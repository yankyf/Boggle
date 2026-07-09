// Turns a photo of a physical Boggle board into a grid of letters, entirely
// in the browser via Tesseract.js. The image is cropped into rows*cols
// cells (so the photo should already be cropped tight to the board) and each
// cell is recognized on its own — recognizing 16-100 tiny isolated glyphs is
// far more reliable than asking a general OCR pass to segment the board.
//
// Per cell the pipeline is:
//   1. crop with an inset (to drop grid lines), upscale, grayscale
//   2. Otsu threshold to pure black/white
//   3. auto polarity: if most pixels came out black the die is dark with
//      light letters, so invert — Tesseract wants dark-on-light
//   4. wipe a border ring so leftover tile edges don't read as strokes
//   5. recognize as a single character; escalate to more attempts (looser
//      crop, line mode for "Qu") only while confidence is poor
// The best-confidence attempt wins, and low-confidence cells are flagged
// for the user to review.

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  const total = gray.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];

  let sumBack = 0;
  let weightBack = 0;
  let maxVariance = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    weightBack += hist[t];
    if (weightBack === 0) continue;
    const weightFore = total - weightBack;
    if (weightFore === 0) break;
    sumBack += t * hist[t];
    const meanBack = sumBack / weightBack;
    const meanFore = (sumAll - sumBack) / weightFore;
    const variance = weightBack * weightFore * (meanBack - meanFore) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }
  return threshold;
}

function preprocessCell(sourceCanvas, x, y, w, h, inset) {
  const ix = x + w * inset;
  const iy = y + h * inset;
  const iw = w * (1 - 2 * inset);
  const ih = h * (1 - 2 * inset);

  const size = 220;
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(sourceCanvas, ix, iy, iw, ih, 0, 0, size, size);

  const imgData = ctx.getImageData(0, 0, size, size);
  const d = imgData.data;

  const gray = new Uint8ClampedArray(size * size);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }

  const threshold = otsuThreshold(gray);

  // Letters should be the dark minority on a light background. If most of
  // the cell thresholds to black, this is a dark die with light letters —
  // invert so Tesseract sees dark-on-light.
  let darkCount = 0;
  for (let p = 0; p < gray.length; p++) if (gray[p] < threshold) darkCount++;
  const invert = darkCount > gray.length / 2;

  const border = Math.round(size * 0.06);
  for (let p = 0; p < gray.length; p++) {
    const px = p % size;
    const py = (p / size) | 0;
    let v;
    if (px < border || px >= size - border || py < border || py >= size - border) {
      v = 255; // wipe tile edges / grid-line remnants
    } else {
      v = gray[p] < threshold ? 0 : 255;
      if (invert) v = 255 - v;
    }
    const i = p * 4;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return out;
}

async function recognizeAttempt(worker, canvas, psm) {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await worker.recognize(canvas);
  const text = (data.text || '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2);
  return { text, confidence: text ? (data.confidence ?? 0) : -1 };
}

const GOOD_ENOUGH = 80; // stop trying more variants above this confidence
const NEEDS_REVIEW = 55; // below this, flag the cell for the user to check

/**
 * @param {File} file
 * @param {number} rows
 * @param {number} cols
 * @param {(status: string, progress: number) => void} onProgress
 * @returns {Promise<{board: string[][], review: boolean[][]}>}
 *   board: uppercase cell strings; review: cells the user should double-check
 */
async function recognizeBoardFromImage(file, rows, cols, onProgress) {
  if (typeof Tesseract === 'undefined') {
    throw new Error('OCR engine failed to load (no internet connection?).');
  }

  const img = await loadImageFromFile(file);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d').drawImage(img, 0, 0);
  URL.revokeObjectURL(img.src);

  const cellW = img.width / cols;
  const cellH = img.height / rows;

  // The whole engine is served with the app (vendor/), so OCR works without
  // any third-party CDN. Paths are absolutized so it also works when the app
  // is hosted under a sub-path (e.g. GitHub Pages).
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: new URL('vendor/tesseract/worker.min.js', document.baseURI).href,
    corePath: new URL('vendor/tesseract/core', document.baseURI).href,
    langPath: new URL('vendor/tesseract/lang', document.baseURI).href,
    gzip: true,
    logger: (m) => {
      // Only surface engine download/setup progress; per-cell progress is
      // reported from the loop below.
      if (onProgress && m.status && m.status !== 'recognizing text') {
        onProgress(m.status, m.progress ?? 0);
      }
    },
  });
  await worker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  });

  const board = [];
  const review = [];
  try {
    for (let r = 0; r < rows; r++) {
      const rowLetters = [];
      const rowReview = [];
      for (let c = 0; c < cols; c++) {
        const n = r * cols + c;
        if (onProgress) onProgress(`Reading letter ${n + 1} of ${rows * cols}…`, n / (rows * cols));

        // Attempts, cheapest first. PSM 10 = single character (best for one
        // letter); PSM 8 = single word; PSM 7 = one text line (both catch
        // letters PSM 10 rejects, and the two-letter "Qu" die).
        // A looser crop rescues letters that the tight inset clipped.
        const attempts = [
          { inset: 0.12, psm: '10' },
          { inset: 0.12, psm: '8' },
          { inset: 0.12, psm: '7' },
          { inset: 0.04, psm: '10' },
          { inset: 0.04, psm: '8' },
          { inset: 0.04, psm: '7' },
        ];

        let best = { text: '', confidence: -1 };
        let cellCanvas = null;
        let lastInset = null;
        for (const a of attempts) {
          if (a.inset !== lastInset) {
            cellCanvas = preprocessCell(canvas, c * cellW, r * cellH, cellW, cellH, a.inset);
            lastInset = a.inset;
          }
          const res = await recognizeAttempt(worker, cellCanvas, a.psm);
          // Prefer a confident "QU" from line mode over a lone "Q".
          const better = res.confidence > best.confidence
            || (res.text.startsWith('Q') && res.text.length === 2 && best.text === 'Q'
                && res.confidence > best.confidence - 15);
          if (res.text && better) best = res;
          if (best.confidence >= GOOD_ENOUGH) break;
        }

        rowLetters.push(best.text);
        rowReview.push(!best.text || best.confidence < NEEDS_REVIEW);
      }
      board.push(rowLetters);
      review.push(rowReview);
    }
  } finally {
    await worker.terminate();
  }
  return { board, review };
}

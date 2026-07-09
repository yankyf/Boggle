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
//   4. connected-component cleanup: drop specks, glare blobs, tile-edge
//      junk and the underline bar real Boggle dice print under M/W/Z
//   5. recenter and scale the remaining glyph
//   6. recognize as a single character; escalate to more modes, a looser
//      crop, and 90/180/270 degree rotations (dice sit at random
//      orientations!) only while confidence is poor
// The best-confidence attempt wins, and low-confidence cells are flagged
// for the user to review.

const OCR_CELL_SIZE = 220;
const GOOD_ENOUGH = 80; // stop trying more variants above this confidence
const NEEDS_REVIEW = 55; // below this, flag the cell for the user to check

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

// Flood-fill labelling of black pixels. Returns per-component pixel lists
// with bounding boxes so the caller can decide what is glyph and what is
// noise.
function findComponents(binary, size) {
  const labels = new Int32Array(binary.length).fill(-1);
  const components = [];
  const stack = [];

  for (let start = 0; start < binary.length; start++) {
    if (binary[start] !== 0 || labels[start] !== -1) continue;
    const id = components.length;
    const comp = { pixels: [], minX: size, maxX: 0, minY: size, maxY: 0 };
    stack.push(start);
    labels[start] = id;
    while (stack.length) {
      const p = stack.pop();
      comp.pixels.push(p);
      const px = p % size;
      const py = (p / size) | 0;
      if (px < comp.minX) comp.minX = px;
      if (px > comp.maxX) comp.maxX = px;
      if (py < comp.minY) comp.minY = py;
      if (py > comp.maxY) comp.maxY = py;
      const neighbors = [p - 1, p + 1, p - size, p + size];
      for (const n of neighbors) {
        if (n < 0 || n >= binary.length) continue;
        if (Math.abs((n % size) - px) > 1) continue; // no row wrap
        if (binary[n] === 0 && labels[n] === -1) {
          labels[n] = id;
          stack.push(n);
        }
      }
    }
    components.push(comp);
  }
  return components;
}

function preprocessCell(sourceCanvas, x, y, w, h, inset) {
  const size = OCR_CELL_SIZE;
  const ix = x + w * inset;
  const iy = y + h * inset;
  const iw = w * (1 - 2 * inset);
  const ih = h * (1 - 2 * inset);

  const work = document.createElement('canvas');
  work.width = size;
  work.height = size;
  const wctx = work.getContext('2d', { willReadFrequently: true });
  wctx.fillStyle = '#fff';
  wctx.fillRect(0, 0, size, size);
  wctx.imageSmoothingEnabled = true;
  wctx.drawImage(sourceCanvas, ix, iy, iw, ih, 0, 0, size, size);

  const imgData = wctx.getImageData(0, 0, size, size);
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

  const border = Math.round(size * 0.05);
  const binary = new Uint8ClampedArray(size * size); // 0 = ink, 255 = paper
  for (let p = 0; p < gray.length; p++) {
    const px = p % size;
    const py = (p / size) | 0;
    if (px < border || px >= size - border || py < border || py >= size - border) {
      binary[p] = 255; // wipe tile edges / grid-line remnants
      continue;
    }
    let v = gray[p] < threshold ? 0 : 255;
    if (invert) v = 255 - v;
    binary[p] = v;
  }

  // Keep only components that look like part of a letter: big enough, not a
  // giant failed-threshold blob, and near the middle. The wide flat bar that
  // Boggle dice print under M, W and Z is excluded from the glyph but used
  // as an orientation anchor: whichever edge the bar sits against is the
  // letter's bottom, which is the only reliable way to tell a rotated M
  // from W or Z from N.
  const components = findComponents(binary, size);
  const kept = [];
  let hint = null; // degrees to rotate the cell so the letter is upright
  let minX = size;
  let maxX = 0;
  let minY = size;
  let maxY = 0;
  for (const comp of components) {
    const area = comp.pixels.length;
    const cw = comp.maxX - comp.minX + 1;
    const ch = comp.maxY - comp.minY + 1;
    if (area < size * size * 0.002) continue; // speck
    if (area > size * size * 0.6) continue; // glare/shadow blob

    const wideBar = cw > size * 0.3 && ch < size * 0.12 && cw / ch >= 3;
    const tallBar = ch > size * 0.3 && cw < size * 0.12 && ch / cw >= 3;
    if (wideBar && comp.minY > size * 0.55) { hint = 0; continue; } // bar below: upright
    if (wideBar && comp.maxY < size * 0.45) { hint = 180; continue; } // bar above: upside down
    if (tallBar && comp.maxX < size * 0.45) { hint = 270; continue; } // bar left: rotated 90° cw
    if (tallBar && comp.minX > size * 0.55) { hint = 90; continue; } // bar right: rotated 90° ccw

    const cx = (comp.minX + comp.maxX) / 2;
    const cy = (comp.minY + comp.maxY) / 2;
    const central = cx > size * 0.12 && cx < size * 0.88 && cy > size * 0.12 && cy < size * 0.88;
    if (!central) continue;
    kept.push(comp);
    if (comp.minX < minX) minX = comp.minX;
    if (comp.maxX > maxX) maxX = comp.maxX;
    if (comp.minY < minY) minY = comp.minY;
    if (comp.maxY > maxY) maxY = comp.maxY;
  }
  if (kept.length === 0) hint = null; // a bar with no glyph means nothing

  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const octx = out.getContext('2d');
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, size, size);
  if (kept.length === 0) return { canvas: out, hint }; // nothing recognizable

  // Paint the kept components on a clean canvas...
  const glyph = document.createElement('canvas');
  glyph.width = size;
  glyph.height = size;
  const gctx = glyph.getContext('2d');
  gctx.fillStyle = '#fff';
  gctx.fillRect(0, 0, size, size);
  const gData = gctx.getImageData(0, 0, size, size);
  for (const comp of kept) {
    for (const p of comp.pixels) {
      const i = p * 4;
      gData.data[i] = gData.data[i + 1] = gData.data[i + 2] = 0;
    }
  }
  gctx.putImageData(gData, 0, 0);

  // ...then recenter and scale it to a comfortable size for Tesseract.
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const target = size * 0.62;
  const scale = Math.min(target / bw, target / bh, 3.5);
  const dw = bw * scale;
  const dh = bh * scale;
  octx.imageSmoothingEnabled = true;
  octx.drawImage(glyph, minX, minY, bw, bh, (size - dw) / 2, (size - dh) / 2, dw, dh);
  return { canvas: out, hint };
}

function rotateCanvas(canvas, degrees) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

async function recognizeAttempt(worker, canvas, psm) {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await worker.recognize(canvas);
  let text = (data.text || '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2);
  let confidence = text ? (data.confidence ?? 0) : -1;
  // "Qu" is the only legitimate two-letter die; any other multi-letter read
  // means the glyph confused the engine, so keep the first letter but leave
  // the cell flagged for the user to check.
  if (text.length === 2 && text !== 'QU') {
    text = text[0];
    confidence = Math.min(confidence, NEEDS_REVIEW - 5);
  }
  return { text, confidence };
}

// Huge photos slow everything down without helping accuracy — the per-cell
// canvases are only 220px anyway.
function drawDownscaled(img) {
  const maxDim = 1600;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function inkProfiles(canvas) {
  const { width: W, height: H } = canvas;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const gray = new Uint8ClampedArray(W * H);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  const threshold = otsuThreshold(gray);
  let dark = 0;
  for (let p = 0; p < gray.length; p++) if (gray[p] < threshold) dark++;
  const invert = dark > gray.length / 2;

  const colInk = new Float64Array(W);
  const rowInk = new Float64Array(H);
  for (let p = 0; p < gray.length; p++) {
    if ((gray[p] < threshold) !== invert) {
      colInk[p % W]++;
      rowInk[(p / W) | 0]++;
    }
  }
  return { colInk, rowInk };
}

// People rarely crop their photo exactly to the grid. The letters are where
// the ink is, so trim away the quiet margins (background, table, page
// chrome) before splitting the image into cells — a misaligned grid ruins
// every cell at once.
function autoCropBoard(canvas) {
  const { width: W, height: H } = canvas;
  const { colInk, rowInk } = inkProfiles(canvas);

  function activeSpan(profile, length) {
    // Smooth so a stray speck doesn't extend the span.
    const win = Math.max(2, Math.round(length * 0.01));
    const smooth = new Float64Array(length);
    for (let i = 0; i < length; i++) {
      let s = 0;
      let n = 0;
      for (let j = i - win; j <= i + win; j++) {
        if (j >= 0 && j < length) { s += profile[j]; n++; }
      }
      smooth[i] = s / n;
    }
    let max = 0;
    for (let i = 0; i < length; i++) if (smooth[i] > max) max = smooth[i];
    if (max === 0) return null;
    const cut = max * 0.12;
    let lo = 0;
    let hi = length - 1;
    while (lo < length && smooth[lo] < cut) lo++;
    while (hi > lo && smooth[hi] < cut) hi--;
    if (hi - lo < length * 0.25) return null; // too small to be the board
    const margin = Math.round((hi - lo) * 0.02);
    return [Math.max(0, lo - margin), Math.min(length - 1, hi + margin)];
  }

  const xs = activeSpan(colInk, W);
  const ys = activeSpan(rowInk, H);
  if (!xs || !ys) return canvas;
  const [x0, x1] = xs;
  const [y0, y1] = ys;
  // Nearly the whole image already? Skip the copy.
  if (x0 < W * 0.03 && x1 > W * 0.97 && y0 < H * 0.03 && y1 > H * 0.97) return canvas;

  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function estimateFromCanvas(canvas) {
  const { colInk, rowInk } = inkProfiles(canvas);
  const cols = bestDivisions(colInk, canvas.width);
  const rows = bestDivisions(rowInk, canvas.height);
  return rows && cols ? { rows, cols } : null;
}

/**
 * Load the photo and decide which framing to read it with. A tightly
 * cropped image usually shows a confident grid as-is; an uncropped photo
 * shows one only after the quiet margins are trimmed. The size estimate
 * and the canvas must come from the same framing, or the cell-splitting
 * misaligns with the tiles.
 *
 * @param {File} file
 * @returns {Promise<{canvas: HTMLCanvasElement, size: {rows: number, cols: number} | null}>}
 */
async function prepareBoardImage(file) {
  const img = await loadImageFromFile(file);
  const original = drawDownscaled(img);
  URL.revokeObjectURL(img.src);

  let size = estimateFromCanvas(original);
  if (size) return { canvas: original, size };

  const cropped = autoCropBoard(original);
  if (cropped !== original) {
    size = estimateFromCanvas(cropped);
    if (size) return { canvas: cropped, size };
  }
  return { canvas: cropped, size: null };
}

// Guess how many rows/cols the photographed board has. Along the boundary
// lines of a k×k split, a real board shows something unusual: almost no ink
// for tile-style boards (background gaps) or lots of ink for boards with
// dark grid lines. So for every candidate count, measure the ink along its
// implied boundaries and pick the count that deviates most from the image
// average — if any candidate deviates clearly enough to trust.
function bestDivisions(profile, length) {
  let total = 0;
  for (let i = 0; i < length; i++) total += profile[i];
  const mean = total / length;
  if (mean === 0) return null;

  let best = null;
  let bestDev = 0;
  for (let k = 3; k <= 10; k++) {
    const band = Math.max(2, Math.round(length * 0.012));
    let sum = 0;
    let cnt = 0;
    for (let i = 1; i < k; i++) {
      const center = Math.round((i * length) / k);
      for (let x = center - band; x <= center + band; x++) {
        if (x >= 0 && x < length) {
          sum += profile[x];
          cnt++;
        }
      }
    }
    const dev = Math.abs(sum / cnt / mean - 1);
    if (dev > bestDev) {
      bestDev = dev;
      best = k;
    }
  }
  return bestDev > 0.45 ? best : null;
}

/**
 * @param {HTMLCanvasElement} canvas - from prepareBoardImage, so the crop
 *   matches the framing the size estimate was made on
 * @param {number} rows
 * @param {number} cols
 * @param {(status: string, progress: number) => void} onProgress
 * @returns {Promise<{board: string[][], review: boolean[][]}>}
 *   board: uppercase cell strings; review: cells the user should double-check
 */
async function recognizeBoardFromCanvas(canvas, rows, cols, onProgress) {
  if (typeof Tesseract === 'undefined') {
    throw new Error('OCR engine failed to load.');
  }

  const cellW = canvas.width / cols;
  const cellH = canvas.height / rows;

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

        let best = { text: '', confidence: -1 };

        // Stage 1 — upright attempts (pre-rotated when the die's underline
        // told us its true orientation). PSM 10 = single character (best
        // for one letter); PSM 8 = single word; PSM 7 = one text line (both
        // catch letters PSM 10 rejects, and the two-letter "Qu" die). A
        // looser crop rescues letters that the tight inset clipped.
        const tight = preprocessCell(canvas, c * cellW, r * cellH, cellW, cellH, 0.12);
        const tightCv = tight.hint ? rotateCanvas(tight.canvas, tight.hint) : tight.canvas;
        for (const psm of ['10', '8', '7']) {
          const res = await recognizeAttempt(worker, tightCv, psm);
          if (res.text && res.confidence > best.confidence) best = res;
          if (best.confidence >= GOOD_ENOUGH) break;
        }
        if (best.confidence < GOOD_ENOUGH) {
          const loose = preprocessCell(canvas, c * cellW, r * cellH, cellW, cellH, 0.04);
          const looseHint = loose.hint ?? tight.hint;
          const looseCv = looseHint ? rotateCanvas(loose.canvas, looseHint) : loose.canvas;
          for (const psm of ['10', '8']) {
            const res = await recognizeAttempt(worker, looseCv, psm);
            if (res.text && res.confidence > best.confidence) best = res;
            if (best.confidence >= GOOD_ENOUGH) break;
          }
        }

        // Stage 2 — physical dice land at random orientations, so try the
        // three other rotations, but ONLY when the upright reading came up
        // basically empty: an upright W reads as a MORE confident M when
        // turned upside down, so rotating a readable glyph makes things
        // worse, not better. Skipped when the underline anchor already
        // fixed the orientation. Letters that are each other's rotations
        // (M/W, A/V upside down; Z/N sideways) are mapped back to their
        // upright interpretation and flagged, since without an underline
        // the orientation is genuinely ambiguous.
        if (best.confidence < 30 && tight.hint === null) {
          const TWIN_180 = { M: 'W', W: 'M', A: 'V', V: 'A' };
          const TWIN_90 = { Z: 'N', N: 'Z' };
          outer: for (const deg of [90, 180, 270]) {
            const rotated = rotateCanvas(tight.canvas, deg);
            for (const psm of ['10', '8']) {
              const res = await recognizeAttempt(worker, rotated, psm);
              if (!res.text) continue;
              const twin = deg === 180 ? TWIN_180[res.text] : TWIN_90[res.text];
              if (twin) {
                res.text = twin;
                res.confidence = Math.min(res.confidence, NEEDS_REVIEW - 5);
              }
              if (res.confidence > best.confidence) best = res;
              if (best.confidence >= GOOD_ENOUGH) break outer;
            }
          }
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

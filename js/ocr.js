// Turns a photo of a physical Boggle board into a grid of letters, entirely
// in the browser via Tesseract.js. The image is cropped into rows*cols
// cells (so the photo should already be cropped tight to the board), each
// cell is cleaned up (grayscale + threshold + upscale) and OCR'd on its own,
// since recognizing 16-25 tiny isolated glyphs is far more reliable than
// asking a general OCR pass to segment the whole board.

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function preprocessCell(sourceCanvas, x, y, w, h) {
  const inset = 0.10; // shave off grid lines / cell borders
  const ix = x + w * inset;
  const iy = y + h * inset;
  const iw = w * (1 - 2 * inset);
  const ih = h * (1 - 2 * inset);

  const size = 220;
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(sourceCanvas, ix, iy, iw, ih, 0, 0, size, size);

  const imgData = ctx.getImageData(0, 0, size, size);
  const d = imgData.data;

  // Grayscale first, to compute an adaptive threshold from this cell only.
  let sum = 0;
  const gray = new Uint8ClampedArray(size * size);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray[p] = g;
    sum += g;
  }
  const mean = sum / gray.length;
  const threshold = mean * 0.85; // letters are usually darker than the cell background

  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = gray[p] < threshold ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return out;
}

/**
 * @param {File} file
 * @param {number} rows
 * @param {number} cols
 * @param {(status: string, progress: number) => void} onProgress
 * @returns {Promise<string[][]>} board of single/double letter cell strings (uppercase)
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

  const worker = await Tesseract.createWorker('eng', 1, {
    logger: (m) => {
      if (onProgress && m.status) onProgress(m.status, m.progress ?? 0);
    },
  });
  await worker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    tessedit_pageseg_mode: '7', // single text line: allows two-letter dice like "Qu"
  });

  const board = [];
  try {
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        if (onProgress) onProgress(`reading cell ${r * cols + c + 1}/${rows * cols}`, (r * cols + c) / (rows * cols));
        const cellCanvas = preprocessCell(canvas, c * cellW, r * cellH, cellW, cellH);
        const { data: { text } } = await worker.recognize(cellCanvas);
        const cleaned = text.replace(/[^A-Za-z]/g, '').toUpperCase();
        row.push(cleaned.slice(0, 2) || '');
      }
      board.push(row);
    }
  } finally {
    await worker.terminate();
  }
  return board;
}

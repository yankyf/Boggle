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
// noise. Works on any width×height raster (height defaults to width).
function findComponents(binary, width, height = width) {
  const labels = new Int32Array(binary.length).fill(-1);
  const components = [];
  const stack = [];

  for (let start = 0; start < binary.length; start++) {
    if (binary[start] !== 0 || labels[start] !== -1) continue;
    const id = components.length;
    const comp = { pixels: [], minX: width, maxX: 0, minY: height, maxY: 0 };
    stack.push(start);
    labels[start] = id;
    while (stack.length) {
      const p = stack.pop();
      comp.pixels.push(p);
      const px = p % width;
      const py = (p / width) | 0;
      if (px < comp.minX) comp.minX = px;
      if (px > comp.maxX) comp.maxX = px;
      if (py < comp.minY) comp.minY = py;
      if (py > comp.maxY) comp.maxY = py;
      const neighbors = [p - 1, p + 1, p - width, p + width];
      for (const n of neighbors) {
        if (n < 0 || n >= binary.length) continue;
        if (Math.abs((n % width) - px) > 1) continue; // no row wrap
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

// Shape facts about the cleaned-up glyph, for the letters Tesseract is
// weakest at when they stand alone: a lone "I" is dropped as a line
// artifact, and a bold "O" often reads as C. Both are trivially separable
// geometrically on our clean binary canvas.
function analyzeGlyph(canvas) {
  const size = canvas.width;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size).data;
  const black = new Uint8Array(size * size);
  let minX = size;
  let maxX = 0;
  let minY = size;
  let maxY = 0;
  let count = 0;
  for (let p = 0; p < size * size; p++) {
    if (d[p * 4] < 128) {
      black[p] = 1;
      count++;
      const x = p % size;
      const y = (p / size) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (count === 0) return null;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;

  // Flood the outside white; any white left unreached is an enclosed hole.
  const seen = new Uint8Array(size * size);
  const stack = [];
  for (let i = 0; i < size; i++) {
    for (const p of [i, (size - 1) * size + i, i * size, i * size + size - 1]) {
      if (!black[p] && !seen[p]) { seen[p] = 1; stack.push(p); }
    }
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % size;
    const neighbors = [p - size, p + size];
    if (x > 0) neighbors.push(p - 1);
    if (x < size - 1) neighbors.push(p + 1);
    for (const n of neighbors) {
      if (n >= 0 && n < size * size && !black[n] && !seen[n]) {
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
  let holePixels = 0;
  for (let p = 0; p < size * size; p++) if (!black[p] && !seen[p]) holePixels++;

  return {
    hasHole: holePixels > size * size * 0.005,
    barLike: bh / bw >= 2.8 && count / (bw * bh) >= 0.8,
  };
}

// --- Template matching: an independent second opinion --------------------
//
// Tesseract is a document-OCR engine; on a single isolated stylized glyph
// it is only so-so, and it's a black box we can't tune. So we also match
// each cleaned-up glyph directly against our own rendered A–Z shapes and
// let the two recognizers vote. This is deterministic, and it's especially
// strong on the clean high-contrast tiles you get from a screenshot or a
// straight-on photo — exactly the cases Tesseract sometimes fumbles.

const TPL_GRID = 32; // glyphs are normalized to a TPL_GRID×TPL_GRID bitmap
const TPL_FIT = 24; // bounding box is scaled to fit this many cells, centered
let LETTER_TEMPLATES = null;

// Normalize any black-on-white raster into a scale/position-independent
// binary bitmap: find the ink bounding box, scale it to fit TPL_FIT and
// center it in a TPL_GRID grid. Both templates and live glyphs go through
// this, so font size and placement differences cancel out.
function normalizeGlyphGrid(imageData) {
  const { width: W, height: H, data } = imageData;
  let minX = W;
  let maxX = -1;
  let minY = H;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4] < 128) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const grid = new Uint8Array(TPL_GRID * TPL_GRID);
  if (maxX < 0) return grid;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const scale = TPL_FIT / Math.max(bw, bh);
  const offX = (TPL_GRID - bw * scale) / 2;
  const offY = (TPL_GRID - bh * scale) / 2;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (data[(y * W + x) * 4] < 128) {
        const gx = Math.floor((x - minX) * scale + offX);
        const gy = Math.floor((y - minY) * scale + offY);
        if (gx >= 0 && gx < TPL_GRID && gy >= 0 && gy < TPL_GRID) {
          grid[gy * TPL_GRID + gx] = 1;
        }
      }
    }
  }
  return grid;
}

function buildLetterTemplates() {
  if (LETTER_TEMPLATES) return LETTER_TEMPLATES;
  // A few common board fonts so a die's typeface doesn't matter much.
  const fonts = ['bold 150px Arial', 'bold 150px "Times New Roman"', 'bold 150px Georgia', '900 150px Arial'];
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 200;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  LETTER_TEMPLATES = [];
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const grids = [];
    for (const font of fonts) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 200, 200);
      ctx.fillStyle = '#000';
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ch, 100, 104);
      grids.push(normalizeGlyphGrid(ctx.getImageData(0, 0, 200, 200)));
    }
    LETTER_TEMPLATES.push({ ch, grids });
  }
  return LETTER_TEMPLATES;
}

function iouScore(a, b) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const on = a[i] | b[i];
    if (on) {
      union++;
      if (a[i] & b[i]) inter++;
    }
  }
  return union ? inter / union : 0;
}

// Returns the best-matching letter, a 0–100 confidence from the shape
// overlap, and the margin over the runner-up (a small margin means two
// letters matched about equally well — genuinely ambiguous).
function templateMatch(cleanCanvas) {
  const size = cleanCanvas.width;
  const data = cleanCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size);
  const grid = normalizeGlyphGrid(data);
  let ink = 0;
  for (let i = 0; i < grid.length; i++) ink += grid[i];
  if (ink < 8) return { text: '', confidence: -1, margin: 0 };

  const templates = buildLetterTemplates();
  let best = '';
  let bestScore = 0;
  let second = 0;
  for (const { ch, grids } of templates) {
    let s = 0;
    for (const g of grids) {
      const iou = iouScore(grid, g);
      if (iou > s) s = iou;
    }
    if (s > bestScore) {
      second = bestScore;
      bestScore = s;
      best = ch;
    } else if (s > second) {
      second = s;
    }
  }
  return { text: best, confidence: Math.round(bestScore * 100), margin: bestScore - second };
}

// Fuse the two recognizers. Agreement is trusted (and un-flags a cell that
// either alone was unsure about); disagreement keeps the more confident
// read but flags it so the user reviews it instead of trusting a coin flip.
function combineReads(tess, tpl) {
  if (!tpl.text) return tess;
  if (!tess.text) {
    return { text: tpl.text, confidence: tpl.confidence, flagged: tpl.confidence < 62 || tpl.margin < 0.06 };
  }
  if (tess.text === tpl.text) {
    return { text: tess.text, confidence: Math.max(tess.confidence, tpl.confidence, 82), flagged: false };
  }
  // Disagreement — pick the stronger, but never trust it silently.
  const winner = tpl.confidence >= tess.confidence + 6 ? tpl : tess;
  return { text: winner.text, confidence: Math.min(winner.confidence, NEEDS_REVIEW - 1), flagged: true };
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

// Segment one axis of the board directly: contiguous runs of ink are the
// letter blocks (one per tile), and the quiet valleys between them are
// where the cell boundaries belong. Unlike uniform division this survives
// trailing whitespace, off-center boards and slightly uneven grids, and it
// returns the exact cut positions.
function segmentAxis(profile, length) {
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
  const cut = max * 0.15;

  const blocks = [];
  let start = null;
  for (let i = 0; i <= length; i++) {
    const on = i < length && smooth[i] >= cut;
    if (on && start === null) start = i;
    if (!on && start !== null) {
      blocks.push([start, i - 1]);
      start = null;
    }
  }
  // Merge blocks split by hairline dips and drop specks.
  const merged = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (prev && b[0] - prev[1] < length * 0.012) prev[1] = b[1];
    else merged.push([...b]);
  }
  const solid = merged.filter(([lo, hi]) => hi - lo >= length * 0.02);
  const count = solid.length;
  if (count < 3 || count > 10) return null;

  // Cell boundaries: midpoints of the gaps, extended a little past the
  // outer blocks so tile faces aren't clipped.
  const pad = Math.round((solid[count - 1][1] - solid[0][0]) / count * 0.35);
  const cuts = [Math.max(0, solid[0][0] - pad)];
  for (let i = 1; i < count; i++) {
    cuts.push(Math.round((solid[i - 1][1] + solid[i][0]) / 2));
  }
  cuts.push(Math.min(length - 1, solid[count - 1][1] + pad));

  // Real tiles are evenly spaced. Irregular spacing means the "blocks"
  // include junk (die edges, glare) — reject rather than mis-split.
  const spans = [];
  for (let i = 1; i < cuts.length; i++) spans.push(cuts[i] - cuts[i - 1]);
  const meanSpan = spans.reduce((a, b) => a + b, 0) / spans.length;
  if (spans.some((s) => Math.abs(s - meanSpan) / meanSpan > 0.3)) return null;

  return { count, cuts };
}

function estimateFromCanvas(canvas) {
  const { colInk, rowInk } = inkProfiles(canvas);

  // Prefer direct segmentation — it also yields the exact cut positions.
  const colSeg = segmentAxis(colInk, canvas.width);
  const rowSeg = segmentAxis(rowInk, canvas.height);
  if (colSeg && rowSeg) {
    return { rows: rowSeg.count, cols: colSeg.count, cuts: { x: colSeg.cuts, y: rowSeg.cuts } };
  }

  // Fallback: uniform division scoring.
  const cols = bestDivisions(colInk, canvas.width);
  const rows = bestDivisions(rowInk, canvas.height);
  return rows && cols ? { rows, cols, cuts: null } : null;
}

// --- Physical-board detection: find each die as a bright blob ------------
//
// A real photo of a Boggle tray defeats grid-cutting: the board sits on a
// patterned surface, the photo is slightly tilted, and the dice are 3D so
// side faces leak partial letters into neighboring cells. But the die faces
// themselves are unmistakable — bright, unsaturated squares against a dark
// tray. So instead of slicing the image, find every die individually and
// read each one where it actually sits. Tilt then barely matters, and the
// tablecloth never enters a cell.

function findDiceGrid(canvas) {
  const { width: W, height: H } = canvas;
  const total = W * H;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;

  // Candidate die pixels: noticeably brighter than their local
  // surroundings (dice sit in a dark tray) and unsaturated (ivory/white
  // plastic). Local contrast instead of a global threshold makes bright
  // backgrounds (tablecloths) cancel out and lighting gradients harmless.
  const values = new Float64Array(total);
  for (let p = 0; p < total; p++) {
    values[p] = (d[p * 4] + d[p * 4 + 1] + d[p * 4 + 2]) / 3;
  }

  // Local mean via summed-area table.
  const sat2 = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += values[y * W + x];
      sat2[(y + 1) * (W + 1) + (x + 1)] = sat2[y * (W + 1) + (x + 1)] + rowSum;
    }
  }
  const radius = Math.max(20, Math.round(Math.min(W, H) / 10));
  const localMean = (x, y) => {
    const x0 = Math.max(0, x - radius);
    const y0 = Math.max(0, y - radius);
    const x1 = Math.min(W - 1, x + radius);
    const y1 = Math.min(H - 1, y + radius);
    const sum = sat2[(y1 + 1) * (W + 1) + (x1 + 1)] - sat2[y0 * (W + 1) + (x1 + 1)]
      - sat2[(y1 + 1) * (W + 1) + x0] + sat2[y0 * (W + 1) + x0];
    return sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
  };

  const bright = new Uint8ClampedArray(total);
  for (let p = 0; p < total; p++) {
    const r = d[p * 4];
    const g = d[p * 4 + 1];
    const b = d[p * 4 + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const satVal = max === 0 ? 0 : (max - min) / max;
    const rel = values[p] / (localMean(p % W, (p / W) | 0) + 1);
    bright[p] = rel > 1.13 && satVal < 0.35 ? 0 : 255; // 0 = candidate
  }

  // Connected components over candidate pixels (0 = candidate).
  const comps = findComponents(bright, W, H);

  // Keep die-shaped blobs: squarish, solid, sensible size.
  let dice = [];
  for (const c of comps) {
    const w = c.maxX - c.minX + 1;
    const h = c.maxY - c.minY + 1;
    const area = c.pixels.length;
    if (area < total / 3000 || area > total / 25) continue;
    const aspect = w / h;
    if (aspect < 0.6 || aspect > 1.7) continue;
    if (area / (w * h) < 0.55) continue; // not solid enough (flower, glare streak)
    dice.push({ x: (c.minX + c.maxX) / 2, y: (c.minY + c.maxY) / 2, w, h, minX: c.minX, minY: c.minY });
  }
  if (dice.length < 9) return null;

  // Keep the dominant size class (drops stray background blobs).
  const areas = dice.map((t) => t.w * t.h).sort((a, b) => a - b);
  const median = areas[(areas.length / 2) | 0];
  dice = dice.filter((t) => t.w * t.h > median * 0.4 && t.w * t.h < median * 2.5);
  if (dice.length < 9) return null;
  const dieSize = Math.sqrt(median);

  // Drop isolated blobs: a die always has a grid neighbor nearby.
  dice = dice.filter((a) => dice.some((b) => {
    if (a === b) return false;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy) < dieSize * 2.4;
  }));
  if (dice.length < 9) return null;

  // Cluster into rows by y (tolerates a few degrees of tilt), then order
  // each row by x. Rank-in-row gives the column, so mild tilt is harmless.
  dice.sort((a, b) => a.y - b.y);
  const rows = [];
  for (const die of dice) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(die.y - row.meanY) < dieSize * 0.55) {
      row.dice.push(die);
      row.meanY += (die.y - row.meanY) / row.dice.length;
    } else {
      rows.push({ meanY: die.y, dice: [die] });
    }
  }

  // A real board has equal-length rows; anything else means detection noise.
  const counts = rows.map((r) => r.dice.length);
  const cols = counts[0];
  if (rows.length < 3 || rows.length > 10 || cols < 3 || cols > 10) return null;
  if (counts.some((c) => c !== cols)) return null;

  const pad = dieSize * 0.06;
  const cells = rows.map((row) => {
    row.dice.sort((a, b) => a.x - b.x);
    return row.dice.map((t) => [
      Math.max(0, t.minX - pad),
      Math.max(0, t.minY - pad),
      Math.min(W - t.minX, t.w + 2 * pad),
      Math.min(H - t.minY, t.h + 2 * pad),
    ]);
  });
  return { rows: rows.length, cols, cells };
}

/**
 * Load the photo and decide which framing to read it with. Physical-board
 * photos are handled by per-die blob detection; screenshots and clean
 * scans by profile segmentation; uncropped variants of those by trimming
 * quiet margins first. The size estimate and the canvas must come from the
 * same framing, or the cell-splitting misaligns with the tiles.
 *
 * @param {File} file
 * @returns {Promise<{canvas, size: {rows, cols, cuts?} | null, cells: number[][][] | null}>}
 */
async function prepareBoardImage(file) {
  const img = await loadImageFromFile(file);
  const original = drawDownscaled(img);
  URL.revokeObjectURL(img.src);

  // Physical photo path: find the dice themselves.
  const grid = findDiceGrid(original);
  if (grid) {
    return { canvas: original, size: { rows: grid.rows, cols: grid.cols, cuts: null }, cells: grid.cells };
  }

  let size = estimateFromCanvas(original);
  if (size) return { canvas: original, size, cells: null };

  const cropped = autoCropBoard(original);
  if (cropped !== original) {
    size = estimateFromCanvas(cropped);
    if (size) return { canvas: cropped, size, cells: null };
  }
  return { canvas: cropped, size: null, cells: null };
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

  const devs = new Map();
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
    devs.set(k, dev);
    if (dev > bestDev) bestDev = dev;
  }
  if (bestDev <= 0.45) return null;
  // Divisors of the true count score just as well (splitting an 8-wide
  // board in 4 also puts every boundary in a gap), so among the candidates
  // near the best score, trust the finest split.
  let best = null;
  for (let k = 3; k <= 10; k++) {
    if (devs.get(k) >= Math.max(0.45, 0.85 * bestDev)) best = k;
  }
  return best;
}

/**
 * @param {HTMLCanvasElement} canvas - from prepareBoardImage, so the crop
 *   matches the framing the size estimate was made on
 * @param {number} rows
 * @param {number} cols
 * @param {(status: string, progress: number) => void} onProgress
 * @param {{x: number[], y: number[]} | null} cuts - exact cell boundaries
 *   from segmentation; falls back to uniform division without them
 * @param {number[][][] | null} cells - per-die [x, y, w, h] rects from blob
 *   detection; takes precedence over cuts
 * @returns {Promise<{board: string[][], review: boolean[][]}>}
 *   board: uppercase cell strings; review: cells the user should double-check
 */
async function recognizeBoardFromCanvas(canvas, rows, cols, onProgress, cuts = null, cells = null) {
  if (typeof Tesseract === 'undefined') {
    throw new Error('OCR engine failed to load.');
  }

  const cellW = canvas.width / cols;
  const cellH = canvas.height / rows;
  const useCells = cells && cells.length === rows && cells.every((row) => row.length === cols);
  const useCuts = !useCells && cuts && cuts.x.length === cols + 1 && cuts.y.length === rows + 1;
  const cellRect = (r, c) => {
    if (useCells) return cells[r][c];
    if (useCuts) return [cuts.x[c], cuts.y[r], cuts.x[c + 1] - cuts.x[c], cuts.y[r + 1] - cuts.y[r]];
    return [c * cellW, r * cellH, cellW, cellH];
  };

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
        const [cx, cy, cw, ch] = cellRect(r, c);
        const tight = preprocessCell(canvas, cx, cy, cw, ch, 0.12);
        const tightCv = tight.hint ? rotateCanvas(tight.canvas, tight.hint) : tight.canvas;
        for (const psm of ['10', '8', '7']) {
          const res = await recognizeAttempt(worker, tightCv, psm);
          if (res.text && res.confidence > best.confidence) best = res;
          if (best.confidence >= GOOD_ENOUGH) break;
        }
        if (best.confidence < GOOD_ENOUGH) {
          const loose = preprocessCell(canvas, cx, cy, cw, ch, 0.04);
          const looseHint = loose.hint ?? tight.hint;
          const looseCv = looseHint ? rotateCanvas(loose.canvas, looseHint) : loose.canvas;
          for (const psm of ['10', '8']) {
            const res = await recognizeAttempt(worker, looseCv, psm);
            if (res.text && res.confidence > best.confidence) best = res;
            if (best.confidence >= GOOD_ENOUGH) break;
          }
        }

        // Geometric rescue for Tesseract's isolated-glyph blind spots.
        const uprightCv = tight.hint ? rotateCanvas(tight.canvas, tight.hint) : tight.canvas;
        const shape = analyzeGlyph(uprightCv);
        if (shape) {
          if (!best.text && shape.barLike) {
            best = { text: 'I', confidence: 75 };
          } else if (best.text === 'C' && shape.hasHole) {
            best = { text: 'O', confidence: Math.max(best.confidence, 75) };
          } else if (!best.text && shape.hasHole) {
            best = { text: 'O', confidence: NEEDS_REVIEW - 5 }; // guess, flagged
          }
        }

        // Second opinion: shape-template match, then vote. Never for the
        // "Qu" die, which isn't a single shape.
        let flagged = !best.text || best.confidence < NEEDS_REVIEW;
        if (best.text !== 'QU') {
          const tpl = templateMatch(uprightCv);
          let fused = combineReads(
            { text: best.text, confidence: Math.max(best.confidence, 0) },
            tpl,
          );

          // Physical dice land at random orientations. When no underline
          // fixed the orientation, template-match the three rotations
          // (cheap — no OCR call). If one matches decisively better than
          // the upright reading, re-read at that angle: an upside-down A
          // reads as a confident V, a rotated D as an O — only the
          // rotation contest exposes them. Letters that are their own
          // rotation twins (M/W, A/V upside down; Z/N sideways) stay
          // flagged when adopted this way: without an underline the
          // orientation is genuinely ambiguous.
          if (tight.hint === null) {
            const ROTATION_TWINS = new Set(['M', 'W', 'A', 'V', 'Z', 'N']);
            let bestDeg = 0;
            let bestTpl = tpl;
            for (const deg of [90, 180, 270]) {
              const t = templateMatch(rotateCanvas(tight.canvas, deg));
              if (t.text && t.confidence > bestTpl.confidence) {
                bestTpl = t;
                bestDeg = deg;
              }
            }
            if (bestDeg !== 0 && bestTpl.confidence >= Math.max(tpl.confidence + 8, 55)) {
              const rotated = rotateCanvas(tight.canvas, bestDeg);
              const tessRot = await recognizeAttempt(worker, rotated, '10');
              const fusedRot = combineReads(
                { text: tessRot.text, confidence: Math.max(tessRot.confidence, 0) },
                bestTpl,
              );
              if (fusedRot.text && fusedRot.confidence > fused.confidence) {
                fused = fusedRot;
                if (ROTATION_TWINS.has(fusedRot.text)) {
                  fused = { ...fusedRot, confidence: Math.min(fusedRot.confidence, NEEDS_REVIEW - 1), flagged: true };
                }
              }
            }
          }

          best = { text: fused.text, confidence: fused.confidence };
          flagged = fused.flagged || !fused.text;
        }

        rowLetters.push(best.text);
        rowReview.push(flagged);
      }
      board.push(rowLetters);
      review.push(rowReview);
    }
  } finally {
    await worker.terminate();
  }
  return { board, review };
}

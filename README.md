# Boggle Solver

A Boggle solver that runs entirely in your browser. Type letters into a
grid, or upload a photo of a physical board, and it finds every valid
dictionary word — with the path for each word highlighted on the grid.

No backend, no build step, no data leaves your machine: the dictionary is
a static word list and the OCR (photo → letters) runs client-side via
[Tesseract.js](https://github.com/naptha/tesseract.js).

## Running it

Browsers block `fetch()` of local files over `file://`, so serve the
folder instead of double-clicking `index.html`:

```bash
npm start          # python3 -m http.server 8000
# or
npm run start:node # npx serve -l 8000 .
```

Then open http://localhost:8000.

## Using it

- **Rows / Columns**: set the board size (3–10 per side); the grid resizes
  instantly as you change the numbers.
- **Random board**: fills the grid using real physical Boggle dice sets
  for 4x4 and 5x5 (Big Boggle); other sizes use weighted-random letters.
- **Long-word board**: rolls dozens of random boards behind the scenes,
  solves each one, and keeps the board richest in 6+ letter words.
- **Upload board photo**: crop your photo tightly to just the board first
  (no background), set rows/cols to match, then upload. Each cell is OCR'd
  individually — review the highlighted (red) or misread cells before
  solving, since OCR on handwritten/stylized dice fonts isn't perfect.
- **Find words**: runs a trie-guided depth-first search over all 8-directional
  neighbors (standard Boggle adjacency, no reusing a cube in the same word).
  Click any result to see its path highlighted with numbered steps.
- A cell can hold two letters (e.g. `Qu`) to match the real Boggle die.

## How it works

- `js/trie.js` — prefix trie built from `data/words.txt` (274k words,
  [sindresorhus/word-list](https://github.com/sindresorhus/word-list), MIT).
- `js/solver.js` — DFS from every cell, pruned against the trie, collecting
  all words at or above the minimum length with standard Boggle scoring.
- `js/dice.js` — real dice letter sets for random boards.
- `js/ocr.js` — crops the uploaded image into a rows×cols grid and reads
  each cell separately (much more reliable than OCR'ing the whole board at
  once). Per cell: Otsu threshold, automatic light/dark polarity, border
  cleanup, then two independent recognizers vote — Tesseract.js and a
  shape-template matcher against rendered A–Z glyphs. When they agree the
  read is trusted; when they disagree the cell is flagged red for review,
  so a wrong letter is surfaced rather than silently accepted.
- `vendor/tesseract/` — the OCR engine and English model, served with the
  app so it works offline and never depends on a third-party CDN.
- `js/app.js` — UI state, grid rendering/editing, and results rendering.

## Limitations

- OCR handles real tray photos (patterned backgrounds, mild tilt, rotated
  dice, uneven light) by detecting each die individually, but always double
  check the detected letters before solving. Letters that are rotations of
  each other (M/W, A/V, Z/N) are flagged red when the die has no underline
  to anchor its orientation.
- Board sizes are capped at 3–10 per side (Boggle boards are square in
  practice, but rows/cols can differ if you want a rectangle).

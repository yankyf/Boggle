// Real physical Boggle dice sets, used for the "Random board" button so
// generated boards match the letter distribution of an actual game.

const DICE_4X4 = [
  'AAEEGN', 'ELRTTY', 'AOOTTW', 'ABBJOO',
  'EHRTVW', 'CIMOTU', 'DISTTY', 'EIOSST',
  'DELRVY', 'ACHOPS', 'HIMNQU', 'EEINSU',
  'EEGHNW', 'AFFKPS', 'HLNNRZ', 'DEILRX',
];

// "Big Boggle" 5x5 dice.
const DICE_5X5 = [
  'AAAFRS', 'AAEEEE', 'AAFIRS', 'ADENNN', 'AEEEEM',
  'AEEGMU', 'AEGMNN', 'AFIRSY', 'BJKQXZ', 'CCNSTW',
  'CEIILT', 'CEILPT', 'CEIPST', 'DDLNOR', 'DHHLOR',
  'DHHNOT', 'DHLNOR', 'EIIITT', 'EMOTTT', 'ENSSSU',
  'FIPRSY', 'GORRVW', 'HIPRRY', 'NOOTUW', 'OOOTTU',
];

// Approximate English letter frequency (%), used as a fallback for board
// sizes that don't match a known physical dice set.
const LETTER_FREQUENCY = {
  a: 8.2, b: 1.5, c: 2.8, d: 4.3, e: 12.7, f: 2.2, g: 2.0, h: 6.1,
  i: 7.0, j: 0.15, k: 0.77, l: 4.0, m: 2.4, n: 6.7, o: 7.5, p: 1.9,
  q: 0.095, r: 6.0, s: 6.3, t: 9.1, u: 2.8, v: 0.98, w: 2.4, x: 0.15,
  y: 2.0, z: 0.074,
};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function weightedRandomLetter() {
  const entries = Object.entries(LETTER_FREQUENCY);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = Math.random() * total;
  for (const [letter, w] of entries) {
    x -= w;
    if (x <= 0) return letter;
  }
  return entries[entries.length - 1][0];
}

// Common English digraphs, roughly ordered by frequency, for two-letter
// mode where every box holds a pair of letters.
const DIGRAPHS = [
  'TH', 'HE', 'IN', 'ER', 'AN', 'RE', 'ON', 'AT', 'EN', 'ND',
  'TI', 'ES', 'OR', 'TE', 'ED', 'IS', 'IT', 'AL', 'AR', 'ST',
  'TO', 'NT', 'NG', 'SE', 'HA', 'AS', 'OU', 'IO', 'LE', 'VE',
  'CO', 'ME', 'DE', 'HI', 'RI', 'RO', 'IC', 'NE', 'EA', 'RA',
  'CE', 'LI', 'CH', 'LL', 'BE', 'MA', 'SI', 'OM', 'UR', 'CA',
  'EL', 'TA', 'LA', 'NS', 'DI', 'FO', 'HO', 'PE', 'EC', 'PR',
];

function randomDigraph() {
  // Bias toward the more common digraphs at the front of the list.
  const i = Math.floor(Math.random() * DIGRAPHS.length * (0.4 + 0.6 * Math.random()));
  return DIGRAPHS[Math.min(i, DIGRAPHS.length - 1)];
}

function generateRandomDigraphBoard(rows, cols) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, randomDigraph));
}

function generateRandomBoard(rows, cols) {
  const count = rows * cols;
  let letters;
  if (count === 16) {
    letters = shuffle(DICE_4X4).map((die) => die[Math.floor(Math.random() * die.length)]);
  } else if (count === 25) {
    letters = shuffle(DICE_5X5).map((die) => die[Math.floor(Math.random() * die.length)]);
  } else {
    letters = Array.from({ length: count }, weightedRandomLetter);
  }

  const board = [];
  for (let r = 0; r < rows; r++) {
    board.push(letters.slice(r * cols, r * cols + cols).map((l) => (l === 'Q' ? 'Qu' : l)));
  }
  return board;
}

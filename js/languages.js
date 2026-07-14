// Language definitions. Each language supplies everything the rest of the
// app needs to stay language-agnostic: its dictionary, how to clean typed
// input, how to map board letters to dictionary form, letter frequencies
// for random boards, and OCR settings.

// Hebrew final letters (used at the end of a word) map to their regular
// forms for matching: the board holds regular letters, and a word like
// שולחן must match a path ending in נ.
const HE_FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

function heNormalize(s) {
  return s.replace(/[ךםןףץ]/g, (ch) => HE_FINALS[ch]);
}

// Rough modern-Hebrew letter frequencies (%), for random boards.
const HE_LETTER_FREQUENCY = {
  'א': 6.5, 'ב': 4.9, 'ג': 1.9, 'ד': 3.0, 'ה': 8.2, 'ו': 10.0, 'ז': 1.1,
  'ח': 2.6, 'ט': 1.4, 'י': 10.5, 'כ': 3.3, 'ל': 6.9, 'מ': 6.7, 'נ': 4.5,
  'ס': 1.9, 'ע': 3.1, 'פ': 2.5, 'צ': 1.6, 'ק': 2.3, 'ר': 5.5, 'ש': 5.6, 'ת': 6.0,
};

// Yiddish is written in Hebrew script with extra conventions: ligature
// digraphs (װ=וו, ױ=וי, ײ=יי) and diacritics that distinguish letters
// (אַ/אָ, פּ/פֿ, בֿ, שׂ, תּ…). Board cells hold plain base letters, so matching
// decomposes ligatures, strips the marks, and folds finals — a word like
// ייִדיש matches the path י-י-ד-י-ש.
const YI_LIGATURES = { 'װ': 'וו', 'ױ': 'וי', 'ײ': 'יי' };

function yiNormalize(s) {
  return heNormalize(
    s.replace(/[װױײ]/g, (ch) => YI_LIGATURES[ch]).replace(/[\u05B0-\u05C7]/g, ''),
  );
}

// Letter frequencies (%) computed over the Yiddish dictionary's normalized
// words, for random boards.
const YI_LETTER_FREQUENCY = {
  'ע': 12.4, 'י': 12.4, 'נ': 9.0, 'א': 8.6, 'ר': 8.5, 'ו': 6.7, 'ט': 6.1,
  'ק': 5.5, 'ד': 4.2, 'פ': 3.9, 'ס': 3.8, 'ל': 3.6, 'ג': 3.4, 'ש': 2.6,
  'מ': 2.1, 'ב': 2.0, 'צ': 1.6, 'כ': 1.3, 'ז': 1.0, 'ה': 0.7, 'ת': 0.2, 'ח': 0.2,
};

const EN_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const HE_LETTERS = 'אבגדהוזחטיכלמנסעפצקרשת';

const LANGUAGES = {
  en: {
    id: 'en',
    name: 'English',
    dir: 'ltr',
    dictUrl: 'data/words.txt',
    alphabet: EN_UPPER,
    stripRegex: /[^a-zA-Z]/g,
    // How a letter is shown in a board cell.
    display: (s) => s.toUpperCase(),
    // How board letters / dictionary words are mapped for matching.
    match: (s) => s.toLowerCase(),
    minLength: 3,
    hasLevels: true,
    hasCase: true,
    digraphs: true, // use the English digraph table for 2-letter boards
    tessLang: 'eng',
    tessWhitelist: EN_UPPER,
    // English-only OCR heuristics (rotation twins, I/O rescue, Qu die).
    latinHeuristics: true,
  },
  he: {
    id: 'he',
    name: 'עברית',
    dir: 'rtl',
    dictUrl: 'data/words-he.txt',
    alphabet: HE_LETTERS,
    stripRegex: /[^א-תךםןףץ]/g,
    // Boards hold regular (non-final) forms; typing a final converts.
    display: (s) => heNormalize(s),
    match: (s) => heNormalize(s),
    minLength: 2,
    hasLevels: false,
    hasCase: false,
    digraphs: false,
    letterFrequency: HE_LETTER_FREQUENCY,
    tessLang: 'heb',
    tessWhitelist: HE_LETTERS + 'ךםןףץ',
    latinHeuristics: false,
  },
  yi: {
    id: 'yi',
    name: 'ייִדיש',
    dir: 'rtl',
    dictUrl: 'data/words-yi.txt',
    alphabet: HE_LETTERS,
    // Base letters, finals, ligature digraphs and pointing marks are all
    // legal input — display() folds them down to base letters.
    stripRegex: /[^א-תךםןףץװױײ\u05B0-\u05C7]/g,
    display: (s) => yiNormalize(s),
    match: (s) => yiNormalize(s),
    minLength: 2,
    hasLevels: false,
    hasCase: false,
    digraphs: false,
    letterFrequency: YI_LETTER_FREQUENCY,
    tessLang: 'yid',
    tessWhitelist: HE_LETTERS + 'ךםןףץװױײ',
    latinHeuristics: false,
  },
};

function weightedRandomFrom(freqTable) {
  const entries = Object.entries(freqTable);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = Math.random() * total;
  for (const [letter, w] of entries) {
    x -= w;
    if (x <= 0) return letter;
  }
  return entries[entries.length - 1][0];
}

function randomLetterFor(lang) {
  if (lang.letterFrequency) return weightedRandomFrom(lang.letterFrequency);
  return weightedRandomLetter().toUpperCase(); // english (dice.js)
}

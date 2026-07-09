(() => {
  const MIN_SIZE = 3;
  const MAX_SIZE = 10;

  const state = {
    rows: 4,
    cols: 4,
    board: [], // rows x cols of strings, e.g. "A", "Qu", ""
    trie: null,
    results: null, // Map word -> { path, score }
    activeWord: null,
  };

  const el = {
    rowsInput: document.getElementById('rows-input'),
    colsInput: document.getElementById('cols-input'),
    randomBtn: document.getElementById('random-btn'),
    richBtn: document.getElementById('rich-btn'),
    clearBtn: document.getElementById('clear-btn'),
    imageInput: document.getElementById('image-input'),
    ocrStatus: document.getElementById('ocr-status'),
    boardGrid: document.getElementById('board-grid'),
    minLengthInput: document.getElementById('min-length-input'),
    solveBtn: document.getElementById('solve-btn'),
    dictStatus: document.getElementById('dict-status'),
    resultsSummary: document.getElementById('results-summary'),
    resultsList: document.getElementById('results-list'),
    wordSearch: document.getElementById('word-search'),
    twoLetterToggle: document.getElementById('two-letter-toggle'),
  };

  function maxCellLetters() {
    return el.twoLetterToggle.checked ? 2 : 1;
  }

  function emptyBoard(rows, cols) {
    return Array.from({ length: rows }, () => new Array(cols).fill(''));
  }

  function clampSize(n) {
    n = Math.round(Number(n) || MIN_SIZE);
    return Math.min(MAX_SIZE, Math.max(MIN_SIZE, n));
  }

  function cellInput(r, c) {
    return document.getElementById(`cell-${r}-${c}`);
  }

  // Rows must be sized explicitly from the measured column width: with only
  // aspect-ratio on the cells, Chromium under-sizes the implicit grid rows
  // and the bottom rows of big boards paint on top of the controls below.
  // Letters scale with the cell size so any board size stays readable.
  function fitBoard() {
    const wrapper = el.boardGrid.querySelector('.cell-wrapper');
    if (wrapper && wrapper.clientWidth) {
      el.boardGrid.style.gridAutoRows = `${wrapper.clientWidth}px`;
      el.boardGrid.style.setProperty('--cell-fs', `${Math.max(11, Math.round(wrapper.clientWidth * 0.42))}px`);
    }
  }

  function renderGrid() {
    el.boardGrid.style.setProperty('--cols', state.cols);
    el.boardGrid.style.gridTemplateColumns = `repeat(${state.cols}, minmax(0, 1fr))`;
    el.boardGrid.innerHTML = '';

    for (let r = 0; r < state.rows; r++) {
      for (let c = 0; c < state.cols; c++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'cell-wrapper';

        const input = document.createElement('input');
        input.type = 'text';
        input.id = `cell-${r}-${c}`;
        input.className = 'board-cell';
        input.maxLength = maxCellLetters();
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.value = state.board[r][c] || '';
        input.dataset.r = r;
        input.dataset.c = c;

        const badge = document.createElement('span');
        badge.className = 'cell-badge';
        badge.id = `badge-${r}-${c}`;

        input.addEventListener('input', onCellInput);
        input.addEventListener('keydown', onCellKeydown);

        wrapper.appendChild(input);
        wrapper.appendChild(badge);
        el.boardGrid.appendChild(wrapper);
      }
    }
    requestAnimationFrame(fitBoard);
  }

  function onCellInput(e) {
    const input = e.target;
    const r = Number(input.dataset.r);
    const c = Number(input.dataset.c);
    const cleaned = input.value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, maxCellLetters());
    input.value = cleaned;
    state.board[r][c] = cleaned;
    input.classList.remove('needs-review');
    clearResults();

    // Jump to the next box once this one has a letter — except after a lone
    // "Q" in two-letter mode, where a "u" is probably coming next.
    const waitForU = maxCellLetters() === 2 && cleaned === 'Q';
    if (cleaned.length >= 1 && !waitForU) {
      focusCell(r, c + 1, r + 1, 0);
    }
  }

  function focusCell(r, c, wrapR, wrapC) {
    let target = cellInput(r, c);
    if (!target && wrapR < state.rows) target = cellInput(wrapR, wrapC);
    if (target) target.focus();
  }

  function onCellKeydown(e) {
    const input = e.target;
    const r = Number(input.dataset.r);
    const c = Number(input.dataset.c);
    const moves = {
      ArrowRight: [r, c + 1],
      ArrowLeft: [r, c - 1],
      ArrowUp: [r - 1, c],
      ArrowDown: [r + 1, c],
      Enter: [r + 1, c],
    };
    if (moves[e.key]) {
      e.preventDefault();
      const [nr, nc] = moves[e.key];
      const target = cellInput(nr, nc);
      if (target) target.focus();
    } else if (e.key === 'Backspace' && !input.value) {
      const target = cellInput(r, c - 1) || (r > 0 ? cellInput(r - 1, state.cols - 1) : null);
      if (target) target.focus();
    }
  }

  function applyResize() {
    const newRows = clampSize(el.rowsInput.value);
    const newCols = clampSize(el.colsInput.value);
    el.rowsInput.value = newRows;
    el.colsInput.value = newCols;

    const newBoard = emptyBoard(newRows, newCols);
    for (let r = 0; r < Math.min(newRows, state.rows); r++) {
      for (let c = 0; c < Math.min(newCols, state.cols); c++) {
        newBoard[r][c] = state.board[r][c];
      }
    }
    state.rows = newRows;
    state.cols = newCols;
    state.board = newBoard;
    renderGrid();
    clearResults();
  }

  function fillBoard(letters) {
    const limit = maxCellLetters();
    state.board = letters.map((row) => row.map((cell) => (cell || '').toUpperCase().slice(0, limit)));
    renderGrid();
    clearResults();
  }

  function setDictStatus(text) {
    el.dictStatus.textContent = text;
  }

  function setOcrStatus(text) {
    el.ocrStatus.textContent = text;
  }

  async function loadDictionary() {
    try {
      state.trie = await Trie.buildFromUrl('data/words.txt', (frac) => {
        setDictStatus(`Loading dictionary… ${Math.round(frac * 100)}%`);
      });
      setDictStatus('Dictionary ready');
      el.solveBtn.disabled = false;
      el.richBtn.disabled = false;
      setTimeout(() => setDictStatus(''), 2500);
    } catch (err) {
      setDictStatus('Failed to load dictionary — check your connection and reload.');
      console.error(err);
    }
  }

  function clearResults() {
    state.results = null;
    state.activeWord = null;
    el.resultsSummary.textContent = '';
    el.resultsList.innerHTML = '<div class="empty-state">No words yet — fill in the board and click "Find words".</div>';
    el.wordSearch.value = '';
    el.wordSearch.disabled = true;
    clearHighlight();
  }

  function clearHighlight() {
    document.querySelectorAll('.board-cell.highlight').forEach((c) => c.classList.remove('highlight'));
    document.querySelectorAll('.cell-badge.show').forEach((b) => {
      b.classList.remove('show');
      b.textContent = '';
    });
    document.querySelectorAll('.word-chip.active').forEach((c) => c.classList.remove('active'));
  }

  function highlightPath(path, chipEl) {
    clearHighlight();
    path.forEach(([r, c], i) => {
      const input = cellInput(r, c);
      const badge = document.getElementById(`badge-${r}-${c}`);
      if (input) input.classList.add('highlight');
      if (badge) {
        badge.textContent = String(i + 1);
        badge.classList.add('show');
      }
    });
    if (chipEl) chipEl.classList.add('active');
  }

  function findEmptyCells() {
    const empties = [];
    for (let r = 0; r < state.rows; r++) {
      for (let c = 0; c < state.cols; c++) {
        if (!state.board[r][c]) empties.push([r, c]);
      }
    }
    return empties;
  }

  function solve() {
    const empties = findEmptyCells();
    if (empties.length > 0) {
      empties.forEach(([r, c]) => cellInput(r, c)?.classList.add('needs-review'));
      el.resultsList.innerHTML = '<div class="empty-state">Fill in every cell (highlighted in red) before solving.</div>';
      el.resultsSummary.textContent = '';
      return;
    }
    if (!state.trie) return;

    const lowerBoard = state.board.map((row) => row.map((cell) => cell.toLowerCase()));
    const minLength = Number(el.minLengthInput.value);
    const results = solveBoggle(lowerBoard, state.trie, minLength);
    state.results = results;
    renderResults();
  }

  function renderResults() {
    clearHighlight();
    const results = state.results;
    if (!results || results.size === 0) {
      el.resultsSummary.textContent = '';
      el.resultsList.innerHTML = '<div class="empty-state">No words found on this board.</div>';
      return;
    }
    el.wordSearch.disabled = false;

    let words = [...results.entries()].sort((a, b) => {
      if (b[0].length !== a[0].length) return b[0].length - a[0].length;
      return a[0].localeCompare(b[0]);
    });

    const totalScore = words.reduce((s, [, v]) => s + v.score, 0);
    el.resultsSummary.textContent = `${words.length} word${words.length === 1 ? '' : 's'} · ${totalScore} pts`;

    const query = el.wordSearch.value.replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (query) {
      words = words.filter(([word]) => word.includes(query));
      if (words.length === 0) {
        el.resultsList.innerHTML = `<div class="empty-state">No word containing “${query}” on this board.</div>`;
        return;
      }
    }

    const byLength = new Map();
    for (const [word, info] of words) {
      if (!byLength.has(word.length)) byLength.set(word.length, []);
      byLength.get(word.length).push([word, info]);
    }

    el.resultsList.innerHTML = '';
    for (const length of [...byLength.keys()].sort((a, b) => b - a)) {
      const group = document.createElement('div');
      group.className = 'results-group';

      const title = document.createElement('div');
      title.className = 'results-group__title';
      title.textContent = `${length} letters (${byLength.get(length).length})`;
      group.appendChild(title);

      const row = document.createElement('div');
      row.className = 'word-chip-row';
      for (const [word, info] of byLength.get(length)) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'word-chip';
        chip.textContent = word;
        chip.addEventListener('click', () => highlightPath(info.path, chip));
        row.appendChild(chip);
      }
      group.appendChild(row);
      el.resultsList.appendChild(group);
    }
  }

  async function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    el.imageInput.value = '';

    setOcrStatus('Reading image…');
    try {
      const { board, review } = await recognizeBoardFromImage(file, state.rows, state.cols, (status, progress) => {
        setOcrStatus(`${status} ${Math.round(progress * 100)}%`);
      });
      const limit = maxCellLetters();
      state.board = board.map((row) => row.map((cell) => {
        const v = cell === 'Q' && limit === 2 ? 'QU' : cell;
        return v.slice(0, limit);
      }));
      renderGrid();
      clearResults();
      for (let r = 0; r < state.rows; r++) {
        for (let c = 0; c < state.cols; c++) {
          if (review[r][c] || !state.board[r][c]) cellInput(r, c)?.classList.add('needs-review');
        }
      }
      setOcrStatus('Detected! Please review the letters (red = uncertain) before solving.');
    } catch (err) {
      console.error(err);
      setOcrStatus('Could not read that image. Try a clearer, tightly-cropped photo of the board.');
    }
  }

  // Roll many random boards, solve each, and keep the one richest in long
  // words. Long words are weighted quadratically so one 8-letter word beats
  // a pile of extra 4-letter ones.
  async function generateLongWordBoard() {
    const cells = state.rows * state.cols;
    const candidates = cells <= 25 ? 60 : cells <= 36 ? 25 : 10;
    el.richBtn.disabled = true;
    let best = null;
    let bestScore = -1;
    let bestLongest = 0;
    for (let i = 0; i < candidates; i++) {
      const board = generateRandomBoard(state.rows, state.cols);
      const lower = board.map((row) => row.map((cell) => cell.toLowerCase()));
      const words = solveBoggle(lower, state.trie, 6);
      let score = 0;
      let longest = 0;
      for (const word of words.keys()) {
        score += word.length * word.length;
        longest = Math.max(longest, word.length);
      }
      score += longest * 200;
      if (score > bestScore) {
        bestScore = score;
        best = board;
        bestLongest = longest;
      }
      // yield to the browser occasionally so the UI doesn't freeze
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
    }
    el.richBtn.disabled = false;
    fillBoard(best);
    setOcrStatus(bestLongest >= 6
      ? `Board picked from ${candidates} rolls — its longest word has ${bestLongest} letters.`
      : `Board picked from ${candidates} rolls.`);
  }

  // Size changes apply instantly — no separate button to remember.
  el.rowsInput.addEventListener('change', applyResize);
  el.colsInput.addEventListener('change', applyResize);
  el.randomBtn.addEventListener('click', () => fillBoard(generateRandomBoard(state.rows, state.cols)));
  el.richBtn.addEventListener('click', generateLongWordBoard);
  el.clearBtn.addEventListener('click', () => fillBoard(emptyBoard(state.rows, state.cols)));
  el.solveBtn.addEventListener('click', solve);
  el.minLengthInput.addEventListener('change', clearResults);
  el.imageInput.addEventListener('change', handleImageUpload);
  el.twoLetterToggle.addEventListener('change', () => {
    if (!el.twoLetterToggle.checked) {
      state.board = state.board.map((row) => row.map((cell) => cell.slice(0, 1)));
    }
    renderGrid();
    clearResults();
  });
  el.wordSearch.addEventListener('input', () => {
    if (state.results) renderResults();
  });
  el.wordSearch.addEventListener('keydown', (e) => {
    // Enter shows the first matching word's path on the board.
    if (e.key === 'Enter') {
      const chip = el.resultsList.querySelector('.word-chip');
      if (chip) chip.click();
    }
  });
  window.addEventListener('resize', fitBoard);

  state.board = emptyBoard(state.rows, state.cols);
  renderGrid();
  clearResults();
  loadDictionary();
})();

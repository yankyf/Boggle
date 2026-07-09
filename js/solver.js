// Boggle solving: DFS over the board guided by a Trie so we never explore a
// path whose letters aren't a prefix of some dictionary word.

const DIRECTIONS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

function scoreForLength(len) {
  if (len <= 4) return 1;
  if (len === 5) return 2;
  if (len === 6) return 3;
  if (len === 7) return 5;
  return 11;
}

/**
 * @param {string[][]} board - rows of cell strings, already lowercased
 *   (a cell may hold more than one letter, e.g. "qu").
 * @param {Trie} trie
 * @param {number} minLength - minimum letter count for a valid word
 * @returns {Map<string, {path: [number, number][], score: number}>}
 */
function solveBoggle(board, trie, minLength = 3) {
  const rows = board.length;
  const cols = rows ? board[0].length : 0;
  const found = new Map();
  const visited = Array.from({ length: rows }, () => new Array(cols).fill(false));

  function dfs(r, c, node, word, path) {
    const cellLetters = board[r][c];
    let cur = node;
    for (const ch of cellLetters) {
      cur = cur.children[ch];
      if (!cur) return; // no dictionary word has this prefix
    }
    const newWord = word + cellLetters;

    if (cur.isWord && newWord.length >= minLength && !found.has(newWord)) {
      found.set(newWord, { path: [...path], score: scoreForLength(newWord.length) });
    }

    for (const [dr, dc] of DIRECTIONS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (visited[nr][nc]) continue;
      visited[nr][nc] = true;
      path.push([nr, nc]);
      dfs(nr, nc, cur, newWord, path);
      path.pop();
      visited[nr][nc] = false;
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      visited[r][c] = true;
      dfs(r, c, trie.root, '', [[r, c]]);
      visited[r][c] = false;
    }
  }

  return found;
}

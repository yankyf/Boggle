// Minimal prefix trie used to prune the Boggle search as early as possible.

class TrieNode {
  constructor() {
    this.children = Object.create(null);
    this.isWord = false;
  }
}

class Trie {
  constructor() {
    this.root = new TrieNode();
  }

  insert(word) {
    let node = this.root;
    for (const ch of word) {
      let next = node.children[ch];
      if (!next) {
        next = new TrieNode();
        node.children[ch] = next;
      }
      node = next;
    }
    node.isWord = true;
  }

  static async buildFromUrl(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load dictionary: ${res.status}`);
    const text = await res.text();
    const words = text.split('\n');
    const trie = new Trie();
    const total = words.length;
    for (let i = 0; i < total; i++) {
      const w = words[i].trim();
      if (w) trie.insert(w);
      if (onProgress && i % 20000 === 0) onProgress(i / total);
    }
    if (onProgress) onProgress(1);
    return trie;
  }
}

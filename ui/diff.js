// Line diff for the history view: what changes if a backup is restored.
// Returns [{ op, text }] with op " " (same), "-" (only in `from`) or "+"
// (only in `to`).
// ponytail: plain LCS table, O(lines²) memory; fine for an ssh config
// (hundreds of lines). Use Myers' algorithm if files get much larger.
function lineDiff(from, to) {
  const a = from.split("\n");
  const b = to.split("\n");
  // lcs[i][j]: length of the longest common run of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: " ", text: a[i++] });
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // On a tie the removed line comes first, as in diff -u.
      out.push({ op: "-", text: a[i++] });
    } else {
      out.push({ op: "+", text: b[j++] });
    }
  }
  return out;
}

// For the Node check script; the browser just uses the global.
if (typeof module !== "undefined") module.exports = lineDiff;

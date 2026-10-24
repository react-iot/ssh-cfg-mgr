// Run: node scripts/check-diff.js
const assert = require("node:assert/strict");
const lineDiff = require("../ui/diff.js");
const show = (d) => d.map((l) => l.op + l.text).join("|");

assert.equal(show(lineDiff("a\nb\nc", "a\nb\nc")), " a| b| c");
assert.equal(show(lineDiff("a\nb\nc", "a\nx\nc")), " a|-b|+x| c");
assert.equal(show(lineDiff("a\nc", "a\nb\nc")), " a|+b| c");
assert.equal(show(lineDiff("a\nb", "")), "-a|-b|+");
// Applying the diff gives the new text back.
const from = "Host a\n  User x\n\nHost b\n  Port 22\n";
const to = "Host a\n  User y\n\nHost c\nHost b\n  Port 22\n";
assert.equal(lineDiff(from, to).filter((l) => l.op !== "-").map((l) => l.text).join("\n"), to);
assert.equal(lineDiff(from, to).filter((l) => l.op !== "+").map((l) => l.text).join("\n"), from);
console.log("diff ok");

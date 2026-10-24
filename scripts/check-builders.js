// Run: node scripts/check-builders.js
// Each value parses to fields and builds back to the same text.
const assert = require("node:assert/strict");
const B = require("../ui/builders.js");

const same = {
  localforward: ["9443 127.0.0.1:9443", "localhost:8080 db.internal:5432", "[::1]:8080 [fe80::1]:80"],
  remoteforward: ["8080 localhost:80", "*:9000 10.0.0.2:22", "1080"],
  dynamicforward: ["1080", "localhost:1080"],
  proxyjump: ["bastion", "admin@jump1:2222,jump2", "[2001:db8::1]:22"],
  preferredauthentications: ["publickey,keyboard-interactive,password"],
  setenv: ["LANG=en_US.UTF-8", 'FOO=bar "GREETING=hello world"'],
};
for (const [key, values] of Object.entries(same)) {
  for (const value of values) {
    assert.equal(B[key].build(B[key].parse(value)), value, `${key}: ${value}`);
  }
}

// Wrong or missing parts give null, so the dialog cannot use them.
assert.equal(B.localforward.build([{ bind: "", port: "70000", host: "h", hostport: "1" }]), null);
assert.equal(B.localforward.build([{ bind: "", port: "80", host: "", hostport: "1" }]), null);
assert.equal(B.remoteforward.build([{ bind: "", port: "80", host: "h", hostport: "" }]), null);
assert.equal(B.proxyjump.build([]), null);
assert.equal(B.setenv.build([{ name: "1BAD", value: "x" }]), null);
console.log("builders ok");

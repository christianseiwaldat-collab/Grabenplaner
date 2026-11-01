"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");

test("Historische Korpusbytes bleiben bei geerbtem core.autocrlf=true unverändert prüfbar", () => {
  // Emulate the workstation Git setting on Linux as well. The archive helper
  // must override it locally without changing global Git configuration.
  const priorCount = process.env.GIT_CONFIG_COUNT;
  const index = Number(priorCount || "0");
  assert.ok(Number.isSafeInteger(index) && index >= 0);
  const key = `GIT_CONFIG_KEY_${index}`, value = `GIT_CONFIG_VALUE_${index}`;
  const priorKey = process.env[key], priorValue = process.env[value];
  process.env.GIT_CONFIG_COUNT = String(index + 1);
  process.env[key] = "core.autocrlf";
  process.env[value] = "true";
  try {
    const { sourceRoot } = require("../test-support/legacy-baseline");
    const root = sourceRoot();
    const file = path.join(root, "lib/password-policy/common-sha256.txt");
    const content = fs.readFileSync(file);
    assert.equal(content.length, 195000);
    assert.equal(crypto.createHash("sha256").update(content).digest("hex"),
      "30c1197d30a6cf571b4080ddddeb750d894e9d3bc8a7a923dec2f741eebc8aa3");
    assert.equal(require(path.join(root, "lib/portal-password-policy.js")).metadata().available, true);
  } finally {
    for (const [name, previous] of [["GIT_CONFIG_COUNT", priorCount], [key, priorKey], [value, priorValue]]) {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
});

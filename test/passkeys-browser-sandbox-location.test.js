"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { assertSandboxLocation } = require("../test-support/passkeys-browser/write-ci-environment.cjs");
const pin = require("../test-support/passkeys-browser/browser-lock.json");
test("Passkey browser environment binds the exact root-owned sandbox destination and every ancestor", () => {
  const directory = "/var/lib/gp-passkeys-ci-sandbox/" + pin.sandbox.sha256;
  const ancestors = ["/", "/var", "/var/lib", "/var/lib/gp-passkeys-ci-sandbox", directory];
  const sandbox = { format: "gp-passkeys-ci-sandbox-v1", path: directory + "/chrome_sandbox", sha256: pin.sandbox.sha256,
    sandboxDisabled: false, directoryProofs: ancestors.map(value => ({ path: value, uid: 0, gid: 0, mode: 0o755, isDirectory: true, canonical: value })) };
  assert.doesNotThrow(() => assertSandboxLocation(sandbox));
  for (const mutate of [
    value => { value.path = "/opt/gp-passkeys-ci-sandbox/" + pin.sandbox.sha256 + "/chrome_sandbox"; },
    value => { value.sandboxDisabled = true; },
    value => { value.directoryProofs[0].uid = 1001; },
    value => { value.directoryProofs[1].mode = 0o775; },
    value => { value.directoryProofs[2].mode = 0o777; },
    value => { value.directoryProofs[3].canonical = "/outside/alias"; },
    value => { value.directoryProofs[4].isDirectory = false; },
    value => { value.directoryProofs.shift(); },
    value => { value.directoryProofs.push(value.directoryProofs.at(-1)); },
  ]) {
    const changed = structuredClone(sandbox); mutate(changed); assert.throws(() => assertSandboxLocation(changed));
  }
  const workflow = fs.readFileSync(path.resolve(__dirname, "../.github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /python3 test-support\/passkeys-browser\/test_sandbox\.py/);
  assert.match(workflow, /test\/passkeys-browser-sandbox-location\.test\.js/);
});

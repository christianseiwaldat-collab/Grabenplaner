"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process"), test = require("node:test");
const { createCapsule, verifyCapsule, hashFile, BASELINE, assertSeparatedOutput } = require("../scripts/legacy-recovery-capsule");
const root = path.resolve(__dirname, ".."), cli = path.join(root, "scripts/legacy-recovery-capsule.js");
test("legacy capsule rejects a mismatched supplied runtime pin before creating any output", () => {
  const output = path.join(os.tmpdir(), "gp-capsule-must-not-exist-" + Date.now());
  assert.throws(() => createCapsule({ repository: root, node: process.execPath, nodeSha256: "0".repeat(64), nodeVersion: process.version, output }), { code: "LEGACY_CAPSULE_RUNTIME_HASH" });
  assert.equal(fs.existsSync(output), false);
});

test("offline output cannot be placed inside retained stage or capsule, including path-prefix siblings", () => {
  const base = path.join(os.tmpdir(), "gp-retained-input-path-check");
  const stage = path.join(base, "stage"), capsule = path.join(base, "capsule");
  for (const retained of [stage, capsule]) {
    for (const output of [retained, path.join(retained, "new-output"), path.join(retained, "nested/new-output")]) {
      assert.throws(() => assertSeparatedOutput(output, stage, capsule), { code: "LEGACY_CAPSULE_OUTPUT_OVERLAPS_RETAINED_INPUT" });
    }
  }
  assert.doesNotThrow(() => assertSeparatedOutput(path.join(base, "stage-independent"), stage, capsule));
  assert.doesNotThrow(() => assertSeparatedOutput(path.join(base, "capsule-independent"), stage, capsule));
});

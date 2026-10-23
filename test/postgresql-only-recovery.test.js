"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process"), test = require("node:test");
const { createLegacyRecoveryFixture, thaw } = require("../test-support/legacy-recovery-fixture");
const root = path.resolve(__dirname, "..");
test("PostgreSQL recovery helpers load without loading a SQLite executable provider", () => {
  const result = spawnSync(process.execPath, ["-e", `const Module=require('node:module'),load=Module._load;Module._load=function(id,...args){if(id==='node:sqlite'||/persistence[\\\\/]sqlite/.test(id))throw new Error('SQLITE_LOADED:'+id);return load.call(this,id,...args)};const m=require('./server-tools/linux/recovery/lib/recovery-shared');if(m.compareSemver('0.9.0','0.10.0')!==-1)throw Error('semver');require('./server-tools/linux/recovery/lib/recovery-verify');require('./server-tools/linux/recovery/lib/recovery-apply');`], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
test("current recovery verifier rejects an old SQLite stage before SQLite loading or output writes", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-pg-only-recovery-"));
  try {
    const built = createLegacyRecoveryFixture(temporary);
    function freeze(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) freeze(file); else fs.chmodSync(file, 0o400); } fs.chmodSync(directory, 0o500); }
    freeze(built.stage);
    const { verifyRecovery } = require("../server-tools/linux/recovery/lib/recovery-verify");
    const policy = require("../server-tools/linux/recovery/lib/recovery-metadata").__internalTestOnly.nonRootOwnershipPolicy;
    const output = path.join(temporary, "must-not-exist.json");
    await assert.rejects(verifyRecovery({ stage: built.stage, stageHelper: path.join(root, "server-tools/linux/offsite/lib/offsite-stage.js"), requiredProvider: "postgresql-pair", output }, policy), { code: "RECOVERY_LEGACY_OFFLINE_REQUIRED" });
    assert.equal(fs.existsSync(output), false);
  } finally { thaw(temporary); fs.rmSync(temporary, { recursive: true, force: true }); }
});
test("current generic recovery apply CLI rejects SQLite before accessing target paths", () => {
  assert.throws(() => require("../server-tools/linux/recovery/lib/recovery-apply").applyRecovery({ "data-root": root }), { code: "RECOVERY_LEGACY_OFFLINE_REQUIRED" });
  const result = spawnSync(process.execPath, [path.join(root, "server-tools/linux/recovery/lib/recovery-apply.js"), "--data-root", root], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.match(result.stderr, /RECOVERY_LEGACY_OFFLINE_REQUIRED/);
});

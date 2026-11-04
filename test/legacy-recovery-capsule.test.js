"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process"), test = require("node:test");
const { createCapsule, verifyCapsule, hashFile, BASELINE, assertSeparatedOutput } = require("../scripts/legacy-recovery-capsule");
const { createLegacyRecoveryFixture, thaw } = require("../test-support/legacy-recovery-fixture");
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
test("Linux capsule restores old SQLite to a new isolated workspace and fails closed for tamper, wrong keys and current targets", { skip: process.platform !== "linux", timeout: 600000 }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-legacy-capsule-test-"));
  try {
    const capsule = path.join(temporary, "capsule"), created = createCapsule({ repository: root, node: process.execPath, nodeSha256: hashFile(process.execPath), nodeVersion: process.version, output: capsule });
    assert.equal(created.baseline, BASELINE);
    const manifest = verifyCapsule(capsule, created.manifestSha256);
    assert.equal(manifest.dependencies.recovery, "node-builtins-only");
    assert.equal(manifest.applicationStart, false);
    assert.equal(manifest.files.some(x => /(?:^|\/)node_modules\//.test(x.file)), false);
    const fixtureRoot = path.join(temporary, "fixture"); fs.mkdirSync(fixtureRoot);
    const built = createLegacyRecoveryFixture(fixtureRoot), before = hashFile(built.database);
    const restore = (output, environment = built.environment) => spawnSync(process.execPath, [cli, "restore", "--capsule", capsule, "--manifest-sha256", created.manifestSha256, "--stage", built.stage, "--environment", environment, "--output", output], { encoding: "utf8", timeout: 180000 });
    const target = path.join(temporary, "offline"), result = restore(target);
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.servicesStarted, false); assert.equal(evidence.offlineOnly, true);
    assert.equal(evidence.databaseSha256, built.databaseSha256); assert.equal(hashFile(built.database), before);
    const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(path.join(target, "restored/data/dienstplan.db"), { readOnly: true });
    try { assert.equal(db.prepare("SELECT value FROM recovery_marker").get().value, "restored-offline"); } finally { db.close(); }
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, "verification.json"))).protectedRecords, 1);
    for (const retained of [built.stage, capsule]) {
      const nestedTarget = path.join(retained, "forbidden-output"), refused = restore(nestedTarget);
      assert.equal(refused.status, 1); assert.match(refused.stderr, /LEGACY_CAPSULE_OUTPUT_OVERLAPS_RETAINED_INPUT/);
      assert.equal(fs.existsSync(nestedTarget), false);
    }
    assert.equal(hashFile(built.database), before);
    const sameTarget = restore(target); assert.equal(sameTarget.status, 1); assert.match(sameTarget.stderr, /LEGACY_CAPSULE_NEW_ROOT_REQUIRED/);
    const currentTarget = path.join(temporary, "current-pg"); fs.mkdirSync(currentTarget); fs.writeFileSync(path.join(currentTarget, "postgresql-pair.json"), "protected");
    const blocked = restore(currentTarget); assert.equal(blocked.status, 1); assert.match(blocked.stderr, /LEGACY_CAPSULE_NEW_ROOT_REQUIRED/);
    assert.equal(fs.readFileSync(path.join(currentTarget, "postgresql-pair.json"), "utf8"), "protected");
    const badKeys = path.join(temporary, "bad-keys.env"); fs.writeFileSync(badKeys, fs.readFileSync(built.environment, "utf8").replace(/GRABENPLANER_AMU_KEY=.+/, "GRABENPLANER_AMU_KEY=" + Buffer.alloc(32, 99).toString("base64")), { mode: 0o600 });
    const badTarget = path.join(temporary, "wrong-key"), badResult = restore(badTarget, badKeys);
    assert.equal(badResult.status, 1); assert.equal(fs.existsSync(path.join(badTarget, "restored")), false);
    assert.equal(hashFile(built.database), before);
    assert.throws(() => verifyCapsule(capsule, "0".repeat(64)), { code: "LEGACY_CAPSULE_MANIFEST_HASH" });
    const manifestFile = path.join(capsule, "capsule.json"), originalManifest = fs.readFileSync(manifestFile);
    const incompatible = JSON.parse(originalManifest); incompatible.runtime.native.libraries[0].originalPath = "/nonexistent/gp-legacy-native-library.so";
    fs.chmodSync(manifestFile, 0o600); fs.writeFileSync(manifestFile, JSON.stringify(incompatible));
    const incompatibleTarget = path.join(temporary, "incompatible-host");
    const nativeMismatch = spawnSync(process.execPath, [cli, "restore", "--capsule", capsule, "--manifest-sha256", hashFile(manifestFile), "--stage", built.stage, "--environment", built.environment, "--output", incompatibleTarget], { encoding: "utf8" });
    assert.equal(nativeMismatch.status, 1); assert.match(nativeMismatch.stderr, /LEGACY_CAPSULE_NATIVE_HOST_MISMATCH/);
    assert.equal(fs.existsSync(incompatibleTarget), false);
    fs.writeFileSync(manifestFile, originalManifest); fs.chmodSync(manifestFile, 0o400);
    const source = path.join(capsule, "source/lib/amu-storage.js"), old = fs.readFileSync(source);
    fs.appendFileSync(source, "\n// simulated tamper\n");
    assert.throws(() => verifyCapsule(capsule, created.manifestSha256), { code: "LEGACY_CAPSULE_CONTENT_HASH" });
    fs.writeFileSync(source, old);
    fs.symlinkSync(source, path.join(capsule, "unexpected-link"));
    assert.throws(() => verifyCapsule(capsule, created.manifestSha256), { code: "LEGACY_CAPSULE_LINK" });
    fs.unlinkSync(path.join(capsule, "unexpected-link"));
    const runtime = path.join(capsule, manifest.runtime.executable); fs.chmodSync(runtime, 0o700);
    const descriptor = fs.openSync(runtime, "r+");
    const byte = Buffer.alloc(1), offset = fs.fstatSync(descriptor).size - 1; fs.readSync(descriptor, byte, 0, 1, offset);
    const changed = Buffer.from([byte[0] ^ 0xff]); fs.writeSync(descriptor, changed, 0, 1, offset); fs.closeSync(descriptor);
    assert.throws(() => verifyCapsule(capsule, created.manifestSha256), { code: "LEGACY_CAPSULE_CONTENT_HASH" });
  } finally { thaw(temporary); fs.rmSync(temporary, { recursive: true, force: true }); }
});

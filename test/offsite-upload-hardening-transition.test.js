"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const helper = require("../server-tools/linux/lib/offsite-upload-hardening-compat.js");
const { classify } = require("../server-tools/linux/lib/offsite-update-compat.js");
const ROOT = path.resolve(__dirname, ".."), MODULE = path.join(ROOT, "server-tools/linux/offsite");
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const rootOnly = process.platform === "linux" && process.getuid() === 0;
function contract(root) {
  const result = spawnSync(process.execPath, [path.join(MODULE, "lib/offsite-contract.js"), "contract", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
const binding = { format: "grabenplaner-offsite-provider-binding", schemaVersion: 1, providerId: "google_drive", remoteName: "synthetic",
  backend: "drive", authentication: "dedicated_oauth", endpoint: null, region: null, scope: "drive.file", configSha256: "a".repeat(64),
  policySha256: "b".repeat(64), repositoryLayout: "google-drive-direct-safe-path-v1", storageRoot: null };
function fixture(t) {
  // Real root-owned fixture; no production app, state, credentials or repository.
  const root = fs.mkdtempSync("/root/gp-offsite-upload-refresh-test-"); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, "module"), candidate = path.join(root, "candidate"), receipt = path.join(root, "receipt.json");
  for (const target of [old, candidate]) fs.cpSync(MODULE, target, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "fixtures/offsite-upload-module13-predecessor.sh"), path.join(old, helper.ARTIFACT));
  function protect(directory) {
    fs.chmodSync(directory, 0o755);
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) protect(file); else fs.chmodSync(file, item.name.endsWith(".sh") ? 0o755 : 0o644);
    }
  }
  protect(old); protect(candidate);
  const before = contract(old), after = contract(candidate);
  assert.equal(before.fingerprint, helper.OLD_FINGERPRINT);
  fs.writeFileSync(receipt, JSON.stringify({ ...before, providerBinding: binding }) + "\n", { mode: 0o600 });
  const app = path.join(root, "app-manifest.json"), nextApp = path.join(root, "candidate-manifest.json");
  fs.writeFileSync(app, '{"version":"0.92.100-beta"}\n', { mode: 0o644 });
  fs.writeFileSync(nextApp, '{"version":"0.92.101-beta"}\n', { mode: 0o644 });
  const prepare = () => helper.prepare(old, candidate, receipt, after.fingerprint, app, nextApp, "c".repeat(64)).transaction;
  return { root, old, candidate, receipt, before, after, app, nextApp, prepare };
}
test("generic same-version fingerprint gate remains closed for the new upload", () => {
  const candidate = contract(MODULE);
  const before = { ...candidate, fingerprint: helper.OLD_FINGERPRINT, files: candidate.files.map(item => item.path === helper.ARTIFACT ? { ...item, sha256: helper.OLD_UPLOAD } : item) };
  const envelope = { offsiteModule: { schemaVersion: 1, moduleVersion: 13, activationPolicy: "explicit-root-setup", fingerprint: candidate.fingerprint,
    installerSha256: candidate.files.find(item => item.path === "install-grabenplaner-offsite.sh").sha256,
    managedArtifacts: candidate.files.map(item => `server-tools/linux/offsite/${item.path}`) } };
  assert.equal(classify(envelope, before), "migration-required:13->13");
  assert.equal(classify(envelope, candidate), "compatible");
});
test("explicit coordinator binds package, keeps old updater and uses actual nonblocking locks", () => {
  const source = fs.readFileSync(path.join(ROOT, "server-tools/linux/refresh-grabenplaner-offsite-upload.sh"), "utf8");
  assert.match(source, /gp_verify_sealed_zip "\$package" "\$candidate" 0/);
  assert.match(source, /cmp --silent.*\$candidate\/server-tools\/linux/);
  assert.match(source, /bash "\$APP\/server-tools\/linux\/update-grabenplaner-server\.sh"/);
  assert.match(source, /flock --nonblock "\$descriptor"/);
  assert.doesNotMatch(source, /offsite_acquire_(assurance|repository)_lock/);
  assert.match(source, /--verification auto/);
});
test("exact upload-only refresh, unchanged binding/state and exact rollback", { skip: !rootOnly }, t => {
  const f = fixture(t), originalReceipt = fs.readFileSync(f.receipt), originalUpload = fs.readFileSync(path.join(f.old, helper.ARTIFACT));
  const unrelated = path.join(f.root, "status.json"); fs.writeFileSync(unrelated, '{"unchanged":true}'); const originalStatus = digest(unrelated);
  const tx = f.prepare();
  assert.equal(helper.apply(tx).fingerprint, f.after.fingerprint);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt)).providerBinding, binding);
  assert.equal(digest(unrelated), originalStatus);
  assert.equal(helper.rollback(tx).fingerprint, helper.OLD_FINGERPRINT);
  assert.deepEqual(fs.readFileSync(f.receipt), originalReceipt); assert.deepEqual(fs.readFileSync(path.join(f.old, helper.ARTIFACT)), originalUpload);
  assert.equal(fs.statSync(tx).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(tx)) assert.equal(fs.statSync(path.join(tx, name)).mode & 0o777, 0o600);
});
test("interruption after artifact rename and before receipt publication recovers exactly", { skip: !rootOnly }, t => {
  const f = fixture(t), tx = f.prepare(), journalPath = path.join(tx, "journal.json"), journal = JSON.parse(fs.readFileSync(journalPath));
  // State produced by SIGKILL between the two durable atomic renames.
  journal.state = "applying"; fs.writeFileSync(journalPath, JSON.stringify(journal));
  fs.copyFileSync(path.join(tx, "new-upload"), path.join(f.old, helper.ARTIFACT)); fs.chmodSync(path.join(f.old, helper.ARTIFACT), 0o755);
  assert.equal(helper.transaction(tx).state, "applying");
  assert.equal(helper.rollback(tx).state, "rolled-back");
  assert.equal(contract(f.old).fingerprint, helper.OLD_FINGERPRINT);
});
test("real killed helper and failed receipt rename preserve a recoverable write-ahead journal", { skip: !rootOnly }, t => {
  const f = fixture(t), tx = f.prepare(), upload = path.join(f.old, helper.ARTIFACT);
  const entry = path.join(ROOT, "server-tools/linux/lib/offsite-upload-hardening-compat.js");
  const script = `const fs=require('node:fs'),rename=fs.renameSync;fs.renameSync=function(a,b){rename(a,b);if(b===process.argv[2])process.kill(process.pid,'SIGKILL')};require(process.argv[1]).apply(process.argv[3]);`;
  const child = spawnSync(process.execPath, ["-e", script, entry, upload, tx], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.signal, "SIGKILL", child.stderr); assert.equal(helper.transaction(tx).state, "applying");
  assert.equal(helper.rollback(tx).state, "rolled-back");
  const second = f.prepare(), rename = fs.renameSync;
  fs.renameSync = function (from, to) { if (to === f.receipt) { const error = new Error("simulated receipt publication I/O failure"); error.code = "EIO"; throw error; } return rename(from, to); };
  try { assert.throws(() => helper.apply(second), /simulated receipt publication/); } finally { fs.renameSync = rename; }
  assert.equal(fs.readdirSync(f.root).filter(name => /^\.upload-refresh-/.test(name)).length, 0);
  assert.equal(helper.transaction(second).state, "applying");
  assert.equal(helper.rollback(second).state, "rolled-back");
  assert.equal(contract(f.old).fingerprint, helper.OLD_FINGERPRINT);
});
test("committed app cannot roll back; committed finish is recoverable and idempotent", { skip: !rootOnly }, t => {
  const f = fixture(t), tx = f.prepare(); helper.apply(tx);
  fs.copyFileSync(f.nextApp, f.app);
  assert.throws(() => helper.rollback(tx), /UPLOAD_REFRESH_APP_COMMITTED_OR_UNKNOWN/);
  assert.equal(helper.finish(tx).state, "committed");
  const journal = fs.readFileSync(path.join(tx, "journal.json"));
  assert.equal(helper.finish(tx).state, "committed");
  assert.deepEqual(fs.readFileSync(path.join(tx, "journal.json")), journal);
  assert.throws(() => helper.rollback(tx), /UPLOAD_REFRESH_APP_COMMITTED_OR_UNKNOWN/);
});
test("unknown app or artifact state fails closed and retains exact backups", { skip: !rootOnly }, t => {
  const f = fixture(t), tx = f.prepare(); helper.apply(tx); fs.writeFileSync(f.app, "unknown");
  assert.throws(() => helper.rollback(tx), /UPLOAD_REFRESH_APP_COMMITTED_OR_UNKNOWN/);
  assert.throws(() => helper.finish(tx), /UPLOAD_REFRESH_APP_NOT_COMMITTED/);
  fs.copyFileSync(path.join(tx, "old-receipt"), f.receipt); fs.chmodSync(f.receipt, 0o600);
  fs.appendFileSync(path.join(f.old, helper.ARTIFACT), "\n# unknown\n");
  assert.throws(() => helper.rollback(tx), /UPLOAD_REFRESH_UNKNOWN_STATE/);
  assert.equal(digest(path.join(tx, "old-upload")), helper.OLD_UPLOAD);
});
test("unrelated module changes, wrong fingerprint, schema delta and damaged predecessor are refused", { skip: !rootOnly }, t => {
  const f = fixture(t);
  assert.throws(() => helper.verify(f.old, f.candidate, f.receipt, "d".repeat(64)), /UPLOAD_REFRESH_CANDIDATE/);
  const other = path.join(f.candidate, "grabenplaner-offsite-check.sh"); fs.appendFileSync(other, "\n# unrelated\n");
  assert.throws(() => helper.verify(f.old, f.candidate, f.receipt, contract(f.candidate).fingerprint), /UPLOAD_REFRESH_DELTA/);
  fs.copyFileSync(path.join(f.old, "grabenplaner-offsite-check.sh"), other);
  fs.appendFileSync(path.join(f.candidate, "module-schema.json"), "\n");
  assert.throws(() => helper.verify(f.old, f.candidate, f.receipt, contract(f.candidate).fingerprint), /UPLOAD_REFRESH_CANDIDATE/);
  fs.appendFileSync(path.join(f.old, "lib/offsite-contract.js"), "\n# corrupted\n");
  assert.throws(() => helper.verify(f.old, f.candidate, f.receipt, f.after.fingerprint), /UPLOAD_REFRESH_PREDECESSOR/);
});
test("unsafe receipt permissions, symlinks, hardlinks and backup tampering are refused", { skip: !rootOnly }, t => {
  const f = fixture(t); fs.chmodSync(f.receipt, 0o644);
  assert.throws(() => f.prepare(), /UPLOAD_REFRESH_PERMISSIONS/); fs.chmodSync(f.receipt, 0o600);
  const link = path.join(f.root, "link.json"); fs.symlinkSync(f.receipt, link);
  assert.throws(() => helper.verify(f.old, f.candidate, link, f.after.fingerprint), /UPLOAD_REFRESH_PATH/);
  const upload = path.join(f.candidate, helper.ARTIFACT), hardlink = path.join(f.root, "hardlink"); fs.linkSync(upload, hardlink);
  assert.throws(() => f.prepare(), /UPLOAD_REFRESH_PERMISSIONS/); fs.unlinkSync(hardlink);
  const tx = f.prepare(); fs.appendFileSync(path.join(tx, "old-upload"), "tamper");
  assert.throws(() => helper.apply(tx), /UPLOAD_REFRESH_BACKUP/);
  assert.equal(contract(f.old).fingerprint, helper.OLD_FINGERPRINT);
});

test("root CLI dispatch validates action and arity and completes the direct transaction commands", { skip: !rootOnly }, t => {
  const f = fixture(t), entry = path.join(ROOT, "server-tools/linux/lib/offsite-upload-hardening-compat.js");
  function cli(...args) { return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 15000 }); }
  for (const args of [[], ["unknown"], ["__proto__"], ["toString"], ["apply"], ["verify", "missing"], ["inspect", "one", "extra"]]) {
    const result = cli(...args); assert.equal(result.status, 1); assert.equal(result.stderr.trim(), "UPLOAD_REFRESH_ARGUMENTS"); assert.equal(result.stdout, "");
  }
  const verified = cli("verify", f.old, f.candidate, f.receipt, f.after.fingerprint);
  assert.equal(verified.status, 0, verified.stderr); assert.equal(JSON.parse(verified.stdout).candidateFingerprint, f.after.fingerprint);
  const prepared = cli("prepare", f.old, f.candidate, f.receipt, f.after.fingerprint, f.app, f.nextApp, "c".repeat(64));
  assert.equal(prepared.status, 0, prepared.stderr); const tx = JSON.parse(prepared.stdout).transaction;
  const inspected = cli("inspect", tx); assert.equal(inspected.status, 0, inspected.stderr); assert.equal(JSON.parse(inspected.stdout).state, "prepared");
  const applied = cli("apply", tx); assert.equal(applied.status, 0, applied.stderr); assert.equal(JSON.parse(applied.stdout).state, "applied");
  fs.copyFileSync(f.nextApp, f.app);
  for (let attempt = 0; attempt < 2; attempt += 1) { const result = cli("finish", tx); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).state, "committed"); }
  const rejected = cli("rollback", tx); assert.equal(rejected.status, 1); assert.equal(rejected.stderr.trim(), "UPLOAD_REFRESH_APP_COMMITTED_OR_UNKNOWN");
});

"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const helper = require("../server-tools/linux/lib/offsite-upload-hardening-compat.js");
const { classify, fingerprint } = require("../server-tools/linux/lib/offsite-update-compat.js");
const ROOT = path.resolve(__dirname, ".."), MODULE = path.join(ROOT, "server-tools/linux/offsite");
const INSTALLER = "install-grabenplaner-offsite.sh";
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const rootOnly = process.platform === "linux" && process.getuid() === 0;
function contract(root) {
  const result = spawnSync(process.execPath, [path.join(MODULE, "lib/offsite-contract.js"), "contract", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
const binding = { format: "grabenplaner-offsite-provider-binding", schemaVersion: 1, providerId: "google_drive", remoteName: "synthetic",
  backend: "drive", authentication: "dedicated_oauth", endpoint: null, region: null, scope: "drive.file", configSha256: "a".repeat(64),
  policySha256: "b".repeat(64), repositoryLayout: "google-drive-direct-safe-path-v1", storageRoot: null };
function replacedHash(receipt, artifact, sha256) {
  const files = receipt.files.map(item => item.path === artifact ? { ...item, sha256 } : item);
  return { ...receipt, fingerprint: fingerprint(new Map(files.map(item => [item.path, item.sha256]))), files };
}
function envelope(receipt) {
  return { offsiteModule: { schemaVersion: 1, moduleVersion: 13, activationPolicy: "explicit-root-setup", fingerprint: receipt.fingerprint,
    installerSha256: receipt.files.find(item => item.path === INSTALLER).sha256,
    managedArtifacts: receipt.files.map(item => "server-tools/linux/offsite/" + item.path) } };
}
function publishedOffsiteBytes(file, expectedSha256) {
  const result = spawnSync("git", ["-c", "safe.directory=" + ROOT, "-c", "core.fsmonitor=false", "show",
    "dbe3d998f6e6a96d6078376e50125db233caaa6c:server-tools/linux/offsite/" + file],
  { cwd: ROOT, timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  assert.equal(crypto.createHash("sha256").update(result.stdout).digest("hex"), expectedSha256);
  return result.stdout;
}
function addPublishedInstallerVariant(directory) {
  const file = path.join(directory, INSTALLER);
  assert.equal(digest(file), helper.REBIND.installer);
  const source = fs.readFileSync(file, "utf8"), anchor = '\nsetup_complete=1\nassurance_trigger="offsite-config-changed"';
  assert.equal(source.split(anchor).length, 2);
  fs.writeFileSync(file, source.replace(anchor, "\nsetup_complete=1\n" + [
    'if [[ -f "$OFFSITE_APP_ROOT/server-tools/linux/install-manual-drive-control.sh" && ! -L "$OFFSITE_APP_ROOT/server-tools/linux/install-manual-drive-control.sh" ]]; then',
    '  if ! /bin/bash "$OFFSITE_APP_ROOT/server-tools/linux/install-manual-drive-control.sh"; then',
    "    offsite_warn 'Die manuelle Google-Drive-Sicherungssteuerung bleibt bis zur sicheren Einrichtung nicht verfuegbar.'",
    "  fi",
    "fi",
    'assurance_trigger="offsite-config-changed"',
  ].join("\n")));
  assert.equal(digest(file), helper.REBIND.release105Installer);
}
function fixture(t, { kind = "upload", alternateInstaller = null } = {}) {
  // Real root-owned fixture; no production app, state, credentials or repository.
  const root = fs.mkdtempSync("/root/gp-offsite-upload-refresh-test-"); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, "module"), candidate = path.join(root, "candidate"), receipt = path.join(root, "receipt.json");
  for (const target of [old, candidate]) {
    fs.cpSync(MODULE, target, { recursive: true });
    fs.writeFileSync(path.join(target, INSTALLER), publishedOffsiteBytes(INSTALLER, helper.REBIND.installer));
  }
  const rebind = publishedOffsiteBytes(helper.REBIND.artifact, helper.REBIND.oldSha);
  fs.writeFileSync(path.join(old, helper.REBIND.artifact), rebind);
  if (kind === "upload") {
    fs.writeFileSync(path.join(candidate, helper.REBIND.artifact), rebind);
    fs.copyFileSync(path.join(__dirname, "fixtures/offsite-upload-module13-predecessor.sh"), path.join(old, helper.ARTIFACT));
  }
  if (alternateInstaller) addPublishedInstallerVariant(alternateInstaller === "installed" ? old : candidate);
  function protect(directory) {
    fs.chownSync(directory, 0, 0); fs.chmodSync(directory, 0o755);
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) protect(file);
      else { fs.chownSync(file, 0, 0); fs.chmodSync(file, item.name.endsWith(".sh") ? 0o755 : 0o644); }
    }
  }
  protect(old); protect(candidate);
  const before = contract(old), after = contract(candidate);
  const reviewed = kind === "upload" ? helper.OLD_FINGERPRINT : helper.REBIND.before;
  assert.equal(replacedHash(before, INSTALLER, helper.REBIND.installer).fingerprint, reviewed);
  if (kind === "rebind") assert.equal(replacedHash(after, INSTALLER, helper.REBIND.installer).fingerprint, helper.REBIND.after);
  fs.writeFileSync(receipt, JSON.stringify({ ...before, providerBinding: binding }) + "\n", { mode: 0o600 });
  const app = path.join(root, "app-manifest.json"), nextApp = path.join(root, "candidate-manifest.json");
  fs.writeFileSync(app, '{"version":"0.92.100-beta"}\n', { mode: 0o644 });
  fs.writeFileSync(nextApp, '{"version":"0.92.101-beta"}\n', { mode: 0o644 });
  const prepare = () => helper.prepare(old, candidate, receipt, after.fingerprint, app, nextApp, "c".repeat(64), kind).transaction;
  return { root, old, candidate, receipt, before, after, app, nextApp, prepare };
}
test("generic same-version fingerprint gate remains closed for the new upload", () => {
  const normalized = replacedHash(contract(MODULE), INSTALLER, helper.REBIND.installer);
  const candidate = replacedHash(normalized, helper.REBIND.artifact, helper.REBIND.oldSha);
  assert.equal(candidate.fingerprint, helper.REBIND.before);
  const before = replacedHash(candidate, helper.ARTIFACT, helper.OLD_UPLOAD);
  assert.equal(before.fingerprint, helper.OLD_FINGERPRINT);
  assert.equal(classify(envelope(candidate), before), "migration-required:13->13");
  assert.equal(classify(envelope(candidate), candidate), "compatible");
});
test("the old updater accepts the new rebind only after the exact module refresh", () => {
  const base = replacedHash(contract(MODULE), INSTALLER, helper.REBIND.installer);
  assert.equal(base.fingerprint, helper.REBIND.after);
  for (const installer of [helper.REBIND.installer, helper.REBIND.release105Installer]) {
    const after = replacedHash(base, INSTALLER, installer);
    const before = replacedHash(after, helper.REBIND.artifact, helper.REBIND.oldSha);
    const compatibility = installer === helper.REBIND.installer ? "compatible" : "compatible-installer-only";
    assert.equal(classify(envelope(base), before), "migration-required:13->13");
    assert.equal(classify(envelope(base), after), compatibility);
  }
});
test("explicit coordinator binds the candidate driver, retains installed verifier authority and actual nonblocking locks", () => {
  const source = fs.readFileSync(path.join(ROOT, "server-tools/linux/refresh-grabenplaner-offsite-upload.sh"), "utf8");
  assert.match(source, /gp_verify_sealed_zip "\$package" "\$candidate" 0/);
  assert.match(source, /cmp --silent.*\$candidate\/server-tools\/linux/);
  assert.match(source, /driver="\$candidate\/server-tools\/linux\/update-grabenplaner-server\.sh"/);
  assert.match(source, /update_args=\(--app-dir "\$APP"/);
  assert.match(source, /bash "\$driver" "\$\{update_args\[@\]\}"/);
  assert.match(source, /root_node "\$APP\/server-tools\/linux\/lib\/verify-package\.js" "\$candidate"/);
  assert.doesNotMatch(source, /root_node "\$candidate\/server-tools\/linux\/lib\/verify-package\.js"/);
  assert.match(source, /gp_sha256 "\$driver".*\$driver_sha/);
  assert.match(source, /gp_sha256 "\$candidate\/grabenplaner-server-manifest\.json".*\$candidate_manifest_sha/);
  const firstPrivate = source.indexOf("\nprivate_workspace_preflight\n"), scan = source.indexOf("\nclamscan --recursive");
  const fencedPrivate = source.indexOf("\nprivate_workspace_preflight\n", firstPrivate + 1), prepare = source.indexOf('prepared="$(root_node "$helper" "$prepare_action"');
  assert.match(source, /--rebind\) verify_action=verify-rebind; prepare_action=prepare-rebind/);
  const verify = source.indexOf('root_node "$helper" "$verify_action"');
  const apply = source.indexOf('root_node "$helper" apply');
  assert.ok(firstPrivate > 0 && firstPrivate < scan && fencedPrivate > scan && fencedPrivate < prepare);
  assert.ok(firstPrivate < verify && verify < scan && prepare < apply);
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
  const upload = path.join(f.candidate, helper.ARTIFACT), hardlink = path.join(f.root, "hardlink");
  fs.chownSync(upload, 1000, 1000);
  try { assert.throws(() => f.prepare(), /UPLOAD_REFRESH_PERMISSIONS/); }
  finally { fs.chownSync(upload, 0, 0); }
  fs.linkSync(upload, hardlink);
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

function serviceGroupApp(f) {
  const directory = path.join(f.root, "installed-app"), app = path.join(directory, "grabenplaner-server-manifest.json");
  fs.mkdirSync(directory, { mode: 0o750 }); fs.chownSync(directory, 0, 1000);
  fs.copyFileSync(f.app, app); fs.chownSync(app, 0, 1000); fs.chmodSync(app, 0o640);
  return { directory, app, prepare: () => helper.prepare(f.old, f.candidate, f.receipt,
    f.after.fingerprint, app, f.nextApp, "c".repeat(64)).transaction };
}

test("installed service-group manifest supports exact apply, rollback and idempotent commit", { skip: !rootOnly }, t => {
  const f = fixture(t), installed = serviceGroupApp(f);
  const first = installed.prepare(); helper.apply(first);
  assert.equal(helper.rollback(first).state, "rolled-back");
  const second = installed.prepare(); helper.apply(second);
  // The normal installer preserves root:<service group> 0640 on replacement.
  fs.writeFileSync(installed.app, fs.readFileSync(f.nextApp));
  assert.equal(helper.finish(second).state, "committed");
  assert.equal(helper.finish(second).state, "committed");
  assert.throws(() => helper.rollback(second), /UPLOAD_REFRESH_APP_COMMITTED_OR_UNKNOWN/);
  assert.equal(fs.statSync(installed.app).gid, 1000);
  assert.equal(fs.statSync(installed.app).mode & 0o7777, 0o640);
  assert.equal(fs.statSync(f.receipt).gid, 0);
  for (const name of fs.readdirSync(second)) assert.equal(fs.statSync(path.join(second, name)).gid, 0);
});

test("service-group app reads do not relax write, link, owner, module or private-receipt boundaries", { skip: !rootOnly }, t => {
  const f = fixture(t), installed = serviceGroupApp(f);
  fs.chownSync(installed.app, 1000, 1000);
  assert.throws(installed.prepare, /UPLOAD_REFRESH_PERMISSIONS/); fs.chownSync(installed.app, 0, 1000);
  fs.chmodSync(installed.app, 0o660);
  assert.throws(installed.prepare, /UPLOAD_REFRESH_PERMISSIONS/); fs.chmodSync(installed.app, 0o640);
  fs.chmodSync(installed.directory, 0o770);
  assert.throws(installed.prepare, /UPLOAD_REFRESH_PARENT/); fs.chmodSync(installed.directory, 0o750);
  fs.chownSync(installed.app, 0, 0);
  assert.throws(installed.prepare, /UPLOAD_REFRESH_APP_MANIFEST_PERMISSIONS/); fs.chownSync(installed.app, 0, 1000);
  const hardlink = path.join(f.root, "linked-manifest"); fs.linkSync(installed.app, hardlink);
  assert.throws(installed.prepare, /UPLOAD_REFRESH_PERMISSIONS/); fs.unlinkSync(hardlink);
  const symlink = path.join(f.root, "symlink-manifest"); fs.symlinkSync(installed.app, symlink);
  assert.throws(() => helper.prepare(f.old, f.candidate, f.receipt, f.after.fingerprint,
    symlink, f.nextApp, "c".repeat(64)), /UPLOAD_REFRESH_PATH/);
  const upload = path.join(f.old, helper.ARTIFACT); fs.chownSync(upload, 0, 1000);
  assert.throws(installed.prepare, /UPLOAD_REFRESH_PERMISSIONS/); fs.chownSync(upload, 0, 0);
  fs.chownSync(f.receipt, 0, 1000);
  assert.throws(installed.prepare, /UPLOAD_REFRESH_PERMISSIONS/); fs.chownSync(f.receipt, 0, 0);
  fs.chownSync(f.nextApp, 0, 1000);
  assert.throws(installed.prepare, /UPLOAD_REFRESH_PERMISSIONS/); fs.chownSync(f.nextApp, 0, 0);
  assert.equal(contract(f.old).fingerprint, helper.OLD_FINGERPRINT);
});

for (const alternateInstaller of [null, "installed", "candidate"]) {
  test("rebind refresh preserves the module binding and installer " + (alternateInstaller || "with matching installer bytes"), { skip: !rootOnly }, t => {
    const f = fixture(t, { kind: "rebind", alternateInstaller });
    const entry = path.join(ROOT, "server-tools/linux/lib/offsite-upload-hardening-compat.js");
    const initialReceipt = fs.readFileSync(f.receipt), installerSha = digest(path.join(f.old, INSTALLER));
    const expected = replacedHash(f.after, INSTALLER, installerSha);
    const before = classify(envelope(f.after), f.before);
    assert.equal(before, "migration-required:13->13");
    const args = [f.old, f.candidate, f.receipt, f.after.fingerprint];
    const verified = spawnSync(process.execPath, [entry, "verify-rebind", ...args], { encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout).changed, [helper.REBIND.artifact]);
    const prepared = spawnSync(process.execPath, [entry, "prepare-rebind", ...args, f.app, f.nextApp, "c".repeat(64)], { encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const tx = JSON.parse(prepared.stdout).transaction;
    assert.match(path.basename(tx), /^\.offsite-rebind-refresh-/);
    assert.equal(helper.apply(tx).fingerprint, expected.fingerprint);
    const receipt = JSON.parse(fs.readFileSync(f.receipt, "utf8"));
    assert.equal(classify(envelope(f.after), receipt), alternateInstaller ? "compatible-installer-only" : "compatible");
    assert.deepEqual(receipt.providerBinding, binding);
    assert.equal(digest(path.join(f.old, INSTALLER)), installerSha);
    assert.equal(digest(path.join(f.old, helper.REBIND.artifact)), helper.REBIND.newSha);

    assert.equal(helper.rollback(tx).fingerprint, f.before.fingerprint);
    assert.deepEqual(fs.readFileSync(f.receipt), initialReceipt);
    assert.equal(digest(path.join(f.old, helper.REBIND.artifact)), helper.REBIND.oldSha);
    assert.equal(classify(envelope(f.before), JSON.parse(fs.readFileSync(f.receipt, "utf8"))), "compatible");
  });
}

test("rebind interruption restores the old binding and a committed app retains the new binding", { skip: !rootOnly }, t => {
  const f = fixture(t, { kind: "rebind" }), tx = f.prepare();
  const journalFile = path.join(tx, "journal.json"), journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
  journal.state = "applying";
  fs.writeFileSync(journalFile, JSON.stringify(journal));
  fs.copyFileSync(path.join(tx, "new-rebind"), path.join(f.old, helper.REBIND.artifact));
  assert.equal(helper.rollback(tx).fingerprint, f.before.fingerprint);
  const second = f.prepare();
  helper.apply(second);
  fs.copyFileSync(f.nextApp, f.app);
  assert.throws(() => helper.rollback(second), /UPLOAD_REFRESH_APP_COMMITTED_OR_UNKNOWN/);
  assert.equal(helper.finish(second).fingerprint, f.after.fingerprint);
  assert.equal(helper.finish(second).state, "committed");
});

test("rebind refuses the pre-upload module, additional deltas and unpublished installer bytes", { skip: !rootOnly }, t => {
  const historical = fixture(t);
  assert.throws(() => helper.verify(historical.old, historical.candidate, historical.receipt, helper.REBIND.after, "rebind"),
    /UPLOAD_REFRESH_PREDECESSOR/);
  const f = fixture(t, { kind: "rebind" });
  for (const relative of ["grabenplaner-offsite-check.sh", INSTALLER, helper.REBIND.artifact]) {
    const target = path.join(f.candidate, relative), original = fs.readFileSync(target);
    fs.appendFileSync(target, "\n# unreviewed delta\n");
    assert.throws(() => helper.verify(f.old, f.candidate, f.receipt, contract(f.candidate).fingerprint, "rebind"),
      /UPLOAD_REFRESH_CANDIDATE/);
    fs.writeFileSync(target, original);
  }
  assert.equal(digest(path.join(f.old, helper.REBIND.artifact)), helper.REBIND.oldSha);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const { archiveCommittedPair, preflightArchive, parameters, runAsServiceUser, scopedChildEnvironment } = require("../server-tools/linux/lib/local-backup-archive");
const root = path.resolve(__dirname, "..");
const input = { backupDirectory: path.join(root, "tmp", "synthetic-backup-area"), snapshot: "dienstplan-synthetic-01", keep: 20 };
const result = { ok: true, archived: true, rawRetained: true, retained: 20, removedArchives: 1, removedRaw: 1 };

test("Linux archive publishes before retention and rechecks exact raw rollback pair", () => {
  const calls = [];
  const verifyBackup = (...args) => { calls.push(["verify", ...args]); return { verified: true }; };
  const actual = archiveCommittedPair(input, { verifyBackup, verifyRecoveryKeys: pair => { calls.push(["keys", pair.databasePath]); }, openArchive: options => {
    assert.equal(options.backupDirectory, input.backupDirectory);
    assert.equal(options.expectedStream, "external");
    return {
      configured: () => true,
      archivePair: (snapshot, { verifyPair }) => { calls.push(["archive", snapshot]); verifyPair(parameters(input).paths); },
      maintainRetention: (snapshot, { verifyPair }) => {
        calls.push(["retention", snapshot]);
        assert.equal(typeof verifyPair, "function");
        return { retained: 20, removedArchives: 1, removedRaw: 1 };
      },
      initialize: () => assert.fail("Normal backup must never initialize repositories or keys"),
    };
  } });
  assert.deepEqual(actual, result);
  assert.deepEqual(calls.map(call => call[0]), ["archive", "verify", "keys", "retention", "verify", "keys"]);
  assert.equal(calls.at(-2)[1], path.join(input.backupDirectory, `${input.snapshot}.db`));
  assert.equal(calls.at(-2)[4], path.join(input.backupDirectory, `${input.snapshot}.complete.json`));
});

test("Linux archive refuses missing configuration, reduced retention, invalid paths and archive failures", () => {
  for (const archive of [null, { configured: () => false }]) {
    assert.throws(() => archiveCommittedPair(input, { openArchive: () => archive }), /eingerichtet/);
  }
  for (const value of [29, 31, 0, "030", undefined]) assert.throws(() => parameters({ ...input, keep: value }), /ungueltig/);
  for (const value of ["relative", path.parse(root).root, `${root}\nsecret`]) {
    assert.throws(() => parameters({ ...input, backupDirectory: value }), /ungueltig/);
  }
  for (const snapshot of ["../dienstplan-any", "dienstplan-ok/../bad", "other"]) assert.throws(() => parameters({ ...input, snapshot }));
  assert.throws(() => archiveCommittedPair(input, { verifyRecoveryKeys: () => {}, openArchive: () => ({
    configured: () => true,
    archivePair: () => { throw new Error("archive failed"); },
    maintainRetention: () => assert.fail("Never prune after failure"),
  }) }), /archive failed/);
});

test("Linux archive requires existing document and import recovery keys before retention", () => {
  let proofCalls = 0;
  assert.throws(() => archiveCommittedPair(input, {
    openArchive: () => ({ configured: () => true,
      archivePair: (_snapshot, { verifyPair }) => verifyPair(parameters(input).paths),
      maintainRetention: () => assert.fail("Key-proof failure must prevent retention") }),
    verifyBackup: () => ({ verified: true }),
    verifyRecoveryKeys: () => { proofCalls++; throw new Error("BACKUP_RECOVERY_KEYS_UNVERIFIED"); },
  }), /BACKUP_RECOVERY_KEYS_UNVERIFIED/);
  assert.equal(proofCalls, 1);
});

test("Linux archive launcher passes existing Vault secrets only through a minimal child environment", () => {
  const secret = "SYNTHETIC-VAULT-SECRET";
  const environment = { GRABENPLANER_LOCAL_BACKUP_ARCHIVE: "1", GRABENPLANER_LOCAL_BACKUP_RESTIC: "/opt/synthetic/restic",
    GRABENPLANER_LOCAL_BACKUP_RESTIC_SHA256: "a".repeat(64), GRABENPLANER_INTEGRATION_KEY_ID: "synthetic-v1",
    GRABENPLANER_INTEGRATION_KEY: secret, GRABENPLANER_INTEGRATION_KEYS: "{}", PATH: "/unsafe", TMPDIR: "/unsafe",
    NODE_OPTIONS: "--require=/unsafe", RESTIC_PASSWORD: "unrelated", GRABENPLANER_AMU_KEY: "synthetic-document-key", SSH_AUTH_SOCK: "/unrelated" };
  const filtered = scopedChildEnvironment(environment, input.backupDirectory);
  assert.equal(filtered.GRABENPLANER_INTEGRATION_KEY, secret);
  assert.equal(filtered.TMPDIR, input.backupDirectory);
  assert.equal(filtered.GRABENPLANER_AMU_KEY, "synthetic-document-key");
  for (const key of ["NODE_OPTIONS", "RESTIC_PASSWORD", "SSH_AUTH_SOCK"]) assert.equal(filtered[key], undefined);
  let invoked = 0;
  const actual = runAsServiceUser({ ...input, user: "grabenplaner", environment }, {
    platform: "linux", uid: 0, spawnSync: (binary, args, options) => {
      invoked++;
      assert.equal(binary, "/usr/sbin/runuser");
      assert.deepEqual(args.slice(0, 3), ["--user", "grabenplaner", "--"]);
      assert.equal(args.some(arg => arg.includes(secret)), false);
      assert.equal(options.env.GRABENPLANER_INTEGRATION_KEY, secret);
      assert.equal(options.timeout, 1500000);
      assert.equal(options.maxBuffer, 65536);
      assert.equal(options.windowsHide, true);
      return { status: 0, stdout: JSON.stringify({ ...result, ignored: secret }), stderr: secret };
    },
  });
  assert.equal(invoked, 1);
  assert.deepEqual(actual, result);
  assert.equal(JSON.stringify(actual).includes(secret), false);
  assert.equal(environment.GRABENPLANER_INTEGRATION_KEY, secret);
});

test("Linux archive launcher rejects unsafe identities and redacts failed child output", () => {
  for (const user of ["root", "0", "-user", "user;echo", "user name", ""]) {
    assert.throws(() => runAsServiceUser({ ...input, user }, { platform: "linux", uid: 0 }), /Dienstbenutzer/);
  }
  assert.throws(() => runAsServiceUser({ ...input, user: "grabenplaner" }, { platform: "linux", uid: 1000 }), /root/);
  for (const child of [{ status: 1, stdout: "SYNTHETICSECRET", stderr: "SYNTHETICSECRET" },
    { status: 0, stdout: "SYNTHETICSECRET" }, { status: 0, stdout: JSON.stringify({ ...result, retained: 29.5 }) }]) {
    assert.throws(() => runAsServiceUser({ ...input, user: "grabenplaner" }, {
      platform: "linux", uid: 0, spawnSync: () => child,
    }), error => !error.message.includes("SYNTHETICSECRET"));
  }
});

test("Linux bulk snapshots use disk, archive mode never falls back to legacy pruning", () => {
  const script = fs.readFileSync(path.join(root, "server-tools/linux/backup-grabenplaner.sh"), "utf8");
  assert.match(script, /mktemp --directory --tmpdir="\$backup_dir" \.backup-stage/);
  assert.ok(script.indexOf('preflight-as "$service_user"') < script.indexOf('staging_directory="$(mktemp'));
  assert.doesNotMatch(script, /mktemp --directory --tmpdir="\$runtime_directory" backup-stage/);
  assert.match(script, /mktemp --tmpdir="\$runtime_directory" backup-result/);
  assert.match(script, /gp_path_is_same_or_child "\$staging_directory" "\$backup_dir"/);
  assert.match(script, /\(\( keep == 20 \)\)/);
  assert.match(script, /lock_already_held == 1 && keep == 1000 && archive_enabled == 0/);
  assert.match(script, /readlink -f -- \/proc\/\$\$\/fd\/9/);
  assert.ok(script.indexOf('snapshot_committed=1') < script.indexOf('elif (( preserve_existing_backups == 1 ))'));
  assert.match(script, /-e "\$backup_dir\/\.gp-local-archive" \|\| -L "\$backup_dir\/\.gp-local-archive"/);
  const publish = script.indexOf("snapshot_committed=1");
  const archive = script.indexOf('"$node" "$archive_helper" archive-as');
  const prune = script.indexOf('"$node" "$pruner" "$backup_dir"');
  assert.ok(publish < archive && archive < prune);
  assert.match(script.slice(archive, prune), /\nelse\r?\n/);
  assert.doesNotMatch(script, /env[^\n]*GRABENPLANER_INTEGRATION_KEY=/);
  const unknown = spawnSync(process.execPath, [path.join(root, "server-tools/linux/lib/local-backup-archive.js"), "initialize"], { encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /rohe Sicherungspunkt bleibt erhalten/);
});

test("Linux archive preflight validates external history before raw creation and sanitizes its child result", () => {
  const expected = { ready: true, retained: 2, retention: 20, stream: "external" };
  let checked = false;
  const dependencies = { openArchive: options => {
    assert.equal(options.expectedStream, "external");
    return { configured: () => true, preflightBackup() { checked = true; return { ...expected, secret: "SYNTHETIC-SECRET" }; },
      archivePair: () => assert.fail("preflight never creates a point") };
  } };
  assert.deepEqual(preflightArchive(input, dependencies), expected);
  assert.equal(checked, true);
  assert.throws(() => preflightArchive(input, { openArchive: () => ({ configured: () => true,
    preflightBackup() { throw new Error("pending archive journal"); } }) }), /pending/);
  const actual = runAsServiceUser({ ...input, action: "preflight", user: "grabenplaner" }, {
    platform: "linux", uid: 0, spawnSync: (_binary, args) => {
      assert.deepEqual(args.slice(-3), ["preflight", input.backupDirectory, "20"]);
      return { status: 0, stdout: JSON.stringify({ ...expected, secret: "SYNTHETIC-SECRET" }) };
    },
  });
  assert.deepEqual(actual, expected);
});

test("Linux archive adapter refuses missing Vault secrets and disabled existing history", t => {
  const temporary = fs.mkdtempSync(path.join(root, "tmp", "linux-archive-adapter-test-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(temporary)), fs.realpathSync(path.join(root, "tmp")));
    fs.rmSync(temporary, { recursive: true });
  });
  const archiveInput = { ...input, backupDirectory: temporary, environment: {
    GRABENPLANER_LOCAL_BACKUP_ARCHIVE: "1", GRABENPLANER_LOCAL_BACKUP_RESTIC: path.join(temporary, "not-used-binary"),
    GRABENPLANER_LOCAL_BACKUP_RESTIC_SHA256: "a".repeat(64),
  } };
  assert.throws(() => archiveCommittedPair(archiveInput), { code: "LOCAL_ARCHIVE_EXISTING_VAULT_REQUIRED" });
  assert.deepEqual(fs.readdirSync(temporary), [], "missing existing credentials must not initialize keys or archives");
  const state = path.join(temporary, ".gp-local-archive");
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "recovery-envelope.json"), "{\"synthetic\":true}");
  assert.throws(() => archiveCommittedPair({ ...archiveInput, environment: { GRABENPLANER_LOCAL_BACKUP_ARCHIVE: "0" } }),
    { code: "LOCAL_ARCHIVE_DISABLED_WITH_HISTORY" });
  const child = spawnSync(process.execPath, [path.join(root, "server-tools/linux/lib/local-backup-archive.js"),
    "archive", temporary, input.snapshot, "20"], {
    encoding: "utf8", env: { ...process.env, GRABENPLANER_LOCAL_BACKUP_ARCHIVE: "0", GRABENPLANER_INTEGRATION_KEY: "SYNTHETIC-SECRET-MUST-NOT-APPEAR" },
  });
  assert.notEqual(child.status, 0);
  assert.equal(`${child.stdout}${child.stderr}`.includes("SYNTHETIC-SECRET-MUST-NOT-APPEAR"), false);
  assert.deepEqual(fs.readdirSync(state), ["recovery-envelope.json"]);
});

const resticBinary = path.join(root, "tmp/backup-restic-tools-20260906/bin/restic_0.18.1_windows_amd64.exe");
test("Linux archive CLI contract works with the real backend and preserves old raw history", {
  skip: process.platform !== "win32" || !fs.existsSync(resticBinary), timeout: 120000,
}, t => {
  const { openLocalBackupArchiveFromEnvironment } = require("../lib/local-backup-environment");
  const { writeBackupCommitMarker } = require("../lib/backup-commit");
  const { sha256File } = require("../lib/file-integrity");
  const directory = fs.mkdtempSync(path.join(root, "tmp", "linux-archive-core-test-"));
  const key = crypto.randomBytes(32);
  t.after(() => {
    key.fill(0);
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(path.join(root, "tmp")));
    fs.rmSync(directory, { recursive: true });
  });
  const environment = { GRABENPLANER_LOCAL_BACKUP_ARCHIVE: "1", GRABENPLANER_LOCAL_BACKUP_RESTIC: resticBinary,
    GRABENPLANER_LOCAL_BACKUP_RESTIC_SHA256: "034b7bf67a23049d30d58ddf4fb318239726cc74728b80bff876de824f2fc786",
    GRABENPLANER_INTEGRATION_KEY_ID: "synthetic-linux", GRABENPLANER_INTEGRATION_KEY: key.toString("base64") };
  const archive = openLocalBackupArchiveFromEnvironment({ backupDirectory: directory, environment, requireConfigured: false });
  assert.equal(archive.configured(), false);
  const archiveInput = { ...input, backupDirectory: directory, environment };
  assert.throws(() => archiveCommittedPair(archiveInput), { code: "LOCAL_ARCHIVE_NOT_INITIALIZED" });
  assert.deepEqual(fs.readdirSync(directory), []);
  archive.initialize({ host: "gp-linux-synthetic", stream: "external", confirmation: "initialize-local-archive" });
  function syntheticPair(number) {
    const snapshot = `dienstplan-linux-synthetic-${number}`;
    const paths = parameters({ ...archiveInput, snapshot }).paths;
    fs.writeFileSync(paths.databasePath, `synthetic-backup-payload-${number}`, { flag: "wx" });
    fs.mkdirSync(paths.protectedDirectory);
    const hash = sha256File(paths.databasePath);
    fs.writeFileSync(path.join(paths.protectedDirectory, "manifest.json"), JSON.stringify({
      database: { fileName: `${snapshot}.db`, sha256: hash }, files: [],
    }), { flag: "wx" });
    writeBackupCommitMarker({ backupDirectory: directory, snapshot, databaseSha256: hash });
    return paths;
  }
  // Synthetic payloads exercise adapter/launcher contracts, not SQLite format.
  // Real SQLite + encrypted-document integrity is covered by the full-source run.
  const verify = (databasePath, protectedDirectory, amuModule, markerPath) => {
    assert.match(fs.readFileSync(databasePath, "utf8"), /^synthetic-backup-payload-/);
    assert.equal(path.basename(protectedDirectory), `${path.basename(databasePath, ".db")}.amu`);
    assert.ok(fs.existsSync(markerPath));
    assert.equal(path.basename(amuModule), "amu-storage.js");
  };
  const oldRaw = syntheticPair("legacy"), first = syntheticPair("first");
  assert.deepEqual(preflightArchive(archiveInput), { ready: true, retained: 0, retention: 20, stream: "external" });
  assert.deepEqual(archiveCommittedPair({ ...archiveInput, snapshot: first.snapshot }, { verifyBackup: verify, verifyRecoveryKeys: () => {} }),
    { ok: true, archived: true, rawRetained: true, retained: 1, removedArchives: 0, removedRaw: 0 });
  const second = syntheticPair("second");
  assert.deepEqual(archiveCommittedPair({ ...archiveInput, snapshot: second.snapshot }, { verifyBackup: verify, verifyRecoveryKeys: () => {} }),
    { ok: true, archived: true, rawRetained: true, retained: 1, removedArchives: 1, removedRaw: 1 });
  assert.ok(fs.existsSync(oldRaw.databasePath));
  assert.ok(fs.existsSync(second.databasePath));
  assert.equal(fs.existsSync(first.databasePath), false);
  assert.equal(archive.listMetadata().length, 1);
  assert.throws(() => archive.materialize(first.snapshot, { verifyPair: () => {} }), /SNAPSHOT_NOT_FOUND/);
  const restored = archive.materialize(second.snapshot, { verifyPair: pair => verify(pair.databasePath,
    pair.protectedDirectory, path.join(root, "lib/amu-storage.js"), pair.markerPath) });
  try { assert.equal(fs.readFileSync(restored.databasePath, "utf8"), "synthetic-backup-payload-second"); }
  finally { restored.cleanup(); }
});

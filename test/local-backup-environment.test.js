"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { localBackupArchiveEnabled, openLocalBackupArchiveFromEnvironment } = require("../lib/local-backup-environment");

test("local archive is opt-in and cannot silently fall back over an existing history", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-archive-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(localBackupArchiveEnabled({}), false);
  assert.equal(localBackupArchiveEnabled({ GRABENPLANER_LOCAL_BACKUP_ARCHIVE: "1" }), true);
  assert.throws(() => localBackupArchiveEnabled({ GRABENPLANER_LOCAL_BACKUP_ARCHIVE: "true" }), { code: "LOCAL_ARCHIVE_MODE_INVALID" });
  assert.equal(openLocalBackupArchiveFromEnvironment({ backupDirectory: root, environment: {} }), null);
  fs.mkdirSync(path.join(root, ".gp-local-archive"));
  assert.throws(() => openLocalBackupArchiveFromEnvironment({ backupDirectory: root, environment: {} }), { code: "LOCAL_ARCHIVE_DISABLED_WITH_HISTORY" });
  fs.writeFileSync(path.join(root, ".gp-local-archive", "recovery-envelope.json"), "{}");
  assert.throws(() => openLocalBackupArchiveFromEnvironment({ backupDirectory: root, environment: {} }), { code: "LOCAL_ARCHIVE_DISABLED_WITH_HISTORY" });
});

test("archive adapter uses only a trusted executable pin and existing vault, without initialization", () => {
  const environment = { GRABENPLANER_LOCAL_BACKUP_ARCHIVE: "1",
    GRABENPLANER_LOCAL_BACKUP_RESTIC: path.resolve("trusted-restic"),
    GRABENPLANER_LOCAL_BACKUP_RESTIC_SHA256: "a".repeat(64),
    GRABENPLANER_INTEGRATION_KEY_ID: "fixture", GRABENPLANER_INTEGRATION_KEY: Buffer.alloc(32, 7).toString("base64") };
  let options;
  const archiveFactory = input => { options = input; return { configured: () => true }; };
  const backupDirectory = path.resolve("archive-environment-no-write");
  assert.ok(openLocalBackupArchiveFromEnvironment({ backupDirectory, environment, archiveFactory }));
  assert.equal(options.binary, environment.GRABENPLANER_LOCAL_BACKUP_RESTIC);
  assert.equal(options.binarySha256, environment.GRABENPLANER_LOCAL_BACKUP_RESTIC_SHA256);
  assert.equal(options.vault.activeKeyId, "fixture");
  assert.equal(options.verifyBinaryOnConstruction, true);
  assert.equal(fs.existsSync(backupDirectory), false);
  assert.throws(() => openLocalBackupArchiveFromEnvironment({ backupDirectory, environment: { ...environment, GRABENPLANER_LOCAL_BACKUP_RESTIC: "restic" }, archiveFactory }), { code: "LOCAL_ARCHIVE_TRUSTED_BINARY_REQUIRED" });
  assert.throws(() => openLocalBackupArchiveFromEnvironment({ backupDirectory, environment: { ...environment, GRABENPLANER_INTEGRATION_KEY: "" }, archiveFactory }), { code: "LOCAL_ARCHIVE_EXISTING_VAULT_REQUIRED" });
  assert.throws(() => openLocalBackupArchiveFromEnvironment({ backupDirectory, environment, archiveFactory: () => ({ configured: () => false }) }), { code: "LOCAL_ARCHIVE_NOT_INITIALIZED" });
  assert.ok(openLocalBackupArchiveFromEnvironment({ backupDirectory, environment, requireConfigured: false, archiveFactory: () => ({ configured: () => false }) }));
});

test("cached metadata adapter cannot invoke archive operations or turn receipt reads into a process", () => {
  const environment = { GRABENPLANER_LOCAL_BACKUP_ARCHIVE: "1", GRABENPLANER_LOCAL_BACKUP_RESTIC: path.resolve("trusted-restic"),
    GRABENPLANER_LOCAL_BACKUP_RESTIC_SHA256: "a".repeat(64) };
  const vault = { seal() {}, useSecretSync() {} };
  const options = { backupDirectory: path.resolve("no-write"), environment, vault, cachedMetadataOnly: true,
    archiveFactory(input) {
      assert.equal(input.verifyBinaryOnConstruction, false);
      return { configured: () => true, archivePair() { assert.fail("read-only facade"); },
        listMetadata(input) { assert.deepEqual(input, { verifyInventory: false }); return []; } };
    } };
  const cached = openLocalBackupArchiveFromEnvironment(options);
  assert.equal(Object.isFrozen(cached), true);
  assert.equal(cached.archivePair, undefined);
  assert.deepEqual(cached.listMetadata({ verifyInventory: true }), []);
  assert.throws(() => openLocalBackupArchiveFromEnvironment({ ...options, cachedMetadataOnly: "true" }), { code: "LOCAL_ARCHIVE_METADATA_MODE_INVALID" });
});

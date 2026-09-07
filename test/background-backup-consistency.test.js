"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAmuStorage, syncEncryptedFilesBackup } = require("../lib/amu-storage");
const { writeBackupCommitMarker, verifyCommittedBackup } = require("../lib/backup-commit");
const { sha256File } = require("../lib/file-integrity");
const { createSqliteMaintenanceOperations } = require("../lib/persistence/sqlite/operations/maintenance");
const { openSqliteLegacyDatabase } = require("../lib/persistence/sqlite/provider");

function pdfBuffer(label) {
  return Buffer.from(`%PDF-1.4\n% synthetic ${label}\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n`, "utf8");
}

function fixture(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `grabenplaner-background-backup-${label}-`));
  const sourceDirectory = path.join(root, "private", "amu");
  const backupDirectory = path.join(root, "backups");
  const databasePath = path.join(root, "live.db");
  const key = crypto.randomBytes(32);
  fs.mkdirSync(backupDirectory, { recursive: true });
  const storage = createAmuStorage({
    rootDirectory: sourceDirectory,
    encryptionKeys: { synthetic: key },
    activeKeyId: "synthetic",
    requireScanner: true,
    scanner: async () => ({ available: true, clean: true, engine: "synthetic" }),
  });
  const database = openSqliteLegacyDatabase(databasePath);
  database.exec("CREATE TABLE loan_documents (id TEXT PRIMARY KEY, storage_key TEXT NOT NULL)");
  t.after(() => {
    try { database.close(); } catch {}
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, sourceDirectory, backupDirectory, database, storage };
}

function snapshotPaths(fixtureValue, snapshot) {
  return {
    snapshot,
    databasePath: path.join(fixtureValue.backupDirectory, `${snapshot}.db`),
    protectedDirectory: path.join(fixtureValue.backupDirectory, `${snapshot}.amu`),
    markerPath: path.join(fixtureValue.backupDirectory, `${snapshot}.complete.json`),
  };
}

function copySnapshot(database, sourceDirectory, paths) {
  createSqliteMaintenanceOperations(database).vacuumInto(paths.databasePath);
  const databaseSha256 = sha256File(paths.databasePath);
  const copied = syncEncryptedFilesBackup({
    sourceDirectory,
    targetDirectory: paths.protectedDirectory,
    manifestMetadata: {
      database: { fileName: path.basename(paths.databasePath), sha256: databaseSha256 },
    },
  });
  return { databaseSha256, copied };
}

function publishVerifiedPair(paths, databaseSha256, verifyStandaloneBackupPair) {
  verifyStandaloneBackupPair(paths);
  writeBackupCommitMarker({
    backupDirectory: path.dirname(paths.databasePath),
    snapshot: paths.snapshot,
    databaseSha256,
  });
  return verifyCommittedBackup(path.dirname(paths.databasePath), path.basename(paths.markerPath), {
    verifyPair: verifyStandaloneBackupPair,
  });
}

test("background copy keeps a verified snapshot when the live reference changes and a new blob joins the copied superset", async (t) => {
  const f = fixture(t, "superset");
  const oldDocument = await f.storage.saveBuffer({ buffer: pdfBuffer("old"), originalName: "old.pdf" });
  f.database.prepare("INSERT INTO loan_documents (id, storage_key) VALUES (?, ?)").run("loan", oldDocument.storageKey);
  const paths = snapshotPaths(f, "dienstplan-synthetic-superset");

  createSqliteMaintenanceOperations(f.database).vacuumInto(paths.databasePath);
  const newDocument = await f.storage.saveBuffer({ buffer: pdfBuffer("new"), originalName: "new.pdf" });
  f.database.prepare("UPDATE loan_documents SET storage_key = ? WHERE id = ?").run(newDocument.storageKey, "loan");
  const databaseSha256 = sha256File(paths.databasePath);
  const copied = syncEncryptedFilesBackup({
    sourceDirectory: f.sourceDirectory,
    targetDirectory: paths.protectedDirectory,
    manifestMetadata: { database: { fileName: path.basename(paths.databasePath), sha256: databaseSha256 } },
  });

  const { verifyStandaloneBackupPair } = require("../backup");
  const committed = publishVerifiedPair(paths, databaseSha256, verifyStandaloneBackupPair);
  const snapshotDatabase = openSqliteLegacyDatabase(paths.databasePath, { readOnly: true });
  try {
    assert.equal(snapshotDatabase.prepare("SELECT storage_key FROM loan_documents WHERE id = ?").get("loan").storage_key,
      oldDocument.storageKey);
  } finally { snapshotDatabase.close(); }
  assert.equal(f.database.prepare("SELECT storage_key FROM loan_documents WHERE id = ?").get("loan").storage_key,
    newDocument.storageKey);
  assert.deepEqual(copied.manifest.files.map((entry) => entry.storageKey).sort(),
    [oldDocument.storageKey, newDocument.storageKey].sort());
  assert.equal(committed.committed, true);
});

test("background copy cannot publish a commit when a snapshot-referenced blob disappeared before copying", async (t) => {
  const f = fixture(t, "missing");
  const document = await f.storage.saveBuffer({ buffer: pdfBuffer("missing"), originalName: "missing.pdf" });
  f.database.prepare("INSERT INTO loan_documents (id, storage_key) VALUES (?, ?)").run("loan", document.storageKey);
  const paths = snapshotPaths(f, "dienstplan-synthetic-missing");

  createSqliteMaintenanceOperations(f.database).vacuumInto(paths.databasePath);
  assert.equal(f.storage.deleteBlob(document.storageKey), true);
  const databaseSha256 = sha256File(paths.databasePath);
  syncEncryptedFilesBackup({
    sourceDirectory: f.sourceDirectory,
    targetDirectory: paths.protectedDirectory,
    manifestMetadata: {
      database: { fileName: path.basename(paths.databasePath), sha256: databaseSha256 },
    },
  });
  const { verifyStandaloneBackupPair } = require("../backup");
  assert.throws(() => publishVerifiedPair(paths, databaseSha256, verifyStandaloneBackupPair), {
    code: "AMU_BACKUP_REFERENCE_MISSING",
  });
  assert.equal(fs.existsSync(paths.markerPath), false);
});

test("background copy remains restorable when its old blob is removed from live storage after copying", async (t) => {
  const f = fixture(t, "delete-after-copy");
  const oldDocument = await f.storage.saveBuffer({ buffer: pdfBuffer("retained"), originalName: "retained.pdf" });
  f.database.prepare("INSERT INTO loan_documents (id, storage_key) VALUES (?, ?)").run("loan", oldDocument.storageKey);
  const paths = snapshotPaths(f, "dienstplan-synthetic-delete-after-copy");
  const { databaseSha256 } = copySnapshot(f.database, f.sourceDirectory, paths);

  const newDocument = await f.storage.saveBuffer({ buffer: pdfBuffer("replacement"), originalName: "replacement.pdf" });
  f.database.prepare("UPDATE loan_documents SET storage_key = ? WHERE id = ?").run(newDocument.storageKey, "loan");
  assert.equal(f.storage.deleteBlob(oldDocument.storageKey), true);
  assert.equal(fs.existsSync(f.storage.blobPath(oldDocument.storageKey)), false);

  const { verifyStandaloneBackupPair } = require("../backup");
  const committed = publishVerifiedPair(paths, databaseSha256, verifyStandaloneBackupPair);
  assert.equal(committed.committed, true);
  assert.equal(fs.existsSync(path.join(paths.protectedDirectory, "blobs", ...oldDocument.storageKey.split("/"))), true);
});

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  inspectCommittedBackupMetadata,
  listCommittedBackups,
  listLegacyBackupPairs,
  pruneCommittedBackups,
  verifyCommittedBackup,
  writeBackupCommitMarker,
} = require("../lib/backup-commit");

function createPair(root, snapshot, { marker = true, content = snapshot } = {}) {
  const databasePath = path.join(root, `${snapshot}.db`);
  const protectedDirectory = path.join(root, `${snapshot}.amu`);
  fs.writeFileSync(databasePath, content);
  const databaseSha256 = crypto.createHash("sha256").update(fs.readFileSync(databasePath)).digest("hex");
  fs.mkdirSync(protectedDirectory);
  fs.writeFileSync(path.join(protectedDirectory, "manifest.json"), JSON.stringify({
    database: { fileName: path.basename(databasePath), sha256: databaseSha256 },
    files: [],
  }));
  const markerPath = marker ? writeBackupCommitMarker({
    backupDirectory: root,
    snapshot,
    databaseSha256,
    protectedFiles: 0,
  }) : null;
  return { databasePath, protectedDirectory, markerPath };
}

test("backup commit marker is published last and binds DB to protected documents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-backup-commit-"));
  try {
    const pair = createPair(root, "dienstplan-2026-07-19T12-00-00-000Z-aabbccddeeff");
    const verified = verifyCommittedBackup(root, path.basename(pair.markerPath));
    assert.equal(verified.committed, true);
    assert.equal(verified.databasePath, pair.databasePath);

    const tampered = fs.readFileSync(pair.databasePath);
    tampered[0] ^= 0xff;
    fs.writeFileSync(pair.databasePath, tampered);
    assert.equal(inspectCommittedBackupMetadata(root, path.basename(pair.markerPath)).verificationCached, true);
    assert.throws(() => verifyCommittedBackup(root, path.basename(pair.markerPath)), /Pruefsumme/);
    assert.equal(listCommittedBackups(root).length, 0);

    const fallback = createPair(root, "dienstplan-2026-07-18T12-00-00-000Z-001122334455");
    fs.utimesSync(fallback.markerPath, new Date("2026-07-18T12:00:00Z"), new Date("2026-07-18T12:00:00Z"));
    fs.utimesSync(pair.markerPath, new Date("2026-07-19T12:00:00Z"), new Date("2026-07-19T12:00:00Z"));
    const latestValid = listCommittedBackups(root, { limit: 1 });
    assert.equal(latestValid.length, 1);
    assert.equal(latestValid[0].databasePath, fallback.databasePath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retention removes only verified committed pairs and preserves legacy or incomplete data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-backup-retention-"));
  try {
    const older = createPair(root, "dienstplan-2026-07-18T12-00-00-000Z-111111111111");
    const newer = createPair(root, "dienstplan-2026-07-19T12-00-00-000Z-222222222222");
    const invalidNew = createPair(root, "dienstplan-2026-07-20T12-00-00-000Z-333333333333");
    fs.appendFileSync(invalidNew.databasePath, "tampered");
    const legacy = createPair(root, "dienstplan-2026-07-17T12-00-00-000Z", { marker: false });
    const incompleteDatabase = path.join(root, "dienstplan-2026-07-16T12-00-00-000Z.db");
    fs.writeFileSync(incompleteDatabase, "incomplete");
    fs.utimesSync(older.markerPath, new Date("2026-07-18T12:00:00Z"), new Date("2026-07-18T12:00:00Z"));
    fs.utimesSync(newer.markerPath, new Date("2026-07-19T12:00:00Z"), new Date("2026-07-19T12:00:00Z"));
    fs.utimesSync(invalidNew.markerPath, new Date("2026-07-20T12:00:00Z"), new Date("2026-07-20T12:00:00Z"));

    const result = pruneCommittedBackups(root, 1);
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(older.markerPath), false);
    assert.equal(fs.existsSync(older.databasePath), false);
    assert.equal(fs.existsSync(newer.markerPath), true);
    assert.equal(fs.existsSync(invalidNew.markerPath), true);
    assert.equal(fs.existsSync(invalidNew.databasePath), true);
    assert.equal(fs.existsSync(legacy.databasePath), true);
    assert.equal(fs.existsSync(legacy.protectedDirectory), true);
    assert.equal(fs.existsSync(incompleteDatabase), true);
    assert.equal(listLegacyBackupPairs(root).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("backup markers reject malformed or mismatched protected-file counts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-backup-marker-count-"));
  try {
    const snapshot = "dienstplan-2026-07-19T13-00-00-000Z-aabbccddeeff";
    const pair = createPair(root, snapshot, { marker: false });
    const databaseSha256 = crypto.createHash("sha256").update(fs.readFileSync(pair.databasePath)).digest("hex");
    assert.throws(() => writeBackupCommitMarker({
      backupDirectory: root,
      snapshot,
      databaseSha256,
      protectedFiles: -1,
    }), /Anzahl geschuetzter Dateien/);
    assert.throws(() => writeBackupCommitMarker({
      backupDirectory: root,
      snapshot,
      databaseSha256,
      protectedFiles: Number.POSITIVE_INFINITY,
    }), /Anzahl geschuetzter Dateien/);

    const markerPath = writeBackupCommitMarker({ backupDirectory: root, snapshot, databaseSha256, protectedFiles: 0 });
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    marker.protectedDocuments.files = "0";
    fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
    assert.throws(() => inspectCommittedBackupMetadata(root, path.basename(markerPath)), /Sicherungsmarker/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("standalone Windows backup uses the same commit marker and committed-only retention", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "backup.js"), "utf8");
  assert.match(source, /writeBackupCommitMarker/);
  assert.match(source, /verifyCommittedBackup[\s\S]*verifyPair: verifyStandaloneBackupPair/);
  assert.match(source, /pruneCommittedBackups\(backupDirectory, 30, \{ verifyPair: verifyStandaloneBackupPair \}\)/);
  assert.match(source, /marker: markerTarget/);
});

test("standalone backup paths include protected loan files through direct or canonical references", () => {
  for (const relativePath of [
    "backup.js",
    "server-tools/windows/Backup-Grabenplaner.ps1",
    "server-tools/windows/Restore-Grabenplaner.ps1",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, "..", ...relativePath.split("/")), "utf8");
    assert.match(source, /loan_documents/, relativePath);
    assert.match(source, /loan_photos/, relativePath);
    assert.match(source, /loan_photo_attachments/, relativePath);
  }
  const canonicalSource = fs.readFileSync(path.join(
    __dirname,
    "..",
    "lib",
    "persistence",
    "sqlite",
    "operations",
    "maintenance.js",
  ), "utf8");
  assert.match(canonicalSource, /candidate_document_versions/);
  assert.match(canonicalSource, /loan_documents/);
  assert.match(canonicalSource, /loan_photos/);
  assert.match(canonicalSource, /loan_photo_attachments/);
  for (const relativePath of [
    "server-tools/linux/lib/backup-snapshot.js",
    "server-tools/linux/lib/verify-backup.js",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, "..", ...relativePath.split("/")), "utf8");
    assert.match(source, /protectedStorageReferencesFromDatabase/, relativePath);
  }
});

test("public readiness uses only O(1) cached metadata helpers", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const latest = source.match(/function latestDatabaseBackup\([\s\S]*?function serverDiagnostics/)?.[0] || "";
  assert.match(latest, /listCommittedBackupMetadata/);
  assert.match(latest, /listLegacyBackupMetadata/);
  assert.doesNotMatch(latest, /listCommittedBackups|listLegacyBackupPairs|verifyProtectedBackupPair|sha256/);
});

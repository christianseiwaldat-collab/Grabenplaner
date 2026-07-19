"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
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

    fs.appendFileSync(pair.databasePath, "tampered");
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
    const invalidOld = createPair(root, "dienstplan-2026-07-15T12-00-00-000Z-333333333333");
    fs.appendFileSync(invalidOld.databasePath, "tampered");
    const legacy = createPair(root, "dienstplan-2026-07-17T12-00-00-000Z", { marker: false });
    const incompleteDatabase = path.join(root, "dienstplan-2026-07-16T12-00-00-000Z.db");
    fs.writeFileSync(incompleteDatabase, "incomplete");
    fs.utimesSync(older.markerPath, new Date("2026-07-18T12:00:00Z"), new Date("2026-07-18T12:00:00Z"));
    fs.utimesSync(newer.markerPath, new Date("2026-07-19T12:00:00Z"), new Date("2026-07-19T12:00:00Z"));
    fs.utimesSync(invalidOld.markerPath, new Date("2026-07-15T12:00:00Z"), new Date("2026-07-15T12:00:00Z"));

    const result = pruneCommittedBackups(root, 1);
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(older.markerPath), false);
    assert.equal(fs.existsSync(older.databasePath), false);
    assert.equal(fs.existsSync(newer.markerPath), true);
    assert.equal(fs.existsSync(invalidOld.markerPath), true);
    assert.equal(fs.existsSync(invalidOld.databasePath), true);
    assert.equal(fs.existsSync(legacy.databasePath), true);
    assert.equal(fs.existsSync(legacy.protectedDirectory), true);
    assert.equal(fs.existsSync(incompleteDatabase), true);
    assert.equal(listLegacyBackupPairs(root).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("standalone Windows backup uses the same commit marker and committed-only retention", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "backup.js"), "utf8");
  assert.match(source, /writeBackupCommitMarker/);
  assert.match(source, /verifyCommittedBackup/);
  assert.match(source, /pruneCommittedBackups\(backupDirectory, 30\)/);
  assert.match(source, /marker: markerTarget/);
});

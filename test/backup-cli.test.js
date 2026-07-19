"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createAmuStorage } = require("../lib/amu-storage");
const { verifyCommittedBackup } = require("../lib/backup-commit");

test("standalone backup creates a verifiable committed pair on Windows-compatible paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-backup-cli-"));
  const dataRoot = path.join(root, "data-root");
  const protectedRoot = path.join(dataRoot, "private", "amu");
  const backupDirectory = path.join(root, "backups");
  process.env.GRABENPLANER_DATA_ROOT = dataRoot;
  createAmuStorage({
    rootDirectory: protectedRoot,
    encryptionKeys: { primary: crypto.randomBytes(32) },
    activeKeyId: "primary",
    scanner: async () => ({ available: true, clean: true, engine: "test" }),
  });
  const { createPairedBackup, verifyStandaloneBackupPair } = require("../backup");
  const { pruneCommittedBackups } = require("../lib/backup-commit");
  const database = new DatabaseSync(path.join(root, "source.db"));
  try {
    database.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample (value) VALUES ('ok')");
    const result = createPairedBackup(database, backupDirectory, "2026-07-19T12-00-00-000Z", "Testbackup");
    assert.equal(result.committed, true);
    assert.equal(fs.existsSync(result.marker), true);
    assert.equal(verifyCommittedBackup(backupDirectory, path.basename(result.marker)).committed, true);

    const newer = createPairedBackup(database, backupDirectory, "2026-07-20T12-00-00-000Z", "Testbackup neu");
    fs.utimesSync(result.marker, new Date("2026-07-19T12:00:00Z"), new Date("2026-07-19T12:00:00Z"));
    fs.utimesSync(newer.marker, new Date("2026-07-20T12:00:00Z"), new Date("2026-07-20T12:00:00Z"));
    const newerManifest = JSON.parse(fs.readFileSync(path.join(newer.protectedDirectory, "manifest.json"), "utf8"));
    fs.appendFileSync(path.join(newer.protectedDirectory, newerManifest.keyCheck.fileName), "tampered");
    const retention = pruneCommittedBackups(backupDirectory, 1, { verifyPair: verifyStandaloneBackupPair });
    assert.equal(retention.removed, 0);
    assert.equal(fs.existsSync(result.marker), true);
    assert.equal(fs.existsSync(newer.marker), true);
  } finally {
    database.close();
    delete process.env.GRABENPLANER_DATA_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

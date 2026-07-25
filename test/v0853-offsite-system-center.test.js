"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v0853-offsite-"));
const externalBackupPath = path.join(root, "external-backups");
const offsiteStatusPath = path.join(root, "offsite-status.json");
const now = new Date().toISOString();

fs.writeFileSync(offsiteStatusPath, `${JSON.stringify({
  format: "grabenplaner-offsite-backup-status",
  schemaVersion: 1,
  configured: true,
  state: "ok",
  generatedAt: now,
  lastAttemptAt: now,
  lastSuccessAt: now,
  lastSnapshotId: "1234567890ab",
  lastRepositoryCheckAt: now,
  lastFullCheckAt: now,
  lastRestoreTestAt: now,
  lastFailureAt: null,
  lastError: null,
  unresolvedFailures: {
    backup: false,
    fullCheck: false,
    restoreTest: false,
  },
  retention: {
    daily: 14,
    weekly: 8,
    monthly: 12,
  },
}, null, 2)}\n`, "utf8");

process.env.DB_PATH = path.join(root, "data", "dienstplan.db");
process.env.BACKUP_DIR = externalBackupPath;
process.env.GRABENPLANER_DATA_DIR = root;
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_OFFSITE_CONFIGURED = "1";
process.env.GRABENPLANER_OFFSITE_STATUS_FILE = offsiteStatusPath;
process.env.NODE_ENV = "test";

const {
  createDatabaseBackupToDirectory,
  db,
  releaseInstanceLockForTests,
  serverDiagnostics,
} = require("../server");

test.after(() => {
  db.close();
  releaseInstanceLockForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

test("v0.85.3 bewertet ein bestätigtes Offsite-Backup als wirksame Datenträgertrennung", () => {
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'external_backup_enabled'").run();
  createDatabaseBackupToDirectory(externalBackupPath, "offsite-separation-test", "external");

  const diagnostics = serverDiagnostics();
  assert.equal(diagnostics.backups.offsite.state, "ok");
  assert.equal(diagnostics.productionChecks.find((check) => check.id === "backup").ok, true);
  assert.equal(diagnostics.alerts.some((alert) => alert.id === "BACKUP_SAME_VOLUME"), false);
});

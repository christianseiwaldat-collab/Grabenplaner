"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "grabenplaner-v087-block5-photo-migration-"),
);
const databasePath = path.join(root, "dienstplan.db");
const environment = {
  ...process.env,
  DB_PATH: databasePath,
  BACKUP_DIR: path.join(root, "backups"),
  GRABENPLANER_DATA_DIR: path.join(root, "app-data"),
  GRABENPLANER_HOST: "127.0.0.1",
  GRABENPLANER_FORCE_PORTAL: "1",
  GRABENPLANER_SEED_DEMO: "1",
  GRABENPLANER_TEST_AMU_SCANNER: "clean",
  NODE_ENV: "test",
};

function runServerInitialization(script) {
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: environment,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
  return result.stdout.trim();
}

test.after(() => {
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
});

test("v0.87 Block 5 migriert einen bestehenden Leihfoto-Stand mit Sicherung und sicherem Default", () => {
  runServerInitialization(`
    const server = require("./server");
    server.db.close();
    server.releaseInstanceLockForTests();
  `);

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    DROP TRIGGER IF EXISTS trg_loan_photos_retention_insert;
    DROP TABLE IF EXISTS loan_photo_attachments;
    ALTER TABLE loan_photos DROP COLUMN original_deletion_reason;
    ALTER TABLE loan_photos DROP COLUMN original_deleted_at;
    ALTER TABLE loan_photos DROP COLUMN original_retained;
    ALTER TABLE loan_location_settings DROP COLUMN photo_original_retention;
    ALTER TABLE loan_location_settings DROP COLUMN photo_pdf_output_mode;
    DELETE FROM schema_migrations
    WHERE id = 'v0.87-loan-photo-pdf-attachments';
  `);
  legacy.close();

  const output = runServerInitialization(`
    const server = require("./server");
    const columns = (table) => server.db.prepare("PRAGMA table_info(" + table + ")")
      .all().map((column) => column.name);
    const result = {
      migration: Boolean(server.db.prepare(
        "SELECT 1 FROM schema_migrations WHERE id = 'v0.87-loan-photo-pdf-attachments'"
      ).get()),
      attachmentTable: Boolean(server.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'loan_photo_attachments'"
      ).get()),
      retentionTrigger: Boolean(server.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_loan_photos_retention_insert'"
      ).get()),
      settingColumns: columns("loan_location_settings"),
      photoColumns: columns("loan_photos"),
      defaults: server.db.prepare(
        "SELECT photo_pdf_output_mode, photo_original_retention FROM loan_location_settings LIMIT 1"
      ).get() || null,
    };
    process.stdout.write(JSON.stringify(result));
    server.db.close();
    server.releaseInstanceLockForTests();
  `);
  const result = JSON.parse(output);
  assert.equal(result.migration, true);
  assert.equal(result.attachmentTable, true);
  assert.equal(result.retentionTrigger, true);
  assert.ok(result.settingColumns.includes("photo_pdf_output_mode"));
  assert.ok(result.settingColumns.includes("photo_original_retention"));
  assert.ok(result.photoColumns.includes("original_retained"));
  assert.ok(result.photoColumns.includes("original_deleted_at"));
  assert.ok(result.photoColumns.includes("original_deletion_reason"));
  if (result.defaults) {
    assert.deepEqual(result.defaults, {
      photo_pdf_output_mode: "grayscale",
      photo_original_retention: "retain",
    });
  }
  assert.ok(
    fs.readdirSync(path.join(root, "app-data", "backups"))
      .some((name) => name.endsWith(".complete.json")),
    "Vor der Schemaerweiterung muss ein vollständiger interner Sicherungspunkt entstehen.",
  );

  const restartOutput = runServerInitialization(`
    const server = require("./server");
    process.stdout.write(JSON.stringify({
      migration: Boolean(server.db.prepare(
        "SELECT 1 FROM schema_migrations WHERE id = 'v0.87-loan-photo-pdf-attachments'"
      ).get()),
      triggerCount: server.db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?, ?)"
      ).get(
        "trg_loan_photos_retention_insert",
        "trg_loan_photo_attachments_immutable_update",
        "trg_loan_photo_attachments_immutable_delete"
      ).count,
    }));
    server.db.close();
    server.releaseInstanceLockForTests();
  `);
  assert.deepEqual(JSON.parse(restartOutput), {
    migration: true,
    triggerCount: 3,
  });
});

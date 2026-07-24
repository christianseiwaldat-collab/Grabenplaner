"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "..");
const serverPath = path.join(root, "server.js");

function runServerScript(script, environment) {
  return spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      ...environment,
      GRABENPLANER_SEED_DEMO: "0",
      GRABENPLANER_FORCE_PORTAL: "0",
      GRABENPLANER_TEST_AMU_SCANNER: "clean",
      NODE_ENV: "test",
    },
  });
}

test("v0.82 repariert einen namensgleichen aber wirkungslosen Immutable-Trigger erst nach Sicherung", () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v082-trigger-"));
  const databasePath = path.join(testRoot, "dienstplan.db");
  const dataDirectory = path.join(testRoot, "data");
  const environment = {
    DB_PATH: databasePath,
    BACKUP_DIR: path.join(testRoot, "external-backups"),
    GRABENPLANER_DATA_DIR: dataDirectory,
  };
  const triggerName = "trg_vacation_account_revisions_immutable_update";

  try {
    const corrupt = runServerScript(`
      const subject = require(${JSON.stringify(serverPath)});
      subject.db.exec(
        "DROP TRIGGER ${triggerName};"
        + " CREATE TRIGGER ${triggerName}"
        + " BEFORE UPDATE ON vacation_account_revisions"
        + " WHEN 0 BEGIN SELECT RAISE(ABORT, 'vacation account revisions are immutable'); END"
      );
      const sql = subject.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?"
      ).get(${JSON.stringify(triggerName)}).sql;
      process.stdout.write(JSON.stringify({ sql }));
      subject.db.close();
      subject.releaseInstanceLockForTests();
    `, environment);
    assert.equal(corrupt.status, 0, corrupt.stderr || corrupt.stdout);
    assert.match(JSON.parse(corrupt.stdout).sql, /WHEN 0/i);

    const repaired = runServerScript(`
      const subject = require(${JSON.stringify(serverPath)});
      const sql = subject.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?"
      ).get(${JSON.stringify(triggerName)}).sql;
      let blocked = false;
      subject.db.prepare(
        "INSERT INTO vacation_account_revisions"
        + " (id, employee_number, leave_year, revision, status, total_days,"
        + " eu_minimum_days, national_additional_days, weekly_workdays,"
        + " leave_year_start, leave_year_end, expiry_status, calculation_json,"
        + " sources_json, receipt_sha256, created_by)"
        + " VALUES ('trigger-test', 'trigger-test', 2032, 1, 'confirmed', 25,"
        + " 20, 5, 5, '2032-01-01', '2032-12-31', 'manual_review', '{}', '[]',"
        + " 'test-only', 'test')"
      ).run();
      try {
        subject.db.prepare(
          "UPDATE vacation_account_revisions SET total_days = 24 WHERE id = 'trigger-test'"
        ).run();
      } catch (error) {
        blocked = /immutable/i.test(String(error && error.message));
      }
      process.stdout.write(JSON.stringify({ sql, blocked }));
      subject.db.close();
      subject.releaseInstanceLockForTests();
    `, environment);
    assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);
    const result = JSON.parse(repaired.stdout);
    assert.doesNotMatch(result.sql, /WHEN 0/i);
    assert.match(result.sql, /BEFORE UPDATE ON vacation_account_revisions/i);
    assert.equal(result.blocked, true);

    const backupDirectory = path.join(dataDirectory, "backups");
    const backupNames = fs.readdirSync(backupDirectory);
    assert.ok(
      backupNames.some((name) => name.endsWith(".complete.json")),
      "Vor der Trigger-Reparatur muss eine verifizierte Migrationssicherung vorliegen.",
    );
    const backupContainsMalformedTrigger = backupNames
      .filter((name) => name.endsWith(".db"))
      .some((name) => {
        const backup = new DatabaseSync(path.join(backupDirectory, name), { readOnly: true });
        try {
          const row = backup.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
          ).get(triggerName);
          return /WHEN 0/i.test(String(row?.sql || ""));
        } finally {
          backup.close();
        }
      });
    assert.equal(
      backupContainsMalformedTrigger,
      true,
      "Die Sicherung muss den fehlerhaften Ausgangszustand vor der Reparatur enthalten.",
    );
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

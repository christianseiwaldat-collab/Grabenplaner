"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const schema = JSON.parse(read("server-tools/linux/offsite/module-schema.json"));
const timer = read("server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance.timer.in");
const smokeUnit = read("server-tools/linux/offsite/systemd/grabenplaner-offsite-application-smoke.service.in");
const restore = read("server-tools/linux/offsite/grabenplaner-offsite-restore-test.sh");
const assurance = read("server-tools/linux/offsite/grabenplaner-offsite-assurance.sh");
const installer = read("server-tools/linux/offsite/install-grabenplaner-offsite.sh");
const uninstaller = read("server-tools/linux/offsite/uninstall-grabenplaner-offsite.sh");
const selfTest = read("server-tools/linux/offsite/test-grabenplaner-offsite.sh");
const server = read("server.js");
const applicationSmokeSource = read("server-tools/linux/offsite/lib/application-smoke.js");
const {
  childEnvironment,
  PROTECTED_COLUMNS,
  PROTECTED_ROW_TABLES,
  sanitizeSmokeDatabase,
  SMOKE_ROOT,
  DATABASE,
  verifiedApplicationSmokeResult,
} = require(path.join(
  root, "server-tools/linux/offsite/lib/application-smoke.js",
));
const {
  ensureSqliteApplicationSchema,
} = require(path.join(root, "lib/persistence/sqlite/operations/application-schema.js"));
const broker = require(path.join(root, "server-tools/linux/offsite/lib/assurance-control-broker.js"));
const history = require(path.join(root, "server-tools/linux/offsite/lib/assurance-history.js"));

test("v0.86.2 packages module v6 and migrates only verified v1 through v5 installations", () => {
  assert.equal(schema.moduleVersion, 7);
  for (const relative of [
    "server-tools/linux/offsite/grabenplaner-offsite-application-smoke.sh",
    "server-tools/linux/offsite/lib/application-smoke.js",
    "server-tools/linux/offsite/systemd/grabenplaner-offsite-application-smoke.service.in",
    "server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance.timer.in",
  ]) assert.ok(schema.managedArtifacts.includes(relative), `Fehlt im Modul-v5-Vertrag: ${relative}`);
  assert.match(installer, /\[1, 2, 3, 4, 5, 6, 7\]\.includes\(value\.moduleVersion\)/);
  assert.match(installer, /installed_module_version >= 1 && installed_module_version <= 5/);
  assert.match(installer, /kontrolliert auf v6 migriert/);
  assert.match(installer, /for template in "\$OFFSITE_MODULE_ROOT"\/systemd\/\*\.in/);
});

test("offsite installer accepts the app-managed private backup mode without broadening it", () => {
  assert.match(installer, /backup_root_contract=.*stat --format='%u:%g:%a'/);
  assert.match(installer, /backup_root_contract" == "\$app_uid:\$app_gid:700"/);
  assert.match(installer, /backup_root_contract" == "\$app_uid:\$app_gid:750"/);
  assert.doesNotMatch(installer, /chmod\s+0?750[^\n]*OFFSITE_BACKUP_ROOT/);
});

test("nightly assurance is persistent, randomized and bound to one fixed allowlisted unit", () => {
  assert.match(timer, /OnCalendar=\*-\*-\* 03:45:00/);
  assert.match(timer, /RandomizedDelaySec=90min/);
  assert.match(timer, /FixedRandomDelay=true/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /AccuracySec=5min/);
  assert.match(timer, /Unit=grabenplaner-offsite-assurance@scheduled-nightly\.service/);
  assert.match(assurance, /scheduled-nightly\|scheduled-weekly/);
  assert.match(installer, /systemctl enable --now[\s\S]*grabenplaner-offsite-assurance\.timer/);
  assert.match(uninstaller, /grabenplaner-offsite-assurance\.timer/);
  assert.match(selfTest, /grabenplaner-offsite-assurance\.timer/);
});

test("every timer worker creates the shared offsite runtime directory independently after reboot", () => {
  for (const unit of ["assurance@", "prepare", "upload", "check", "restore-test"]) {
    const source = read(`server-tools/linux/offsite/systemd/grabenplaner-offsite-${unit}.service.in`);
    assert.match(source, /^RuntimeDirectory=grabenplaner-offsite$/m, unit);
    assert.match(source, /^RuntimeDirectoryMode=0755$/m, unit);
    assert.match(source, /^RuntimeDirectoryPreserve=yes$/m, unit);
    assert.match(source, /ReadWritePaths=.*\/run\/grabenplaner-offsite/, unit);
  }
  const socket = read("server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance-control.socket.in");
  assert.match(socket, /ListenStream=\/run\/grabenplaner-assurance-control\/request\.sock/);
  assert.doesNotMatch(socket, /\/run\/grabenplaner-offsite/);
});

function schedulerRunner(values, calls) {
  return (executable, args) => {
    calls.push([executable, ...args]);
    if (args[0] === "show") {
      const property = String(args[1] || "").replace("--property=", "");
      const value = values[property];
      if (value === undefined) return { status: 1, stdout: "unexpected\n" };
      return { status: 0, stdout: `${value}\n` };
    }
    if (args[0] === "is-enabled") return values.isEnabled;
    if (args[0] === "is-active") return values.isActive;
    return { status: 1, stdout: "unexpected\n" };
  };
}

test("broker proves only the fixed enabled and active nightly timer with a bounded canonical next run", () => {
  const calls = [];
  const dateCalls = [];
  const evidence = broker.schedulerEvidence({
    nowMs: Date.UTC(2026, 6, 22, 8, 30, 0),
    schedulerSpawnSync: schedulerRunner({
      LoadState: "loaded",
      FragmentPath: "/etc/systemd/system/grabenplaner-offsite-assurance.timer",
      NextElapseUSecRealtime: "Thu 2026-07-23 04:12:00 CEST",
      isEnabled: { status: 0, stdout: "enabled\n" },
      isActive: { status: 0, stdout: "active\n" },
    }, calls),
    dateSpawnSync: (executable, args) => {
      dateCalls.push([executable, ...args]);
      return { status: 0, stdout: "2026-07-23T02:12:00.000Z\n" };
    },
  });
  assert.deepEqual(evidence, {
    evidenceTrusted: true,
    timerInstalled: true,
    timerEnabled: true,
    nextElapse: "2026-07-23T02:12:00.000Z",
    checkedAt: "2026-07-22T08:30:00.000Z",
  });
  for (const call of calls) assert.equal(call.at(-1), "grabenplaner-offsite-assurance.timer");
  assert.deepEqual(calls.map((call) => call[1]), ["show", "show", "is-enabled", "is-active", "show"]);
  assert.deepEqual(dateCalls, [[
    "/usr/bin/date", "--date", "Thu 2026-07-23 04:12:00 CEST", "--utc", "+%Y-%m-%dT%H:%M:%S.000Z",
  ]]);
});

test("enabled but inactive timer is never reported operational", () => {
  const calls = [];
  let dateCalled = false;
  const evidence = broker.schedulerEvidence({
    nowMs: Date.UTC(2026, 6, 22, 8, 30, 0),
    schedulerSpawnSync: schedulerRunner({
      LoadState: "loaded",
      FragmentPath: "/etc/systemd/system/grabenplaner-offsite-assurance.timer",
      isEnabled: { status: 0, stdout: "enabled\n" },
      isActive: { status: 3, stdout: "inactive\n" },
    }, calls),
    dateSpawnSync: () => { dateCalled = true; return { status: 0, stdout: "unexpected\n" }; },
  });
  assert.deepEqual(evidence, {
    evidenceTrusted: true,
    timerInstalled: true,
    timerEnabled: false,
    nextElapse: null,
    checkedAt: "2026-07-22T08:30:00.000Z",
  });
  assert.equal(dateCalled, false);
});

test("scheduler evidence distinguishes a trusted missing timer and fails closed on malformed output", () => {
  const notFound = broker.schedulerEvidence({
    nowMs: Date.UTC(2026, 6, 22, 8, 30, 0),
    schedulerSpawnSync: schedulerRunner({ LoadState: "not-found" }, []),
  });
  assert.deepEqual(notFound, {
    evidenceTrusted: true,
    timerInstalled: false,
    timerEnabled: false,
    nextElapse: null,
    checkedAt: "2026-07-22T08:30:00.000Z",
  });
  const malformed = broker.schedulerEvidence({
    schedulerSpawnSync: () => ({ status: 0, stdout: `${"x".repeat(129)}\n` }),
  });
  assert.deepEqual(malformed, {
    evidenceTrusted: false,
    timerInstalled: false,
    timerEnabled: false,
    nextElapse: null,
    checkedAt: null,
  });
});

test("broker schema v2 always carries scheduler evidence while legacy schema v1 stays exact", () => {
  const requestId = crypto.randomUUID();
  const manualUnit = (_executable, args) => {
    if (args.includes("--property=LoadState")) return { status: 0, stdout: "loaded\n" };
    if (args.includes("--property=ActiveState")) return { status: 0, stdout: "inactive\n" };
    return { status: 1, stdout: "" };
  };
  const schedulerSpawnSync = schedulerRunner({ LoadState: "not-found" }, []);
  const makeRequest = (schemaVersion) => Buffer.from(`${JSON.stringify({
    format: broker.REQUEST_FORMAT,
    schemaVersion,
    action: "status",
    requestId,
  })}\n`);
  const modern = broker.handleRequest(makeRequest(2), {
    globalLockBusy: false,
    spawnSync: manualUnit,
    schedulerSpawnSync,
    nowMs: Date.UTC(2026, 6, 22, 8, 30, 0),
  });
  assert.deepEqual(Object.keys(modern).sort(), [
    "accepted", "acceptedAt", "code", "format", "requestId", "retryAfterSeconds", "scheduler", "schemaVersion",
  ]);
  assert.equal(modern.schemaVersion, 2);
  assert.equal(modern.scheduler.evidenceTrusted, true);

  const legacy = broker.handleRequest(makeRequest(1), {
    globalLockBusy: false,
    spawnSync: manualUnit,
  });
  assert.deepEqual(Object.keys(legacy).sort(), [
    "accepted", "acceptedAt", "code", "format", "requestId", "retryAfterSeconds", "schemaVersion",
  ]);
  assert.equal(legacy.schemaVersion, 1);
});

test("application smoke uses one-run server credentials without inheriting live secrets", () => {
  const environment = childEnvironment(43123);
  const secondEnvironment = childEnvironment(43123);
  assert.equal(environment.NODE_ENV, "test");
  assert.equal(environment.GRABENPLANER_OPERATION_MODE, "server");
  assert.equal(environment.GRABENPLANER_DEPLOYMENT_KIND, "recovery-smoke");
  assert.equal(environment.GRABENPLANER_PUBLIC_URL, "https://recovery-smoke.invalid");
  assert.equal(environment.GRABENPLANER_HOST, "127.0.0.1");
  assert.equal(environment.PORT, "43123");
  assert.equal(environment.GRABENPLANER_DATA_DIR, path.join(SMOKE_ROOT, "data-root"));
  assert.equal(environment.DB_PATH, DATABASE);
  assert.equal(environment.GRABENPLANER_OFFSITE_CONFIGURED, "0");
  assert.equal("GRABENPLANER_ALLOW_UNSCANNED_AMU" in environment, false);
  assert.equal(environment.GRABENPLANER_TEST_AMU_SCANNER, "clean");
  for (const key of [environment.GRABENPLANER_AMU_KEY, environment.GRABENPLANER_INTEGRATION_KEY]) {
    const decoded = Buffer.from(key, "base64");
    assert.equal(decoded.length, 32);
    assert.equal(decoded.toString("base64"), key);
  }
  assert.ok(environment.GRABENPLANER_SERVICE_CONTROL_TOKEN.length >= 32);
  assert.ok(environment.GRABENPLANER_WIFI_WEBHOOK_SECRET.length >= 32);
  for (const key of [
    "GRABENPLANER_AMU_KEY", "GRABENPLANER_INTEGRATION_KEY",
    "GRABENPLANER_SERVICE_CONTROL_TOKEN", "GRABENPLANER_WIFI_WEBHOOK_SECRET",
  ]) {
    assert.notEqual(environment[key], secondEnvironment[key], key);
  }
  const serializedValues = JSON.stringify(Object.values(environment)).toLowerCase();
  for (const forbidden of ["smtp", "rclone", "restic", "/etc/grabenplaner", "production-secret"]) {
    assert.equal(serializedValues.includes(forbidden), false, forbidden);
  }
  assert.match(restore, /cp --reflink=never -- "\$smoke_source_database" "\$OFFSITE_SMOKE_ROOT\/data-root\/data\/dienstplan\.db"/);
  assert.match(restore, /application-smoke\.js" --sanitize-database/);
  assert.doesNotMatch(restore, /restoreEncryptedFilesBackup\(\{ backupDirectory: documents, targetDirectory: target \}\)/);
  assert.doesNotMatch(restore, /smoke_source_documents|data-root\/private\/amu/);
  assert.match(restore, /\$\{#smoke_sources\[@\]\} == 1/);
  assert.ok(restore.indexOf('"$RECOVERY_VERIFY"') < restore.indexOf("--sanitize-database"));
  assert.match(restore, /restored_database_before/);
  assert.match(restore, /restored_database_after/);
  assert.match(restore, /Der verifizierte Restore-Stand wurde beim App-Smoke-Test veraendert/);
  assert.match(server, /if \(serverModeActive \|\| deploymentKind === "recovery-smoke"\) return;/);
});

test("application smoke sanitizes every known protected domain but preserves operational rows", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-smoke-sanitize-"));
  const databaseFile = path.join(directory, "dienstplan.db");
  let database = new DatabaseSync(databaseFile);
  try {
    database.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE employees (personnel_number TEXT PRIMARY KEY, full_name TEXT NOT NULL);
      CREATE TABLE personnel_sensitive_records (employee_number TEXT PRIMARY KEY, protected_payload TEXT NOT NULL);
      CREATE TABLE personnel_record_documents (id TEXT PRIMARY KEY, employee_number TEXT, protected_payload TEXT NOT NULL);
      CREATE TABLE sickness_cases (id INTEGER PRIMARY KEY, protected_payload TEXT NOT NULL);
      CREATE TABLE protected_case_events (id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL);
      CREATE TABLE sickness_alerts (id TEXT PRIMARY KEY, sickness_case_id INTEGER, protected_payload TEXT NOT NULL,
        FOREIGN KEY (sickness_case_id) REFERENCES sickness_cases(id));
      CREATE TABLE amu_reports (id INTEGER PRIMARY KEY, sickness_case_id INTEGER, protected_payload TEXT NOT NULL,
        FOREIGN KEY (sickness_case_id) REFERENCES sickness_cases(id));
      CREATE TABLE amu_documents (id TEXT PRIMARY KEY, report_id INTEGER, protected_payload TEXT NOT NULL,
        FOREIGN KEY (report_id) REFERENCES amu_reports(id));
      CREATE TABLE sickness_notification_preferences (
        employee_number TEXT,
        channel TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        earliest_time TEXT NOT NULL DEFAULT '08:00',
        protected_destination TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE personal_notification_contacts (
        employee_number TEXT,
        email_target_fingerprint TEXT NOT NULL DEFAULT '',
        phone_target_fingerprint TEXT NOT NULL DEFAULT '',
        email_enabled INTEGER NOT NULL DEFAULT 0,
        sms_enabled INTEGER NOT NULL DEFAULT 0,
        whatsapp_enabled INTEGER NOT NULL DEFAULT 0,
        earliest_time TEXT NOT NULL DEFAULT '08:00'
      );
      CREATE TABLE outbound_notification_jobs (id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL);
      CREATE TABLE privacy_requests (
        id TEXT PRIMARY KEY,
        employee_number TEXT NOT NULL,
        protected_payload TEXT NOT NULL
      );
      CREATE TABLE privacy_request_events (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        protected_payload TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES privacy_requests(id) ON DELETE RESTRICT
      );
      CREATE TABLE privacy_export_receipts (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        receipt_sha256 TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES privacy_requests(id) ON DELETE RESTRICT
      );
      CREATE TABLE vacation_account_revisions (
        id TEXT PRIMARY KEY,
        employee_number TEXT NOT NULL,
        calculation_json TEXT NOT NULL
      );
      CREATE TABLE vacation_account_events (
        id TEXT PRIMARY KEY,
        account_revision_id TEXT NOT NULL,
        FOREIGN KEY (account_revision_id) REFERENCES vacation_account_revisions(id) ON DELETE RESTRICT
      );
      CREATE TABLE vacation_history_events (
        id TEXT PRIMARY KEY,
        employee_number TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
      CREATE TABLE time_record_statements (
        id TEXT PRIMARY KEY,
        employee_number TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
      CREATE TABLE time_record_statement_events (
        id TEXT PRIMARY KEY,
        statement_id TEXT NOT NULL,
        FOREIGN KEY (statement_id) REFERENCES time_record_statements(id) ON DELETE RESTRICT
      );
      CREATE TABLE payroll_handoffs (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE payroll_handoff_events (
        id TEXT PRIMARY KEY,
        handoff_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY (handoff_id) REFERENCES payroll_handoffs(id) ON DELETE RESTRICT
      );
      CREATE TABLE retention_preview_runs (id TEXT PRIMARY KEY, result_json TEXT NOT NULL);
      CREATE TABLE loans (id TEXT PRIMARY KEY);
      CREATE TABLE loan_documents (
        id TEXT PRIMARY KEY,
        loan_id TEXT NOT NULL,
        storage_key TEXT NOT NULL UNIQUE,
        FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE RESTRICT
      );
      CREATE TABLE loan_photos (
        id TEXT PRIMARY KEY,
        loan_id TEXT NOT NULL,
        storage_key TEXT NOT NULL UNIQUE,
        FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE RESTRICT
      );
      CREATE TABLE loan_photo_attachments (
        id TEXT PRIMARY KEY,
        loan_id TEXT NOT NULL,
        storage_key TEXT NOT NULL UNIQUE,
        FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE RESTRICT
      );
      CREATE TABLE loan_document_deliveries (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES loan_documents(id) ON DELETE RESTRICT
      );
      CREATE TRIGGER trg_loan_document_deliveries_immutable_delete BEFORE DELETE ON loan_document_deliveries
        BEGIN SELECT RAISE(ABORT, 'loan document deliveries are immutable'); END;
      CREATE TRIGGER trg_loan_documents_immutable_delete BEFORE DELETE ON loan_documents
        BEGIN SELECT RAISE(ABORT, 'loan documents are immutable'); END;
      CREATE TRIGGER trg_loan_photos_immutable_delete BEFORE DELETE ON loan_photos
        BEGIN SELECT RAISE(ABORT, 'loan photos are immutable'); END;
      CREATE TRIGGER trg_loan_photo_attachments_immutable_delete BEFORE DELETE ON loan_photo_attachments
        BEGIN SELECT RAISE(ABORT, 'loan photo attachments are immutable'); END;
      CREATE TRIGGER trg_payroll_handoff_events_immutable_delete BEFORE DELETE ON payroll_handoff_events
        BEGIN SELECT RAISE(ABORT, 'payroll handoff events are immutable'); END;
      CREATE TRIGGER trg_payroll_handoffs_immutable_delete BEFORE DELETE ON payroll_handoffs
        BEGIN SELECT RAISE(ABORT, 'payroll handoffs are immutable'); END;
      CREATE TRIGGER trg_privacy_request_events_immutable_delete BEFORE DELETE ON privacy_request_events
        BEGIN SELECT RAISE(ABORT, 'privacy request events are immutable'); END;
      CREATE TRIGGER trg_retention_preview_runs_immutable_delete BEFORE DELETE ON retention_preview_runs
        BEGIN SELECT RAISE(ABORT, 'retention preview runs are immutable'); END;
      CREATE TRIGGER trg_time_record_statement_events_immutable_delete BEFORE DELETE ON time_record_statement_events
        BEGIN SELECT RAISE(ABORT, 'time record statement events are immutable'); END;
      CREATE TRIGGER trg_time_record_statements_immutable_delete BEFORE DELETE ON time_record_statements
        BEGIN SELECT RAISE(ABORT, 'time record statements are immutable'); END;
      CREATE TRIGGER trg_vacation_account_events_immutable_delete BEFORE DELETE ON vacation_account_events
        BEGIN SELECT RAISE(ABORT, 'vacation account events are immutable'); END;
      CREATE TRIGGER trg_vacation_account_revisions_immutable_delete BEFORE DELETE ON vacation_account_revisions
        BEGIN SELECT RAISE(ABORT, 'vacation account revisions are immutable'); END;
      CREATE TRIGGER trg_vacation_history_events_immutable_delete BEFORE DELETE ON vacation_history_events
        BEGIN SELECT RAISE(ABORT, 'vacation history events are immutable'); END;
      CREATE TABLE integration_connections (id TEXT PRIMARY KEY, active INTEGER NOT NULL,
        protected_credentials TEXT NOT NULL, credential_key_id TEXT NOT NULL);
      CREATE TABLE integration_deliveries (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL,
        FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE RESTRICT);
      CREATE TABLE portal_notifications (id TEXT PRIMARY KEY, message TEXT NOT NULL);
      INSERT INTO employees VALUES ('101', 'Demo Person');
      INSERT INTO personnel_sensitive_records VALUES ('101', 'enc:v2:sensitive');
      INSERT INTO personnel_record_documents VALUES ('doc', '101', 'enc:v2:document');
      INSERT INTO sickness_cases VALUES (1, 'enc:v2:case');
      INSERT INTO protected_case_events VALUES ('event', 'enc:v2:event');
      INSERT INTO sickness_alerts VALUES ('alert', 1, 'enc:v2:alert');
      INSERT INTO amu_reports VALUES (1, 1, 'enc:v2:report');
      INSERT INTO amu_documents VALUES ('amu', 1, 'enc:v2:amu');
      INSERT INTO sickness_notification_preferences
        (employee_number, channel, enabled, earliest_time, protected_destination)
      VALUES ('101', 'email', 1, '07:30', '');
      INSERT INTO personal_notification_contacts
        (employee_number, email_target_fingerprint, phone_target_fingerprint,
         email_enabled, sms_enabled, whatsapp_enabled, earliest_time)
      VALUES ('101', '${"a".repeat(64)}', '${"b".repeat(64)}', 1, 1, 0, '07:30');
      INSERT INTO outbound_notification_jobs VALUES ('job', 'enc:v2:job');
      INSERT INTO privacy_requests VALUES ('privacy', '101', 'enc:v2:privacy');
      INSERT INTO privacy_request_events VALUES ('privacy-event', 'privacy', 'enc:v2:privacy-event');
      INSERT INTO privacy_export_receipts VALUES ('privacy-receipt', 'privacy', '0123456789abcdef');
      INSERT INTO vacation_account_revisions VALUES ('vacation', '101', 'enc:v2:vacation');
      INSERT INTO vacation_account_events VALUES ('vacation-event', 'vacation');
      INSERT INTO vacation_history_events VALUES ('vacation-history', '101', 'enc:v2:vacation-history');
      INSERT INTO time_record_statements VALUES ('statement', '101', 'enc:v2:statement');
      INSERT INTO time_record_statement_events VALUES ('statement-event', 'statement');
      INSERT INTO payroll_handoffs VALUES ('handoff', 'enc:v2:handoff');
      INSERT INTO payroll_handoff_events VALUES ('handoff-event', 'handoff', 'enc:v2:handoff-event');
      INSERT INTO retention_preview_runs VALUES ('retention', 'enc:v2:retention');
      INSERT INTO loans VALUES ('loan');
      INSERT INTO loan_documents VALUES ('loan-document', 'loan', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      INSERT INTO loan_photos VALUES ('loan-photo', 'loan', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      INSERT INTO loan_photo_attachments VALUES ('loan-photo-attachment', 'loan', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
      INSERT INTO loan_document_deliveries VALUES ('loan-delivery', 'loan-document');
      INSERT INTO integration_connections VALUES ('connection', 1, 'gp-integration-secret:v1:value', 'live-key');
      INSERT INTO integration_deliveries VALUES ('delivery', 'connection');
      INSERT INTO portal_notifications VALUES ('notice', 'Nicht fuer den Smoke-Test');
    `);
  } finally {
    database.close();
    database = null;
  }

  try {
    assert.equal(sanitizeSmokeDatabase(databaseFile), true);
    database = new DatabaseSync(databaseFile, { readOnly: true });
    assert.deepEqual(
      database.prepare("SELECT * FROM employees").all().map((row) => ({ ...row })),
      [{ personnel_number: "101", full_name: "Demo Person" }],
    );
    for (const table of [
      "personnel_sensitive_records", "personnel_record_documents", "sickness_cases", "sickness_alerts",
      "protected_case_events",
      "amu_reports", "amu_documents", "outbound_notification_jobs",
      "privacy_export_receipts", "privacy_request_events", "privacy_requests",
      "vacation_account_events", "vacation_account_revisions",
      "vacation_history_events",
      "time_record_statement_events", "time_record_statements", "retention_preview_runs",
      "loan_document_deliveries", "loan_documents", "loan_photo_attachments", "loan_photos",
      "payroll_handoff_events", "payroll_handoffs",
      "portal_notifications",
    ]) assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT employee_number, channel, enabled, earliest_time, protected_destination
          FROM sickness_notification_preferences
        `).get(),
      },
      {
        employee_number: "101",
        channel: "email",
        enabled: 1,
        earliest_time: "07:30",
        protected_destination: "",
      },
    );
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT employee_number, email_target_fingerprint, phone_target_fingerprint,
                 email_enabled, sms_enabled, whatsapp_enabled, earliest_time
          FROM personal_notification_contacts
        `).get(),
      },
      {
        employee_number: "101",
        email_target_fingerprint: "a".repeat(64),
        phone_target_fingerprint: "b".repeat(64),
        email_enabled: 1,
        sms_enabled: 1,
        whatsapp_enabled: 0,
        earliest_time: "07:30",
      },
    );
    for (const column of [
      "privacy_requests.protected_payload",
      "privacy_request_events.protected_payload",
      "vacation_account_revisions.calculation_json",
      "vacation_history_events.snapshot_json",
      "time_record_statements.snapshot_json",
      "payroll_handoffs.payload_json",
      "payroll_handoff_events.payload_json",
      "retention_preview_runs.result_json",
    ]) assert.equal(PROTECTED_COLUMNS.has(column), true, column);
    for (const column of [
      "personal_notification_contacts.protected_address",
      "sickness_notification_preferences.protected_destination",
    ]) assert.equal(PROTECTED_COLUMNS.has(column), false, column);
    for (const table of [
      "personal_notification_contacts",
      "sickness_notification_preferences",
    ]) assert.equal(PROTECTED_ROW_TABLES.includes(table), false, table);
    for (const trigger of [
      "trg_payroll_handoff_events_immutable_delete",
      "trg_payroll_handoffs_immutable_delete",
      "trg_loan_document_deliveries_immutable_delete",
      "trg_loan_documents_immutable_delete",
      "trg_loan_photo_attachments_immutable_delete",
      "trg_loan_photos_immutable_delete",
      "trg_privacy_request_events_immutable_delete",
      "trg_retention_preview_runs_immutable_delete",
      "trg_time_record_statement_events_immutable_delete",
      "trg_time_record_statements_immutable_delete",
      "trg_vacation_account_events_immutable_delete",
      "trg_vacation_account_revisions_immutable_delete",
      "trg_vacation_history_events_immutable_delete",
    ]) {
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trigger).count,
        1,
        trigger,
      );
    }
    assert.deepEqual(
      { ...database.prepare("SELECT id, active, protected_credentials, credential_key_id FROM integration_connections").get() },
      { id: "connection", active: 0, protected_credentials: "", credential_key_id: "" },
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM loans").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM integration_deliveries").get().count, 1);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(database.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]), ["ok"]);
  } finally {
    if (database) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("application smoke sanitizes v0.90 personnel document history and restores delete guards", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-smoke-personnel-v090-"));
  const databaseFile = path.join(directory, "dienstplan.db");
  const protectedDeleteTriggers = [
    "trg_personnel_record_document_events_immutable_delete",
    "trg_personnel_record_document_versions_immutable_delete",
    "trg_personnel_record_documents_no_delete",
  ];
  let database = new DatabaseSync(databaseFile);
  let triggerSqlBefore;
  try {
    database.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE employees (
        personnel_number TEXT PRIMARY KEY,
        full_name TEXT NOT NULL
      );
      CREATE TABLE personnel_record_document_categories (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL
      );
      CREATE TABLE personnel_record_documents (
        id TEXT PRIMARY KEY,
        employee_number TEXT NOT NULL,
        category_id TEXT NOT NULL,
        protected_payload TEXT NOT NULL,
        FOREIGN KEY (employee_number) REFERENCES employees(personnel_number) ON DELETE RESTRICT,
        FOREIGN KEY (category_id) REFERENCES personnel_record_document_categories(id) ON DELETE RESTRICT
      );
      CREATE TABLE personnel_record_document_versions (
        document_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        protected_payload TEXT NOT NULL,
        PRIMARY KEY (document_id, version_number),
        FOREIGN KEY (document_id) REFERENCES personnel_record_documents(id) ON DELETE RESTRICT
      );
      CREATE TABLE personnel_record_document_events (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        FOREIGN KEY (document_id, version_number)
          REFERENCES personnel_record_document_versions(document_id, version_number) ON DELETE RESTRICT
      );
      CREATE TRIGGER trg_personnel_record_document_events_immutable_delete
        BEFORE DELETE ON personnel_record_document_events
        BEGIN SELECT RAISE(ABORT, 'personnel document events are immutable'); END;
      CREATE TRIGGER trg_personnel_record_document_versions_immutable_delete
        BEFORE DELETE ON personnel_record_document_versions
        BEGIN SELECT RAISE(ABORT, 'personnel document versions are immutable'); END;
      CREATE TRIGGER trg_personnel_record_documents_no_delete
        BEFORE DELETE ON personnel_record_documents
        BEGIN SELECT RAISE(ABORT, 'versioned personnel documents cannot be deleted'); END;

      INSERT INTO employees VALUES ('101', 'Demo Person');
      INSERT INTO personnel_record_document_categories VALUES ('contract', 'Vertrag');
      INSERT INTO personnel_record_documents
        VALUES ('document-1', '101', 'contract', 'enc:v2:document');
      INSERT INTO personnel_record_document_versions
        VALUES ('document-1', 1, 'enc:v2:document-version');
      INSERT INTO personnel_record_document_events VALUES ('event-1', 'document-1', 1);
    `);
    triggerSqlBefore = Object.fromEntries(database.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name IN (${protectedDeleteTriggers.map(() => "?").join(", ")})
      ORDER BY name
    `).all(...protectedDeleteTriggers).map((row) => [row.name, row.sql]));
  } finally {
    database.close();
    database = null;
  }

  try {
    assert.equal(sanitizeSmokeDatabase(databaseFile), true);
    database = new DatabaseSync(databaseFile, { readOnly: true });
    for (const table of [
      "personnel_record_document_events",
      "personnel_record_document_versions",
      "personnel_record_documents",
    ]) assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
    assert.deepEqual(
      database.prepare("SELECT id, label FROM personnel_record_document_categories").all()
        .map((row) => ({ ...row })),
      [{ id: "contract", label: "Vertrag" }],
    );
    assert.deepEqual(
      database.prepare("SELECT personnel_number, full_name FROM employees").all()
        .map((row) => ({ ...row })),
      [{ personnel_number: "101", full_name: "Demo Person" }],
    );
    const triggerSqlAfter = Object.fromEntries(database.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name IN (${protectedDeleteTriggers.map(() => "?").join(", ")})
      ORDER BY name
    `).all(...protectedDeleteTriggers).map((row) => [row.name, row.sql]));
    assert.deepEqual(triggerSqlAfter, triggerSqlBefore);
    assert.equal(PROTECTED_COLUMNS.has("personnel_record_document_versions.protected_payload"), true);
    for (const table of [
      "personnel_record_document_events",
      "personnel_record_document_versions",
    ]) assert.equal(PROTECTED_ROW_TABLES.includes(table), true, table);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(database.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]), ["ok"]);
  } finally {
    if (database) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("application smoke sanitizes v0.89 personnel lifecycle rows and bound candidate workflows", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-smoke-personnel-v089-"));
  const databaseFile = path.join(directory, "dienstplan.db");
  let database = new DatabaseSync(databaseFile);
  const protectedDeleteTriggers = [
    "trg_candidate_conversions_immutable_delete",
    "trg_candidate_document_versions_immutable_delete",
    "trg_candidate_events_immutable_delete",
    "trg_custom_process_run_assignments_immutable_delete",
    "trg_custom_process_run_bindings_immutable_delete",
    "trg_custom_process_run_steps_personnel_protected_delete",
    "trg_custom_process_runs_personnel_protected_delete",
  ];
  let triggerSqlBefore;
  try {
    database.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE employees (personnel_number TEXT PRIMARY KEY);
      CREATE TABLE candidates (
        id TEXT PRIMARY KEY,
        protected_payload TEXT NOT NULL
      );
      CREATE TABLE candidate_applications (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        protected_payload TEXT NOT NULL,
        UNIQUE(id, candidate_id),
        FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE RESTRICT
      );
      CREATE TABLE candidate_document_categories (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL
      );
      CREATE TABLE candidate_documents (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        category_id TEXT NOT NULL,
        protected_payload TEXT NOT NULL,
        UNIQUE(id, candidate_id),
        FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE RESTRICT,
        FOREIGN KEY (application_id, candidate_id)
          REFERENCES candidate_applications(id, candidate_id) ON DELETE RESTRICT,
        FOREIGN KEY (category_id) REFERENCES candidate_document_categories(id) ON DELETE RESTRICT
      );
      CREATE TABLE candidate_document_versions (
        document_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        protected_payload TEXT NOT NULL,
        PRIMARY KEY (document_id, version_number),
        FOREIGN KEY (document_id) REFERENCES candidate_documents(id) ON DELETE RESTRICT
      );
      CREATE TABLE candidate_events (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        application_id TEXT,
        document_id TEXT,
        protected_payload TEXT NOT NULL,
        FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE RESTRICT,
        FOREIGN KEY (application_id, candidate_id)
          REFERENCES candidate_applications(id, candidate_id) ON DELETE RESTRICT,
        FOREIGN KEY (document_id, candidate_id)
          REFERENCES candidate_documents(id, candidate_id) ON DELETE RESTRICT
      );
      CREATE TABLE candidate_conversions (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        employee_number TEXT NOT NULL,
        protected_payload TEXT NOT NULL,
        FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE RESTRICT,
        FOREIGN KEY (application_id, candidate_id)
          REFERENCES candidate_applications(id, candidate_id) ON DELETE RESTRICT,
        FOREIGN KEY (employee_number) REFERENCES employees(personnel_number) ON DELETE RESTRICT
      );
      CREATE TABLE custom_process_runs (
        id TEXT PRIMARY KEY,
        trigger_type TEXT NOT NULL
      );
      CREATE TABLE custom_process_run_steps (
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        PRIMARY KEY (run_id, step_id),
        FOREIGN KEY (run_id) REFERENCES custom_process_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE custom_process_run_bindings (
        run_id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES custom_process_runs(id) ON DELETE RESTRICT,
        FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE RESTRICT,
        FOREIGN KEY (application_id, candidate_id)
          REFERENCES candidate_applications(id, candidate_id) ON DELETE RESTRICT
      );
      CREATE TABLE custom_process_run_step_assignments (
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        employee_number TEXT NOT NULL,
        PRIMARY KEY (run_id, step_id),
        FOREIGN KEY (run_id) REFERENCES custom_process_run_bindings(run_id) ON DELETE RESTRICT,
        FOREIGN KEY (run_id, step_id)
          REFERENCES custom_process_run_steps(run_id, step_id) ON DELETE RESTRICT,
        FOREIGN KEY (employee_number) REFERENCES employees(personnel_number) ON DELETE RESTRICT
      );
      CREATE TRIGGER trg_candidate_document_versions_immutable_delete
        BEFORE DELETE ON candidate_document_versions
        BEGIN SELECT RAISE(ABORT, 'candidate document versions are immutable'); END;
      CREATE TRIGGER trg_candidate_events_immutable_delete
        BEFORE DELETE ON candidate_events
        BEGIN SELECT RAISE(ABORT, 'candidate events are immutable'); END;
      CREATE TRIGGER trg_candidate_conversions_immutable_delete
        BEFORE DELETE ON candidate_conversions
        BEGIN SELECT RAISE(ABORT, 'candidate conversions are immutable'); END;
      CREATE TRIGGER trg_custom_process_run_bindings_immutable_delete
        BEFORE DELETE ON custom_process_run_bindings
        BEGIN SELECT RAISE(ABORT, 'personnel workflow instance bindings are immutable'); END;
      CREATE TRIGGER trg_custom_process_run_assignments_immutable_delete
        BEFORE DELETE ON custom_process_run_step_assignments
        BEGIN SELECT RAISE(ABORT, 'personnel workflow task assignments are immutable'); END;
      CREATE TRIGGER trg_custom_process_runs_personnel_protected_delete
        BEFORE DELETE ON custom_process_runs
        WHEN EXISTS (
          SELECT 1 FROM custom_process_run_bindings binding WHERE binding.run_id = OLD.id
        )
        BEGIN SELECT RAISE(ABORT, 'personnel workflow instances cannot be deleted'); END;
      CREATE TRIGGER trg_custom_process_run_steps_personnel_protected_delete
        BEFORE DELETE ON custom_process_run_steps
        WHEN EXISTS (
          SELECT 1 FROM custom_process_run_bindings binding WHERE binding.run_id = OLD.run_id
        )
        BEGIN SELECT RAISE(ABORT, 'personnel workflow instance steps cannot be deleted'); END;

      INSERT INTO employees VALUES ('101');
      INSERT INTO candidates VALUES ('candidate-1', 'enc:v2:candidate');
      INSERT INTO candidate_applications VALUES ('application-1', 'candidate-1', 'enc:v2:application');
      INSERT INTO candidate_document_categories VALUES ('cv', 'Lebenslauf');
      INSERT INTO candidate_documents
        VALUES ('document-1', 'candidate-1', 'application-1', 'cv', 'enc:v2:document');
      INSERT INTO candidate_document_versions VALUES ('document-1', 1, 'enc:v2:document-version');
      INSERT INTO candidate_events
        VALUES ('event-1', 'candidate-1', 'application-1', 'document-1', 'enc:v2:event');
      INSERT INTO candidate_conversions
        VALUES ('conversion-1', 'candidate-1', 'application-1', '101', 'enc:v2:conversion');
      INSERT INTO custom_process_runs VALUES ('personnel-run', 'personnel_manual');
      INSERT INTO custom_process_runs VALUES ('operational-run', 'manual');
      INSERT INTO custom_process_run_steps VALUES ('personnel-run', 'step-1');
      INSERT INTO custom_process_run_steps VALUES ('operational-run', 'step-1');
      INSERT INTO custom_process_run_bindings
        VALUES ('personnel-run', 'candidate-1', 'application-1');
      INSERT INTO custom_process_run_step_assignments VALUES ('personnel-run', 'step-1', '101');
    `);
    triggerSqlBefore = Object.fromEntries(database.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name IN (${protectedDeleteTriggers.map(() => "?").join(", ")})
      ORDER BY name
    `).all(...protectedDeleteTriggers).map((row) => [row.name, row.sql]));
  } finally {
    database.close();
    database = null;
  }

  try {
    assert.equal(sanitizeSmokeDatabase(databaseFile), true);
    database = new DatabaseSync(databaseFile, { readOnly: true });
    for (const table of [
      "custom_process_run_step_assignments",
      "custom_process_run_bindings",
      "candidate_events",
      "candidate_document_versions",
      "candidate_documents",
      "candidate_conversions",
      "candidate_applications",
      "candidates",
    ]) assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
    assert.deepEqual(
      database.prepare("SELECT id, trigger_type FROM custom_process_runs ORDER BY id").all()
        .map((row) => ({ ...row })),
      [{ id: "operational-run", trigger_type: "manual" }],
    );
    assert.deepEqual(
      database.prepare("SELECT run_id, step_id FROM custom_process_run_steps").all()
        .map((row) => ({ ...row })),
      [{ run_id: "operational-run", step_id: "step-1" }],
    );
    assert.deepEqual(
      database.prepare("SELECT id, label FROM candidate_document_categories").all()
        .map((row) => ({ ...row })),
      [{ id: "cv", label: "Lebenslauf" }],
    );
    assert.deepEqual(
      database.prepare("SELECT personnel_number FROM employees").all()
        .map((row) => ({ ...row })),
      [{ personnel_number: "101" }],
    );
    const triggerSqlAfter = Object.fromEntries(database.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name IN (${protectedDeleteTriggers.map(() => "?").join(", ")})
      ORDER BY name
    `).all(...protectedDeleteTriggers).map((row) => [row.name, row.sql]));
    assert.deepEqual(triggerSqlAfter, triggerSqlBefore);
    for (const column of [
      "candidates.protected_payload",
      "candidate_applications.protected_payload",
      "candidate_documents.protected_payload",
      "candidate_document_versions.protected_payload",
      "candidate_events.protected_payload",
      "candidate_conversions.protected_payload",
    ]) assert.equal(PROTECTED_COLUMNS.has(column), true, column);
    for (const table of [
      "custom_process_run_step_assignments",
      "custom_process_run_bindings",
      "candidate_events",
      "candidate_document_versions",
      "candidate_documents",
      "candidate_conversions",
      "candidate_applications",
      "candidates",
    ]) assert.equal(PROTECTED_ROW_TABLES.includes(table), true, table);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(database.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]), ["ok"]);
  } finally {
    if (database) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("application smoke accepts the complete O2 through O5 lifecycle schema", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-smoke-lifecycle-schema-"));
  const databaseFile = path.join(directory, "dienstplan.db");
  let database = new DatabaseSync(databaseFile);
  try {
    database.exec("PRAGMA foreign_keys=ON");
    ensureSqliteApplicationSchema(database);
  } finally {
    database.close();
    database = null;
  }

  try {
    assert.equal(sanitizeSmokeDatabase(databaseFile), true);
    database = new DatabaseSync(databaseFile, { readOnly: true });
    for (const column of [
      "personnel_employment_episodes.protected_payload",
      "personnel_lifecycle_cases.protected_payload",
      "personnel_lifecycle_case_reference_dates.protected_payload",
      "personnel_lifecycle_case_events.protected_payload",
      "personnel_lifecycle_offboarding_operations.protected_result_payload",
      "personnel_lifecycle_offboarding_package_versions.protected_snapshot",
      "personnel_lifecycle_offboarding_package_version_archives.protected_payload",
      "personnel_lifecycle_offboarding_runtime_steps.protected_payload",
      "personnel_lifecycle_offboarding_run_terminations.protected_payload",
    ]) assert.equal(PROTECTED_COLUMNS.has(column), true, column);
    for (const table of [
      "personnel_employment_episodes",
      "personnel_lifecycle_cases",
      "personnel_lifecycle_case_reference_dates",
      "personnel_lifecycle_case_package_bindings",
      "personnel_lifecycle_case_package_runs",
      "personnel_lifecycle_case_assignments",
      "personnel_lifecycle_case_assignment_bindings",
      "personnel_lifecycle_case_events",
      "personnel_lifecycle_confidential_access_events",
      "personnel_lifecycle_onboarding_operations",
      "personnel_lifecycle_offboarding_package_versions",
      "personnel_lifecycle_offboarding_package_version_archives",
      "personnel_lifecycle_offboarding_operations",
      "personnel_lifecycle_offboarding_package_bindings",
      "personnel_lifecycle_offboarding_package_runs",
      "personnel_lifecycle_offboarding_runtime_steps",
      "personnel_lifecycle_offboarding_assignment_bindings",
      "personnel_lifecycle_offboarding_run_terminations",
    ]) assert.equal(PROTECTED_ROW_TABLES.includes(table), true, table);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(database.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]), ["ok"]);
  } finally {
    if (database) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("application smoke accepts and clears the prior O2 lifecycle delete guards", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-smoke-lifecycle-o2-"));
  const databaseFile = path.join(directory, "dienstplan.db");
  const tableColumns = new Map([
    ["personnel_employment_episodes", "id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL"],
    ["personnel_lifecycle_cases", "id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL"],
    ["personnel_lifecycle_case_reference_dates", "id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL"],
    ["personnel_lifecycle_case_package_bindings", "id TEXT PRIMARY KEY"],
    ["personnel_lifecycle_case_assignments", "id TEXT PRIMARY KEY"],
    ["personnel_lifecycle_case_events", "id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL"],
    ["personnel_lifecycle_confidential_access_events", "id TEXT PRIMARY KEY"],
  ]);
  let database = new DatabaseSync(databaseFile);
  try {
    for (const [table, columns] of tableColumns) {
      database.exec(`CREATE TABLE ${table} (${columns})`);
      database.exec(`
        CREATE TRIGGER trg_${table}_o2_delete_blocked
        BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT, 'personnel lifecycle O2 persistence is read-only'); END;
      `);
      const protectedColumn = columns.includes("protected_payload") ? ", protected_payload" : "";
      const protectedValue = protectedColumn ? ", 'enc:v2:lifecycle'" : "";
      database.exec(`INSERT INTO ${table} (id${protectedColumn}) VALUES ('${table}'${protectedValue})`);
    }
  } finally {
    database.close();
    database = null;
  }

  try {
    assert.equal(sanitizeSmokeDatabase(databaseFile), true);
    database = new DatabaseSync(databaseFile, { readOnly: true });
    for (const table of tableColumns.keys()) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
    }
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(database.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]), ["ok"]);
  } finally {
    if (database) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("application smoke removes O2 through O5 lifecycle rows and their linked workflow runs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-smoke-lifecycle-rows-"));
  const databaseFile = path.join(directory, "dienstplan.db");
  let database = new DatabaseSync(databaseFile);
  const lifecycleTables = [
    "personnel_employment_episodes",
    "personnel_lifecycle_cases",
    "personnel_lifecycle_case_reference_dates",
    "personnel_lifecycle_case_package_bindings",
    "personnel_lifecycle_case_assignments",
    "personnel_lifecycle_case_assignment_bindings",
    "personnel_lifecycle_case_events",
    "personnel_lifecycle_confidential_access_events",
    "personnel_lifecycle_onboarding_operations",
    "personnel_lifecycle_offboarding_package_versions",
    "personnel_lifecycle_offboarding_package_version_archives",
    "personnel_lifecycle_offboarding_operations",
    "personnel_lifecycle_offboarding_package_bindings",
    "personnel_lifecycle_offboarding_runtime_steps",
    "personnel_lifecycle_offboarding_assignment_bindings",
    "personnel_lifecycle_offboarding_run_terminations",
  ];
  try {
    database.exec(`
      CREATE TABLE custom_process_runs (id TEXT PRIMARY KEY, trigger_type TEXT NOT NULL);
      CREATE TABLE custom_process_run_steps (run_id TEXT NOT NULL, step_id TEXT NOT NULL);
      CREATE TABLE custom_process_run_bindings (run_id TEXT PRIMARY KEY);
      CREATE TABLE custom_process_run_step_assignments (run_id TEXT NOT NULL);
      CREATE TABLE personnel_employment_episodes (id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL);
      CREATE TABLE personnel_lifecycle_cases (id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL);
      CREATE TABLE personnel_lifecycle_case_reference_dates (id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL);
      CREATE TABLE personnel_lifecycle_case_package_bindings (id TEXT PRIMARY KEY);
      CREATE TABLE personnel_lifecycle_case_package_runs (package_binding_id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
      CREATE TABLE personnel_lifecycle_case_assignments (id TEXT PRIMARY KEY);
      CREATE TABLE personnel_lifecycle_case_assignment_bindings (id TEXT PRIMARY KEY);
      CREATE TABLE personnel_lifecycle_case_events (id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL);
      CREATE TABLE personnel_lifecycle_confidential_access_events (id TEXT PRIMARY KEY);
      CREATE TABLE personnel_lifecycle_onboarding_operations (id TEXT PRIMARY KEY);
      CREATE TABLE personnel_lifecycle_offboarding_package_versions (id TEXT PRIMARY KEY, protected_snapshot TEXT NOT NULL);
      CREATE TABLE personnel_lifecycle_offboarding_package_version_archives (id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL);
      CREATE TABLE personnel_lifecycle_offboarding_operations (id TEXT PRIMARY KEY, protected_result_payload TEXT NOT NULL);
      CREATE TABLE personnel_lifecycle_offboarding_package_bindings (id TEXT PRIMARY KEY);
      CREATE TABLE personnel_lifecycle_offboarding_package_runs (package_binding_id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
      CREATE TABLE personnel_lifecycle_offboarding_runtime_steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, protected_payload TEXT NOT NULL);
      CREATE TABLE personnel_lifecycle_offboarding_assignment_bindings (id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
      CREATE TABLE personnel_lifecycle_offboarding_run_terminations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, protected_payload TEXT NOT NULL);

      INSERT INTO custom_process_runs VALUES ('onboarding-run', 'personnel_manual');
      INSERT INTO custom_process_runs VALUES ('offboarding-run', 'personnel_manual');
      INSERT INTO custom_process_runs VALUES ('operational-run', 'manual');
      INSERT INTO custom_process_run_steps VALUES ('onboarding-run', 'onboarding-step');
      INSERT INTO custom_process_run_steps VALUES ('offboarding-run', 'offboarding-step');
      INSERT INTO custom_process_run_steps VALUES ('operational-run', 'operational-step');
      INSERT INTO personnel_employment_episodes VALUES ('episode', 'enc:v2:episode');
      INSERT INTO personnel_lifecycle_cases VALUES ('case', 'enc:v2:case');
      INSERT INTO personnel_lifecycle_case_reference_dates VALUES ('reference', 'enc:v2:reference');
      INSERT INTO personnel_lifecycle_case_package_bindings VALUES ('case-package');
      INSERT INTO personnel_lifecycle_case_package_runs VALUES ('case-package', 'onboarding-run');
      INSERT INTO personnel_lifecycle_case_assignments VALUES ('case-assignment');
      INSERT INTO personnel_lifecycle_case_assignment_bindings VALUES ('case-assignment-binding');
      INSERT INTO personnel_lifecycle_case_events VALUES ('case-event', 'enc:v2:case-event');
      INSERT INTO personnel_lifecycle_confidential_access_events VALUES ('confidential-event');
      INSERT INTO personnel_lifecycle_onboarding_operations VALUES ('onboarding-operation');
      INSERT INTO personnel_lifecycle_offboarding_package_versions VALUES ('offboarding-version', 'enc:v2:version');
      INSERT INTO personnel_lifecycle_offboarding_package_version_archives VALUES ('offboarding-archive', 'enc:v2:archive');
      INSERT INTO personnel_lifecycle_offboarding_operations VALUES ('offboarding-operation', 'enc:v2:operation');
      INSERT INTO personnel_lifecycle_offboarding_package_bindings VALUES ('offboarding-package');
      INSERT INTO personnel_lifecycle_offboarding_package_runs VALUES ('offboarding-package', 'offboarding-run');
      INSERT INTO personnel_lifecycle_offboarding_runtime_steps VALUES ('offboarding-step', 'offboarding-run', 'enc:v2:step');
      INSERT INTO personnel_lifecycle_offboarding_assignment_bindings VALUES ('offboarding-assignment', 'offboarding-run');
      INSERT INTO personnel_lifecycle_offboarding_run_terminations VALUES ('offboarding-termination', 'offboarding-run', 'enc:v2:termination');
    `);
  } finally {
    database.close();
    database = null;
  }

  try {
    assert.equal(sanitizeSmokeDatabase(databaseFile), true);
    database = new DatabaseSync(databaseFile, { readOnly: true });
    for (const table of lifecycleTables.concat([
      "personnel_lifecycle_case_package_runs",
      "personnel_lifecycle_offboarding_package_runs",
    ])) assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
    assert.deepEqual(
      database.prepare("SELECT id, trigger_type FROM custom_process_runs ORDER BY id").all()
        .map((row) => ({ ...row })),
      [{ id: "operational-run", trigger_type: "manual" }],
    );
    assert.deepEqual(
      database.prepare("SELECT run_id, step_id FROM custom_process_run_steps").all()
        .map((row) => ({ ...row })),
      [{ run_id: "operational-run", step_id: "operational-step" }],
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(database.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]), ["ok"]);
  } finally {
    if (database) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("application smoke rejects orphan personnel workflow runs before sanitizing v0.89 rows", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-smoke-orphan-personnel-run-"));
  const databaseFile = path.join(directory, "dienstplan.db");
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE candidates (
      id TEXT PRIMARY KEY,
      protected_payload TEXT NOT NULL
    );
    CREATE TABLE custom_process_runs (
      id TEXT PRIMARY KEY,
      trigger_type TEXT NOT NULL
    );
    CREATE TABLE custom_process_run_steps (
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      PRIMARY KEY (run_id, step_id)
    );
    CREATE TABLE custom_process_run_bindings (
      run_id TEXT PRIMARY KEY
    );
    CREATE TABLE custom_process_run_step_assignments (
      run_id TEXT NOT NULL
    );
    INSERT INTO candidates VALUES ('candidate-1', 'enc:v2:candidate');
    INSERT INTO custom_process_runs VALUES ('orphan-personnel-run', 'personnel_manual');
    INSERT INTO custom_process_run_steps VALUES ('orphan-personnel-run', 'step-1');
  `);
  database.close();
  try {
    assert.throws(() => sanitizeSmokeDatabase(databaseFile), /SMOKE_PRECONDITION_FAILED/);
    const verify = new DatabaseSync(databaseFile, { readOnly: true });
    assert.deepEqual(
      { ...verify.prepare("SELECT id, protected_payload FROM candidates").get() },
      { id: "candidate-1", protected_payload: "enc:v2:candidate" },
    );
    assert.deepEqual(
      { ...verify.prepare("SELECT id, trigger_type FROM custom_process_runs").get() },
      { id: "orphan-personnel-run", trigger_type: "personnel_manual" },
    );
    assert.deepEqual(
      { ...verify.prepare("SELECT run_id, step_id FROM custom_process_run_steps").get() },
      { run_id: "orphan-personnel-run", step_id: "step-1" },
    );
    verify.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("application smoke rejects a non-empty legacy sickness destination before cleanup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-smoke-legacy-target-"));
  const databaseFile = path.join(directory, "dienstplan.db");
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE sickness_notification_preferences (
      employee_number TEXT,
      protected_destination TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO sickness_notification_preferences
      (employee_number, protected_destination)
    VALUES ('101', 'enc:v2:legacy-destination');
  `);
  database.close();
  try {
    assert.throws(() => sanitizeSmokeDatabase(databaseFile), /SMOKE_PRECONDITION_FAILED/);
    const verify = new DatabaseSync(databaseFile, { readOnly: true });
    assert.equal(
      verify.prepare("SELECT protected_destination FROM sickness_notification_preferences").get()
        .protected_destination,
      "enc:v2:legacy-destination",
    );
    verify.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("application smoke refuses unknown future protected columns before cleanup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-smoke-unknown-"));
  const databaseFile = path.join(directory, "dienstplan.db");
  const database = new DatabaseSync(databaseFile);
  database.exec("CREATE TABLE future_sensitive_domain (id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL); INSERT INTO future_sensitive_domain VALUES ('1', 'enc:v3:future')");
  database.close();
  try {
    assert.throws(() => sanitizeSmokeDatabase(databaseFile), /SMOKE_PRECONDITION_FAILED/);
    const verify = new DatabaseSync(databaseFile, { readOnly: true });
    assert.equal(verify.prepare("SELECT protected_payload FROM future_sensitive_domain").get().protected_payload, "enc:v3:future");
    verify.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("application smoke refuses unknown delete triggers on protected tables before cleanup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-smoke-trigger-"));
  const databaseFile = path.join(directory, "dienstplan.db");
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE privacy_requests (id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL);
    CREATE TRIGGER future_privacy_delete BEFORE DELETE ON privacy_requests
      BEGIN SELECT RAISE(ABORT, 'future delete policy'); END;
    INSERT INTO privacy_requests VALUES ('1', 'enc:v3:future');
  `);
  database.close();
  try {
    assert.throws(() => sanitizeSmokeDatabase(databaseFile), /SMOKE_PRECONDITION_FAILED/);
    const verify = new DatabaseSync(databaseFile, { readOnly: true });
    assert.equal(verify.prepare("SELECT protected_payload FROM privacy_requests").get().protected_payload, "enc:v3:future");
    assert.equal(
      verify.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'future_privacy_delete'").get().count,
      1,
    );
    verify.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("application smoke refuses hard-linked database copies without changing their source", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-smoke-linked-"));
  const source = path.join(directory, "source.db");
  const linked = path.join(directory, "linked.db");
  const database = new DatabaseSync(source);
  database.exec("CREATE TABLE employees (personnel_number TEXT PRIMARY KEY); INSERT INTO employees VALUES ('101')");
  database.close();
  fs.linkSync(source, linked);
  const before = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
  try {
    assert.throws(() => sanitizeSmokeDatabase(linked), /SMOKE_PRECONDITION_FAILED/);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex"), before);
    const verify = new DatabaseSync(source, { readOnly: true });
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM employees").get().count, 1);
    verify.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("application smoke is a private-network, hard-timeout unit without live data or secret access", () => {
  assert.match(smokeUnit, /^User=grabenplaner-offsite$/m);
  assert.equal((smokeUnit.match(/^User=/gm) || []).length, 1);
  assert.doesNotMatch(smokeUnit, /^User=grabenplaner$/m);
  assert.match(smokeUnit, /^Group=grabenplaner-offsite$/m);
  assert.equal((smokeUnit.match(/^Group=/gm) || []).length, 1);
  assert.match(smokeUnit, /^SupplementaryGroups=grabenplaner$/m);
  assert.equal((smokeUnit.match(/^SupplementaryGroups=/gm) || []).length, 1);
  assert.match(smokeUnit, /PrivateNetwork=yes/);
  assert.match(smokeUnit, /IPAddressAllow=localhost/);
  assert.match(smokeUnit, /IPAddressDeny=any/);
  assert.match(smokeUnit, /ProtectSystem=strict/);
  assert.match(smokeUnit, /^ReadOnlyPaths=\/opt\/grabenplaner\/app \/opt\/grabenplaner-offsite\/module$/m);
  assert.equal((smokeUnit.match(/^ReadOnlyPaths=/gm) || []).length, 1);
  assert.match(smokeUnit, /^ReadWritePaths=\/var\/lib\/grabenplaner-offsite\/application-smoke$/m);
  assert.equal((smokeUnit.match(/^ReadWritePaths=/gm) || []).length, 1);
  assert.doesNotMatch(smokeUnit, /^ReadWritePaths=.*(?:\/opt\/grabenplaner\/app|\/var\/log\/grabenplaner)/m);
  assert.match(smokeUnit, /InaccessiblePaths=.*\/etc\/grabenplaner .*\/var\/lib\/grabenplaner .*\/var\/backups\/grabenplaner .*\/var\/log\/grabenplaner/);
  assert.match(smokeUnit, /\/var\/lib\/grabenplaner-offsite\/restore-tests(?:\s|$)/m);
  assert.match(smokeUnit, /\/var\/lib\/grabenplaner-offsite\/uploader-home(?:\s|$)/m);
  assert.match(smokeUnit, /\/var\/lib\/grabenplaner-offsite\/credentials(?:\s|$)/m);
  assert.doesNotMatch(smokeUnit, /\/var\/lib\/grabenplaner-offsite\/rclone-config(?:\s|$)/m);
  assert.doesNotMatch(smokeUnit, /\/var\/lib\/grabenplaner-offsite\/restore-test(?:\s|$)/m);
  assert.match(smokeUnit, /TimeoutStartSec=120s/);
  assert.match(smokeUnit, /RuntimeMaxSec=120s/);
  assert.match(smokeUnit, /KillMode=control-group/);
  assert.match(smokeUnit, /^MemoryHigh=512M$/m);
  assert.match(smokeUnit, /^MemoryMax=768M$/m);
  assert.match(smokeUnit, /^MemorySwapMax=0$/m);
  assert.match(smokeUnit, /^TasksMax=128$/m);
  assert.match(smokeUnit, /^LimitNOFILE=1024$/m);
  assert.match(smokeUnit, /^LimitCORE=0$/m);
  assert.match(smokeUnit, /^CPUQuota=100%$/m);
  assert.match(smokeUnit, /^CPUWeight=10$/m);
  assert.match(smokeUnit, /^IOWeight=10$/m);
  assert.match(smokeUnit, /^Nice=10$/m);
  assert.match(smokeUnit, /^OOMPolicy=stop$/m);
  assert.doesNotMatch(smokeUnit, /Conflicts=grabenplaner\.service/);
});

test("root seals the smoke parent and parses only a bounded descriptor-stable result", () => {
  assert.match(restore, /chown --no-dereference root:root -- "\$OFFSITE_SMOKE_ROOT"/);
  assert.match(restore, /chmod 0500 -- "\$OFFSITE_SMOKE_ROOT"/);
  assert.match(restore, /--verify-result "\$smoke_result" "\$smoke_uid" "\$smoke_gid"/);
  assert.match(applicationSmokeSource, /O_NOFOLLOW/);
  assert.match(applicationSmokeSource, /fs\.lstatSync\(file, \{ bigint: true \}\)/);
  assert.match(applicationSmokeSource, /fs\.fstatSync\(descriptor, \{ bigint: true \}\)/g);
  assert.match(applicationSmokeSource, /before\.size > BigInt\(MAX_RESULT_BYTES\)/);
  assert.doesNotMatch(applicationSmokeSource, /readFileSync\(file/);
  assert.match(restore, /systemctl stop "\$OFFSITE_SMOKE_SERVICE"/);
  assert.match(restore, /rm -rf --one-file-system -- "\$OFFSITE_SMOKE_ROOT"/);
  const assuranceGuard = restore.indexOf('if [[ -n "$assurance_result" ]]');
  const serviceStart = restore.indexOf('systemctl start "$OFFSITE_SMOKE_SERVICE"');
  assert.ok(assuranceGuard >= 0 && serviceStart > assuranceGuard);
});

test("smoke result verifier rejects links and same-inode races without reopening the path", (context) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-smoke-result-"));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const result = path.join(parent, "result.json");
  const payload = `${JSON.stringify({
    format: "grabenplaner-recovery-application-smoke",
    schemaVersion: 1,
    ok: true,
    live: true,
    ready: true,
    reason: null,
  })}\n`;
  fs.writeFileSync(result, payload, { mode: 0o600 });
  fs.chmodSync(result, 0o600);
  const stat = fs.statSync(result);
  const expectedMode = stat.mode & 0o7777;
  const secureOptions = { expectedMode };
  assert.match(applicationSmokeSource, /before\.isSymbolicLink\(\)/);
  assert.match(applicationSmokeSource, /O_NOFOLLOW/);
  assert.equal(verifiedApplicationSmokeResult(result, stat.uid, stat.gid, 0, secureOptions), true);

  const hardlink = path.join(parent, "hardlink.json");
  fs.linkSync(result, hardlink);
  assert.throws(() => verifiedApplicationSmokeResult(result, stat.uid, stat.gid, 0, secureOptions), /SMOKE_RESULT_INVALID/);
  fs.unlinkSync(hardlink);

  const original = path.join(parent, "original.json");
  assert.throws(() => verifiedApplicationSmokeResult(result, stat.uid, stat.gid, 0, {
    expectedMode,
    afterLstat() {
      fs.renameSync(result, original);
      fs.writeFileSync(result, payload, { mode: expectedMode });
      fs.chmodSync(result, expectedMode);
    },
  }), /SMOKE_RESULT_INVALID/);
  fs.unlinkSync(result);
  fs.renameSync(original, result);

  assert.throws(() => verifiedApplicationSmokeResult(result, stat.uid, stat.gid, 0, {
    expectedMode,
    afterRead() {
      fs.writeFileSync(result, payload.replace('"ok":true', '"ok":null'));
      // NTFS can coalesce timestamps for an immediate same-size rewrite.
      fs.utimesSync(result, new Date(0), new Date(0));
    },
  }), /SMOKE_RESULT_INVALID/);
});

test("global assurance lock makes scheduled and manual runs mutually exclusive", () => {
  let systemctlCalls = 0;
  assert.equal(broker.assuranceUnitBusy({
    globalLockBusy: true,
    spawnSync: () => { systemctlCalls += 1; return { status: 0, stdout: "inactive\n" }; },
  }), true);
  assert.equal(systemctlCalls, 0);
  assert.match(read("server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance-control@.service.in"),
    /RuntimeDirectory=grabenplaner-offsite/);
  assert.match(read("server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance-control@.service.in"),
    /RuntimeDirectoryPreserve=yes/);
});

test("new runs sign application-smoke-passed or application-smoke-failed while legacy not-run stays readable", (context) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v078-history-"));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const historyRoot = path.join(parent, "assurance");
  const policy = history.__internalTestOnly.policy;
  const statusGid = typeof process.getgid === "function" ? process.getgid() : 0;
  history.initializeHistory({ root: historyRoot, statusGid, policy });
  const runId = crypto.randomUUID();
  const now = (offset) => new Date(Date.UTC(2026, 6, 22, 1, 0, offset));
  const base = (eventType, offset, extra = {}) => history.appendEvent({
    root: historyRoot, statusGid, policy, runId, eventType, trigger: "scheduled-nightly",
    errorCode: extra.errorCode || null, evidence: extra.evidence || {}, now: now(offset),
  });
  const proof = { snapshotIdPrefix: "a".repeat(12), receiptSha256: "b".repeat(64), appVersion: "0.78.0-beta" };
  base("full-assurance-started", 0);
  base("oauth-policy-passed", 1, { evidence: { appVersion: proof.appVersion } });
  base("backup-passed", 2, { evidence: proof });
  base("repository-check-passed", 3, { evidence: proof });
  base("restore-test-passed", 4, { evidence: proof });
  base("application-smoke-passed", 5, { evidence: proof });
  base("full-assurance-passed", 6, { evidence: proof });
  const inspected = history.inspectHistory({ root: historyRoot, statusGid, policy });
  assert.deepEqual(inspected.events.slice(-2).map((entry) => entry.payload.eventType), [
    "application-smoke-passed", "full-assurance-passed",
  ]);

  const failedRunId = crypto.randomUUID();
  const failed = (eventType, offset, extra = {}) => history.appendEvent({
    root: historyRoot, statusGid, policy, runId: failedRunId, eventType, trigger: "scheduled-nightly",
    errorCode: extra.errorCode || null, evidence: extra.evidence || {}, now: now(10 + offset),
  });
  failed("full-assurance-started", 0);
  failed("oauth-policy-passed", 1, { evidence: { appVersion: proof.appVersion } });
  failed("backup-passed", 2, { evidence: proof });
  failed("repository-check-passed", 3, { evidence: proof });
  failed("restore-test-passed", 4, { evidence: proof });
  failed("application-smoke-failed", 5, { evidence: proof });
  failed("full-assurance-failed", 6, { errorCode: "APPLICATION_SMOKE_FAILED", evidence: proof });
  const afterFailure = history.inspectHistory({ root: historyRoot, statusGid, policy });
  assert.deepEqual(afterFailure.events.slice(-2).map((entry) => entry.payload.eventType), [
    "application-smoke-failed", "full-assurance-failed",
  ]);
  assert.doesNotMatch(assurance, /record_event application-smoke-not-run/);
  assert.match(assurance, /record_event application-smoke-failed/);
  assert.match(assurance, /failure_code="APPLICATION_SMOKE_FAILED"/);
});

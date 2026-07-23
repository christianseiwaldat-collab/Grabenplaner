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
const { childEnvironment, sanitizeSmokeDatabase, SMOKE_ROOT, DATABASE, verifiedApplicationSmokeResult } = require(path.join(
  root, "server-tools/linux/offsite/lib/application-smoke.js",
));
const broker = require(path.join(root, "server-tools/linux/offsite/lib/assurance-control-broker.js"));
const history = require(path.join(root, "server-tools/linux/offsite/lib/assurance-history.js"));

test("v0.78 packages module v4 and migrates only verified v1, v2 or v3 installations", () => {
  assert.equal(schema.moduleVersion, 4);
  for (const relative of [
    "server-tools/linux/offsite/grabenplaner-offsite-application-smoke.sh",
    "server-tools/linux/offsite/lib/application-smoke.js",
    "server-tools/linux/offsite/systemd/grabenplaner-offsite-application-smoke.service.in",
    "server-tools/linux/offsite/systemd/grabenplaner-offsite-assurance.timer.in",
  ]) assert.ok(schema.managedArtifacts.includes(relative), `Fehlt im Modul-v4-Vertrag: ${relative}`);
  assert.match(installer, /\[1, 2, 3, 4\]\.includes\(value\.moduleVersion\)/);
  assert.match(installer, /installed_module_version >= 1 && installed_module_version <= 3/);
  assert.match(installer, /kontrolliert auf v4 migriert/);
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
      CREATE TABLE sickness_notification_preferences (employee_number TEXT, protected_destination TEXT NOT NULL);
      CREATE TABLE outbound_notification_jobs (id TEXT PRIMARY KEY, protected_payload TEXT NOT NULL);
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
      INSERT INTO sickness_notification_preferences VALUES ('101', 'enc:v2:destination');
      INSERT INTO outbound_notification_jobs VALUES ('job', 'enc:v2:job');
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
      "amu_reports", "amu_documents", "sickness_notification_preferences", "outbound_notification_jobs",
      "portal_notifications",
    ]) assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
    assert.deepEqual(
      { ...database.prepare("SELECT id, active, protected_credentials, credential_key_id FROM integration_connections").get() },
      { id: "connection", active: 0, protected_credentials: "", credential_key_id: "" },
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM integration_deliveries").get().count, 1);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(database.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]), ["ok"]);
  } finally {
    if (database) database.close();
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

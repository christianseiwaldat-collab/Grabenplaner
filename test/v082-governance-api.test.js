"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v082-governance-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const {
  app,
  db,
  releaseInstanceLockForTests,
  verifyProtectedGovernanceRecords,
} = require("../server");

const HR = "v082-hr";
const EMPLOYEE = "v082-employee";
const DEACTIVATE = "v082-deactivate";
const MONTH = "2032-04";
const YEAR = 2032;

let httpServer;
let baseUrl;
let hrSession;
let employeeSession;
let locationId;

function ensureEmployee(employeeNumber, fullName) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      active = 1
  `).run(employeeNumber, fullName, fullName.split(" ")[0], locationId);
}

function createSession(employeeNumber, role) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only', role = excluded.role, active = 1,
      must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber,
    crypto.createHash("sha256").update(rawToken).digest("hex"));
  return {
    cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

async function request(route, { method = "GET", session = hrSession, body, accept = "application/json" } = {}) {
  const headers = { Accept: accept };
  if (session) headers.Cookie = session.cookie;
  if (session && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let payload = null;
  if (String(response.headers.get("content-type") || "").includes("application/json")) {
    payload = JSON.parse(buffer.toString("utf8"));
  }
  return { response, payload, buffer };
}

test.before(async () => {
  locationId = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id;
  ensureEmployee(HR, "Hanna Personal");
  ensureEmployee(EMPLOYEE, "Eva Beispiel");
  ensureEmployee(DEACTIVATE, "Dora Historie");
  hrSession = createSession(HR, "hr");
  employeeSession = createSession(EMPLOYEE, "employee");
  createSession(DEACTIVATE, "employee");

  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.82: Aufbewahrung ist belegte Vorschau und führt keine Löschung aus", async () => {
  const policies = await request("/api/privacy-governance/retention");
  assert.equal(policies.response.status, 200, JSON.stringify(policies.payload));
  assert.ok(policies.payload.rules.some((rule) => rule.category === "time_records" && rule.status === "active"));
  assert.match(policies.payload.notice, /keine Löschung/);

  const preview = await request("/api/privacy-governance/retention/preview", {
    method: "POST",
    body: { asOf: "2035-01-01" },
  });
  assert.equal(preview.response.status, 201, JSON.stringify(preview.payload));
  assert.equal(preview.payload.preview.mode, "preview_only");
  assert.equal(preview.payload.preview.automaticExecution, false);
  const stored = db.prepare("SELECT result_json FROM retention_preview_runs WHERE id = ?")
    .get(preview.payload.preview.id);
  assert.match(stored.result_json, /^enc:v2:/);

  const rule = await request("/api/privacy-governance/retention/rules", {
    method: "POST",
    body: {
      schemaVersion: 1,
      id: "retention-test-governance-v1",
      version: "1",
      category: "test_governance_records",
      title: "Testregel für den Admin-Ablauf",
      status: "draft",
      validFrom: "2032-01-01",
      validTo: null,
      sources: [{
        id: "eu-gdpr",
        authority: "Europäische Union",
        title: "Verordnung (EU) 2016/679",
        url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
        jurisdiction: "EU",
        reference: "Art. 5",
      }],
      startTrigger: "record_closed",
      retention: { value: 2, unit: "years" },
      disposition: "manual_review",
      legalHold: { behavior: "exclude_while_active" },
    },
  });
  assert.equal(rule.response.status, 201, JSON.stringify(rule.payload));
  assert.equal(rule.payload.rule.category, "test_governance_records");

  const hold = await request("/api/privacy-governance/retention/holds", {
    method: "POST",
    body: {
      category: "test_governance_records",
      employeeNumber: EMPLOYEE,
      reasonCode: "laufendes_verfahren",
      validFrom: "2032-01-01",
    },
  });
  assert.equal(hold.response.status, 201, JSON.stringify(hold.payload));
  assert.equal(hold.payload.active, true);
  const released = await request(
    `/api/privacy-governance/retention/holds/${encodeURIComponent(hold.payload.id)}/release`,
    { method: "POST", body: {} },
  );
  assert.equal(released.response.status, 200, JSON.stringify(released.payload));
  assert.equal(released.payload.active, false);
});

test("v0.82: Betroffenenanfrage bleibt verschlüsselt, manuell geprüft und exportierbar", async () => {
  const created = await request("/api/portal/v1/self/privacy-requests", {
    method: "POST",
    session: employeeSession,
    body: { type: "access" },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const requestId = created.payload.request.id;
  const stored = db.prepare("SELECT protected_payload FROM privacy_requests WHERE id = ?").get(requestId);
  assert.match(stored.protected_payload, /^enc:v2:/);

  const verified = await request(`/api/privacy-governance/requests/${encodeURIComponent(requestId)}`, {
    method: "PATCH",
    body: { action: "verify_identity" },
  });
  assert.equal(verified.response.status, 200, JSON.stringify(verified.payload));
  assert.equal(verified.payload.request.status, "in_review");

  const approved = await request(`/api/privacy-governance/requests/${encodeURIComponent(requestId)}`, {
    method: "PATCH",
    body: { action: "approve", summary: "Manuell geprüft." },
  });
  assert.equal(approved.response.status, 200, JSON.stringify(approved.payload));
  assert.equal(approved.payload.request.status, "approved");
  const events = db.prepare(`
    SELECT id, protected_payload, previous_receipt_sha256, receipt_sha256
    FROM privacy_request_events WHERE request_id = ? ORDER BY created_at, id
  `).all(requestId);
  assert.deepEqual(events.map((event) => event.id), [
    `${requestId}:event:1`,
    `${requestId}:event:2`,
    `${requestId}:event:3`,
  ]);
  assert.ok(events.every((event) => /^enc:v2:/.test(event.protected_payload)));
  assert.equal(events[1].previous_receipt_sha256, events[0].receipt_sha256);
  assert.equal(events[2].previous_receipt_sha256, events[1].receipt_sha256);

  const governanceExport = await request(
    `/api/privacy-governance/requests/${encodeURIComponent(requestId)}/export`,
  );
  assert.equal(governanceExport.response.status, 200, governanceExport.buffer.toString("utf8"));
  assert.match(governanceExport.response.headers.get("content-disposition") || "", /attachment/);
  assert.equal(JSON.parse(governanceExport.buffer.toString("utf8")).subjectId, EMPLOYEE);

  const exported = await request(`/api/portal/v1/self/privacy-requests/${encodeURIComponent(requestId)}/export`, {
    session: employeeSession,
  });
  assert.equal(exported.response.status, 200, exported.buffer.toString("utf8"));
  const bundle = JSON.parse(exported.buffer.toString("utf8"));
  assert.equal(bundle.subjectId, EMPLOYEE);
  assert.equal(Object.hasOwn(bundle.data, "timeRecords"), true);
  assert.equal(Object.hasOwn(bundle.data, "password_hash"), false);
});

test("v0.82: Selbstservice und Governance-Verwaltung bleiben serverseitig strikt getrennt", async () => {
  const forbidden = await request("/api/privacy-governance/retention", {
    session: employeeSession,
  });
  assert.equal(forbidden.response.status, 403, JSON.stringify(forbidden.payload));

  const createdForHr = await request("/api/privacy-governance/requests", {
    method: "POST",
    body: { employeeNumber: HR, type: "access" },
  });
  assert.equal(createdForHr.response.status, 201, JSON.stringify(createdForHr.payload));
  const foreignId = createdForHr.payload.request.id;

  const foreignExport = await request(
    `/api/portal/v1/self/privacy-requests/${encodeURIComponent(foreignId)}/export`,
    { session: employeeSession },
  );
  assert.equal(foreignExport.response.status, 404, JSON.stringify(foreignExport.payload));

  const forbiddenEntitlement = await request("/api/vacation-entitlements", {
    method: "PUT",
    session: employeeSession,
    body: { year: YEAR, entries: [{ employeeNumber: EMPLOYEE, days: 25 }] },
  });
  assert.equal(forbiddenEntitlement.response.status, 403, JSON.stringify(forbiddenEntitlement.payload));
});

test("v0.82: Datenschutz-State und Ereignis werden bei einem Schreibfehler gemeinsam zurückgerollt", async () => {
  const beforeRequests = db.prepare("SELECT COUNT(*) AS count FROM privacy_requests").get().count;
  const beforeEvents = db.prepare("SELECT COUNT(*) AS count FROM privacy_request_events").get().count;
  db.exec(`
    CREATE TRIGGER test_v082_privacy_event_insert_failure
    BEFORE INSERT ON privacy_request_events
    BEGIN
      SELECT RAISE(ABORT, 'test privacy event failure');
    END
  `);
  let failed;
  try {
    failed = await request("/api/portal/v1/self/privacy-requests", {
      method: "POST",
      session: employeeSession,
      body: { type: "rectification" },
    });
  } finally {
    db.exec("DROP TRIGGER IF EXISTS test_v082_privacy_event_insert_failure");
  }
  assert.ok(failed.response.status >= 400, JSON.stringify(failed.payload));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM privacy_requests").get().count, beforeRequests);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM privacy_request_events").get().count, beforeEvents);
});

test("v0.82: Governance-GETs bleiben strikt lesend", async () => {
  const readOnlyYear = YEAR + 1;
  db.prepare(`
    INSERT INTO vacation_entitlements (employee_number, year, days)
    VALUES (?, ?, 24)
  `).run(EMPLOYEE, readOnlyYear);
  const rulesBefore = db.prepare("SELECT COUNT(*) AS count FROM retention_policy_versions").get().count;
  const accountsBefore = db.prepare("SELECT COUNT(*) AS count FROM vacation_account_revisions").get().count;

  const retention = await request("/api/privacy-governance/retention");
  assert.equal(retention.response.status, 200, JSON.stringify(retention.payload));
  const accounts = await request(`/api/vacation-accounts?year=${readOnlyYear}`);
  assert.equal(accounts.response.status, 200, JSON.stringify(accounts.payload));
  const ownAccount = await request(`/api/portal/v1/self/vacation-account?year=${readOnlyYear}`, {
    session: employeeSession,
  });
  assert.equal(ownAccount.response.status, 200, JSON.stringify(ownAccount.payload));
  assert.equal(ownAccount.payload.account, null);

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM retention_policy_versions").get().count, rulesBefore);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vacation_account_revisions").get().count, accountsBefore);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM vacation_account_revisions
    WHERE employee_number = ? AND leave_year = ?
  `).get(EMPLOYEE, readOnlyYear).count, 0);
});

test("v0.82: Urlaubskonto wird bei Korrekturen nur als neue Revision geschrieben", async () => {
  const first = await request("/api/vacation-entitlements", {
    method: "PUT",
    body: { year: YEAR, entries: [{ employeeNumber: EMPLOYEE, days: 25 }] },
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  const second = await request("/api/vacation-entitlements", {
    method: "PUT",
    body: { year: YEAR, entries: [{ employeeNumber: EMPLOYEE, days: 26 }] },
  });
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  const revisions = db.prepare(`
    SELECT revision, total_days, calculation_json
    FROM vacation_account_revisions
    WHERE employee_number = ? AND leave_year = ? ORDER BY revision
  `).all(EMPLOYEE, YEAR);
  assert.deepEqual(revisions.map(({ revision }) => revision), [1, 2]);
  assert.deepEqual(revisions.map(({ total_days }) => total_days), [25, 26]);
  assert.ok(revisions.every(({ calculation_json }) => /^enc:v2:/.test(calculation_json)));

  const own = await request(`/api/portal/v1/self/vacation-account?year=${YEAR}`, {
    session: employeeSession,
  });
  assert.equal(own.response.status, 200, JSON.stringify(own.payload));
  assert.equal(own.payload.account.totalDays, 26);
  assert.equal(own.payload.account.revision, 2);
  assert.equal(own.payload.account.expiryStatus, "not_due");

  assert.throws(
    () => db.prepare(`
      UPDATE vacation_account_revisions SET total_days = 99
      WHERE employee_number = ? AND leave_year = ?
    `).run(EMPLOYEE, YEAR),
    /immutable|unver|not allowed/i,
  );
});

test("v0.82: Monatsnachweis nutzt nur Ist-Ereignisse und wird revisionssicher finalisiert", async () => {
  db.prepare(`
    INSERT INTO shifts
      (employee_number, location_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, '09:00', '18:00', 'Demo', 'Nur Planwert')
  `).run(HR, locationId, `${MONTH}-08`);
  const plannedOnly = await request("/api/time-record-statements/generate", {
    method: "POST",
    body: { month: MONTH, employeeNumbers: [HR] },
  });
  assert.equal(plannedOnly.response.status, 201, JSON.stringify(plannedOnly.payload));
  assert.equal(plannedOnly.payload.statements.length, 1);
  assert.equal(plannedOnly.payload.statements[0].actualMinutes, 0);

  const insert = db.prepare(`
    INSERT INTO time_entries
      (employee_number, location_id, work_date, entry_type, entry_timestamp, source, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 'portal', ?, ?)
  `);
  for (const [type, time] of [
    ["clock_in", "08:00:00"],
    ["break_start", "12:00:00"],
    ["break_end", "12:30:00"],
    ["clock_out", "16:30:00"],
  ]) {
    const stamp = `${MONTH}-08T${time}.000Z`;
    insert.run(EMPLOYEE, locationId, `${MONTH}-08`, type, stamp, EMPLOYEE, stamp);
  }
  const generated = await request("/api/time-record-statements/generate", {
    method: "POST",
    body: { month: MONTH, employeeNumbers: [EMPLOYEE] },
  });
  assert.equal(generated.response.status, 201, JSON.stringify(generated.payload));
  assert.equal(generated.payload.statements.length, 1);
  assert.equal(generated.payload.statements[0].actualMinutes, 480);
  const draftId = generated.payload.statements[0].id;
  const encrypted = db.prepare("SELECT snapshot_json FROM time_record_statements WHERE id = ?").get(draftId);
  assert.match(encrypted.snapshot_json, /^enc:v2:/);

  const reviewed = await request(`/api/time-record-statements/${encodeURIComponent(draftId)}`, {
    method: "PATCH",
    body: { action: "review", decision: "approved", note: "Ist-Buchungen geprüft." },
  });
  assert.equal(reviewed.response.status, 200, JSON.stringify(reviewed.payload));
  assert.equal(reviewed.payload.statement.status, "reviewed");
  const reviewedId = reviewed.payload.statement.id;

  const finalized = await request(`/api/time-record-statements/${encodeURIComponent(reviewedId)}`, {
    method: "PATCH",
    body: { action: "finalize" },
  });
  assert.equal(finalized.response.status, 200, JSON.stringify(finalized.payload));
  assert.equal(finalized.payload.statement.status, "finalized");

  const own = await request(`/api/portal/v1/self/time-record-statements?month=${MONTH}`, {
    session: employeeSession,
  });
  assert.equal(own.response.status, 200, JSON.stringify(own.payload));
  assert.equal(own.payload.statements.length, 1);
  assert.equal(own.payload.statements[0].downloadAvailable, true);

  const pdf = await request(`/api/portal/v1/self/time-record-statements/${encodeURIComponent(finalized.payload.statement.id)}/download`, {
    session: employeeSession,
    accept: "application/pdf",
  });
  assert.equal(pdf.response.status, 200, pdf.buffer.toString("utf8"));
  assert.equal(pdf.buffer.subarray(0, 4).toString("ascii"), "%PDF");

  const laterStamp = `${MONTH}-09T08:00:00.000Z`;
  insert.run(EMPLOYEE, locationId, `${MONTH}-09`, "clock_in", laterStamp, EMPLOYEE, laterStamp);
  const regenerated = await request("/api/time-record-statements/generate", {
    method: "POST",
    body: { month: MONTH, employeeNumbers: [EMPLOYEE] },
  });
  assert.equal(regenerated.response.status, 201, JSON.stringify(regenerated.payload));
  assert.equal(regenerated.payload.statements.length, 1);
  const latestId = regenerated.payload.statements[0].id;
  assert.notEqual(latestId, finalized.payload.statement.id);

  const currentOnly = await request(`/api/time-record-statements?month=${MONTH}`);
  assert.equal(currentOnly.response.status, 200, JSON.stringify(currentOnly.payload));
  const currentEmployee = currentOnly.payload.statements
    .filter((statement) => statement.employeeNumber === EMPLOYEE);
  assert.equal(currentEmployee.length, 1);
  assert.equal(currentEmployee[0].id, latestId);
  assert.equal(currentEmployee[0].archived, false);

  const includingArchive = await request(`/api/time-record-statements?month=${MONTH}&includeArchived=1`);
  assert.equal(includingArchive.response.status, 200, JSON.stringify(includingArchive.payload));
  const employeeRevisions = includingArchive.payload.statements
    .filter((statement) => statement.employeeNumber === EMPLOYEE);
  assert.equal(employeeRevisions.length, 4);
  assert.equal(employeeRevisions.filter((statement) => statement.archived).length, 3);
  assert.equal(employeeRevisions.find((statement) => statement.id === finalized.payload.statement.id).archiveStatus, "archived");

  const supersedeEvents = db.prepare(`
    SELECT statement_id, detail_json
    FROM time_record_statement_events
    WHERE event_type = 'superseded'
    ORDER BY created_at, id
  `).all().filter((event) => JSON.parse(event.detail_json).supersededByStatementId);
  assert.ok(supersedeEvents.some((event) => (
    event.statement_id === finalized.payload.statement.id
    && JSON.parse(event.detail_json).supersededByStatementId === latestId
  )));

  const archivedDefaultDownload = await request(
    `/api/time-record-statements/${encodeURIComponent(finalized.payload.statement.id)}/download`,
    { accept: "application/pdf" },
  );
  assert.equal(archivedDefaultDownload.response.status, 409);
  const archivedExplicitDownload = await request(
    `/api/time-record-statements/${encodeURIComponent(finalized.payload.statement.id)}/download?includeArchived=1`,
    { accept: "application/pdf" },
  );
  assert.equal(archivedExplicitDownload.response.status, 200, archivedExplicitDownload.buffer.toString("utf8"));
  assert.equal(archivedExplicitDownload.response.headers.get("x-grabenplaner-record-state"), "archived");

  const ownCurrentFinalized = await request(`/api/portal/v1/self/time-record-statements?month=${MONTH}`, {
    session: employeeSession,
  });
  assert.equal(ownCurrentFinalized.response.status, 200, JSON.stringify(ownCurrentFinalized.payload));
  assert.equal(ownCurrentFinalized.payload.statements.length, 0);
  const ownArchivedDownload = await request(
    `/api/portal/v1/self/time-record-statements/${encodeURIComponent(finalized.payload.statement.id)}/download`,
    { session: employeeSession, accept: "application/pdf" },
  );
  assert.equal(ownArchivedDownload.response.status, 409);
});

test("v0.82: Hilfsereignisse werden gegen ihre geschützten Revisionen geprüft", () => {
  assert.ok(verifyProtectedGovernanceRecords() > 0);

  const vacationEvent = db.prepare(`
    SELECT id, detail_json FROM vacation_account_events
    WHERE employee_number = ? AND leave_year = ?
    ORDER BY created_at, id LIMIT 1
  `).get(EMPLOYEE, YEAR);
  assert.ok(vacationEvent);
  db.exec("DROP TRIGGER trg_vacation_account_events_immutable_update");
  try {
    db.prepare("UPDATE vacation_account_events SET detail_json = '{}' WHERE id = ?")
      .run(vacationEvent.id);
    assert.throws(
      () => verifyProtectedGovernanceRecords(),
      { code: "VACATION_ACCOUNT_EVENT_INTEGRITY_FAILED" },
    );
  } finally {
    db.prepare("UPDATE vacation_account_events SET detail_json = ? WHERE id = ?")
      .run(vacationEvent.detail_json, vacationEvent.id);
    db.exec(`
      CREATE TRIGGER trg_vacation_account_events_immutable_update
      BEFORE UPDATE ON vacation_account_events
      BEGIN
        SELECT RAISE(ABORT, 'vacation account events are immutable');
      END
    `);
  }

  const timeEvent = db.prepare(`
    SELECT id, detail_json FROM time_record_statement_events
    ORDER BY created_at, id LIMIT 1
  `).get();
  assert.ok(timeEvent);
  db.exec("DROP TRIGGER trg_time_record_statement_events_immutable_update");
  try {
    db.prepare("UPDATE time_record_statement_events SET detail_json = '{}' WHERE id = ?")
      .run(timeEvent.id);
    assert.throws(
      () => verifyProtectedGovernanceRecords(),
      { code: "TIME_RECORD_STATEMENT_EVENT_INTEGRITY_FAILED" },
    );
  } finally {
    db.prepare("UPDATE time_record_statement_events SET detail_json = ? WHERE id = ?")
      .run(timeEvent.detail_json, timeEvent.id);
    db.exec(`
      CREATE TRIGGER trg_time_record_statement_events_immutable_update
      BEFORE UPDATE ON time_record_statement_events
      BEGIN
        SELECT RAISE(ABORT, 'time record statement events are immutable');
      END
    `);
  }
  assert.ok(verifyProtectedGovernanceRecords() > 0);
});

test("v0.82: Teammitglied löschen deaktiviert den Zugang und erhält die Historie", async () => {
  db.prepare(`
    INSERT INTO vacation_entitlements (employee_number, year, days)
    VALUES (?, ?, 25)
  `).run(DEACTIVATE, YEAR);
  const removed = await request(`/api/employees/${DEACTIVATE}`, { method: "DELETE" });
  assert.equal(removed.response.status, 204, removed.buffer.toString("utf8"));
  assert.equal(db.prepare("SELECT active FROM employees WHERE personnel_number = ?").get(DEACTIVATE).active, 0);
  assert.equal(db.prepare("SELECT days FROM vacation_entitlements WHERE employee_number = ? AND year = ?")
    .get(DEACTIVATE, YEAR).days, 25);
  assert.equal(db.prepare("SELECT active FROM portal_users WHERE employee_number = ?").get(DEACTIVATE).active, 0);
});

test("v0.82: Eine Lücke im unveränderlichen Datenschutzverlauf wird beim Lesen erkannt", async () => {
  const created = await request("/api/portal/v1/self/privacy-requests", {
    method: "POST",
    session: employeeSession,
    body: { type: "portability" },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const requestId = created.payload.request.id;
  db.exec("DROP TRIGGER trg_privacy_request_events_immutable_delete");
  try {
    db.prepare("DELETE FROM privacy_request_events WHERE request_id = ?").run(requestId);
  } finally {
    db.exec(`
      CREATE TRIGGER trg_privacy_request_events_immutable_delete
      BEFORE DELETE ON privacy_request_events
      BEGIN
        SELECT RAISE(ABORT, 'privacy request events are immutable');
      END
    `);
  }
  const corrupted = await request(`/api/privacy-governance/requests/${encodeURIComponent(requestId)}`);
  assert.equal(corrupted.response.status, 503, JSON.stringify(corrupted.payload));
  assert.equal(corrupted.payload.code, "INTERNAL_ERROR");
});

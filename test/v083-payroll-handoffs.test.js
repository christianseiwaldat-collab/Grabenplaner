"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  PAYROLL_HANDOFF_SCHEMA_VERSION,
  createPayrollHandoff,
  createPayrollHandoffEvent,
  derivePayrollHandoffState,
  verifyPayrollHandoff,
  verifyPayrollHandoffEvent,
} = require("../lib/payroll-handoffs");

test("v0.83: Monatsübergaben enthalten nur finalisierte Ist-Nachweise und sind stabil belegt", () => {
  const handoff = createPayrollHandoff({
    handoffId: "payroll-handoff:2033-05:18:all:r1",
    month: "2033-05",
    revision: 1,
    createdAt: "2033-06-01T08:00:00.000Z",
    createdBy: "101",
    scope: { locationId: "18", departmentId: "" },
    statements: [{
      employeeId: "007",
      statementId: "time-statement:007:2033-05:r3",
      statementRevision: 3,
      statementReceiptSha256: "a".repeat(64),
      actualMinutes: 9600,
      breakMinutes: 600,
      status: "finalized",
    }],
    previousReceiptSha256: null,
  });
  assert.equal(handoff.schemaVersion, PAYROLL_HANDOFF_SCHEMA_VERSION);
  assert.equal(handoff.totals.actualMinutes, 9600);
  assert.equal(verifyPayrollHandoff(handoff), true);
  assert.equal("fullName" in handoff.statements[0], false);
  assert.equal("plannedMinutes" in handoff.statements[0], false);
  assert.throws(
    () => createPayrollHandoff({
      handoffId: "draft",
      month: "2033-05",
      revision: 1,
      createdAt: "2033-06-01T08:00:00.000Z",
      createdBy: "101",
      scope: { locationId: "18", departmentId: "" },
      statements: [{
        employeeId: "007",
        statementId: "draft",
        statementRevision: 1,
        statementReceiptSha256: "b".repeat(64),
        actualMinutes: 1,
        breakMinutes: 0,
        status: "draft",
      }],
      previousReceiptSha256: null,
    }),
    { code: "PAYROLL_HANDOFF_FINAL_STATEMENTS_REQUIRED" },
  );
});

test("v0.83: Ohne externes Protokoll bleibt die Übergabe offen; W und N bleiben unterscheidbar", () => {
  const base = {
    handoffId: "handoff",
    actorId: "101",
    handoffReceiptSha256: "c".repeat(64),
  };
  const events = [
    createPayrollHandoffEvent({
      ...base,
      eventId: "event-created",
      eventType: "created",
      occurredAt: "2033-06-01T08:00:00.000Z",
      note: "",
    }),
    createPayrollHandoffEvent({
      ...base,
      eventId: "event-exported",
      eventType: "exported",
      occurredAt: "2033-06-01T08:01:00.000Z",
      note: "",
    }),
  ];
  assert.ok(events.every(verifyPayrollHandoffEvent));
  assert.equal(derivePayrollHandoffState(events), "external_transfer_required");
  events.push(createPayrollHandoffEvent({
    ...base,
    eventId: "event-transferred",
    eventType: "external_transfer_marked",
    occurredAt: "2033-06-01T08:02:00.000Z",
    note: "",
  }));
  assert.equal(derivePayrollHandoffState(events), "protocol_pending");
  const warning = createPayrollHandoffEvent({
    ...base,
    eventId: "event-protocol",
    eventType: "protocol_recorded",
    occurredAt: "2033-06-01T08:03:00.000Z",
    protocolResult: "warning",
    protocolNumber: "ELDA-2033-4711",
    note: "Status W laut externem Protokoll.",
  });
  assert.equal(derivePayrollHandoffState([...events, warning]), "accepted_with_warning");
  const rejected = createPayrollHandoffEvent({
    ...base,
    eventId: "event-protocol-n",
    eventType: "protocol_recorded",
    occurredAt: "2033-06-01T08:04:00.000Z",
    protocolResult: "not_accepted",
    protocolNumber: "ELDA-2033-4712",
    note: "Status N.",
  });
  assert.equal(derivePayrollHandoffState([...events, rejected]), "correction_required");
});

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v083-payroll-handoffs-"));
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

const HR = "v083-hr";
const EMPLOYEE = "v083-employee";
const MONTH = "2033-05";
let httpServer;
let baseUrl;
let hrSession;
let employeeSession;
let locationId;

function ensureEmployee(employeeNumber, fullName, active) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      active = excluded.active
  `).run(employeeNumber, fullName, fullName.split(" ")[0], locationId, active ? 1 : 0);
}

function createSession(employeeNumber, role) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET role = excluded.role, active = 1,
      must_change_password = 0, updated_at = CURRENT_TIMESTAMP
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

async function request(route, { method = "GET", session = hrSession, body } = {}) {
  const headers = { Accept: "application/json" };
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
  db.prepare("UPDATE employees SET active = 0").run();
  ensureEmployee(HR, "Hanna Personal", false);
  ensureEmployee(EMPLOYEE, "Eva Beispiel", true);
  hrSession = createSession(HR, "hr");
  employeeSession = createSession(EMPLOYEE, "employee");
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

test("v0.83: API erzwingt Finalisierung, protokolliert Übergabe und verschlüsselt Belege", async () => {
  const blocked = await request("/api/integrations/payroll-handoffs/preflight", {
    method: "POST",
    body: { month: MONTH, locationId, departmentId: null },
  });
  assert.equal(blocked.response.status, 200, JSON.stringify(blocked.payload));
  assert.equal(blocked.payload.blockers[0].code, "MONTHLY_STATEMENT_MISSING");

  const insert = db.prepare(`
    INSERT INTO time_entries
      (employee_number, location_id, work_date, entry_type, entry_timestamp, source, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 'portal', ?, ?)
  `);
  for (const [type, time] of [["clock_in", "08:00:00"], ["clock_out", "16:00:00"]]) {
    const stamp = `${MONTH}-08T${time}.000Z`;
    insert.run(EMPLOYEE, locationId, `${MONTH}-08`, type, stamp, EMPLOYEE, stamp);
  }
  const generated = await request("/api/time-record-statements/generate", {
    method: "POST",
    body: { month: MONTH, employeeNumbers: [EMPLOYEE] },
  });
  assert.equal(generated.response.status, 201, JSON.stringify(generated.payload));
  const reviewed = await request(`/api/time-record-statements/${encodeURIComponent(generated.payload.statements[0].id)}`, {
    method: "PATCH",
    body: { action: "review", decision: "approved", note: "Geprüft." },
  });
  const finalized = await request(`/api/time-record-statements/${encodeURIComponent(reviewed.payload.statement.id)}`, {
    method: "PATCH",
    body: { action: "finalize" },
  });
  assert.equal(finalized.payload.statement.status, "finalized");

  const ready = await request("/api/integrations/payroll-handoffs/preflight", {
    method: "POST",
    body: { month: MONTH, locationId, departmentId: null },
  });
  assert.equal(ready.response.status, 200, JSON.stringify(ready.payload));
  assert.equal(ready.payload.blockers.length, 0);
  assert.equal(ready.payload.finalizedCount, 1);

  const denied = await request("/api/integrations/payroll-handoffs", {
    method: "POST",
    session: employeeSession,
    body: { month: MONTH, locationId, departmentId: null, fingerprint: ready.payload.fingerprint },
  });
  assert.equal(denied.response.status, 403);

  const created = await request("/api/integrations/payroll-handoffs", {
    method: "POST",
    body: { month: MONTH, locationId, departmentId: null, fingerprint: ready.payload.fingerprint },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.handoff.state, "prepared");
  const handoffId = created.payload.handoff.id;
  db.prepare(`
    INSERT OR IGNORE INTO portal_permission_grants
      (employee_number, permission, granted_by, updated_at)
    VALUES (?, 'payroll:export', ?, CURRENT_TIMESTAMP)
  `).run(EMPLOYEE, HR);
  db.prepare(`
    INSERT OR IGNORE INTO portal_access_scopes
      (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, ?)
  `).run(EMPLOYEE, locationId, HR);
  const delegatedList = await request(
    `/api/integrations/payroll-handoffs?month=${MONTH}&locationId=${encodeURIComponent(locationId)}`,
    { session: employeeSession },
  );
  assert.equal(delegatedList.response.status, 200, JSON.stringify(delegatedList.payload));
  assert.equal(delegatedList.payload.handoffs[0].id, handoffId);
  const stored = db.prepare("SELECT payload_json FROM payroll_handoffs WHERE id = ?").get(handoffId);
  assert.match(stored.payload_json, /^enc:v2:/);
  assert.throws(
    () => db.prepare("UPDATE payroll_handoffs SET revision = 99 WHERE id = ?").run(handoffId),
    /immutable/i,
  );

  const exported = await request(`/api/integrations/payroll-handoffs/${encodeURIComponent(handoffId)}/file`);
  assert.equal(exported.response.status, 200);
  const document = JSON.parse(exported.buffer.toString("utf8"));
  assert.equal(document.contract, PAYROLL_HANDOFF_SCHEMA_VERSION);
  assert.equal(document.handoff.statements[0].employeeId, EMPLOYEE);
  assert.equal("fullName" in document.handoff.statements[0], false);

  const transferred = await request(`/api/integrations/payroll-handoffs/${encodeURIComponent(handoffId)}/events`, {
    method: "POST",
    body: { action: "mark_external_transfer" },
  });
  assert.equal(transferred.payload.handoff.state, "protocol_pending");
  const protocol = await request(`/api/integrations/payroll-handoffs/${encodeURIComponent(handoffId)}/events`, {
    method: "POST",
    body: {
      action: "record_protocol",
      protocolResult: "warning",
      protocolNumber: "ELDA-TEST-W-1",
      note: "Warnung extern geprüft.",
    },
  });
  assert.equal(protocol.payload.handoff.state, "accepted_with_warning");
  assert.equal(protocol.payload.handoff.protocolNumber, "ELDA-TEST-W-1");
  assert.ok(db.prepare("SELECT payload_json FROM payroll_handoff_events WHERE event_type = 'protocol_recorded'").get().payload_json.startsWith("enc:v2:"));
  assert.ok(verifyProtectedGovernanceRecords() > 0);
});

test("v0.83: Vertrag und UI benennen die Grenze zur externen ELDA-Übermittlung", () => {
  const contracts = require("../lib/integration-contracts");
  const contract = contracts.contractById(contracts.CONTRACT_IDS.payrollPeriodHandoff);
  assert.equal(contract.evidenceRequirements.directEldaTransmission, false);
  assert.equal(contract.evidenceRequirements.externalProtocolRequiredForCompletion, true);
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const client = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(html, /Monatsübergaben &amp; externe Protokolle/);
  assert.match(html, /mBGM gilt erst nach externer ELDA-Übermittlung/);
  assert.match(client, /protocol_pending/);
  assert.match(client, /data-payroll-handoff-protocol/);
});

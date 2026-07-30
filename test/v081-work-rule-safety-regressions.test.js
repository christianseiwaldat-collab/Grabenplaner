"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v081-rule-safety-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const {
  app,
  db,
  ensureWorkRuleEvaluationReceiptIntegrity,
  initializeApplicationPersistence,
  releaseInstanceLockForTests,
  workRuleStoreRepository,
} = subject;
const { canonicalSha256 } = require("../lib/work-rules");
const { getWorkRuleEvaluation } = require("../lib/work-rules/store");

const ADMIN = "v081-safety-admin";
const NO_RULE_READ = "v081-no-rule-read";
const SCOPED_MANAGER = "v081-scoped-manager";
const HISTORICAL_EMPLOYEE = "v081-historical";
const FOREIGN_EMPLOYEE = "v081-foreign";
const SWITCH_EMPLOYEE = "v081-switch";
const ATOMIC_EMPLOYEE = "v081-atomic";

const HISTORICAL_WEEK = "2032-07-05";
const SWITCH_WEEK = "2032-08-02";
const ATOMIC_WEEK = "2033-08-01";

let httpServer;
let baseUrl;
let mainLocationId;
let foreignLocationId;
let mainCostCenterId;
let foreignCostCenterId;
let adminSession;
let employeeSession;
let managerSession;

function insertEmployee(personnelNumber, name, locationId, costCenterId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id, cost_center_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, 1)
  `).run(personnelNumber, name, name.split(" ")[0], locationId, costCenterId || null);
}

function createSession(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return {
    cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

async function request(route, { method = "GET", body, session = adminSession } = {}) {
  const headers = {
    Accept: "application/json",
    Cookie: session.cookie,
  };
  if (!["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { response, payload };
}

function uniqueLocationId() {
  for (let id = 80; id <= 98; id += 1) {
    const candidate = String(id);
    if (!db.prepare("SELECT 1 FROM locations WHERE id = ?").get(candidate)) return candidate;
  }
  throw new Error("Kein freier Test-Standort gefunden.");
}

function insertProfileVersion(version, {
  normalDailyMinutes = 9 * 60,
  normalWeeklyMinutes = 44 * 60,
  validFrom = "2031-01-01",
  validTo = "2099-12-31",
} = {}) {
  const source = db.prepare(`
    SELECT rules_json, sources_json
    FROM work_rule_profile_versions
    WHERE id = 'at-retail-adult-monitor@2026.1'
  `).get();
  const storedRules = JSON.parse(source.rules_json);
  storedRules.schemaVersion = 2;
  storedRules.title = `Historisches Testprofil ${version}`;
  storedRules.status = "active";
  storedRules.assignable = true;
  storedRules.defaultEnforcementMode = "monitor";
  storedRules.limits.normalDailyMinutes = normalDailyMinutes;
  storedRules.limits.normalWeeklyMinutes = normalWeeklyMinutes;
  storedRules.validFrom = validFrom;
  storedRules.validTo = validTo;
  const id = `at-retail-adult-monitor@${version}`;
  const snapshot = {
    schemaVersion: storedRules.schemaVersion,
    catalogVersion: storedRules.catalogVersion,
    profileId: "at-retail-adult-monitor",
    version,
    title: storedRules.title,
    status: storedRules.status,
    assignable: storedRules.assignable,
    validFrom,
    validTo,
    defaultEnforcementMode: storedRules.defaultEnforcementMode,
    applicability: storedRules.applicability,
    limits: storedRules.limits,
    ruleIds: storedRules.ruleIds,
    rules: storedRules.rules,
    sources: JSON.parse(source.sources_json),
  };
  db.prepare(`
    INSERT INTO work_rule_profile_versions
      (id, profile_id, version, layer, status, valid_from, valid_to,
       rules_json, sources_json, content_sha256, created_by, published_at)
    VALUES (?, 'at-retail-adult-monitor', ?, 'sector', 'published', ?, ?,
      ?, ?, ?, 'regression-test', CURRENT_TIMESTAMP)
  `).run(
    id,
    version,
    validFrom,
    validTo,
    JSON.stringify(storedRules),
    source.sources_json,
    canonicalSha256(snapshot),
  );
  return id;
}

function insertEmployeeAssignment({
  id,
  employeeNumber,
  profileVersionId,
  validFrom,
  validTo = null,
  enforcementMode = "enforced",
}) {
  db.prepare(`
    INSERT INTO work_rule_assignments
      (id, profile_version_id, scope_type, scope_key, valid_from, valid_to,
       enforcement_mode, applicability_confirmed, confirmed_by, confirmed_at,
       active, created_by)
    VALUES (?, ?, 'employee', ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, 1, ?)
  `).run(
    id,
    profileVersionId,
    employeeNumber,
    validFrom,
    validTo,
    enforcementMode,
    ADMIN,
    ADMIN,
  );
}

function insertShift(employeeNumber, date, locationId, startTime = "09:00", endTime = "18:00", note = "") {
  return Number(db.prepare(`
    INSERT INTO shifts
      (employee_number, location_id, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, NULL, ?, ?, ?, 'Regeltest', ?)
  `).run(employeeNumber, locationId, date, startTime, endTime, note).lastInsertRowid);
}

function insertEvaluationRun(id, receiptSha256 = canonicalSha256({ receipt: id })) {
  const result = {
    engineVersion: "regression-fixture",
    basis: "planned_schedule",
    summary: { state: "pass" },
    findings: [],
  };
  db.prepare(`
    INSERT INTO work_rule_evaluation_runs
      (id, target_type, scope_type, scope_key, period_from, period_to,
       profile_version_ids_json, input_sha256, result_sha256, result_json,
       receipt_sha256, outcome, created_by)
    VALUES (?, 'planned_schedule', 'location', ?, '2032-07-05', '2032-07-11',
      ?, ?, ?, ?, ?, 'pass', ?)
  `).run(
    id,
    mainLocationId,
    JSON.stringify(["at-retail-adult-monitor@2026.1"]),
    canonicalSha256({ fixture: id }),
    canonicalSha256(result),
    JSON.stringify(result),
    receiptSha256,
    ADMIN,
  );
}

test.before(async () => {
  await initializeApplicationPersistence();
  const mainLocation = db.prepare(`
    SELECT id, cost_center_id FROM locations WHERE active = 1 ORDER BY id LIMIT 1
  `).get();
  mainLocationId = mainLocation.id;
  mainCostCenterId = mainLocation.cost_center_id || null;
  foreignLocationId = uniqueLocationId();
  foreignCostCenterId = `cc-v081-${foreignLocationId}`;
  db.prepare(`
    INSERT INTO cost_centers
      (id, code, name, type, cost_center_type_id, active, sort_order)
    VALUES (?, ?, 'Regeltest Fremdfiliale', 'branch', 'branch', 1, 900)
  `).run(foreignCostCenterId, `V081-${foreignLocationId}`);
  db.prepare(`
    INSERT INTO locations (id, name, cost_center_id, min_staff, day_settings_json, active)
    VALUES (?, 'Regeltest Fremdfiliale', ?, 1, '', 1)
  `).run(foreignLocationId, foreignCostCenterId);

  insertEmployee(ADMIN, "Ada Regelsicherheit", mainLocationId, mainCostCenterId);
  insertEmployee(NO_RULE_READ, "Emil Ohne Regelrecht", mainLocationId, mainCostCenterId);
  insertEmployee(SCOPED_MANAGER, "Mara Bereichsleitung", mainLocationId, mainCostCenterId);
  insertEmployee(HISTORICAL_EMPLOYEE, "Hanna Historie", mainLocationId, mainCostCenterId);
  insertEmployee(FOREIGN_EMPLOYEE, "Franz Fremdfiliale", foreignLocationId, foreignCostCenterId);
  insertEmployee(SWITCH_EMPLOYEE, "Wera Profilwechsel", mainLocationId, mainCostCenterId);
  insertEmployee(ATOMIC_EMPLOYEE, "Toni Transaktion", mainLocationId, mainCostCenterId);

  adminSession = createSession(ADMIN, "admin");
  employeeSession = createSession(NO_RULE_READ, "manager");
  managerSession = createSession(SCOPED_MANAGER, "manager");
  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, 'work_rules:read', ?)
  `).run(NO_RULE_READ, ADMIN);
  db.prepare(`
    INSERT INTO portal_access_scopes
      (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, ?)
  `).run(SCOPED_MANAGER, mainLocationId, ADMIN);
  db.prepare(`
    INSERT INTO portal_access_scopes
      (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, ?)
  `).run(NO_RULE_READ, mainLocationId, ADMIN);

  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try {
    db.close();
  } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Regression: Eine historisch zugewiesene Profilversion liefert ihre eigene Version und Grenzwerte", async () => {
  const historicalVersion = insertProfileVersion("2031.1", {
    normalDailyMinutes: 8 * 60,
    validFrom: "2031-01-01",
    validTo: "2032-12-31",
  });
  insertEmployeeAssignment({
    id: "regression-historical-version",
    employeeNumber: HISTORICAL_EMPLOYEE,
    profileVersionId: historicalVersion,
    validFrom: "2032-01-01",
    validTo: "2032-12-31",
  });
  insertShift(HISTORICAL_EMPLOYEE, HISTORICAL_WEEK, mainLocationId);

  const evaluated = await request(`/api/schedule?week=${HISTORICAL_WEEK}&location=${encodeURIComponent(mainLocationId)}`);
  assert.equal(evaluated.response.status, 200, JSON.stringify(evaluated.payload));
  const usedProfile = evaluated.payload.workRuleAssessment.profiles
    .find((profile) => profile.versionId === historicalVersion);
  assert.ok(usedProfile, `Profilversion ${historicalVersion} fehlt.`);
  assert.equal(usedProfile.version, "2031.1", "Metadaten dürfen nicht von der aktuellen Profilfassung stammen.");
  const dailyFinding = evaluated.payload.workRuleAssessment.findings.find((finding) => (
    finding.employeeNumber === HISTORICAL_EMPLOYEE
      && finding.ruleId === "at.azg.normal.daily"
      && finding.scope?.date === HISTORICAL_WEEK
  ));
  assert.ok(dailyFinding, "Der historische Tagesgrenzwert muss einen nachvollziehbaren Befund erzeugen.");
  assert.equal(dailyFinding.evidence.threshold, 8 * 60);
  assert.equal(dailyFinding.evidence.conditionalResult ?? dailyFinding.resultState, "fail");
});

test("Regression: Ein filialfremdes neues Teammitglied wird bereits in der Candidate-Prüfung bewertet", async () => {
  const evaluated = await request("/api/work-rules/evaluate", {
    method: "POST",
    body: {
      targetType: "planned_schedule",
      weekStart: HISTORICAL_WEEK,
      locationId: mainLocationId,
      candidateShift: {
        employeeNumber: FOREIGN_EMPLOYEE,
        locationId: mainLocationId,
        departmentId: "",
        date: HISTORICAL_WEEK,
        startTime: "09:00",
        endTime: "18:00",
        area: "Aushilfe",
        note: "",
      },
    },
  });
  assert.equal(evaluated.response.status, 200, JSON.stringify(evaluated.payload));
  assert.ok(evaluated.payload.findings.some((finding) => finding.employeeNumber === FOREIGN_EMPLOYEE),
    "Das neu hinzukommende Teammitglied darf nicht aus der Regelprüfung herausfallen.");
});

test("Regression: Profilwechsel innerhalb einer Woche werden pro Diensttag statt rückwirkend ab Wochenbeginn ausgewertet", async () => {
  const firstVersion = insertProfileVersion("2032.first", {
    normalDailyMinutes: 8 * 60,
    normalWeeklyMinutes: 10 * 60,
    validFrom: "2032-01-01",
  });
  const secondVersion = insertProfileVersion("2032.second", {
    normalDailyMinutes: 9 * 60,
    validFrom: "2032-01-01",
  });
  insertEmployeeAssignment({
    id: "regression-dated-first",
    employeeNumber: SWITCH_EMPLOYEE,
    profileVersionId: firstVersion,
    validFrom: SWITCH_WEEK,
    validTo: "2032-08-03",
  });
  insertEmployeeAssignment({
    id: "regression-dated-second",
    employeeNumber: SWITCH_EMPLOYEE,
    profileVersionId: secondVersion,
    validFrom: "2032-08-04",
  });
  insertShift(SWITCH_EMPLOYEE, SWITCH_WEEK, mainLocationId);
  insertShift(SWITCH_EMPLOYEE, "2032-08-05", mainLocationId);

  const evaluated = await request(`/api/schedule?week=${SWITCH_WEEK}&location=${encodeURIComponent(mainLocationId)}`);
  assert.equal(evaluated.response.status, 200, JSON.stringify(evaluated.payload));
  const usedVersions = new Set(evaluated.payload.workRuleAssessment.profiles.map((profile) => profile.versionId));
  assert.ok(usedVersions.has(firstVersion), "Für den Montagsdienst fehlt die bis Dienstag gültige Fassung.");
  assert.ok(usedVersions.has(secondVersion), "Für den Donnerstagsdienst fehlt die ab Mittwoch gültige Fassung.");
  assert.equal(
    evaluated.payload.workRuleAssessment.findings.some((finding) => (
      finding.employeeNumber === SWITCH_EMPLOYEE
      && finding.ruleId === "at.azg.normal.weekly"
      && (finding.evidence?.conditionalResult ?? finding.resultState) === "fail"
    )),
    false,
    "Die bis Dienstag geltende Wochenregel darf den Dienst ab Mittwoch nicht rückwirkend mitzählen.",
  );
  assert.ok(
    evaluated.payload.workRuleAssessment.findings.some((finding) => (
      finding.employeeNumber === SWITCH_EMPLOYEE
      && finding.ruleId === "at.system.profile-boundary"
      && finding.state === "manual_review"
    )),
    "Nicht sicher kombinierbare Wochen-, Durchschnitts- und Ruhezeitgrenzen müssen sichtbar manuell geprüft werden.",
  );
});

test("Regression: Dienstmutation und Evaluationsbeleg werden atomar zurückgerollt", async () => {
  const note = `atomic-${crypto.randomUUID()}`;
  let receiptInsertAttempts = 0;
  db.function("regression_receipt_attempt", () => {
    receiptInsertAttempts += 1;
    return 1;
  });
  const shiftCountBefore = db.prepare("SELECT COUNT(*) AS count FROM shifts WHERE note = ?").get(note).count;
  const receiptCountBefore = db.prepare("SELECT COUNT(*) AS count FROM work_rule_evaluation_runs").get().count;
  db.exec(`
    CREATE TRIGGER regression_reject_evaluation_insert
    BEFORE INSERT ON work_rule_evaluation_runs
    BEGIN
      SELECT regression_receipt_attempt();
      SELECT RAISE(ABORT, 'regression: evaluation receipt rejected');
    END;
  `);
  try {
    const created = await request("/api/shifts", {
      method: "POST",
      body: {
        employeeNumber: ATOMIC_EMPLOYEE,
        locationId: mainLocationId,
        departmentId: "",
        date: ATOMIC_WEEK,
        startTime: "09:00",
        endTime: "18:00",
        area: "Transaktionstest",
        note,
      },
    });
    assert.ok(created.response.status >= 400, "Ein fehlgeschlagener Beleg darf nicht als erfolgreiche Mutation erscheinen.");
    assert.equal(receiptInsertAttempts, 1, "Die Mutation muss den Prüfbeleg tatsächlich im selben Transaktionspfad versuchen.");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM shifts WHERE note = ?").get(note).count,
      shiftCountBefore,
      "Ohne Evaluationsbeleg darf kein Dienst gespeichert bleiben.",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM work_rule_evaluation_runs").get().count,
      receiptCountBefore,
      "Der erzwungene Belegfehler darf keinen Teilbeleg hinterlassen.",
    );
  } finally {
    db.exec("DROP TRIGGER IF EXISTS regression_reject_evaluation_insert");
    db.prepare("DELETE FROM shifts WHERE note = ?").run(note);
  }
});

test("Regression: Ein verschobener Dienst erzeugt Belege für alte und neue Woche", async () => {
  const sourceDate = "2034-01-02";
  const targetDate = "2034-01-09";
  const created = await request("/api/shifts", {
    method: "POST",
    body: {
      employeeNumber: ATOMIC_EMPLOYEE,
      locationId: mainLocationId,
      departmentId: "",
      date: sourceDate,
      startTime: "09:00",
      endTime: "18:00",
      area: "Verschiebetest",
      note: "receipt-old-new",
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const sourceBefore = db.prepare(`
    SELECT COUNT(*) AS count FROM work_rule_evaluation_runs
    WHERE period_from = ? AND scope_key = ?
  `).get(sourceDate, mainLocationId).count;
  const targetBefore = db.prepare(`
    SELECT COUNT(*) AS count FROM work_rule_evaluation_runs
    WHERE period_from = ? AND scope_key = ?
  `).get(targetDate, mainLocationId).count;

  const moved = await request(`/api/shifts/${created.payload.id}`, {
    method: "PUT",
    body: {
      employeeNumber: ATOMIC_EMPLOYEE,
      locationId: mainLocationId,
      departmentId: "",
      date: targetDate,
      startTime: "09:00",
      endTime: "18:00",
      area: "Verschiebetest",
      note: "receipt-old-new",
    },
  });
  assert.equal(moved.response.status, 200, JSON.stringify(moved.payload));
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM work_rule_evaluation_runs
      WHERE period_from = ? AND scope_key = ?
    `).get(sourceDate, mainLocationId).count,
    sourceBefore + 1,
    "Auch der Plan, aus dem ein Dienst entfernt wurde, benötigt einen neuen Beleg.",
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM work_rule_evaluation_runs
      WHERE period_from = ? AND scope_key = ?
    `).get(targetDate, mainLocationId).count,
    targetBefore + 1,
    "Der neue Plan benötigt einen eigenen Beleg.",
  );
});

test("Regression: ZA-Freigabe rollt Dienständerung ohne Regelbeleg vollständig zurück", async () => {
  const date = "2034-02-06";
  const targetShiftId = insertShift(ATOMIC_EMPLOYEE, date, mainLocationId);
  insertShift(ADMIN, date, mainLocationId);
  insertShift(NO_RULE_READ, date, mainLocationId);
  const requestId = Number(db.prepare(`
    INSERT INTO time_off_requests
      (employee_number, location_id, request_date, date_from, date_to, all_day,
       start_time, end_time, note, status, approval_type, approval_stage)
    VALUES (?, ?, ?, ?, ?, 1, '00:00', '23:59', 'Atomarer ZA-Test',
      'pending', 'local', 'local')
  `).run(ATOMIC_EMPLOYEE, mainLocationId, date, date, date).lastInsertRowid);
  db.exec(`
    CREATE TRIGGER regression_reject_time_off_evaluation
    BEFORE INSERT ON work_rule_evaluation_runs
    BEGIN
      SELECT RAISE(ABORT, 'regression: time-off evaluation receipt rejected');
    END;
  `);
  try {
    const approved = await request(`/api/portal/v1/time-off-requests/${requestId}/decision`, {
      method: "PUT",
      body: { decision: "approved" },
    });
    assert.ok(approved.response.status >= 400, JSON.stringify(approved.payload));
    assert.ok(db.prepare("SELECT 1 FROM shifts WHERE id = ?").get(targetShiftId),
      "Der ursprüngliche Dienst muss nach dem Belegfehler erhalten bleiben.");
    const storedRequest = db.prepare(`
      SELECT status, option_id, original_shifts_json
      FROM time_off_requests WHERE id = ?
    `).get(requestId);
    assert.equal(storedRequest.status, "pending");
    assert.equal(storedRequest.option_id, null);
    assert.equal(storedRequest.original_shifts_json, "[]");
  } finally {
    db.exec("DROP TRIGGER IF EXISTS regression_reject_time_off_evaluation");
  }
});

test("Regression: work_rules:read wird vor dem Zugriff auf Regel-APIs erzwungen", async () => {
  const denied = await request("/api/work-rules/catalog", { session: employeeSession });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PORTAL_PERMISSION_DENIED");

  const schedule = await request(
    `/api/schedule?week=${HISTORICAL_WEEK}&location=${encodeURIComponent(mainLocationId)}`,
    { session: employeeSession },
  );
  assert.equal(schedule.response.status, 200, JSON.stringify(schedule.payload));
  assert.equal(schedule.payload.workRuleAssessment, null,
    "Ein entzogener Regelzugriff darf nicht über die normale Dienstplanantwort umgangen werden.");
});

test("Regression: Candidate-Prüfungen bleiben im organisatorisch zugewiesenen Standort", async () => {
  insertEmployeeAssignment({
    id: "regression-foreign-assignment-hidden",
    employeeNumber: FOREIGN_EMPLOYEE,
    profileVersionId: "at-retail-adult-monitor@2026.1",
    validFrom: "2032-01-01",
  });
  const assignments = await request("/api/work-rules/assignments", { session: managerSession });
  assert.equal(assignments.response.status, 200, JSON.stringify(assignments.payload));
  assert.equal(
    assignments.payload.assignments.some((assignment) => assignment.id === "regression-foreign-assignment-hidden"),
    false,
    "Regelzuordnungen außerhalb des Organisationsscopes dürfen nicht offengelegt werden.",
  );

  const allowed = await request("/api/work-rules/evaluate", {
    method: "POST",
    session: managerSession,
    body: {
      weekStart: HISTORICAL_WEEK,
      locationId: mainLocationId,
    },
  });
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.payload));

  const existingForeignShiftId = insertShift(
    FOREIGN_EMPLOYEE,
    "2032-07-06",
    mainLocationId,
    "09:00",
    "17:00",
    "Bestehende Aushilfe",
  );
  const allowedExistingEdit = await request("/api/work-rules/evaluate", {
    method: "POST",
    session: managerSession,
    body: {
      weekStart: HISTORICAL_WEEK,
      locationId: mainLocationId,
      candidateShift: {
        id: existingForeignShiftId,
        employeeNumber: FOREIGN_EMPLOYEE,
        locationId: mainLocationId,
        departmentId: "",
        date: "2032-07-06",
        startTime: "09:00",
        endTime: "18:00",
        area: "Bestehende Aushilfe",
        note: "",
      },
    },
  });
  assert.equal(allowedExistingEdit.response.status, 200, JSON.stringify(allowedExistingEdit.payload));

  const denied = await request("/api/work-rules/evaluate", {
    method: "POST",
    session: managerSession,
    body: {
      weekStart: HISTORICAL_WEEK,
      locationId: foreignLocationId,
    },
  });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PORTAL_SCOPE_DENIED");
});

test("Regression: Evaluation-Runs sind DB-seitig gegen UPDATE geschützt", () => {
  const id = `immutable-update-${crypto.randomUUID()}`;
  insertEvaluationRun(id);
  assert.throws(
    () => db.prepare("UPDATE work_rule_evaluation_runs SET outcome = 'attention' WHERE id = ?").run(id),
    /immutable|unveränderlich/i,
  );
});

test("Regression: Evaluation-Runs sind DB-seitig gegen DELETE geschützt", () => {
  const id = `immutable-delete-${crypto.randomUUID()}`;
  insertEvaluationRun(id);
  assert.throws(
    () => db.prepare("DELETE FROM work_rule_evaluation_runs WHERE id = ?").run(id),
    /immutable|unveränderlich/i,
  );
});

test("Regression: Legacy-Prüfbelege werden vor Aktivierung der Trigger vollständig nachsigniert", async () => {
  const id = `legacy-receipt-${crypto.randomUUID()}`;
  db.exec(`
    DROP TRIGGER IF EXISTS trg_work_rule_evaluations_immutable_update;
    DROP TRIGGER IF EXISTS trg_work_rule_evaluations_immutable_delete;
  `);
  insertEvaluationRun(id, "");
  ensureWorkRuleEvaluationReceiptIntegrity();
  const migrated = db.prepare(`
    SELECT receipt_sha256 FROM work_rule_evaluation_runs WHERE id = ?
  `).get(id);
  assert.match(migrated.receipt_sha256, /^[a-f0-9]{64}$/);
  const verified = await getWorkRuleEvaluation(workRuleStoreRepository, id);
  assert.equal(verified.receiptHashValid, true);
  assert.equal(verified.resultHashValid, true);
  assert.throws(
    () => db.prepare("UPDATE work_rule_evaluation_runs SET outcome = 'attention' WHERE id = ?").run(id),
    /immutable|unverÃ¤nderlich/i,
  );
});

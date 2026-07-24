"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v081-work-rules-"));
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
const { app, db, releaseInstanceLockForTests } = subject;
const { recordWorkRuleEvaluation } = require("../lib/work-rules/store");

const ADMIN = "v081-admin";
const EMPLOYEE = "v081-plan";
const WEEK = "2032-07-05";
let httpServer;
let baseUrl;
let adminSession;
let locationId;

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

async function request(route, { method = "GET", body } = {}) {
  const headers = {
    Accept: "application/json",
    Cookie: adminSession.cookie,
  };
  if (!["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = adminSession.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

test.before(async () => {
  const location = db.prepare(`
    SELECT id, cost_center_id FROM locations WHERE active = 1 ORDER BY id LIMIT 1
  `).get();
  locationId = location.id;
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id, cost_center_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, 1)
  `).run(ADMIN, "Ada Regelverwaltung", "Ada", locationId, location.cost_center_id);
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id, cost_center_id, active)
    VALUES (?, ?, ?, '#0b84c6', 38.5, 5, '', ?, ?, 1)
  `).run(EMPLOYEE, "Paul Planzeit", "Paul", locationId, location.cost_center_id);
  adminSession = createSession(ADMIN, "admin");
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

test("v0.81: Katalog, Profile und sichere Monitor-Standardzuordnung sind verfÃ¼gbar", async () => {
  const catalog = await request("/api/work-rules/catalog");
  assert.equal(catalog.response.status, 200, JSON.stringify(catalog.payload));
  assert.equal(catalog.payload.timeBasis, "planned_schedule");
  assert.match(catalog.payload.legalNotice, /keine Rechtsberatung/i);

  const profiles = await request("/api/work-rules/profiles");
  assert.equal(profiles.response.status, 200, JSON.stringify(profiles.payload));
  assert.ok(profiles.payload.profiles.some((profile) => profile.id === "at-retail-adult-monitor"));

  const assignments = await request("/api/work-rules/assignments");
  assert.equal(assignments.response.status, 200, JSON.stringify(assignments.payload));
  const installation = assignments.payload.assignments.find((assignment) => assignment.scopeType === "installation");
  assert.equal(installation.enforcementMode, "monitor");
  assert.equal(installation.applicabilityConfirmed, false);
});

test("v0.81: Wochenplan liefert eine sichtbare, nicht blockierende PlanprÃ¼fung", async () => {
  const schedule = await request(`/api/schedule?week=${WEEK}&location=${encodeURIComponent(locationId)}`);
  assert.equal(schedule.response.status, 200, JSON.stringify(schedule.payload));
  assert.equal(schedule.payload.workRuleAssessment.targetType, "planned_schedule");
  assert.equal(schedule.payload.workRuleAssessment.mode, "monitor");
  assert.equal(schedule.payload.workRuleAssessment.outcome, "manual_review");
  assert.ok(schedule.payload.workRuleAssessment.findings.some((finding) => (
    finding.employeeNumber === EMPLOYEE && finding.ruleId === "at.applicability.adult"
  )));
  assert.match(schedule.payload.workRuleAssessment.disclaimer, /keine Rechtsberatung/i);
});

test("v0.81: Schichtvorschau bleibt Planzeit und eine Mutation erzeugt einen PrÃ¼fbeleg", async () => {
  const candidateShift = {
    employeeNumber: EMPLOYEE,
    locationId,
    departmentId: "",
    date: WEEK,
    startTime: "09:00",
    endTime: "18:00",
    area: "Test",
    note: "",
  };
  const preview = await request("/api/work-rules/evaluate", {
    method: "POST",
    body: {
      targetType: "planned_schedule",
      weekStart: WEEK,
      locationId,
      candidateShift,
    },
  });
  assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
  assert.equal(preview.payload.targetType, "planned_schedule");
  assert.equal(preview.payload.candidate.employeeNumber, EMPLOYEE);

  const actualRejected = await request("/api/work-rules/evaluate", {
    method: "POST",
    body: { targetType: "actual_time", weekStart: WEEK, locationId },
  });
  assert.equal(actualRejected.response.status, 400);

  const created = await request("/api/shifts", { method: "POST", body: candidateShift });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.workRuleAssessment.mode, "monitor");

  const evaluations = await request("/api/work-rules/evaluations");
  assert.equal(evaluations.response.status, 200, JSON.stringify(evaluations.payload));
  assert.ok(evaluations.payload.evaluations.some((evaluation) => (
    evaluation.targetType === "planned_schedule"
      && evaluation.periodFrom === WEEK
      && /^[a-f0-9]{64}$/.test(evaluation.resultSha256)
  )));
});

test("v0.81: nur vorgesehene Ausnahmen werden begrÃ¼ndet angelegt und widerrufen", async () => {
  const row = db.prepare(`
    SELECT id, target_type, scope_type, scope_key, period_from, period_to,
           profile_version_ids_json, input_sha256, result_json
    FROM work_rule_evaluation_runs
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get();
  const result = JSON.parse(row.result_json);
  const finding = result.employeeResults[0].result.findings.find((entry) => entry.profileId && entry.profileVersion);
  finding.baseEnforcement = "exception_required";
  const evaluation = recordWorkRuleEvaluation(db, {
    targetType: row.target_type,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    profileVersionIds: JSON.parse(row.profile_version_ids_json),
    inputSha256: row.input_sha256,
    result,
    outcome: "manual_review",
    actor: ADMIN,
  });

  const created = await request("/api/work-rules/exceptions", {
    method: "POST",
    body: {
      evaluationId: evaluation.id,
      findingFingerprint: finding.fingerprint,
      exceptionType: "documented_exception",
      reason: "Betriebliche Ausnahme mit gesondertem Nachweis",
      evidence: "Testnachweis",
      validFrom: WEEK,
      validTo: WEEK,
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.state, "active");

  const revoked = await request(`/api/work-rules/exceptions/${encodeURIComponent(created.payload.id)}/revoke`, {
    method: "POST",
    body: { reason: "Nachweis ist nicht mehr anwendbar" },
  });
  assert.equal(revoked.response.status, 200, JSON.stringify(revoked.payload));
  assert.equal(revoked.payload.state, "revoked");
  const stored = db.prepare("SELECT state, revoked_by FROM work_rule_exceptions WHERE id = ?").get(created.payload.id);
  assert.equal(stored.state, "revoked");
  assert.equal(stored.revoked_by, ADMIN);
});

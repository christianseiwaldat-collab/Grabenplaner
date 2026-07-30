"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-block3-personnel-rules-"));
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
  closePersistenceForTests,
  db,
  initializeApplicationPersistence,
  releaseInstanceLockForTests,
} = subject;

const MANAGER = "block3-manager";
const EMPLOYEE = "block3-employee";
let httpServer;
let baseUrl;
let managerSession;
let employeeSession;
let localLocationId;
let foreignLocationId;
let foreignCostCenterId;

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

async function request(route, { method = "GET", body, session = managerSession } = {}) {
  const headers = { Accept: "application/json", Cookie: session.cookie };
  if (!["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
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

function insertEmployee(personnelNumber, name, locationId, costCenterId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id, cost_center_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, 1)
  `).run(personnelNumber, name, name.split(" ")[0], locationId, costCenterId || null);
}

test.before(async () => {
  await initializeApplicationPersistence();
  const localLocation = db.prepare(`
    SELECT id, cost_center_id FROM locations WHERE active = 1 ORDER BY id LIMIT 1
  `).get();
  localLocationId = String(localLocation.id);
  foreignLocationId = String(
    Array.from({ length: 19 }, (_, index) => 80 + index)
      .find((id) => !db.prepare("SELECT 1 FROM locations WHERE id = ?").get(String(id))),
  );
  foreignCostCenterId = `cc-block3-${foreignLocationId}`;
  db.prepare(`
    INSERT INTO cost_centers
      (id, code, name, type, cost_center_type_id, active, sort_order)
    VALUES (?, ?, 'Block 3 Fremdfiliale', 'branch', 'branch', 1, 900)
  `).run(foreignCostCenterId, `B3-${foreignLocationId}`);
  db.prepare(`
    INSERT INTO locations (id, name, cost_center_id, min_staff, day_settings_json, active)
    VALUES (?, 'Block 3 Fremdfiliale', ?, 1, '', 1)
  `).run(foreignLocationId, foreignCostCenterId);
  insertEmployee(MANAGER, "Mara Regelblick", localLocationId, localLocation.cost_center_id);
  insertEmployee(EMPLOYEE, "Emil Ohne Regelrecht", localLocationId, localLocation.cost_center_id);
  managerSession = createSession(MANAGER, "manager");
  employeeSession = createSession(EMPLOYEE, "employee");
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, 'block3-test')
  `).run(MANAGER, localLocationId);
  db.prepare(`
    INSERT INTO work_rule_assignments
      (id, profile_version_id, scope_type, scope_key, valid_from, valid_to,
       enforcement_mode, applicability_confirmed, confirmed_by, confirmed_at,
       active, created_by)
    VALUES (?, 'at-retail-adult-monitor@2026.1', 'location', ?, '2026-01-01', NULL,
      'monitor', 1, 'block3-test', CURRENT_TIMESTAMP, 1, 'block3-test')
  `).run("block3-local-assignment", localLocationId);
  db.prepare(`
    INSERT INTO work_rule_assignments
      (id, profile_version_id, scope_type, scope_key, valid_from, valid_to,
       enforcement_mode, applicability_confirmed, confirmed_by, confirmed_at,
       active, created_by)
    VALUES (?, 'at-retail-adult-monitor@2026.1', 'location', ?, '2026-01-01', NULL,
      'enforced', 1, 'block3-test', CURRENT_TIMESTAMP, 1, 'block3-test')
  `).run("block3-foreign-assignment", foreignLocationId);
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  await closePersistenceForTests();
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Block 3/7: Personal-Regelwerk liefert versionierte Profile, Quellen und den eigenen Scope", async () => {
  const result = await request("/api/work-rules/dashboard");
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.timeBasis, "planned_schedule");
  assert.match(result.payload.legalNotice, /keine Rechtsberatung/i);
  assert.equal(result.payload.scopeLabel, "Eigene zugewiesene Bereiche");
  assert.equal(result.payload.capabilities.canSimulate, true);
  assert.equal(result.payload.capabilities.canManageAssignments, false);
  assert.deepEqual(result.payload.locations.map((location) => String(location.id)), [localLocationId]);
  assert.deepEqual(result.payload.profiles.map((profile) => profile.id), [
    "at-general-adult",
    "at-retail-adult-monitor",
    "at-retail-youth-monitor",
    "at-retail-kv-2026-draft",
  ]);

  const adult = result.payload.profiles.find((profile) => profile.id === "at-retail-adult-monitor");
  const youth = result.payload.profiles.find((profile) => profile.id === "at-retail-youth-monitor");
  const draft = result.payload.profiles.find((profile) => profile.id === "at-retail-kv-2026-draft");
  assert.equal(adult.status, "published");
  assert.ok(adult.contentSha256);
  assert.ok(adult.rules.length > 0);
  assert.ok(adult.sources.length > 0);
  assert.equal(youth.automaticByBirthDate, true);
  assert.equal(youth.applicability.maximumAgeExclusive, 18);
  assert.equal(draft.status, "draft");
  assert.equal(draft.assignable, false);
  assert.equal(
    result.payload.assignments.some((assignment) => assignment.id === "block3-local-assignment"),
    true,
  );
  assert.equal(
    result.payload.assignments.some((assignment) => assignment.id === "block3-foreign-assignment"),
    false,
  );
  const serialized = JSON.stringify(result.payload);
  for (const forbidden of ["password_hash", "token_hash", "credentials", "time_tracking_allowed_networks"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("Block 3/7: Leserecht und organisatorischer Simulations-Scope werden serverseitig erzwungen", async () => {
  const denied = await request("/api/work-rules/dashboard", { session: employeeSession });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PORTAL_PERMISSION_DENIED");

  const allowed = await request("/api/work-rules/evaluate", {
    method: "POST",
    body: {
      targetType: "planned_schedule",
      preview: true,
      weekStart: "2032-07-05",
      locationId: localLocationId,
    },
  });
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.payload));

  const foreign = await request("/api/work-rules/evaluate", {
    method: "POST",
    body: {
      targetType: "planned_schedule",
      preview: true,
      weekStart: "2032-07-05",
      locationId: foreignLocationId,
    },
  });
  assert.equal(foreign.response.status, 403, JSON.stringify(foreign.payload));
});

test("Block 3/7: Dashboard ist zwischen Rechteübersicht und Abläufe & Prozesse verdrahtet", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  const rightsTab = html.indexOf('data-rights-dashboard-mode="rights"');
  const rulesTab = html.indexOf('data-rights-dashboard-mode="personnelRules"');
  const processesTab = html.indexOf('data-rights-dashboard-mode="processes"');
  const systemTab = html.indexOf('data-rights-dashboard-mode="systemCenter"');
  assert.ok(rightsTab >= 0 && rightsTab < rulesTab);
  assert.ok(rulesTab < processesTab && processesTab < systemTab);
  assert.match(html, /data-dashboard-capability="workRules"[^>]*>Personal-Regelwerk<\/button>/);
  for (const id of [
    "personnelRulesDashboardPanel",
    "personnelRulesProfileList",
    "personnelRulesApplicability",
    "personnelRulesAssignments",
    "personnelRulesRules",
    "personnelRulesSources",
    "personnelRulesSimulationResult",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  for (const marker of [
    "function canReadPersonnelRulesDashboard",
    "function loadPersonnelRulesDashboard",
    "function renderPersonnelRulesDashboard",
    "function runPersonnelRulesSimulation",
    'api("/api/work-rules/dashboard")',
  ]) assert.ok(script.includes(marker), marker);
  for (const marker of [
    ".personnel-rules-summary",
    ".personnel-rules-workspace",
    ".personnel-rules-profile",
    ".personnel-rules-simulation-overview",
  ]) assert.ok(styles.includes(marker), marker);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*personnel-rules-filterbar/);
});

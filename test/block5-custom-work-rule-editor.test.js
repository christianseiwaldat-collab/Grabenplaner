"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-block5-rule-editor-"));
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

const HR = "block5-hr";
const MANAGER = "block5-manager";
const IT_ADMIN = "block5-it";
let httpServer;
let baseUrl;
let hrSession;
let managerSession;
let itAdminSession;
let locationId;
let departmentId;
let draft;

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

function insertEmployee(personnelNumber, name, roleLocationId, costCenterId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id, cost_center_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, 1)
  `).run(personnelNumber, name, name.split(" ")[0], roleLocationId, costCenterId || null);
}

async function request(route, { method = "GET", body, session = hrSession } = {}) {
  const headers = { Accept: "application/json", Cookie: session.cookie };
  if (!["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseText = await response.text();
  let payload = null;
  try { payload = responseText ? JSON.parse(responseText) : null; } catch { payload = { raw: responseText }; }
  return { response, payload };
}

function rulePayload(overrides = {}) {
  return {
    code: "URLAUB-VORLAUF",
    title: "Interner Mindestvorlauf für Urlaubsanträge",
    description: "Betriebliche Planungsregel für einen nachvollziehbaren Vorlauf bei Urlaubsanträgen.",
    ruleType: "company_rule",
    topic: "vacation",
    scopeType: "location",
    scopeKey: locationId,
    validFrom: "2026-08-01",
    validTo: null,
    metric: "minimum_vacation_request_lead_days",
    threshold: 14,
    severity: "warning",
    reaction: "acknowledge",
    message: "Der gewünschte Urlaubsbeginn liegt innerhalb des betrieblichen Planungsvorlaufs.",
    responsibleUnit: "Personalleitung",
    sourceTitle: "Interne Urlaubsrichtlinie",
    sourceReference: "RL-URL-2026, Abschnitt 3",
    sourceUrl: "https://example.invalid/interne-richtlinie",
    sourceNote: "Interne Regel; zwingende gesetzliche oder kollektivvertragliche Vorgaben bleiben unberührt.",
    testCases: {
      positiveValue: 21,
      negativeValue: 7,
    },
    status: "draft",
    enforcementMode: "monitor",
    ...overrides,
  };
}

test.before(async () => {
  const location = db.prepare(`
    SELECT id, cost_center_id
    FROM locations
    WHERE active = 1
    ORDER BY id
    LIMIT 1
  `).get();
  locationId = String(location.id);
  departmentId = String(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active)
    VALUES (?, 'Block 5 Testabteilung', 0, 1)
    RETURNING id
  `).get(locationId).id);
  insertEmployee(HR, "Helena Regelwerk", locationId, location.cost_center_id);
  insertEmployee(MANAGER, "Mara Leserecht", locationId, location.cost_center_id);
  insertEmployee(IT_ADMIN, "Ines Technik", locationId, location.cost_center_id);
  hrSession = createSession(HR, "hr");
  managerSession = createSession(MANAGER, "manager");
  itAdminSession = createSession(IT_ADMIN, "it_admin");
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

test("Block 5/7: Regelbaukasten prüft positiven, negativen und unklaren Testfall deterministisch", async () => {
  const simulated = await request("/api/work-rules/drafts/simulate", {
    method: "POST",
    body: rulePayload(),
  });
  assert.equal(simulated.response.status, 200, JSON.stringify(simulated.payload));
  assert.equal(simulated.payload.simulation.valid, true);
  assert.deepEqual(
    simulated.payload.simulation.testCases.map((entry) => [entry.id, entry.actual]),
    [["positive", "pass"], ["negative", "fail"], ["unknown", "unknown"]],
  );

  const inconsistent = await request("/api/work-rules/drafts/simulate", {
    method: "POST",
    body: rulePayload({
      testCases: { positiveValue: 7, negativeValue: 21 },
    }),
  });
  assert.equal(inconsistent.response.status, 400, JSON.stringify(inconsistent.payload));
  assert.match(inconsistent.payload.error, /positive Testfall/i);
});

test("Block 5/7: eigene Regeln bleiben unveränderliche, nicht wirksame Entwurfsfassungen", async () => {
  const created = await request("/api/work-rules/drafts", {
    method: "POST",
    body: rulePayload(),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  draft = created.payload.draft;
  assert.equal(draft.code, "URLAUB-VORLAUF");
  assert.equal(draft.status, "draft");
  assert.equal(draft.versions.length, 1);
  assert.equal(draft.currentVersion.status, "draft");
  assert.equal(draft.currentVersion.versionLabel, "draft-1");
  assert.match(draft.currentVersion.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(draft.currentVersion.definition.reaction, "acknowledge");
  assert.deepEqual(
    draft.currentVersion.definition.testCases.map((entry) => entry.actual),
    ["pass", "fail", "unknown"],
  );

  assert.throws(
    () => db.prepare("UPDATE work_rule_profile_versions SET status = 'published' WHERE id = ?")
      .run(draft.currentVersionId),
    /immutable/i,
  );

  const revised = await request(`/api/work-rules/drafts/${encodeURIComponent(draft.id)}/revisions`, {
    method: "POST",
    body: rulePayload({
      threshold: 21,
      message: "Der gewünschte Urlaubsbeginn unterschreitet den überarbeiteten betrieblichen Planungsvorlauf.",
      testCases: { positiveValue: 28, negativeValue: 14 },
    }),
  });
  assert.equal(revised.response.status, 201, JSON.stringify(revised.payload));
  draft = revised.payload.draft;
  assert.equal(draft.versions.length, 2);
  assert.equal(draft.currentVersion.versionLabel, "draft-2");
  assert.equal(draft.currentVersion.definition.threshold, 21);
  assert.notEqual(draft.versions[0].contentSha256, draft.versions[1].contentSha256);

  const changedCode = await request(`/api/work-rules/drafts/${encodeURIComponent(draft.id)}/revisions`, {
    method: "POST",
    body: rulePayload({ code: "ANDERES-KUERZEL" }),
  });
  assert.equal(changedCode.response.status, 400, JSON.stringify(changedCode.payload));
  assert.match(changedCode.payload.error, /unverändert/i);
});

test("Block 5/7: Veröffentlichung, Aktivierung und Dienstplanzuordnung sind serverseitig ausgeschlossen", async () => {
  const prematurePublication = await request("/api/work-rules/drafts", {
    method: "POST",
    body: rulePayload({
      code: "NICHT-PUBLIZIEREN",
      status: "published",
      published: true,
      assignable: true,
    }),
  });
  assert.equal(prematurePublication.response.status, 400, JSON.stringify(prematurePublication.payload));
  assert.match(prematurePublication.payload.error, /Block 5|Block 6|Entwürfe/i);

  const prematureAssignment = await request("/api/work-rules/assignments", {
    method: "POST",
    body: {
      profileVersionId: draft.currentVersionId,
      scopeType: "location",
      scopeKey: locationId,
      validFrom: "2026-08-01",
      enforcementMode: "monitor",
      applicabilityConfirmed: false,
    },
  });
  assert.equal(prematureAssignment.response.status, 400, JSON.stringify(prematureAssignment.payload));
  assert.match(prematureAssignment.payload.error, /veröffentlicht|aktive/i);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM work_rule_assignments WHERE profile_version_id = ?")
      .get(draft.currentVersionId).count,
    0,
  );

  const invalidBlockingSeverity = await request("/api/work-rules/drafts/simulate", {
    method: "POST",
    body: rulePayload({ reaction: "block", severity: "warning" }),
  });
  assert.equal(invalidBlockingSeverity.response.status, 400, JSON.stringify(invalidBlockingSeverity.payload));
  assert.match(invalidBlockingSeverity.payload.error, /kritisch/i);
});

test("Block 5/7: eigenes Entwurfsrecht ist von Leserecht und technischer Profilpflege getrennt", async () => {
  const registry = await request("/api/work-rules/drafts");
  assert.equal(registry.response.status, 200, JSON.stringify(registry.payload));
  assert.match(registry.payload.notice, /keine Auswirkung/i);
  assert.equal(registry.payload.capabilities.canDraft, true);
  assert.equal(registry.payload.capabilities.canApprove, false);
  assert.equal(registry.payload.capabilities.canPublish, false);
  assert.equal(registry.payload.capabilities.canActivate, false);
  assert.equal(registry.payload.capabilities.approvalBlock, 6);
  assert.equal(registry.payload.summary.drafts, 1);
  assert.equal(registry.payload.summary.revisions, 2);
  assert.ok(registry.payload.organizationalScopes.locations.some((location) => (
    location.id === locationId && location.departments.some((department) => department.id === departmentId)
  )));

  const managerDenied = await request("/api/work-rules/drafts", { session: managerSession });
  assert.equal(managerDenied.response.status, 403, JSON.stringify(managerDenied.payload));

  const itAdminDenied = await request("/api/work-rules/drafts", { session: itAdminSession });
  assert.equal(itAdminDenied.response.status, 403, JSON.stringify(itAdminDenied.payload));

  const managerDashboard = await request("/api/work-rules/dashboard", { session: managerSession });
  assert.equal(managerDashboard.response.status, 200, JSON.stringify(managerDashboard.payload));
  assert.ok(managerDashboard.payload.profiles.length > 0);
});

test("Block 5/7: Personalverwaltung verdrahtet Regelwerk, Baukasten und mobile Darstellung", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  for (const marker of [
    'data-personnel-administration-route="ruleDrafts"',
    'data-personnel-administration-tab="ruleDrafts"',
    'id="customWorkRulesSection"',
    'id="customWorkRuleModal"',
    "Geführter Regelbaukasten",
    "Keine Dienstplanwirkung",
    "3 Testfälle prüfen",
  ]) assert.ok(html.includes(marker), marker);
  for (const marker of [
    "function canDraftCustomWorkRules",
    "function loadCustomWorkRuleRegistry",
    "function renderCustomWorkRuleRegistry",
    "function simulateCustomWorkRuleDraft",
    "function saveCustomWorkRule",
    'api("/api/work-rules/drafts")',
    "elements.customWorkRuleValidFrom.value = definition.validFrom || toIsoDate(new Date());",
    '<article class="personnel-administration-stat">',
  ]) assert.ok(script.includes(marker), marker);
  for (const marker of [
    ".custom-work-rule-workspace",
    ".custom-work-rule-boundary",
    ".custom-work-rule-tests",
    ".custom-work-rule-review-state",
  ]) assert.ok(styles.includes(marker), marker);
  assert.match(styles, /@media \(max-width:1000px\)[\s\S]*custom-work-rule-workspace/);
  assert.match(styles, /@media \(max-width:700px\)[\s\S]*custom-work-rule-test-actions/);
});

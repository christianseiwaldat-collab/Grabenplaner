"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "grabenplaner-v087-block6-work-rule-panel-"),
);
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
const { app, db } = subject;

const ADMIN = "v087-b6-admin";
const MANAGER = "v087-b6-manager";

let httpServer;
let baseUrl;

function ensureEmployee(employeeNumber, fullName, role) {
  const locationId = db.prepare(
    "SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1",
  ).get().id;
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, home_location_id, active)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      active = 1
  `).run(employeeNumber, fullName, fullName.split(" ")[0], locationId);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only',
      role = excluded.role,
      active = 1,
      must_change_password = 0,
      password_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
}

function createPortalSession(employeeNumber) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(rawToken).digest("hex"),
  );
  return {
    cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

function resetFixture() {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "DELETE FROM shifts WHERE employee_number IN (?, ?)",
    ).run(ADMIN, MANAGER);
    db.prepare(
      "DELETE FROM portal_sessions WHERE employee_number IN (?, ?)",
    ).run(ADMIN, MANAGER);
    db.prepare(
      "DELETE FROM portal_user_preferences WHERE employee_number IN (?, ?)",
    ).run(ADMIN, MANAGER);
    db.prepare(
      "DELETE FROM portal_users WHERE employee_number IN (?, ?)",
    ).run(ADMIN, MANAGER);
    db.prepare(
      "DELETE FROM employees WHERE personnel_number IN (?, ?)",
    ).run(ADMIN, MANAGER);
    ensureEmployee(ADMIN, "Ada Blocksechs", "admin");
    ensureEmployee(MANAGER, "Mara Blocksechs", "manager");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

async function requestJson(
  route,
  {
    method = "GET",
    session = null,
    body,
  } = {},
) {
  const headers = { Accept: "application/json" };
  if (session) headers.Cookie = session.cookie;
  if (session && !["GET", "HEAD"].includes(method)) {
    headers["X-CSRF-Token"] = session.csrf;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    response,
    payload: text ? JSON.parse(text) : null,
  };
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `${startMarker} fehlt`);
  assert.ok(end > start, `${endMarker} fehlt nach ${startMarker}`);
  return source.slice(start, end);
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.beforeEach(resetFixture);

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
});

test("Block 6 speichert den Regelprüfungszustand getrennt je Benutzer", async () => {
  const admin = createPortalSession(ADMIN);
  const manager = createPortalSession(MANAGER);

  const adminDefault = await requestJson("/api/portal/v1/ui-preferences", {
    session: admin,
  });
  assert.equal(adminDefault.response.status, 200, JSON.stringify(adminDefault.payload));
  assert.equal(adminDefault.payload.workRuleAssessmentExpanded, false);

  const changed = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: admin,
    body: { workRuleAssessmentExpanded: true },
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.equal(changed.payload.workRuleAssessmentExpanded, true);
  assert.equal(
    db.prepare(`
      SELECT value FROM portal_user_preferences
      WHERE employee_number = ? AND preference_key = 'work_rule_assessment_expanded'
    `).get(ADMIN).value,
    "1",
  );

  const refreshed = await requestJson("/api/portal/v1/ui-preferences", {
    session: admin,
  });
  assert.equal(refreshed.payload.workRuleAssessmentExpanded, true);

  const themeOnlyUpdate = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: admin,
    body: { pageThemes: { planning: "dark" } },
  });
  assert.equal(themeOnlyUpdate.response.status, 200, JSON.stringify(themeOnlyUpdate.payload));
  assert.equal(themeOnlyUpdate.payload.workRuleAssessmentExpanded, true);
  const afterPartialUpdate = await requestJson("/api/portal/v1/ui-preferences", {
    session: admin,
  });
  assert.equal(afterPartialUpdate.payload.workRuleAssessmentExpanded, true);

  const managerDefault = await requestJson("/api/portal/v1/ui-preferences", {
    session: manager,
  });
  assert.equal(managerDefault.response.status, 200, JSON.stringify(managerDefault.payload));
  assert.equal(managerDefault.payload.workRuleAssessmentExpanded, false);

  const collapsed = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: admin,
    body: { workRuleAssessmentExpanded: false },
  });
  assert.equal(collapsed.response.status, 200, JSON.stringify(collapsed.payload));
  assert.equal(collapsed.payload.workRuleAssessmentExpanded, false);
  assert.equal(
    db.prepare(`
      SELECT value FROM portal_user_preferences
      WHERE employee_number = ? AND preference_key = 'work_rule_assessment_expanded'
    `).get(ADMIN).value,
    "0",
  );

  const locationId = db.prepare(
    "SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1",
  ).get().id;
  const candidateShift = {
    employeeNumber: ADMIN,
    locationId,
    departmentId: "",
    date: "2035-01-08",
    startTime: "09:00",
    endTime: "17:00",
    area: "Block-6-Regressionspruefung",
    note: "Panel bleibt geschlossen",
  };
  const created = await requestJson("/api/shifts", {
    method: "POST",
    session: admin,
    body: candidateShift,
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const afterCreate = await requestJson("/api/portal/v1/ui-preferences", {
    session: admin,
  });
  assert.equal(afterCreate.payload.workRuleAssessmentExpanded, false);

  const updated = await requestJson(`/api/shifts/${created.payload.id}`, {
    method: "PUT",
    session: admin,
    body: {
      ...candidateShift,
      startTime: "10:00",
      endTime: "18:00",
      note: "Panel bleibt auch nach Bearbeitung geschlossen",
    },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  const afterUpdate = await requestJson("/api/portal/v1/ui-preferences", {
    session: admin,
  });
  assert.equal(afterUpdate.payload.workRuleAssessmentExpanded, false);
});

test("Block 6 akzeptiert ausschließlich einen booleschen Panelzustand", async () => {
  const admin = createPortalSession(ADMIN);
  const invalid = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: admin,
    body: { workRuleAssessmentExpanded: "true" },
  });
  assert.equal(invalid.response.status, 400, JSON.stringify(invalid.payload));
  assert.equal(invalid.payload.code, "UI_PREFERENCES_INVALID");
  assert.equal(
    db.prepare(`
      SELECT value FROM portal_user_preferences
      WHERE employee_number = ? AND preference_key = 'work_rule_assessment_expanded'
    `).get(ADMIN),
    undefined,
  );

  const anonymous = await requestJson("/api/portal/v1/ui-preferences");
  assert.equal(anonymous.response.status, 401, JSON.stringify(anonymous.payload));
});

test("Block 6 lässt Render und Datenneuladen den Benutzerzustand unangetastet", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

  const panel = between(
    html,
    '<details class="work-rule-assessment" id="workRuleAssessmentPanel">',
    "</details>",
  );
  const summary = between(panel, "<summary>", "</summary>");
  assert.match(summary, /id="workRuleAssessmentSummary"/);
  assert.match(summary, /id="workRuleModeBadge"/);
  assert.match(summary, /id="workRuleAssessmentCounts"/);
  assert.doesNotMatch(
    '<details class="work-rule-assessment" id="workRuleAssessmentPanel">',
    /\sopen(?:\s|>)/,
  );

  const renderer = between(
    script,
    "function renderWorkRuleAssessment()",
    "function renderTimeline()",
  );
  assert.doesNotMatch(renderer, /workRuleAssessmentPanel\.open\s*=/);
  assert.doesNotMatch(renderer, /setAttribute\(["']open["']/);
  assert.match(renderer, /work-rule-assessment \$\{displayOutcome\}/);
  assert.match(renderer, /<strong>\$\{counts\.blocked\}<\/strong> blockiert/);

  const preferenceFunctions = between(
    script,
    "function workRuleAssessmentExpandedStorageKey()",
    "async function savePageTheme(",
  );
  assert.match(preferenceFunctions, /uiPreferenceActorKey\(\)/);
  assert.match(preferenceFunctions, /workRuleAssessmentExpanded/);
  assert.match(preferenceFunctions, /localStorage\.getItem/);
  assert.match(preferenceFunctions, /method:\s*"PUT"/);
  assert.match(preferenceFunctions, /workRuleAssessmentPreferenceRequestId/);
  assert.match(
    script,
    /const localOnly = preferences\?\.actor === "local"[\s\S]*state\.portalStatus\?\.portalEnabled !== true/,
  );
  assert.match(
    script,
    /workRuleAssessmentPanel\?\.addEventListener\("toggle",[\s\S]*expanded === state\.workRuleAssessmentExpanded/,
  );

  assert.match(styles, /\.work-rule-assessment\.blocked\s*\{\s*border-left-color:#bd4d3e/);
  assert.match(styles, /\.work-rule-assessment-counts \.blocked\s*\{[^}]*background:#fde9e5/);
  assert.match(
    styles,
    /@media \(max-width: 600px\)[\s\S]*\.work-rule-assessment-counts\s*\{\s*justify-content:flex-start/,
  );
});

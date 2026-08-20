"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-learning-catalog-"));
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
} = require("../server");

const LOCATION_A = "91";
const LOCATION_B = "92";
const MANAGER = "learning-catalog-fl";
const DEPARTMENT_MANAGER = "learning-catalog-al";
const FOREIGN_MANAGER = "learning-catalog-foreign-fl";
const DEVELOPER = "learning-catalog-developer";
const IT_ADMIN = "learning-catalog-it";
const BLOCK6_TRAINER = "learning-progress-trainer";
const BLOCK6_LEARNER = "learning-progress-learner";
const BLOCK7_BRANCH_LOGIN = "learning-dashboard-branch";
const BLOCK7_BRANCH_PASSWORD = "Learning-Dashboard-Branch-2027!";

let departmentA;
let departmentB;
let httpServer;
let baseUrl;

function employee(personnelNumber, name, role, locationId, departmentId = null) {
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours,
      target_workdays_per_week, fixed_workdays, home_location_id,
      preferred_department_id, active
    ) VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, 1)
  `).run(personnelNumber, name, name.split(/\s+/)[0], locationId, departmentId);
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password,
      password_changed_at, updated_at
    ) VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(personnelNumber, role);
  if (role === "manager") {
    db.prepare(`
      INSERT INTO portal_access_scopes
        (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, 0, ?)
    `).run(personnelNumber, locationId, DEVELOPER);
  } else if (role === "department_manager") {
    db.prepare(`
      INSERT INTO portal_access_scopes
        (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, ?, ?)
    `).run(personnelNumber, locationId, departmentId, DEVELOPER);
  }
}

function session(employeeNumber) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
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

function responseSession(response) {
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const cookies = setCookies.map((value) => value.split(";", 1)[0]);
  const csrfCookie = cookies.find((value) => value.startsWith("grabenplaner_csrf="));
  assert.ok(csrfCookie, "CSRF-Cookie fehlt");
  return {
    cookie: cookies.join("; "),
    csrf: decodeURIComponent(csrfCookie.split("=").slice(1).join("=")),
  };
}

async function request(route, {
  method = "GET",
  auth = null,
  body,
  csrfToken = undefined,
} = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method) && csrfToken !== null) {
    headers["X-CSRF-Token"] = csrfToken === undefined ? auth.csrf : String(csrfToken);
  }
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

function template({
  code,
  title = "Kassasystem sicher bedienen",
  scope = { type: "location", locationId: LOCATION_A, departmentId: null },
  objective = "Alle wesentlichen Kassenabläufe sicher durchführen.",
  versionNote = "Erstfassung",
  verificationMode = "practical_check",
  steps = null,
} = {}) {
  return {
    moduleCode: code,
    moduleType: "training",
    title,
    summary: "Transparente Grundlagen und Praxisprüfung.",
    objective,
    estimatedMinutes: 45,
    verificationMode,
    tags: ["Kassa", "Praxis"],
    versionNote,
    scope,
    steps: steps || [{
      stepId: "start",
      title: "Kassa öffnen",
      instruction: "Anmeldung und Startbestand prüfen.",
      completionCriteria: "Startbestand ist bestätigt.",
      required: true,
    }],
  };
}

function skillLevels(suffix = "") {
  return Array.from({ length: 10 }, (_entry, index) => ({
    level: index + 1,
    label: `Stufe ${index + 1}${suffix}`,
    description: `Nachvollziehbar definierter Fähigkeitsumfang der Stufe ${index + 1}${suffix}.`,
  }));
}

function skill({
  code,
  title = "Drohnen inklusive Praxis",
  scope = { type: "location", locationId: LOCATION_A, departmentId: null },
  levelDefinitions = skillLevels(),
  versionNote = "Erstfassung",
} = {}) {
  return {
    skillCode: code,
    title,
    category: "Foto und Video",
    summary: "Transparente Kompetenzdefinition für Theorie und Praxis.",
    tags: ["Drohne", "Praxis"],
    levelDefinitions,
    versionNote,
    scope,
  };
}

async function createPublishedSkill(auth, code, overrides = {}) {
  const created = await request("/api/portal/v1/personnel-learning/skills", {
    method: "POST",
    auth,
    body: skill({ code, ...overrides }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const published = await request(
    `/api/portal/v1/personnel-learning/skills/${encodeURIComponent(created.payload.skill.id)}/publish`,
    {
      method: "POST",
      auth,
      body: {
        versionNumber: 1,
        expectedEventReceipt: created.payload.skill.currentEventReceipt,
      },
    },
  );
  assert.equal(published.response.status, 200, JSON.stringify(published.payload));
  return published.payload.skill;
}

async function createPublishedProcess(auth, code, overrides = {}) {
  const created = await request("/api/portal/v1/personnel-learning/modules", {
    method: "POST",
    auth,
    body: template({ code, ...overrides }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const published = await request(
    `/api/portal/v1/personnel-learning/modules/${encodeURIComponent(created.payload.module.id)}/publish`,
    {
      method: "POST",
      auth,
      body: {
        versionNumber: 1,
        expectedEventReceipt: created.payload.module.currentEventReceipt,
      },
    },
  );
  assert.equal(published.response.status, 200, JSON.stringify(published.payload));
  return published.payload.module;
}

async function assignTrainerCompetency(auth, employeeNumber, skillId, level = 7) {
  const assigned = await request(
    `/api/portal/v1/personnel-learning/competencies/${employeeNumber}/${encodeURIComponent(skillId)}`,
    {
      method: "PUT",
      auth,
      body: { level, trainerAuthorized: true },
    },
  );
  assert.equal(assigned.response.status, 201, JSON.stringify(assigned.payload));
  return assigned.payload.competency;
}

test.before(async () => {
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, active)
    VALUES (?, 'Learning Filiale A', 0, 1), (?, 'Learning Filiale B', 0, 1)
  `).run(LOCATION_A, LOCATION_B);
  departmentA = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Learning Abteilung A', 0, 1, 9910)
    RETURNING id
  `).get(LOCATION_A).id);
  departmentB = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Learning Abteilung B', 0, 1, 9911)
    RETURNING id
  `).get(LOCATION_B).id);
  employee(MANAGER, "Florian Lernleitung", "manager", LOCATION_A);
  employee(DEPARTMENT_MANAGER, "Alina Lernabteilung", "department_manager", LOCATION_A, departmentA);
  employee(FOREIGN_MANAGER, "Franz Fremdfiliale", "manager", LOCATION_B);
  employee(DEVELOPER, "Dora Developer", "developer", LOCATION_A);
  employee(IT_ADMIN, "Ina Technik", "it_admin", LOCATION_A);
  employee(BLOCK6_TRAINER, "Tina Trainerperson", "employee", LOCATION_B);
  employee(BLOCK6_LEARNER, "Lena Lernperson", "employee", LOCATION_A, departmentA);
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

test("Learning-Katalog führt Entwurf, Veröffentlichung, neue Version, Archiv und Restore revisionssicher", async () => {
  const manager = session(MANAGER);
  const departmentManager = session(DEPARTMENT_MANAGER);
  const code = "catalog.lifecycle";
  const created = await request("/api/portal/v1/personnel-learning/modules", {
    method: "POST",
    auth: manager,
    body: template({ code }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.module.status, "draft");
  assert.equal(created.payload.module.latestVersionNumber, 1);
  assert.equal(created.payload.module.versions.length, 1);
  const moduleId = created.payload.module.id;

  const hiddenDraft = await request("/api/portal/v1/personnel-learning/modules", {
    auth: departmentManager,
  });
  assert.equal(hiddenDraft.response.status, 200, JSON.stringify(hiddenDraft.payload));
  assert.equal(hiddenDraft.payload.modules.some((module) => module.id === moduleId), false);

  const publishedV1 = await request(
    `/api/portal/v1/personnel-learning/modules/${encodeURIComponent(moduleId)}/publish`,
    {
      method: "POST",
      auth: manager,
      body: {
        versionNumber: 1,
        expectedEventReceipt: created.payload.module.currentEventReceipt,
      },
    },
  );
  assert.equal(publishedV1.response.status, 200, JSON.stringify(publishedV1.payload));
  assert.equal(publishedV1.payload.module.status, "published");

  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, 'personnel:learning:audit:read', ?)
  `).run(DEPARTMENT_MANAGER, DEVELOPER);
  const visiblePublished = await request("/api/portal/v1/personnel-learning/modules", {
    auth: departmentManager,
  });
  const readerProjection = visiblePublished.payload.modules.find((module) => module.id === moduleId);
  assert.equal(readerProjection.status, "published");
  assert.equal(readerProjection.currentEventReceipt, null);
  assert.equal(readerProjection.versions.length, 1);
  assert.equal("receiptSha256" in readerProjection.versions[0], false);
  assert.equal(readerProjection.history.some((event) => "actorId" in event), false);

  const versionTwo = await request(
    `/api/portal/v1/personnel-learning/modules/${encodeURIComponent(moduleId)}/versions`,
    {
      method: "POST",
      auth: manager,
      body: {
        ...template({
          code,
          title: "Kassasystem und Tagesabschluss sicher bedienen",
          objective: "Kassenabläufe und Tagesabschluss sicher durchführen.",
          versionNote: "Tagesabschluss ergänzt",
        }),
        expectedEventReceipt: publishedV1.payload.module.currentEventReceipt,
      },
    },
  );
  assert.equal(versionTwo.response.status, 200, JSON.stringify(versionTwo.payload));
  assert.equal(versionTwo.payload.module.status, "published_with_draft");
  assert.equal(versionTwo.payload.module.latestVersionNumber, 2);
  assert.equal(versionTwo.payload.module.publishedVersionNumber, 1);

  const readerStillSeesV1 = await request("/api/portal/v1/personnel-learning/modules", {
    auth: departmentManager,
  });
  const readerV1 = readerStillSeesV1.payload.modules.find((module) => module.id === moduleId);
  assert.equal(readerV1.latestVersionNumber, 1);
  assert.equal(readerV1.latestVersion.title, "Kassasystem sicher bedienen");
  assert.equal(readerV1.status, "published");

  const stale = await request(
    `/api/portal/v1/personnel-learning/modules/${encodeURIComponent(moduleId)}/archive`,
    {
      method: "POST",
      auth: manager,
      body: { expectedEventReceipt: publishedV1.payload.module.currentEventReceipt },
    },
  );
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.code, "PERSONNEL_LEARNING_CONCURRENT_CHANGE");

  const publishedV2 = await request(
    `/api/portal/v1/personnel-learning/modules/${encodeURIComponent(moduleId)}/publish`,
    {
      method: "POST",
      auth: manager,
      body: {
        versionNumber: 2,
        expectedEventReceipt: versionTwo.payload.module.currentEventReceipt,
      },
    },
  );
  assert.equal(publishedV2.response.status, 200, JSON.stringify(publishedV2.payload));
  const archived = await request(
    `/api/portal/v1/personnel-learning/modules/${encodeURIComponent(moduleId)}/archive`,
    {
      method: "POST",
      auth: manager,
      body: { expectedEventReceipt: publishedV2.payload.module.currentEventReceipt },
    },
  );
  assert.equal(archived.response.status, 200, JSON.stringify(archived.payload));
  assert.equal(archived.payload.module.archived, true);
  const hiddenArchive = await request("/api/portal/v1/personnel-learning/modules", {
    auth: departmentManager,
  });
  assert.equal(hiddenArchive.payload.modules.some((module) => module.id === moduleId), false);

  const restored = await request(
    `/api/portal/v1/personnel-learning/modules/${encodeURIComponent(moduleId)}/restore`,
    {
      method: "POST",
      auth: manager,
      body: { expectedEventReceipt: archived.payload.module.currentEventReceipt },
    },
  );
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.module.status, "published");
  assert.deepEqual(
    db.prepare(`
      SELECT event_type
      FROM personnel_learning_module_events
      WHERE module_id = ?
      ORDER BY sequence_number
    `).all(moduleId).map((row) => row.event_type),
    ["created", "version_added", "published", "version_added", "published", "archived", "restored"],
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_learning_module_versions
    WHERE module_id = ?
  `).get(moduleId).count, 2);
  const auditRows = db.prepare(`
    SELECT action, detail
    FROM audit_log
    WHERE entity_type = 'personnel_learning_module' AND entity_id = ?
    ORDER BY id
  `).all(moduleId);
  assert.deepEqual(auditRows.map((row) => row.action), [
    "personnel.learning.module.create",
    "personnel.learning.module.publish",
    "personnel.learning.module.version.add",
    "personnel.learning.module.publish",
    "personnel.learning.module.archive",
    "personnel.learning.module.restore",
  ]);
  assert.equal(auditRows.some((row) => row.detail.includes("Kassasystem")), false);
});

test("FL und AL verwalten nur ihren erlaubten Katalogbereich; IT erhält keinen Fachzugriff", async () => {
  const departmentManager = session(DEPARTMENT_MANAGER);
  const foreignManager = session(FOREIGN_MANAGER);
  const itAdmin = session(IT_ADMIN);
  const catalog = await request("/api/portal/v1/personnel-learning/modules", {
    auth: departmentManager,
  });
  assert.equal(catalog.response.status, 200, JSON.stringify(catalog.payload));
  assert.deepEqual(catalog.payload.scopes.map((scope) => ({
    type: scope.type,
    locationId: scope.locationId,
    departmentId: scope.departmentId,
  })), [{
    type: "department",
    locationId: LOCATION_A,
    departmentId: departmentA,
  }]);

  const code = "catalog.department";
  const created = await request("/api/portal/v1/personnel-learning/modules", {
    method: "POST",
    auth: departmentManager,
    body: template({
      code,
      scope: { type: "department", locationId: LOCATION_A, departmentId: departmentA },
    }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));

  const locationEscape = await request("/api/portal/v1/personnel-learning/modules", {
    method: "POST",
    auth: departmentManager,
    body: template({ code: "catalog.scope-escape" }),
  });
  assert.equal(locationEscape.response.status, 403, JSON.stringify(locationEscape.payload));
  assert.equal(locationEscape.payload.code, "PERSONNEL_LEARNING_CATALOG_SCOPE_DENIED");

  const foreignCatalog = await request("/api/portal/v1/personnel-learning/modules", {
    auth: foreignManager,
  });
  assert.equal(foreignCatalog.response.status, 200, JSON.stringify(foreignCatalog.payload));
  assert.equal(foreignCatalog.payload.modules.some((module) => module.id === created.payload.module.id), false);
  const foreignEdit = await request(
    `/api/portal/v1/personnel-learning/modules/${encodeURIComponent(created.payload.module.id)}/versions`,
    {
      method: "POST",
      auth: foreignManager,
      body: {
        ...template({
          code,
          scope: { type: "department", locationId: LOCATION_B, departmentId: departmentB },
        }),
        expectedEventReceipt: created.payload.module.currentEventReceipt,
      },
    },
  );
  assert.equal(foreignEdit.response.status, 403, JSON.stringify(foreignEdit.payload));
  assert.equal(foreignEdit.payload.code, "PERSONNEL_LEARNING_CATALOG_SCOPE_DENIED");

  const technicalAttempt = await request("/api/portal/v1/personnel-learning/modules", {
    auth: itAdmin,
  });
  assert.equal(technicalAttempt.response.status, 403, JSON.stringify(technicalAttempt.payload));
});

test("Learning-Katalog koppelt fachliches Ereignis und Betriebsaudit atomar", async () => {
  const before = {
    modules: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_modules").get().count,
    versions: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_module_versions").get().count,
    events: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_module_events").get().count,
  };
  db.exec(`
    CREATE TRIGGER test_personnel_learning_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'personnel.learning.module.create'
    BEGIN
      SELECT RAISE(ABORT, 'test personnel learning audit failure');
    END;
  `);
  try {
    const failed = await request("/api/portal/v1/personnel-learning/modules", {
      method: "POST",
      auth: session(MANAGER),
      body: template({ code: "catalog.atomic-rollback" }),
    });
    assert.equal(failed.response.status, 500, JSON.stringify(failed.payload));
  } finally {
    db.exec("DROP TRIGGER test_personnel_learning_audit_failure");
  }
  assert.deepEqual({
    modules: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_modules").get().count,
    versions: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_module_versions").get().count,
    events: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_module_events").get().count,
  }, before);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_learning_modules
    WHERE module_code = 'catalog.atomic-rollback'
  `).get().count, 0);
});

test("Fähigkeitskatalog führt zehn Stufen getrennt von Prozessvorlagen und versioniert", async () => {
  const manager = session(MANAGER);
  const code = "skill.drone.practice";
  const created = await request("/api/portal/v1/personnel-learning/skills", {
    method: "POST",
    auth: manager,
    body: skill({ code }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const skillId = created.payload.skill.id;
  assert.equal(created.payload.skill.skillCode, code);
  assert.equal(created.payload.skill.latestVersion.content.levelDefinitions.length, 10);
  assert.deepEqual(
    created.payload.skill.latestVersion.content.levelDefinitions.map((entry) => entry.level),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );

  const [processCatalog, skillCatalog] = await Promise.all([
    request("/api/portal/v1/personnel-learning/modules", { auth: manager }),
    request("/api/portal/v1/personnel-learning/skills", { auth: manager }),
  ]);
  assert.equal(processCatalog.response.status, 200, JSON.stringify(processCatalog.payload));
  assert.equal(skillCatalog.response.status, 200, JSON.stringify(skillCatalog.payload));
  assert.equal(processCatalog.payload.modules.some((entry) => entry.id === skillId), false);
  assert.equal(skillCatalog.payload.skills.some((entry) => entry.id === skillId), true);

  const crossContract = await request(
    `/api/portal/v1/personnel-learning/modules/${encodeURIComponent(skillId)}/versions`,
    {
      method: "POST",
      auth: manager,
      body: {
        ...template({ code }),
        expectedEventReceipt: created.payload.skill.currentEventReceipt,
      },
    },
  );
  assert.equal(crossContract.response.status, 404, JSON.stringify(crossContract.payload));
  assert.equal(crossContract.payload.code, "PERSONNEL_LEARNING_MODULE_NOT_FOUND");

  const published = await request(
    `/api/portal/v1/personnel-learning/skills/${encodeURIComponent(skillId)}/publish`,
    {
      method: "POST",
      auth: manager,
      body: {
        expectedEventReceipt: created.payload.skill.currentEventReceipt,
        versionNumber: 1,
      },
    },
  );
  assert.equal(published.response.status, 200, JSON.stringify(published.payload));
  assert.equal(published.payload.skill.status, "published");

  const nextLevels = skillLevels();
  nextLevels[4] = {
    level: 5,
    label: "Stufe 5 · selbstständig",
    description: "Plant und führt einen vollständigen Praxiseinsatz selbstständig durch.",
  };
  const changed = await request(
    `/api/portal/v1/personnel-learning/skills/${encodeURIComponent(skillId)}/versions`,
    {
      method: "POST",
      auth: manager,
      body: {
        ...skill({ code, levelDefinitions: nextLevels, versionNote: "Stufe 5 präzisiert" }),
        expectedEventReceipt: published.payload.skill.currentEventReceipt,
      },
    },
  );
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.equal(changed.payload.skill.status, "published_with_draft");
  assert.equal(changed.payload.skill.latestVersion.content.levelDefinitions[4].label,
    "Stufe 5 · selbstständig");
  assert.equal(changed.payload.skill.publishedVersion.content.levelDefinitions[4].label,
    "Stufe 5");

  const publishedV2 = await request(
    `/api/portal/v1/personnel-learning/skills/${encodeURIComponent(skillId)}/publish`,
    {
      method: "POST",
      auth: manager,
      body: {
        expectedEventReceipt: changed.payload.skill.currentEventReceipt,
        versionNumber: 2,
      },
    },
  );
  assert.equal(publishedV2.response.status, 200, JSON.stringify(publishedV2.payload));
  assert.equal(publishedV2.payload.skill.status, "published");
  const archived = await request(
    `/api/portal/v1/personnel-learning/skills/${encodeURIComponent(skillId)}/archive`,
    {
      method: "POST",
      auth: manager,
      body: { expectedEventReceipt: publishedV2.payload.skill.currentEventReceipt },
    },
  );
  assert.equal(archived.response.status, 200, JSON.stringify(archived.payload));
  assert.equal(archived.payload.skill.status, "archived");
  const restored = await request(
    `/api/portal/v1/personnel-learning/skills/${encodeURIComponent(skillId)}/restore`,
    {
      method: "POST",
      auth: manager,
      body: { expectedEventReceipt: archived.payload.skill.currentEventReceipt },
    },
  );
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.skill.status, "published");

  const auditRows = db.prepare(`
    SELECT action, detail
    FROM audit_log
    WHERE entity_type = 'personnel_learning_skill' AND entity_id = ?
    ORDER BY id
  `).all(skillId);
  assert.deepEqual(auditRows.map((row) => row.action), [
    "personnel.learning.skill.create",
    "personnel.learning.skill.publish",
    "personnel.learning.skill.version.add",
    "personnel.learning.skill.publish",
    "personnel.learning.skill.archive",
    "personnel.learning.skill.restore",
  ]);
  assert.equal(auditRows.some((row) => row.detail.includes("Drohnen")), false);
});

test("Fähigkeitskatalog prüft Stufen und Geltungsbereich fail-closed und audit-atomar", async () => {
  const manager = session(MANAGER);
  const departmentManager = session(DEPARTMENT_MANAGER);
  const itAdmin = session(IT_ADMIN);
  const invalidLevels = await request("/api/portal/v1/personnel-learning/skills", {
    method: "POST",
    auth: manager,
    body: skill({ code: "skill.invalid-levels", levelDefinitions: skillLevels().slice(0, 9) }),
  });
  assert.equal(invalidLevels.response.status, 400, JSON.stringify(invalidLevels.payload));
  assert.equal(invalidLevels.payload.code, "PERSONNEL_LEARNING_SKILL_LEVELS_INVALID");

  const escapedScope = await request("/api/portal/v1/personnel-learning/skills", {
    method: "POST",
    auth: departmentManager,
    body: skill({ code: "skill.scope-escape" }),
  });
  assert.equal(escapedScope.response.status, 403, JSON.stringify(escapedScope.payload));
  assert.equal(escapedScope.payload.code, "PERSONNEL_LEARNING_CATALOG_SCOPE_DENIED");

  const technicalAttempt = await request("/api/portal/v1/personnel-learning/skills", {
    auth: itAdmin,
  });
  assert.equal(technicalAttempt.response.status, 403, JSON.stringify(technicalAttempt.payload));

  const before = {
    modules: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_modules").get().count,
    versions: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_module_versions").get().count,
    events: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_module_events").get().count,
  };
  db.exec(`
    CREATE TRIGGER test_personnel_learning_skill_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'personnel.learning.skill.create'
    BEGIN
      SELECT RAISE(ABORT, 'test personnel learning skill audit failure');
    END;
  `);
  try {
    const failed = await request("/api/portal/v1/personnel-learning/skills", {
      method: "POST",
      auth: manager,
      body: skill({ code: "skill.atomic-rollback" }),
    });
    assert.equal(failed.response.status, 500, JSON.stringify(failed.payload));
  } finally {
    db.exec("DROP TRIGGER test_personnel_learning_skill_audit_failure");
  }
  assert.deepEqual({
    modules: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_modules").get().count,
    versions: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_module_versions").get().count,
    events: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_module_events").get().count,
  }, before);
});

test("Block 4 verwaltet mehrere Kompetenzstufen und Trainerfreigaben revisions- und versionsgebunden", async () => {
  const manager = session(MANAGER);
  const firstSkill = await createPublishedSkill(
    manager,
    "competency.tradefoto",
    { title: "TradeFoto und Kassasystem" },
  );
  const secondSkill = await createPublishedSkill(
    manager,
    "competency.drone",
    { title: "Drohnen inklusive Praxis" },
  );

  const assignedFirst = await request(
    `/api/portal/v1/personnel-learning/competencies/${DEPARTMENT_MANAGER}/${encodeURIComponent(firstSkill.id)}`,
    {
      method: "PUT",
      auth: manager,
      body: { level: 4, trainerAuthorized: true },
    },
  );
  assert.equal(assignedFirst.response.status, 201, JSON.stringify(assignedFirst.payload));
  assert.equal(assignedFirst.payload.competency.level, 4);
  assert.equal(assignedFirst.payload.competency.trainerAuthorized, true);
  assert.equal(assignedFirst.payload.competency.skillVersionNumber, 1);

  const assignedSecond = await request(
    `/api/portal/v1/personnel-learning/competencies/${DEPARTMENT_MANAGER}/${encodeURIComponent(secondSkill.id)}`,
    {
      method: "PUT",
      auth: manager,
      body: { level: 7, trainerAuthorized: false },
    },
  );
  assert.equal(assignedSecond.response.status, 201, JSON.stringify(assignedSecond.payload));

  const catalog = await request("/api/portal/v1/personnel-learning/competencies", {
    auth: manager,
  });
  assert.equal(catalog.response.status, 200, JSON.stringify(catalog.payload));
  assert.equal(catalog.payload.capabilities.canWriteAssignments, true);
  assert.equal(catalog.payload.competencies.filter((entry) => (
    entry.employeeNumber === DEPARTMENT_MANAGER
  )).length, 2);
  assert.equal(catalog.payload.summary.trainers >= 1, true);

  const updated = await request(
    `/api/portal/v1/personnel-learning/competencies/${DEPARTMENT_MANAGER}/${encodeURIComponent(firstSkill.id)}`,
    {
      method: "PUT",
      auth: manager,
      body: {
        level: 5,
        trainerAuthorized: false,
        expectedRevisionReceipt: assignedFirst.payload.competency.currentRevisionReceipt,
      },
    },
  );
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.competency.revisionNumber, 2);

  const newLevels = skillLevels(" · V2");
  const newVersion = await request(
    `/api/portal/v1/personnel-learning/skills/${encodeURIComponent(firstSkill.id)}/versions`,
    {
      method: "POST",
      auth: manager,
      body: {
        ...skill({
          code: firstSkill.skillCode,
          title: "TradeFoto und Kassasystem",
          levelDefinitions: newLevels,
          versionNote: "Kompetenzleiter V2",
        }),
        expectedEventReceipt: firstSkill.currentEventReceipt,
      },
    },
  );
  assert.equal(newVersion.response.status, 200, JSON.stringify(newVersion.payload));
  const publishedV2 = await request(
    `/api/portal/v1/personnel-learning/skills/${encodeURIComponent(firstSkill.id)}/publish`,
    {
      method: "POST",
      auth: manager,
      body: {
        versionNumber: 2,
        expectedEventReceipt: newVersion.payload.skill.currentEventReceipt,
      },
    },
  );
  assert.equal(publishedV2.response.status, 200, JSON.stringify(publishedV2.payload));

  const unchangedBinding = await request("/api/portal/v1/personnel-learning/competencies", {
    auth: manager,
  });
  const beforeReassessment = unchangedBinding.payload.competencies.find((entry) => (
    entry.employeeNumber === DEPARTMENT_MANAGER && entry.skillId === firstSkill.id
  ));
  assert.equal(beforeReassessment.skillVersionNumber, 1);
  assert.equal(beforeReassessment.currentPublishedVersionNumber, 2);
  assert.equal(beforeReassessment.usesCurrentPublishedVersion, false);

  const reassessed = await request(
    `/api/portal/v1/personnel-learning/competencies/${DEPARTMENT_MANAGER}/${encodeURIComponent(firstSkill.id)}`,
    {
      method: "PUT",
      auth: manager,
      body: {
        level: 6,
        trainerAuthorized: true,
        expectedRevisionReceipt: beforeReassessment.currentRevisionReceipt,
      },
    },
  );
  assert.equal(reassessed.response.status, 200, JSON.stringify(reassessed.payload));
  assert.equal(reassessed.payload.competency.skillVersionNumber, 2);
  assert.equal(reassessed.payload.competency.levelDefinition.label, "Stufe 6 · V2");

  const stale = await request(
    `/api/portal/v1/personnel-learning/competencies/${DEPARTMENT_MANAGER}/${encodeURIComponent(firstSkill.id)}`,
    {
      method: "PUT",
      auth: manager,
      body: {
        level: 6,
        trainerAuthorized: false,
        expectedRevisionReceipt: updated.payload.competency.currentRevisionReceipt,
      },
    },
  );
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.code, "PERSONNEL_LEARNING_COMPETENCY_CONCURRENT_CHANGE");

  const withdrawn = await request(
    `/api/portal/v1/personnel-learning/competencies/${DEPARTMENT_MANAGER}/${encodeURIComponent(firstSkill.id)}`,
    {
      method: "PUT",
      auth: manager,
      body: {
        active: false,
        expectedRevisionReceipt: reassessed.payload.competency.currentRevisionReceipt,
      },
    },
  );
  assert.equal(withdrawn.response.status, 200, JSON.stringify(withdrawn.payload));
  assert.equal(withdrawn.payload.competency.active, false);
  assert.equal(withdrawn.payload.competency.trainerAuthorized, false);

  const restored = await request(
    `/api/portal/v1/personnel-learning/competencies/${DEPARTMENT_MANAGER}/${encodeURIComponent(firstSkill.id)}`,
    {
      method: "PUT",
      auth: manager,
      body: {
        active: true,
        level: 8,
        trainerAuthorized: true,
        expectedRevisionReceipt: withdrawn.payload.competency.currentRevisionReceipt,
      },
    },
  );
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.deepEqual({
    active: restored.payload.competency.active,
    level: restored.payload.competency.level,
    trainerAuthorized: restored.payload.competency.trainerAuthorized,
    revisionNumber: restored.payload.competency.revisionNumber,
  }, { active: true, level: 8, trainerAuthorized: true, revisionNumber: 5 });

  const audits = db.prepare(`
    SELECT action, detail
    FROM audit_log
    WHERE entity_type = 'personnel_learning_employee_competency'
      AND entity_id = ?
    ORDER BY id
  `).all(restored.payload.competency.id);
  assert.deepEqual(audits.map((row) => row.action), [
    "personnel.learning.competency.assign",
    "personnel.learning.competency.update",
    "personnel.learning.competency.update",
    "personnel.learning.competency.withdraw",
    "personnel.learning.competency.restore",
  ]);
  assert.equal(audits.some((row) => /TradeFoto|Drohnen|Alina/.test(row.detail)), false);

  const itAttempt = await request("/api/portal/v1/personnel-learning/competencies", {
    auth: session(IT_ADMIN),
  });
  assert.equal(itAttempt.response.status, 403, JSON.stringify(itAttempt.payload));
});

test("Block 4 begrenzt entzogenes filialübergreifendes Recht und koppelt Fachaudit atomar", async () => {
  const manager = session(MANAGER);
  const atomicSkill = await createPublishedSkill(
    manager,
    "competency.atomic",
    { title: "Analoger Filmprozess" },
  );
  const before = {
    competencies: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_employee_competencies").get().count,
    revisions: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_employee_competency_revisions").get().count,
  };
  db.exec(`
    CREATE TRIGGER test_personnel_learning_competency_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'personnel.learning.competency.assign'
    BEGIN
      SELECT RAISE(ABORT, 'test personnel learning competency audit failure');
    END;
  `);
  try {
    const failed = await request(
      `/api/portal/v1/personnel-learning/competencies/${MANAGER}/${encodeURIComponent(atomicSkill.id)}`,
      {
        method: "PUT",
        auth: manager,
        body: { level: 3, trainerAuthorized: false },
      },
    );
    assert.equal(failed.response.status, 500, JSON.stringify(failed.payload));
  } finally {
    db.exec("DROP TRIGGER test_personnel_learning_competency_audit_failure");
  }
  assert.deepEqual({
    competencies: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_employee_competencies").get().count,
    revisions: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_employee_competency_revisions").get().count,
  }, before);

  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, 'personnel:learning:cross_location:assign', ?)
  `).run(DEPARTMENT_MANAGER, MANAGER);
  db.prepare(`
    INSERT INTO personnel_learning_permission_denial_authorities (
      employee_number, permission, authority_level, scope_location_id,
      denied_by, created_at, updated_at, revision
    ) VALUES (
      ?, 'personnel:learning:cross_location:assign', 'manager', ?, ?,
      '2026-08-18T15:00:00.000Z', '2026-08-18T15:00:00.000Z', 1
    )
  `).run(DEPARTMENT_MANAGER, LOCATION_A, MANAGER);
  const departmentManagerCatalog = await request(
    "/api/portal/v1/personnel-learning/competencies",
    { auth: session(DEPARTMENT_MANAGER) },
  );
  assert.equal(departmentManagerCatalog.response.status, 200, JSON.stringify(departmentManagerCatalog.payload));
  assert.equal(departmentManagerCatalog.payload.capabilities.canAssignCrossLocation, false);
  assert.equal(departmentManagerCatalog.payload.employees.some((employee) => (
    employee.employeeNumber === FOREIGN_MANAGER
  )), false);
  assert.equal(departmentManagerCatalog.payload.employees.every((employee) => (
    employee.locationId === LOCATION_A
      && Number(employee.departmentId || 0) === departmentA
  )), true);
});

test("Block 5 weist Lernende filialübergreifend mehreren exakten Trainerfähigkeiten zu", async () => {
  const developer = session(DEVELOPER);
  const manager = session(MANAGER);
  const process = await createPublishedProcess(
    developer,
    "assignment.cross-location.process",
    {
      title: "Filialübergreifende Foto-Praxisschulung",
      scope: { type: "organization", locationId: null, departmentId: null },
    },
  );
  const droneSkill = await createPublishedSkill(
    developer,
    "assignment.cross-location.drone",
    {
      title: "Drohnen inklusive Praxis",
      scope: { type: "organization", locationId: null, departmentId: null },
    },
  );
  const analogSkill = await createPublishedSkill(
    developer,
    "assignment.cross-location.analog",
    {
      title: "Analogfilm",
      scope: { type: "organization", locationId: null, departmentId: null },
    },
  );
  const droneTrainer = await assignTrainerCompetency(
    manager,
    FOREIGN_MANAGER,
    droneSkill.id,
    8,
  );
  const analogTrainer = await assignTrainerCompetency(
    manager,
    FOREIGN_MANAGER,
    analogSkill.id,
    6,
  );

  const before = await request("/api/portal/v1/personnel-learning/assignments", {
    auth: manager,
  });
  assert.equal(before.response.status, 200, JSON.stringify(before.payload));
  assert.equal(before.payload.capabilities.canAssignCrossLocation, true);
  assert.equal(before.payload.trainers.filter((entry) => (
    entry.trainerEmployeeNumber === FOREIGN_MANAGER
  )).length >= 2, true);

  const created = await request("/api/portal/v1/personnel-learning/assignments", {
    method: "POST",
    auth: manager,
    body: {
      processId: process.id,
      learnerEmployeeNumber: DEPARTMENT_MANAGER,
      trainerCompetencyIds: [analogTrainer.id, droneTrainer.id],
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.deepEqual({
    active: created.payload.assignment.active,
    processVersionNumber: created.payload.assignment.processVersionNumber,
    revisionNumber: created.payload.assignment.revisionNumber,
    trainerBindings: created.payload.assignment.trainerBindings.length,
    trainerEmployees: new Set(created.payload.assignment.trainerBindings.map((entry) => (
      entry.trainerEmployeeNumber
    ))).size,
  }, {
    active: true,
    processVersionNumber: 1,
    revisionNumber: 1,
    trainerBindings: 2,
    trainerEmployees: 1,
  });
  assert.equal(created.payload.assignment.trainersCurrent, true);
  assert.equal(created.payload.assignment.trainerBindings.every((entry) => (
    entry.trainerLocationName.includes("Learning Filiale B")
  )), true);

  const duplicate = await request("/api/portal/v1/personnel-learning/assignments", {
    method: "POST",
    auth: manager,
    body: {
      processId: process.id,
      learnerEmployeeNumber: DEPARTMENT_MANAGER,
      trainerCompetencyIds: [droneTrainer.id],
    },
  });
  assert.equal(duplicate.response.status, 409, JSON.stringify(duplicate.payload));
  assert.equal(duplicate.payload.code, "PERSONNEL_LEARNING_ASSIGNMENT_ALREADY_EXISTS");

  const auditCountBeforeNoop = db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE entity_type = 'personnel_learning_assignment' AND entity_id = ?
  `).get(created.payload.assignment.id).count;
  const unchanged = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(created.payload.assignment.id)}`,
    {
      method: "PUT",
      auth: manager,
      body: {
        trainerCompetencyIds: [droneTrainer.id, analogTrainer.id],
        expectedRevisionReceipt: created.payload.assignment.currentRevisionReceipt,
      },
    },
  );
  assert.equal(unchanged.response.status, 200, JSON.stringify(unchanged.payload));
  assert.equal(unchanged.payload.assignment.revisionNumber, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE entity_type = 'personnel_learning_assignment' AND entity_id = ?
  `).get(created.payload.assignment.id).count, auditCountBeforeNoop);

  const processVersionTwo = await request(
    `/api/portal/v1/personnel-learning/modules/${encodeURIComponent(process.id)}/versions`,
    {
      method: "POST",
      auth: developer,
      body: {
        ...template({
          code: process.moduleCode,
          title: "Filialübergreifende Foto-Praxisschulung V2",
          objective: "Erweiterte Praxis sicher durchführen.",
          versionNote: "Praxis erweitert",
          scope: { type: "organization", locationId: null, departmentId: null },
        }),
        expectedEventReceipt: process.currentEventReceipt,
      },
    },
  );
  assert.equal(processVersionTwo.response.status, 200, JSON.stringify(processVersionTwo.payload));
  const processPublishedTwo = await request(
    `/api/portal/v1/personnel-learning/modules/${encodeURIComponent(process.id)}/publish`,
    {
      method: "POST",
      auth: developer,
      body: {
        versionNumber: 2,
        expectedEventReceipt: processVersionTwo.payload.module.currentEventReceipt,
      },
    },
  );
  assert.equal(processPublishedTwo.response.status, 200, JSON.stringify(processPublishedTwo.payload));

  const updatedTrainer = await request(
    `/api/portal/v1/personnel-learning/competencies/${FOREIGN_MANAGER}/${encodeURIComponent(droneSkill.id)}`,
    {
      method: "PUT",
      auth: manager,
      body: {
        level: 9,
        trainerAuthorized: true,
        expectedRevisionReceipt: droneTrainer.currentRevisionReceipt,
      },
    },
  );
  assert.equal(updatedTrainer.response.status, 200, JSON.stringify(updatedTrainer.payload));

  const staleBinding = await request("/api/portal/v1/personnel-learning/assignments", {
    auth: manager,
  });
  const staleAssignment = staleBinding.payload.assignments.find((entry) => (
    entry.id === created.payload.assignment.id
  ));
  assert.equal(staleAssignment.processVersionNumber, 1);
  assert.equal(staleAssignment.currentPublishedVersionNumber, 2);
  assert.equal(staleAssignment.usesCurrentPublishedVersion, false);
  assert.equal(staleAssignment.trainersCurrent, false);
  assert.equal(staleBinding.payload.summary.attentionRequired >= 1, true);
  assert.equal(staleAssignment.trainerBindings.some((entry) => (
    entry.competencyId === droneTrainer.id && !entry.usesCurrentCompetencyRevision
  )), true);

  const rebound = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(created.payload.assignment.id)}`,
    {
      method: "PUT",
      auth: manager,
      body: {
        trainerCompetencyIds: [droneTrainer.id, analogTrainer.id],
        expectedRevisionReceipt: staleAssignment.currentRevisionReceipt,
      },
    },
  );
  assert.equal(rebound.response.status, 200, JSON.stringify(rebound.payload));
  assert.equal(rebound.payload.assignment.revisionNumber, 2);
  assert.equal(rebound.payload.assignment.processVersionNumber, 1);
  assert.equal(rebound.payload.assignment.trainersCurrent, true);

  const staleUpdate = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(created.payload.assignment.id)}`,
    {
      method: "PUT",
      auth: manager,
      body: {
        trainerCompetencyIds: [droneTrainer.id],
        expectedRevisionReceipt: created.payload.assignment.currentRevisionReceipt,
      },
    },
  );
  assert.equal(staleUpdate.response.status, 409, JSON.stringify(staleUpdate.payload));
  assert.equal(staleUpdate.payload.code, "PERSONNEL_LEARNING_ASSIGNMENT_CONCURRENT_CHANGE");

  const cancelled = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(created.payload.assignment.id)}`,
    {
      method: "PUT",
      auth: manager,
      body: {
        active: false,
        expectedRevisionReceipt: rebound.payload.assignment.currentRevisionReceipt,
      },
    },
  );
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.payload));
  assert.equal(cancelled.payload.assignment.active, false);
  assert.equal(cancelled.payload.assignment.revisionNumber, 3);

  const restored = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(created.payload.assignment.id)}`,
    {
      method: "PUT",
      auth: manager,
      body: {
        active: true,
        trainerCompetencyIds: [droneTrainer.id, analogTrainer.id],
        expectedRevisionReceipt: cancelled.payload.assignment.currentRevisionReceipt,
      },
    },
  );
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.assignment.revisionNumber, 4);

  const audits = db.prepare(`
    SELECT action, detail FROM audit_log
    WHERE entity_type = 'personnel_learning_assignment' AND entity_id = ?
    ORDER BY id
  `).all(created.payload.assignment.id);
  assert.deepEqual(audits.map((row) => row.action), [
    "personnel.learning.assignment.assign",
    "personnel.learning.assignment.trainers.update",
    "personnel.learning.assignment.cancel",
    "personnel.learning.assignment.restore",
  ]);
  assert.equal(audits.some((row) => /Florian|Franz|Alina|Drohnen|Analogfilm/.test(row.detail)), false);
});

test("Block 5 setzt den filialübergreifenden Entzug auch für AL-Zuweisungen durch", async () => {
  const developer = session(DEVELOPER);
  const manager = session(MANAGER);
  const departmentManager = session(DEPARTMENT_MANAGER);
  const process = await createPublishedProcess(
    developer,
    "assignment.denied.process",
    {
      title: "Entzugsprüfung Schulungszuweisung",
      scope: { type: "organization", locationId: null, departmentId: null },
    },
  );
  const skillEntry = await createPublishedSkill(
    developer,
    "assignment.denied.skill",
    {
      title: "Systemkamera Video",
      scope: { type: "organization", locationId: null, departmentId: null },
    },
  );
  const foreignTrainer = await assignTrainerCompetency(
    manager,
    FOREIGN_MANAGER,
    skillEntry.id,
    9,
  );
  const catalog = await request("/api/portal/v1/personnel-learning/assignments", {
    auth: departmentManager,
  });
  assert.equal(catalog.response.status, 200, JSON.stringify(catalog.payload));
  assert.equal(catalog.payload.capabilities.canAssignCrossLocation, false);
  assert.equal(catalog.payload.trainers.some((entry) => (
    entry.trainerEmployeeNumber === FOREIGN_MANAGER
  )), false);
  const denied = await request("/api/portal/v1/personnel-learning/assignments", {
    method: "POST",
    auth: departmentManager,
    body: {
      processId: process.id,
      learnerEmployeeNumber: DEPARTMENT_MANAGER,
      trainerCompetencyIds: [foreignTrainer.id],
    },
  });
  assert.equal(denied.response.status, 409, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PERSONNEL_LEARNING_ASSIGNMENT_TRAINER_NOT_ELIGIBLE");
});

test("Block 6 führt Schrittfortschritt, Abschlussbewertung und begründete Korrekturen revisionssicher", async () => {
  const developer = session(DEVELOPER);
  const manager = session(MANAGER);
  const trainerAuth = session(BLOCK6_TRAINER);
  const learnerAuth = session(BLOCK6_LEARNER);
  const process = await createPublishedProcess(
    developer,
    "progress.practical.process",
    {
      title: "Drohnen-Praxis kontrolliert durchführen",
      scope: { type: "organization", locationId: null, departmentId: null },
      verificationMode: "practical_check",
      steps: [
        {
          title: "Sicherheitsprüfung vorbereiten",
          instruction: "Gerät, Umgebung und Freigaben prüfen.",
          completionCriteria: "Die Sicherheitsprüfung ist vollständig dokumentiert.",
          required: true,
        },
        {
          title: "Praxisflug durchführen",
          instruction: "Die vereinbarte Praxisübung kontrolliert durchführen.",
          completionCriteria: "Die Praxisübung wurde fachlich geprüft.",
          required: true,
        },
        {
          title: "Vertiefung besprechen",
          instruction: "Weiterführende Einsatzfälle besprechen.",
          completionCriteria: "Die optionale Vertiefung wurde besprochen.",
          required: false,
        },
      ],
    },
  );
  const skill = await createPublishedSkill(
    developer,
    "progress.practical.skill",
    {
      title: "Drohnen-Praxis schulen",
      scope: { type: "organization", locationId: null, departmentId: null },
    },
  );
  const trainerCompetency = await assignTrainerCompetency(
    manager,
    BLOCK6_TRAINER,
    skill.id,
    8,
  );
  const created = await request("/api/portal/v1/personnel-learning/assignments", {
    method: "POST",
    auth: manager,
    body: {
      processId: process.id,
      learnerEmployeeNumber: BLOCK6_LEARNER,
      trainerCompetencyIds: [trainerCompetency.id],
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const assignment = created.payload.assignment;
  const stepIds = assignment.progress.steps.map((step) => step.stepId);
  assert.equal(assignment.progress.status, "not_started");
  assert.equal(assignment.progress.percent, 0);
  assert.equal(stepIds.length, 3);

  const trainerView = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignment.id)}/progress`,
    { auth: trainerAuth },
  );
  assert.equal(trainerView.response.status, 200, JSON.stringify(trainerView.payload));
  assert.equal(trainerView.payload.assignment.participantRole, "trainer");
  assert.equal(trainerView.payload.assignment.progress.capabilities.canFinalize, true);
  const learnerView = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignment.id)}/progress`,
    { auth: learnerAuth },
  );
  assert.equal(learnerView.response.status, 200, JSON.stringify(learnerView.payload));
  assert.equal(learnerView.payload.assignment.participantRole, "learner");
  assert.equal(learnerView.payload.assignment.progress.capabilities.canFinalize, false);
  const unrelated = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignment.id)}/progress`,
    { auth: session(IT_ADMIN) },
  );
  assert.equal(unrelated.response.status, 403, JSON.stringify(unrelated.payload));

  const started = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignment.id)}/progress`,
    {
      method: "PUT",
      auth: learnerAuth,
      body: {
        expectedAssignmentRevisionReceipt: assignment.currentRevisionReceipt,
        expectedProgressRevisionReceipt: "",
        completedStepIds: [stepIds[0]],
        progressPercent: 100,
        finalized: false,
        result: "pending",
      },
    },
  );
  assert.equal(started.response.status, 200, JSON.stringify(started.payload));
  assert.equal(started.payload.assignment.progress.percent, 33);
  assert.equal(started.payload.assignment.progress.completedStepCount, 1);
  assert.equal(started.payload.assignment.progress.history[0].actorKind, "learner");

  const premature = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignment.id)}/progress`,
    {
      method: "PUT",
      auth: trainerAuth,
      body: {
        expectedAssignmentRevisionReceipt: assignment.currentRevisionReceipt,
        expectedProgressRevisionReceipt:
          started.payload.assignment.progress.currentRevisionReceipt,
        completedStepIds: [stepIds[0]],
        finalized: true,
        result: "passed",
      },
    },
  );
  assert.equal(premature.response.status, 400, JSON.stringify(premature.payload));
  assert.equal(
    premature.payload.code,
    "PERSONNEL_LEARNING_PROGRESS_REQUIRED_STEPS_INCOMPLETE",
  );

  const completed = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignment.id)}/progress`,
    {
      method: "PUT",
      auth: trainerAuth,
      body: {
        expectedAssignmentRevisionReceipt: assignment.currentRevisionReceipt,
        expectedProgressRevisionReceipt:
          started.payload.assignment.progress.currentRevisionReceipt,
        completedStepIds: stepIds.slice(0, 2),
        finalized: true,
        result: "passed",
        assessmentNote: "Die praktische Prüfung wurde sicher durchgeführt.",
      },
    },
  );
  assert.equal(completed.response.status, 200, JSON.stringify(completed.payload));
  assert.equal(completed.payload.assignment.progress.status, "completed_passed");
  assert.equal(completed.payload.assignment.progress.percent, 67);
  assert.equal(completed.payload.assignment.progress.revisionNumber, 2);

  const progressRowsAfterCompletion = db.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_learning_assignment_progress_revisions
    WHERE assignment_id = ?
  `).get(assignment.id).count;
  const noOp = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignment.id)}/progress`,
    {
      method: "PUT",
      auth: trainerAuth,
      body: {
        expectedAssignmentRevisionReceipt: assignment.currentRevisionReceipt,
        expectedProgressRevisionReceipt:
          completed.payload.assignment.progress.currentRevisionReceipt,
        completedStepIds: stepIds.slice(0, 2),
        finalized: true,
        result: "passed",
        assessmentNote: "Die praktische Prüfung wurde sicher durchgeführt.",
      },
    },
  );
  assert.equal(noOp.response.status, 200, JSON.stringify(noOp.payload));
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_learning_assignment_progress_revisions
    WHERE assignment_id = ?
  `).get(assignment.id).count, progressRowsAfterCompletion);

  const learnerCorrection = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignment.id)}/progress`,
    {
      method: "PUT",
      auth: learnerAuth,
      body: {
        expectedAssignmentRevisionReceipt: assignment.currentRevisionReceipt,
        expectedProgressRevisionReceipt:
          completed.payload.assignment.progress.currentRevisionReceipt,
        completedStepIds: stepIds,
        finalized: true,
        result: "follow_up_required",
        assessmentNote: "Unzulässiger Selbstabschluss.",
        correctionReason: "Sollte selbst geändert werden.",
      },
    },
  );
  assert.equal(learnerCorrection.response.status, 403, JSON.stringify(learnerCorrection.payload));
  assert.equal(
    learnerCorrection.payload.code,
    "PERSONNEL_LEARNING_PROGRESS_CORRECTION_DENIED",
  );

  const corrected = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignment.id)}/progress`,
    {
      method: "PUT",
      auth: trainerAuth,
      body: {
        expectedAssignmentRevisionReceipt: assignment.currentRevisionReceipt,
        expectedProgressRevisionReceipt:
          completed.payload.assignment.progress.currentRevisionReceipt,
        completedStepIds: stepIds,
        finalized: true,
        result: "follow_up_required",
        assessmentNote: "Ein Praxisdetail wird nochmals gemeinsam geübt.",
        correctionReason: "Bewertung nach fachlicher Rücksprache berichtigt.",
      },
    },
  );
  assert.equal(corrected.response.status, 200, JSON.stringify(corrected.payload));
  assert.equal(corrected.payload.assignment.progress.revisionNumber, 3);
  assert.equal(corrected.payload.assignment.progress.percent, 100);
  assert.equal(corrected.payload.assignment.progress.result, "follow_up_required");
  assert.equal(corrected.payload.assignment.progress.history[2].changeType, "corrected");

  const stale = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignment.id)}/progress`,
    {
      method: "PUT",
      auth: trainerAuth,
      body: {
        expectedAssignmentRevisionReceipt: assignment.currentRevisionReceipt,
        expectedProgressRevisionReceipt:
          completed.payload.assignment.progress.currentRevisionReceipt,
        completedStepIds: stepIds,
        finalized: true,
        result: "passed",
        correctionReason: "Veralteter Änderungsversuch.",
      },
    },
  );
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.code, "PERSONNEL_LEARNING_PROGRESS_CONCURRENT_CHANGE");

  const audits = db.prepare(`
    SELECT action, detail
    FROM audit_log
    WHERE entity_type = 'personnel_learning_assignment_progress' AND entity_id = ?
    ORDER BY id
  `).all(assignment.id);
  assert.deepEqual(audits.map((row) => row.action), [
    "personnel.learning.progress.record",
    "personnel.learning.progress.complete",
    "personnel.learning.progress.correct",
  ]);
  assert.equal(audits.some((row) => /praktische Prüfung|fachlicher Rücksprache/.test(row.detail)), false);

  const beforeAtomic = db.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_learning_assignment_progress_revisions
    WHERE assignment_id = ?
  `).get(assignment.id).count;
  db.exec(`
    CREATE TRIGGER test_personnel_learning_progress_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'personnel.learning.progress.correct'
    BEGIN
      SELECT RAISE(ABORT, 'test personnel learning progress audit failure');
    END;
  `);
  try {
    const failedCorrection = await request(
      `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignment.id)}/progress`,
      {
        method: "PUT",
        auth: trainerAuth,
        body: {
          expectedAssignmentRevisionReceipt: assignment.currentRevisionReceipt,
          expectedProgressRevisionReceipt:
            corrected.payload.assignment.progress.currentRevisionReceipt,
          completedStepIds: stepIds.slice(0, 2),
          finalized: true,
          result: "passed",
          assessmentNote: "Rollbacktest.",
          correctionReason: "Atomare Korrekturprüfung.",
        },
      },
    );
    assert.equal(failedCorrection.response.status, 500, JSON.stringify(failedCorrection.payload));
  } finally {
    db.exec("DROP TRIGGER test_personnel_learning_progress_audit_failure");
  }
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_learning_assignment_progress_revisions
    WHERE assignment_id = ?
  `).get(assignment.id).count, beforeAtomic);

  assert.throws(() => db.prepare(`
    UPDATE personnel_learning_assignment_progress_revisions
    SET result = 'passed'
    WHERE assignment_id = ? AND revision_number = 3
  `).run(assignment.id));
  assert.throws(() => db.prepare(`
    DELETE FROM personnel_learning_assignment_progress_revisions
    WHERE assignment_id = ? AND revision_number = 1
  `).run(assignment.id));
});

test("Block 5 koppelt Zuweisung und minimiertes Audit atomar", async () => {
  const developer = session(DEVELOPER);
  const manager = session(MANAGER);
  const process = await createPublishedProcess(
    developer,
    "assignment.atomic.process",
    {
      title: "Atomare Schulungszuweisung",
      scope: { type: "organization", locationId: null, departmentId: null },
    },
  );
  const skillEntry = await createPublishedSkill(
    developer,
    "assignment.atomic.skill",
    {
      title: "Fineart-Drucke",
      scope: { type: "organization", locationId: null, departmentId: null },
    },
  );
  const trainer = await assignTrainerCompetency(manager, FOREIGN_MANAGER, skillEntry.id, 7);
  const before = {
    assignments: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_assignments").get().count,
    revisions: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_assignment_revisions").get().count,
  };
  db.exec(`
    CREATE TRIGGER test_personnel_learning_assignment_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'personnel.learning.assignment.assign'
    BEGIN
      SELECT RAISE(ABORT, 'test personnel learning assignment audit failure');
    END;
  `);
  try {
    const failed = await request("/api/portal/v1/personnel-learning/assignments", {
      method: "POST",
      auth: manager,
      body: {
        processId: process.id,
        learnerEmployeeNumber: MANAGER,
        trainerCompetencyIds: [trainer.id],
      },
    });
    assert.equal(failed.response.status, 500, JSON.stringify(failed.payload));
  } finally {
    db.exec("DROP TRIGGER test_personnel_learning_assignment_audit_failure");
  }
  assert.deepEqual({
    assignments: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_assignments").get().count,
    revisions: db.prepare("SELECT COUNT(*) AS count FROM personnel_learning_assignment_revisions").get().count,
  }, before);
  const itAttempt = await request("/api/portal/v1/personnel-learning/assignments", {
    auth: session(IT_ADMIN),
  });
  assert.equal(itAttempt.response.status, 403, JSON.stringify(itAttempt.payload));
});

test("Block 8 sperrt das Schulungsdashboard ohne persönliche oder freigegebene Kontositzung", async () => {
  const anonymous = await request("/api/portal/v1/personnel-learning/dashboard");
  assert.equal(anonymous.response.status, 401, JSON.stringify(anonymous.payload));
  assert.equal(anonymous.payload.code, "PORTAL_LOGIN_REQUIRED");
});

test("Block 7 projiziert transparente Dashboards und den Fähigkeitsbaum standortgebunden", async () => {
  const developer = session(DEVELOPER);
  const manager = session(MANAGER);
  const learner = session(BLOCK6_LEARNER);
  const process = await createPublishedProcess(
    developer,
    "dashboard.transparent.process",
    {
      title: "Kassasystem transparent einschulen",
      scope: { type: "organization", locationId: null, departmentId: null },
      steps: [
        {
          title: "Grundfunktionen durchführen",
          instruction: "Die Grundfunktionen gemeinsam durchgehen.",
          completionCriteria: "Die Grundfunktionen wurden sicher durchgeführt.",
          required: true,
        },
        {
          title: "Sonderfall erklären",
          instruction: "Einen Sonderfall nachvollziehbar erklären.",
          completionCriteria: "Der Sonderfall wurde verstanden.",
          required: true,
        },
      ],
    },
  );
  const skillEntry = await createPublishedSkill(
    developer,
    "dashboard.transparent.skill",
    {
      title: "Kassasystem und Tagesabschluss",
      scope: { type: "organization", locationId: null, departmentId: null },
    },
  );
  const trainerCompetency = await assignTrainerCompetency(
    manager,
    BLOCK6_TRAINER,
    skillEntry.id,
    8,
  );
  const learnerCompetency = await request(
    `/api/portal/v1/personnel-learning/competencies/${BLOCK6_LEARNER}/${encodeURIComponent(skillEntry.id)}`,
    {
      method: "PUT",
      auth: manager,
      body: { level: 4, trainerAuthorized: false },
    },
  );
  assert.equal(learnerCompetency.response.status, 201, JSON.stringify(learnerCompetency.payload));
  const created = await request("/api/portal/v1/personnel-learning/assignments", {
    method: "POST",
    auth: manager,
    body: {
      processId: process.id,
      learnerEmployeeNumber: BLOCK6_LEARNER,
      trainerCompetencyIds: [trainerCompetency.id],
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const assignmentId = created.payload.assignment.id;
  const stepIds = created.payload.assignment.progress.steps.map((step) => step.stepId);

  const leadershipDashboard = await request(
    "/api/portal/v1/personnel-learning/dashboard",
    { auth: manager },
  );
  assert.equal(
    leadershipDashboard.response.status,
    200,
    JSON.stringify(leadershipDashboard.payload),
  );
  assert.equal(leadershipDashboard.payload.viewer.kind, "leadership");
  assert.equal(leadershipDashboard.payload.capabilities.canManageAssignments, true);
  assert.equal(leadershipDashboard.payload.assignments.some((entry) => (
    entry.id === assignmentId && entry.progress.status === "not_started"
  )), true);
  const learnerProfile = leadershipDashboard.payload.profiles.find((profile) => (
    profile.employee.employeeNumber === BLOCK6_LEARNER
  ));
  assert.ok(learnerProfile);
  const visibleSkill = learnerProfile.competencies.find((entry) => (
    entry.skillId === skillEntry.id
  ));
  assert.equal(visibleSkill.level, 4);
  assert.equal(visibleSkill.levelDefinitions.length, 10);
  assert.equal(visibleSkill.trainerAuthorized, false);

  const personalDashboard = await request(
    "/api/portal/v1/personnel-learning/dashboard",
    { auth: learner },
  );
  assert.equal(personalDashboard.response.status, 200, JSON.stringify(personalDashboard.payload));
  assert.equal(personalDashboard.payload.viewer.kind, "personal");
  assert.equal(personalDashboard.payload.capabilities.canViewTeam, false);
  assert.equal(personalDashboard.payload.assignments.every((entry) => (
    entry.learner.employeeNumber === BLOCK6_LEARNER
  )), true);
  assert.equal(personalDashboard.payload.profiles.every((profile) => (
    profile.employee.employeeNumber === BLOCK6_LEARNER
  )), true);

  const createdBranch = await request("/api/portal/v1/organization-accounts", {
    method: "POST",
    auth: developer,
    body: {
      loginName: BLOCK7_BRANCH_LOGIN,
      displayName: "Learning Filiale A",
      accountType: "branch",
      password: BLOCK7_BRANCH_PASSWORD,
      active: true,
      permissions: [],
      scopes: [{ locationId: LOCATION_A }],
    },
  });
  assert.equal(createdBranch.response.status, 201, JSON.stringify(createdBranch.payload));
  assert.equal(
    createdBranch.payload.account.permissions.includes(
      "personnel_learning:location:dashboard",
    ),
    true,
  );
  const branchLogin = await request("/api/portal/v1/auth/login", {
    method: "POST",
    body: { loginName: BLOCK7_BRANCH_LOGIN, password: BLOCK7_BRANCH_PASSWORD },
  });
  assert.equal(branchLogin.response.status, 200, JSON.stringify(branchLogin.payload));
  const branch = responseSession(branchLogin.response);
  const branchDashboard = await request(
    "/api/portal/v1/personnel-learning/dashboard",
    { auth: branch },
  );
  assert.equal(branchDashboard.response.status, 200, JSON.stringify(branchDashboard.payload));
  assert.equal(branchDashboard.payload.viewer.kind, "branch_account");
  assert.equal(branchDashboard.payload.capabilities.branchAccount, true);
  assert.equal(branchDashboard.payload.capabilities.canManageAssignments, false);
  assert.equal(branchDashboard.payload.assignments.every((entry) => (
    entry.learner.locationId === LOCATION_A
  )), true);
  assert.equal(branchDashboard.payload.profiles.every((profile) => (
    profile.employee.locationId === LOCATION_A
  )), true);
  const branchAssignment = branchDashboard.payload.assignments.find((entry) => (
    entry.id === assignmentId
  ));
  assert.ok(branchAssignment);
  assert.deepEqual(branchAssignment.progress.capabilities, {
    canRecord: true,
    canFinalize: false,
    canCorrect: false,
  });
  assert.equal(JSON.stringify(branchDashboard.payload).includes("changedBy"), false);
  assert.equal(JSON.stringify(branchDashboard.payload).includes("receiptSha256"), false);

  const recorded = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignmentId)}/progress`,
    {
      method: "PUT",
      auth: branch,
      body: {
        expectedAssignmentRevisionReceipt:
          branchAssignment.currentAssignmentRevisionReceipt,
        expectedProgressRevisionReceipt: "",
        completedStepIds: [stepIds[0]],
        finalized: false,
        result: "pending",
      },
    },
  );
  assert.equal(recorded.response.status, 200, JSON.stringify(recorded.payload));
  assert.equal(recorded.payload.assignment.participantRole, "branch_account");
  assert.equal(recorded.payload.assignment.progress.history[0].actorKind, "branch_account");

  const progressRevisionCount = () => Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM personnel_learning_assignment_progress_revisions
    WHERE assignment_id = ?
  `).get(assignmentId).count);
  const revisionsBeforeSecurityChecks = progressRevisionCount();
  const securityMutationBody = {
    expectedAssignmentRevisionReceipt:
      recorded.payload.assignment.currentAssignmentRevisionReceipt,
    expectedProgressRevisionReceipt:
      recorded.payload.assignment.progress.currentRevisionReceipt,
    completedStepIds: stepIds,
    finalized: false,
    result: "pending",
  };
  const missingCsrf = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignmentId)}/progress`,
    {
      method: "PUT",
      auth: branch,
      csrfToken: null,
      body: securityMutationBody,
    },
  );
  assert.equal(missingCsrf.response.status, 403, JSON.stringify(missingCsrf.payload));
  assert.equal(missingCsrf.payload.code, "PORTAL_CSRF_INVALID");
  const forgedCsrf = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignmentId)}/progress`,
    {
      method: "PUT",
      auth: branch,
      csrfToken: "x".repeat(branch.csrf.length),
      body: securityMutationBody,
    },
  );
  assert.equal(forgedCsrf.response.status, 403, JSON.stringify(forgedCsrf.payload));
  assert.equal(forgedCsrf.payload.code, "PORTAL_CSRF_INVALID");
  assert.equal(progressRevisionCount(), revisionsBeforeSecurityChecks);

  const branchAccountId = String(createdBranch.payload.account.id);
  db.exec(`
    CREATE TRIGGER test_block8_learning_branch_live_account
    AFTER UPDATE OF expires_at ON portal_organization_sessions
    WHEN NEW.account_id = '${branchAccountId}'
    BEGIN
      UPDATE portal_organization_accounts SET active = 0 WHERE id = NEW.account_id;
    END;
  `);
  let disabledDuringRequest;
  try {
    disabledDuringRequest = await request(
      `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignmentId)}/progress`,
      { method: "PUT", auth: branch, body: securityMutationBody },
    );
  } finally {
    db.exec("DROP TRIGGER test_block8_learning_branch_live_account");
    db.prepare("UPDATE portal_organization_accounts SET active = 1 WHERE id = ?")
      .run(branchAccountId);
  }
  assert.equal(
    disabledDuringRequest.response.status,
    403,
    JSON.stringify(disabledDuringRequest.payload),
  );

  db.exec(`
    CREATE TRIGGER test_block8_learning_branch_live_scope
    AFTER UPDATE OF expires_at ON portal_organization_sessions
    WHEN NEW.account_id = '${branchAccountId}'
    BEGIN
      DELETE FROM portal_organization_account_scopes WHERE account_id = NEW.account_id;
    END;
  `);
  let scopeRemovedDuringRequest;
  try {
    scopeRemovedDuringRequest = await request(
      `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignmentId)}/progress`,
      { method: "PUT", auth: branch, body: securityMutationBody },
    );
  } finally {
    db.exec("DROP TRIGGER test_block8_learning_branch_live_scope");
    db.prepare(`
      INSERT INTO portal_organization_account_scopes
        (account_id, location_id, department_id, assigned_by)
      VALUES (?, ?, 0, ?)
    `).run(branchAccountId, LOCATION_A, DEVELOPER);
  }
  assert.equal(
    scopeRemovedDuringRequest.response.status,
    403,
    JSON.stringify(scopeRemovedDuringRequest.payload),
  );
  assert.equal(progressRevisionCount(), revisionsBeforeSecurityChecks);

  const forbiddenCompletion = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignmentId)}/progress`,
    {
      method: "PUT",
      auth: branch,
      body: {
        expectedAssignmentRevisionReceipt:
          branchAssignment.currentAssignmentRevisionReceipt,
        expectedProgressRevisionReceipt:
          recorded.payload.assignment.progress.currentRevisionReceipt,
        completedStepIds: stepIds,
        finalized: true,
        result: "passed",
      },
    },
  );
  assert.equal(forbiddenCompletion.response.status, 403, JSON.stringify(forbiddenCompletion.payload));
  assert.equal(
    forbiddenCompletion.payload.code,
    "PERSONNEL_LEARNING_PROGRESS_FINALIZATION_DENIED",
  );

  const completed = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignmentId)}/progress`,
    {
      method: "PUT",
      auth: manager,
      body: {
        expectedAssignmentRevisionReceipt:
          recorded.payload.assignment.currentAssignmentRevisionReceipt,
        expectedProgressRevisionReceipt:
          recorded.payload.assignment.progress.currentRevisionReceipt,
        completedStepIds: stepIds,
        finalized: true,
        result: "passed",
        assessmentNote: "Die Schulungsziele wurden nachvollziehbar erreicht.",
      },
    },
  );
  assert.equal(completed.response.status, 200, JSON.stringify(completed.payload));
  assert.equal(completed.payload.assignment.progress.status, "completed_passed");

  const completedBranchDashboard = await request(
    "/api/portal/v1/personnel-learning/dashboard",
    { auth: branch },
  );
  assert.equal(
    completedBranchDashboard.response.status,
    200,
    JSON.stringify(completedBranchDashboard.payload),
  );
  const completedBranchAssignment = completedBranchDashboard.payload.assignments.find((entry) => (
    entry.id === assignmentId
  ));
  assert.ok(completedBranchAssignment);
  assert.deepEqual(completedBranchAssignment.progress.capabilities, {
    canRecord: false,
    canFinalize: false,
    canCorrect: false,
  });
  const forbiddenCorrection = await request(
    `/api/portal/v1/personnel-learning/assignments/${encodeURIComponent(assignmentId)}/progress`,
    {
      method: "PUT",
      auth: branch,
      body: {
        expectedAssignmentRevisionReceipt:
          completedBranchAssignment.currentAssignmentRevisionReceipt,
        expectedProgressRevisionReceipt:
          completedBranchAssignment.progress.currentRevisionReceipt,
        completedStepIds: stepIds,
        finalized: true,
        result: "follow_up_required",
        assessmentNote: "Unzulässige nachträgliche Änderung.",
        correctionReason: "Das Filialkonto darf keinen Abschluss korrigieren.",
      },
    },
  );
  assert.equal(forbiddenCorrection.response.status, 403, JSON.stringify(forbiddenCorrection.payload));
  assert.equal(
    forbiddenCorrection.payload.code,
    "PERSONNEL_LEARNING_PROGRESS_CORRECTION_DENIED",
  );

  const itDashboard = await request(
    "/api/portal/v1/personnel-learning/dashboard",
    { auth: session(IT_ADMIN) },
  );
  assert.equal(itDashboard.response.status, 200, JSON.stringify(itDashboard.payload));
  assert.equal(itDashboard.payload.assignments.length, 0);
  assert.equal(itDashboard.payload.profiles.length, 0);
});

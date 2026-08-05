"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  PERMISSION_IDS: EDITOR_PERMISSION_IDS,
  PERMISSIONS: E,
} = require("../lib/personnel-lifecycle-editor-contract");
const {
  PERSONNEL_LIFECYCLE_CASE_PERMISSIONS: P,
} = require("../lib/personnel-lifecycle-case-contract");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-o8-editor-api-"));
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

const CATALOG_ROUTE = "/api/portal/v1/personnel-lifecycle/editor/catalog";
const VALIDATE_ROUTE = "/api/portal/v1/personnel-lifecycle/editor/validate";
const EDITOR_VALIDATE_PERMISSIONS = Object.freeze([E.READ, E.DRAFT_WRITE, E.VALIDATE]);
const ONBOARDING_SOURCE_PERMISSIONS = Object.freeze([P.ONBOARDING_READ]);
const OFFBOARDING_SOURCE_PERMISSIONS = Object.freeze([
  P.OFFBOARDING_CONFIDENTIAL_READ,
  P.HR_CONFIDENTIAL_READ,
]);
const ELIGIBLE_ROLES = Object.freeze(["hr", "admin", "it_admin", "developer"]);

let httpServer;
let baseUrl;
let sessions;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function configuredInstallationFeatures() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'installation_features'").get();
  try {
    const parsed = JSON.parse(String(row?.value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function enablePersonnelLifecycle() {
  const features = configuredInstallationFeatures()
    .filter((feature) => feature !== "personnelLifecycle");
  features.push("personnelLifecycle");
  db.prepare("UPDATE settings SET value = ? WHERE key = 'installation_features'")
    .run(JSON.stringify(features));
}

function insertEmployee(employeeNumber, fullName) {
  db.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname, active)
    VALUES (?, ?, ?, 1)
  `).run(employeeNumber, fullName, fullName);
}

function createEmployeeSession(employeeNumber, role) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, role_locked, active,
      must_change_password, password_changed_at, updated_at
    ) VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, sha256(rawToken));
  return Object.freeze({
    cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
    csrf,
  });
}

function createOrganizationSession() {
  const accountId = crypto.randomUUID();
  const rawToken = crypto.randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO portal_organization_accounts (
      id, login_name, display_name, account_type, password_hash, active,
      must_change_password, created_by, updated_by
    ) VALUES (?, ?, 'O8 Shared Account', 'branch', 'test-only', 1, 0, 'test', 'test')
  `).run(accountId, `o8-shared-${accountId.slice(0, 8)}`);
  for (const permission of [
    ...EDITOR_PERMISSION_IDS,
    ...ONBOARDING_SOURCE_PERMISSIONS,
    ...OFFBOARDING_SOURCE_PERMISSIONS,
  ]) {
    db.prepare(`
      INSERT INTO portal_organization_account_permissions (
        account_id, permission, granted_by
      ) VALUES (?, ?, 'O8-API-TEST')
    `).run(accountId, permission);
  }
  db.prepare(`
    INSERT INTO portal_organization_sessions (id, account_id, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), accountId, sha256(rawToken));
  return Object.freeze({ cookie: `grabenplaner_session=${rawToken}` });
}

function grantPermissions(employeeNumber, permissions) {
  for (const permission of permissions) {
    db.prepare(`
      INSERT OR IGNORE INTO portal_permission_grants (
        employee_number, permission, granted_by
      ) VALUES (?, ?, 'O8-API-TEST')
    `).run(employeeNumber, permission);
  }
}

function createFixtures() {
  const definitions = Object.freeze([
    ["O8-HR-ROLE", "hr"],
    ["O8-IT-ROLE", "it_admin"],
    ["O8-DEV-ROLE", "developer"],
    ["O8-NO-SOURCE", "hr"],
    ["O8-ACTIONS", "hr"],
    ["O8-MANAGER", "manager"],
    ["O8-ONBOARDING", "hr"],
    ["O8-OFF-INCOMPLETE", "hr"],
    ["O8-BOTH", "admin"],
    ["O8-VALID-ON", "hr"],
    ["O8-VALID-OFF", "developer"],
  ]);
  const result = {};
  for (const [employeeNumber, role] of definitions) {
    insertEmployee(employeeNumber, `Synthetic ${employeeNumber}`);
    result[employeeNumber] = createEmployeeSession(employeeNumber, role);
  }
  grantPermissions("O8-NO-SOURCE", [E.READ]);
  grantPermissions("O8-ACTIONS", [E.DRAFT_WRITE, E.VALIDATE, ...ONBOARDING_SOURCE_PERMISSIONS]);
  grantPermissions("O8-MANAGER", [
    ...EDITOR_PERMISSION_IDS,
    ...ONBOARDING_SOURCE_PERMISSIONS,
  ]);
  grantPermissions("O8-ONBOARDING", [E.READ, ...ONBOARDING_SOURCE_PERMISSIONS]);
  grantPermissions("O8-OFF-INCOMPLETE", [E.READ, P.OFFBOARDING_CONFIDENTIAL_READ]);
  grantPermissions("O8-BOTH", [
    E.READ,
    ...ONBOARDING_SOURCE_PERMISSIONS,
    ...OFFBOARDING_SOURCE_PERMISSIONS,
  ]);
  grantPermissions("O8-VALID-ON", [
    ...EDITOR_VALIDATE_PERMISSIONS,
    ...ONBOARDING_SOURCE_PERMISSIONS,
  ]);
  grantPermissions("O8-VALID-OFF", [
    ...EDITOR_VALIDATE_PERMISSIONS,
    ...OFFBOARDING_SOURCE_PERMISSIONS,
  ]);
  result.organization = createOrganizationSession();
  enablePersonnelLifecycle();
  return Object.freeze(result);
}

function draft(workflowType = "onboarding", overrides = {}) {
  const offboarding = workflowType === "offboarding";
  return {
    draftId: `draft-${workflowType}-1`,
    workflowType,
    workflowCode: `${workflowType}.standard`,
    title: offboarding ? "Standard-Offboarding" : "Standard-Onboarding",
    description: "Fluechtiger Arbeitsentwurf.",
    scopeType: "company",
    requirementKind: "mandatory",
    steps: [
      {
        id: "prepare",
        type: "task",
        title: "Vorbereitung",
        description: "Aufgabe vorbereiten.",
        responsibilityClass: offboarding ? "offboarding_confidential" : "hr_case",
        required: true,
      },
      {
        id: "finish",
        type: "finish",
        title: "Abschluss",
        description: "Abschluss pruefen.",
        responsibilityClass: offboarding ? "hr_confidential" : "hr_case",
        required: true,
      },
    ],
    ...overrides,
  };
}

async function request(route, {
  method = "GET",
  auth = null,
  body,
  includeCsrf = true,
} = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && includeCsrf && !["GET", "HEAD"].includes(method)) {
    headers["X-CSRF-Token"] = auth.csrf;
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
  return { response, payload, text };
}

function assertNoStore(result) {
  assert.match(result.response.headers.get("cache-control") || "", /(?:^|,\s*)no-store(?:,|$)/i);
  assert.equal(result.response.headers.get("pragma"), "no-cache");
  assert.equal(result.response.headers.has("etag"), false);
}

function assertClosedGates(value) {
  assert.equal(Object.keys(value || {}).length, 11);
  assert.equal(Object.values(value).every((entry) => entry === false), true);
}

function protectedCounts() {
  const existing = new Set(db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map(({ name }) => name));
  const tables = [
    "custom_processes",
    "custom_process_steps",
    "custom_process_revisions",
    "custom_process_publications",
    "custom_process_publication_archives",
    "custom_process_runs",
    "custom_process_run_steps",
    "personnel_lifecycle_cases",
    "personnel_lifecycle_case_events",
    "portal_notifications",
    "outbound_notification_jobs",
    "integration_deliveries",
  ].filter((name) => existing.has(name));
  return Object.fromEntries(tables.map((tableName) => [
    tableName,
    db.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get().count,
  ]));
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  sessions = createFixtures();
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("O8-Katalog verlangt persönliche zentrale Rechte und filtert Quelltypen", async (t) => {
  const anonymous = await request(CATALOG_ROUTE);
  assert.equal(anonymous.response.status, 401, anonymous.text);
  assertNoStore(anonymous);

  for (const principal of [
    "O8-HR-ROLE",
    "O8-IT-ROLE",
    "O8-DEV-ROLE",
    "O8-NO-SOURCE",
    "O8-ACTIONS",
    "O8-MANAGER",
    "O8-OFF-INCOMPLETE",
    "organization",
  ]) {
    await t.test(`${principal} bleibt fail-closed`, async () => {
      const denied = await request(CATALOG_ROUTE, { auth: sessions[principal] });
      assert.equal(denied.response.status, 403, denied.text);
      assertNoStore(denied);
    });
  }

  const previousForcePortal = process.env.GRABENPLANER_FORCE_PORTAL;
  process.env.GRABENPLANER_FORCE_PORTAL = "0";
  try {
    const localSystem = await request(CATALOG_ROUTE);
    assert.equal(localSystem.response.status, 403, localSystem.text);
    assertNoStore(localSystem);
  } finally {
    process.env.GRABENPLANER_FORCE_PORTAL = previousForcePortal;
  }

  const onboarding = await request(CATALOG_ROUTE, { auth: sessions["O8-ONBOARDING"] });
  assert.equal(onboarding.response.status, 200, onboarding.text);
  assertNoStore(onboarding);
  assert.equal(onboarding.payload.contractVersion, "o8-v0.1");
  assert.equal(onboarding.payload.model, "linear-v1");
  assert.equal(onboarding.payload.mode, "memory_only");
  assert.equal(onboarding.payload.source, "memory");
  assert.deepEqual(onboarding.payload.workflowTypes, ["onboarding"]);
  assertClosedGates(onboarding.payload.runtimeGates);

  const both = await request(CATALOG_ROUTE, { auth: sessions["O8-BOTH"] });
  assert.equal(both.response.status, 200, both.text);
  assertNoStore(both);
  assert.deepEqual(both.payload.workflowTypes, ["onboarding", "offboarding"]);
});

test("alle sechs O8-Rechte sind katalogisiert, rollenberechtigt und ohne Autogrant", async () => {
  const result = await request("/api/portal/v1/roles");
  assert.equal(result.response.status, 200, result.text);
  const entries = (result.payload?.catalog || []).filter(({ id }) => (
    String(id).startsWith("personnel:lifecycle:editor:")
  ));
  assert.deepEqual(entries.map(({ id }) => id).sort(), [...EDITOR_PERMISSION_IDS].sort());
  for (const entry of entries) assert.deepEqual(entry.eligibleRoles, ELIGIBLE_ROLES, entry.id);
  for (const role of (result.payload?.roles || []).filter(({ builtin }) => builtin)) {
    assert.deepEqual(
      (role.permissions || []).filter((permission) => EDITOR_PERMISSION_IDS.includes(permission)),
      [],
      `Built-in-Rolle ${role.id} besitzt O8-Autogrants.`,
    );
  }
});

test("O8-Validierung trennt Rechte, CSRF und Onboarding-/Offboarding-Quellen", async (t) => {
  const anonymous = await request(VALIDATE_ROUTE, {
    method: "POST",
    body: draft(),
  });
  assert.equal(anonymous.response.status, 401, anonymous.text);
  assertNoStore(anonymous);

  const missingCsrf = await request(VALIDATE_ROUTE, {
    method: "POST",
    auth: sessions["O8-VALID-ON"],
    body: draft(),
    includeCsrf: false,
  });
  assert.equal(missingCsrf.response.status, 403, missingCsrf.text);
  assertNoStore(missingCsrf);

  const missingActionRights = await request(VALIDATE_ROUTE, {
    method: "POST",
    auth: sessions["O8-ONBOARDING"],
    body: draft(),
  });
  assert.equal(missingActionRights.response.status, 403, missingActionRights.text);
  assertNoStore(missingActionRights);

  for (const [principal, submittedDraft] of [
    ["O8-VALID-ON", draft("offboarding")],
    ["O8-VALID-OFF", draft("onboarding")],
  ]) {
    await t.test(`${principal} darf den fremden Quelltyp nicht prüfen`, async () => {
      const denied = await request(VALIDATE_ROUTE, {
        method: "POST",
        auth: sessions[principal],
        body: submittedDraft,
      });
      assert.equal(denied.response.status, 403, denied.text);
      assert.equal(denied.payload?.code, "PERSONNEL_LIFECYCLE_EDITOR_SOURCE_PERMISSION_REQUIRED");
      assertNoStore(denied);
    });
  }

  for (const [principal, submittedDraft, workflowType] of [
    ["O8-VALID-ON", draft("onboarding"), "onboarding"],
    ["O8-VALID-OFF", draft("offboarding"), "offboarding"],
  ]) {
    await t.test(`${workflowType} wird nur im Arbeitsspeicher geprüft`, async () => {
      const validated = await request(VALIDATE_ROUTE, {
        method: "POST",
        auth: sessions[principal],
        body: submittedDraft,
      });
      assert.equal(validated.response.status, 200, validated.text);
      assertNoStore(validated);
      assert.equal(validated.payload.contractVersion, "o8-v0.1");
      assert.equal(validated.payload.mode, "memory_only");
      assert.equal(validated.payload.source, "memory");
      assert.equal(validated.payload.valid, true);
      assert.equal(validated.payload.status, "ready");
      assert.equal(validated.payload.draft.workflowType, workflowType);
      assert.equal(validated.payload.nodes.length, 2);
      assert.equal(validated.payload.edges.length, 1);
      assert.match(validated.payload.fingerprint, /^[a-f0-9]{64}$/);
      assertClosedGates(validated.payload.runtimeGates);
    });
  }
});

test("strukturell feindliche Entwürfe werden mit 400 und ohne Textaudit abgewiesen", async () => {
  const unknownField = await request(VALIDATE_ROUTE, {
    method: "POST",
    auth: sessions["O8-VALID-ON"],
    body: { ...draft(), protectedPayload: { secret: "O8-DO-NOT-AUDIT" } },
  });
  assert.equal(unknownField.response.status, 400, unknownField.text);
  assert.equal(unknownField.payload?.code, "O8_FIELDS_INVALID");
  assertNoStore(unknownField);

  const reservedIdentifier = await request(VALIDATE_ROUTE, {
    method: "POST",
    auth: sessions["O8-VALID-ON"],
    body: draft("onboarding", {
      steps: [
        { ...draft().steps[0], id: "__proto__" },
        draft().steps[1],
      ],
    }),
  });
  assert.equal(reservedIdentifier.response.status, 400, reservedIdentifier.text);
  assert.equal(reservedIdentifier.payload?.code, "O8_RESERVED_IDENTIFIER");
  assertNoStore(reservedIdentifier);

  const auditSecret = "O8-AUDIT-SECRET-IMG";
  const valid = await request(VALIDATE_ROUTE, {
    method: "POST",
    auth: sessions["O8-VALID-ON"],
    body: draft("onboarding", { title: `${auditSecret} <img src=x onerror=alert(1)>` }),
  });
  assert.equal(valid.response.status, 200, valid.text);
  const audit = db.prepare(`
    SELECT detail FROM audit_log
    WHERE action = 'personnel-lifecycle.editor.draft.validate'
    ORDER BY id DESC LIMIT 1
  `).get();
  assert.ok(audit);
  assert.equal(String(audit.detail).includes(auditSecret), false);
  assert.deepEqual(Object.keys(JSON.parse(audit.detail)), ["blockerCount"]);
});

test("O8 besitzt keine Save-, Publish-, Run- oder Dispatch-Wirkung", async () => {
  const before = protectedCounts();
  const successfulValidation = await request(VALIDATE_ROUTE, {
    method: "POST",
    auth: sessions["O8-VALID-ON"],
    body: draft(),
  });
  assert.equal(successfulValidation.response.status, 200, successfulValidation.text);

  for (const [method, route] of [
    ["POST", CATALOG_ROUTE],
    ["PUT", "/api/portal/v1/personnel-lifecycle/editor/drafts/draft-onboarding-1"],
    ["PATCH", "/api/portal/v1/personnel-lifecycle/editor/drafts/draft-onboarding-1"],
    ["DELETE", "/api/portal/v1/personnel-lifecycle/editor/drafts/draft-onboarding-1"],
    ["POST", "/api/portal/v1/personnel-lifecycle/editor/save"],
    ["POST", "/api/portal/v1/personnel-lifecycle/editor/publish"],
    ["POST", "/api/portal/v1/personnel-lifecycle/editor/archive"],
    ["POST", "/api/portal/v1/personnel-lifecycle/editor/run"],
    ["POST", "/api/portal/v1/personnel-lifecycle/editor/dispatch"],
  ]) {
    const result = await request(route, {
      method,
      auth: sessions["O8-VALID-ON"],
      body: { action: "must-not-run", secret: "must-not-persist" },
    });
    assert.equal([404, 405].includes(result.response.status), true, `${method} ${route}: ${result.text}`);
  }
  assert.deepEqual(protectedCounts(), before);

  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("const PERSONNEL_LIFECYCLE_EDITOR_SOURCE_PERMISSIONS");
  const end = source.indexOf("function personnelProfileCanReadMasterProjection", start);
  const routeStart = source.indexOf(`app.get("${CATALOG_ROUTE}"`);
  const routeEnd = source.indexOf(`app.get("/api/portal/v1/personnel-lifecycle/automation/preview"`, routeStart);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);
  assert.doesNotMatch(`${source.slice(start, end)}${source.slice(routeStart, routeEnd)}`, /\/custom-processes|reconcileCustomProcessTriggers|createPersonnelWorkflow|start\(|dispatch/i);
});

test("O8-Rechteabhängigkeiten bilden die vollständige Freigabekette", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("PERSONNEL_LIFECYCLE_EDITOR_PERMISSIONS.DRAFT_WRITE");
  const end = source.indexOf("const portalDashboardPermissionDetails", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const dependencySource = source.slice(start, end);
  for (const permission of ["DRAFT_WRITE", "VALIDATE", "REVIEW", "PUBLISH", "ARCHIVE"]) {
    assert.match(dependencySource, new RegExp(`PERSONNEL_LIFECYCLE_EDITOR_PERMISSIONS\\.${permission}`));
  }
  assert.match(dependencySource, /DRAFT_WRITE,[\s\S]*READ/);
  assert.match(dependencySource, /VALIDATE,[\s\S]*DRAFT_WRITE/);
  assert.match(dependencySource, /REVIEW,[\s\S]*VALIDATE/);
  assert.match(dependencySource, /PUBLISH,[\s\S]*REVIEW/);
  assert.match(dependencySource, /ARCHIVE,[\s\S]*PUBLISH/);
});

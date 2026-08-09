"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS: B,
  PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS,
  PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSIONS: A,
  PERSONNEL_LIFECYCLE_AUTOMATION_READ_PERMISSIONS,
} = require("../lib/personnel-lifecycle-automation-contract");
const {
  PERSONNEL_LIFECYCLE_CASE_PERMISSIONS: P,
} = require("../lib/personnel-lifecycle-case-contract");
const {
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS,
} = require("../lib/personnel-lifecycle-offboarding-contract");

const ONBOARDING_MARKER = "O7-SYNTHETIC-ONBOARDING-TASK";
const OFFBOARDING_MARKER = "O7-SYNTHETIC-OFFBOARDING-TASK";
const serviceCalls = { onboarding: 0, offboarding: 0 };
const [offboardingFamily] = PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS;

const onboardingTasksModule = require("../lib/personnel-lifecycle-onboarding-tasks");
onboardingTasksModule.createPersonnelLifecycleOnboardingTaskService = () => Object.freeze({
  async listActiveTasks() {
    serviceCalls.onboarding += 1;
    return Object.freeze({
      items: Object.freeze([Object.freeze({
        caseId: "o7-synthetic-onboarding-case",
        runId: "o7-synthetic-onboarding-run",
        stepId: "o7-synthetic-onboarding-step",
        step: Object.freeze({ title: ONBOARDING_MARKER }),
        scope: Object.freeze({ locationId: "o7-location", departmentId: 7707 }),
      })]),
    });
  },
});

const offboardingServiceModule = require("../lib/personnel-lifecycle-offboarding-service");
offboardingServiceModule.createPersonnelLifecycleOffboardingService = () => Object.freeze({
  async listTasks() {
    serviceCalls.offboarding += 1;
    return Object.freeze({
      items: Object.freeze([Object.freeze({
        runId: "o7-synthetic-offboarding-run",
        stepId: offboardingFamily.stepId,
        canComplete: true,
        task: Object.freeze({
          orderId: offboardingFamily.orderId,
          displayName: "O7 Synthetic Subject",
          locationId: "o7-location",
          departmentId: 7707,
          status: "active",
          employeeNumber: "O7-SYNTHETIC-SUBJECT",
          payrollAction: OFFBOARDING_MARKER,
          effectiveDate: "2026-09-30",
          dueAt: "2026-09-30",
        }),
      })]),
    });
  },
});

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-o7-automation-api-"));
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

const CATALOG_ROUTE = "/api/portal/v1/personnel-lifecycle/automation/catalog";
const PREVIEW_ROUTE = "/api/portal/v1/personnel-lifecycle/automation/preview";
const READ_PERMISSIONS = Object.freeze(
  Object.values(PERSONNEL_LIFECYCLE_AUTOMATION_READ_PERMISSIONS),
);
const ALL_PREVIEW_PERMISSIONS = Object.freeze([...READ_PERMISSIONS, P.OPERATIONAL_READ]);
const ELIGIBLE_ROLES = Object.freeze(["hr", "admin", "it_admin", "developer"]);
const EXPECTED_DOMAINS = Object.freeze(["deadlines", "substitutions", "reminders", "escalations"]);

let httpServer;
let baseUrl;

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
    ) VALUES (?, ?, 'O7 Shared Account', 'branch', 'test-only', 1, 0, 'test', 'test')
  `).run(accountId, `o7-shared-${accountId.slice(0, 8)}`);
  for (const permission of READ_PERMISSIONS) {
    db.prepare(`
      INSERT INTO portal_organization_account_permissions (
        account_id, permission, granted_by
      ) VALUES (?, ?, 'O7-API-TEST')
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
      ) VALUES (?, ?, 'O7-API-TEST')
    `).run(employeeNumber, permission);
  }
}

async function request(route, { method = "GET", auth = null, body } = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
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
  return { response, payload, text };
}

function createFixture() {
  const definitions = Object.freeze([
    ["O7-NO-RIGHTS", "employee"],
    ["O7-TECHNICAL", "it_admin"],
    ["O7-ACTIONS", "hr"],
    ["O7-MANAGER", "manager"],
    ["O7-DEADLINES", "hr"],
    ["O7-MULTI", "admin"],
    ["O7-INCOMPLETE", "hr"],
    ["O7-BASE", "hr"],
    ["O7-ONBOARDING", "hr"],
    ["O7-OFFBOARDING", "hr"],
    ["O7-BOTH", "hr"],
  ]);
  const sessions = {};
  for (const [employeeNumber, role] of definitions) {
    insertEmployee(employeeNumber, `Synthetic ${employeeNumber}`);
    sessions[employeeNumber] = createEmployeeSession(employeeNumber, role);
  }
  grantPermissions(
    "O7-ACTIONS",
    PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS.filter((permission) => (
      !READ_PERMISSIONS.includes(permission)
    )),
  );
  grantPermissions("O7-MANAGER", READ_PERMISSIONS);
  grantPermissions("O7-DEADLINES", [A.DEADLINES_READ]);
  grantPermissions("O7-MULTI", [A.SUBSTITUTIONS_READ, A.REMINDERS_READ]);
  grantPermissions("O7-INCOMPLETE", [...READ_PERMISSIONS.slice(0, 3), P.OPERATIONAL_READ]);
  for (const employeeNumber of ["O7-BASE", "O7-ONBOARDING", "O7-OFFBOARDING", "O7-BOTH"]) {
    grantPermissions(employeeNumber, ALL_PREVIEW_PERMISSIONS);
  }
  grantPermissions("O7-ONBOARDING", [P.ONBOARDING_READ]);
  grantPermissions("O7-OFFBOARDING", [P.OFFBOARDING_CONFIDENTIAL_READ]);
  grantPermissions("O7-BOTH", [P.ONBOARDING_READ, P.OFFBOARDING_CONFIDENTIAL_READ]);
  sessions.organization = createOrganizationSession();
  enablePersonnelLifecycle();
  return Object.freeze(sessions);
}

function assertNoStore(result) {
  assert.match(result.response.headers.get("cache-control") || "", /(?:^|,\s*)no-store(?:,|$)/i);
  assert.equal(result.response.headers.get("pragma"), "no-cache");
  assert.equal(result.response.headers.has("etag"), false);
}

function assertRuntimeGatesClosed(runtimeGates) {
  assert.equal(Object.keys(runtimeGates || {}).length, 12);
  assert.equal(Object.values(runtimeGates).every((value) => value === false), true);
}

function assertCatalog(result, expectedDomains) {
  assert.equal(result.response.status, 200, result.text);
  assertNoStore(result);
  assert.deepEqual(
    Object.keys(result.payload || {}).sort(),
    ["blockerCodes", "contractVersion", "domains", "modes", "registries", "runtimeGates"].sort(),
  );
  assertRuntimeGatesClosed(result.payload.runtimeGates);
  assert.deepEqual(result.payload.domains.map(({ id }) => id), expectedDomains);
  for (const domain of result.payload.domains) {
    assert.equal(domain.status, "blocked");
    assert.equal(domain.configurationCount, 0);
    assert.equal(domain.externalEffectsEnabled, false);
  }
  for (const registry of Object.values(result.payload.registries)) {
    assert.deepEqual(registry, {
      recordCount: 0,
      activeRecordCount: 0,
      customerConfigured: false,
    });
  }
  const serialized = JSON.stringify(result.payload);
  assert.equal(serialized.includes(ONBOARDING_MARKER), false);
  assert.equal(serialized.includes(OFFBOARDING_MARKER), false);
}

function assertBlockedItem(item, source, marker) {
  assert.equal(item.source, source);
  assert.equal(item.title, marker);
  assert.equal(item.processVersionId, null);
  assert.equal(item.referenceKind, null);
  assert.equal(item.referenceDate, null);
  assert.equal(item.dueAt, null);
  assert.equal(item.dueState, "not_configured");
  assert.equal(item.responsibilityState, "unknown");
  assert.equal(item.representationState, "not_evaluated");
  assert.equal(item.reminderState, "blocked");
  assert.equal(item.escalationState, "blocked");
  assert.deepEqual(new Set(item.blockerCodes), new Set([
    B.PROCESS_VERSION_MISSING,
    B.REFERENCE_KIND_MISSING,
    B.REFERENCE_DATE_MISSING,
    B.POLICY_BINDING_MISSING,
  ]));
}

function resetServiceCalls() {
  serviceCalls.onboarding = 0;
  serviceCalls.offboarding = 0;
}

function protectedCounts() {
  const tableNames = [
    "integration_deliveries",
    "outbound_notification_jobs",
    "portal_notifications",
    "personnel_lifecycle_cases",
    "personnel_lifecycle_case_events",
    "custom_process_runs",
    "custom_process_run_steps",
  ];
  return Object.fromEntries(tableNames.map((tableName) => [
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
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("O7 Katalog und Vorschau bleiben rechtegetrennt, quellenminimiert und wirkungslos", async (t) => {
  const sessions = createFixture();

  await t.test("Katalog verlangt ein persönliches zentrales Konto mit mindestens einem read-Recht", async () => {
    assert.equal((await request(CATALOG_ROUTE)).response.status, 401);
    for (const principal of [
      "O7-NO-RIGHTS",
      "O7-TECHNICAL",
      "O7-ACTIONS",
      "O7-MANAGER",
      "organization",
    ]) {
      const denied = await request(CATALOG_ROUTE, { auth: sessions[principal] });
      assert.equal(denied.response.status, 403, `${principal}: ${denied.text}`);
    }

    const previousForcePortal = process.env.GRABENPLANER_FORCE_PORTAL;
    process.env.GRABENPLANER_FORCE_PORTAL = "0";
    try {
      const denied = await request(CATALOG_ROUTE);
      assert.equal(denied.response.status, 403, denied.text);
      assert.equal(
        denied.payload?.code,
        "PERSONNEL_LIFECYCLE_AUTOMATION_CATALOG_PERMISSION_REQUIRED",
      );
    } finally {
      process.env.GRABENPLANER_FORCE_PORTAL = previousForcePortal;
    }
  });

  await t.test("Katalog filtert strikt nach Domänen-read und setzt no-store", async () => {
    assertCatalog(
      await request(CATALOG_ROUTE, { auth: sessions["O7-DEADLINES"] }),
      ["deadlines"],
    );
    assertCatalog(
      await request(CATALOG_ROUTE, { auth: sessions["O7-MULTI"] }),
      ["substitutions", "reminders"],
    );
  });

  await t.test("alle 16 Rechte sind katalogisiert; nur developer erhält sie automatisch", async () => {
    const roles = await request("/api/portal/v1/roles");
    assert.equal(roles.response.status, 200, roles.text);
    const entries = (roles.payload?.catalog || []).filter(({ id }) => (
      String(id).startsWith("personnel:lifecycle:automation:")
    ));
    assert.deepEqual(entries.map(({ id }) => id).sort(), [...PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS].sort());
    for (const entry of entries) assert.deepEqual(entry.eligibleRoles, ELIGIBLE_ROLES, entry.id);
    for (const role of (roles.payload?.roles || []).filter(({ builtin }) => builtin)) {
      const automaticPermissions = (role.permissions || []).filter((permission) => (
        PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS.includes(permission)
      )).sort();
      const expectedPermissions = role.id === "developer"
        ? [...PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS].sort()
        : [];
      assert.deepEqual(automaticPermissions, expectedPermissions, role.id);
    }
  });

  await t.test("Preview verlangt alle vier read-Rechte und operational:read", async () => {
    for (const principal of ["O7-DEADLINES", "O7-INCOMPLETE", "O7-TECHNICAL", "organization"]) {
      const denied = await request(PREVIEW_ROUTE, { auth: sessions[principal] });
      assert.equal(denied.response.status, 403, `${principal}: ${denied.text}`);
    }
  });

  await t.test("Fallleserechte unterdrücken O4 und O5 bereits vor dem jeweiligen Serviceaufruf", async () => {
    resetServiceCalls();
    const base = await request(PREVIEW_ROUTE, { auth: sessions["O7-BASE"] });
    assert.equal(base.response.status, 200, base.text);
    assertNoStore(base);
    assertRuntimeGatesClosed(base.payload.runtimeGates);
    assert.deepEqual(base.payload.items, []);
    assert.deepEqual(serviceCalls, { onboarding: 0, offboarding: 0 });
    assert.equal(JSON.stringify(base.payload).includes(ONBOARDING_MARKER), false);
    assert.equal(JSON.stringify(base.payload).includes(OFFBOARDING_MARKER), false);

    resetServiceCalls();
    const onboarding = await request(PREVIEW_ROUTE, { auth: sessions["O7-ONBOARDING"] });
    assert.equal(onboarding.response.status, 200, onboarding.text);
    assertNoStore(onboarding);
    assert.deepEqual(serviceCalls, { onboarding: 1, offboarding: 0 });
    assert.equal(onboarding.payload.items.length, 1);
    assertBlockedItem(onboarding.payload.items[0], "onboarding", ONBOARDING_MARKER);
    assert.equal(JSON.stringify(onboarding.payload).includes(OFFBOARDING_MARKER), false);

    resetServiceCalls();
    const offboarding = await request(PREVIEW_ROUTE, { auth: sessions["O7-OFFBOARDING"] });
    assert.equal(offboarding.response.status, 200, offboarding.text);
    assertNoStore(offboarding);
    assert.deepEqual(serviceCalls, { onboarding: 0, offboarding: 1 });
    assert.equal(offboarding.payload.items.length, 1);
    assertBlockedItem(offboarding.payload.items[0], "offboarding", OFFBOARDING_MARKER);
    assert.equal(JSON.stringify(offboarding.payload).includes(ONBOARDING_MARKER), false);

    resetServiceCalls();
    const both = await request(PREVIEW_ROUTE, { auth: sessions["O7-BOTH"] });
    assert.equal(both.response.status, 200, both.text);
    assertNoStore(both);
    assert.deepEqual(serviceCalls, { onboarding: 1, offboarding: 1 });
    assert.deepEqual(both.payload.items.map(({ source }) => source), ["onboarding", "offboarding"]);
    assertBlockedItem(both.payload.items[0], "onboarding", ONBOARDING_MARKER);
    assertBlockedItem(both.payload.items[1], "offboarding", OFFBOARDING_MARKER);
  });

  await t.test("Mutations-, Dispatch- und Reconcile-Endpunkte existieren nicht", async () => {
    resetServiceCalls();
    const before = protectedCounts();
    for (const route of [
      CATALOG_ROUTE,
      PREVIEW_ROUTE,
      "/api/portal/v1/personnel-lifecycle/automation/deadlines/recalculate",
      "/api/portal/v1/personnel-lifecycle/automation/substitutions/apply",
      "/api/portal/v1/personnel-lifecycle/automation/reminders/dispatch",
      "/api/portal/v1/personnel-lifecycle/automation/escalations/trigger",
      "/api/portal/v1/personnel-lifecycle/automation/reconcile",
    ]) {
      const result = await request(route, {
        method: "POST",
        auth: sessions["O7-BOTH"],
        body: { action: "must-not-run", secret: "must-not-persist" },
      });
      assert.equal([404, 405].includes(result.response.status), true, `${route}: ${result.text}`);
    }
    assert.deepEqual(serviceCalls, { onboarding: 0, offboarding: 0 });
    assert.deepEqual(protectedCounts(), before);
  });
});

test("O7 Rechteabhängigkeiten verlangen für jede Wirkung das read-Recht derselben Domäne", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("const automationCapabilitiesByDomain");
  const end = source.indexOf("const portalDashboardPermissionDetails", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const dependencySource = source.slice(start, end);
  for (const [domain, capabilities] of Object.entries({
    deadlines: ["manage", "recalculate", "reconcile"],
    substitutions: ["manage", "apply", "reconcile"],
    reminders: ["manage", "dispatch", "reconcile"],
    escalations: ["manage", "trigger", "reconcile"],
  })) {
    assert.match(dependencySource, new RegExp(`${domain}: \\[${capabilities
      .map((capability) => `"${capability}"`).join(", ")}\\]`));
  }
  assert.match(dependencySource, /PERSONNEL_LIFECYCLE_AUTOMATION_READ_PERMISSIONS\[domain\]/);
  assert.match(dependencySource, /personnel:lifecycle:automation:\$\{domain\}:\$\{capability\}/);
});

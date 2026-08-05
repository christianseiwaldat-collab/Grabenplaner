"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  PERSONNEL_LIFECYCLE_CASE_PERMISSIONS: P,
} = require("../lib/personnel-lifecycle-case-contract");
const {
  personnelWorkflowPublicationReceiptBody,
} = require("../lib/personnel-workflow-publication-receipt");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-o4-api-"));
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

const LOCATION = "o4-api-location";
const DEPARTMENT = 9941;
const SUBJECT = "O4-API-SUBJECT";
const DEVELOPER = "O4-API-DEV";
const RECIPIENT_A = "O4-API-HR-A";
const RECIPIENT_B = "O4-API-HR-B";
const PRIVATE_MARKER = "O4-API-PRIVATE-DESCRIPTION-MUST-NOT-LEAK";
const INJECTED_EMPLOYEE = "O4-API-INJECTED-EMPLOYEE";
const PUBLICATIONS = Object.freeze([
  Object.freeze({
    publicationId: "o4-api-publication-personnel",
    processId: "o4-api-process-personnel",
    workflowCode: "onboarding.o4.api.personnel",
    title: "O4 Personaladministration",
    stepId: "o4-api-step-personnel",
    recipientId: RECIPIENT_A,
  }),
  Object.freeze({
    publicationId: "o4-api-publication-security",
    processId: "o4-api-process-security",
    workflowCode: "onboarding.o4.api.security",
    title: "O4 Basis, Sicherheit und Datenschutz",
    stepId: "o4-api-step-security",
    recipientId: RECIPIENT_B,
  }),
]);
const PROFILE_ROUTE = `/api/portal/v1/personnel-lifecycle/employees/${SUBJECT}/profile?tab=onboarding`;
const START_ROUTE = `/api/portal/v1/personnel-lifecycle/employees/${SUBJECT}/onboarding-starts`;
const START_PERMISSIONS = Object.freeze([
  "personnel:central:read",
  P.ONBOARDING_READ,
  P.ONBOARDING_PREPARE,
  P.ONBOARDING_APPROVE,
  P.ONBOARDING_EXECUTE,
  P.PACKAGES_READ,
  P.PACKAGES_WRITE,
  P.PACKAGES_PUBLISH,
  P.ASSIGNMENTS_WRITE,
]);
const PROFILE_READ_PERMISSIONS = new Set([
  "personnel:central:read",
  P.ONBOARDING_READ,
  P.PACKAGES_READ,
]);
const LIFECYCLE_TABLES = Object.freeze([
  "personnel_employment_episodes",
  "personnel_lifecycle_cases",
  "personnel_lifecycle_case_reference_dates",
  "personnel_lifecycle_case_package_bindings",
  "personnel_lifecycle_case_package_runs",
  "personnel_lifecycle_case_assignments",
  "personnel_lifecycle_case_assignment_bindings",
  "personnel_lifecycle_case_events",
  "personnel_lifecycle_onboarding_operations",
  "custom_process_runs",
  "custom_process_run_steps",
  "custom_process_run_bindings",
  "custom_process_run_step_assignments",
]);
const EXTERNAL_SIDE_EFFECT_TABLES = Object.freeze([
  "portal_notifications",
  "outbound_notification_jobs",
  "integration_deliveries",
  "portal_users",
  "portal_organization_accounts",
]);

let httpServer;
let baseUrl;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function countsFor(tables) {
  return Object.fromEntries(tables.map((tableName) => [
    tableName,
    db.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get().count,
  ]));
}

function operationId(index) {
  return `44000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function configuredInstallationFeatures() {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'installation_features'").get();
  try {
    const parsed = JSON.parse(String(stored?.value || "[]"));
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
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    sha256(rawToken),
  );
  return {
    cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

async function request(route, {
  method = "GET",
  auth = null,
  body,
  csrfToken,
} = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method)) {
    headers["X-CSRF-Token"] = csrfToken === undefined ? auth.csrf : csrfToken;
  }
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

function insertPublication(definition) {
  const snapshotJson = JSON.stringify({
    id: definition.processId,
    revision: 1,
    title: definition.title,
    scope: { type: "company", locationId: null, departmentId: null },
    steps: [
      {
        id: definition.stepId,
        type: "actor",
        title: `${definition.title} vorbereiten`,
        description: `${PRIVATE_MARKER}:${definition.stepId}`,
        responsibilityType: "employee",
        responsibilityReference: definition.recipientId,
        responsibilityLabel: "Feste verantwortliche Person",
        conditionType: "always",
        conditionText: "",
        notificationChannels: [],
      },
    ],
  });
  const row = {
    id: definition.publicationId,
    process_id: definition.processId,
    source_revision: 1,
    version_number: 1,
    workflow_code: definition.workflowCode,
    workflow_type: "onboarding",
    authority_level: "central",
    requirement_kind: "mandatory",
    data_classification: "standard",
    scope_type: "company",
    location_id: null,
    department_id: null,
    snapshot_json: snapshotJson,
    snapshot_sha256: sha256(snapshotJson),
    published_by: DEVELOPER,
    published_at: "2026-08-03T10:00:00.000Z",
  };
  row.receipt_sha256 = sha256(JSON.stringify(personnelWorkflowPublicationReceiptBody(row)));
  db.prepare(`
    INSERT INTO custom_processes (
      id, title, symbol, description, category, scope_type, trigger_type,
      trigger_minimum_shortfall, status, revision, created_by, updated_by
    ) VALUES (?, ?, 'O4', 'Synthetisches O4 API-Pflichtpaket', 'other',
      'company', 'manual', 1, 'active', 1, ?, ?)
  `).run(definition.processId, definition.title, DEVELOPER, DEVELOPER);
  db.prepare(`
    INSERT INTO custom_process_revisions (
      process_id, revision, snapshot_json, created_by
    ) VALUES (?, 1, ?, ?)
  `).run(definition.processId, snapshotJson, DEVELOPER);
  db.prepare(`
    INSERT INTO custom_process_publications (
      id, process_id, source_revision, version_number, workflow_code,
      workflow_type, authority_level, requirement_kind, data_classification,
      scope_type, location_id, department_id, snapshot_json, snapshot_sha256,
      receipt_sha256, published_by, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.process_id,
    row.source_revision,
    row.version_number,
    row.workflow_code,
    row.workflow_type,
    row.authority_level,
    row.requirement_kind,
    row.data_classification,
    row.scope_type,
    row.location_id,
    row.department_id,
    row.snapshot_json,
    row.snapshot_sha256,
    row.receipt_sha256,
    row.published_by,
    row.published_at,
  );
}

function createFixture() {
  db.prepare(`
    INSERT INTO locations (id, name, active)
    VALUES (?, 'O4 API Standort', 1)
  `).run(LOCATION);
  db.prepare(`
    INSERT INTO departments (id, location_id, name, active, sort_order)
    VALUES (?, ?, 'O4 API Abteilung', 1, 9941)
  `).run(DEPARTMENT, LOCATION);
  const insertEmployee = db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES (?, ?, ?, ?, ?, 1)
  `);
  insertEmployee.run(SUBJECT, "O4 API Zielperson", "Ziel", LOCATION, DEPARTMENT);
  insertEmployee.run(DEVELOPER, "O4 API Developer", "Dev", LOCATION, DEPARTMENT);
  insertEmployee.run(RECIPIENT_A, "O4 API Personal A", "HR A", LOCATION, DEPARTMENT);
  insertEmployee.run(RECIPIENT_B, "O4 API Personal B", "HR B", LOCATION, DEPARTMENT);

  const auth = createEmployeeSession(DEVELOPER, "developer");
  createEmployeeSession(RECIPIENT_A, "hr");
  createEmployeeSession(RECIPIENT_B, "hr");
  const grant = db.prepare(`
    INSERT OR IGNORE INTO portal_permission_grants (
      employee_number, permission, granted_by
    ) VALUES (?, ?, ?)
  `);
  for (const recipient of [RECIPIENT_A, RECIPIENT_B]) {
    grant.run(recipient, P.OPERATIONAL_READ, DEVELOPER);
    grant.run(recipient, P.OPERATIONAL_UPDATE, DEVELOPER);
  }
  for (const publication of PUBLICATIONS) insertPublication(publication);
  enablePersonnelLifecycle();
  return auth;
}

function grantDeveloperStartPermissions() {
  const grant = db.prepare(`
    INSERT OR IGNORE INTO portal_permission_grants (
      employee_number, permission, granted_by
    ) VALUES (?, ?, ?)
  `);
  for (const permission of START_PERMISSIONS) grant.run(DEVELOPER, permission, DEVELOPER);
}

function denyDeveloperPermission(permission) {
  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, ?, ?)
  `).run(DEVELOPER, permission, DEVELOPER);
}

function restoreDeveloperPermission(permission) {
  db.prepare(`
    DELETE FROM portal_permission_denials
    WHERE employee_number = ? AND permission = ?
  `).run(DEVELOPER, permission);
}

function bodyFor(profileResponse, requestedOperationId) {
  const packages = [...profileResponse.onboardingPreview.packageResolution.packages]
    .sort((left, right) => left.publicationId.localeCompare(right.publicationId));
  const familyCodes = ["personnel_administration", "base_security_privacy"];
  return {
    operationId: requestedOperationId,
    expectedPreviewSha256: profileResponse.onboardingExecution.previewSha256,
    responsibleActorId: DEVELOPER,
    confirmation: "START_ONBOARDING",
    confirmations: {
      responsibility: true,
      packages: true,
      lifecycleReviews: true,
      assignments: true,
      atomicStart: true,
    },
    referenceDates: {
      contractualEntryDate: "2026-09-01",
      firstWorkingDay: "2026-09-02",
      onboardingTargetDate: "2026-09-30",
    },
    packageBindings: packages.map((entry, index) => ({
      publicationId: entry.publicationId,
      versionNumber: entry.versionNumber,
      familyCodes: [familyCodes[index]],
      reviewConfirmed: true,
      assignments: entry.assignments
        .filter(({ responsibility }) => responsibility.type !== "system")
        .map(({ stepReference, eligibleRecipients }) => ({
          stepReference,
          assigneeActorId: eligibleRecipients[0].actorId,
        })),
    })),
  };
}

function assertMinimalError(result, {
  status,
  code,
  forbidden = [],
}) {
  assert.equal(result.response.status, status, result.text);
  assert.equal(result.payload?.code, code, result.text);
  assert.equal(typeof result.payload?.error, "string");
  assert.equal(typeof result.payload?.requestId, "string");
  assert.deepEqual(Object.keys(result.payload).sort(), ["code", "error", "requestId"]);
  const serialized = JSON.stringify(result.payload);
  for (const marker of [
    SUBJECT,
    RECIPIENT_A,
    RECIPIENT_B,
    PRIVATE_MARKER,
    ...PUBLICATIONS.map(({ publicationId }) => publicationId),
    ...forbidden,
  ]) {
    assert.equal(serialized.includes(marker), false, `Fehlerantwort enthaelt ${marker}`);
  }
}

function assertNoLifecycleWrites(expected, label) {
  assert.deepEqual(countsFor(LIFECYCLE_TABLES), expected, label);
}

function assertNoExternalSideEffects(expected, label) {
  assert.deepEqual(countsFor(EXTERNAL_SIDE_EFFECT_TABLES), expected, label);
  assert.equal(
    db.prepare("SELECT active FROM employees WHERE personnel_number = ?").get(SUBJECT)?.active,
    1,
    `${label}: Mitarbeiterstamm wurde aktiviert/deaktiviert`,
  );
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

test("O4 Onboarding-Start-API erzwingt Rechte, Vertrag, Atomizitaet und Idempotenz", async () => {
  const auth = createFixture();
  const lifecycleBaseline = countsFor(LIFECYCLE_TABLES);
  const externalBaseline = countsFor(EXTERNAL_SIDE_EFFECT_TABLES);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM custom_process_publications
    WHERE id IN (?, ?)
      AND workflow_type = 'onboarding'
      AND authority_level = 'central'
      AND requirement_kind = 'mandatory'
      AND scope_type = 'company'
  `).get(...PUBLICATIONS.map(({ publicationId }) => publicationId)).count, 2);

  const noDomainRights = await request(PROFILE_ROUTE, { auth });
  assertMinimalError(noDomainRights, {
    status: 403,
    code: "PORTAL_PERMISSION_DENIED",
  });
  assertNoLifecycleWrites(lifecycleBaseline, "GET ohne explizite Fachrechte");

  grantDeveloperStartPermissions();
  const fullProfile = await request(PROFILE_ROUTE, { auth });
  assert.equal(fullProfile.response.status, 200, fullProfile.text);
  assert.equal(fullProfile.payload.capabilities.canReadOnboardingPreview, true);
  assert.equal(fullProfile.payload.capabilities.canStartOnboarding, true);
  assert.equal(fullProfile.payload.onboardingExecution.contractVersion, "o4-v0.1");
  assert.equal(fullProfile.payload.onboardingExecution.mode, "controlled_onboarding_start");
  assert.match(fullProfile.payload.onboardingExecution.previewSha256, /^[0-9a-f]{64}$/);
  assert.equal(fullProfile.payload.onboardingExecution.formAvailable, true);
  assert.equal(fullProfile.payload.onboardingExecution.requiredConfirmation, "START_ONBOARDING");
  assert.equal(fullProfile.payload.onboardingExecution.activeCase, null);
  assert.equal(fullProfile.payload.onboardingPreview.packageResolution.packages.length, 2);
  assert.equal(
    fullProfile.payload.onboardingPreview.packageResolution.packages.every((entry) => (
      entry.scope.type === "company"
        && entry.authorityLevel === "central"
        && entry.requirementKind === "mandatory"
        && entry.assignments.length === 1
        && entry.assignments[0].eligibleRecipients.length === 1
    )),
    true,
  );
  assert.equal(JSON.stringify(fullProfile.payload).includes(PRIVATE_MARKER), false);
  const validBody = bodyFor(fullProfile.payload, operationId(100));

  for (const [index, permission] of START_PERMISSIONS.entries()) {
    denyDeveloperPermission(permission);
    const restrictedProfile = await request(PROFILE_ROUTE, { auth });
    if (PROFILE_READ_PERMISSIONS.has(permission)) {
      assertMinimalError(restrictedProfile, {
        status: 403,
        code: "PERSONNEL_LIFECYCLE_ONBOARDING_PREVIEW_ACCESS_DENIED",
      });
    } else {
      assert.equal(restrictedProfile.response.status, 200, `${permission}: ${restrictedProfile.text}`);
      assert.equal(restrictedProfile.payload.capabilities.canReadOnboardingPreview, true, permission);
      assert.equal(restrictedProfile.payload.capabilities.canStartOnboarding, false, permission);
      assert.equal(restrictedProfile.payload.onboardingExecution.formAvailable, false, permission);
    }
    const deniedStart = await request(START_ROUTE, {
      method: "POST",
      auth,
      body: { ...validBody, operationId: operationId(index + 1) },
    });
    assertMinimalError(deniedStart, {
      status: 403,
      code: "PERSONNEL_LIFECYCLE_ONBOARDING_PERMISSION_REQUIRED",
      forbidden: [operationId(index + 1)],
    });
    assertNoLifecycleWrites(lifecycleBaseline, `fehlendes Recht ${permission}`);
    assertNoExternalSideEffects(externalBaseline, `fehlendes Recht ${permission}`);
    restoreDeveloperPermission(permission);
  }

  const refreshedProfile = await request(PROFILE_ROUTE, { auth });
  assert.equal(refreshedProfile.response.status, 200, refreshedProfile.text);
  assert.equal(refreshedProfile.payload.capabilities.canStartOnboarding, true);
  assert.equal(refreshedProfile.payload.onboardingExecution.formAvailable, true);
  const body = bodyFor(refreshedProfile.payload, operationId(100));

  const injected = await request(START_ROUTE, {
    method: "POST",
    auth,
    body: { ...body, employeeNumber: INJECTED_EMPLOYEE },
  });
  assertMinimalError(injected, {
    status: 400,
    code: "PERSONNEL_LIFECYCLE_ONBOARDING_INPUT_INVALID",
    forbidden: [INJECTED_EMPLOYEE, body.operationId],
  });

  const wrongCsrf = await request(START_ROUTE, {
    method: "POST",
    auth,
    csrfToken: "wrong-csrf-token",
    body: { ...body, operationId: operationId(101) },
  });
  assertMinimalError(wrongCsrf, {
    status: 403,
    code: "PORTAL_CSRF_INVALID",
    forbidden: [operationId(101)],
  });

  const missingConfirmationBody = clone(body);
  delete missingConfirmationBody.confirmation;
  missingConfirmationBody.operationId = operationId(102);
  const missingConfirmation = await request(START_ROUTE, {
    method: "POST",
    auth,
    body: missingConfirmationBody,
  });
  assertMinimalError(missingConfirmation, {
    status: 400,
    code: "PERSONNEL_LIFECYCLE_ONBOARDING_CONFIRMATION_REQUIRED",
    forbidden: [operationId(102)],
  });

  const staleHash = await request(START_ROUTE, {
    method: "POST",
    auth,
    body: {
      ...body,
      operationId: operationId(103),
      expectedPreviewSha256: "f".repeat(64),
    },
  });
  assertMinimalError(staleHash, {
    status: 409,
    code: "PERSONNEL_LIFECYCLE_ONBOARDING_PREVIEW_STALE",
    forbidden: [operationId(103), "f".repeat(64)],
  });

  const manipulatedPackagesBody = clone(body);
  manipulatedPackagesBody.operationId = operationId(104);
  manipulatedPackagesBody.packageBindings[0].versionNumber += 1;
  const manipulatedPackages = await request(START_ROUTE, {
    method: "POST",
    auth,
    body: manipulatedPackagesBody,
  });
  assertMinimalError(manipulatedPackages, {
    status: 409,
    code: "PERSONNEL_LIFECYCLE_ONBOARDING_PREVIEW_STALE",
    forbidden: [operationId(104)],
  });

  const manipulatedAssignmentsBody = clone(body);
  manipulatedAssignmentsBody.operationId = operationId(105);
  const expectedAssignee = manipulatedAssignmentsBody.packageBindings[0]
    .assignments[0].assigneeActorId;
  manipulatedAssignmentsBody.packageBindings[0].assignments[0].assigneeActorId = (
    expectedAssignee === RECIPIENT_A ? RECIPIENT_B : RECIPIENT_A
  );
  const manipulatedAssignments = await request(START_ROUTE, {
    method: "POST",
    auth,
    body: manipulatedAssignmentsBody,
  });
  assertMinimalError(manipulatedAssignments, {
    status: 409,
    code: "PERSONNEL_LIFECYCLE_ONBOARDING_ASSIGNMENT_STALE",
    forbidden: [operationId(105)],
  });

  assertNoLifecycleWrites(lifecycleBaseline, "ungueltige O4-Auftraege");
  assertNoExternalSideEffects(externalBaseline, "ungueltige O4-Auftraege");

  const started = await request(START_ROUTE, {
    method: "POST",
    auth,
    body,
  });
  assert.equal(started.response.status, 201, started.text);
  assert.equal(started.response.headers.get("idempotency-replayed"), null);
  const result = started.payload.onboardingExecution;
  assert.equal(result.contractVersion, "o4-v0.1");
  assert.equal(result.employeeNumber, SUBJECT);
  assert.equal(result.state, "active");
  assert.equal(result.packageCount, 2);
  assert.equal(result.assignmentCount, 2);
  assert.equal(result.packages.length, 2);
  assert.equal(result.replayed, false);
  assert.deepEqual(
    result.packages.map(({ publicationId }) => publicationId).sort(),
    PUBLICATIONS.map(({ publicationId }) => publicationId).sort(),
  );
  const countsAfterStart = countsFor(LIFECYCLE_TABLES);
  assert.deepEqual(countsAfterStart, {
    personnel_employment_episodes: lifecycleBaseline.personnel_employment_episodes + 1,
    personnel_lifecycle_cases: lifecycleBaseline.personnel_lifecycle_cases + 1,
    personnel_lifecycle_case_reference_dates:
      lifecycleBaseline.personnel_lifecycle_case_reference_dates + 1,
    personnel_lifecycle_case_package_bindings:
      lifecycleBaseline.personnel_lifecycle_case_package_bindings + 2,
    personnel_lifecycle_case_package_runs:
      lifecycleBaseline.personnel_lifecycle_case_package_runs + 2,
    personnel_lifecycle_case_assignments:
      lifecycleBaseline.personnel_lifecycle_case_assignments + 2,
    personnel_lifecycle_case_assignment_bindings:
      lifecycleBaseline.personnel_lifecycle_case_assignment_bindings + 2,
    personnel_lifecycle_case_events: lifecycleBaseline.personnel_lifecycle_case_events + 3,
    personnel_lifecycle_onboarding_operations:
      lifecycleBaseline.personnel_lifecycle_onboarding_operations + 1,
    custom_process_runs: lifecycleBaseline.custom_process_runs + 2,
    custom_process_run_steps: lifecycleBaseline.custom_process_run_steps + 2,
    custom_process_run_bindings: lifecycleBaseline.custom_process_run_bindings + 2,
    custom_process_run_step_assignments:
      lifecycleBaseline.custom_process_run_step_assignments + 2,
  });
  assertNoExternalSideEffects(externalBaseline, "erfolgreicher atomarer Start");

  const replay = await request(START_ROUTE, {
    method: "POST",
    auth,
    body,
  });
  assert.equal(replay.response.status, 200, replay.text);
  assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
  assert.equal(replay.payload.onboardingExecution.replayed, true);
  assert.equal(replay.payload.onboardingExecution.caseId, result.caseId);
  assert.deepEqual(
    { ...replay.payload.onboardingExecution, replayed: false },
    result,
  );
  assert.deepEqual(countsFor(LIFECYCLE_TABLES), countsAfterStart);
  assertNoExternalSideEffects(externalBaseline, "idempotente Wiederholung");

  const duplicateOperation = operationId(106);
  const duplicateStart = await request(START_ROUTE, {
    method: "POST",
    auth,
    body: { ...body, operationId: duplicateOperation },
  });
  assertMinimalError(duplicateStart, {
    status: 409,
    code: "PERSONNEL_LIFECYCLE_ONBOARDING_CASE_EXISTS",
    forbidden: [duplicateOperation, result.caseId],
  });
  assert.deepEqual(countsFor(LIFECYCLE_TABLES), countsAfterStart);
  assertNoExternalSideEffects(externalBaseline, "doppelter Start");

  const activeProfile = await request(PROFILE_ROUTE, { auth });
  assert.equal(activeProfile.response.status, 200, activeProfile.text);
  assert.equal(activeProfile.payload.onboardingExecution.formAvailable, false);
  assert.equal(activeProfile.payload.onboardingExecution.activeCase.caseId, result.caseId);
  assert.equal(activeProfile.payload.onboardingExecution.activeCase.state, "active");
  assert.equal(activeProfile.payload.onboardingExecution.activeCase.packageCount, 2);
  assert.equal(activeProfile.payload.onboardingExecution.activeCase.taskCount, 2);

  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM audit_log
    WHERE action = 'personnel-lifecycle.onboarding.start'
      AND actor = ?
      AND entity_id = ?
  `).get(DEVELOPER, result.caseId).count, 1);
});

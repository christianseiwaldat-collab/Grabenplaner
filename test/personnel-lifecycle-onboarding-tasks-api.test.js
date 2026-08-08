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

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-o4-tasks-api-"));
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

const LOCATION = "o4-tasks-location";
const OTHER_LOCATION = "o4-tasks-other-location";
const DEPARTMENT = 9942;
const OTHER_DEPARTMENT = 9943;
const SUBJECT = "O4-TASKS-SUBJECT";
const DEVELOPER = "O4-TASKS-DEV";
const RECIPIENT_A = "O4-TASKS-A";
const RECIPIENT_B = "O4-TASKS-B";
const CLOSER_B = "O4-TASKS-CLOSER-B";
const OUTSIDER = "O4-TASKS-OUTSIDER";
const PRIVATE_MARKER = "O4-TASKS-PRIVATE-MARKER-MUST-NOT-LEAK";
const TASKS_ROUTE = "/api/portal/v1/personnel-lifecycle/onboarding/tasks";
const OVERVIEW_PROFILE_ROUTE = `/api/portal/v1/personnel-lifecycle/employees/${SUBJECT}/profile?tab=overview`;
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
const CLOSE_PERMISSIONS = Object.freeze([
  P.OPERATIONAL_READ,
  P.OPERATIONAL_UPDATE,
  P.ONBOARDING_READ,
  P.ONBOARDING_CLOSE,
]);
const PUBLICATIONS = Object.freeze([
  Object.freeze({
    publicationId: "o4-tasks-publication-personnel",
    processId: "o4-tasks-process-personnel",
    workflowCode: "onboarding.o4.tasks.personnel",
    title: "O4 Personaladministration",
    stepId: "o4-tasks-step-personnel",
    recipientId: RECIPIENT_A,
  }),
  Object.freeze({
    publicationId: "o4-tasks-publication-security",
    processId: "o4-tasks-process-security",
    workflowCode: "onboarding.o4.tasks.security",
    title: "O4 Basis, Sicherheit und Datenschutz",
    stepId: "o4-tasks-step-security",
    recipientId: RECIPIENT_B,
  }),
]);
const EXTERNAL_SIDE_EFFECT_TABLES = Object.freeze([
  "portal_notifications",
  "outbound_notification_jobs",
  "integration_deliveries",
]);

let httpServer;
let baseUrl;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function operationId(index) {
  return `55000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
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

function insertEmployee(employeeNumber, fullName, locationId, departmentId) {
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES (?, ?, ?, ?, ?, 1)
  `).run(employeeNumber, fullName, fullName, locationId, departmentId);
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

function grantPermission(employeeNumber, permission) {
  db.prepare(`
    INSERT OR IGNORE INTO portal_permission_grants (
      employee_number, permission, granted_by
    ) VALUES (?, ?, ?)
  `).run(employeeNumber, permission, DEVELOPER);
}

function denyPermission(employeeNumber, permission) {
  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, ?, ?)
  `).run(employeeNumber, permission, DEVELOPER);
}

function restorePermission(employeeNumber, permission) {
  db.prepare(`
    DELETE FROM portal_permission_denials
    WHERE employee_number = ? AND permission = ?
  `).run(employeeNumber, permission);
}

function setScopedOperationalPermissions(employeeNumber, locationId, departmentId) {
  db.prepare("DELETE FROM portal_permission_scope_grants WHERE employee_number = ?")
    .run(employeeNumber);
  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?")
    .run(employeeNumber);
  db.prepare(`
    INSERT INTO portal_access_scopes (
      employee_number, location_id, department_id, assigned_by
    ) VALUES (?, ?, ?, ?)
  `).run(employeeNumber, locationId, departmentId, DEVELOPER);
  for (const permission of [P.OPERATIONAL_READ, P.OPERATIONAL_UPDATE]) {
    grantPermission(employeeNumber, permission);
    db.prepare(`
      INSERT INTO portal_permission_scope_grants (
        employee_number, permission, location_id, department_id, approved_by
      ) VALUES (?, ?, ?, ?, ?)
    `).run(employeeNumber, permission, locationId, departmentId, DEVELOPER);
  }
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
    published_at: "2026-08-03T11:00:00.000Z",
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

function startBody(profileResponse, requestedOperationId) {
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

function countsFor(tables) {
  return Object.fromEntries(tables.map((tableName) => [
    tableName,
    db.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get().count,
  ]));
}

function businessSnapshot(caseId) {
  return {
    caseState: db.prepare(`
      SELECT state FROM personnel_lifecycle_cases WHERE id = ?
    `).get(caseId)?.state,
    runStates: db.prepare(`
      SELECT id, status, resolved_at AS resolvedAt
      FROM custom_process_runs
      WHERE id IN (
        SELECT run_id FROM personnel_lifecycle_case_package_runs
        WHERE package_binding_id IN (
          SELECT id FROM personnel_lifecycle_case_package_bindings WHERE case_id = ?
        )
      )
      ORDER BY id
    `).all(caseId).map((row) => ({ ...row })),
    stepStates: db.prepare(`
      SELECT run_id AS runId, step_id AS stepId, status, completed_at AS completedAt,
             completion_request_id AS completionRequestId
      FROM custom_process_run_steps
      WHERE run_id IN (
        SELECT run_id FROM personnel_lifecycle_case_package_runs
        WHERE package_binding_id IN (
          SELECT id FROM personnel_lifecycle_case_package_bindings WHERE case_id = ?
        )
      )
      ORDER BY run_id, step_id
    `).all(caseId).map((row) => ({ ...row })),
    taskEvents: db.prepare(`
      SELECT COUNT(*) AS count FROM personnel_lifecycle_case_events
      WHERE case_id = ? AND event_type = 'onboarding_task_completed'
    `).get(caseId).count,
    closeEvents: db.prepare(`
      SELECT COUNT(*) AS count FROM personnel_lifecycle_case_events
      WHERE case_id = ? AND event_type = 'onboarding_completed'
    `).get(caseId).count,
    successAudits: db.prepare(`
      SELECT COUNT(*) AS count FROM audit_log audit
      WHERE (
        audit.entity_id = ?
        AND audit.action IN (
          'personnel-lifecycle.onboarding.task.complete',
          'personnel-lifecycle.onboarding.close'
        )
      ) OR (
        audit.action = 'personnel-workflow.task.complete'
        AND audit.entity_id IN (
          SELECT run_id FROM personnel_lifecycle_case_package_runs
          WHERE package_binding_id IN (
            SELECT id FROM personnel_lifecycle_case_package_bindings WHERE case_id = ?
          )
        )
      )
    `).get(caseId, caseId).count,
    externalSideEffects: countsFor(EXTERNAL_SIDE_EFFECT_TABLES),
    employeeActive: db.prepare(`
      SELECT active FROM employees WHERE personnel_number = ?
    `).get(SUBJECT)?.active,
  };
}

function assertBusinessUnchanged(expected, caseId, label) {
  assert.deepEqual(businessSnapshot(caseId), expected, label);
}

function assertError(result, status, code, forbidden = []) {
  assert.equal(result.response.status, status, result.text);
  assert.equal(result.payload?.code, code, result.text);
  assert.equal(typeof result.payload?.error, "string");
  assert.equal(typeof result.payload?.requestId, "string");
  assert.deepEqual(Object.keys(result.payload).sort(), ["code", "error", "requestId"]);
  const serialized = JSON.stringify(result.payload);
  for (const marker of [SUBJECT, PRIVATE_MARKER, ...forbidden]) {
    assert.equal(serialized.includes(marker), false, `Fehlerantwort enthaelt ${marker}`);
  }
}

function completeRoute(task) {
  return `${TASKS_ROUTE}/${encodeURIComponent(task.runId)}/${encodeURIComponent(task.stepId)}/complete`;
}

function closeRoute(caseId) {
  return `/api/portal/v1/personnel-lifecycle/onboarding/cases/${encodeURIComponent(caseId)}/close`;
}

function createFixture() {
  db.prepare("INSERT INTO locations (id, name, active) VALUES (?, 'O4 Aufgaben Standort', 1)")
    .run(LOCATION);
  db.prepare("INSERT INTO locations (id, name, active) VALUES (?, 'O4 Fremdstandort', 1)")
    .run(OTHER_LOCATION);
  db.prepare(`
    INSERT INTO departments (id, location_id, name, active, sort_order)
    VALUES (?, ?, 'O4 Aufgaben Abteilung', 1, 9942)
  `).run(DEPARTMENT, LOCATION);
  db.prepare(`
    INSERT INTO departments (id, location_id, name, active, sort_order)
    VALUES (?, ?, 'O4 Fremdabteilung', 1, 9943)
  `).run(OTHER_DEPARTMENT, OTHER_LOCATION);
  insertEmployee(SUBJECT, "O4 Aufgaben Zielperson", LOCATION, DEPARTMENT);
  insertEmployee(DEVELOPER, "O4 Aufgaben Developer", LOCATION, DEPARTMENT);
  insertEmployee(RECIPIENT_A, "O4 Aufgaben Person A", LOCATION, DEPARTMENT);
  insertEmployee(RECIPIENT_B, "O4 Aufgaben Person B", LOCATION, DEPARTMENT);
  insertEmployee(CLOSER_B, "O4 Aufgaben Abschluss B", LOCATION, DEPARTMENT);
  insertEmployee(OUTSIDER, "O4 Aufgaben Ohne Rechte", OTHER_LOCATION, OTHER_DEPARTMENT);

  const sessions = {
    developer: createEmployeeSession(DEVELOPER, "developer"),
    recipientA: createEmployeeSession(RECIPIENT_A, "employee"),
    recipientB: createEmployeeSession(RECIPIENT_B, "hr"),
    closerB: createEmployeeSession(CLOSER_B, "hr"),
    outsider: createEmployeeSession(OUTSIDER, "employee"),
  };
  for (const permission of START_PERMISSIONS) grantPermission(DEVELOPER, permission);
  grantPermission(DEVELOPER, P.OPERATIONAL_READ);
  grantPermission(DEVELOPER, P.OPERATIONAL_UPDATE);
  grantPermission(RECIPIENT_B, P.OPERATIONAL_READ);
  grantPermission(RECIPIENT_B, P.OPERATIONAL_UPDATE);
  for (const permission of CLOSE_PERMISSIONS) grantPermission(CLOSER_B, permission);
  for (const publication of PUBLICATIONS) insertPublication(publication);
  enablePersonnelLifecycle();
  return sessions;
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

test("O4 Aufgaben- und Abschluss-API bleibt actor-, scope-, rechte- und replay-sicher", async (t) => {
  const sessions = createFixture();
  const overviewProfile = await request(OVERVIEW_PROFILE_ROUTE, { auth: sessions.developer });
  assert.equal(overviewProfile.response.status, 200, overviewProfile.text);
  assert.equal(overviewProfile.payload.capabilities.canReadOverview, true);
  const profile = await request(PROFILE_ROUTE, { auth: sessions.developer });
  assert.equal(profile.response.status, 200, profile.text);
  const started = await request(START_ROUTE, {
    method: "POST",
    auth: sessions.developer,
    body: startBody(profile.payload, operationId(1)),
  });
  assert.equal(started.response.status, 201, started.text);
  const caseId = started.payload.onboardingExecution.caseId;
  db.prepare(`
    UPDATE portal_users SET role = 'department_manager', updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ?
  `).run(RECIPIENT_B);
  setScopedOperationalPermissions(RECIPIENT_B, LOCATION, DEPARTMENT);
  const startSnapshot = businessSnapshot(caseId);
  assert.equal(startSnapshot.caseState, "active");
  assert.equal(startSnapshot.stepStates.length, 2);
  assert.equal(startSnapshot.stepStates.every(({ status }) => status === "active"), true);

  let taskA;
  let taskB;

  await t.test("GET zeigt normalen Mitarbeitenden ausschließlich ihre exakte Zuweisung", async () => {
    const unauthenticated = await request(TASKS_ROUTE);
    assertError(unauthenticated, 401, "PORTAL_LOGIN_REQUIRED");
    assertBusinessUnchanged(startSnapshot, caseId, "GET ohne Sitzung");

    const noAssignment = await request(TASKS_ROUTE, { auth: sessions.outsider });
    assert.equal(noAssignment.response.status, 200, noAssignment.text);
    assert.deepEqual(noAssignment.payload.tasks, []);
    assertBusinessUnchanged(startSnapshot, caseId, "GET ohne persönliche Zuweisung");

    const listedA = await request(TASKS_ROUTE, { auth: sessions.recipientA });
    assert.equal(listedA.response.status, 200, listedA.text);
    assert.deepEqual(listedA.payload.capabilities, {
      canReadOnboardingTasks: true,
      canCompleteOnboardingTasks: true,
    });
    assert.equal(listedA.payload.tasks.length, 1);
    [taskA] = listedA.payload.tasks;
    assert.equal(taskA.workflowCode, PUBLICATIONS[0].workflowCode);
    assert.deepEqual(taskA.subject, {
      employeeNumber: SUBJECT,
      displayName: "O4 Aufgaben Zielperson",
    });
    assert.deepEqual(taskA.scope, {
      type: "department",
      locationId: LOCATION,
      departmentId: DEPARTMENT,
    });
    assert.equal(JSON.stringify(listedA.payload).includes(PRIVATE_MARKER), false);

    const listedB = await request(TASKS_ROUTE, { auth: sessions.recipientB });
    assert.equal(listedB.response.status, 200, listedB.text);
    assert.equal(listedB.payload.tasks.length, 1);
    [taskB] = listedB.payload.tasks;
    assert.equal(taskB.workflowCode, PUBLICATIONS[1].workflowCode);
    assert.notEqual(taskA.runId, taskB.runId);

  });

  await t.test("Aufgabenabschluss bleibt an CSRF und die persönliche Zuweisung gebunden", async () => {
    const baseline = businessSnapshot(caseId);
    const wrongCsrf = await request(completeRoute(taskA), {
      method: "POST",
      auth: sessions.recipientA,
      csrfToken: "wrong-csrf-token",
      body: { operationId: operationId(11), action: "complete" },
    });
    assertError(wrongCsrf, 403, "PORTAL_CSRF_INVALID", [operationId(11)]);
    assertBusinessUnchanged(baseline, caseId, "Abschluss mit falschem CSRF");

    const actorIdor = await request(completeRoute(taskB), {
      method: "POST",
      auth: sessions.recipientA,
      body: { operationId: operationId(12), action: "complete" },
    });
    assertError(actorIdor, 404, "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_NOT_FOUND", [taskB.runId]);
    assertBusinessUnchanged(baseline, caseId, "Abschluss einer fremden Zuweisung");
  });

  await t.test("skip, not_applicable, Ausnahme und Evidence bleiben ueber HTTP fail-closed", async () => {
    const baseline = businessSnapshot(caseId);
    const attempts = [
      [{ operationId: operationId(20), action: "skip" }, 409,
        "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_ACTION_DEFERRED"],
      [{ operationId: operationId(21), action: "not_applicable" }, 409,
        "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_NOT_APPLICABLE_DEFERRED"],
      [{ operationId: operationId(22), action: "complete", notApplicable: true }, 409,
        "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_NOT_APPLICABLE_DEFERRED"],
      [{ operationId: operationId(23), action: "complete", exception: { reason: "test" } }, 409,
        "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_EXCEPTION_DEFERRED"],
      [{ operationId: operationId(24), action: "complete", evidenceReference: "document-test" }, 409,
        "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_EVIDENCE_DEFERRED"],
    ];
    for (const [body, status, code] of attempts) {
      const rejected = await request(completeRoute(taskA), {
        method: "POST",
        auth: sessions.recipientA,
        body,
      });
      assertError(rejected, status, code, [body.operationId]);
      assertBusinessUnchanged(baseline, caseId, code);
    }
  });

  await t.test("Fallabschluss erzwingt zentrale Rechte, CSRF, IDOR, Bestaetigung und Vollstaendigkeit", async () => {
    const baseline = businessSnapshot(caseId);
    const closeBody = { operationId: operationId(30), confirmation: "CLOSE_ONBOARDING" };
    const developerCanClose = await request(closeRoute(caseId), {
      method: "POST",
      auth: sessions.developer,
      body: closeBody,
    });
    assertError(developerCanClose, 409, "PERSONNEL_LIFECYCLE_ONBOARDING_CLOSE_INCOMPLETE",
      [caseId, closeBody.operationId]);
    assertBusinessUnchanged(baseline, caseId, "Developer-Fallabschluss mit offenen Aufgaben");

    const missingCloseRight = await request(closeRoute(caseId), {
      method: "POST",
      auth: sessions.recipientA,
      body: { ...closeBody, operationId: operationId(301) },
    });
    assertError(missingCloseRight, 403, "PORTAL_PERMISSION_DENIED",
      [caseId, operationId(301)]);
    assertBusinessUnchanged(baseline, caseId, "Fallabschluss ohne zentrale Rechte");

    const wrongCsrf = await request(closeRoute(caseId), {
      method: "POST",
      auth: sessions.closerB,
      csrfToken: "wrong-csrf-token",
      body: { ...closeBody, operationId: operationId(31) },
    });
    assertError(wrongCsrf, 403, "PORTAL_CSRF_INVALID", [caseId, operationId(31)]);
    assertBusinessUnchanged(baseline, caseId, "Fallabschluss mit falschem CSRF");

    const idorCaseId = crypto.randomUUID();
    const idor = await request(closeRoute(idorCaseId), {
      method: "POST",
      auth: sessions.closerB,
      body: { ...closeBody, operationId: operationId(32) },
    });
    assertError(idor, 404, "PERSONNEL_LIFECYCLE_ONBOARDING_CASE_NOT_FOUND", [idorCaseId]);
    assertBusinessUnchanged(baseline, caseId, "Fallabschluss eines fremden Falls");

    const missingConfirmation = await request(closeRoute(caseId), {
      method: "POST",
      auth: sessions.closerB,
      body: { operationId: operationId(33), confirmation: "" },
    });
    assertError(missingConfirmation, 400,
      "PERSONNEL_LIFECYCLE_ONBOARDING_CLOSE_CONFIRMATION_REQUIRED", [caseId, operationId(33)]);

    for (const [index, deferredBody, code] of [
      [34, { notApplicable: true }, "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_NOT_APPLICABLE_DEFERRED"],
      [35, { exception: { reason: "test" } }, "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_EXCEPTION_DEFERRED"],
      [36, { evidenceReference: "document-test" }, "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_EVIDENCE_DEFERRED"],
    ]) {
      const rejected = await request(closeRoute(caseId), {
        method: "POST",
        auth: sessions.closerB,
        body: {
          operationId: operationId(index),
          confirmation: "CLOSE_ONBOARDING",
          ...deferredBody,
        },
      });
      assertError(rejected, 409, code, [caseId, operationId(index)]);
      assertBusinessUnchanged(baseline, caseId, code);
    }

    const incomplete = await request(closeRoute(caseId), {
      method: "POST",
      auth: sessions.closerB,
      body: closeBody,
    });
    assertError(incomplete, 409, "PERSONNEL_LIFECYCLE_ONBOARDING_CLOSE_INCOMPLETE",
      [caseId, closeBody.operationId]);
    assertBusinessUnchanged(baseline, caseId, "Fallabschluss mit offenen Aufgaben");
  });

  let completedA;
  await t.test("Aufgabenabschluss schreibt genau einmal und liefert einen exakten Replay", async () => {
    const baseline = businessSnapshot(caseId);
    const body = { operationId: operationId(40), action: "complete", evidenceReference: null };
    const completed = await request(completeRoute(taskA), {
      method: "POST",
      auth: sessions.recipientA,
      body,
    });
    assert.equal(completed.response.status, 200, completed.text);
    assert.equal(completed.response.headers.get("idempotency-replayed"), null);
    completedA = completed.payload.onboardingTask;
    assert.deepEqual({
      caseId: completedA.caseId,
      runId: completedA.runId,
      stepId: completedA.stepId,
      status: completedA.status,
      resolved: completedA.resolved,
      replayed: completedA.replayed,
    }, {
      caseId,
      runId: taskA.runId,
      stepId: taskA.stepId,
      status: "completed",
      resolved: true,
      replayed: false,
    });
    assert.match(completedA.eventId, /^[0-9a-f-]{36}$/);
    assert.equal(completedA.progress.completedSteps, 1);
    const completedSnapshot = businessSnapshot(caseId);
    assert.equal(completedSnapshot.taskEvents, baseline.taskEvents + 1);
    assert.equal(completedSnapshot.successAudits, baseline.successAudits + 2);
    assert.equal(completedSnapshot.stepStates.filter(({ status }) => status === "completed").length, 1);
    assert.deepEqual(completedSnapshot.externalSideEffects, baseline.externalSideEffects);

    const replay = await request(completeRoute(taskA), {
      method: "POST",
      auth: sessions.recipientA,
      body,
    });
    assert.equal(replay.response.status, 200, replay.text);
    assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
    assert.deepEqual({ ...replay.payload.onboardingTask, replayed: false }, completedA);
    assertBusinessUnchanged(completedSnapshot, caseId, "idempotenter Aufgaben-Replay");

    const onlyRemaining = await request(TASKS_ROUTE, { auth: sessions.recipientA });
    assert.equal(onlyRemaining.response.status, 200, onlyRemaining.text);
    assert.deepEqual(onlyRemaining.payload.tasks, []);
  });

  await t.test("Abschluss bleibt bis zur letzten Aufgabe gesperrt", async () => {
    const baseline = businessSnapshot(caseId);
    const incomplete = await request(closeRoute(caseId), {
      method: "POST",
      auth: sessions.closerB,
      body: { operationId: operationId(41), confirmation: "CLOSE_ONBOARDING" },
    });
    assertError(incomplete, 409, "PERSONNEL_LIFECYCLE_ONBOARDING_CLOSE_INCOMPLETE",
      [caseId, operationId(41)]);
    assertBusinessUnchanged(baseline, caseId, "Fallabschluss mit einer offenen Aufgabe");

    const completedB = await request(completeRoute(taskB), {
      method: "POST",
      auth: sessions.recipientB,
      body: { operationId: operationId(42), action: "complete" },
    });
    assert.equal(completedB.response.status, 200, completedB.text);
    assert.equal(completedB.payload.onboardingTask.replayed, false);
    assert.equal(completedB.payload.onboardingTask.resolved, true);
    assert.equal(businessSnapshot(caseId).stepStates.every(({ status }) => status === "completed"), true);

    grantPermission(DEVELOPER, P.ONBOARDING_CLOSE);
    const closableProfile = await request(PROFILE_ROUTE, { auth: sessions.developer });
    assert.equal(closableProfile.response.status, 200, closableProfile.text);
    assert.equal(closableProfile.payload.capabilities.canCloseOnboarding, true);
    assert.deepEqual({
      caseId: closableProfile.payload.onboardingExecution.activeCase.caseId,
      state: closableProfile.payload.onboardingExecution.activeCase.state,
      completedTaskCount: closableProfile.payload.onboardingExecution.activeCase.completedTaskCount,
      taskCount: closableProfile.payload.onboardingExecution.activeCase.taskCount,
      closeAvailable: closableProfile.payload.onboardingExecution.activeCase.closeAvailable,
    }, {
      caseId,
      state: "active",
      completedTaskCount: 2,
      taskCount: 2,
      closeAvailable: true,
    });
  });

  await t.test("Fallabschluss schreibt genau einmal; Replay bleibt an den Actor gebunden", async () => {
    const baseline = businessSnapshot(caseId);
    const body = { operationId: operationId(50), confirmation: "CLOSE_ONBOARDING", evidenceReference: null };
    const closed = await request(closeRoute(caseId), {
      method: "POST",
      auth: sessions.closerB,
      body,
    });
    assert.equal(closed.response.status, 200, closed.text);
    assert.equal(closed.response.headers.get("idempotency-replayed"), null);
    const result = closed.payload.onboardingCase;
    assert.equal(result.caseId, caseId);
    assert.equal(result.state, "completed");
    assert.equal(result.replayed, false);
    assert.match(result.eventId, /^[0-9a-f-]{36}$/);
    assert.match(result.closedAt, /^\d{4}-\d{2}-\d{2}T/);
    const closedSnapshot = businessSnapshot(caseId);
    assert.equal(closedSnapshot.caseState, "completed");
    assert.equal(closedSnapshot.closeEvents, baseline.closeEvents + 1);
    assert.equal(closedSnapshot.successAudits, baseline.successAudits + 1);
    assert.deepEqual(closedSnapshot.externalSideEffects, baseline.externalSideEffects);

    const replay = await request(closeRoute(caseId), {
      method: "POST",
      auth: sessions.closerB,
      body,
    });
    assert.equal(replay.response.status, 200, replay.text);
    assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
    assert.deepEqual({ ...replay.payload.onboardingCase, replayed: false }, result);
    assertBusinessUnchanged(closedSnapshot, caseId, "idempotenter Fallabschluss-Replay");

    const completedProfile = await request(PROFILE_ROUTE, { auth: sessions.developer });
    assert.equal(completedProfile.response.status, 200, completedProfile.text);
    assert.equal(completedProfile.payload.onboardingExecution.formAvailable, false);
    assert.deepEqual({
      caseId: completedProfile.payload.onboardingExecution.activeCase.caseId,
      state: completedProfile.payload.onboardingExecution.activeCase.state,
      closeAvailable: completedProfile.payload.onboardingExecution.activeCase.closeAvailable,
      completedAt: Boolean(completedProfile.payload.onboardingExecution.activeCase.completedAt),
    }, {
      caseId,
      state: "completed",
      closeAvailable: false,
      completedAt: true,
    });
    const forbiddenRestart = await request(START_ROUTE, {
      method: "POST",
      auth: sessions.developer,
      body: startBody(completedProfile.payload, operationId(51)),
    });
    assertError(forbiddenRestart, 409, "PERSONNEL_LIFECYCLE_ONBOARDING_CASE_EXISTS",
      [caseId, operationId(51)]);
    assertBusinessUnchanged(closedSnapshot, caseId, "zweiter Start nach terminalem Fall");

    for (const permission of CLOSE_PERMISSIONS) grantPermission(DEVELOPER, permission);
    const actorMismatch = await request(closeRoute(caseId), {
      method: "POST",
      auth: sessions.developer,
      body,
    });
    assertError(actorMismatch, 409, "PERSONNEL_LIFECYCLE_ONBOARDING_CLOSE_OPERATION_CONFLICT",
      [caseId, body.operationId]);
    assertBusinessUnchanged(closedSnapshot, caseId, "Fallabschluss-Replay durch anderen Actor");
  });
});

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

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-o5-api-"));
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

const LOCATION = "o5-api-location";
const DEPARTMENT = 9951;
const SUBJECT = "O5-API-SUBJECT";
const DEVELOPER = "O5-API-DEV";
const IT_ASSIGNEE = "O5-API-IT";
const OUTSIDER = "O5-API-OUTSIDER";
const CONFIDENTIAL_MARKER = "O5-API-STRICT-CONFIDENTIAL-MUST-NOT-LEAK";
const PROFILE_ROUTE = `/api/portal/v1/personnel-lifecycle/employees/${SUBJECT}/profile?tab=offboarding`;
const PREPARE_ROUTE = `/api/portal/v1/personnel-lifecycle/employees/${SUBJECT}/offboarding-preparations`;
const TASKS_ROUTE = "/api/portal/v1/personnel-lifecycle/offboarding/tasks";
const EXTERNAL_SIDE_EFFECT_TABLES = Object.freeze([
  "portal_notifications",
  "outbound_notification_jobs",
  "integration_deliveries",
]);
const DEVELOPER_PERMISSIONS = Object.freeze([
  "personnel:central:read",
  P.OFFBOARDING_CONFIDENTIAL_READ,
  P.OFFBOARDING_PREPARE,
  P.OFFBOARDING_COMMUNICATION_RELEASE,
  P.OFFBOARDING_INFORMATION_CONFIRM,
  P.OFFBOARDING_EXECUTE,
  P.OFFBOARDING_CLOSE,
  P.PACKAGES_READ,
  P.ASSIGNMENTS_WRITE,
  P.EXCEPTIONS_APPROVE,
  P.OPERATIONAL_READ,
  P.OPERATIONAL_UPDATE,
]);

let httpServer;
let baseUrl;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function operationId(index) {
  return `66000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
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

function insertEmployee(employeeNumber, fullName) {
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES (?, ?, ?, ?, ?, 1)
  `).run(employeeNumber, fullName, fullName, LOCATION, DEPARTMENT);
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

function countsFor(tables) {
  return Object.fromEntries(tables.map((tableName) => [
    tableName,
    Number(db.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get().count || 0),
  ]));
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
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload, text };
}

function assertNoStoreWithoutEtag(result) {
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.response.headers.get("pragma"), "no-cache");
  assert.equal(result.response.headers.get("etag"), null);
}

function assertError(result, status, code) {
  assert.equal(result.response.status, status, result.text);
  assert.equal(result.payload?.code, code, result.text);
  assert.equal(typeof result.payload?.error, "string");
  assert.equal(typeof result.payload?.requestId, "string");
  assert.deepEqual(Object.keys(result.payload).sort(), ["code", "error", "requestId"]);
  assert.equal(result.text.includes(CONFIDENTIAL_MARKER), false);
  assert.equal(result.text.includes(SUBJECT), false);
}

function mutationReason(code) {
  return {
    code,
    note: `${CONFIDENTIAL_MARKER}: geschützte Begründung`,
    documentReferenceIds: ["O5-API-DOC-MUTATION"],
  };
}

function preparationBody(profile, index, { timeCritical = false } = {}) {
  assert.equal(profile.offboarding.preparation.packages.length, 6);
  return {
    operationId: operationId(index),
    confirmation: "PREPARE_OFFBOARDING",
    referenceTimes: {
      plannedExitAt: "2026-09-30T16:00:00.000Z",
      lastWorkingDay: "2026-09-30",
      legalExitDate: "2026-09-30",
      accessBlockAt: "2026-09-30T16:00:00.000Z",
    },
    urgency: timeCritical ? {
      mode: "time_critical",
      confirmation: "CONFIRM_TIME_CRITICAL_OFFBOARDING",
      exceptionReason: {
        code: "immediate_exit",
        note: `${CONFIDENTIAL_MARKER}: zeitkritische Ausnahme`,
      },
      followUpDueAt: "2026-10-02T12:00:00.000Z",
    } : {
      mode: "standard",
      confirmation: null,
      exceptionReason: null,
      followUpDueAt: null,
    },
    exitReason: {
      code: "employee_notice",
      note: `${CONFIDENTIAL_MARKER}: Austrittsgrund`,
    },
    hrNote: `${CONFIDENTIAL_MARKER}: vertraulicher PL-Vermerk`,
    documentReferenceIds: ["O5-API-DOC-001"],
    assignments: profile.offboarding.preparation.packages.map((entry) => {
      const assigneeActorId = entry.familyCode === "work_access_assets"
        ? IT_ASSIGNEE
        : DEVELOPER;
      assert.equal(
        entry.candidates.some(({ actorId }) => actorId === assigneeActorId),
        true,
        `${entry.familyCode}:${assigneeActorId}`,
      );
      return {
        familyCode: entry.familyCode,
        assigneeActorId,
        title: entry.title,
        instructions: `${CONFIDENTIAL_MARKER}: Anweisung ${entry.familyCode}`,
      };
    }),
  };
}

function caseActionRoute(caseId, action) {
  return `/api/portal/v1/personnel-lifecycle/offboarding/cases/${caseId}/${action}`;
}

function taskCompletionRoute(task) {
  return `/api/portal/v1/personnel-lifecycle/offboarding/tasks/${task.runId}/${task.stepId}/completions`;
}

function o5CaseRuntimeCounts(caseId) {
  return {
    bindings: Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM personnel_lifecycle_offboarding_package_bindings
      WHERE case_id = ?
    `).get(caseId).count || 0),
    runs: Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM personnel_lifecycle_offboarding_package_runs package_run
      JOIN personnel_lifecycle_offboarding_package_bindings binding
        ON binding.id = package_run.package_binding_id
      WHERE binding.case_id = ?
    `).get(caseId).count || 0),
    genericBindings: Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM personnel_lifecycle_offboarding_package_runs package_run
      JOIN personnel_lifecycle_offboarding_package_bindings binding
        ON binding.id = package_run.package_binding_id
      JOIN custom_process_run_bindings generic_binding
        ON generic_binding.run_id = package_run.run_id
      WHERE binding.case_id = ?
    `).get(caseId).count || 0),
    genericAssignments: Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM personnel_lifecycle_offboarding_package_runs package_run
      JOIN personnel_lifecycle_offboarding_package_bindings binding
        ON binding.id = package_run.package_binding_id
      JOIN custom_process_run_step_assignments generic_assignment
        ON generic_assignment.run_id = package_run.run_id
      WHERE binding.case_id = ?
    `).get(caseId).count || 0),
  };
}

function createFixture() {
  db.prepare(`
    INSERT INTO locations (id, name, active)
    VALUES (?, 'O5 API Standort', 1)
  `).run(LOCATION);
  db.prepare(`
    INSERT INTO departments (id, location_id, name, active, sort_order)
    VALUES (?, ?, 'O5 API Abteilung', 1, 9951)
  `).run(DEPARTMENT, LOCATION);
  insertEmployee(SUBJECT, "O5 API Zielperson");
  insertEmployee(DEVELOPER, "O5 API Developer");
  insertEmployee(IT_ASSIGNEE, "O5 API IT-Fachperson");
  insertEmployee(OUTSIDER, "O5 API Ohne Rechte");

  const sessions = {
    developer: createEmployeeSession(DEVELOPER, "developer"),
    it: createEmployeeSession(IT_ASSIGNEE, "employee"),
    outsider: createEmployeeSession(OUTSIDER, "employee"),
  };
  for (const permission of DEVELOPER_PERMISSIONS) grantPermission(DEVELOPER, permission);
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

test("O5-HTTP-Vertrag bleibt vertraulich, actor-gebunden und vollständig kontrolliert", async (t) => {
  const sessions = createFixture();
  const externalBaseline = countsFor(EXTERNAL_SIDE_EFFECT_TABLES);

  let initialProfile;
  await t.test("Profil und Vorbereitung sind fachrechtlich getrennt und cache-frei", async () => {
    const unauthenticated = await request(PROFILE_ROUTE);
    assertError(unauthenticated, 401, "PORTAL_LOGIN_REQUIRED");
    const forbidden = await request(PROFILE_ROUTE, { auth: sessions.outsider });
    assertError(forbidden, 403, "PORTAL_PERMISSION_DENIED");

    const loaded = await request(PROFILE_ROUTE, { auth: sessions.developer });
    assert.equal(loaded.response.status, 200, loaded.text);
    assertNoStoreWithoutEtag(loaded);
    initialProfile = loaded.payload;
    assert.equal(initialProfile.offboarding.contractVersion, "o5-v0.1");
    assert.equal(initialProfile.offboarding.mode, "confidential_offboarding");
    assert.equal(initialProfile.offboarding.case, null);
    assert.equal(initialProfile.offboarding.preparation.available, true);
    assert.equal(initialProfile.offboarding.preparation.packages.length, 6);
    const assetFamily = initialProfile.offboarding.preparation.packages
      .find(({ familyCode }) => familyCode === "work_access_assets");
    const payrollFamily = initialProfile.offboarding.preparation.packages
      .find(({ familyCode }) => familyCode === "hr_contract_end");
    assert.equal(assetFamily.candidates.some(({ actorId }) => actorId === IT_ASSIGNEE), true);
    assert.equal(payrollFamily.candidates.some(({ actorId }) => actorId === IT_ASSIGNEE), false);
    assert.equal(loaded.text.includes(CONFIDENTIAL_MARKER), false);

    const injected = await request(PREPARE_ROUTE, {
      method: "POST",
      auth: sessions.developer,
      body: {
        ...preparationBody(initialProfile, 1),
        employeeNumber: OUTSIDER,
      },
    });
    assertError(injected, 400, "PERSONNEL_LIFECYCLE_OFFBOARDING_INPUT_INVALID");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM personnel_lifecycle_cases").get().count, 0);

    const wrongCsrf = await request(PREPARE_ROUTE, {
      method: "POST",
      auth: sessions.developer,
      csrfToken: "wrong-csrf",
      body: preparationBody(initialProfile, 2),
    });
    assertError(wrongCsrf, 403, "PORTAL_CSRF_INVALID");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM personnel_lifecycle_cases").get().count, 0);
  });

  let cancelledCaseId;
  await t.test("interne Vorbereitung erzeugt keine Laufzeit und kann additiv abgebrochen werden", async () => {
    const prepared = await request(PREPARE_ROUTE, {
      method: "POST",
      auth: sessions.developer,
      body: preparationBody(initialProfile, 3),
    });
    assert.equal(prepared.response.status, 201, prepared.text);
    assertNoStoreWithoutEtag(prepared);
    cancelledCaseId = prepared.payload.offboardingCase.caseId;
    assert.equal(prepared.payload.offboardingCase.state, "internally_prepared");
    assert.equal(prepared.payload.offboardingCase.runtimeCount, 0);
    assert.deepEqual(o5CaseRuntimeCounts(cancelledCaseId), {
      bindings: 0,
      runs: 0,
      genericBindings: 0,
      genericAssignments: 0,
    });

    const projected = await request(PROFILE_ROUTE, { auth: sessions.developer });
    assert.equal(projected.response.status, 200, projected.text);
    assertNoStoreWithoutEtag(projected);
    assert.equal(projected.payload.offboarding.case.caseId, cancelledCaseId);
    assert.equal(projected.payload.offboarding.case.state, "internally_prepared");
    assert.equal(projected.payload.offboarding.case.confidential.hrNote.includes(
      CONFIDENTIAL_MARKER,
    ), true);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM personnel_lifecycle_confidential_access_events
      WHERE case_id = ?
    `).get(cancelledCaseId).count, 1);

    const cancelled = await request(caseActionRoute(cancelledCaseId, "cancellations"), {
      method: "POST",
      auth: sessions.developer,
      body: {
        operationId: operationId(4),
        expectedRevision: 1,
        confirmation: "CANCEL_OFFBOARDING",
        reason: mutationReason("preparation_withdrawn"),
      },
    });
    assert.equal(cancelled.response.status, 200, cancelled.text);
    assertNoStoreWithoutEtag(cancelled);
    assert.equal(cancelled.payload.offboardingCase.state, "cancelled");
    assert.equal(cancelled.payload.offboardingCase.terminatedRunCount, 0);
    assert.deepEqual(o5CaseRuntimeCounts(cancelledCaseId), {
      bindings: 0,
      runs: 0,
      genericBindings: 0,
      genericAssignments: 0,
    });
    assert.equal(db.prepare(`
      SELECT state FROM personnel_employment_episodes
      WHERE employee_number = ? ORDER BY sequence_number DESC LIMIT 1
    `).get(SUBJECT).state, "employment_active");
  });

  let activeCaseId;
  await t.test("Neustart nutzt Vorgängerbezug und zeitkritische Freigabe vor Kommunikation", async () => {
    const restartProfile = await request(PROFILE_ROUTE, { auth: sessions.developer });
    assert.equal(restartProfile.response.status, 200, restartProfile.text);
    assert.equal(restartProfile.payload.offboarding.case, null);
    assert.equal(restartProfile.payload.offboarding.preparation.available, true);
    const prepared = await request(PREPARE_ROUTE, {
      method: "POST",
      auth: sessions.developer,
      body: preparationBody(restartProfile.payload, 5, { timeCritical: true }),
    });
    assert.equal(prepared.response.status, 201, prepared.text);
    activeCaseId = prepared.payload.offboardingCase.caseId;
    assert.equal(db.prepare(`
      SELECT predecessor_case_id AS predecessorCaseId
      FROM personnel_lifecycle_cases WHERE id = ?
    `).get(activeCaseId).predecessorCaseId, cancelledCaseId);

    const releaseBeforeApproval = await request(
      caseActionRoute(activeCaseId, "communication-releases"),
      {
        method: "POST",
        auth: sessions.developer,
        body: {
          operationId: operationId(6),
          expectedRevision: 1,
          confirmation: "RELEASE_OFFBOARDING_COMMUNICATION",
          reason: mutationReason("communication_approved"),
        },
      },
    );
    assertError(
      releaseBeforeApproval,
      409,
      "PERSONNEL_LIFECYCLE_OFFBOARDING_TIME_CRITICAL_APPROVAL_REQUIRED",
    );
    assert.deepEqual(o5CaseRuntimeCounts(activeCaseId), {
      bindings: 0,
      runs: 0,
      genericBindings: 0,
      genericAssignments: 0,
    });

    const approved = await request(caseActionRoute(activeCaseId, "time-critical-approvals"), {
      method: "POST",
      auth: sessions.developer,
      body: {
        operationId: operationId(7),
        expectedRevision: 1,
        confirmation: "CONFIRM_TIME_CRITICAL_OFFBOARDING",
        reason: mutationReason("time_critical_approved"),
      },
    });
    assert.equal(approved.response.status, 200, approved.text);
    assertNoStoreWithoutEtag(approved);
    assert.equal(approved.payload.offboardingCase.approved, true);
    assert.equal(approved.payload.offboardingCase.revision, 1);
  });

  let itTask;
  await t.test("Kommunikationsfreigabe erzeugt sechs pending Aufgaben ohne Falloffenlegung", async () => {
    const released = await request(caseActionRoute(activeCaseId, "communication-releases"), {
      method: "POST",
      auth: sessions.developer,
      body: {
        operationId: operationId(8),
        expectedRevision: 1,
        confirmation: "RELEASE_OFFBOARDING_COMMUNICATION",
        reason: mutationReason("communication_approved"),
      },
    });
    assert.equal(released.response.status, 200, released.text);
    assertNoStoreWithoutEtag(released);
    assert.equal(released.payload.offboardingCase.state, "communication_released");
    assert.equal(released.payload.offboardingCase.runtimeCount, 6);
    assert.deepEqual(o5CaseRuntimeCounts(activeCaseId), {
      bindings: 6,
      runs: 6,
      genericBindings: 0,
      genericAssignments: 0,
    });

    const noAssignment = await request(TASKS_ROUTE, { auth: sessions.outsider });
    assert.equal(noAssignment.response.status, 200, noAssignment.text);
    assert.deepEqual(noAssignment.payload.tasks, []);
    const listed = await request(TASKS_ROUTE, { auth: sessions.it });
    assert.equal(listed.response.status, 200, listed.text);
    assertNoStoreWithoutEtag(listed);
    assert.deepEqual(listed.payload.capabilities, {
      canReadOffboardingTasks: true,
      canCompleteOffboardingTasks: true,
    });
    assert.equal(listed.payload.tasks.length, 1);
    [itTask] = listed.payload.tasks;
    assert.equal(itTask.projection, "asset_task");
    assert.equal(itTask.status, "pending");
    assert.equal(listed.text.includes(CONFIDENTIAL_MARKER), false);
    for (const forbiddenField of [
      "caseId",
      "exitReasonCode",
      "exitReasonNote",
      "hrNote",
      "instructions",
      "documentReferenceIds",
    ]) assert.equal(Object.hasOwn(itTask, forbiddenField), false, forbiddenField);

    const evidenceRejected = await request(taskCompletionRoute(itTask), {
      method: "POST",
      auth: sessions.it,
      body: {
        operationId: operationId(9),
        action: "complete",
        evidenceReference: "O5-API-EVIDENCE-FORBIDDEN",
      },
    });
    assertError(
      evidenceRejected,
      400,
      "PERSONNEL_LIFECYCLE_OFFBOARDING_TASK_INPUT_INVALID",
    );
  });

  await t.test("Information, Aktivierung, exakter Taskabschluss und Fallabschluss bleiben geordnet", async () => {
    const informed = await request(caseActionRoute(activeCaseId, "information-confirmations"), {
      method: "POST",
      auth: sessions.developer,
      body: {
        operationId: operationId(10),
        expectedRevision: 2,
        confirmation: "CONFIRM_OFFBOARDING_INFORMATION",
        employeeInformedAt: "2026-09-29T12:00:00.000Z",
      },
    });
    assert.equal(informed.response.status, 200, informed.text);
    assert.equal(informed.payload.offboardingCase.state, "employee_informed");
    const activated = await request(caseActionRoute(activeCaseId, "activations"), {
      method: "POST",
      auth: sessions.developer,
      body: {
        operationId: operationId(11),
        expectedRevision: 3,
        confirmation: "ACTIVATE_OFFBOARDING",
      },
    });
    assert.equal(activated.response.status, 200, activated.text);
    assert.equal(activated.payload.offboardingCase.state, "active");

    const activeIt = await request(TASKS_ROUTE, { auth: sessions.it });
    assert.equal(activeIt.response.status, 200, activeIt.text);
    assert.equal(activeIt.payload.tasks.length, 1);
    assert.equal(activeIt.payload.tasks[0].status, "active");
    const completedIt = await request(taskCompletionRoute(activeIt.payload.tasks[0]), {
      method: "POST",
      auth: sessions.it,
      body: {
        operationId: operationId(12),
        action: "complete",
        evidenceReference: null,
      },
    });
    assert.equal(completedIt.response.status, 200, completedIt.text);
    assertNoStoreWithoutEtag(completedIt);
    assert.equal(completedIt.payload.offboardingTask.status, "completed");
    const replay = await request(taskCompletionRoute(activeIt.payload.tasks[0]), {
      method: "POST",
      auth: sessions.it,
      body: {
        operationId: operationId(12),
        action: "complete",
        evidenceReference: null,
      },
    });
    assert.equal(replay.response.status, 200, replay.text);
    assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
    assert.equal(replay.payload.offboardingTask.replayed, true);

    const incomplete = await request(caseActionRoute(activeCaseId, "closures"), {
      method: "POST",
      auth: sessions.developer,
      body: {
        operationId: operationId(13),
        expectedRevision: 4,
        confirmation: "CLOSE_OFFBOARDING",
      },
    });
    assertError(
      incomplete,
      409,
      "PERSONNEL_LIFECYCLE_OFFBOARDING_CLOSE_INCOMPLETE",
    );

    const developerTasks = await request(TASKS_ROUTE, { auth: sessions.developer });
    assert.equal(developerTasks.response.status, 200, developerTasks.text);
    assert.equal(developerTasks.payload.tasks.length, 5);
    for (const [index, taskValue] of developerTasks.payload.tasks.entries()) {
      assert.equal(taskValue.status, "active");
      const completed = await request(taskCompletionRoute(taskValue), {
        method: "POST",
        auth: sessions.developer,
        body: { operationId: operationId(20 + index), action: "complete" },
      });
      assert.equal(completed.response.status, 200, completed.text);
      assert.equal(completed.payload.offboardingTask.status, "completed");
    }

    const closed = await request(caseActionRoute(activeCaseId, "closures"), {
      method: "POST",
      auth: sessions.developer,
      body: {
        operationId: operationId(30),
        expectedRevision: 4,
        confirmation: "CLOSE_OFFBOARDING",
      },
    });
    assert.equal(closed.response.status, 200, closed.text);
    assertNoStoreWithoutEtag(closed);
    assert.equal(closed.payload.offboardingCase.state, "completed");
    assert.equal(closed.payload.offboardingCase.completedRunCount, 6);
    assert.equal(db.prepare(`
      SELECT state FROM personnel_employment_episodes
      WHERE employee_number = ? ORDER BY sequence_number DESC LIMIT 1
    `).get(SUBJECT).state, "employment_ended");
    assert.deepEqual(countsFor(EXTERNAL_SIDE_EFFECT_TABLES), externalBaseline);
  });

  await t.test("allgemeines Audit und generische M5-Pfade enthalten keine O5-Falldaten", async () => {
    const generalAudit = JSON.stringify(db.prepare(`
      SELECT actor, action, entity_type, entity_id, detail
      FROM audit_log ORDER BY id
    `).all());
    for (const forbidden of [CONFIDENTIAL_MARKER, SUBJECT, cancelledCaseId, activeCaseId]) {
      assert.equal(generalAudit.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(o5CaseRuntimeCounts(activeCaseId), {
      bindings: 6,
      runs: 6,
      genericBindings: 0,
      genericAssignments: 0,
    });
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM personnel_lifecycle_confidential_access_events
      WHERE case_id IN (?, ?)
    `).get(cancelledCaseId, activeCaseId).count > 0, true);
  });
});

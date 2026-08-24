"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "grabenplaner-personnel-workflow-instances-api-"),
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

const {
  app,
  db,
  releaseInstanceLockForTests,
} = require("../server");
const {
  PERSONNEL_WORKFLOW_PERMISSIONS: WORKFLOW,
} = require("../lib/personnel-workflow-access");

const LOCATION_A = "M5-A";
const LOCATION_B = "M5-B";
const EMPLOYEES = Object.freeze({
  hr: "M5-HR",
  starter: "M5-START",
  candidateDenied: "M5-NO-APP",
  employeeDenied: "M5-NO-EMP",
  readOnly: "M5-READ-ONLY",
  publishOnly: "M5-PUBLISH-ONLY",
  wrongScope: "M5-WRONG-SCOPE",
  employeeViewer: "M5-EMP-VIEW",
  candidateViewer: "M5-CAND-VIEW",
  outsider: "M5-OUTSIDE",
  assignee: "M5-ASSIGNEE",
  foreignAssignee: "M5-FOREIGN",
  wrongRole: "M5-WRONG-ROLE",
  subject: "M5-SUBJECT",
  it: "M5-IT",
});
const WORKFLOW_START_PERMISSIONS = Object.freeze([
  WORKFLOW.READ,
  WORKFLOW.DRAFT_WRITE,
  WORKFLOW.PUBLISH,
  WORKFLOW.LOCAL_SUPPLEMENT,
]);
const CANDIDATE_READ = "personnel:candidates:read";
const APPLICATION_WRITE = "personnel:applications:write";

let httpServer;
let baseUrl;

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

function createOrganizationFixture() {
  db.prepare("INSERT OR REPLACE INTO locations (id, name, active) VALUES (?, ?, 1)")
    .run(LOCATION_A, "M5 API Standort A");
  db.prepare("INSERT OR REPLACE INTO locations (id, name, active) VALUES (?, ?, 1)")
    .run(LOCATION_B, "M5 API Standort B");
  for (const [locationId, name] of [
    [LOCATION_A, "M5 API Abteilung A"],
    [LOCATION_B, "M5 API Abteilung B"],
  ]) {
    db.prepare(`
      INSERT OR IGNORE INTO departments (location_id, name, active)
      VALUES (?, ?, 1)
    `).run(locationId, name);
  }
  const department = (locationId, name) => Number(db.prepare(`
    SELECT id FROM departments WHERE location_id = ? AND name = ?
  `).get(locationId, name).id);
  return Object.freeze({
    departmentA: department(LOCATION_A, "M5 API Abteilung A"),
    departmentB: department(LOCATION_B, "M5 API Abteilung B"),
  });
}

function ensureEmployee(employeeNumber, label, locationId, departmentId) {
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      preferred_department_id = excluded.preferred_department_id,
      active = 1
  `).run(employeeNumber, `M5 API ${label}`, label, locationId, departmentId);
}

function createSession(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, role_locked, active,
      must_change_password, password_changed_at, updated_at
    ) VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      role = excluded.role,
      role_locked = 0,
      active = 1,
      must_change_password = 0,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return Object.freeze({
    cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,
    csrf,
  });
}

function grantPermission(employeeNumber, permission) {
  db.prepare(`
    INSERT OR IGNORE INTO portal_permission_grants (
      employee_number, permission, granted_by
    ) VALUES (?, ?, ?)
  `).run(employeeNumber, permission, EMPLOYEES.hr);
}

function grantScopedPermissions(employeeNumber, locationId, permissions) {
  db.prepare(`
    INSERT OR IGNORE INTO portal_access_scopes (
      employee_number, location_id, department_id, assigned_by
    ) VALUES (?, ?, 0, ?)
  `).run(employeeNumber, locationId, EMPLOYEES.hr);
  for (const permission of permissions) {
    grantPermission(employeeNumber, permission);
    db.prepare(`
      INSERT OR IGNORE INTO portal_permission_scope_grants (
        employee_number, permission, location_id, department_id, approved_by
      ) VALUES (?, ?, ?, 0, ?)
    `).run(employeeNumber, permission, locationId, EMPLOYEES.hr);
  }
}

function denyPermission(employeeNumber, permission) {
  db.prepare(`
    INSERT OR IGNORE INTO portal_permission_denials (
      employee_number, permission, denied_by
    ) VALUES (?, ?, ?)
  `).run(employeeNumber, permission, EMPLOYEES.hr);
}

async function createCandidateFixture(auth, departmentId) {
  const created = await request("/api/portal/v1/personnel-lifecycle/candidates", {
    method: "POST",
    auth,
    body: {
      dataProcessingAuthorizationConfirmed: true,
      profile: {
        firstName: "M5",
        lastName: "Synthetic",
        email: "m5-api-candidate@example.invalid",
        phone: "+43 660 5550101",
        address: { street: "Testweg 5", city: "Testort" },
        preferredLanguage: "de",
      },
      application: {
        desiredLocationId: LOCATION_A,
        desiredDepartmentId: departmentId,
        desiredRoleTitle: "M5 Synthetic Role",
        source: "M5 API integration test",
        internalRating: 4,
        internalNotes: "Synthetic M5 integration test data",
        communicationNotes: "Synthetic M5 integration test data",
        tags: ["m5", "synthetic"],
      },
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const candidate = created.payload?.candidate;
  const application = candidate?.applications?.[0];
  assert.ok(candidate?.id, JSON.stringify(created.payload));
  assert.ok(application?.id, JSON.stringify(created.payload));
  return Object.freeze({
    type: "candidate",
    candidateId: candidate.id,
    applicationId: application.id,
    candidateRevision: candidate.revision,
    applicationRevision: application.revision,
  });
}

function insertWorkflowDefinition({
  id,
  title,
  locationId = LOCATION_A,
  departmentId = null,
  responsibilityType = "role",
  responsibilityReference = "manager",
  conditionType = "always",
} = {}) {
  const scopeType = departmentId ? "department" : "location";
  const stepId = `${id}-step`;
  const snapshot = {
    id,
    revision: 1,
    title,
    scope: { type: scopeType, locationId, departmentId },
    steps: [{
      id: stepId,
      type: "actor",
      title: `${title} bearbeiten`,
      description: "Synthetischer M5-API-Schritt",
      responsibilityType,
      responsibilityReference,
      conditionType,
      notificationChannels: [],
    }],
  };
  db.prepare(`
    INSERT INTO custom_processes (
      id, title, symbol, description, category, scope_type, location_id,
      department_id, trigger_type, trigger_minimum_shortfall, status,
      revision, created_by, updated_by
    ) VALUES (?, ?, 'P', 'Synthetischer M5-API-Prozess', 'other', ?, ?, ?,
      'manual', 1, 'active', 1, ?, ?)
  `).run(
    id,
    title,
    scopeType,
    locationId,
    departmentId,
    EMPLOYEES.hr,
    EMPLOYEES.hr,
  );
  db.prepare(`
    INSERT INTO custom_process_steps (
      id, process_id, sort_order, step_type, title, description,
      responsibility_type, responsibility_reference, responsibility_label,
      condition_type, condition_text, notification_channels
    ) VALUES (?, ?, 1, 'actor', ?, 'Synthetischer M5-API-Schritt', ?, ?, ?, ?, '', '[]')
  `).run(
    stepId,
    id,
    `${title} bearbeiten`,
    responsibilityType,
    responsibilityReference,
    responsibilityReference,
    conditionType,
  );
  db.prepare(`
    INSERT INTO custom_process_revisions (
      process_id, revision, snapshot_json, created_by
    ) VALUES (?, 1, ?, ?)
  `).run(id, JSON.stringify(snapshot), EMPLOYEES.hr);
  return Object.freeze({ id, stepId, snapshot });
}

function publicationBody(workflowCode, workflowType, containsConfidentialSteps = false) {
  return {
    workflowCode,
    workflowType,
    requirementKind: "supplemental",
    dataClassification: "standard",
    containsConfidentialSteps,
  };
}

function workflowStartBody({
  publicationId,
  subject,
  stepId,
  employeeNumber = EMPLOYEES.assignee,
  operationId = crypto.randomUUID(),
} = {}) {
  return {
    operationId,
    publicationId,
    subject,
    assignments: [{ stepId, employeeNumber }],
  };
}

async function request(route, {
  method = "GET",
  auth = null,
  body,
  includeCsrf = true,
  headers: suppliedHeaders = {},
} = {}) {
  const headers = { Accept: "application/json", ...suppliedHeaders };
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
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { response, payload };
}

async function publish(auth, definition, workflowCode, workflowType) {
  const result = await request(
    `/api/portal/v1/personnel-lifecycle/workflows/${encodeURIComponent(definition.id)}/publish`,
    {
      method: "POST",
      auth,
      body: publicationBody(workflowCode, workflowType),
    },
  );
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  return result.payload.publication;
}

function instanceIds(payload) {
  return (Array.isArray(payload?.instances) ? payload.instances : [])
    .map(({ id }) => id)
    .sort();
}

function tasks(payload) {
  assert.ok(Array.isArray(payload?.items), JSON.stringify(payload));
  assert.ok(Array.isArray(payload?.tasks), JSON.stringify(payload));
  assert.deepEqual(payload.tasks, payload.items);
  return payload.items;
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

test("Personalmodul M5: echter HTTP-Vertrag bleibt fachlich, idempotent und legacy-kompatibel", async (t) => {
  enablePersonnelLifecycle();
  const organization = createOrganizationFixture();
  const locationByEmployee = new Map([
    [EMPLOYEES.wrongScope, [LOCATION_B, organization.departmentB]],
    [EMPLOYEES.outsider, [LOCATION_B, organization.departmentB]],
  ]);
  for (const [key, employeeNumber] of Object.entries(EMPLOYEES)) {
    const [locationId, departmentId] = locationByEmployee.get(employeeNumber)
      || [LOCATION_A, organization.departmentA];
    ensureEmployee(employeeNumber, key, locationId, departmentId);
  }

  const auth = Object.freeze({
    hr: createSession(EMPLOYEES.hr, "hr"),
    starter: createSession(EMPLOYEES.starter, "manager"),
    candidateDenied: createSession(EMPLOYEES.candidateDenied, "manager"),
    employeeDenied: createSession(EMPLOYEES.employeeDenied, "manager"),
    readOnly: createSession(EMPLOYEES.readOnly, "manager"),
    publishOnly: createSession(EMPLOYEES.publishOnly, "manager"),
    wrongScope: createSession(EMPLOYEES.wrongScope, "manager"),
    employeeViewer: createSession(EMPLOYEES.employeeViewer, "manager"),
    candidateViewer: createSession(EMPLOYEES.candidateViewer, "manager"),
    outsider: createSession(EMPLOYEES.outsider, "manager"),
    assignee: createSession(EMPLOYEES.assignee, "manager"),
    foreignAssignee: createSession(EMPLOYEES.foreignAssignee, "manager"),
    wrongRole: createSession(EMPLOYEES.wrongRole, "employee"),
    it: createSession(EMPLOYEES.it, "it_admin"),
  });

  grantScopedPermissions(
    EMPLOYEES.starter,
    LOCATION_A,
    [...WORKFLOW_START_PERMISSIONS, CANDIDATE_READ, APPLICATION_WRITE],
  );
  grantScopedPermissions(
    EMPLOYEES.candidateDenied,
    LOCATION_A,
    [...WORKFLOW_START_PERMISSIONS, CANDIDATE_READ],
  );
  grantScopedPermissions(
    EMPLOYEES.employeeDenied,
    LOCATION_A,
    WORKFLOW_START_PERMISSIONS,
  );
  denyPermission(EMPLOYEES.employeeDenied, "employees:read");
  grantScopedPermissions(
    EMPLOYEES.readOnly,
    LOCATION_A,
    [WORKFLOW.READ, CANDIDATE_READ, APPLICATION_WRITE],
  );
  grantScopedPermissions(
    EMPLOYEES.publishOnly,
    LOCATION_A,
    [WORKFLOW.PUBLISH, CANDIDATE_READ, APPLICATION_WRITE],
  );
  grantScopedPermissions(
    EMPLOYEES.wrongScope,
    LOCATION_B,
    [...WORKFLOW_START_PERMISSIONS, CANDIDATE_READ, APPLICATION_WRITE],
  );
  grantScopedPermissions(EMPLOYEES.employeeViewer, LOCATION_A, [WORKFLOW.READ]);
  grantScopedPermissions(
    EMPLOYEES.candidateViewer,
    LOCATION_A,
    [WORKFLOW.READ, CANDIDATE_READ],
  );
  denyPermission(EMPLOYEES.candidateViewer, "employees:read");
  grantScopedPermissions(
    EMPLOYEES.outsider,
    LOCATION_B,
    [WORKFLOW.READ, CANDIDATE_READ],
  );
  for (const employeeNumber of [EMPLOYEES.assignee, EMPLOYEES.foreignAssignee]) {
    grantScopedPermissions(employeeNumber, LOCATION_A, [WORKFLOW.READ, CANDIDATE_READ]);
  }
  db.prepare(`
    INSERT OR IGNORE INTO portal_access_scopes (
      employee_number, location_id, department_id, assigned_by
    ) VALUES (?, ?, 0, ?)
  `).run(EMPLOYEES.wrongRole, LOCATION_A, EMPLOYEES.hr);

  const candidate = await createCandidateFixture(auth.hr, organization.departmentA);
  const employeeSubject = Object.freeze({
    type: "employee",
    employeeNumber: EMPLOYEES.subject,
  });
  const definitions = Object.freeze({
    candidate: insertWorkflowDefinition({
      id: "m5-api-candidate-workflow",
      title: "M5 Bewerbung",
    }),
    employee: insertWorkflowDefinition({
      id: "m5-api-employee-workflow",
      title: "M5 Schulung",
    }),
    archived: insertWorkflowDefinition({
      id: "m5-api-archived-workflow",
      title: "M5 Archiviert",
    }),
    deferred: insertWorkflowDefinition({
      id: "m5-api-deferred-workflow",
      title: "M5 Aufgeschoben",
    }),
    customDeferred: insertWorkflowDefinition({
      id: "m5-api-custom-deferred-workflow",
      title: "M5 Benutzerdefiniert",
    }),
    confidential: insertWorkflowDefinition({
      id: "m5-api-confidential-workflow",
      title: "M5 Vertraulich",
    }),
    legacy: insertWorkflowDefinition({
      id: "m5-api-legacy-workflow",
      title: "M5 Legacy-Kontrolle",
    }),
  });
  const publications = Object.freeze({
    candidate: await publish(
      auth.hr,
      definitions.candidate,
      "m5.application",
      "application",
    ),
    employee: await publish(
      auth.hr,
      definitions.employee,
      "m5.training",
      "training",
    ),
    archived: await publish(
      auth.hr,
      definitions.archived,
      "m5.archived",
      "training",
    ),
    deferred: await publish(
      auth.hr,
      definitions.deferred,
      "m5.onboarding",
      "onboarding",
    ),
    customDeferred: await publish(
      auth.hr,
      definitions.customDeferred,
      "m5.custom",
      "custom_personnel",
    ),
  });
  const archived = await request(
    `/api/portal/v1/personnel-lifecycle/workflow-publications/${encodeURIComponent(publications.archived.id)}/archive`,
    {
      method: "POST",
      auth: auth.hr,
      body: { reason: "Synthetischer M5-Archivtest" },
    },
  );
  assert.equal(archived.response.status, 200, JSON.stringify(archived.payload));

  const validCandidateBody = workflowStartBody({
    publicationId: publications.candidate.id,
    subject: candidate,
    stepId: definitions.candidate.stepId,
  });
  const validEmployeeBody = workflowStartBody({
    publicationId: publications.employee.id,
    subject: employeeSubject,
    stepId: definitions.employee.stepId,
  });
  let candidateInstance;
  let employeeInstance;

  await t.test("POST erzeugt 201, spielt exakt mit 200 und Header wieder und sperrt Body-Drift", async () => {
    const created = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      { method: "POST", auth: auth.starter, body: validCandidateBody },
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    assert.equal(created.payload.replayed, false);
    assert.equal(created.response.headers.get("idempotency-replayed"), null);
    assert.equal(created.payload.instance.subject.type, "candidate");
    candidateInstance = created.payload.instance;

    const replayed = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      { method: "POST", auth: auth.starter, body: validCandidateBody },
    );
    assert.equal(replayed.response.status, 200, JSON.stringify(replayed.payload));
    assert.equal(replayed.response.headers.get("idempotency-replayed"), "true");
    assert.equal(replayed.payload.replayed, true);
    assert.deepEqual(replayed.payload.instance, candidateInstance);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM custom_process_run_bindings WHERE operation_id = ?
    `).get(validCandidateBody.operationId).count, 1);

    const conflict = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      {
        method: "POST",
        auth: auth.starter,
        body: {
          ...validCandidateBody,
          assignments: [{
            stepId: definitions.candidate.stepId,
            employeeNumber: EMPLOYEES.foreignAssignee,
          }],
        },
      },
    );
    assert.equal(conflict.response.status, 409, JSON.stringify(conflict.payload));
    assert.equal(conflict.payload.code, "PERSONNEL_WORKFLOW_INSTANCE_OPERATION_CONFLICT");
  });

  await t.test("Subject-Rechte und Workflow-Read/Publish/Scope bleiben getrennte Gates", async () => {
    const candidateDenied = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      {
        method: "POST",
        auth: auth.candidateDenied,
        body: { ...validCandidateBody, operationId: crypto.randomUUID() },
      },
    );
    assert.equal(candidateDenied.response.status, 404, JSON.stringify(candidateDenied.payload));
    assert.equal(candidateDenied.payload.code, "PERSONNEL_WORKFLOW_INSTANCE_NOT_FOUND");

    const employeeDenied = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      { method: "POST", auth: auth.employeeDenied, body: validEmployeeBody },
    );
    assert.equal(employeeDenied.response.status, 404, JSON.stringify(employeeDenied.payload));
    assert.equal(employeeDenied.payload.code, "PERSONNEL_WORKFLOW_INSTANCE_NOT_FOUND");

    const readOnly = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      {
        method: "POST",
        auth: auth.readOnly,
        body: { ...validCandidateBody, operationId: crypto.randomUUID() },
      },
    );
    assert.equal(readOnly.response.status, 403, JSON.stringify(readOnly.payload));
    assert.equal(readOnly.payload.code, "PORTAL_PERMISSION_DENIED");

    const publishOnly = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      {
        method: "POST",
        auth: auth.publishOnly,
        body: { ...validCandidateBody, operationId: crypto.randomUUID() },
      },
    );
    assert.equal(publishOnly.response.status, 403, JSON.stringify(publishOnly.payload));
    assert.equal(publishOnly.payload.code, "PERSONNEL_WORKFLOW_PERMISSION_REQUIRED");

    const wrongScope = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      {
        method: "POST",
        auth: auth.wrongScope,
        body: { ...validCandidateBody, operationId: crypto.randomUUID() },
      },
    );
    assert.equal(wrongScope.response.status, 404, JSON.stringify(wrongScope.payload));
    assert.equal(wrongScope.payload.code, "PERSONNEL_WORKFLOW_INSTANCE_NOT_FOUND");

    const itStart = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      { method: "POST", auth: auth.it, body: validEmployeeBody },
    );
    assert.equal(itStart.response.status, 403, JSON.stringify(itStart.payload));
    assert.equal(itStart.payload.code, "PORTAL_PERMISSION_DENIED");
    const itList = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      { auth: auth.it },
    );
    assert.equal(itList.response.status, 403, JSON.stringify(itList.payload));
    assert.equal(itList.payload.code, "PORTAL_PERMISSION_DENIED");
  });

  await t.test("fehlende, zusaetzliche und rollenfalsche Zuordnungen scheitern vor Persistenz", async () => {
    const before = Number(db.prepare("SELECT COUNT(*) AS count FROM custom_process_run_bindings")
      .get().count);
    const cases = [
      {
        assignments: [],
        code: "PERSONNEL_WORKFLOW_INSTANCE_ASSIGNMENTS_INVALID",
      },
      {
        assignments: [
          { stepId: definitions.candidate.stepId, employeeNumber: EMPLOYEES.assignee },
          { stepId: "unexpected-step", employeeNumber: EMPLOYEES.assignee },
        ],
        code: "PERSONNEL_WORKFLOW_INSTANCE_ASSIGNMENTS_INVALID",
      },
      {
        assignments: [{
          stepId: definitions.candidate.stepId,
          employeeNumber: EMPLOYEES.wrongRole,
        }],
        status: 404,
        code: "PERSONNEL_WORKFLOW_INSTANCE_ASSIGNMENT_NOT_FOUND",
      },
      {
        assignments: [{
          stepId: definitions.candidate.stepId,
          employeeNumber: EMPLOYEES.publishOnly,
        }],
        status: 404,
        code: "PERSONNEL_WORKFLOW_INSTANCE_ASSIGNMENT_NOT_FOUND",
      },
    ];
    for (const entry of cases) {
      const result = await request(
        "/api/portal/v1/personnel-lifecycle/workflow-instances",
        {
          method: "POST",
          auth: auth.starter,
          body: {
            ...validCandidateBody,
            operationId: crypto.randomUUID(),
            assignments: entry.assignments,
          },
        },
      );
      assert.equal(result.response.status, entry.status || 400, JSON.stringify(result.payload));
      assert.equal(result.payload.code, entry.code);
    }
    assert.equal(Number(db.prepare(
      "SELECT COUNT(*) AS count FROM custom_process_run_bindings",
    ).get().count), before);
  });

  await t.test("archivierte, vertrauliche und aufgeschobene Versionen bleiben geschlossen", async () => {
    const archivedStart = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      {
        method: "POST",
        auth: auth.starter,
        body: workflowStartBody({
          publicationId: publications.archived.id,
          subject: employeeSubject,
          stepId: definitions.archived.stepId,
        }),
      },
    );
    assert.equal(archivedStart.response.status, 409, JSON.stringify(archivedStart.payload));
    assert.equal(
      archivedStart.payload.code,
      "PERSONNEL_WORKFLOW_INSTANCE_PUBLICATION_ARCHIVED",
    );

    for (const [publication, definition, subject] of [
      [publications.deferred, definitions.deferred, candidate],
      [publications.customDeferred, definitions.customDeferred, employeeSubject],
    ]) {
      const deferred = await request(
        "/api/portal/v1/personnel-lifecycle/workflow-instances",
        {
          method: "POST",
          auth: auth.starter,
          body: workflowStartBody({
            publicationId: publication.id,
            subject,
            stepId: definition.stepId,
          }),
        },
      );
      assert.equal(deferred.response.status, 409, JSON.stringify(deferred.payload));
      assert.equal(deferred.payload.code, "PERSONNEL_WORKFLOW_INSTANCE_TYPE_DEFERRED");
    }

    const confidential = await request(
      `/api/portal/v1/personnel-lifecycle/workflows/${encodeURIComponent(definitions.confidential.id)}/publish`,
      {
        method: "POST",
        auth: auth.hr,
        body: publicationBody("m5.confidential", "training", true),
      },
    );
    assert.equal(confidential.response.status, 409, JSON.stringify(confidential.payload));
    assert.equal(confidential.payload.code, "PERSONNEL_WORKFLOW_CONFIDENTIAL_DEFERRED");
    const offboarding = await request(
      `/api/portal/v1/personnel-lifecycle/workflows/${encodeURIComponent(definitions.confidential.id)}/publish`,
      {
        method: "POST",
        auth: auth.hr,
        body: publicationBody("m5.confidential", "offboarding", false),
      },
    );
    assert.equal(offboarding.response.status, 409, JSON.stringify(offboarding.payload));
    assert.equal(offboarding.payload.code, "PERSONNEL_WORKFLOW_CONFIDENTIAL_DEFERRED");
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM custom_process_publications WHERE process_id = ?
    `).get(definitions.confidential.id).count, 0);
  });

  await t.test("GET filtert gleichzeitig nach Fachrecht und Organisationsscope", async () => {
    const employeeCreated = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      { method: "POST", auth: auth.starter, body: validEmployeeBody },
    );
    assert.equal(employeeCreated.response.status, 201, JSON.stringify(employeeCreated.payload));
    employeeInstance = employeeCreated.payload.instance;

    const full = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      { auth: auth.starter },
    );
    assert.equal(full.response.status, 200, JSON.stringify(full.payload));
    assert.deepEqual(instanceIds(full.payload), [candidateInstance.id, employeeInstance.id].sort());

    const employeeOnly = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      { auth: auth.employeeViewer },
    );
    assert.equal(employeeOnly.response.status, 200, JSON.stringify(employeeOnly.payload));
    assert.deepEqual(instanceIds(employeeOnly.payload), [employeeInstance.id]);

    const candidateOnly = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      { auth: auth.candidateViewer },
    );
    assert.equal(candidateOnly.response.status, 200, JSON.stringify(candidateOnly.payload));
    assert.deepEqual(instanceIds(candidateOnly.payload), [candidateInstance.id]);

    const outside = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      { auth: auth.outsider },
    );
    assert.equal(outside.response.status, 200, JSON.stringify(outside.payload));
    assert.deepEqual(outside.payload.instances, []);
  });

  await t.test("Self-Task bleibt beim eingefrorenen Assignee und wird idempotent abgeschlossen", async () => {
    const own = await request("/api/portal/v1/me/process-tasks", { auth: auth.assignee });
    assert.equal(own.response.status, 200, JSON.stringify(own.payload));
    const ownItems = tasks(own.payload);
    const candidateTask = ownItems.find(({ runId }) => runId === candidateInstance.id);
    assert.ok(candidateTask, JSON.stringify(own.payload));
    assert.equal(candidateTask.step.id, definitions.candidate.stepId);

    const foreign = await request(
      "/api/portal/v1/me/process-tasks",
      { auth: auth.foreignAssignee },
    );
    assert.equal(foreign.response.status, 200, JSON.stringify(foreign.payload));
    assert.equal(tasks(foreign.payload).some(({ runId }) => runId === candidateInstance.id), false);

    const completionBody = { action: "complete", operationId: crypto.randomUUID() };
    const foreignCompletion = await request(
      `/api/portal/v1/me/process-tasks/${encodeURIComponent(candidateInstance.id)}`
        + `/${encodeURIComponent(definitions.candidate.stepId)}/complete`,
      {
        method: "POST",
        auth: auth.foreignAssignee,
        body: completionBody,
      },
    );
    assert.equal(
      foreignCompletion.response.status,
      404,
      JSON.stringify(foreignCompletion.payload),
    );
    assert.equal(foreignCompletion.payload.code, "CUSTOM_PROCESS_TASK_NOT_FOUND");

    const unknownCompletion = await request(
      `/api/portal/v1/me/process-tasks/${crypto.randomUUID()}`
        + `/${encodeURIComponent(definitions.candidate.stepId)}/complete`,
      { method: "POST", auth: auth.foreignAssignee, body: completionBody },
    );
    assert.equal(unknownCompletion.response.status, 404, JSON.stringify(unknownCompletion.payload));
    assert.equal(unknownCompletion.payload.code, foreignCompletion.payload.code);
    assert.equal(unknownCompletion.payload.error, foreignCompletion.payload.error);

    const extraField = await request(
      `/api/portal/v1/me/process-tasks/${encodeURIComponent(candidateInstance.id)}`
        + `/${encodeURIComponent(definitions.candidate.stepId)}/complete`,
      {
        method: "POST",
        auth: auth.assignee,
        body: { ...completionBody, note: "M5 akzeptiert keine Fachnotiz." },
      },
    );
    assert.equal(extraField.response.status, 400, JSON.stringify(extraField.payload));
    assert.equal(extraField.payload.code, "PERSONNEL_WORKFLOW_INSTANCE_INPUT_INVALID");

    const completed = await request(
      `/api/portal/v1/me/process-tasks/${encodeURIComponent(candidateInstance.id)}`
        + `/${encodeURIComponent(definitions.candidate.stepId)}/complete`,
      { method: "POST", auth: auth.assignee, body: completionBody },
    );
    assert.equal(completed.response.status, 200, JSON.stringify(completed.payload));
    assert.equal(completed.payload.runId, candidateInstance.id);
    assert.equal(completed.payload.stepId, definitions.candidate.stepId);
    assert.equal(completed.payload.status, "completed");
    assert.equal(completed.payload.resolved, true);
    assert.equal(completed.payload.replayed, false);

    const replayed = await request(
      `/api/portal/v1/me/process-tasks/${encodeURIComponent(candidateInstance.id)}`
        + `/${encodeURIComponent(definitions.candidate.stepId)}/complete`,
      { method: "POST", auth: auth.assignee, body: completionBody },
    );
    assert.equal(replayed.response.status, 200, JSON.stringify(replayed.payload));
    assert.equal(replayed.payload.replayed, true);
    assert.equal(replayed.payload.runId, candidateInstance.id);

    const after = await request("/api/portal/v1/me/process-tasks", { auth: auth.assignee });
    assert.equal(after.response.status, 200, JSON.stringify(after.payload));
    assert.equal(tasks(after.payload).some(({ runId }) => runId === candidateInstance.id), false);
    assert.equal(tasks(after.payload).some(({ runId }) => runId === employeeInstance.id), true);
  });

  await t.test("Legacy-Task bleibt auf derselben Route funktionsfaehig", async () => {
    const triggered = await request(
      `/api/portal/v1/custom-processes/${encodeURIComponent(definitions.legacy.id)}/trigger`,
      {
        method: "POST",
        auth: auth.hr,
        body: { idempotencyKey: `m5-legacy-${crypto.randomUUID()}` },
      },
    );
    assert.equal(triggered.response.status, 200, JSON.stringify(triggered.payload));
    const runId = triggered.payload.run.id;
    const listed = await request("/api/portal/v1/me/process-tasks", { auth: auth.assignee });
    assert.equal(listed.response.status, 200, JSON.stringify(listed.payload));
    const legacyTask = tasks(listed.payload).find((item) => item.runId === runId);
    assert.ok(legacyTask, JSON.stringify(listed.payload));
    assert.equal(legacyTask.processId, definitions.legacy.id);

    const completed = await request(
      `/api/portal/v1/me/process-tasks/${encodeURIComponent(runId)}`
        + `/${encodeURIComponent(legacyTask.stepId)}/complete`,
      {
        method: "POST",
        auth: auth.assignee,
        body: {
          action: "complete",
          note: "Legacy bleibt funktionsfaehig",
          idempotencyKey: `m5-legacy-task-${crypto.randomUUID()}`,
          activationCount: legacyTask.activationCount,
        },
      },
    );
    assert.equal(completed.response.status, 200, JSON.stringify(completed.payload));
    assert.equal(db.prepare("SELECT status FROM custom_process_runs WHERE id = ?")
      .get(runId).status, "resolved");
  });

  await t.test("alter manueller Trigger bleibt fuer publizierte Prozesse gesperrt", async () => {
    const legacyTrigger = await request(
      `/api/portal/v1/custom-processes/${encodeURIComponent(definitions.candidate.id)}/trigger`,
      {
        method: "POST",
        auth: auth.hr,
        body: { idempotencyKey: `m5-published-${crypto.randomUUID()}` },
      },
    );
    assert.equal(legacyTrigger.response.status, 409, JSON.stringify(legacyTrigger.payload));
    assert.equal(legacyTrigger.payload.code, "CUSTOM_PROCESS_PERSONNEL_INSTANCE_REQUIRED");
  });

  await t.test("deaktiviertes M5 bleibt auf gemeinsamer Self-Task-Route fail-closed", async () => {
    const original = db.prepare(
      "SELECT value FROM settings WHERE key = 'installation_features'",
    ).get().value;
    try {
      const disabled = JSON.parse(original)
        .filter((feature) => feature !== "personnelLifecycle");
      db.prepare("UPDATE settings SET value = ? WHERE key = 'installation_features'")
        .run(JSON.stringify(disabled));

      const listed = await request("/api/portal/v1/me/process-tasks", { auth: auth.assignee });
      assert.equal(listed.response.status, 200, JSON.stringify(listed.payload));
      assert.equal(tasks(listed.payload).some(({ runId }) => runId === employeeInstance.id), false);

      const completion = await request(
        `/api/portal/v1/me/process-tasks/${encodeURIComponent(employeeInstance.id)}`
          + `/${encodeURIComponent(definitions.employee.stepId)}/complete`,
        {
          method: "POST",
          auth: auth.assignee,
          body: { action: "complete", operationId: crypto.randomUUID() },
        },
      );
      assert.equal(completion.response.status, 404, JSON.stringify(completion.payload));
      assert.equal(completion.payload.code, "CUSTOM_PROCESS_TASK_NOT_FOUND");
    } finally {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'installation_features'")
        .run(original);
    }
  });

  await t.test("historische Zuweisungen bleiben nach entferntem Portalzugang lesbar", async () => {
    db.prepare("DELETE FROM portal_users WHERE employee_number = ?")
      .run(EMPLOYEES.assignee);
    const listed = await request(
      "/api/portal/v1/personnel-lifecycle/workflow-instances",
      { auth: auth.hr },
    );
    assert.equal(listed.response.status, 200, JSON.stringify(listed.payload));
    assert.equal(instanceIds(listed.payload).includes(candidateInstance.id), true);
    assert.equal(instanceIds(listed.payload).includes(employeeInstance.id), true);
  });
});

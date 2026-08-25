"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");

const { createAmuStorage } = require("../lib/amu-storage");
const {
  candidateDocumentProtectionContext,
  candidateDocumentVersionProtectionContext,
  candidateProtectionContext,
} = require("../lib/personnel-lifecycle");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-personnel-lifecycle-api-"));
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
  reconcileOrphanAmuBlobs,
  releaseInstanceLockForTests,
} = require("../server");
const {
  PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS,
  PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-schema");

let httpServer;
let baseUrl;

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
  return {
    cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,
    csrf,
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
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { response, payload };
}

async function multipartRequest(route, { auth, form }) {
  const headers = { Accept: "application/json" };
  if (auth) {
    headers.Cookie = auth.cookie;
    headers["X-CSRF-Token"] = auth.csrf;
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers,
    body: form,
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

function assertForbiddenSummaryKeysAbsent(value) {
  const forbidden = new Set([
    "address",
    "preferredLanguage",
    "internalRating",
    "internalNotes",
    "communicationNotes",
    "source",
    "tags",
  ]);
  const visit = (entry) => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(entry)) {
      assert.equal(forbidden.has(key), false, `Vertrauliches Listenfeld gefunden: ${key}`);
      visit(child);
    }
  };
  visit(value);
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

function setPersonnelLifecycleEnabled(enabled) {
  const features = configuredInstallationFeatures()
    .filter((feature) => feature !== "personnelLifecycle");
  if (enabled) features.push("personnelLifecycle");
  db.prepare("UPDATE settings SET value = ? WHERE key = 'installation_features'")
    .run(JSON.stringify(features));
}

function resetFixture() {
  db.exec("BEGIN IMMEDIATE");
  try {
    const convertedEmployeeNumbers = db.prepare(
      "SELECT employee_number FROM candidate_conversions",
    ).all().map((row) => String(row.employee_number));
    for (const definition of [
      ...PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS,
      ...PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS,
    ]) {
      db.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
    }
    db.prepare("DELETE FROM candidate_conversions").run();
    db.prepare("DELETE FROM candidate_events").run();
    db.prepare("DELETE FROM candidate_document_versions").run();
    db.prepare("DELETE FROM candidate_documents").run();
    db.prepare("DELETE FROM candidate_applications").run();
    db.prepare("DELETE FROM candidates").run();
    db.prepare("DELETE FROM portal_sessions").run();
    db.prepare("DELETE FROM portal_permission_scope_grants").run();
    db.prepare("DELETE FROM portal_permission_grants").run();
    db.prepare("DELETE FROM portal_permission_denials").run();
    db.prepare("DELETE FROM portal_access_scopes").run();
    db.prepare("DELETE FROM portal_users").run();
    db.prepare("DELETE FROM audit_log WHERE action LIKE 'personnel-lifecycle.%'").run();
    for (const employeeNumber of convertedEmployeeNumbers) {
      db.prepare("DELETE FROM personnel_sensitive_records WHERE employee_number = ?")
        .run(employeeNumber);
      db.prepare("DELETE FROM employees WHERE personnel_number = ?").run(employeeNumber);
    }
    for (const definition of [
      ...PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS,
      ...PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS,
    ]) {
      db.exec(definition.sql);
    }
    setPersonnelLifecycleEnabled(false);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function grantSensitivePersonnelAccess(employeeNumber) {
  const insert = db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, ?, 'personnel-lifecycle-api-test')
  `);
  insert.run(employeeNumber, "personnel:sensitive:read");
  insert.run(employeeNumber, "personnel:sensitive:write");
}

function denyPersonnelReadAccess(employeeNumber) {
  const insert = db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, ?, 'personnel-lifecycle-api-test')
  `);
  insert.run(employeeNumber, "personnel:central:read");
  insert.run(employeeNumber, "personnel:sensitive:read");
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
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

async function moveApplicationToPreboarding(auth, candidateId, application) {
  let current = application;
  for (const status of [
    "screening",
    "first_interview",
    "further_interview",
    "offer",
    "accepted",
    "preboarding",
  ]) {
    const transitioned = await request(
      `/api/portal/v1/personnel-lifecycle/candidates/${candidateId}/applications/${application.id}/status`,
      {
        method: "POST",
        auth,
        body: { revision: current.revision, status },
      },
    );
    assert.equal(transitioned.response.status, 200, JSON.stringify(transitioned.payload));
    current = transitioned.payload.application;
  }
  return current;
}

test("Personalmodul M3: kontrollierte Einstellung ist atomar, idempotent und datensparsam", async () => {
  setPersonnelLifecycleEnabled(true);
  const admin = createSession("101", "admin");
  grantSensitivePersonnelAccess("101");
  const piiMarker = "M3-SYNTHETIC-PII";
  const created = await request(
    "/api/portal/v1/personnel-lifecycle/candidates",
    {
      method: "POST",
      auth: admin,
      body: {
        dataProcessingAuthorizationConfirmed: true,
        profile: {
          firstName: "Mira",
          lastName: piiMarker,
          email: "m3.synthetic@example.invalid",
          phone: "+43 660 1234567",
          address: {
            street: "Sicherheitsweg 3",
            postalCode: "1010",
            city: "Wien",
            country: "Österreich",
          },
        },
        application: {
          internalNotes: `${piiMarker}-INTERNAL`,
          source: "synthetic-test",
        },
      },
    },
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const candidate = created.payload.candidate;
  const preboarding = await moveApplicationToPreboarding(
    admin,
    candidate.id,
    candidate.applications[0],
  );
  const assignment = db.prepare(`
    SELECT center.id AS cost_center_id, position.id AS position_id
    FROM cost_centers center
    JOIN cost_center_types type ON type.id = center.cost_center_type_id
    JOIN cost_center_type_positions mapping
      ON mapping.cost_center_type_id = type.id
    JOIN positions position ON position.id = mapping.position_id
    WHERE center.active = 1 AND type.active = 1
    ORDER BY center.sort_order, center.id, mapping.sort_order, position.id
    LIMIT 1
  `).get();
  assert.ok(assignment);
  const operationId = crypto.randomUUID();
  const employee = {
    personnelNumber: "M3-9001",
    nickname: "Mira M3",
    contractedHours: 30,
    targetWorkdaysPerWeek: 5,
    positionId: assignment.position_id,
    costCenterId: assignment.cost_center_id,
  };
  const conversionBody = {
    operationId,
    candidateRevision: candidate.revision,
    applicationRevision: preboarding.revision,
    employee,
  };

  const missingCsrf = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${preboarding.id}/convert`,
    {
      method: "POST",
      auth: admin,
      includeCsrf: false,
      body: conversionBody,
    },
  );
  assert.equal(missingCsrf.response.status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidate_conversions").get().count, 0);

  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES ('101', 'employees:write', 'personnel-lifecycle-api-test')
  `).run();
  const missingEmployeeCreatePermission = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${preboarding.id}/convert`,
    { method: "POST", auth: admin, body: conversionBody },
  );
  assert.equal(missingEmployeeCreatePermission.response.status, 403);
  assert.equal(
    missingEmployeeCreatePermission.payload.code,
    "PERSONNEL_LIFECYCLE_EMPLOYEE_CREATE_PERMISSION_REQUIRED",
  );
  db.prepare(`
    DELETE FROM portal_permission_denials
    WHERE employee_number = '101' AND permission = 'employees:write'
  `).run();

  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES ('101', 'personnel:phone:write', 'personnel-lifecycle-api-test')
  `).run();
  const deniedByFieldRights = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${preboarding.id}/convert`,
    { method: "POST", auth: admin, body: conversionBody },
  );
  assert.equal(deniedByFieldRights.response.status, 403, JSON.stringify(deniedByFieldRights.payload));
  assert.equal(deniedByFieldRights.payload.code, "PERSONNEL_PHONE_WRITE_DENIED");
  db.prepare(`
    DELETE FROM portal_permission_denials
    WHERE employee_number = '101' AND permission = 'personnel:phone:write'
  `).run();

  const deniedAudits = db.prepare(`
    SELECT actor, action, entity_type, entity_id, detail
    FROM audit_log
    WHERE action = 'personnel-lifecycle.candidate.convert.denied'
      AND entity_id = ?
    ORDER BY id
  `).all(operationId).map((row) => ({ ...row }));
  assert.equal(deniedAudits.length, 1);
  assert.deepEqual(
    {
      actor: deniedAudits[0].actor,
      action: deniedAudits[0].action,
      entityType: deniedAudits[0].entity_type,
      entityId: deniedAudits[0].entity_id,
      detail: JSON.parse(deniedAudits[0].detail),
    },
    {
      actor: "101",
      action: "personnel-lifecycle.candidate.convert.denied",
      entityType: "candidate_conversion",
      entityId: operationId,
      detail: {
        reason: "PERSONNEL_PHONE_WRITE_DENIED",
        route: "POST /api/portal/v1/personnel-lifecycle/candidates/:candidateId/applications/:applicationId/convert",
        fieldKeys: ["phone"],
      },
    },
  );
  const deniedAuditText = JSON.stringify(deniedAudits);
  for (const privateValue of [
    piiMarker,
    "m3.synthetic@example.invalid",
    "+43 660 1234567",
    "Sicherheitsweg 3",
    employee.personnelNumber,
    candidate.id,
    preboarding.id,
  ]) {
    assert.equal(deniedAuditText.includes(privateValue), false, `Denied-Audit enthält ${privateValue}`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidate_conversions").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM employees WHERE personnel_number = ?")
    .get(employee.personnelNumber).count, 0);
  assert.deepEqual(
    { ...db.prepare("SELECT state, revision FROM candidates WHERE id = ?").get(candidate.id) },
    { state: "active", revision: candidate.revision },
  );
  assert.deepEqual(
    { ...db.prepare("SELECT status, revision FROM candidate_applications WHERE id = ?").get(preboarding.id) },
    { status: "preboarding", revision: preboarding.revision },
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidate_events WHERE candidate_id = ?")
    .get(candidate.id).count, 8);

  db.exec(`
    CREATE TRIGGER test_candidate_conversion_rollback
    BEFORE INSERT ON candidate_conversions
    BEGIN
      SELECT RAISE(ABORT, 'forced conversion rollback');
    END;
  `);
  const forcedRollback = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${preboarding.id}/convert`,
    { method: "POST", auth: admin, body: conversionBody },
  );
  db.exec("DROP TRIGGER test_candidate_conversion_rollback");
  assert.equal(forcedRollback.response.status, 400, JSON.stringify(forcedRollback.payload));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidate_conversions").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM employees WHERE personnel_number = ?")
    .get(employee.personnelNumber).count, 0);
  assert.equal(db.prepare("SELECT state, revision FROM candidates WHERE id = ?")
    .get(candidate.id).state, "active");
  assert.deepEqual(
    { ...db.prepare("SELECT status, revision FROM candidate_applications WHERE id = ?")
      .get(preboarding.id) },
    { status: "preboarding", revision: preboarding.revision },
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidate_events WHERE candidate_id = ?")
    .get(candidate.id).count, 8);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE action IN (
      'personnel-lifecycle.candidate.convert',
      'personnel-record.create-from-candidate'
    )
  `).get().count, 0);

  const converted = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${preboarding.id}/convert`,
    { method: "POST", auth: admin, body: conversionBody },
  );
  assert.equal(converted.response.status, 201, JSON.stringify(converted.payload));
  assert.equal(converted.payload.replayed, false);
  assert.deepEqual(converted.payload.candidate, {
    id: candidate.id,
    state: "archived",
    revision: candidate.revision + 1,
  });
  assert.deepEqual(converted.payload.application, {
    id: preboarding.id,
    status: "converted",
    revision: preboarding.revision + 1,
  });
  assert.equal(converted.payload.conversion.employeeNumber, employee.personnelNumber);
  assert.equal(converted.payload.conversion.documentTransfer, "none");
  assert.equal(converted.payload.conversion.onboarding, "deferred");
  assert.equal(Object.hasOwn(converted.payload.conversion, "requestSha256"), false);
  assert.equal(Object.hasOwn(converted.payload.conversion, "protectedPayload"), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidate_conversions").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM employees WHERE personnel_number = ?")
    .get(employee.personnelNumber).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM portal_users WHERE employee_number = ?")
    .get(employee.personnelNumber).count, 0);

  const replay = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${preboarding.id}/convert`,
    { method: "POST", auth: admin, body: conversionBody },
  );
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
  assert.equal(replay.payload.replayed, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidate_conversions").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidate_events WHERE candidate_id = ?")
    .get(candidate.id).count, 10);

  const reusedWithDifferentInput = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${preboarding.id}/convert`,
    {
      method: "POST",
      auth: admin,
      body: {
        ...conversionBody,
        employee: { ...employee, nickname: "Anderer Vorgang" },
      },
    },
  );
  assert.equal(reusedWithDifferentInput.response.status, 409);
  assert.equal(
    reusedWithDifferentInput.payload.code,
    "PERSONNEL_LIFECYCLE_CONVERSION_IDEMPOTENCY_CONFLICT",
  );

  const personnelRecord = await request(
    `/api/portal/v1/personnel-records/${employee.personnelNumber}`,
    { auth: admin },
  );
  assert.equal(personnelRecord.response.status, 200, JSON.stringify(personnelRecord.payload));
  assert.equal(personnelRecord.payload.employee.personnel_number, employee.personnelNumber);
  assert.equal(personnelRecord.payload.profile.sensitive.identity.firstName, "Mira");
  assert.equal(personnelRecord.payload.profile.sensitive.identity.lastName, piiMarker);
  assert.equal(
    personnelRecord.payload.profile.sensitive.privateEmail,
    "m3.synthetic@example.invalid",
  );
  assert.equal(personnelRecord.payload.profile.phone, "+43 660 1234567");

  const conversionAudits = db.prepare(`
    SELECT actor, entity_type, entity_id, detail
    FROM audit_log
    WHERE action = 'personnel-lifecycle.candidate.convert'
    ORDER BY id
  `).all().map((row) => ({ ...row }));
  assert.equal(conversionAudits.length, 1);
  assert.equal(conversionAudits[0].actor, "101");
  assert.equal(conversionAudits[0].entity_type, "candidate_conversion");
  assert.equal(conversionAudits[0].entity_id, operationId);
  assert.doesNotMatch(
    JSON.stringify(conversionAudits),
    new RegExp(`${piiMarker}|m3\\.synthetic@example\\.invalid|Sicherheitsweg`, "i"),
  );
});

test("Personalmodul-API: Feature, Zentralrecht, Sensitivrecht und CSRF bleiben fail-closed", async () => {
  const admin = createSession("101", "admin");

  const featureDisabled = await request(
    "/api/portal/v1/personnel-lifecycle/document-categories",
    { auth: admin },
  );
  assert.equal(featureDisabled.response.status, 403);
  assert.equal(featureDisabled.payload.code, "FEATURE_DISABLED");

  setPersonnelLifecycleEnabled(true);
  const featureEnabled = await request(
    "/api/portal/v1/personnel-lifecycle/document-categories",
    { auth: admin },
  );
  assert.equal(featureEnabled.response.status, 200, JSON.stringify(featureEnabled.payload));
  assert.equal(featureEnabled.payload.categories.length, 7);

  const sensitiveOnly = createSession("103", "manager");
  grantSensitivePersonnelAccess("103");
  const missingCentral = await request(
    "/api/portal/v1/personnel-lifecycle/candidates",
    { auth: sensitiveOnly },
  );
  assert.equal(missingCentral.response.status, 403);
  assert.equal(missingCentral.payload.code, "PORTAL_PERMISSION_DENIED");

  const centralOnly = createSession("102", "it_admin");
  const missingSensitive = await request(
    "/api/portal/v1/personnel-lifecycle/candidates",
    { auth: centralOnly },
  );
  assert.equal(missingSensitive.response.status, 403);
  assert.equal(
    missingSensitive.payload.code,
    "PORTAL_PERMISSION_DENIED",
  );

  const missingCsrf = await request(
    "/api/portal/v1/personnel-lifecycle/candidates",
    {
      method: "POST",
      auth: admin,
      includeCsrf: false,
      body: {
        dataProcessingAuthorizationConfirmed: true,
        profile: {
          firstName: "Keine",
          lastName: "Mutation",
          email: "keine-mutation@example.invalid",
        },
      },
    },
  );
  assert.equal(missingCsrf.response.status, 403);
  assert.equal(missingCsrf.payload.code, "PORTAL_CSRF_INVALID");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidates").get().count, 0);
});

test("Personalmodul-API: Bewerberanlage verlangt eine ausdrücklich bestätigte EDV-Erlaubnis", async () => {
  setPersonnelLifecycleEnabled(true);
  const admin = createSession("101", "admin");
  const profile = {
    firstName: "Erlaubnis",
    lastName: "Prüfung",
    email: "edv-erlaubnis@example.invalid",
  };

  for (const submitted of [undefined, false, null, "true", 1, {}]) {
    const body = { profile };
    if (submitted !== undefined) body.dataProcessingAuthorizationConfirmed = submitted;
    const denied = await request("/api/portal/v1/personnel-lifecycle/candidates", {
      method: "POST",
      auth: admin,
      body,
    });
    assert.equal(denied.response.status, 400, JSON.stringify(denied.payload));
    assert.equal(
      denied.payload.code,
      "PERSONNEL_LIFECYCLE_DATA_PROCESSING_AUTHORIZATION_REQUIRED",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidates").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidate_applications").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidate_events").get().count, 0);
  }
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE action = 'personnel-lifecycle.candidate.create'
  `).get().count, 0);

  const created = await request("/api/portal/v1/personnel-lifecycle/candidates", {
    method: "POST",
    auth: admin,
    body: {
      dataProcessingAuthorizationConfirmed: true,
      profile,
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const creationEvent = created.payload.candidate.history.find(
    ({ eventType }) => eventType === "candidate_created",
  );
  assert.deepEqual(creationEvent.detail.dataProcessingAuthorization, {
    confirmed: true,
    statementVersion: "candidate-data-processing-authorization-v1",
  });
  assert.equal(creationEvent.actorEmployeeNumber, "101");
  assert.match(creationEvent.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  const audit = db.prepare(`
    SELECT detail FROM audit_log
    WHERE action = 'personnel-lifecycle.candidate.create'
    ORDER BY id DESC LIMIT 1
  `).get();
  assert.deepEqual(JSON.parse(audit.detail), {
    applicationCount: 0,
    dataProcessingAuthorizationConfirmed: true,
  });
  assert.doesNotMatch(audit.detail, /Erlaubnis|Prüfung|example\.invalid/i);

  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES ('101', 'personnel:candidates:write', 'personnel-lifecycle-api-test')
  `).run();
  const centralWriteDenied = await request("/api/portal/v1/personnel-lifecycle/candidates", {
    method: "POST",
    auth: admin,
    body: {
      dataProcessingAuthorizationConfirmed: true,
      profile: {
        firstName: "Nicht",
        lastName: "Angelegt",
        email: "central-write-denied@example.invalid",
      },
    },
  });
  assert.equal(centralWriteDenied.response.status, 403, JSON.stringify(centralWriteDenied.payload));
  assert.equal(centralWriteDenied.payload.code, "PERSONNEL_LIFECYCLE_PERMISSION_REQUIRED");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidates").get().count, 1);
});

test("Personalmodul-API: Bewerberanlage rollt nach einem nachgelagerten Ereignisfehler vollständig zurück", async () => {
  setPersonnelLifecycleEnabled(true);
  const admin = createSession("101", "admin");
  db.exec(`
    CREATE TRIGGER test_candidate_creation_rollback
    BEFORE INSERT ON candidate_events
    WHEN NEW.event_type = 'candidate_created'
    BEGIN
      SELECT RAISE(ABORT, 'test candidate creation rollback');
    END
  `);
  try {
    const failed = await request("/api/portal/v1/personnel-lifecycle/candidates", {
      method: "POST",
      auth: admin,
      body: {
        dataProcessingAuthorizationConfirmed: true,
        profile: {
          firstName: "Rollback",
          lastName: "Prüfung",
          email: "rollback@example.invalid",
        },
      },
    });
    assert.equal(failed.response.status, 400);
    assert.equal(failed.payload.code, "PERSONNEL_LIFECYCLE_REFERENCE_INVALID");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidates").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidate_applications").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidate_events").get().count, 0);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE action = 'personnel-lifecycle.candidate.create'
    `).get().count, 0);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS test_candidate_creation_rollback");
  }
});

test("Personalmodul-API: Create, Read, Update und Status liefern stabile Erfolgs- und Fehlerverträge", async () => {
  setPersonnelLifecycleEnabled(true);
  const admin = createSession("101", "admin");

  const created = await request(
    "/api/portal/v1/personnel-lifecycle/candidates",
    {
      method: "POST",
      auth: admin,
      body: {
        dataProcessingAuthorizationConfirmed: true,
        profile: {
          firstName: "Ada",
          lastName: "Beispiel",
          email: "ada.beispiel@example.invalid",
          address: {
            street: "Synthetikweg 1",
            postalCode: "0000",
            city: "Testort",
          },
          preferredLanguage: "de",
        },
        application: {
          desiredRoleTitle: "Verkauf",
          source: "Synthetischer API-Test",
          internalRating: 4,
          internalNotes: "Nur Testdaten",
          communicationNotes: "Nur im Detail",
          tags: ["synthetisch", "api"],
        },
      },
    },
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const candidate = created.payload.candidate;
  const application = candidate.applications[0];
  assert.match(candidate.id, /^[0-9a-f-]{36}$/);
  assert.equal(candidate.revision, 1);
  assert.equal(candidate.profile.firstName, "Ada");
  assert.equal(application.status, "new");
  assert.equal(application.revision, 1);

  for (const index of [2, 3]) {
    const additional = await request(
      "/api/portal/v1/personnel-lifecycle/candidates",
      {
        method: "POST",
        auth: admin,
        body: {
          dataProcessingAuthorizationConfirmed: true,
          profile: {
            firstName: `Test ${index}`,
            lastName: "Bewerbung",
            email: `test-${index}@example.invalid`,
          },
        },
      },
    );
    assert.equal(additional.response.status, 201, JSON.stringify(additional.payload));
  }

  const firstPage = await request(
    "/api/portal/v1/personnel-lifecycle/candidates?limit=2&offset=0",
    { auth: admin },
  );
  assert.equal(firstPage.response.status, 200, JSON.stringify(firstPage.payload));
  assert.equal(firstPage.payload.candidates.length, 2);
  assert.deepEqual(firstPage.payload.pagination, {
    limit: 2,
    offset: 0,
    hasMore: true,
    includeArchived: false,
  });
  assertForbiddenSummaryKeysAbsent(firstPage.payload.candidates);

  const secondPage = await request(
    "/api/portal/v1/personnel-lifecycle/candidates?limit=2&offset=2&includeArchived=1",
    { auth: admin },
  );
  assert.equal(secondPage.response.status, 200, JSON.stringify(secondPage.payload));
  assert.equal(secondPage.payload.candidates.length, 1);
  assert.deepEqual(secondPage.payload.pagination, {
    limit: 2,
    offset: 2,
    hasMore: false,
    includeArchived: true,
  });
  assertForbiddenSummaryKeysAbsent(secondPage.payload.candidates);
  assert.deepEqual(
    new Set([
      ...firstPage.payload.candidates.map(({ id }) => id),
      ...secondPage.payload.candidates.map(({ id }) => id),
    ]),
    new Set(db.prepare("SELECT id FROM candidates").all().map(({ id }) => id)),
  );

  const invalidPage = await request(
    "/api/portal/v1/personnel-lifecycle/candidates?limit=0",
    { auth: admin },
  );
  assert.equal(invalidPage.response.status, 400);
  assert.equal(
    invalidPage.payload.code,
    "PERSONNEL_LIFECYCLE_PAGINATION_INVALID",
  );

  const read = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}`,
    { auth: admin },
  );
  assert.equal(read.response.status, 200);
  assert.equal(read.payload.candidate.profile.email, "ada.beispiel@example.invalid");
  assert.equal(read.payload.candidate.profile.address.street, "Synthetikweg 1");
  assert.equal(read.payload.candidate.profile.preferredLanguage, "de");
  assert.equal(read.payload.candidate.applications[0].internalRating, 4);
  assert.equal(read.payload.candidate.applications[0].internalNotes, "Nur Testdaten");
  assert.equal(read.payload.candidate.applications[0].communicationNotes, "Nur im Detail");
  assert.equal(read.payload.candidate.applications[0].source, "Synthetischer API-Test");
  assert.deepEqual(read.payload.candidate.applications[0].tags, ["synthetisch", "api"]);

  const updated = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}`,
    {
      method: "PUT",
      auth: admin,
      body: {
        revision: candidate.revision,
        profile: { firstName: "Ada Neu" },
      },
    },
  );
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.candidate.revision, 2);
  assert.equal(updated.payload.candidate.profile.firstName, "Ada Neu");

  const applicationUpdated = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${application.id}`,
    {
      method: "PUT",
      auth: admin,
      body: {
        revision: application.revision,
        internalNotes: "Geprüft",
      },
    },
  );
  assert.equal(applicationUpdated.response.status, 200, JSON.stringify(applicationUpdated.payload));
  assert.equal(applicationUpdated.payload.application.revision, 2);
  assert.equal(applicationUpdated.payload.application.internalNotes, "Geprüft");

  const transitioned = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${application.id}/status`,
    {
      method: "POST",
      auth: admin,
      body: {
        revision: applicationUpdated.payload.application.revision,
        status: "screening",
        reason: "Unterlagen vollständig",
      },
    },
  );
  assert.equal(transitioned.response.status, 200, JSON.stringify(transitioned.payload));
  assert.equal(transitioned.payload.application.status, "screening");
  assert.equal(transitioned.payload.application.revision, 3);

  const notFound = await request(
    "/api/portal/v1/personnel-lifecycle/candidates/00000000-0000-4000-8000-000000000000",
    { auth: admin },
  );
  assert.equal(notFound.response.status, 404);
  assert.equal(notFound.payload.code, "PERSONNEL_LIFECYCLE_CANDIDATE_NOT_FOUND");

  const staleRevision = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}`,
    {
      method: "PUT",
      auth: admin,
      body: {
        revision: candidate.revision,
        profile: { firstName: "Veraltet" },
      },
    },
  );
  assert.equal(staleRevision.response.status, 409);
  assert.equal(staleRevision.payload.code, "PERSONNEL_LIFECYCLE_REVISION_CONFLICT");

  const conversionBlocked = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${application.id}/status`,
    {
      method: "POST",
      auth: admin,
      body: {
        revision: transitioned.payload.application.revision,
        status: "converted",
      },
    },
  );
  assert.equal(conversionBlocked.response.status, 409);
  assert.equal(
    conversionBlocked.payload.code,
    "PERSONNEL_LIFECYCLE_CONVERSION_NOT_AVAILABLE",
  );

  const listAudits = db.prepare(`
    SELECT actor, entity_type, entity_id, detail
    FROM audit_log
    WHERE action = 'personnel-lifecycle.candidate.list'
    ORDER BY id
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(
    listAudits.map(({ actor, entity_type: entityType, entity_id: entityId }) => ({
      actor,
      entityType,
      entityId,
    })),
    [
      { actor: "101", entityType: "candidate", entityId: "page" },
      { actor: "101", entityType: "candidate", entityId: "page" },
    ],
  );
  assert.deepEqual(listAudits.map(({ detail }) => JSON.parse(detail)), [
    { count: 2, limit: 2, offset: 0, includeArchived: false },
    { count: 1, limit: 2, offset: 2, includeArchived: true },
  ]);

  const readAudits = db.prepare(`
    SELECT actor, entity_type, entity_id, detail
    FROM audit_log
    WHERE action = 'personnel-lifecycle.candidate.read'
    ORDER BY id
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(readAudits, [{
    actor: "101",
    entity_type: "candidate",
    entity_id: candidate.id,
    detail: "",
  }]);
  assert.doesNotMatch(
    listAudits.map(({ detail }) => detail).join("\n"),
    /Ada|Beispiel|example\.invalid|Synthetikweg|Testdaten|Kommunikation/i,
  );

  // Schreibrechte dürfen explizit entzogene Leserechte nicht über Vollprojektionen umgehen.
  const deniedReadMarker = "READ-DENIED-PII";
  const deniedReadCandidateResponse = await request(
    "/api/portal/v1/personnel-lifecycle/candidates",
    {
      method: "POST",
      auth: admin,
      body: {
        dataProcessingAuthorizationConfirmed: true,
        profile: {
          firstName: "Read",
          lastName: "Denied",
          email: "read-denied-pii@example.invalid",
          address: { street: deniedReadMarker },
        },
        application: { internalNotes: deniedReadMarker },
      },
    },
  );
  assert.equal(
    deniedReadCandidateResponse.response.status,
    201,
    JSON.stringify(deniedReadCandidateResponse.payload),
  );
  const deniedReadCandidate = deniedReadCandidateResponse.payload.candidate;
  denyPersonnelReadAccess("101");

  const readDenied = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${deniedReadCandidate.id}`,
    { auth: admin },
  );
  assert.equal(readDenied.response.status, 403, JSON.stringify(readDenied.payload));
  assert.equal(readDenied.payload.code, "PERSONNEL_LIFECYCLE_CENTRAL_PERMISSION_REQUIRED");
  assert.doesNotMatch(JSON.stringify(readDenied.payload), new RegExp(deniedReadMarker, "i"));

  const writeDenied = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${deniedReadCandidate.id}`,
    {
      method: "PUT",
      auth: admin,
      body: { revision: deniedReadCandidate.revision, profile: {} },
    },
  );
  assert.equal(writeDenied.response.status, 403, JSON.stringify(writeDenied.payload));
  assert.equal(writeDenied.payload.code, "PERSONNEL_LIFECYCLE_CENTRAL_PERMISSION_REQUIRED");
  assert.doesNotMatch(JSON.stringify(writeDenied.payload), new RegExp(deniedReadMarker, "i"));
  assert.equal(
    db.prepare("SELECT revision FROM candidates WHERE id = ?").get(deniedReadCandidate.id).revision,
    deniedReadCandidate.revision,
  );
});

test("Personalmodul M2: Candidate-Dokument bleibt beim Blob-Abgleich erhalten", async () => {
  const storageRoot = path.join(testRoot, "app-data", "private", "amu");
  const key = fs.readFileSync(
    path.join(testRoot, "app-data", "private", "amu-local.key"),
    "utf8",
  ).trim();
  const storage = createAmuStorage({
    rootDirectory: storageRoot,
    encryptionKeys: { "local-v1": key },
    activeKeyId: "local-v1",
    scanner: async () => true,
  });
  const content = Buffer.from(
    "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n% candidate reconciliation\n%%EOF",
    "utf8",
  );
  const stored = await storage.saveBuffer({
    buffer: content,
    originalName: "bewerberunterlage.pdf",
  });
  const candidate = { id: crypto.randomUUID() };
  const document = { id: crypto.randomUUID(), candidate_id: candidate.id };
  const version = {
    document_id: document.id,
    version_number: 1,
    candidate_id: candidate.id,
  };
  const createdAt = new Date().toISOString();
  const category = db.prepare(
    "SELECT id FROM candidate_document_categories WHERE code = 'resume'",
  ).get();
  assert.ok(category?.id);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO candidates (
        id, state, protected_payload, revision, created_by, updated_by, created_at, updated_at
      ) VALUES (?, 'active', ?, 1, 'M2-TEST', 'M2-TEST', ?, ?)
    `).run(
      candidate.id,
      storage.protectRecord(
        JSON.stringify({ firstName: "Synthetic", lastName: "Candidate" }),
        candidateProtectionContext(candidate),
      ),
      createdAt,
      createdAt,
    );
    db.prepare(`
      INSERT INTO candidate_documents (
        id, candidate_id, category_id, visibility, status, current_version,
        protected_payload, revision, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'recruiting', 'active', 0, ?, 1, 'M2-TEST', 'M2-TEST', ?, ?)
    `).run(
      document.id,
      document.candidate_id,
      category.id,
      storage.protectRecord(
        JSON.stringify({ title: "Bewerberunterlage" }),
        candidateDocumentProtectionContext(document),
      ),
      createdAt,
      createdAt,
    );
    db.prepare(`
      INSERT INTO candidate_document_versions (
        document_id, version_number, storage_key, content_sha256, size_bytes,
        media_type, protected_payload, uploaded_by, created_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, 'M2-TEST', ?)
    `).run(
      version.document_id,
      stored.storageKey,
      stored.sha256,
      stored.byteSize,
      stored.detectedMime,
      storage.protectRecord(
        JSON.stringify({ originalFilename: stored.originalFilename }),
        candidateDocumentVersionProtectionContext(version),
      ),
      createdAt,
    );
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }

  const reconciliation = await reconcileOrphanAmuBlobs();
  assert.equal(reconciliation.removed, 0);
  assert.deepEqual(storage.readBuffer({
    storageKey: stored.storageKey,
    byteSize: stored.byteSize,
    sha256: stored.sha256,
    detectedMime: stored.detectedMime,
    originalFilename: stored.originalFilename,
  }), content);
});

test("Personalmodul Recruiting: strukturierte Profildaten, Teamfeedback und Bewerberfoto funktionieren gemeinsam", async () => {
  setPersonnelLifecycleEnabled(true);
  const admin = createSession("101", "admin");
  grantSensitivePersonnelAccess("101");
  const location = db.prepare(`
    SELECT id
    FROM locations
    WHERE active = 1
    ORDER BY id
    LIMIT 1
  `).get();
  assert.ok(location?.id);
  const department = db.prepare(`
    SELECT id
    FROM departments
    WHERE active = 1 AND location_id = ?
    ORDER BY id
    LIMIT 1
  `).get(String(location.id));
  const departmentId = department?.id ? Number(department.id) : null;
  const trialAppointmentId = crypto.randomUUID();

  const created = await request(
    "/api/portal/v1/personnel-lifecycle/candidates",
    {
      method: "POST",
      auth: admin,
      body: {
        dataProcessingAuthorizationConfirmed: true,
        profile: {
          firstName: "Foto",
          lastName: "Kandidatin",
          phone: "+43 660 1234567",
          birthDate: "1997-04-12",
          address: { postalCode: "6020", city: "Innsbruck" },
          citizenships: ["Österreich"],
        },
        application: {
          desiredLocationId: String(location.id),
          desiredDepartmentId: departmentId,
          targetAreas: [{
            locationId: String(location.id),
            departmentId,
            preferred: true,
          }],
          trialAppointments: [{
            id: trialAppointmentId,
            dateFrom: "2026-09-10",
            dateTo: "2026-09-11",
            startTime: "09:00",
            endTime: "17:00",
            locationId: String(location.id),
            departmentId,
            status: "planned",
            note: "Zwei Schnuppertage",
          }],
          competencyRatings: [
            { id: "fachlich", label: "Fachlich", rating: 4, note: "Guter Eindruck" },
            { id: "menschlich", label: "Menschlich", rating: 5, note: "Sehr passend" },
          ],
        },
      },
    },
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const candidate = created.payload.candidate;
  let application = candidate.applications[0];
  assert.equal(candidate.profile.email, "");
  assert.equal(candidate.profile.phone, "+43 660 1234567");
  assert.equal(candidate.profile.birthDate, "1997-04-12");
  assert.equal(candidate.profile.address.city, "Innsbruck");
  assert.deepEqual(candidate.profile.citizenships, ["Österreich"]);
  assert.equal(application.targetAreas[0].preferred, true);
  assert.equal(application.trialAppointments[0].id, trialAppointmentId);
  assert.deepEqual(application.competencyRatings.map(({ rating }) => rating), [4, 5]);

  db.prepare(`
    INSERT INTO locations (id, name, active)
    VALUES ('candidate-alternate', 'Alternative Testfiliale', 1)
  `).run();
  const alternateLocation = db.prepare(`
    SELECT id
    FROM locations
    WHERE active = 1 AND id <> ?
    ORDER BY id
    LIMIT 1
  `).get(String(location.id));
  assert.ok(alternateLocation?.id);
  const changedPreferredArea = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${application.id}`,
    {
      method: "PUT",
      auth: admin,
      body: {
        revision: application.revision,
        targetAreas: [
          {
            locationId: String(location.id),
            departmentId,
            preferred: false,
          },
          {
            locationId: String(alternateLocation.id),
            departmentId: null,
            preferred: true,
          },
        ],
      },
    },
  );
  assert.equal(changedPreferredArea.response.status, 200, JSON.stringify(changedPreferredArea.payload));
  application = changedPreferredArea.payload.application;
  assert.equal(application.desiredLocationId, String(alternateLocation.id));
  assert.equal(application.desiredDepartmentId, null);
  assert.equal(application.targetAreas.filter((area) => area.preferred).length, 1);

  const employee = db.prepare(`
    SELECT personnel_number
    FROM employees
    WHERE active = 1
    ORDER BY personnel_number
    LIMIT 1
  `).get();
  assert.ok(employee?.personnel_number);
  const feedback = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${application.id}/team-feedback`,
    {
      method: "POST",
      auth: admin,
      body: {
        revision: application.revision,
        employeeNumber: String(employee.personnel_number),
        trialAppointmentId,
        rating: 5,
        comment: "Rückmeldung aus dem Team",
        recordedByEmployeeNumber: "manipuliert",
        recordedAt: "1990-01-01T00:00:00.000Z",
      },
    },
  );
  assert.equal(feedback.response.status, 201, JSON.stringify(feedback.payload));
  const storedFeedback = feedback.payload.application.teamFeedback[0];
  assert.equal(storedFeedback.employeeNumber, String(employee.personnel_number));
  assert.equal(storedFeedback.recordedByEmployeeNumber, "101");
  assert.notEqual(storedFeedback.recordedAt, "1990-01-01T00:00:00.000Z");
  assert.equal(storedFeedback.comment, "Rückmeldung aus dem Team");

  const photoInput = await sharp({
    create: {
      width: 1600,
      height: 1200,
      channels: 3,
      background: { r: 40, g: 120, b: 180 },
    },
  }).png().toBuffer();
  const form = new FormData();
  form.append("document", new Blob([photoInput], { type: "image/png" }), "kandidatin.png");
  const uploaded = await multipartRequest(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/photo`,
    { auth: admin, form },
  );
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  assert.equal(uploaded.payload.photo.currentVersion, 1);
  assert.equal(uploaded.payload.photo.mediaType, "image/jpeg");
  assert.match(uploaded.payload.photo.downloadUrl, /\/photo$/);

  const photoResponse = await fetch(
    `${baseUrl}/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/photo`,
    { headers: { Cookie: admin.cookie } },
  );
  assert.equal(photoResponse.status, 200);
  assert.equal(photoResponse.headers.get("content-type"), "image/jpeg");
  assert.match(photoResponse.headers.get("cache-control") || "", /no-store/);
  const photo = Buffer.from(await photoResponse.arrayBuffer());
  const photoMetadata = await sharp(photo).metadata();
  assert.equal(Math.max(photoMetadata.width, photoMetadata.height), 768);

  const reread = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}`,
    { auth: admin },
  );
  assert.equal(reread.response.status, 200, JSON.stringify(reread.payload));
  assert.equal(reread.payload.candidate.photo.currentVersion, 1);
  assert.match(reread.payload.candidate.photo.downloadUrl, /\/photo$/);
  const listed = await request(
    "/api/portal/v1/personnel-lifecycle/candidates?limit=50&offset=0",
    { auth: admin },
  );
  assert.equal(listed.response.status, 200, JSON.stringify(listed.payload));
  const listedCandidate = listed.payload.candidates.find((entry) => entry.id === candidate.id);
  assert.equal(listedCandidate.photo.currentVersion, 1);
  assert.match(listedCandidate.photo.downloadUrl, /\/photo$/);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM candidate_document_versions WHERE document_id = ?")
      .get(uploaded.payload.photo.id).count,
    1,
  );

  const profileOnly = await request(
    "/api/portal/v1/personnel-lifecycle/candidates",
    {
      method: "POST",
      auth: admin,
      body: {
        dataProcessingAuthorizationConfirmed: true,
        profile: {
          firstName: "Nur",
          lastName: "Profil",
          phone: "+43 660 7654321",
        },
      },
    },
  );
  assert.equal(profileOnly.response.status, 201, JSON.stringify(profileOnly.payload));
  assert.deepEqual(profileOnly.payload.candidate.applications, []);
  const profileOnlyPhotoForm = new FormData();
  profileOnlyPhotoForm.append(
    "document",
    new Blob([photoInput], { type: "image/png" }),
    "profil-ohne-bewerbung.png",
  );
  const profileOnlyPhoto = await multipartRequest(
    `/api/portal/v1/personnel-lifecycle/candidates/${profileOnly.payload.candidate.id}/photo`,
    { auth: admin, form: profileOnlyPhotoForm },
  );
  assert.equal(profileOnlyPhoto.response.status, 201, JSON.stringify(profileOnlyPhoto.payload));
  assert.equal(profileOnlyPhoto.payload.photo.currentVersion, 1);
});

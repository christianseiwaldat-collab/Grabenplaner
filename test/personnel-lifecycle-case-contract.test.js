"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  PERSONNEL_LIFECYCLE_CASE_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_CASE_TYPES,
  PERSONNEL_LIFECYCLE_DATA_CLASSIFICATIONS: C,
  PERSONNEL_LIFECYCLE_DATA_CLASSIFICATION_IDS,
  PERSONNEL_LIFECYCLE_CASE_STATES,
  PERSONNEL_LIFECYCLE_INITIAL_STATES,
  PERSONNEL_LIFECYCLE_TERMINAL_STATES,
  PERSONNEL_LIFECYCLE_EMPLOYMENT_STATES,
  PERSONNEL_LIFECYCLE_EMPLOYMENT_TRANSITIONS,
  PERSONNEL_LIFECYCLE_CASE_PERMISSIONS: P,
  PERSONNEL_LIFECYCLE_CASE_PERMISSION_IDS,
  PERSONNEL_LIFECYCLE_PROJECTIONS: PROJECTION,
  PERSONNEL_LIFECYCLE_RECIPIENT_CLASSES: RECIPIENT,
  PERSONNEL_LIFECYCLE_PROJECTION_RECIPIENT_CLASSES,
  PERSONNEL_LIFECYCLE_PROJECTION_FIELDS,
  PERSONNEL_LIFECYCLE_PROJECTION_CLASSIFICATIONS,
  PERSONNEL_LIFECYCLE_TARGET_ENTITIES,
  PERSONNEL_LIFECYCLE_O1_RUNTIME_GATES,
  isPersonnelLifecycleCaseTransitionAllowed,
  personnelLifecyclePermissionsForTransition,
  isPersonnelLifecycleEmploymentTransitionAllowed,
  personnelLifecyclePermissionsForEmploymentTransition,
  projectPersonnelLifecycleRecord,
  assertPersonnelLifecycleCaseContract,
} = require("../lib/personnel-lifecycle-case-contract");

test("O1-Vertrag ist versioniert, eingefroren und öffnet keine Laufzeitgrenze", () => {
  assert.equal(PERSONNEL_LIFECYCLE_CASE_CONTRACT_VERSION, "o1-v0.1");
  assert.deepEqual(PERSONNEL_LIFECYCLE_CASE_TYPES, ["onboarding", "offboarding"]);
  assert.deepEqual(C, {
    OPERATIONAL_STANDARD: "operational_standard",
    PERSONAL_RESTRICTED: "personal_restricted",
    HR_CONFIDENTIAL: "hr_confidential",
    OFFBOARDING_STRICT_CONFIDENTIAL: "offboarding_strict_confidential",
    EMPLOYEE_RELEASED: "employee_released",
  });
  assert.deepEqual(PERSONNEL_LIFECYCLE_DATA_CLASSIFICATION_IDS, Object.values(C));
  assert.equal(Object.isFrozen(PERSONNEL_LIFECYCLE_CASE_TYPES), true);
  assert.equal(Object.isFrozen(C), true);
  assert.equal(Object.isFrozen(PERSONNEL_LIFECYCLE_O1_RUNTIME_GATES), true);
  assert.equal(Object.values(PERSONNEL_LIFECYCLE_O1_RUNTIME_GATES).every((value) => (
    value === false
  )), true);
  assert.equal(assertPersonnelLifecycleCaseContract(), true);
});

test("O1-Fachrechte sind aktionsbezogen und enthalten keine implizite Rollenfreigabe", () => {
  assert.deepEqual(P, {
    ONBOARDING_READ: "personnel:lifecycle:onboarding:read",
    ONBOARDING_PREPARE: "personnel:lifecycle:onboarding:prepare",
    ONBOARDING_APPROVE: "personnel:lifecycle:onboarding:approve",
    ONBOARDING_EXECUTE: "personnel:lifecycle:onboarding:execute",
    ONBOARDING_CLOSE: "personnel:lifecycle:onboarding:close",
    OFFBOARDING_CONFIDENTIAL_READ: "personnel:lifecycle:offboarding:confidential:read",
    OFFBOARDING_PREPARE: "personnel:lifecycle:offboarding:prepare",
    OFFBOARDING_COMMUNICATION_RELEASE: "personnel:lifecycle:offboarding:communication:release",
    OFFBOARDING_INFORMATION_CONFIRM: "personnel:lifecycle:offboarding:information:confirm",
    OFFBOARDING_EXECUTE: "personnel:lifecycle:offboarding:execute",
    OFFBOARDING_CLOSE: "personnel:lifecycle:offboarding:close",
    PERSONAL_RESTRICTED_READ: "personnel:lifecycle:personal:read",
    HR_CONFIDENTIAL_READ: "personnel:lifecycle:hr-confidential:read",
    PACKAGES_READ: "personnel:lifecycle:packages:read",
    PACKAGES_WRITE: "personnel:lifecycle:packages:write",
    PACKAGES_PUBLISH: "personnel:lifecycle:packages:publish",
    ASSIGNMENTS_WRITE: "personnel:lifecycle:assignments:write",
    EXCEPTIONS_APPROVE: "personnel:lifecycle:exceptions:approve",
    OPERATIONAL_READ: "personnel:lifecycle:operational:read",
    OPERATIONAL_UPDATE: "personnel:lifecycle:operational:update",
    AUDIT_READ: "personnel:lifecycle:audit:read",
    CONFIDENTIAL_AUDIT_READ: "personnel:lifecycle:audit:confidential:read",
    DELEGATE: "personnel:lifecycle:delegate",
  });
  assert.deepEqual(PERSONNEL_LIFECYCLE_CASE_PERMISSION_IDS, Object.values(P));
  assert.equal(new Set(PERSONNEL_LIFECYCLE_CASE_PERMISSION_IDS).size, 23);
  assert.equal(Object.isFrozen(P), true);
  assert.equal(Object.isFrozen(PERSONNEL_LIFECYCLE_CASE_PERMISSION_IDS), true);
});

test("Onboarding-Zustände sind begrenzt und terminale Fälle bleiben geschlossen", () => {
  assert.deepEqual(PERSONNEL_LIFECYCLE_CASE_STATES.onboarding, [
    "prepared",
    "approved",
    "active",
    "completed",
    "cancelled",
  ]);
  assert.equal(PERSONNEL_LIFECYCLE_INITIAL_STATES.onboarding, "prepared");
  assert.deepEqual(PERSONNEL_LIFECYCLE_TERMINAL_STATES.onboarding, [
    "completed",
    "cancelled",
  ]);
  assert.equal(isPersonnelLifecycleCaseTransitionAllowed("onboarding", null, "prepared"), true);
  assert.equal(isPersonnelLifecycleCaseTransitionAllowed("onboarding", "prepared", "approved"), true);
  assert.equal(isPersonnelLifecycleCaseTransitionAllowed("onboarding", "approved", "active"), true);
  assert.equal(isPersonnelLifecycleCaseTransitionAllowed("onboarding", "active", "completed"), true);
  for (const from of ["prepared", "approved", "active"]) {
    assert.equal(isPersonnelLifecycleCaseTransitionAllowed("onboarding", from, "cancelled"), true);
  }
  for (const terminal of PERSONNEL_LIFECYCLE_TERMINAL_STATES.onboarding) {
    for (const target of PERSONNEL_LIFECYCLE_CASE_STATES.onboarding) {
      assert.equal(
        isPersonnelLifecycleCaseTransitionAllowed("onboarding", terminal, target),
        false,
        `${terminal}->${target}`,
      );
    }
  }
  assert.equal(isPersonnelLifecycleCaseTransitionAllowed("onboarding", "prepared", "active"), false);
  assert.equal(isPersonnelLifecycleCaseTransitionAllowed("onboarding", "unknown", "active"), false);
});

test("Offboarding erzwingt Vorbereitung, Kommunikationsfreigabe und Mitarbeiterinformation", () => {
  assert.deepEqual(PERSONNEL_LIFECYCLE_CASE_STATES.offboarding, [
    "internally_prepared",
    "communication_released",
    "employee_informed",
    "active",
    "completed",
    "cancelled",
  ]);
  assert.equal(PERSONNEL_LIFECYCLE_INITIAL_STATES.offboarding, "internally_prepared");
  const ordered = [
    [null, "internally_prepared"],
    ["internally_prepared", "communication_released"],
    ["communication_released", "employee_informed"],
    ["employee_informed", "active"],
    ["active", "completed"],
  ];
  for (const [from, to] of ordered) {
    assert.equal(isPersonnelLifecycleCaseTransitionAllowed("offboarding", from, to), true);
  }
  assert.equal(
    isPersonnelLifecycleCaseTransitionAllowed(
      "offboarding",
      "internally_prepared",
      "employee_informed",
    ),
    false,
  );
  assert.equal(
    isPersonnelLifecycleCaseTransitionAllowed("offboarding", "employee_informed", "completed"),
    false,
  );
  for (const terminal of PERSONNEL_LIFECYCLE_TERMINAL_STATES.offboarding) {
    assert.equal(
      isPersonnelLifecycleCaseTransitionAllowed("offboarding", terminal, "active"),
      false,
    );
  }
});

test("Austritt läuft bleibt ein eigener geschützter Beschäftigungsstatus", () => {
  assert.deepEqual(PERSONNEL_LIFECYCLE_EMPLOYMENT_STATES, {
    ACTIVE: "employment_active",
    EXIT_IN_PROGRESS: "exit_in_progress",
    ENDED: "employment_ended",
  });
  assert.deepEqual(PERSONNEL_LIFECYCLE_EMPLOYMENT_TRANSITIONS, {
    employment_active: ["exit_in_progress"],
    exit_in_progress: ["employment_active", "employment_ended"],
    employment_ended: [],
  });
  assert.equal(
    isPersonnelLifecycleEmploymentTransitionAllowed("employment_active", "exit_in_progress"),
    true,
  );
  assert.deepEqual(
    personnelLifecyclePermissionsForEmploymentTransition(
      "employment_active",
      "exit_in_progress",
    ),
    [P.OFFBOARDING_COMMUNICATION_RELEASE],
  );
  assert.deepEqual(
    personnelLifecyclePermissionsForEmploymentTransition(
      "exit_in_progress",
      "employment_active",
    ),
    [P.OFFBOARDING_COMMUNICATION_RELEASE, P.OFFBOARDING_CLOSE],
  );
  assert.deepEqual(
    personnelLifecyclePermissionsForEmploymentTransition(
      "exit_in_progress",
      "employment_ended",
    ),
    [P.OFFBOARDING_CLOSE],
  );
  assert.equal(
    isPersonnelLifecycleEmploymentTransitionAllowed("employment_ended", "employment_active"),
    false,
  );
});

test("jeder zulässige Zustandswechsel besitzt genau das vorgesehene Fachrecht", () => {
  assert.deepEqual(
    personnelLifecyclePermissionsForTransition("onboarding", null, "prepared"),
    [P.ONBOARDING_PREPARE],
  );
  assert.deepEqual(
    personnelLifecyclePermissionsForTransition("onboarding", "prepared", "approved"),
    [P.ONBOARDING_APPROVE],
  );
  assert.deepEqual(
    personnelLifecyclePermissionsForTransition("onboarding", "approved", "active"),
    [P.ONBOARDING_EXECUTE],
  );
  assert.deepEqual(
    personnelLifecyclePermissionsForTransition("offboarding", null, "internally_prepared"),
    [P.OFFBOARDING_PREPARE],
  );
  assert.deepEqual(
    personnelLifecyclePermissionsForTransition(
      "offboarding",
      "internally_prepared",
      "communication_released",
    ),
    [P.OFFBOARDING_COMMUNICATION_RELEASE],
  );
  assert.deepEqual(
    personnelLifecyclePermissionsForTransition(
      "offboarding",
      "communication_released",
      "employee_informed",
    ),
    [P.OFFBOARDING_INFORMATION_CONFIRM],
  );
  assert.deepEqual(
    personnelLifecyclePermissionsForTransition("offboarding", "employee_informed", "active"),
    [P.OFFBOARDING_EXECUTE],
  );
  assert.deepEqual(
    personnelLifecyclePermissionsForTransition("offboarding", "active", "cancelled"),
    [P.OFFBOARDING_COMMUNICATION_RELEASE, P.OFFBOARDING_CLOSE],
  );
  assert.deepEqual(
    personnelLifecyclePermissionsForTransition("offboarding", "completed", "active"),
    [],
  );
});

test("positive Projektionen besitzen feste Schutzklassen und Feldlisten", () => {
  assert.deepEqual(PERSONNEL_LIFECYCLE_PROJECTION_RECIPIENT_CLASSES, {
    employee_task: RECIPIENT.EMPLOYEE,
    leadership_task: RECIPIENT.LEADERSHIP,
    it_security_task: RECIPIENT.IT_SECURITY,
    asset_task: RECIPIENT.ASSET_CUSTODIAN,
    training_task: RECIPIENT.TRAINER,
    payroll_task: RECIPIENT.PAYROLL,
    hr_case: RECIPIENT.HR_CASE,
    hr_confidential: RECIPIENT.HR_CONFIDENTIAL,
    offboarding_confidential: RECIPIENT.OFFBOARDING_CONFIDENTIAL,
    confidential_audit: RECIPIENT.CONFIDENTIAL_AUDIT,
  });
  assert.deepEqual(PERSONNEL_LIFECYCLE_PROJECTION_CLASSIFICATIONS, {
    employee_task: C.EMPLOYEE_RELEASED,
    leadership_task: C.OPERATIONAL_STANDARD,
    it_security_task: C.OPERATIONAL_STANDARD,
    asset_task: C.OPERATIONAL_STANDARD,
    training_task: C.OPERATIONAL_STANDARD,
    payroll_task: C.PERSONAL_RESTRICTED,
    hr_case: C.PERSONAL_RESTRICTED,
    hr_confidential: C.HR_CONFIDENTIAL,
    offboarding_confidential: C.OFFBOARDING_STRICT_CONFIDENTIAL,
    confidential_audit: C.OFFBOARDING_STRICT_CONFIDENTIAL,
  });
  assert.deepEqual(PERSONNEL_LIFECYCLE_PROJECTION_FIELDS[PROJECTION.IT_SECURITY_TASK], [
    "orderId",
    "displayName",
    "businessIdentifier",
    "targetSystem",
    "action",
    "executeAt",
    "status",
  ]);
  assert.deepEqual(PERSONNEL_LIFECYCLE_PROJECTION_FIELDS[PROJECTION.CONFIDENTIAL_AUDIT], [
    "accessEventId",
    "caseId",
    "actorId",
    "action",
    "occurredAt",
    "result",
    "purposeCode",
  ]);
});

test("Projektoren kopieren ausschließlich die Positivliste und niemals vertrauliche Nebenfelder", () => {
  const source = {
    orderId: "order-1",
    displayName: "Erika Beispiel",
    businessIdentifier: "e.beispiel",
    targetSystem: "directory",
    action: "disable",
    executeAt: "2026-09-30T16:00:00.000Z",
    status: "pending",
    exitReason: "darf nicht erscheinen",
    hrNotes: "darf nicht erscheinen",
    privateContact: { phone: "+43 000" },
    receiptSha256: "a".repeat(64),
  };
  const projection = projectPersonnelLifecycleRecord(source, PROJECTION.IT_SECURITY_TASK);
  assert.deepEqual(projection, {
    orderId: "order-1",
    displayName: "Erika Beispiel",
    businessIdentifier: "e.beispiel",
    targetSystem: "directory",
    action: "disable",
    executeAt: "2026-09-30T16:00:00.000Z",
    status: "pending",
  });
  assert.equal(Object.isFrozen(projection), true);
  assert.equal("exitReason" in projection, false);
  assert.equal("hrNotes" in projection, false);
  assert.equal("privateContact" in projection, false);
  assert.equal("receiptSha256" in projection, false);
  assert.equal(projectPersonnelLifecycleRecord(source, "unknown"), null);
  assert.equal(projectPersonnelLifecycleRecord(null, PROJECTION.IT_SECURITY_TASK), null);
});

test("verschachtelte Projektionswerte werden defensiv kopiert und eingefroren", () => {
  const source = {
    caseId: "case-1",
    employeeNumber: "EMP-1",
    contractReference: "contract-1",
    employmentType: "full_time",
    weeklyMinutes: 2280,
    hrNote: "Geschützter Hinweis",
    legalReferenceIds: ["legal-1"],
    documentReferenceIds: ["document-1"],
  };
  const projection = projectPersonnelLifecycleRecord(source, PROJECTION.HR_CONFIDENTIAL);
  source.legalReferenceIds[0] = "manipulated";
  source.documentReferenceIds[0] = "manipulated";
  assert.equal(projection.legalReferenceIds[0], "legal-1");
  assert.equal(projection.documentReferenceIds[0], "document-1");
  assert.equal(Object.isFrozen(projection.legalReferenceIds), true);
  assert.equal(Object.isFrozen(projection.documentReferenceIds), true);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => projectPersonnelLifecycleRecord({ legalReferenceIds: cyclic }, PROJECTION.HR_CONFIDENTIAL),
    /strukturell ungültig/,
  );
});

test("O1 entscheidet additive Zielentitäten, persistiert sie aber ausdrücklich nicht", () => {
  assert.deepEqual(Object.keys(PERSONNEL_LIFECYCLE_TARGET_ENTITIES), [
    "EMPLOYMENT_EPISODE",
    "CASE",
    "REFERENCE_DATES",
    "PACKAGE_BINDING",
    "ASSIGNMENT",
    "CASE_EVENT",
    "CONFIDENTIAL_ACCESS_EVENT",
  ]);
  const stores = Object.values(PERSONNEL_LIFECYCLE_TARGET_ENTITIES)
    .map((entity) => entity.targetStore);
  assert.equal(new Set(stores).size, stores.length);
  for (const entity of Object.values(PERSONNEL_LIFECYCLE_TARGET_ENTITIES)) {
    assert.equal(entity.storageMode, "additive_sidecar");
    assert.equal(entity.historyMode, "append_only_events");
    assert.equal(entity.persistedInO1, false);
    assert.equal(Object.isFrozen(entity), true);
    assert.equal(Object.isFrozen(entity.immutableFields), true);
  }
});

test("Lifecycle-UI verdrahtet nur freigegebene Rechte; interne O1-Rechte bleiben geschlossen", () => {
  const root = path.join(__dirname, "..");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
  assert.match(server, /personnel-lifecycle-case-access/);
  assert.match(server, /PERSONNEL_LIFECYCLE_CASE_PERMISSIONS\.ONBOARDING_READ/);
  assert.match(server, /PERSONNEL_LIFECYCLE_CASE_PERMISSIONS\.PACKAGES_READ/);
  assert.equal(app.includes(P.ONBOARDING_READ), true);
  assert.equal(app.includes(P.PACKAGES_READ), true);

  const o5ServerPermissionNames = new Set(Object.keys(P));
  const o5ClientPermissionNames = new Set([
    "ONBOARDING_READ",
    "ONBOARDING_PREPARE",
    "ONBOARDING_APPROVE",
    "ONBOARDING_EXECUTE",
    "ONBOARDING_CLOSE",
    "OFFBOARDING_CONFIDENTIAL_READ",
    "OFFBOARDING_PREPARE",
    "OFFBOARDING_COMMUNICATION_RELEASE",
    "OFFBOARDING_INFORMATION_CONFIRM",
    "OFFBOARDING_EXECUTE",
    "OFFBOARDING_CLOSE",
    "PACKAGES_READ",
    "PACKAGES_WRITE",
    "PACKAGES_PUBLISH",
    "OPERATIONAL_READ",
    "OPERATIONAL_UPDATE",
    "AUDIT_READ",
    "CONFIDENTIAL_AUDIT_READ",
    "HR_CONFIDENTIAL_READ",
  ]);
  for (const [name, permission] of Object.entries(P)) {
    assert.equal(
      server.includes(`PERSONNEL_LIFECYCLE_CASE_PERMISSIONS.${name}`),
      o5ServerPermissionNames.has(name),
      name,
    );
    assert.equal(app.includes(permission), o5ClientPermissionNames.has(name), permission);
  }

  const unrelatedRuntimeSources = [
    "lib/persistence/application-repositories.js",
    "lib/persistence/migrations/application-manifest.js",
    "lib/persistence/repositories/personnel-lifecycle.js",
  ].map((relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8"));
  for (const source of unrelatedRuntimeSources) {
    assert.doesNotMatch(source, /personnel-lifecycle-case-(?:contract|access)/);
    assert.doesNotMatch(source, /personnel-lifecycle-case-foundation/);
    for (const permission of PERSONNEL_LIFECYCLE_CASE_PERMISSION_IDS) {
      assert.equal(source.includes(permission), false, permission);
    }
    for (const entity of Object.values(PERSONNEL_LIFECYCLE_TARGET_ENTITIES)) {
      assert.equal(source.includes(entity.targetStore), false, entity.targetStore);
    }
  }
  const applicationSchema = fs.readFileSync(path.join(
    root,
    "lib/persistence/sqlite/operations/application-schema.js",
  ), "utf8");
  assert.match(applicationSchema, /ensureSqlitePersonnelLifecycleCaseSchema/);
  assert.doesNotMatch(applicationSchema, /personnel-lifecycle-case-(?:contract|access)/);

  const o2Schema = fs.readFileSync(path.join(
    root,
    "lib/persistence/sqlite/operations/personnel-lifecycle-case-schema.js",
  ), "utf8");
  for (const entity of Object.values(PERSONNEL_LIFECYCLE_TARGET_ENTITIES)) {
    assert.equal(o2Schema.includes(entity.targetStore), true, entity.targetStore);
  }
  assert.match(o2Schema, /O2 persistence is read-only/);
});

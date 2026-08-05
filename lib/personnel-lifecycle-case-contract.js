"use strict";

const PERSONNEL_LIFECYCLE_CASE_CONTRACT_VERSION = "o1-v0.1";

const PERSONNEL_LIFECYCLE_CASE_TYPES = Object.freeze([
  "onboarding",
  "offboarding",
]);

const PERSONNEL_LIFECYCLE_DATA_CLASSIFICATIONS = Object.freeze({
  OPERATIONAL_STANDARD: "operational_standard",
  PERSONAL_RESTRICTED: "personal_restricted",
  HR_CONFIDENTIAL: "hr_confidential",
  OFFBOARDING_STRICT_CONFIDENTIAL: "offboarding_strict_confidential",
  EMPLOYEE_RELEASED: "employee_released",
});

const PERSONNEL_LIFECYCLE_DATA_CLASSIFICATION_IDS = Object.freeze(
  Object.values(PERSONNEL_LIFECYCLE_DATA_CLASSIFICATIONS),
);

const PERSONNEL_LIFECYCLE_CASE_STATES = Object.freeze({
  onboarding: Object.freeze([
    "prepared",
    "approved",
    "active",
    "completed",
    "cancelled",
  ]),
  offboarding: Object.freeze([
    "internally_prepared",
    "communication_released",
    "employee_informed",
    "active",
    "completed",
    "cancelled",
  ]),
});

const PERSONNEL_LIFECYCLE_INITIAL_STATES = Object.freeze({
  onboarding: "prepared",
  offboarding: "internally_prepared",
});

const PERSONNEL_LIFECYCLE_TERMINAL_STATES = Object.freeze({
  onboarding: Object.freeze(["completed", "cancelled"]),
  offboarding: Object.freeze(["completed", "cancelled"]),
});

const PERSONNEL_LIFECYCLE_EMPLOYMENT_STATES = Object.freeze({
  ACTIVE: "employment_active",
  EXIT_IN_PROGRESS: "exit_in_progress",
  ENDED: "employment_ended",
});

const PERSONNEL_LIFECYCLE_EMPLOYMENT_TRANSITIONS = Object.freeze({
  employment_active: Object.freeze(["exit_in_progress"]),
  exit_in_progress: Object.freeze(["employment_active", "employment_ended"]),
  employment_ended: Object.freeze([]),
});

const PERSONNEL_LIFECYCLE_CASE_TRANSITIONS = Object.freeze({
  onboarding: Object.freeze({
    prepared: Object.freeze(["approved", "cancelled"]),
    approved: Object.freeze(["active", "cancelled"]),
    active: Object.freeze(["completed", "cancelled"]),
    completed: Object.freeze([]),
    cancelled: Object.freeze([]),
  }),
  offboarding: Object.freeze({
    internally_prepared: Object.freeze(["communication_released", "cancelled"]),
    communication_released: Object.freeze(["employee_informed", "cancelled"]),
    employee_informed: Object.freeze(["active", "cancelled"]),
    active: Object.freeze(["completed", "cancelled"]),
    completed: Object.freeze([]),
    cancelled: Object.freeze([]),
  }),
});

const PERSONNEL_LIFECYCLE_CASE_PERMISSIONS = Object.freeze({
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

const PERSONNEL_LIFECYCLE_CASE_PERMISSION_IDS = Object.freeze(
  Object.values(PERSONNEL_LIFECYCLE_CASE_PERMISSIONS),
);

const P = PERSONNEL_LIFECYCLE_CASE_PERMISSIONS;

function permissionRequirements(...permissions) {
  return Object.freeze(permissions);
}

const PERSONNEL_LIFECYCLE_TRANSITION_PERMISSION_REQUIREMENTS = Object.freeze({
  onboarding: Object.freeze({
    "none->prepared": permissionRequirements(P.ONBOARDING_PREPARE),
    "prepared->approved": permissionRequirements(P.ONBOARDING_APPROVE),
    "approved->active": permissionRequirements(P.ONBOARDING_EXECUTE),
    "prepared->cancelled": permissionRequirements(P.ONBOARDING_CLOSE),
    "approved->cancelled": permissionRequirements(P.ONBOARDING_CLOSE),
    "active->cancelled": permissionRequirements(P.ONBOARDING_CLOSE),
    "active->completed": permissionRequirements(P.ONBOARDING_CLOSE),
  }),
  offboarding: Object.freeze({
    "none->internally_prepared": permissionRequirements(P.OFFBOARDING_PREPARE),
    "internally_prepared->communication_released": permissionRequirements(
      P.OFFBOARDING_COMMUNICATION_RELEASE,
    ),
    "communication_released->employee_informed": permissionRequirements(
      P.OFFBOARDING_INFORMATION_CONFIRM,
    ),
    "employee_informed->active": permissionRequirements(P.OFFBOARDING_EXECUTE),
    "internally_prepared->cancelled": permissionRequirements(
      P.OFFBOARDING_PREPARE,
      P.OFFBOARDING_CLOSE,
    ),
    "communication_released->cancelled": permissionRequirements(
      P.OFFBOARDING_COMMUNICATION_RELEASE,
      P.OFFBOARDING_CLOSE,
    ),
    "employee_informed->cancelled": permissionRequirements(
      P.OFFBOARDING_COMMUNICATION_RELEASE,
      P.OFFBOARDING_CLOSE,
    ),
    "active->cancelled": permissionRequirements(
      P.OFFBOARDING_COMMUNICATION_RELEASE,
      P.OFFBOARDING_CLOSE,
    ),
    "active->completed": permissionRequirements(P.OFFBOARDING_CLOSE),
  }),
});

const PERSONNEL_LIFECYCLE_EMPLOYMENT_TRANSITION_PERMISSION_REQUIREMENTS = Object.freeze({
  "employment_active->exit_in_progress": permissionRequirements(
    P.OFFBOARDING_COMMUNICATION_RELEASE,
  ),
  "exit_in_progress->employment_active": permissionRequirements(
    P.OFFBOARDING_COMMUNICATION_RELEASE,
    P.OFFBOARDING_CLOSE,
  ),
  "exit_in_progress->employment_ended": permissionRequirements(P.OFFBOARDING_CLOSE),
});

const PERSONNEL_LIFECYCLE_PROJECTIONS = Object.freeze({
  EMPLOYEE_TASK: "employee_task",
  LEADERSHIP_TASK: "leadership_task",
  IT_SECURITY_TASK: "it_security_task",
  ASSET_TASK: "asset_task",
  TRAINING_TASK: "training_task",
  PAYROLL_TASK: "payroll_task",
  HR_CASE: "hr_case",
  HR_CONFIDENTIAL: "hr_confidential",
  OFFBOARDING_CONFIDENTIAL: "offboarding_confidential",
  CONFIDENTIAL_AUDIT: "confidential_audit",
});

const PERSONNEL_LIFECYCLE_RECIPIENT_CLASSES = Object.freeze({
  EMPLOYEE: "employee",
  LEADERSHIP: "leadership",
  IT_SECURITY: "it_security",
  ASSET_CUSTODIAN: "asset_custodian",
  TRAINER: "trainer",
  PAYROLL: "payroll",
  HR_CASE: "hr_case",
  HR_CONFIDENTIAL: "hr_confidential",
  OFFBOARDING_CONFIDENTIAL: "offboarding_confidential",
  CONFIDENTIAL_AUDIT: "confidential_audit",
});

const R = PERSONNEL_LIFECYCLE_RECIPIENT_CLASSES;
const PERSONNEL_LIFECYCLE_PROJECTION_RECIPIENT_CLASSES = Object.freeze({
  employee_task: R.EMPLOYEE,
  leadership_task: R.LEADERSHIP,
  it_security_task: R.IT_SECURITY,
  asset_task: R.ASSET_CUSTODIAN,
  training_task: R.TRAINER,
  payroll_task: R.PAYROLL,
  hr_case: R.HR_CASE,
  hr_confidential: R.HR_CONFIDENTIAL,
  offboarding_confidential: R.OFFBOARDING_CONFIDENTIAL,
  confidential_audit: R.CONFIDENTIAL_AUDIT,
});

const PROJECTION_FIELDS = Object.freeze({
  employee_task: Object.freeze([
    "orderId",
    "title",
    "instructions",
    "dueAt",
    "status",
    "evidenceStatus",
  ]),
  leadership_task: Object.freeze([
    "orderId",
    "displayName",
    "locationId",
    "departmentId",
    "title",
    "dueAt",
    "status",
  ]),
  it_security_task: Object.freeze([
    "orderId",
    "displayName",
    "businessIdentifier",
    "targetSystem",
    "action",
    "executeAt",
    "status",
  ]),
  asset_task: Object.freeze([
    "orderId",
    "displayName",
    "locationId",
    "assetIdentifier",
    "action",
    "dueAt",
    "status",
  ]),
  training_task: Object.freeze([
    "orderId",
    "displayName",
    "locationId",
    "departmentId",
    "module",
    "dueAt",
    "evidenceStatus",
    "status",
  ]),
  payroll_task: Object.freeze([
    "orderId",
    "employeeNumber",
    "displayName",
    "payrollAction",
    "effectiveDate",
    "dueAt",
    "status",
  ]),
  hr_case: Object.freeze([
    "caseId",
    "caseType",
    "employmentEpisodeId",
    "employeeNumber",
    "state",
    "scopeType",
    "locationId",
    "departmentId",
    "createdAt",
    "updatedAt",
  ]),
  hr_confidential: Object.freeze([
    "caseId",
    "employeeNumber",
    "contractReference",
    "employmentType",
    "weeklyMinutes",
    "hrNote",
    "legalReferenceIds",
    "documentReferenceIds",
  ]),
  offboarding_confidential: Object.freeze([
    "caseId",
    "employeeNumber",
    "plannedExitAt",
    "lastWorkingDay",
    "legalExitDate",
    "accessBlockAt",
    "exitReasonCode",
    "exitReasonNote",
    "communicationReleaseAt",
    "employeeInformedAt",
    "hrNote",
    "documentReferenceIds",
  ]),
  confidential_audit: Object.freeze([
    "accessEventId",
    "caseId",
    "actorId",
    "action",
    "occurredAt",
    "result",
    "purposeCode",
  ]),
});

const C = PERSONNEL_LIFECYCLE_DATA_CLASSIFICATIONS;
const PERSONNEL_LIFECYCLE_PROJECTION_CLASSIFICATIONS = Object.freeze({
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

function targetEntity({ logicalName, targetStore, purpose, immutableFields }) {
  return Object.freeze({
    logicalName,
    targetStore,
    purpose,
    storageMode: "additive_sidecar",
    immutableFields: Object.freeze([...immutableFields]),
    historyMode: "append_only_events",
    persistedInO1: false,
  });
}

const PERSONNEL_LIFECYCLE_TARGET_ENTITIES = Object.freeze({
  EMPLOYMENT_EPISODE: targetEntity({
    logicalName: "EmploymentEpisode",
    targetStore: "personnel_employment_episodes",
    purpose: "Bindet eine eigenständige Beschäftigungsepisode an den bestehenden Mitarbeiterstamm.",
    immutableFields: ["id", "employeeNumber", "sequenceNumber", "predecessorEpisodeId"],
  }),
  CASE: targetEntity({
    logicalName: "PersonnelLifecycleCase",
    targetStore: "personnel_lifecycle_cases",
    purpose: "Bündelt einen Onboarding- oder Offboarding-Fall ohne Aufgabenstatus zu duplizieren.",
    immutableFields: ["id", "caseType", "employmentEpisodeId", "predecessorCaseId"],
  }),
  REFERENCE_DATES: targetEntity({
    logicalName: "PersonnelLifecycleReferenceDates",
    targetStore: "personnel_lifecycle_case_reference_dates",
    purpose: "Hält getrennte, versionierte Referenztermine und deren geschützten Änderungsbezug.",
    immutableFields: ["id", "caseId", "revision", "previousRevisionId"],
  }),
  PACKAGE_BINDING: targetEntity({
    logicalName: "PersonnelLifecyclePackageBinding",
    targetStore: "personnel_lifecycle_case_package_bindings",
    purpose: "Bindet später jede Paketinstanz unveränderlich an Veröffentlichung und Fall.",
    immutableFields: ["id", "caseId", "publicationId", "versionNumber", "scopeSnapshotSha256"],
  }),
  ASSIGNMENT: targetEntity({
    logicalName: "PersonnelLifecycleAssignment",
    targetStore: "personnel_lifecycle_case_assignments",
    purpose: "Dokumentiert Einzelzuweisung und additive Nachfolgezuweisung ohne Überschreiben.",
    immutableFields: ["id", "caseId", "stepReference", "assigneeActorId", "predecessorAssignmentId"],
  }),
  CASE_EVENT: targetEntity({
    logicalName: "PersonnelLifecycleCaseEvent",
    targetStore: "personnel_lifecycle_case_events",
    purpose: "Belegt Zustandswechsel, Ausnahmen, Umbesetzungen und Abschlussentscheidungen.",
    immutableFields: ["id", "caseId", "sequenceNumber", "eventType", "previousReceiptSha256"],
  }),
  CONFIDENTIAL_ACCESS_EVENT: targetEntity({
    logicalName: "PersonnelLifecycleConfidentialAccessEvent",
    targetStore: "personnel_lifecycle_confidential_access_events",
    purpose: "Hält die getrennte Zugriffsspur ohne vertrauliche Nutzdaten im allgemeinen Audit.",
    immutableFields: ["id", "caseId", "actorId", "action", "occurredAt", "previousReceiptSha256"],
  }),
});

const PERSONNEL_LIFECYCLE_O1_RUNTIME_GATES = Object.freeze({
  productiveActivation: false,
  schemaMigration: false,
  persistence: false,
  apiRoutes: false,
  caseCreation: false,
  workflowInstantiation: false,
  taskCreation: false,
  profileProjection: false,
  notifications: false,
  externalActions: false,
});

function knownCaseType(value) {
  return PERSONNEL_LIFECYCLE_CASE_TYPES.includes(value);
}

function transitionKey(fromState, toState) {
  return `${fromState === null || fromState === undefined ? "none" : fromState}->${toState}`;
}

function isPersonnelLifecycleCaseTransitionAllowed(caseType, fromState, toState) {
  if (!knownCaseType(caseType) || typeof toState !== "string") return false;
  if (fromState === null || fromState === undefined) {
    return PERSONNEL_LIFECYCLE_INITIAL_STATES[caseType] === toState;
  }
  if (!PERSONNEL_LIFECYCLE_CASE_STATES[caseType].includes(fromState)) return false;
  return PERSONNEL_LIFECYCLE_CASE_TRANSITIONS[caseType][fromState].includes(toState);
}

function personnelLifecyclePermissionsForTransition(caseType, fromState, toState) {
  if (!isPersonnelLifecycleCaseTransitionAllowed(caseType, fromState, toState)) {
    return Object.freeze([]);
  }
  return PERSONNEL_LIFECYCLE_TRANSITION_PERMISSION_REQUIREMENTS[caseType][
    transitionKey(fromState, toState)
  ] || Object.freeze([]);
}

function isPersonnelLifecycleEmploymentTransitionAllowed(fromState, toState) {
  if (typeof fromState !== "string" || typeof toState !== "string") return false;
  return (PERSONNEL_LIFECYCLE_EMPLOYMENT_TRANSITIONS[fromState] || []).includes(toState);
}

function personnelLifecyclePermissionsForEmploymentTransition(fromState, toState) {
  if (!isPersonnelLifecycleEmploymentTransitionAllowed(fromState, toState)) {
    return Object.freeze([]);
  }
  return PERSONNEL_LIFECYCLE_EMPLOYMENT_TRANSITION_PERMISSION_REQUIREMENTS[
    transitionKey(fromState, toState)
  ] || Object.freeze([]);
}

function cloneProjectionValue(value, seen = new WeakSet(), depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Projektionswerte müssen endlich sein.");
    return value;
  }
  if (!value || typeof value !== "object" || depth > 12 || seen.has(value)) {
    throw new TypeError("Projektionswerte sind strukturell ungültig.");
  }
  seen.add(value);
  let clone;
  if (Array.isArray(value)) {
    if (value.length > 500) throw new TypeError("Projektionslisten sind zu groß.");
    clone = value.map((entry) => cloneProjectionValue(entry, seen, depth + 1));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Projektionsobjekte müssen einfache Datensätze sein.");
    }
    const keys = Object.keys(value);
    if (keys.length > 200) throw new TypeError("Projektionsobjekte sind zu groß.");
    clone = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("Dynamische Projektionsfelder sind nicht zulässig.");
      }
      clone[key] = cloneProjectionValue(descriptor.value, seen, depth + 1);
    }
  }
  seen.delete(value);
  return Object.freeze(clone);
}

function projectPersonnelLifecycleRecord(source, projectionValue) {
  const projection = String(projectionValue ?? "");
  const fields = PROJECTION_FIELDS[projection];
  if (!fields || !source || typeof source !== "object" || Array.isArray(source)) return null;
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const result = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, field);
    if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) continue;
    result[field] = cloneProjectionValue(descriptor.value);
  }
  return Object.freeze(result);
}

function assertPersonnelLifecycleCaseContract() {
  const permissionIds = PERSONNEL_LIFECYCLE_CASE_PERMISSION_IDS;
  if (new Set(permissionIds).size !== permissionIds.length) {
    throw new Error("O1 enthält doppelte Fachrechte.");
  }
  for (const caseType of PERSONNEL_LIFECYCLE_CASE_TYPES) {
    const states = PERSONNEL_LIFECYCLE_CASE_STATES[caseType];
    if (!states.includes(PERSONNEL_LIFECYCLE_INITIAL_STATES[caseType])) {
      throw new Error(`O1 enthält keinen gültigen Initialzustand für ${caseType}.`);
    }
    for (const terminal of PERSONNEL_LIFECYCLE_TERMINAL_STATES[caseType]) {
      if (!states.includes(terminal)
        || PERSONNEL_LIFECYCLE_CASE_TRANSITIONS[caseType][terminal].length !== 0) {
        throw new Error(`O1 enthält einen nicht terminalen Endzustand für ${caseType}.`);
      }
    }
  }
  if (PERSONNEL_LIFECYCLE_EMPLOYMENT_TRANSITIONS[
    PERSONNEL_LIFECYCLE_EMPLOYMENT_STATES.ENDED
  ].length !== 0) {
    throw new Error("O1 darf eine beendete Beschäftigungsepisode nicht wieder öffnen.");
  }
  if (Object.values(PERSONNEL_LIFECYCLE_O1_RUNTIME_GATES).some(Boolean)) {
    throw new Error("O1 darf keine Laufzeitgrenze öffnen.");
  }
  if (Object.values(PERSONNEL_LIFECYCLE_TARGET_ENTITIES)
    .some((entity) => entity.persistedInO1 !== false)) {
    throw new Error("O1 darf keine Zielentität persistieren.");
  }
  return true;
}

assertPersonnelLifecycleCaseContract();

module.exports = {
  PERSONNEL_LIFECYCLE_CASE_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_CASE_TYPES,
  PERSONNEL_LIFECYCLE_DATA_CLASSIFICATIONS,
  PERSONNEL_LIFECYCLE_DATA_CLASSIFICATION_IDS,
  PERSONNEL_LIFECYCLE_CASE_STATES,
  PERSONNEL_LIFECYCLE_INITIAL_STATES,
  PERSONNEL_LIFECYCLE_TERMINAL_STATES,
  PERSONNEL_LIFECYCLE_EMPLOYMENT_STATES,
  PERSONNEL_LIFECYCLE_EMPLOYMENT_TRANSITIONS,
  PERSONNEL_LIFECYCLE_CASE_TRANSITIONS,
  PERSONNEL_LIFECYCLE_CASE_PERMISSIONS,
  PERSONNEL_LIFECYCLE_CASE_PERMISSION_IDS,
  PERSONNEL_LIFECYCLE_TRANSITION_PERMISSION_REQUIREMENTS,
  PERSONNEL_LIFECYCLE_EMPLOYMENT_TRANSITION_PERMISSION_REQUIREMENTS,
  PERSONNEL_LIFECYCLE_PROJECTIONS,
  PERSONNEL_LIFECYCLE_RECIPIENT_CLASSES,
  PERSONNEL_LIFECYCLE_PROJECTION_RECIPIENT_CLASSES,
  PERSONNEL_LIFECYCLE_PROJECTION_FIELDS: PROJECTION_FIELDS,
  PERSONNEL_LIFECYCLE_PROJECTION_CLASSIFICATIONS,
  PERSONNEL_LIFECYCLE_TARGET_ENTITIES,
  PERSONNEL_LIFECYCLE_O1_RUNTIME_GATES,
  isPersonnelLifecycleCaseTransitionAllowed,
  personnelLifecyclePermissionsForTransition,
  isPersonnelLifecycleEmploymentTransitionAllowed,
  personnelLifecyclePermissionsForEmploymentTransition,
  projectPersonnelLifecycleRecord,
  assertPersonnelLifecycleCaseContract,
};

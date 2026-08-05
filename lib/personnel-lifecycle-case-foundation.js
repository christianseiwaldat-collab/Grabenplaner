"use strict";

const {
  assertCustomProcessManagementRepository,
} = require("./persistence/repositories/custom-process-management");
const {
  verifyPersonnelWorkflowPublication,
} = require("./personnel-workflow-publications");

const PERSONNEL_LIFECYCLE_O2_CONTRACT_VERSION = "o2-v0.1";

const PERSONNEL_LIFECYCLE_O2_REQUIRED_ONBOARDING_PACKAGE_FAMILIES = Object.freeze([
  "personnel_administration",
  "base_security_privacy",
]);

const PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES = Object.freeze({
  STARTS_LOCKED: "o2_starts_locked",
  SUBJECT_NOT_FOUND: "subject_not_found",
  SUBJECT_INACTIVE: "subject_inactive",
  SCOPE_UNRESOLVED: "scope_unresolved",
  SCOPE_INACTIVE: "scope_inactive",
  SCOPE_RELATION_INVALID: "scope_relation_invalid",
  NO_APPLICABLE_ONBOARDING_PACKAGES: "no_applicable_onboarding_packages",
  M4_PUBLICATION_REVIEW_REQUIRED: "m4_publication_review_required",
  REQUIRED_PACKAGE_FAMILY_UNMAPPED: "required_package_family_unmapped",
  PACKAGE_CONFLICT: "package_conflict",
  OFFBOARDING_DEFERRED: "offboarding_deferred_until_o5",
});

const PERSONNEL_LIFECYCLE_O2_RUNTIME_GATES = Object.freeze({
  schemaMigration: true,
  persistenceFoundation: true,
  readOnlyPackageResolution: true,
  readOnlyStartPreview: true,
  productiveActivation: false,
  apiRoutes: false,
  caseCreation: false,
  caseMutation: false,
  workflowInstantiation: false,
  taskCreation: false,
  assignmentResolution: false,
  profileProjection: false,
  notifications: false,
  externalActions: false,
});

class PersonnelLifecycleCaseFoundationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PersonnelLifecycleCaseFoundationError";
    this.code = code;
  }
}

function foundationError(message, code = "PERSONNEL_LIFECYCLE_O2_INPUT_INVALID") {
  return new PersonnelLifecycleCaseFoundationError(message, code);
}

function nonEmptyText(value, label, maximum = 200) {
  const text = String(value ?? "").trim();
  if (!text || text.includes("\0") || text.length > maximum) {
    throw foundationError(`${label} ist ungueltig.`);
  }
  return text;
}

function isTrue(value) {
  return value === true || value === 1;
}

function blocker(code, details = {}) {
  return Object.freeze({ code, ...details });
}

function normalizedSubject(row) {
  if (!row) return Object.freeze({ found: false, employeeNumber: null, active: false });
  const employeeNumber = String(row.employee_number || "").trim();
  if (row.subject_type !== "employee" || !employeeNumber) {
    throw foundationError(
      "Der Mitarbeiterbezug der O2-Vorschau ist widerspruechlich.",
      "PERSONNEL_LIFECYCLE_O2_SUBJECT_INTEGRITY_FAILED",
    );
  }
  return Object.freeze({
    found: true,
    employeeNumber,
    active: isTrue(row.employee_active),
    locationId: String(row.location_id || "").trim() || null,
    departmentId: Number.isSafeInteger(Number(row.department_id))
      && Number(row.department_id) > 0
      ? Number(row.department_id)
      : null,
    locationActive: isTrue(row.location_active),
    departmentActive: row.department_id === null || row.department_id === undefined
      ? null
      : isTrue(row.department_active),
    departmentLocationId: String(row.department_location_id || "").trim() || null,
  });
}

function subjectScope(subject, blockers) {
  if (!subject.found || !subject.locationId) {
    blockers.push(blocker(PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.SCOPE_UNRESOLVED));
    return null;
  }
  if (!subject.locationActive) {
    blockers.push(blocker(PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.SCOPE_INACTIVE, {
      scopeType: "location",
      locationId: subject.locationId,
    }));
    return null;
  }
  if (subject.departmentId === null) {
    return Object.freeze({
      type: "location",
      locationId: subject.locationId,
      departmentId: null,
    });
  }
  if (subject.departmentLocationId !== subject.locationId) {
    blockers.push(blocker(PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.SCOPE_RELATION_INVALID, {
      locationId: subject.locationId,
      departmentId: subject.departmentId,
    }));
    return null;
  }
  if (!subject.departmentActive) {
    blockers.push(blocker(PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.SCOPE_INACTIVE, {
      scopeType: "department",
      locationId: subject.locationId,
      departmentId: subject.departmentId,
    }));
    return null;
  }
  return Object.freeze({
    type: "department",
    locationId: subject.locationId,
    departmentId: subject.departmentId,
  });
}

function publicationAppliesTo(publication, scope) {
  if (!scope) return false;
  if (publication.scope.type === "company") return true;
  if (publication.scope.locationId !== scope.locationId) return false;
  if (publication.scope.type === "location") return true;
  return scope.type === "department"
    && publication.scope.departmentId === scope.departmentId;
}

function latestOnboardingPublications(rows) {
  if (!Array.isArray(rows)) {
    throw foundationError("Die Publikationsliste der O2-Vorschau ist ungueltig.");
  }
  const verified = rows.map(verifyPersonnelWorkflowPublication);
  const workflowCodeByProcess = new Map();
  const latestByProcess = new Map();
  for (const value of verified) {
    const { row } = value;
    const processId = String(row.process_id || "");
    const expectedCode = workflowCodeByProcess.get(processId);
    if (expectedCode && expectedCode !== row.workflow_code) {
      throw foundationError(
        "Die Publikationsfolge besitzt keinen stabilen Workflow-Code.",
        "PERSONNEL_LIFECYCLE_O2_PUBLICATION_INTEGRITY_FAILED",
      );
    }
    workflowCodeByProcess.set(processId, row.workflow_code);
    if (row.workflow_type !== "onboarding" || row.archived_at) continue;
    const current = latestByProcess.get(processId);
    if (!current || Number(row.version_number) > Number(current.row.version_number)) {
      latestByProcess.set(processId, value);
    }
  }
  return [...latestByProcess.values()];
}

function publicCandidate(value) {
  const { row, scope, snapshot } = value;
  return Object.freeze({
    publicationId: row.id,
    processId: row.process_id,
    sourceRevision: Number(row.source_revision),
    versionNumber: Number(row.version_number),
    workflowCode: row.workflow_code,
    title: String(snapshot.title || ""),
    authorityLevel: row.authority_level,
    requirementKind: row.requirement_kind,
    scope,
    publishedAt: row.published_at,
    reviewStatus: "requires_new_lifecycle_review",
  });
}

function candidateSort(left, right) {
  const priority = (candidate) => {
    if (candidate.requirementKind === "mandatory") return 0;
    if (candidate.scope.type === "company") return 1;
    if (candidate.scope.type === "location") return 2;
    return 3;
  };
  return priority(left) - priority(right)
    || left.workflowCode.localeCompare(right.workflowCode)
    || left.publicationId.localeCompare(right.publicationId);
}

function conflictSummary(candidates) {
  const groups = new Map();
  const add = (kind, value, candidate) => {
    const normalized = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized) return;
    const key = `${kind}\0${normalized}`;
    const values = groups.get(key) || [];
    values.push(candidate);
    groups.set(key, values);
  };
  for (const candidate of candidates) {
    add("workflow_code", candidate.workflowCode, candidate);
    add("title", candidate.title, candidate);
  }
  return Object.freeze([...groups.entries()]
    .filter(([, values]) => new Set(values.map(({ processId }) => processId)).size > 1)
    .map(([key, values]) => Object.freeze({
      kind: key.split("\0")[0],
      value: key.split("\0")[1],
      publicationIds: Object.freeze(values.map(({ publicationId }) => publicationId).sort()),
    }))
    .sort((left, right) => left.kind.localeCompare(right.kind)
      || left.value.localeCompare(right.value)));
}

function createPersonnelLifecycleStartPreview({
  caseType,
  subject: subjectRow,
  publications = [],
} = {}) {
  if (!new Set(["onboarding", "offboarding"]).has(caseType)) {
    throw foundationError("Der Falltyp der O2-Vorschau ist ungueltig.");
  }
  if (caseType === "offboarding") {
    return Object.freeze({
      contractVersion: PERSONNEL_LIFECYCLE_O2_CONTRACT_VERSION,
      mode: "read_only_start_preview",
      caseType,
      subject: null,
      scope: null,
      packageResolution: Object.freeze({
        requiredPackageFamilies: Object.freeze([]),
        applicableCandidates: Object.freeze([]),
        selectedBindings: Object.freeze([]),
        conflicts: Object.freeze([]),
      }),
      blockers: Object.freeze([
        blocker(PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.STARTS_LOCKED),
        blocker(PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.OFFBOARDING_DEFERRED),
      ]),
      startAllowed: false,
      casePersisted: false,
      instanceCount: 0,
      taskCount: 0,
      assignmentCount: 0,
    });
  }
  const subject = normalizedSubject(subjectRow);
  const blockers = [blocker(PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.STARTS_LOCKED)];
  if (!subject.found) {
    blockers.push(blocker(PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.SUBJECT_NOT_FOUND));
  } else if (!subject.active) {
    blockers.push(blocker(PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.SUBJECT_INACTIVE, {
      employeeNumber: subject.employeeNumber,
    }));
  }
  const scope = subjectScope(subject, blockers);
  let candidates = [];
  let conflicts = Object.freeze([]);

  if (scope) {
    candidates = latestOnboardingPublications(publications)
      .filter((publication) => publicationAppliesTo(publication, scope))
      .map(publicCandidate)
      .sort(candidateSort);
    if (!candidates.length) {
      blockers.push(blocker(
        PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.NO_APPLICABLE_ONBOARDING_PACKAGES,
      ));
    } else {
      blockers.push(blocker(
        PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.M4_PUBLICATION_REVIEW_REQUIRED,
        { publicationIds: Object.freeze(candidates.map(({ publicationId }) => publicationId)) },
      ));
    }
    conflicts = conflictSummary(candidates);
    for (const conflict of conflicts) {
      blockers.push(blocker(PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.PACKAGE_CONFLICT, {
        kind: conflict.kind,
        value: conflict.value,
        publicationIds: conflict.publicationIds,
      }));
    }
    for (const family of PERSONNEL_LIFECYCLE_O2_REQUIRED_ONBOARDING_PACKAGE_FAMILIES) {
      blockers.push(blocker(
        PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.REQUIRED_PACKAGE_FAMILY_UNMAPPED,
        { family },
      ));
    }
  }

  const subjectProjection = subject.found
    ? Object.freeze({
      employeeNumber: subject.employeeNumber,
      active: subject.active,
      employmentEpisodePersisted: false,
    })
    : null;
  const frozenCandidates = Object.freeze(candidates);
  return Object.freeze({
    contractVersion: PERSONNEL_LIFECYCLE_O2_CONTRACT_VERSION,
    mode: "read_only_start_preview",
    caseType,
    subject: subjectProjection,
    scope,
    packageResolution: Object.freeze({
      requiredPackageFamilies:
        PERSONNEL_LIFECYCLE_O2_REQUIRED_ONBOARDING_PACKAGE_FAMILIES,
      applicableCandidates: frozenCandidates,
      selectedBindings: Object.freeze([]),
      conflicts,
    }),
    blockers: Object.freeze(blockers),
    startAllowed: false,
    casePersisted: false,
    instanceCount: 0,
    taskCount: 0,
    assignmentCount: 0,
  });
}

function createPersonnelLifecycleCaseFoundationService(repositoryValue) {
  const repository = assertCustomProcessManagementRepository(repositoryValue);
  return Object.freeze({
    async preview({ caseType, employeeNumber } = {}) {
      if (caseType === "offboarding") {
        return createPersonnelLifecycleStartPreview({ caseType });
      }
      const normalizedEmployeeNumber = nonEmptyText(
        employeeNumber,
        "Die Personalnummer",
        100,
      );
      const [subject, publications] = await Promise.all([
        repository.personnelWorkflowEmployeeSubject({
          employeeNumber: normalizedEmployeeNumber,
        }),
        repository.listWorkflowPublications({ includeArchived: 1 }),
      ]);
      return createPersonnelLifecycleStartPreview({
        caseType,
        subject,
        publications,
      });
    },
  });
}

function assertPersonnelLifecycleO2Contract() {
  const openReadOnlyGates = [
    "schemaMigration",
    "persistenceFoundation",
    "readOnlyPackageResolution",
    "readOnlyStartPreview",
  ];
  for (const [name, value] of Object.entries(PERSONNEL_LIFECYCLE_O2_RUNTIME_GATES)) {
    if (value !== openReadOnlyGates.includes(name)) {
      throw new Error(`Das O2-Laufzeitgate ${name} verletzt den read-only Vertrag.`);
    }
  }
  return true;
}

assertPersonnelLifecycleO2Contract();

module.exports = {
  PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES,
  PERSONNEL_LIFECYCLE_O2_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_O2_REQUIRED_ONBOARDING_PACKAGE_FAMILIES,
  PERSONNEL_LIFECYCLE_O2_RUNTIME_GATES,
  PersonnelLifecycleCaseFoundationError,
  assertPersonnelLifecycleO2Contract,
  createPersonnelLifecycleCaseFoundationService,
  createPersonnelLifecycleStartPreview,
};

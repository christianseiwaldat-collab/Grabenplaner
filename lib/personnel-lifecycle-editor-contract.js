"use strict";

const crypto = require("node:crypto");
const { types: utilTypes } = require("node:util");

const PERSONNEL_LIFECYCLE_EDITOR_CONTRACT_VERSION = "o8-v0.1";
const PERSONNEL_LIFECYCLE_EDITOR_MODEL = "linear-v1";
const PERSONNEL_LIFECYCLE_EDITOR_MODE = "memory_only";
const PERSONNEL_LIFECYCLE_EDITOR_SOURCE = "memory";

const PERMISSIONS = Object.freeze({
  READ: "personnel:lifecycle:editor:read",
  DRAFT_WRITE: "personnel:lifecycle:editor:draft:write",
  VALIDATE: "personnel:lifecycle:editor:validate",
  REVIEW: "personnel:lifecycle:editor:review",
  PUBLISH: "personnel:lifecycle:editor:publish",
  ARCHIVE: "personnel:lifecycle:editor:archive",
});

const PERMISSION_IDS = Object.freeze(Object.values(PERMISSIONS));
const ROLE_GRANTS = Object.freeze({});

const WORKFLOW_TYPES = Object.freeze(["onboarding", "offboarding"]);
const STEP_TYPES = Object.freeze(["task", "approval", "finish"]);
const SCOPE_TYPES = Object.freeze(["company", "location", "department"]);
const REQUIREMENT_KINDS = Object.freeze(["mandatory", "optional"]);

const RESPONSIBILITY_CLASSES_BY_WORKFLOW_TYPE = Object.freeze({
  onboarding: Object.freeze([
    "hr_case",
    "payroll",
    "leadership",
    "it_security",
    "asset_custodian",
    "trainer",
    "employee",
  ]),
  offboarding: Object.freeze([
    "offboarding_confidential",
    "hr_confidential",
    "payroll",
    "leadership",
    "it_security",
    "asset_custodian",
    "employee",
  ]),
});

const LIMITS = Object.freeze({
  minimumSteps: 2,
  maximumSteps: 30,
  draftIdMaximumLength: 128,
  workflowCodeMaximumLength: 80,
  titleMaximumLength: 120,
  descriptionMaximumLength: 600,
  stepIdMaximumLength: 80,
  stepTitleMaximumLength: 120,
  stepDescriptionMaximumLength: 600,
});

const RUNTIME_GATES = Object.freeze({
  persistence: false,
  draftPersistence: false,
  publication: false,
  archive: false,
  instantiation: false,
  runtimeExecution: false,
  taskMutation: false,
  notification: false,
  scheduler: false,
  externalMutation: false,
  legacyBridge: false,
});

const BLOCKER_CODES = Object.freeze({
  DRAFT_ID_MISSING: "draft_id_missing",
  WORKFLOW_CODE_MISSING: "workflow_code_missing",
  TITLE_MISSING: "title_missing",
  MANDATORY_SCOPE_REQUIRES_COMPANY: "mandatory_scope_requires_company",
  STEP_COUNT_BELOW_MINIMUM: "step_count_below_minimum",
  STEP_ID_MISSING: "step_id_missing",
  STEP_TYPE_MISSING: "step_type_missing",
  STEP_TITLE_MISSING: "step_title_missing",
  RESPONSIBILITY_CLASS_MISSING: "responsibility_class_missing",
  FINISH_MISSING: "finish_missing",
  FINISH_MULTIPLE: "finish_multiple",
  FINISH_NOT_LAST: "finish_not_last",
  FINISH_MUST_BE_REQUIRED: "finish_must_be_required",
});

const DRAFT_KEYS = new Set([
  "draftId",
  "workflowType",
  "workflowCode",
  "title",
  "description",
  "scopeType",
  "requirementKind",
  "steps",
]);
const STEP_KEYS = new Set([
  "id",
  "type",
  "title",
  "description",
  "responsibilityClass",
  "required",
]);

const RESERVED_IDENTIFIERS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "local",
  "system",
]);
const RESERVED_IDENTIFIER_PREFIXES = Object.freeze([
  "memory-node-",
  "memory-edge-",
]);

class PersonnelLifecycleEditorContractError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "PersonnelLifecycleEditorContractError";
    this.code = code;
  }
}

function contractError(code, message) {
  return new PersonnelLifecycleEditorContractError(code, message);
}

function assertExactRecord(value, keys, label) {
  if (utilTypes.isProxy(value)
    || !value
    || typeof value !== "object"
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw contractError("O8_RECORD_INVALID", `${label} must be a plain record.`);
  }
  const actualKeys = Reflect.ownKeys(value);
  for (const key of actualKeys) {
    const descriptor = typeof key === "string"
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    if (typeof key !== "string"
      || !keys.has(key)
      || !descriptor
      || !("value" in descriptor)
      || descriptor.enumerable !== true) {
      throw contractError(
        "O8_FIELDS_INVALID",
        `${label} contains an unknown or dynamic field.`,
      );
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw contractError("O8_FIELDS_INVALID", `${label} is missing ${key}.`);
    }
  }
}

function plainArrayValues(value, label, maximumLength) {
  if (utilTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximumLength) {
    throw contractError("O8_ARRAY_INVALID", `${label} must be a bounded plain array.`);
  }
  const expectedKeys = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string"
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    if (typeof key !== "string"
      || !expectedKeys.has(key)
      || !descriptor
      || !("value" in descriptor)
      || (key !== "length" && descriptor.enumerable !== true)) {
      throw contractError("O8_ARRAY_INVALID", `${label} must contain plain values.`);
    }
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw contractError("O8_ARRAY_INVALID", `${label} must not contain gaps.`);
    }
    return descriptor.value;
  });
}

function normalizedText(value, label, { maximumLength, allowEmpty = true } = {}) {
  if (typeof value !== "string") {
    throw contractError("O8_VALUE_INVALID", `${label} must be a string.`);
  }
  const normalized = value.normalize("NFC").trim();
  if (normalized.length > maximumLength
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
    || (!allowEmpty && normalized === "")) {
    throw contractError("O8_VALUE_INVALID", `${label} is outside the allowed text boundary.`);
  }
  return normalized;
}

function normalizedIdentifier(
  value,
  label,
  { maximumLength, allowEmpty = true, workflowCode = false } = {},
) {
  const normalized = normalizedText(value, label, { maximumLength, allowEmpty });
  if (normalized === "") return normalized;
  const lower = normalized.toLowerCase();
  if (RESERVED_IDENTIFIERS.has(lower)
    || RESERVED_IDENTIFIER_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    throw contractError("O8_RESERVED_IDENTIFIER", `${label} is reserved.`);
  }
  const pattern = workflowCode
    ? /^[a-z][a-z0-9._-]{1,79}$/
    : /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
  if (!pattern.test(normalized)) {
    throw contractError("O8_IDENTIFIER_INVALID", `${label} is not an opaque identifier.`);
  }
  return normalized;
}

function normalizedEnum(value, label, allowed, code, { allowEmpty = false } = {}) {
  const normalized = normalizedText(value, label, {
    maximumLength: 64,
    allowEmpty,
  });
  if (allowEmpty && normalized === "") return normalized;
  if (!allowed.includes(normalized)) {
    throw contractError(code, `${label} is not supported.`);
  }
  return normalized;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function fingerprintDraft(draft) {
  return crypto.createHash("sha256")
    .update(canonicalJson({
      contractVersion: PERSONNEL_LIFECYCLE_EDITOR_CONTRACT_VERSION,
      model: PERSONNEL_LIFECYCLE_EDITOR_MODEL,
      draft,
    }), "utf8")
    .digest("hex");
}

function addBlocker(blockers, code, path, message) {
  const key = `${code}\0${path}`;
  if (blockers.some((blocker) => `${blocker.code}\0${blocker.path}` === key)) return;
  blockers.push({ code, path, message });
}

function normalizeStep(value, index, workflowType, blockers, usedIds) {
  const label = `Draft step ${index + 1}`;
  assertExactRecord(value, STEP_KEYS, label);
  const path = `steps[${index}]`;
  const id = normalizedIdentifier(value.id, `${label}.id`, {
    maximumLength: LIMITS.stepIdMaximumLength,
  });
  if (id === "") {
    addBlocker(
      blockers,
      BLOCKER_CODES.STEP_ID_MISSING,
      `${path}.id`,
      "Der Schritt benötigt vor einer fachlichen Freigabe eine technische Kennung.",
    );
  } else if (usedIds.has(id)) {
    throw contractError("O8_STEPS_INVALID", "Draft steps must use unique identifiers.");
  } else {
    usedIds.add(id);
  }

  const type = normalizedEnum(
    value.type,
    `${label}.type`,
    STEP_TYPES,
    "O8_STEP_TYPE_INVALID",
    { allowEmpty: true },
  );
  if (type === "") {
    addBlocker(
      blockers,
      BLOCKER_CODES.STEP_TYPE_MISSING,
      `${path}.type`,
      "Der Schritttyp ist noch nicht festgelegt.",
    );
  }

  const title = normalizedText(value.title, `${label}.title`, {
    maximumLength: LIMITS.stepTitleMaximumLength,
  });
  if (title === "") {
    addBlocker(
      blockers,
      BLOCKER_CODES.STEP_TITLE_MISSING,
      `${path}.title`,
      "Der Schritt benötigt einen fachlichen Titel.",
    );
  }
  const description = normalizedText(value.description, `${label}.description`, {
    maximumLength: LIMITS.stepDescriptionMaximumLength,
  });

  const allowedResponsibilities = RESPONSIBILITY_CLASSES_BY_WORKFLOW_TYPE[workflowType];
  const responsibilityClass = normalizedEnum(
    value.responsibilityClass,
    `${label}.responsibilityClass`,
    allowedResponsibilities,
    "O8_RESPONSIBILITY_CLASS_INVALID",
    { allowEmpty: true },
  );
  if (responsibilityClass === "") {
    addBlocker(
      blockers,
      BLOCKER_CODES.RESPONSIBILITY_CLASS_MISSING,
      `${path}.responsibilityClass`,
      "Der Schritt benötigt eine zulässige Verantwortungsgruppe.",
    );
  }
  if (typeof value.required !== "boolean") {
    throw contractError("O8_VALUE_INVALID", `${label}.required must be a boolean.`);
  }
  if (type === "finish" && value.required !== true) {
    addBlocker(
      blockers,
      BLOCKER_CODES.FINISH_MUST_BE_REQUIRED,
      `${path}.required`,
      "Der lineare Abschlussschritt muss verpflichtend sein.",
    );
  }
  return {
    id,
    type,
    title,
    description,
    responsibilityClass,
    required: value.required,
  };
}

function normalizedDraft(input) {
  assertExactRecord(input, DRAFT_KEYS, "O8 editor draft");
  const blockers = [];
  const draftId = normalizedIdentifier(input.draftId, "draftId", {
    maximumLength: LIMITS.draftIdMaximumLength,
  });
  if (draftId === "") {
    addBlocker(
      blockers,
      BLOCKER_CODES.DRAFT_ID_MISSING,
      "draftId",
      "Der flüchtige Arbeitsentwurf benötigt eine technische Kennung.",
    );
  }
  const workflowType = normalizedEnum(
    input.workflowType,
    "workflowType",
    WORKFLOW_TYPES,
    "O8_WORKFLOW_TYPE_INVALID",
  );
  const workflowCode = normalizedIdentifier(input.workflowCode, "workflowCode", {
    maximumLength: LIMITS.workflowCodeMaximumLength,
    workflowCode: true,
  });
  if (workflowCode === "") {
    addBlocker(
      blockers,
      BLOCKER_CODES.WORKFLOW_CODE_MISSING,
      "workflowCode",
      "Der Arbeitsentwurf benötigt einen stabilen Workflow-Code.",
    );
  }
  const title = normalizedText(input.title, "title", {
    maximumLength: LIMITS.titleMaximumLength,
  });
  if (title === "") {
    addBlocker(
      blockers,
      BLOCKER_CODES.TITLE_MISSING,
      "title",
      "Der Arbeitsentwurf benötigt einen fachlichen Titel.",
    );
  }
  const description = normalizedText(input.description, "description", {
    maximumLength: LIMITS.descriptionMaximumLength,
  });
  const scopeType = normalizedEnum(
    input.scopeType,
    "scopeType",
    SCOPE_TYPES,
    "O8_SCOPE_TYPE_INVALID",
  );
  const requirementKind = normalizedEnum(
    input.requirementKind,
    "requirementKind",
    REQUIREMENT_KINDS,
    "O8_REQUIREMENT_KIND_INVALID",
  );
  if (requirementKind === "mandatory" && scopeType !== "company") {
    addBlocker(
      blockers,
      BLOCKER_CODES.MANDATORY_SCOPE_REQUIRES_COMPANY,
      "scopeType",
      "Ein Pflichtablauf muss unternehmensweit gelten.",
    );
  }

  const rawSteps = plainArrayValues(input.steps, "steps", LIMITS.maximumSteps);
  if (rawSteps.length < LIMITS.minimumSteps) {
    addBlocker(
      blockers,
      BLOCKER_CODES.STEP_COUNT_BELOW_MINIMUM,
      "steps",
      `Der lineare Arbeitsentwurf benötigt mindestens ${LIMITS.minimumSteps} Schritte.`,
    );
  }
  const usedIds = new Set();
  const steps = rawSteps.map((step, index) => (
    normalizeStep(step, index, workflowType, blockers, usedIds)
  ));

  const finishIndexes = steps
    .map((step, index) => (step.type === "finish" ? index : -1))
    .filter((index) => index >= 0);
  if (finishIndexes.length === 0) {
    addBlocker(
      blockers,
      BLOCKER_CODES.FINISH_MISSING,
      "steps",
      "Der lineare Arbeitsentwurf benötigt genau einen Abschlussschritt.",
    );
  } else if (finishIndexes.length > 1) {
    addBlocker(
      blockers,
      BLOCKER_CODES.FINISH_MULTIPLE,
      "steps",
      "Der lineare Arbeitsentwurf darf nur einen Abschlussschritt enthalten.",
    );
  }
  if (finishIndexes.length === 1 && finishIndexes[0] !== steps.length - 1) {
    addBlocker(
      blockers,
      BLOCKER_CODES.FINISH_NOT_LAST,
      `steps[${finishIndexes[0]}]`,
      "Der Abschlussschritt muss an der letzten Position stehen.",
    );
  }

  return {
    draft: {
      draftId,
      workflowType,
      workflowCode,
      title,
      description,
      scopeType,
      requirementKind,
      steps,
    },
    blockers,
  };
}

function buildNodes(steps) {
  return steps.map((step, index) => ({
    id: step.id || `memory-node-${index + 1}`,
    position: index + 1,
    type: step.type,
    title: step.title,
    description: step.description,
    responsibilityClass: step.responsibilityClass,
    required: step.required,
  }));
}

function buildEdges(nodes) {
  return nodes.slice(1).map((node, index) => ({
    id: `memory-edge-${index + 1}`,
    from: nodes[index].id,
    to: node.id,
    type: "sequence",
  }));
}

function validatePersonnelLifecycleEditorDraft(input) {
  const { draft, blockers } = normalizedDraft(input);
  const nodes = buildNodes(draft.steps);
  const edges = buildEdges(nodes);
  const valid = blockers.length === 0;
  return deepFreeze({
    contractVersion: PERSONNEL_LIFECYCLE_EDITOR_CONTRACT_VERSION,
    model: PERSONNEL_LIFECYCLE_EDITOR_MODEL,
    mode: PERSONNEL_LIFECYCLE_EDITOR_MODE,
    source: PERSONNEL_LIFECYCLE_EDITOR_SOURCE,
    status: valid ? "ready" : "blocked",
    valid,
    fingerprint: fingerprintDraft(draft),
    draft,
    nodes,
    edges,
    blockers,
    runtimeGates: { ...RUNTIME_GATES },
  });
}

function normalizeAllowedWorkflowTypes(value) {
  const values = plainArrayValues(value, "allowedWorkflowTypes", WORKFLOW_TYPES.length);
  const result = values.map((workflowType, index) => normalizedEnum(
    workflowType,
    `allowedWorkflowTypes[${index}]`,
    WORKFLOW_TYPES,
    "O8_WORKFLOW_TYPE_INVALID",
  ));
  if (new Set(result).size !== result.length) {
    throw contractError("O8_ARRAY_INVALID", "allowedWorkflowTypes must not contain duplicates.");
  }
  return result;
}

function personnelLifecycleEditorCatalog(allowedWorkflowTypes = []) {
  const workflowTypes = normalizeAllowedWorkflowTypes(allowedWorkflowTypes);
  const responsibilityClassesByWorkflowType = Object.fromEntries(
    workflowTypes.map((workflowType) => [
      workflowType,
      [...RESPONSIBILITY_CLASSES_BY_WORKFLOW_TYPE[workflowType]],
    ]),
  );
  return deepFreeze({
    contractVersion: PERSONNEL_LIFECYCLE_EDITOR_CONTRACT_VERSION,
    model: PERSONNEL_LIFECYCLE_EDITOR_MODEL,
    mode: PERSONNEL_LIFECYCLE_EDITOR_MODE,
    source: PERSONNEL_LIFECYCLE_EDITOR_SOURCE,
    workflowTypes: [...workflowTypes],
    enums: {
      workflowTypes: [...workflowTypes],
      stepTypes: [...STEP_TYPES],
      scopeTypes: [...SCOPE_TYPES],
      requirementKinds: [...REQUIREMENT_KINDS],
      responsibilityClassesByWorkflowType,
    },
    limits: { ...LIMITS },
    runtimeGates: { ...RUNTIME_GATES },
  });
}

function assertPersonnelLifecycleEditorContract() {
  if (new Set(PERMISSION_IDS).size !== PERMISSION_IDS.length) {
    throw new Error("O8 contains duplicate permissions.");
  }
  if (Object.keys(ROLE_GRANTS).length !== 0) {
    throw new Error("O8 must not grant editor permissions to roles.");
  }
  if (WORKFLOW_TYPES.some((workflowType) => (
    !Array.isArray(RESPONSIBILITY_CLASSES_BY_WORKFLOW_TYPE[workflowType])
    || RESPONSIBILITY_CLASSES_BY_WORKFLOW_TYPE[workflowType].length === 0
    || new Set(RESPONSIBILITY_CLASSES_BY_WORKFLOW_TYPE[workflowType]).size
      !== RESPONSIBILITY_CLASSES_BY_WORKFLOW_TYPE[workflowType].length
  ))) {
    throw new Error("O8 contains an invalid responsibility-class catalog.");
  }
  if (Object.values(RUNTIME_GATES).some(Boolean)) {
    throw new Error("O8 must not enable persistence or runtime effects.");
  }
  if (LIMITS.minimumSteps !== 2 || LIMITS.maximumSteps !== 30) {
    throw new Error("O8 must retain the approved linear step limits.");
  }
  return true;
}

assertPersonnelLifecycleEditorContract();

module.exports = {
  PERSONNEL_LIFECYCLE_EDITOR_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_EDITOR_MODEL,
  PERSONNEL_LIFECYCLE_EDITOR_MODE,
  PERSONNEL_LIFECYCLE_EDITOR_SOURCE,
  PERMISSIONS,
  PERMISSION_IDS,
  ROLE_GRANTS,
  RUNTIME_GATES,
  WORKFLOW_TYPES,
  STEP_TYPES,
  SCOPE_TYPES,
  REQUIREMENT_KINDS,
  RESPONSIBILITY_CLASSES_BY_WORKFLOW_TYPE,
  LIMITS,
  BLOCKER_CODES,
  PersonnelLifecycleEditorContractError,
  personnelLifecycleEditorCatalog,
  validatePersonnelLifecycleEditorDraft,
  assertPersonnelLifecycleEditorContract,
};

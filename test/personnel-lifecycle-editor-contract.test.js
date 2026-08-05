"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
} = require("../lib/personnel-lifecycle-editor-contract");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validDraft(workflowType = "onboarding") {
  const responsibilityClass = workflowType === "offboarding"
    ? "offboarding_confidential"
    : "hr_case";
  return {
    draftId: `draft-${workflowType}-1`,
    workflowType,
    workflowCode: `${workflowType}.standard`,
    title: workflowType === "offboarding" ? "Austritt vorbereiten" : "Eintritt vorbereiten",
    description: "Flüchtiger, strikt linearer Arbeitsentwurf.",
    scopeType: "company",
    requirementKind: "mandatory",
    steps: [
      {
        id: "prepare",
        type: "task",
        title: "Vorbereitung",
        description: "Den nächsten fachlichen Schritt vorbereiten.",
        responsibilityClass,
        required: true,
      },
      {
        id: "review",
        type: "approval",
        title: "Prüfung",
        description: "Den linearen Ablauf fachlich prüfen.",
        responsibilityClass,
        required: true,
      },
      {
        id: "finish",
        type: "finish",
        title: "Abschluss",
        description: "Den flüchtigen Entwurf abschließen.",
        responsibilityClass,
        required: true,
      },
    ],
  };
}

function assertCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof PersonnelLifecycleEditorContractError);
    assert.ok(error instanceof TypeError);
    assert.equal(error.code, code);
    return true;
  });
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function blockerCodes(result) {
  return new Set(result.blockers.map(({ code }) => code));
}

test("O8 exports the approved identity, permissions, enums, limits and closed runtime gates", () => {
  assert.equal(PERSONNEL_LIFECYCLE_EDITOR_CONTRACT_VERSION, "o8-v0.1");
  assert.equal(PERSONNEL_LIFECYCLE_EDITOR_MODEL, "linear-v1");
  assert.equal(PERSONNEL_LIFECYCLE_EDITOR_MODE, "memory_only");
  assert.equal(PERSONNEL_LIFECYCLE_EDITOR_SOURCE, "memory");
  assert.deepEqual(PERMISSIONS, {
    READ: "personnel:lifecycle:editor:read",
    DRAFT_WRITE: "personnel:lifecycle:editor:draft:write",
    VALIDATE: "personnel:lifecycle:editor:validate",
    REVIEW: "personnel:lifecycle:editor:review",
    PUBLISH: "personnel:lifecycle:editor:publish",
    ARCHIVE: "personnel:lifecycle:editor:archive",
  });
  assert.deepEqual(PERMISSION_IDS, Object.values(PERMISSIONS));
  assert.equal(new Set(PERMISSION_IDS).size, 6);
  assert.deepEqual(ROLE_GRANTS, {});
  assert.deepEqual(WORKFLOW_TYPES, ["onboarding", "offboarding"]);
  assert.deepEqual(STEP_TYPES, ["task", "approval", "finish"]);
  assert.deepEqual(SCOPE_TYPES, ["company", "location", "department"]);
  assert.deepEqual(REQUIREMENT_KINDS, ["mandatory", "optional"]);
  assert.deepEqual(LIMITS, {
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
  assert.deepEqual(RUNTIME_GATES, {
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
  assert.equal(Object.values(RUNTIME_GATES).some(Boolean), false);
  assert.equal(assertPersonnelLifecycleEditorContract(), true);
  for (const value of [
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
  ]) assertDeepFrozen(value);
});

test("catalog projects only workflow types explicitly supplied by the server", () => {
  const empty = personnelLifecycleEditorCatalog();
  assert.deepEqual(empty.workflowTypes, []);
  assert.deepEqual(empty.enums.workflowTypes, []);
  assert.deepEqual(empty.enums.responsibilityClassesByWorkflowType, {});

  const onboarding = personnelLifecycleEditorCatalog(["onboarding"]);
  assert.deepEqual(Object.keys(onboarding), [
    "contractVersion", "model", "mode", "source", "workflowTypes", "enums", "limits",
    "runtimeGates",
  ]);
  assert.equal(onboarding.contractVersion, "o8-v0.1");
  assert.equal(onboarding.model, "linear-v1");
  assert.equal(onboarding.mode, "memory_only");
  assert.equal(onboarding.source, "memory");
  assert.deepEqual(onboarding.workflowTypes, ["onboarding"]);
  assert.deepEqual(onboarding.enums, {
    workflowTypes: ["onboarding"],
    stepTypes: ["task", "approval", "finish"],
    scopeTypes: ["company", "location", "department"],
    requirementKinds: ["mandatory", "optional"],
    responsibilityClassesByWorkflowType: {
      onboarding: [...RESPONSIBILITY_CLASSES_BY_WORKFLOW_TYPE.onboarding],
    },
  });
  assert.deepEqual(onboarding.limits, LIMITS);
  assert.deepEqual(onboarding.runtimeGates, RUNTIME_GATES);
  assertDeepFrozen(onboarding);

  const reverse = personnelLifecycleEditorCatalog(["offboarding", "onboarding"]);
  assert.deepEqual(reverse.workflowTypes, ["offboarding", "onboarding"]);
  assert.deepEqual(Object.keys(reverse.enums.responsibilityClassesByWorkflowType), [
    "offboarding", "onboarding",
  ]);
});

test("catalog rejects untrusted, dynamic, sparse, duplicate and unknown allowlists", () => {
  assertCode(
    () => personnelLifecycleEditorCatalog(new Proxy(["onboarding"], {})),
    "O8_ARRAY_INVALID",
  );
  const sparse = new Array(1);
  assertCode(() => personnelLifecycleEditorCatalog(sparse), "O8_ARRAY_INVALID");
  const accessor = [];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() { return "onboarding"; },
  });
  accessor.length = 1;
  assertCode(() => personnelLifecycleEditorCatalog(accessor), "O8_ARRAY_INVALID");
  const symbol = ["onboarding"];
  symbol[Symbol("extra")] = true;
  assertCode(() => personnelLifecycleEditorCatalog(symbol), "O8_ARRAY_INVALID");
  class ForeignArray extends Array {}
  assertCode(
    () => personnelLifecycleEditorCatalog(new ForeignArray("onboarding")),
    "O8_ARRAY_INVALID",
  );
  assertCode(
    () => personnelLifecycleEditorCatalog(["onboarding", "onboarding"]),
    "O8_ARRAY_INVALID",
  );
  assertCode(
    () => personnelLifecycleEditorCatalog(["custom_personnel"]),
    "O8_WORKFLOW_TYPE_INVALID",
  );
});

test("valid onboarding draft yields only a frozen in-memory linear graph", () => {
  const input = validDraft();
  const result = validatePersonnelLifecycleEditorDraft(input);
  assert.deepEqual(Object.keys(result), [
    "contractVersion", "model", "mode", "source", "status", "valid", "fingerprint",
    "draft", "nodes", "edges", "blockers", "runtimeGates",
  ]);
  assert.equal(result.contractVersion, "o8-v0.1");
  assert.equal(result.model, "linear-v1");
  assert.equal(result.mode, "memory_only");
  assert.equal(result.source, "memory");
  assert.equal(result.status, "ready");
  assert.equal(result.valid, true);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.runtimeGates, RUNTIME_GATES);
  assert.deepEqual(result.draft, input);
  assert.deepEqual(result.nodes, input.steps.map((step, index) => ({
    id: step.id,
    position: index + 1,
    type: step.type,
    title: step.title,
    description: step.description,
    responsibilityClass: step.responsibilityClass,
    required: step.required,
  })));
  assert.deepEqual(result.edges, [
    { id: "memory-edge-1", from: "prepare", to: "review", type: "sequence" },
    { id: "memory-edge-2", from: "review", to: "finish", type: "sequence" },
  ]);
  assertDeepFrozen(result);
  assert.deepEqual(input, validDraft());
});

test("valid offboarding draft remains transient and uses only its hard allowlist", () => {
  const input = validDraft("offboarding");
  const result = validatePersonnelLifecycleEditorDraft(input);
  assert.equal(result.status, "ready");
  assert.equal(result.valid, true);
  assert.equal(result.draft.workflowType, "offboarding");
  assert.ok(RESPONSIBILITY_CLASSES_BY_WORKFLOW_TYPE.offboarding.includes(
    result.nodes[0].responsibilityClass,
  ));
  assert.equal(result.runtimeGates.persistence, false);
  assert.equal(result.runtimeGates.legacyBridge, false);
  assert.equal(result.runtimeGates.publication, false);
});

test("canonical fingerprint ignores property insertion order but changes with workflow content or step order", () => {
  const input = validDraft();
  const reorderedProperties = {
    steps: input.steps.map((step) => ({
      required: step.required,
      responsibilityClass: step.responsibilityClass,
      description: step.description,
      title: step.title,
      type: step.type,
      id: step.id,
    })),
    requirementKind: input.requirementKind,
    scopeType: input.scopeType,
    description: input.description,
    title: input.title,
    workflowCode: input.workflowCode,
    workflowType: input.workflowType,
    draftId: input.draftId,
  };
  const first = validatePersonnelLifecycleEditorDraft(input);
  const second = validatePersonnelLifecycleEditorDraft(reorderedProperties);
  assert.equal(first.fingerprint, second.fingerprint);

  const changed = clone(input);
  changed.steps[0].title = "Andere Vorbereitung";
  assert.notEqual(
    first.fingerprint,
    validatePersonnelLifecycleEditorDraft(changed).fingerprint,
  );
  const reorderedSteps = clone(input);
  [reorderedSteps.steps[0], reorderedSteps.steps[1]] = [
    reorderedSteps.steps[1],
    reorderedSteps.steps[0],
  ];
  assert.notEqual(
    first.fingerprint,
    validatePersonnelLifecycleEditorDraft(reorderedSteps).fingerprint,
  );
});

test("draft envelope rejects proxies, foreign prototypes, accessors, symbols and unknown or missing fields", () => {
  assertCode(
    () => validatePersonnelLifecycleEditorDraft(new Proxy(validDraft(), {})),
    "O8_RECORD_INVALID",
  );
  const foreign = Object.assign(Object.create({ inherited: true }), validDraft());
  assertCode(() => validatePersonnelLifecycleEditorDraft(foreign), "O8_RECORD_INVALID");

  const accessor = validDraft();
  delete accessor.title;
  Object.defineProperty(accessor, "title", {
    enumerable: true,
    get() { return "dynamic"; },
  });
  assertCode(() => validatePersonnelLifecycleEditorDraft(accessor), "O8_FIELDS_INVALID");

  const symbol = validDraft();
  symbol[Symbol("extra")] = true;
  assertCode(() => validatePersonnelLifecycleEditorDraft(symbol), "O8_FIELDS_INVALID");
  assertCode(
    () => validatePersonnelLifecycleEditorDraft({ ...validDraft(), layout: {} }),
    "O8_FIELDS_INVALID",
  );
  const missing = validDraft();
  delete missing.description;
  assertCode(() => validatePersonnelLifecycleEditorDraft(missing), "O8_FIELDS_INVALID");
});

test("step envelope and array reject proxies, accessors, symbols, gaps and client graph or effect fields", () => {
  const proxiedStep = validDraft();
  proxiedStep.steps[0] = new Proxy(proxiedStep.steps[0], {});
  assertCode(() => validatePersonnelLifecycleEditorDraft(proxiedStep), "O8_RECORD_INVALID");

  const accessorStep = validDraft();
  delete accessorStep.steps[0].title;
  Object.defineProperty(accessorStep.steps[0], "title", {
    enumerable: true,
    get() { return "dynamic"; },
  });
  assertCode(() => validatePersonnelLifecycleEditorDraft(accessorStep), "O8_FIELDS_INVALID");

  const symbolStep = validDraft();
  symbolStep.steps[0][Symbol("extra")] = true;
  assertCode(() => validatePersonnelLifecycleEditorDraft(symbolStep), "O8_FIELDS_INVALID");

  const sparse = validDraft();
  sparse.steps = new Array(2);
  sparse.steps[1] = validDraft().steps[2];
  assertCode(() => validatePersonnelLifecycleEditorDraft(sparse), "O8_ARRAY_INVALID");

  for (const field of ["edges", "layout", "trigger", "notificationChannels", "condition"]) {
    const draft = validDraft();
    draft.steps[0][field] = field === "edges" ? [] : {};
    assertCode(() => validatePersonnelLifecycleEditorDraft(draft), "O8_FIELDS_INVALID");
  }
});

test("identifiers are opaque, unique and cannot use reserved server graph identifiers", () => {
  for (const [field, value] of [
    ["draftId", "__proto__"],
    ["draftId", "memory-node-5"],
    ["draftId", "local"],
  ]) {
    const draft = validDraft();
    draft[field] = value;
    assertCode(() => validatePersonnelLifecycleEditorDraft(draft), "O8_RESERVED_IDENTIFIER");
  }
  const reservedStep = validDraft();
  reservedStep.steps[0].id = "memory-edge-client";
  assertCode(
    () => validatePersonnelLifecycleEditorDraft(reservedStep),
    "O8_RESERVED_IDENTIFIER",
  );
  const invalidCode = validDraft();
  invalidCode.workflowCode = "Onboarding Standard";
  assertCode(
    () => validatePersonnelLifecycleEditorDraft(invalidCode),
    "O8_IDENTIFIER_INVALID",
  );
  const invalidStep = validDraft();
  invalidStep.steps[0].id = "step/person";
  assertCode(
    () => validatePersonnelLifecycleEditorDraft(invalidStep),
    "O8_IDENTIFIER_INVALID",
  );
  const duplicate = validDraft();
  duplicate.steps[1].id = duplicate.steps[0].id;
  assertCode(() => validatePersonnelLifecycleEditorDraft(duplicate), "O8_STEPS_INVALID");
});

test("workflow, scope, requirement and step enums are fail-closed", () => {
  const cases = [
    ["workflowType", "custom_personnel", "O8_WORKFLOW_TYPE_INVALID"],
    ["scopeType", "global", "O8_SCOPE_TYPE_INVALID"],
    ["requirementKind", "supplemental", "O8_REQUIREMENT_KIND_INVALID"],
  ];
  for (const [field, value, code] of cases) {
    const draft = validDraft();
    draft[field] = value;
    assertCode(() => validatePersonnelLifecycleEditorDraft(draft), code);
  }
  const invalidStepType = validDraft();
  invalidStepType.steps[0].type = "decision";
  assertCode(
    () => validatePersonnelLifecycleEditorDraft(invalidStepType),
    "O8_STEP_TYPE_INVALID",
  );
  const invalidRequired = validDraft();
  invalidRequired.steps[0].required = 1;
  assertCode(() => validatePersonnelLifecycleEditorDraft(invalidRequired), "O8_VALUE_INVALID");
});

test("responsibility classes are type-specific and never accept personal identifiers", () => {
  const onboarding = validDraft("onboarding");
  onboarding.steps[0].responsibilityClass = "offboarding_confidential";
  assertCode(
    () => validatePersonnelLifecycleEditorDraft(onboarding),
    "O8_RESPONSIBILITY_CLASS_INVALID",
  );
  const offboarding = validDraft("offboarding");
  offboarding.steps[0].responsibilityClass = "trainer";
  assertCode(
    () => validatePersonnelLifecycleEditorDraft(offboarding),
    "O8_RESPONSIBILITY_CLASS_INVALID",
  );
  const person = validDraft();
  person.steps[0].responsibilityClass = "EMP-0001";
  assertCode(
    () => validatePersonnelLifecycleEditorDraft(person),
    "O8_RESPONSIBILITY_CLASS_INVALID",
  );
});

test("safe semantic incompleteness produces structured blockers and derived temporary node ids", () => {
  const draft = validDraft();
  draft.draftId = "";
  draft.workflowCode = "";
  draft.title = "";
  draft.steps[0].id = "";
  draft.steps[0].type = "";
  draft.steps[0].title = "";
  draft.steps[0].responsibilityClass = "";
  const result = validatePersonnelLifecycleEditorDraft(draft);
  const codes = blockerCodes(result);
  assert.equal(result.status, "blocked");
  assert.equal(result.valid, false);
  for (const code of [
    BLOCKER_CODES.DRAFT_ID_MISSING,
    BLOCKER_CODES.WORKFLOW_CODE_MISSING,
    BLOCKER_CODES.TITLE_MISSING,
    BLOCKER_CODES.STEP_ID_MISSING,
    BLOCKER_CODES.STEP_TYPE_MISSING,
    BLOCKER_CODES.STEP_TITLE_MISSING,
    BLOCKER_CODES.RESPONSIBILITY_CLASS_MISSING,
  ]) assert.ok(codes.has(code), code);
  assert.equal(result.nodes[0].id, "memory-node-1");
  assert.equal(result.edges[0].from, "memory-node-1");
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assertDeepFrozen(result);
});

test("step count and finish invariants are semantic blockers without any runtime effect", () => {
  const empty = validDraft();
  empty.steps = [];
  const emptyResult = validatePersonnelLifecycleEditorDraft(empty);
  assert.deepEqual(blockerCodes(emptyResult), new Set([
    BLOCKER_CODES.STEP_COUNT_BELOW_MINIMUM,
    BLOCKER_CODES.FINISH_MISSING,
  ]));
  assert.deepEqual(emptyResult.nodes, []);
  assert.deepEqual(emptyResult.edges, []);

  const noFinish = validDraft();
  noFinish.steps[2].type = "task";
  assert.ok(blockerCodes(validatePersonnelLifecycleEditorDraft(noFinish))
    .has(BLOCKER_CODES.FINISH_MISSING));

  const multiple = validDraft();
  multiple.steps[1].type = "finish";
  assert.ok(blockerCodes(validatePersonnelLifecycleEditorDraft(multiple))
    .has(BLOCKER_CODES.FINISH_MULTIPLE));

  const notLast = validDraft();
  notLast.steps[1].type = "finish";
  notLast.steps[2].type = "task";
  assert.ok(blockerCodes(validatePersonnelLifecycleEditorDraft(notLast))
    .has(BLOCKER_CODES.FINISH_NOT_LAST));

  const optionalFinish = validDraft();
  optionalFinish.steps[2].required = false;
  assert.ok(blockerCodes(validatePersonnelLifecycleEditorDraft(optionalFinish))
    .has(BLOCKER_CODES.FINISH_MUST_BE_REQUIRED));

  const tooMany = validDraft();
  tooMany.steps = Array.from({ length: LIMITS.maximumSteps + 1 }, (_, index) => ({
    ...validDraft().steps[0],
    id: `step-${index + 1}`,
  }));
  assertCode(() => validatePersonnelLifecycleEditorDraft(tooMany), "O8_ARRAY_INVALID");
});

test("mandatory local scope is blocked while optional local drafts remain valid", () => {
  const mandatory = validDraft();
  mandatory.scopeType = "location";
  assert.ok(blockerCodes(validatePersonnelLifecycleEditorDraft(mandatory))
    .has(BLOCKER_CODES.MANDATORY_SCOPE_REQUIRES_COMPANY));

  const optional = validDraft();
  optional.scopeType = "department";
  optional.requirementKind = "optional";
  assert.equal(validatePersonnelLifecycleEditorDraft(optional).status, "ready");
});

test("normalization is deterministic, bounded and never mutates caller data", () => {
  const input = validDraft();
  input.title = "  Eintritt vorbereiten  ";
  input.description = "  Zeile eins\nZeile zwei  ";
  input.steps[0].title = "  Vorbereitung  ";
  const before = clone(input);
  const result = validatePersonnelLifecycleEditorDraft(input);
  assert.equal(result.draft.title, "Eintritt vorbereiten");
  assert.equal(result.draft.description, "Zeile eins\nZeile zwei");
  assert.equal(result.draft.steps[0].title, "Vorbereitung");
  assert.deepEqual(input, before);

  const long = validDraft();
  long.description = "x".repeat(LIMITS.descriptionMaximumLength + 1);
  assertCode(() => validatePersonnelLifecycleEditorDraft(long), "O8_VALUE_INVALID");
  const control = validDraft();
  control.steps[0].description = "nicht\0zulaessig";
  assertCode(() => validatePersonnelLifecycleEditorDraft(control), "O8_VALUE_INVALID");
});

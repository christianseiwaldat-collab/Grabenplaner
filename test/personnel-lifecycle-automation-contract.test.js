"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS: B,
  PERSONNEL_LIFECYCLE_AUTOMATION_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_AUTOMATION_DEFAULT_POLICY_REGISTRY,
  PERSONNEL_LIFECYCLE_AUTOMATION_DOMAINS,
  PERSONNEL_LIFECYCLE_AUTOMATION_DOMAIN_IDS,
  PERSONNEL_LIFECYCLE_AUTOMATION_MODES,
  PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS,
  PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSIONS: P,
  PERSONNEL_LIFECYCLE_AUTOMATION_READ_PERMISSIONS,
  PERSONNEL_LIFECYCLE_AUTOMATION_ROLE_GRANTS,
  PERSONNEL_LIFECYCLE_AUTOMATION_RUNTIME_GATES,
  createPersonnelLifecycleAutomationPolicy,
  personnelLifecycleAutomationCatalog,
  previewPersonnelLifecycleAutomation,
} = require("../lib/personnel-lifecycle-automation-contract");

const GLOBAL_SCOPE = Object.freeze({ type: "global", id: null });

function policyInput(overrides = {}) {
  return {
    policyId: "onboarding-step-a-deadline",
    revision: 1,
    active: true,
    source: "onboarding",
    processVersionId: "onboarding-v1",
    stepId: "step-a",
    referenceKind: "task_activated_at",
    scope: GLOBAL_SCOPE,
    timezone: "Europe/Vienna",
    dayMode: "calendar_days",
    workingDays: [],
    holidayDates: [],
    referenceAdjustment: "none",
    dueOffsetDays: 0,
    dueSoonDays: 3,
    reminderOffsetsDays: [3, 1, 0],
    escalationAfterDays: 2,
    representationMode: "manual_hr_clarification",
    notificationChannels: [],
    ...overrides,
  };
}

function policy(overrides = {}) {
  return createPersonnelLifecycleAutomationPolicy(policyInput(overrides));
}

function projectedTask(boundPolicy, overrides = {}) {
  return {
    source: boundPolicy.source,
    runId: "run-a",
    processVersionId: boundPolicy.processVersionId,
    stepId: boundPolicy.stepId,
    title: "Unterlagen pruefen",
    status: "active",
    scope: boundPolicy.scope,
    referenceKind: boundPolicy.referenceKind,
    referenceDate: "2026-08-10",
    responsibilityState: "assigned",
    policyBinding: {
      policyId: boundPolicy.policyId,
      revision: boundPolicy.revision,
      fingerprint: boundPolicy.fingerprint,
    },
    ...overrides,
  };
}

function preview(boundPolicy, task, asOf = "2026-08-07T10:00:00.000Z") {
  return previewPersonnelLifecycleAutomation({
    asOf,
    policyRegistry: [boundPolicy],
    tasks: [task],
  });
}

function assertCode(callback, expectedCode) {
  assert.throws(callback, (error) => {
    assert.equal(error && error.code, expectedCode);
    return true;
  });
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("O7-Vertrag definiert vier Domaenen, 16 eindeutige Rechte und keine Rollengrants", () => {
  assert.equal(PERSONNEL_LIFECYCLE_AUTOMATION_CONTRACT_VERSION, "o7-v0.1");
  assert.deepEqual(PERSONNEL_LIFECYCLE_AUTOMATION_DOMAINS, {
    DEADLINES: "deadlines",
    SUBSTITUTIONS: "substitutions",
    REMINDERS: "reminders",
    ESCALATIONS: "escalations",
  });
  assert.deepEqual(PERSONNEL_LIFECYCLE_AUTOMATION_DOMAIN_IDS, [
    "deadlines",
    "substitutions",
    "reminders",
    "escalations",
  ]);
  assert.deepEqual(P, {
    DEADLINES_READ: "personnel:lifecycle:automation:deadlines:read",
    DEADLINES_MANAGE: "personnel:lifecycle:automation:deadlines:manage",
    DEADLINES_RECALCULATE: "personnel:lifecycle:automation:deadlines:recalculate",
    DEADLINES_RECONCILE: "personnel:lifecycle:automation:deadlines:reconcile",
    SUBSTITUTIONS_READ: "personnel:lifecycle:automation:substitutions:read",
    SUBSTITUTIONS_MANAGE: "personnel:lifecycle:automation:substitutions:manage",
    SUBSTITUTIONS_APPLY: "personnel:lifecycle:automation:substitutions:apply",
    SUBSTITUTIONS_RECONCILE: "personnel:lifecycle:automation:substitutions:reconcile",
    REMINDERS_READ: "personnel:lifecycle:automation:reminders:read",
    REMINDERS_MANAGE: "personnel:lifecycle:automation:reminders:manage",
    REMINDERS_DISPATCH: "personnel:lifecycle:automation:reminders:dispatch",
    REMINDERS_RECONCILE: "personnel:lifecycle:automation:reminders:reconcile",
    ESCALATIONS_READ: "personnel:lifecycle:automation:escalations:read",
    ESCALATIONS_MANAGE: "personnel:lifecycle:automation:escalations:manage",
    ESCALATIONS_TRIGGER: "personnel:lifecycle:automation:escalations:trigger",
    ESCALATIONS_RECONCILE: "personnel:lifecycle:automation:escalations:reconcile",
  });
  assert.equal(PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS.length, 16);
  assert.equal(new Set(PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS).size, 16);
  assert.deepEqual(PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS, Object.values(P));
  assert.deepEqual(PERSONNEL_LIFECYCLE_AUTOMATION_READ_PERMISSIONS, {
    deadlines: P.DEADLINES_READ,
    substitutions: P.SUBSTITUTIONS_READ,
    reminders: P.REMINDERS_READ,
    escalations: P.ESCALATIONS_READ,
  });
  assert.deepEqual(PERSONNEL_LIFECYCLE_AUTOMATION_ROLE_GRANTS, {});
  assert.deepEqual(PERSONNEL_LIFECYCLE_AUTOMATION_DEFAULT_POLICY_REGISTRY, []);
  assertDeepFrozen(PERSONNEL_LIFECYCLE_AUTOMATION_DOMAINS);
  assertDeepFrozen(PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS);
  assertDeepFrozen(PERSONNEL_LIFECYCLE_AUTOMATION_READ_PERMISSIONS);
  assertDeepFrozen(PERSONNEL_LIFECYCLE_AUTOMATION_ROLE_GRANTS);
});

test("alle zwoelf O7-Laufzeit-Gates bleiben fail-closed", () => {
  assert.deepEqual(PERSONNEL_LIFECYCLE_AUTOMATION_RUNTIME_GATES, {
    policyPersistence: false,
    deadlinePersistence: false,
    referenceDateMutation: false,
    assignmentMutation: false,
    scheduler: false,
    internalNotification: false,
    externalNotification: false,
    calendarMutation: false,
    automaticSubstitution: false,
    automaticEscalation: false,
    outboxDispatch: false,
    externalMutation: false,
  });
  assert.equal(Object.keys(PERSONNEL_LIFECYCLE_AUTOMATION_RUNTIME_GATES).length, 12);
  assert.equal(Object.values(PERSONNEL_LIFECYCLE_AUTOMATION_RUNTIME_GATES)
    .every((enabled) => enabled === false), true);
  assert.deepEqual(PERSONNEL_LIFECYCLE_AUTOMATION_MODES, {
    deadlineCalculation: "explicit_versioned_policy_only",
    representation: "manual_hr_clarification",
    reminders: "preview_only",
    escalations: "preview_only",
  });
  assertDeepFrozen(PERSONNEL_LIFECYCLE_AUTOMATION_RUNTIME_GATES);
  assertDeepFrozen(PERSONNEL_LIFECYCLE_AUTOMATION_MODES);
});

test("Katalog zeigt sechs leere Register und filtert Domaenen in angeforderter Reihenfolge", () => {
  const catalog = personnelLifecycleAutomationCatalog();
  const expectedEmptyRegistry = {
    recordCount: 0,
    activeRecordCount: 0,
    customerConfigured: false,
  };

  assert.equal(catalog.contractVersion, "o7-v0.1");
  assert.deepEqual(Object.keys(catalog.registries), [
    "deadlinePolicies",
    "calendarRules",
    "substitutionRules",
    "reminderRules",
    "escalationRules",
    "notificationChannels",
  ]);
  for (const registry of Object.values(catalog.registries)) {
    assert.deepEqual(registry, expectedEmptyRegistry);
  }
  assert.deepEqual(catalog.domains.map(({ id }) => id), [
    "deadlines",
    "substitutions",
    "reminders",
    "escalations",
  ]);
  for (const domain of catalog.domains) {
    assert.equal(domain.status, "blocked");
    assert.equal(domain.configurationCount, 0);
    assert.equal(domain.externalEffectsEnabled, false);
    assert.ok(domain.blockerCodes.includes(B.POLICY_REGISTRY_EMPTY));
    assert.ok(domain.blockerCodes.includes(B.EFFECTS_ACTIVATION_NOT_APPROVED));
  }
  assert.ok(catalog.blockerCodes.includes(B.CALENDAR_RULE_MISSING));
  assert.ok(catalog.blockerCodes.includes(B.NOTIFICATION_CHANNEL_NOT_APPROVED));
  assert.deepEqual(catalog.runtimeGates, PERSONNEL_LIFECYCLE_AUTOMATION_RUNTIME_GATES);
  assertDeepFrozen(catalog);

  const filtered = personnelLifecycleAutomationCatalog(["escalations", "deadlines"]);
  assert.deepEqual(filtered.domains.map(({ id }) => id), ["escalations", "deadlines"]);
  assert.deepEqual(Object.keys(filtered.registries), Object.keys(catalog.registries));
});

test("Katalogfilter verwirft unbekannte, doppelte und dynamische Eingaben", () => {
  assertCode(() => personnelLifecycleAutomationCatalog(["deadlines", "deadlines"]),
    "O7_DOMAIN_INVALID");
  assertCode(() => personnelLifecycleAutomationCatalog(["sales"]), "O7_DOMAIN_INVALID");
  assertCode(() => personnelLifecycleAutomationCatalog(new Proxy(["deadlines"], {})),
    "O7_VALUE_INVALID");

  const withUnknownField = ["deadlines"];
  withUnknownField.extra = true;
  assertCode(() => personnelLifecycleAutomationCatalog(withUnknownField), "O7_VALUE_INVALID");

  let reads = 0;
  const accessorArray = [];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      reads += 1;
      return "deadlines";
    },
  });
  assertCode(() => personnelLifecycleAutomationCatalog(accessorArray), "O7_VALUE_INVALID");
  assert.equal(reads, 0);
});

test("versionierte Richtlinien erhalten einen deterministischen Fingerprint", () => {
  const first = policy({
    dayMode: "working_days",
    workingDays: [5, 1, 3, 2, 4],
    holidayDates: ["2026-08-18", "2026-08-17"],
    referenceAdjustment: "next_working_day",
    reminderOffsetsDays: [3, 0, 1],
  });
  const reordered = policy({
    dayMode: "working_days",
    workingDays: [1, 2, 3, 4, 5],
    holidayDates: ["2026-08-17", "2026-08-18"],
    referenceAdjustment: "next_working_day",
    reminderOffsetsDays: [0, 1, 3],
  });
  const revised = policy({
    revision: 2,
    dayMode: "working_days",
    workingDays: [1, 2, 3, 4, 5],
    holidayDates: ["2026-08-17", "2026-08-18"],
    referenceAdjustment: "next_working_day",
    reminderOffsetsDays: [0, 1, 3],
  });

  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.fingerprint, reordered.fingerprint);
  assert.notEqual(first.fingerprint, revised.fingerprint);
  assert.deepEqual(first.workingDays, [1, 2, 3, 4, 5]);
  assert.deepEqual(first.holidayDates, ["2026-08-17", "2026-08-18"]);
  assert.deepEqual(first.reminderOffsetsDays, [0, 1, 3]);
  assertDeepFrozen(first);
});

test("Richtlinien binden jede erlaubte Referenzart an eine explizite Prozessversion", () => {
  const sourceReferencePairs = [
    ["onboarding", "task_activated_at"],
    ["onboarding", "contractual_entry_date"],
    ["onboarding", "first_working_day"],
    ["onboarding", "onboarding_target_date"],
    ["onboarding", "explicit_task_due_date"],
    ["offboarding", "task_activated_at"],
    ["offboarding", "planned_exit_date"],
    ["offboarding", "last_working_day"],
    ["offboarding", "legal_exit_date"],
    ["offboarding", "access_block_at"],
    ["offboarding", "explicit_task_due_date"],
  ];
  for (const [index, [source, referenceKind]] of sourceReferencePairs.entries()) {
    const configured = policy({
      policyId: `reference-${index}`,
      processVersionId: `process-v${index + 1}`,
      source,
      referenceKind,
    });
    assert.equal(configured.processVersionId, `process-v${index + 1}`);
    assert.equal(configured.source, source);
    assert.equal(configured.referenceKind, referenceKind);
  }

  assertCode(() => policy({ referenceKind: "free_text_date" }), "O7_REFERENCE_INVALID");
  assertCode(() => policy({ source: "onboarding", referenceKind: "planned_exit_date" }),
    "O7_REFERENCE_INVALID");
  assertCode(() => policy({ source: "offboarding", referenceKind: "contractual_entry_date" }),
    "O7_REFERENCE_INVALID");
  assertCode(() => policy({
    referenceKind: "explicit_task_due_date",
    dueOffsetDays: 1,
  }), "O7_REFERENCE_INVALID");
  assertCode(() => policy({
    referenceKind: "explicit_task_due_date",
    dayMode: "working_days",
    workingDays: [1, 2, 3, 4, 5],
    referenceAdjustment: "next_working_day",
  }), "O7_REFERENCE_INVALID");
  assertCode(() => policy({ processVersionId: "ungueltige version" }), "O7_VALUE_INVALID");
  assert.notEqual(
    policy().fingerprint,
    policy({ processVersionId: "onboarding-v2" }).fingerprint,
  );
  assert.notEqual(
    policy().fingerprint,
    policy({ referenceKind: "contractual_entry_date" }).fingerprint,
  );
});

test("Richtlinien verwerfen Proxy, Accessor, unbekannte Felder und doppelte Listenwerte", () => {
  assertCode(() => createPersonnelLifecycleAutomationPolicy(new Proxy(policyInput(), {})),
    "O7_RECORD_INVALID");
  assertCode(() => createPersonnelLifecycleAutomationPolicy(policyInput({
    scope: new Proxy({ type: "global", id: null }, {}),
  })), "O7_RECORD_INVALID");

  let reads = 0;
  const accessorPolicy = policyInput();
  delete accessorPolicy.policyId;
  Object.defineProperty(accessorPolicy, "policyId", {
    enumerable: true,
    get() {
      reads += 1;
      return "dynamic-policy";
    },
  });
  assertCode(() => createPersonnelLifecycleAutomationPolicy(accessorPolicy), "O7_FIELDS_INVALID");
  assert.equal(reads, 0);

  assertCode(() => createPersonnelLifecycleAutomationPolicy({
    ...policyInput(),
    unexpected: true,
  }), "O7_FIELDS_INVALID");
  const symbolPolicy = policyInput();
  symbolPolicy[Symbol("unexpected")] = true;
  assertCode(() => createPersonnelLifecycleAutomationPolicy(symbolPolicy), "O7_FIELDS_INVALID");

  for (const duplicate of [
    { dayMode: "working_days", workingDays: [1, 1], referenceAdjustment: "none" },
    { dayMode: "working_days", workingDays: [1], holidayDates: ["2026-08-17", "2026-08-17"] },
    { reminderOffsetsDays: [1, 1] },
  ]) {
    assertCode(() => policy(duplicate), "O7_VALUE_INVALID");
  }
});

test("Registry, Tasks und Bindings verwerfen unbekannte, dynamische und doppelte Datensaetze", () => {
  const p = policy();
  const task = projectedTask(p);

  assertCode(() => previewPersonnelLifecycleAutomation({
    asOf: "2026-08-07T10:00:00.000Z",
    policyRegistry: [p, p],
    tasks: [],
  }), "O7_REGISTRY_INVALID");
  assertCode(() => previewPersonnelLifecycleAutomation({
    asOf: "2026-08-07T10:00:00.000Z",
    policyRegistry: [p],
    tasks: [task, { ...task }],
  }), "O7_TASKS_INVALID");
  assertCode(() => previewPersonnelLifecycleAutomation({
    asOf: "2026-08-07T10:00:00.000Z",
    policyRegistry: [p],
    tasks: [{ ...task, unexpected: true }],
  }), "O7_FIELDS_INVALID");
  assertCode(() => previewPersonnelLifecycleAutomation({
    asOf: "2026-08-07T10:00:00.000Z",
    policyRegistry: [p],
    tasks: [{
      ...task,
      policyBinding: { ...task.policyBinding, unexpected: true },
    }],
  }), "O7_FIELDS_INVALID");
  assertCode(() => previewPersonnelLifecycleAutomation({
    asOf: "2026-08-07T10:00:00.000Z",
    policyRegistry: [new Proxy(p, {})],
    tasks: [],
  }), "O7_RECORD_INVALID");
  assertCode(() => previewPersonnelLifecycleAutomation({
    asOf: "2026-08-07T10:00:00.000Z",
    policyRegistry: [p],
    tasks: [new Proxy(task, {})],
  }), "O7_RECORD_INVALID");

  let reads = 0;
  const accessorTask = { ...task };
  delete accessorTask.title;
  Object.defineProperty(accessorTask, "title", {
    enumerable: true,
    get() {
      reads += 1;
      return "Dynamischer Titel";
    },
  });
  assertCode(() => previewPersonnelLifecycleAutomation({
    asOf: "2026-08-07T10:00:00.000Z",
    policyRegistry: [p],
    tasks: [accessorTask],
  }), "O7_FIELDS_INVALID");
  assert.equal(reads, 0);
});

test("Preview-Huelle verwirft Proxy, Accessor, unbekannte Felder und unkanonische Zeitpunkte", () => {
  const valid = {
    asOf: "2026-08-07T10:00:00.000Z",
    policyRegistry: [],
    tasks: [],
  };
  assertCode(() => previewPersonnelLifecycleAutomation(new Proxy(valid, {})), "O7_RECORD_INVALID");
  assertCode(() => previewPersonnelLifecycleAutomation({ ...valid, unexpected: true }),
    "O7_FIELDS_INVALID");
  assertCode(() => previewPersonnelLifecycleAutomation({ ...valid, asOf: "2026-08-07T10:00:00Z" }),
    "O7_TIMESTAMP_INVALID");
  assertCode(() => previewPersonnelLifecycleAutomation({ ...valid, asOf: "nicht-iso" }),
    "O7_TIMESTAMP_INVALID");

  let reads = 0;
  const accessorPreview = { ...valid };
  delete accessorPreview.tasks;
  Object.defineProperty(accessorPreview, "tasks", {
    enumerable: true,
    get() {
      reads += 1;
      return [];
    },
  });
  assertCode(() => previewPersonnelLifecycleAutomation(accessorPreview), "O7_FIELDS_INVALID");
  assert.equal(reads, 0);
});

test("jede Benachrichtigungsbelegung und jede automatische Vertretungsart ist gesperrt", () => {
  for (const channel of [
    "internal",
    "portal",
    "email",
    "sms",
    "push",
    "webhook",
    "whatsapp",
  ]) {
    assertCode(() => policy({ notificationChannels: [channel] }), "O7_VALUE_INVALID");
  }
  for (const representationMode of [
    "automatic",
    "automatic_substitution",
    "automatic_assignment",
    "approval_delegation",
    "rule_based",
    "scheduler",
  ]) {
    assertCode(() => policy({ representationMode }), "O7_REPRESENTATION_INVALID");
  }
  assert.equal(policy().representationMode, "manual_hr_clarification");
  assert.deepEqual(policy().notificationChannels, []);
});

test("fehlende Bindung, fehlendes Datum und nicht bearbeitbare Stati blockieren fail-closed", () => {
  const p = policy();
  const missingBinding = preview(p, projectedTask(p, {
    policyBinding: null,
    referenceDate: null,
  })).items[0];
  assert.deepEqual(new Set(missingBinding.blockerCodes), new Set([
    B.POLICY_BINDING_MISSING,
    B.REFERENCE_DATE_MISSING,
  ]));
  assert.equal(missingBinding.dueAt, null);
  assert.equal(missingBinding.dueState, "not_configured");
  assert.equal(missingBinding.reminderState, "blocked");
  assert.equal(missingBinding.escalationState, "blocked");

  const missingDate = preview(p, projectedTask(p, { referenceDate: null })).items[0];
  assert.deepEqual(missingDate.blockerCodes, [B.REFERENCE_DATE_MISSING]);

  for (const status of ["completed", "cancelled"]) {
    const item = preview(p, projectedTask(p, { status })).items[0];
    assert.deepEqual(item.blockerCodes, [B.TASK_STATUS_NOT_ACTIONABLE]);
    assert.equal(item.dueState, "not_configured");
  }

  const pending = preview(p, projectedTask(p, { status: "pending" })).items[0];
  assert.deepEqual(pending.blockerCodes, []);
  assert.notEqual(pending.dueState, "not_configured");
  assertCode(() => preview(p, projectedTask(p, { status: "paused" })), "O7_VALUE_INVALID");
});

test("fehlende Prozessversion und Referenzart erhalten eigene Blocker", () => {
  const p = policy();
  const item = preview(p, projectedTask(p, {
    processVersionId: null,
    referenceKind: null,
  })).items[0];
  assert.ok(item.blockerCodes.includes(B.PROCESS_VERSION_MISSING));
  assert.ok(item.blockerCodes.includes(B.REFERENCE_KIND_MISSING));
  assert.equal(item.dueState, "not_configured");
  assert.equal(item.processVersionId, null);
  assert.equal(item.referenceKind, null);

  assertCode(() => preview(p, projectedTask(p, {
    referenceKind: "free_text_date",
  })), "O7_REFERENCE_INVALID");
  assertCode(() => preview(p, projectedTask(p, {
    processVersionId: "ungueltige version",
  })), "O7_VALUE_INVALID");
});

test("fehlende, veraltete und inaktive Richtlinien werden getrennt blockiert", () => {
  const p = policy();
  const task = projectedTask(p);
  const notFound = previewPersonnelLifecycleAutomation({
    asOf: "2026-08-07T10:00:00.000Z",
    policyRegistry: [],
    tasks: [task],
  }).items[0];
  assert.deepEqual(notFound.blockerCodes, [B.POLICY_NOT_FOUND]);

  const staleBinding = preview(p, projectedTask(p, {
    policyBinding: { ...task.policyBinding, fingerprint: "f".repeat(64) },
  })).items[0];
  assert.deepEqual(staleBinding.blockerCodes, [B.POLICY_BINDING_STALE]);

  const tampered = { ...p, fingerprint: "0".repeat(64) };
  const tamperedItem = previewPersonnelLifecycleAutomation({
    asOf: "2026-08-07T10:00:00.000Z",
    policyRegistry: [tampered],
    tasks: [projectedTask(p, {
      policyBinding: { ...task.policyBinding, fingerprint: tampered.fingerprint },
    })],
  }).items[0];
  assert.deepEqual(tamperedItem.blockerCodes, [B.POLICY_BINDING_STALE]);

  const inactive = policy({ active: false });
  const inactiveItem = preview(inactive, projectedTask(inactive)).items[0];
  assert.deepEqual(inactiveItem.blockerCodes, [B.POLICY_INACTIVE]);
});

test("Quelle, Schritt und Scope einer Richtlinie muessen zur Aufgabe passen", () => {
  const p = policy();
  for (const mismatch of [
    { source: "offboarding" },
    { processVersionId: "onboarding-v2" },
    { stepId: "step-b" },
    { referenceKind: "contractual_entry_date" },
  ]) {
    const item = preview(p, projectedTask(p, mismatch)).items[0];
    assert.deepEqual(item.blockerCodes, [B.POLICY_NOT_APPLICABLE]);
  }

  const locationPolicy = policy({ scope: { type: "location", id: "location-1" } });
  const wrongLocation = preview(locationPolicy, projectedTask(locationPolicy, {
    scope: { type: "location", id: "location-2" },
  })).items[0];
  assert.deepEqual(wrongLocation.blockerCodes, [B.POLICY_NOT_APPLICABLE]);

  const globalForLocation = preview(p, projectedTask(p, {
    scope: { type: "location", id: "location-2" },
  })).items[0];
  assert.deepEqual(globalForLocation.blockerCodes, []);
  assertCode(() => preview(p, projectedTask(p, { source: "verkauf" })), "O7_SOURCE_INVALID");
});

test("Kalendertage berechnen Frist, Erinnerung und Eskalation nur als Vorschau", () => {
  const p = policy({
    dueOffsetDays: 5,
    reminderOffsetsDays: [3, 1, 0],
    escalationAfterDays: 2,
  });
  const task = projectedTask(p);

  const reminder = preview(p, task, "2026-08-12T10:00:00.000Z");
  assert.equal(reminder.items[0].dueAt, "2026-08-15");
  assert.equal(reminder.items[0].dueState, "due_soon");
  assert.equal(reminder.items[0].reminderState, "preview_due");
  assert.equal(reminder.items[0].escalationState, "not_due");

  const beforeReminder = preview(p, task, "2026-08-11T10:00:00.000Z");
  assert.equal(beforeReminder.items[0].reminderState, "not_due");

  const overdue = preview(p, task, "2026-08-17T10:00:00.000Z");
  assert.equal(overdue.items[0].dueState, "overdue");
  assert.equal(overdue.items[0].escalationState, "preview_due");
  assert.deepEqual(overdue.runtimeGates, PERSONNEL_LIFECYCLE_AUTOMATION_RUNTIME_GATES);
  assert.equal(Object.values(overdue.runtimeGates).some(Boolean), false);
  assert.equal(overdue.modes.reminders, "preview_only");
  assert.equal(overdue.modes.escalations, "preview_only");
  assertDeepFrozen(overdue);

  const withoutReminder = policy({ reminderOffsetsDays: [] });
  assert.equal(preview(withoutReminder, projectedTask(withoutReminder)).items[0].reminderState,
    "not_scheduled");
});

test("Arbeitstage beruecksichtigen Wochenenden, Feiertage und Referenzanpassungen", () => {
  const nextWorkingDay = policy({
    dayMode: "working_days",
    workingDays: [1, 2, 3, 4, 5],
    holidayDates: ["2026-08-17"],
    referenceAdjustment: "next_working_day",
    dueOffsetDays: 0,
  });
  const adjusted = preview(nextWorkingDay, projectedTask(nextWorkingDay, {
    referenceDate: "2026-08-15",
  }), "2026-08-14T10:00:00.000Z").items[0];
  assert.equal(adjusted.dueAt, "2026-08-18");

  const plusOne = policy({
    policyId: "working-plus-one",
    dayMode: "working_days",
    workingDays: [1, 2, 3, 4, 5],
    holidayDates: ["2026-08-17"],
    referenceAdjustment: "none",
    dueOffsetDays: 1,
  });
  assert.equal(preview(plusOne, projectedTask(plusOne, {
    referenceDate: "2026-08-14",
  })).items[0].dueAt, "2026-08-18");

  const previousWorkingDay = policy({
    policyId: "working-previous",
    dayMode: "working_days",
    workingDays: [1, 2, 3, 4, 5],
    holidayDates: [],
    referenceAdjustment: "previous_working_day",
    dueOffsetDays: 0,
  });
  assert.equal(preview(previousWorkingDay, projectedTask(previousWorkingDay, {
    referenceDate: "2026-08-16",
  })).items[0].dueAt, "2026-08-14");

  const minusOne = policy({
    policyId: "working-minus-one",
    dayMode: "working_days",
    workingDays: [1, 2, 3, 4, 5],
    holidayDates: ["2026-08-17"],
    referenceAdjustment: "none",
    dueOffsetDays: -1,
  });
  assert.equal(preview(minusOne, projectedTask(minusOne, {
    referenceDate: "2026-08-18",
  })).items[0].dueAt, "2026-08-14");
});

test("chronologische Ueberfaelligkeit bleibt auch an Nichtarbeitstagen sichtbar", () => {
  const p = policy({
    dayMode: "working_days",
    workingDays: [1, 2, 3, 4, 5],
    holidayDates: [],
    referenceAdjustment: "none",
    escalationAfterDays: 1,
  });
  const item = preview(p, projectedTask(p, {
    referenceDate: "2026-08-14",
  }), "2026-08-15T10:00:00.000Z").items[0];
  assert.equal(item.dueAt, "2026-08-14");
  assert.equal(item.dueState, "overdue");
  assert.equal(item.escalationState, "preview_due");
});

test("IANA-Zeitzonen bestimmen den lokalen Kalendertag ohne Serverzeit-Leak", () => {
  const vienna = policy({
    policyId: "timezone-vienna",
    timezone: "Europe/Vienna",
  });
  const newYork = policy({
    policyId: "timezone-new-york",
    timezone: "America/New_York",
  });
  const asOf = "2026-08-03T22:30:00.000Z";
  const viennaItem = preview(vienna, projectedTask(vienna, {
    referenceDate: "2026-08-04",
  }), asOf).items[0];
  const newYorkItem = preview(newYork, projectedTask(newYork, {
    referenceDate: "2026-08-04",
  }), asOf).items[0];

  assert.equal(viennaItem.dueState, "due_today");
  assert.equal(newYorkItem.dueState, "due_soon");
  assertCode(() => policy({ timezone: "Europe/Unbekannt" }), "O7_TIMEZONE_INVALID");
});

test("Vertretung bleibt eine manuelle HR-Klaerung ohne Personen- oder Kanalprojektion", () => {
  const p = policy();
  const expectations = {
    assigned: "manual_only",
    unavailable: "clarification_required",
    unknown: "not_evaluated",
  };
  for (const [responsibilityState, representationState] of Object.entries(expectations)) {
    const sourceTask = projectedTask(p, { responsibilityState });
    const before = JSON.stringify(sourceTask);
    const result = preview(p, sourceTask);
    const item = result.items[0];
    assert.equal(item.responsibilityState, responsibilityState);
    assert.equal(item.representationState, representationState);
    assert.equal(Object.prototype.hasOwnProperty.call(item, "representativeId"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(item, "assigneeId"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(item, "notificationChannels"), false);
    assert.equal(JSON.stringify(sourceTask), before);
  }
});

test("Preview-Summary zaehlt nur sichtbare Projektionen und schreibt keine Eingaben um", () => {
  const dueTodayPolicy = policy({ policyId: "due-today" });
  const unavailable = projectedTask(dueTodayPolicy, { responsibilityState: "unavailable" });
  const blocked = projectedTask(dueTodayPolicy, {
    runId: "run-b",
    stepId: "step-b",
    policyBinding: null,
    referenceDate: null,
  });
  const input = {
    asOf: "2026-08-10T10:00:00.000Z",
    policyRegistry: [dueTodayPolicy],
    tasks: [unavailable, blocked],
  };
  const before = JSON.stringify(input);
  const result = previewPersonnelLifecycleAutomation(input);

  assert.deepEqual(result.policyRegistry, {
    policyCount: 1,
    activePolicyCount: 1,
    customerConfigured: true,
  });
  assert.deepEqual(result.summary, {
    visibleTasks: 2,
    configuredDeadlines: 1,
    dueSoon: 0,
    dueToday: 1,
    overdue: 0,
    clarificationRequired: 2,
    notConfigured: 1,
  });
  assert.equal(JSON.stringify(input), before);
  assertDeepFrozen(result);
});

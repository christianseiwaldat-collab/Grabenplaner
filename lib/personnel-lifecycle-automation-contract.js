"use strict";

const crypto = require("node:crypto");
const { types: utilTypes } = require("node:util");

const PERSONNEL_LIFECYCLE_AUTOMATION_CONTRACT_VERSION = "o7-v0.1";

const PERSONNEL_LIFECYCLE_AUTOMATION_DOMAINS = Object.freeze({
  DEADLINES: "deadlines",
  SUBSTITUTIONS: "substitutions",
  REMINDERS: "reminders",
  ESCALATIONS: "escalations",
});

const PERSONNEL_LIFECYCLE_AUTOMATION_DOMAIN_IDS = Object.freeze(
  Object.values(PERSONNEL_LIFECYCLE_AUTOMATION_DOMAINS),
);

const PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSIONS = Object.freeze({
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

const PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS = Object.freeze(
  Object.values(PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSIONS),
);

const PERSONNEL_LIFECYCLE_AUTOMATION_READ_PERMISSIONS = Object.freeze({
  deadlines: PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSIONS.DEADLINES_READ,
  substitutions: PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSIONS.SUBSTITUTIONS_READ,
  reminders: PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSIONS.REMINDERS_READ,
  escalations: PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSIONS.ESCALATIONS_READ,
});

const PERSONNEL_LIFECYCLE_AUTOMATION_ROLE_GRANTS = Object.freeze({});

// O7 has no customer decision for persistence, channels, scheduling or automatic
// reassignment. These gates are product invariants for this first contract and
// cannot be changed through request data.
const PERSONNEL_LIFECYCLE_AUTOMATION_RUNTIME_GATES = Object.freeze({
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

const PERSONNEL_LIFECYCLE_AUTOMATION_MODES = Object.freeze({
  deadlineCalculation: "explicit_versioned_policy_only",
  representation: "manual_hr_clarification",
  reminders: "preview_only",
  escalations: "preview_only",
});

const PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS = Object.freeze({
  POLICY_REGISTRY_EMPTY: "policy_registry_empty",
  POLICY_BINDING_MISSING: "policy_binding_missing",
  POLICY_NOT_FOUND: "policy_not_found",
  POLICY_BINDING_STALE: "policy_binding_stale",
  POLICY_INACTIVE: "policy_inactive",
  POLICY_NOT_APPLICABLE: "policy_not_applicable",
  TASK_STATUS_NOT_ACTIONABLE: "task_status_not_actionable",
  PROCESS_VERSION_MISSING: "process_version_missing",
  REFERENCE_KIND_MISSING: "reference_kind_missing",
  REFERENCE_DATE_MISSING: "reference_date_missing",
  CALENDAR_RULE_MISSING: "calendar_rule_missing",
  NOTIFICATION_CHANNEL_NOT_APPROVED: "notification_channel_not_approved",
  EFFECTS_ACTIVATION_NOT_APPROVED: "effects_activation_not_approved",
});

const DEFAULT_CATALOG_BLOCKERS = Object.freeze([
  PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.POLICY_REGISTRY_EMPTY,
  PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.CALENDAR_RULE_MISSING,
  PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.NOTIFICATION_CHANNEL_NOT_APPROVED,
  PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.EFFECTS_ACTIVATION_NOT_APPROVED,
]);

const DOMAIN_CATALOG = Object.freeze({
  deadlines: Object.freeze({
    label: "Fristen und Kalenderregeln",
    registry: "deadlinePolicies",
    blockerCodes: Object.freeze([
      PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.POLICY_REGISTRY_EMPTY,
      PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.CALENDAR_RULE_MISSING,
      PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.EFFECTS_ACTIVATION_NOT_APPROVED,
    ]),
  }),
  substitutions: Object.freeze({
    label: "Vertretung und Verantwortlichkeit",
    registry: "substitutionRules",
    blockerCodes: Object.freeze([
      PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.POLICY_REGISTRY_EMPTY,
      PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.EFFECTS_ACTIVATION_NOT_APPROVED,
    ]),
  }),
  reminders: Object.freeze({
    label: "Erinnerungen",
    registry: "reminderRules",
    blockerCodes: Object.freeze([
      PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.POLICY_REGISTRY_EMPTY,
      PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.NOTIFICATION_CHANNEL_NOT_APPROVED,
      PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.EFFECTS_ACTIVATION_NOT_APPROVED,
    ]),
  }),
  escalations: Object.freeze({
    label: "Eskalationen",
    registry: "escalationRules",
    blockerCodes: Object.freeze([
      PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.POLICY_REGISTRY_EMPTY,
      PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.NOTIFICATION_CHANNEL_NOT_APPROVED,
      PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.EFFECTS_ACTIVATION_NOT_APPROVED,
    ]),
  }),
});

const PERSONNEL_LIFECYCLE_AUTOMATION_DEFAULT_POLICY_REGISTRY = Object.freeze([]);

const SOURCE_IDS = new Set(["onboarding", "offboarding"]);
const TASK_STATUS_IDS = new Set(["pending", "active", "completed", "cancelled"]);
const ACTIONABLE_TASK_STATUS_IDS = new Set(["pending", "active"]);
const RESPONSIBILITY_STATE_IDS = new Set(["assigned", "unavailable", "unknown"]);
const SCOPE_TYPES = new Set(["global", "location", "department"]);
const DAY_MODES = new Set(["calendar_days", "working_days"]);
const REFERENCE_ADJUSTMENTS = new Set(["none", "next_working_day", "previous_working_day"]);
const REFERENCE_KINDS = new Set([
  "task_activated_at",
  "contractual_entry_date",
  "first_working_day",
  "onboarding_target_date",
  "planned_exit_date",
  "last_working_day",
  "legal_exit_date",
  "access_block_at",
  "explicit_task_due_date",
]);
const REFERENCE_KINDS_BY_SOURCE = Object.freeze({
  onboarding: new Set([
    "task_activated_at",
    "contractual_entry_date",
    "first_working_day",
    "onboarding_target_date",
    "explicit_task_due_date",
  ]),
  offboarding: new Set([
    "task_activated_at",
    "planned_exit_date",
    "last_working_day",
    "legal_exit_date",
    "access_block_at",
    "explicit_task_due_date",
  ]),
});

const POLICY_INPUT_KEYS = new Set([
  "policyId", "revision", "active", "source", "processVersionId", "stepId",
  "referenceKind", "scope", "timezone",
  "dayMode", "workingDays", "holidayDates", "referenceAdjustment", "dueOffsetDays",
  "dueSoonDays", "reminderOffsetsDays", "escalationAfterDays", "representationMode",
  "notificationChannels",
]);
const POLICY_RECORD_KEYS = new Set([...POLICY_INPUT_KEYS, "fingerprint"]);
const POLICY_BINDING_KEYS = new Set(["policyId", "revision", "fingerprint"]);
const SCOPE_KEYS = new Set(["type", "id"]);
const TASK_KEYS = new Set([
  "source", "runId", "processVersionId", "stepId", "title", "status", "scope",
  "referenceKind", "referenceDate", "responsibilityState", "policyBinding",
]);
const PREVIEW_KEYS = new Set(["asOf", "policyRegistry", "tasks"]);

function contractError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function assertExactRecord(value, keys, label, requiredKeys = keys) {
  if (utilTypes.isProxy(value) || !value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw contractError("O7_RECORD_INVALID", `${label} must be a plain record.`);
  }
  const actualKeys = Reflect.ownKeys(value);
  for (const key of actualKeys) {
    const descriptor = typeof key === "string"
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    if (typeof key !== "string" || !keys.has(key) || !descriptor
      || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw contractError("O7_FIELDS_INVALID", `${label} contains an unknown or dynamic field.`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw contractError("O7_FIELDS_INVALID", `${label} is missing ${key}.`);
    }
  }
}

function plainArrayValues(value, label, maximumLength) {
  if (utilTypes.isProxy(value) || !Array.isArray(value) || value.length > maximumLength) {
    throw contractError("O7_VALUE_INVALID", `${label} must be a bounded plain array.`);
  }
  const expectedKeys = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string"
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    if (typeof key !== "string" || !expectedKeys.has(key) || !descriptor
      || !("value" in descriptor) || (key !== "length" && descriptor.enumerable !== true)) {
      throw contractError("O7_VALUE_INVALID", `${label} must contain plain values.`);
    }
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw contractError("O7_VALUE_INVALID", `${label} must not contain gaps.`);
    }
    return descriptor.value;
  });
}

function text(value, label, { maxLength = 256, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength
    || /[\0\r\n]/.test(value)) {
    throw contractError("O7_VALUE_INVALID", `${label} must be a bounded string.`);
  }
  return value;
}

function integer(value, label, { minimum = 0, maximum = 3650 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw contractError("O7_VALUE_INVALID", `${label} must be an integer in range.`);
  }
  return value;
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

function normalizeScope(value, label = "scope") {
  assertExactRecord(value, SCOPE_KEYS, label);
  const type = text(value.type, `${label}.type`, { maxLength: 32 });
  if (!SCOPE_TYPES.has(type)) {
    throw contractError("O7_SCOPE_INVALID", `${label}.type is not supported.`);
  }
  const id = value.id;
  if ((type === "global" && id !== null)
    || (type !== "global" && (typeof id !== "string" || id.trim() === ""
      || id.length > 128 || /[\0\r\n]/.test(id)))) {
    throw contractError("O7_SCOPE_INVALID", `${label}.id does not match its type.`);
  }
  return Object.freeze({ type, id });
}

function normalizeDate(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw contractError("O7_DATE_INVALID", `${label} must be an ISO calendar date.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) {
    throw contractError("O7_DATE_INVALID", `${label} must be a real calendar date.`);
  }
  return value;
}

function normalizeTimezone(value) {
  const timezone = text(value, "timezone", { maxLength: 128 });
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw contractError("O7_TIMEZONE_INVALID", "timezone must be an explicit IANA timezone.");
  }
  return timezone;
}

function normalizeIntegerArray(value, label, options) {
  const values = plainArrayValues(value, label, 64)
    .map((entry, index) => integer(entry, `${label}[${index}]`, options));
  if (new Set(values).size !== values.length) {
    throw contractError("O7_VALUE_INVALID", `${label} must not contain duplicates.`);
  }
  return Object.freeze(values.sort((left, right) => left - right));
}

function normalizeDateArray(value, label) {
  const values = plainArrayValues(value, label, 2048)
    .map((entry, index) => normalizeDate(entry, `${label}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw contractError("O7_VALUE_INVALID", `${label} must not contain duplicates.`);
  }
  return Object.freeze(values.sort());
}

function policyFingerprintContent(policy) {
  const result = {};
  for (const key of POLICY_INPUT_KEYS) result[key] = policy[key];
  return result;
}

function fingerprintPolicy(policy) {
  return crypto.createHash("sha256")
    .update(canonicalJson(policyFingerprintContent(policy)), "utf8")
    .digest("hex");
}

function normalizePolicyInput(input) {
  assertExactRecord(input, POLICY_INPUT_KEYS, "O7 policy");
  const policyId = text(input.policyId, "policyId", { maxLength: 128 });
  const processVersionId = text(input.processVersionId, "processVersionId", { maxLength: 128 });
  const stepId = text(input.stepId, "stepId", { maxLength: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(policyId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(processVersionId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(stepId)) {
    throw contractError(
      "O7_VALUE_INVALID",
      "Policy, process-version and step identifiers must be opaque identifiers.",
    );
  }
  const revision = integer(input.revision, "revision", { minimum: 1, maximum: 2147483647 });
  if (typeof input.active !== "boolean") {
    throw contractError("O7_VALUE_INVALID", "active must be a boolean.");
  }
  const source = text(input.source, "source", { maxLength: 32 });
  if (!SOURCE_IDS.has(source)) {
    throw contractError("O7_SOURCE_INVALID", "source is not supported.");
  }
  const referenceKind = text(input.referenceKind, "referenceKind", { maxLength: 64 });
  if (!REFERENCE_KINDS.has(referenceKind) || !REFERENCE_KINDS_BY_SOURCE[source].has(referenceKind)) {
    throw contractError("O7_REFERENCE_INVALID", "referenceKind is not supported for this source.");
  }
  const scope = normalizeScope(input.scope, "Policy scope");
  const timezone = normalizeTimezone(input.timezone);
  const dayMode = text(input.dayMode, "dayMode", { maxLength: 32 });
  if (!DAY_MODES.has(dayMode)) {
    throw contractError("O7_CALENDAR_INVALID", "dayMode is not supported.");
  }
  const workingDays = normalizeIntegerArray(input.workingDays, "workingDays", {
    minimum: 1,
    maximum: 7,
  });
  const holidayDates = normalizeDateArray(input.holidayDates, "holidayDates");
  if ((dayMode === "working_days" && workingDays.length === 0)
    || (dayMode === "calendar_days" && (workingDays.length !== 0 || holidayDates.length !== 0))) {
    throw contractError(
      "O7_CALENDAR_INVALID",
      "Working-day rules must be explicit and must not leak into calendar-day policies.",
    );
  }
  const referenceAdjustment = text(
    input.referenceAdjustment,
    "referenceAdjustment",
    { maxLength: 32 },
  );
  if (!REFERENCE_ADJUSTMENTS.has(referenceAdjustment)
    || (dayMode === "calendar_days" && referenceAdjustment !== "none")) {
    throw contractError("O7_CALENDAR_INVALID", "referenceAdjustment does not match dayMode.");
  }
  const dueOffsetDays = integer(input.dueOffsetDays, "dueOffsetDays", {
    minimum: -3650,
    maximum: 3650,
  });
  if (referenceKind === "explicit_task_due_date"
    && (dayMode !== "calendar_days" || referenceAdjustment !== "none" || dueOffsetDays !== 0)) {
    throw contractError(
      "O7_REFERENCE_INVALID",
      "An explicit task due date must remain unchanged by calendar or offset rules.",
    );
  }
  const dueSoonDays = integer(input.dueSoonDays, "dueSoonDays", { maximum: 365 });
  const reminderOffsetsDays = normalizeIntegerArray(
    input.reminderOffsetsDays,
    "reminderOffsetsDays",
    { maximum: 3650 },
  );
  const escalationAfterDays = integer(input.escalationAfterDays, "escalationAfterDays", {
    maximum: 3650,
  });
  if (input.representationMode !== PERSONNEL_LIFECYCLE_AUTOMATION_MODES.representation) {
    throw contractError("O7_REPRESENTATION_INVALID", "Automatic representation is not allowed in O7.");
  }
  const notificationChannels = plainArrayValues(
    input.notificationChannels,
    "notificationChannels",
    0,
  );
  return {
    policyId,
    revision,
    active: input.active,
    source,
    processVersionId,
    stepId,
    referenceKind,
    scope,
    timezone,
    dayMode,
    workingDays,
    holidayDates,
    referenceAdjustment,
    dueOffsetDays,
    dueSoonDays,
    reminderOffsetsDays,
    escalationAfterDays,
    representationMode: PERSONNEL_LIFECYCLE_AUTOMATION_MODES.representation,
    notificationChannels: Object.freeze(notificationChannels),
  };
}

function createPersonnelLifecycleAutomationPolicy(input) {
  const normalized = normalizePolicyInput(input);
  return deepFreeze({ ...normalized, fingerprint: fingerprintPolicy(normalized) });
}

function inspectPolicyRecord(value) {
  assertExactRecord(value, POLICY_RECORD_KEYS, "O7 policy registry entry");
  const input = {};
  for (const key of POLICY_INPUT_KEYS) input[key] = value[key];
  const normalized = normalizePolicyInput(input);
  const fingerprint = text(value.fingerprint, "fingerprint", { maxLength: 64 });
  return deepFreeze({
    ...normalized,
    fingerprint,
    fingerprintValid: /^[a-f0-9]{64}$/.test(fingerprint)
      && fingerprint === fingerprintPolicy(normalized),
  });
}

function normalizeRegistry(value) {
  const records = plainArrayValues(value, "policyRegistry", 1000).map(inspectPolicyRecord);
  const keys = new Set();
  for (const policy of records) {
    const key = `${policy.policyId}\0${policy.revision}`;
    if (keys.has(key)) {
      throw contractError("O7_REGISTRY_INVALID", "The policy registry contains duplicate revisions.");
    }
    keys.add(key);
  }
  return Object.freeze(records);
}

function normalizePolicyBinding(value) {
  if (value === null) return null;
  assertExactRecord(value, POLICY_BINDING_KEYS, "O7 task policy binding");
  return Object.freeze({
    policyId: text(value.policyId, "policyBinding.policyId", { maxLength: 128 }),
    revision: integer(value.revision, "policyBinding.revision", {
      minimum: 1,
      maximum: 2147483647,
    }),
    fingerprint: text(value.fingerprint, "policyBinding.fingerprint", { maxLength: 64 }),
  });
}

function normalizeTask(value) {
  assertExactRecord(value, TASK_KEYS, "O7 task projection");
  const source = text(value.source, "task.source", { maxLength: 32 });
  if (!SOURCE_IDS.has(source)) {
    throw contractError("O7_SOURCE_INVALID", "task.source is not supported.");
  }
  const status = text(value.status, "task.status", { maxLength: 32 });
  const responsibilityState = text(
    value.responsibilityState,
    "task.responsibilityState",
    { maxLength: 32 },
  );
  if (!TASK_STATUS_IDS.has(status) || !RESPONSIBILITY_STATE_IDS.has(responsibilityState)) {
    throw contractError("O7_VALUE_INVALID", "Task state is not supported.");
  }
  const processVersionId = text(value.processVersionId, "task.processVersionId", {
    maxLength: 128,
    nullable: true,
  });
  if (processVersionId !== null
    && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(processVersionId)) {
    throw contractError("O7_VALUE_INVALID", "task.processVersionId must be an opaque identifier.");
  }
  const referenceKind = text(value.referenceKind, "task.referenceKind", {
    maxLength: 64,
    nullable: true,
  });
  if (referenceKind !== null && (!REFERENCE_KINDS.has(referenceKind)
    || !REFERENCE_KINDS_BY_SOURCE[source].has(referenceKind))) {
    throw contractError("O7_REFERENCE_INVALID", "task.referenceKind is not supported for this source.");
  }
  return Object.freeze({
    source,
    runId: text(value.runId, "task.runId", { maxLength: 128 }),
    processVersionId,
    stepId: text(value.stepId, "task.stepId", { maxLength: 128 }),
    title: text(value.title, "task.title", { maxLength: 200 }),
    status,
    scope: normalizeScope(value.scope, "Task scope"),
    referenceKind,
    referenceDate: normalizeDate(value.referenceDate, "task.referenceDate", { nullable: true }),
    responsibilityState,
    policyBinding: normalizePolicyBinding(value.policyBinding),
  });
}

function dateValue(date) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function shiftCalendarDate(date, offset) {
  const value = new Date(dateValue(date) + offset * 86400000);
  return `${String(value.getUTCFullYear()).padStart(4, "0")}-${String(
    value.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function weekday(date) {
  const day = new Date(dateValue(date)).getUTCDay();
  return day === 0 ? 7 : day;
}

function isWorkingDate(date, policy) {
  return policy.workingDays.includes(weekday(date)) && !policy.holidayDates.includes(date);
}

function adjustedReferenceDate(referenceDate, policy) {
  if (policy.dayMode === "calendar_days" || policy.referenceAdjustment === "none"
    || isWorkingDate(referenceDate, policy)) return referenceDate;
  const direction = policy.referenceAdjustment === "next_working_day" ? 1 : -1;
  let candidate = referenceDate;
  for (let index = 0; index < 3660; index += 1) {
    candidate = shiftCalendarDate(candidate, direction);
    if (isWorkingDate(candidate, policy)) return candidate;
  }
  throw contractError("O7_CALENDAR_INVALID", "Calendar rules do not yield a working day.");
}

function calculateDueDate(referenceDate, policy) {
  const adjusted = adjustedReferenceDate(referenceDate, policy);
  if (policy.dayMode === "calendar_days") {
    return shiftCalendarDate(adjusted, policy.dueOffsetDays);
  }
  if (policy.dueOffsetDays === 0) return adjusted;
  const direction = policy.dueOffsetDays > 0 ? 1 : -1;
  const target = Math.abs(policy.dueOffsetDays);
  let counted = 0;
  let candidate = adjusted;
  for (let index = 0; index < 10000; index += 1) {
    candidate = shiftCalendarDate(candidate, direction);
    if (isWorkingDate(candidate, policy)) counted += 1;
    if (counted === target) return candidate;
  }
  throw contractError("O7_CALENDAR_INVALID", "Calendar offset exceeds the supported boundary.");
}

function dateForTimestamp(timestamp, timezone) {
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw contractError("O7_TIMESTAMP_INVALID", "asOf must be a canonical ISO timestamp.");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const map = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function daysBetween(fromDate, toDate, policy) {
  if (fromDate === toDate) return 0;
  const direction = dateValue(toDate) > dateValue(fromDate) ? 1 : -1;
  if (policy.dayMode === "calendar_days") {
    return direction * Math.abs((dateValue(toDate) - dateValue(fromDate)) / 86400000);
  }
  let count = 0;
  let candidate = fromDate;
  for (let index = 0; index < 10000 && candidate !== toDate; index += 1) {
    candidate = shiftCalendarDate(candidate, direction);
    if (isWorkingDate(candidate, policy)) count += 1;
  }
  if (candidate !== toDate) {
    throw contractError("O7_CALENDAR_INVALID", "Calendar comparison exceeds the supported boundary.");
  }
  return direction * count;
}

function scopeMatches(policyScope, taskScope) {
  return policyScope.type === "global"
    || (policyScope.type === taskScope.type && policyScope.id === taskScope.id);
}

function responsibilityProjection(state) {
  if (state === "assigned") return Object.freeze({
    responsibilityState: "assigned",
    representationState: "manual_only",
  });
  if (state === "unavailable") return Object.freeze({
    responsibilityState: "unavailable",
    representationState: "clarification_required",
  });
  return Object.freeze({
    responsibilityState: "unknown",
    representationState: "not_evaluated",
  });
}

function blockedTask(task, blockers) {
  return deepFreeze({
    source: task.source,
    runId: task.runId,
    processVersionId: task.processVersionId,
    stepId: task.stepId,
    title: task.title,
    status: task.status,
    referenceKind: task.referenceKind,
    referenceDate: task.referenceDate,
    dueAt: null,
    dueState: "not_configured",
    ...responsibilityProjection(task.responsibilityState),
    reminderState: "blocked",
    escalationState: "blocked",
    blockerCodes: [...blockers],
  });
}

function previewTask(task, registry, asOf) {
  const blockers = new Set();
  const binding = task.policyBinding;
  if (!ACTIONABLE_TASK_STATUS_IDS.has(task.status)) {
    blockers.add(PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.TASK_STATUS_NOT_ACTIONABLE);
  }
  if (!task.processVersionId) {
    blockers.add(PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.PROCESS_VERSION_MISSING);
  }
  if (!task.referenceKind) {
    blockers.add(PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.REFERENCE_KIND_MISSING);
  }
  if (!task.referenceDate) {
    blockers.add(PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.REFERENCE_DATE_MISSING);
  }
  if (!binding) {
    blockers.add(PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.POLICY_BINDING_MISSING);
    return blockedTask(task, blockers);
  }
  const policy = registry.find((entry) => (
    entry.policyId === binding.policyId && entry.revision === binding.revision
  ));
  if (!policy) blockers.add(PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.POLICY_NOT_FOUND);
  if (policy && (!policy.fingerprintValid || policy.fingerprint !== binding.fingerprint)) {
    blockers.add(PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.POLICY_BINDING_STALE);
  }
  if (policy && !policy.active) {
    blockers.add(PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.POLICY_INACTIVE);
  }
  if (policy && (policy.source !== task.source
    || policy.processVersionId !== task.processVersionId
    || policy.stepId !== task.stepId || policy.referenceKind !== task.referenceKind
    || !scopeMatches(policy.scope, task.scope))) {
    blockers.add(PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS.POLICY_NOT_APPLICABLE);
  }
  if (blockers.size > 0) return blockedTask(task, blockers);

  const dueAt = calculateDueDate(task.referenceDate, policy);
  const currentDate = dateForTimestamp(asOf, policy.timezone);
  const distance = daysBetween(currentDate, dueAt, policy);
  const chronologicalDirection = Math.sign(dateValue(dueAt) - dateValue(currentDate));
  const dueState = chronologicalDirection < 0
    ? "overdue"
    : chronologicalDirection === 0
      ? "due_today"
      : distance <= policy.dueSoonDays
        ? "due_soon"
        : "not_due";
  const maximumReminderOffset = policy.reminderOffsetsDays.length
    ? Math.max(...policy.reminderOffsetsDays)
    : null;
  const reminderState = maximumReminderOffset === null
    ? "not_scheduled"
    : distance <= maximumReminderOffset
      ? "preview_due"
      : "not_due";
  const overdueBy = chronologicalDirection < 0 ? Math.max(1, Math.abs(distance)) : 0;
  const escalationState = dueState === "overdue" && overdueBy >= policy.escalationAfterDays
    ? "preview_due"
    : "not_due";
  return deepFreeze({
    source: task.source,
    runId: task.runId,
    processVersionId: task.processVersionId,
    stepId: task.stepId,
    title: task.title,
    status: task.status,
    referenceKind: task.referenceKind,
    referenceDate: task.referenceDate,
    dueAt,
    dueState,
    ...responsibilityProjection(task.responsibilityState),
    reminderState,
    escalationState,
    blockerCodes: [],
  });
}

function summaryForItems(items) {
  return Object.freeze({
    visibleTasks: items.length,
    configuredDeadlines: items.filter(({ dueState }) => dueState !== "not_configured").length,
    dueSoon: items.filter(({ dueState }) => dueState === "due_soon").length,
    dueToday: items.filter(({ dueState }) => dueState === "due_today").length,
    overdue: items.filter(({ dueState }) => dueState === "overdue").length,
    clarificationRequired: items.filter(({ blockerCodes, representationState }) => (
      blockerCodes.length > 0 || representationState === "clarification_required"
    )).length,
    notConfigured: items.filter(({ dueState }) => dueState === "not_configured").length,
  });
}

function registryProjection(registry) {
  return Object.freeze({
    policyCount: registry.length,
    activePolicyCount: registry.filter(({ active }) => active).length,
    customerConfigured: registry.length > 0,
  });
}

function normalizeCatalogDomainIds(value) {
  const values = value === undefined
    ? [...PERSONNEL_LIFECYCLE_AUTOMATION_DOMAIN_IDS]
    : plainArrayValues(value, "domainIds", PERSONNEL_LIFECYCLE_AUTOMATION_DOMAIN_IDS.length)
      .map((entry, index) => text(entry, `domainIds[${index}]`, { maxLength: 32 }));
  if (new Set(values).size !== values.length
    || values.some((domainId) => !PERSONNEL_LIFECYCLE_AUTOMATION_DOMAIN_IDS.includes(domainId))) {
    throw contractError("O7_DOMAIN_INVALID", "The requested automation domains are invalid.");
  }
  return values;
}

function personnelLifecycleAutomationCatalog(domainIds) {
  const visibleDomainIds = normalizeCatalogDomainIds(domainIds);
  const emptyRegistry = Object.freeze({
    recordCount: 0,
    activeRecordCount: 0,
    customerConfigured: false,
  });
  return deepFreeze({
    contractVersion: PERSONNEL_LIFECYCLE_AUTOMATION_CONTRACT_VERSION,
    registries: {
      deadlinePolicies: { ...emptyRegistry },
      calendarRules: { ...emptyRegistry },
      substitutionRules: { ...emptyRegistry },
      reminderRules: { ...emptyRegistry },
      escalationRules: { ...emptyRegistry },
      notificationChannels: { ...emptyRegistry },
    },
    runtimeGates: { ...PERSONNEL_LIFECYCLE_AUTOMATION_RUNTIME_GATES },
    modes: { ...PERSONNEL_LIFECYCLE_AUTOMATION_MODES },
    blockerCodes: [...DEFAULT_CATALOG_BLOCKERS],
    domains: visibleDomainIds.map((id) => ({
      id,
      label: DOMAIN_CATALOG[id].label,
      status: "blocked",
      registry: DOMAIN_CATALOG[id].registry,
      configurationCount: 0,
      externalEffectsEnabled: false,
      blockerCodes: [...DOMAIN_CATALOG[id].blockerCodes],
    })),
  });
}

function previewPersonnelLifecycleAutomation(input) {
  assertExactRecord(input, PREVIEW_KEYS, "O7 preview");
  const asOf = text(input.asOf, "asOf", { maxLength: 32 });
  // Validate canonical timestamp even when the empty registry means no task can
  // currently calculate a due date.
  const parsedAsOf = new Date(asOf);
  if (!Number.isFinite(parsedAsOf.getTime()) || parsedAsOf.toISOString() !== asOf) {
    throw contractError("O7_TIMESTAMP_INVALID", "asOf must be a canonical ISO timestamp.");
  }
  const registry = normalizeRegistry(input.policyRegistry);
  const tasks = plainArrayValues(input.tasks, "tasks", 1000).map(normalizeTask);
  const taskKeys = new Set();
  for (const task of tasks) {
    const key = `${task.source}\0${task.runId}\0${task.stepId}`;
    if (taskKeys.has(key)) {
      throw contractError("O7_TASKS_INVALID", "The task preview contains duplicate tasks.");
    }
    taskKeys.add(key);
  }
  const items = tasks.map((task) => previewTask(task, registry, asOf));
  return deepFreeze({
    contractVersion: PERSONNEL_LIFECYCLE_AUTOMATION_CONTRACT_VERSION,
    generatedAt: asOf,
    policyRegistry: registryProjection(registry),
    runtimeGates: { ...PERSONNEL_LIFECYCLE_AUTOMATION_RUNTIME_GATES },
    modes: { ...PERSONNEL_LIFECYCLE_AUTOMATION_MODES },
    summary: summaryForItems(items),
    items,
  });
}

module.exports = {
  PERSONNEL_LIFECYCLE_AUTOMATION_BLOCKERS,
  PERSONNEL_LIFECYCLE_AUTOMATION_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_AUTOMATION_DEFAULT_POLICY_REGISTRY,
  PERSONNEL_LIFECYCLE_AUTOMATION_DOMAINS,
  PERSONNEL_LIFECYCLE_AUTOMATION_DOMAIN_IDS,
  PERSONNEL_LIFECYCLE_AUTOMATION_MODES,
  PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS,
  PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSIONS,
  PERSONNEL_LIFECYCLE_AUTOMATION_READ_PERMISSIONS,
  PERSONNEL_LIFECYCLE_AUTOMATION_ROLE_GRANTS,
  PERSONNEL_LIFECYCLE_AUTOMATION_RUNTIME_GATES,
  createPersonnelLifecycleAutomationPolicy,
  personnelLifecycleAutomationCatalog,
  previewPersonnelLifecycleAutomation,
};

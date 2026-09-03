"use strict";

const PERSONAL_ACTION_ACTOR_KIND = "employee";
const PERSONAL_ACTION_DEFAULT_LIMIT = 30;
const PERSONAL_ACTION_MAX_LIMIT = 50;
const PERSONAL_ACTION_LEGACY_MAX_LIMIT = 100;
const PERSONAL_ACTION_COMPENSATOR_KEYS = Object.freeze([
  "schedule.manual-lock.restore.v1",
]);
const PERSONAL_ACTION_COMPENSATOR_KEY_SET = new Set(PERSONAL_ACTION_COMPENSATOR_KEYS);

function invalidInput() {
  throw new TypeError("Die Angaben für das persönliche Aktionslog sind ungültig.");
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed) {
  if (!isPlainRecord(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) invalidInput();
}

function boundedText(value, maximumLength, { required = true } = {}) {
  if (typeof value !== "string") invalidInput();
  const normalized = value.trim();
  if ((required && !normalized)
    || normalized.length > maximumLength
    || /[\u0000-\u001f\u007f]/.test(normalized)) invalidInput();
  return normalized;
}

function identifier(value, maximumLength = 160) {
  const normalized = boundedText(value, maximumLength);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(normalized)) invalidInput();
  return normalized;
}

function actionType(value) {
  const normalized = boundedText(value, 120);
  if (!/^[a-z][a-z0-9.-]{2,119}$/.test(normalized)) invalidInput();
  return normalized;
}

function utcTimestamp(value) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalidInput();
  try {
    if (new Date(value).toISOString() !== value) invalidInput();
  } catch {
    invalidInput();
  }
  return value;
}

function nullableTimestamp(value) {
  return value === null || value === undefined ? null : utcTimestamp(value);
}

function nullablePositiveRevision(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) invalidInput();
  return value;
}

function nullablePositiveSafeInteger(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) invalidInput();
  return value;
}

function nullableFingerprint(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalidInput();
  return value;
}

function validCalendarDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function manualScheduleLockPayload(value) {
  exactKeys(value, ["locationId", "weekStart", "restoreLocked"]);
  const locationId = identifier(value.locationId, 80);
  if (!validCalendarDate(value.weekStart)
    || new Date(`${value.weekStart}T00:00:00.000Z`).getUTCDay() !== 1
    || typeof value.restoreLocked !== "boolean") invalidInput();
  return Object.freeze({
    locationId,
    weekStart: value.weekStart,
    restoreLocked: value.restoreLocked,
  });
}

function normalizedUndoPayload(compensatorKey, value) {
  if (compensatorKey === null) {
    if (value !== null && value !== undefined) invalidInput();
    return null;
  }
  if (compensatorKey === "schedule.manual-lock.restore.v1") {
    return manualScheduleLockPayload(value);
  }
  invalidInput();
}

function normalizePersonalActionReceiptInput(value) {
  exactKeys(value, [
    "actorId",
    "actionType",
    "entityType",
    "entityId",
    "scope",
    "summary",
    "compensatorKey",
    "undoPayload",
    "resultRevision",
    "resultFingerprint",
    "sourceAuditId",
    "undoExpiresAt",
    "compensatesActionId",
    "createdAt",
  ]);
  const actorId = identifier(value.actorId, 120);
  const normalizedActionType = actionType(value.actionType);
  const entityType = identifier(value.entityType, 120);
  const entityId = identifier(value.entityId, 160);
  const scope = boundedText(value.scope, 160);
  const summary = boundedText(value.summary, 300);
  const compensatorKey = value.compensatorKey === null || value.compensatorKey === undefined
    ? null
    : boundedText(value.compensatorKey, 120);
  if (compensatorKey !== null && !PERSONAL_ACTION_COMPENSATOR_KEY_SET.has(compensatorKey)) {
    invalidInput();
  }
  const undoPayload = normalizedUndoPayload(compensatorKey, value.undoPayload);
  const resultRevision = nullablePositiveRevision(value.resultRevision);
  const resultFingerprint = nullableFingerprint(value.resultFingerprint);
  const sourceAuditId = nullablePositiveSafeInteger(value.sourceAuditId);
  const createdAt = utcTimestamp(value.createdAt);
  const undoExpiresAt = nullableTimestamp(value.undoExpiresAt);
  const compensatesActionId = value.compensatesActionId === null
    || value.compensatesActionId === undefined
    ? null
    : identifier(value.compensatesActionId, 36);

  if (compensatorKey === null) {
    if (undoExpiresAt !== null) invalidInput();
  } else if (undoExpiresAt === null
    || undoExpiresAt <= createdAt
    || (resultRevision === null && resultFingerprint === null)
    || compensatesActionId !== null) {
    invalidInput();
  }
  if (compensatesActionId !== null
    && (undoPayload !== null || compensatorKey !== null)) invalidInput();

  return Object.freeze({
    actorKind: PERSONAL_ACTION_ACTOR_KIND,
    actorId,
    actionType: normalizedActionType,
    entityType,
    entityId,
    scope,
    summary,
    compensatorKey,
    undoPayload,
    resultRevision,
    resultFingerprint,
    sourceAuditId,
    undoExpiresAt,
    compensatesActionId,
    createdAt,
  });
}

function normalizePersonalActionListInput(actorId, options = {}) {
  exactKeys(options, ["beforeCreatedAt", "beforeId", "limit"]);
  const beforeCreatedAt = options.beforeCreatedAt === null
    || options.beforeCreatedAt === undefined ? null : utcTimestamp(options.beforeCreatedAt);
  const beforeId = options.beforeId === null || options.beforeId === undefined
    ? null : identifier(options.beforeId, 36);
  if ((beforeCreatedAt === null) !== (beforeId === null)) invalidInput();
  const limit = options.limit === undefined ? PERSONAL_ACTION_DEFAULT_LIMIT : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PERSONAL_ACTION_MAX_LIMIT) invalidInput();
  return Object.freeze({
    actorId: identifier(actorId, 120),
    beforeCreatedAt,
    beforeId,
    limit,
  });
}

function normalizeLegacyAuditListInput(actorId, options = {}) {
  exactKeys(options, ["beforeId", "limit"]);
  const beforeId = options.beforeId === null || options.beforeId === undefined
    ? null : options.beforeId;
  const limit = options.limit === undefined ? PERSONAL_ACTION_DEFAULT_LIMIT : options.limit;
  if ((beforeId !== null && (!Number.isSafeInteger(beforeId) || beforeId < 1))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > PERSONAL_ACTION_LEGACY_MAX_LIMIT) {
    invalidInput();
  }
  return Object.freeze({
    actorId: identifier(actorId, 120),
    beforeId,
    limit,
  });
}

module.exports = {
  PERSONAL_ACTION_ACTOR_KIND,
  PERSONAL_ACTION_COMPENSATOR_KEYS,
  PERSONAL_ACTION_DEFAULT_LIMIT,
  PERSONAL_ACTION_LEGACY_MAX_LIMIT,
  PERSONAL_ACTION_MAX_LIMIT,
  normalizeLegacyAuditListInput,
  normalizePersonalActionListInput,
  normalizePersonalActionReceiptInput,
};

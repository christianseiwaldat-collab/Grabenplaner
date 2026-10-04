"use strict";

const STATUS_KEYS = new Set(["version", "planningEnabled", "periods"]);
const PERIOD_KEYS = new Set([
  "id", "phase", "confirmed", "validFrom", "validTo", "referenceId", "normalDailyMinutes",
]);
const PHASES = new Set([
  "unknown", "pregnancy", "postpartum", "breastfeeding", "not_applicable", "employment_prohibition",
]);
const BASIS_KEYS = ["id", "phase", "validFrom", "validTo", "referenceId", "normalDailyMinutes"];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function invalid() {
  // Do not echo protected values, source references or a rejected field's value.
  return Object.assign(new Error("Bitte gültige Angaben zum geschützten Planungsstatus übermitteln."), {
    status: 400, code: "PERSONNEL_PROTECTION_STATUS_INVALID",
  });
}

function assertRecord(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !own(descriptor, "value")) throw invalid();
  }
}

function assertPeriods(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > 32) throw invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) throw invalid();
  for (const key of keys) {
    if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)
        || Number(key) >= value.length)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !own(descriptor, "value")) throw invalid();
  }
}

function strictIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function opaqueReference(value, pattern, { optional = false } = {}) {
  if (typeof value !== "string" || value.length > 80
      || (value === "" ? !optional : !pattern.test(value))) throw invalid();
  return value;
}

function normalizePeriod(value, previousById) {
  assertRecord(value, PERIOD_KEYS);
  const id = opaqueReference(value.id, /^[A-Za-z0-9._-]+$/);
  if (!PHASES.has(value.phase) || !strictIsoDate(value.validFrom)) throw invalid();
  const validTo = own(value, "validTo") ? value.validTo : "";
  if (validTo !== "" && (!strictIsoDate(validTo) || validTo < value.validFrom)) throw invalid();
  const referenceId = opaqueReference(own(value, "referenceId") ? value.referenceId : "",
    /^[A-Za-z0-9._:/-]+$/, { optional: true });
  const normalDailyMinutes = own(value, "normalDailyMinutes") ? value.normalDailyMinutes : null;
  if (normalDailyMinutes !== null && (typeof normalDailyMinutes !== "number"
      || !Number.isInteger(normalDailyMinutes) || normalDailyMinutes < 1 || normalDailyMinutes > 540)) {
    throw invalid();
  }
  if (own(value, "confirmed") && typeof value.confirmed !== "boolean") throw invalid();
  const previous = previousById.get(id);
  const next = { id, phase: value.phase, confirmed: false, validFrom: value.validFrom, validTo,
    referenceId, normalDailyMinutes };
  const basisChanged = !previous || BASIS_KEYS.some(key => next[key] !== previous[key]);
  next.confirmed = own(value, "confirmed") ? value.confirmed : previous?.confirmed === true;
  if (basisChanged && value.confirmed !== true) next.confirmed = false;
  if (next.confirmed && (next.phase === "unknown" || !next.referenceId)) throw invalid();
  return next;
}

function normalizeRecord(value, previous) {
  assertRecord(value, STATUS_KEYS);
  if (own(value, "version") && value.version !== 1) throw invalid();
  if (own(value, "planningEnabled") && typeof value.planningEnabled !== "boolean") throw invalid();
  const periodsInput = own(value, "periods") ? value.periods : previous?.periods || [];
  assertPeriods(periodsInput);
  const previousById = new Map((previous?.periods || []).map(period => [period.id, period]));
  const ids = new Set();
  const periods = periodsInput.map(period => {
    const normalized = normalizePeriod(period, previousById);
    if (ids.has(normalized.id)) throw invalid();
    ids.add(normalized.id);
    return normalized;
  });
  return {
    version: 1,
    planningEnabled: own(value, "planningEnabled") ? value.planningEnabled : previous?.planningEnabled || false,
    periods,
  };
}

// The caller stores this whole field in the existing protected personnel JSON.
// No phase, enablement, ordinary working time or prohibition dates are inferred.
function normalizeProtectionStatus(value, { previous = null } = {}) {
  if (value === undefined || value === null) return null;
  const normalizedPrevious = previous === undefined || previous === null
    ? null : normalizeRecord(previous, null);
  return normalizeRecord(value, normalizedPrevious);
}

module.exports = { normalizeProtectionStatus };

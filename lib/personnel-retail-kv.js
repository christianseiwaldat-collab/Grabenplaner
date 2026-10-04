"use strict";

const RETAIL_KV_SOURCE = Object.freeze({
  id: "wko.kv.handel.angestellte.2026.20261003",
  version: "2026",
  title: "Kollektivvertrag für Angestellte und Lehrlinge in Handelsbetrieben 2026",
  url: "https://www.wko.at/oe/kollektivvertrag/kollektivvertrag-handel-angestellte-2026.pdf",
  retrievedOn: "2026-10-03",
  sha256: "ea214b34db934d18a4c0b25c0ae6dd3b62dceb5255851e91ac25908cee876e90",
  validFrom: "2026-01-01",
  validTo: "2026-12-31",
});
const RECORD_KEYS = new Set(["version", "planningEnabled", "periods"]);
const PERIOD_KEYS = new Set([
  "id", "group", "confirmed", "validFrom", "validTo", "sourceReference",
  "collectiveAgreementVersionId", "approvedAssignmentId", "sourceVersion", "sourceSha256",
  "contractWeeklyMinutes", "normalWorkModel", "agreementStatus", "agreementReference",
  "agreementValidFrom", "agreementValidTo", "agreementConfirmedBy",
  "workplaceKind", "workplaceConfirmed", "exceptionModel", "averagingPeriod",
]);
const GROUPS = new Set(["salaried", "apprentice", "unknown", "not_applicable"]);
const MODELS = new Set(["standard", "durchrechnung26Weeks", "agreement_other", "unknown"]);
const AGREEMENT_STATUSES = new Set(["unknown", "none_confirmed", "documented"]);
const WORKPLACE_KINDS = new Set(["unknown", "retail_sales", "retail_other", "wholesale_sales", "wholesale_other"]);
const EXCEPTION_MODELS = new Set(["unknown", "none_confirmed", "unsupported"]);
const AVERAGING_KEYS = new Set(["start", "end", "confirmed", "carryMinutes"]);
const BASIS_KEYS = [...PERIOD_KEYS].filter(key => key !== "confirmed");
const CONFLICT_KEYS = BASIS_KEYS.filter(key => ![
  "id", "validFrom", "validTo", "sourceReference", "agreementReference", "agreementConfirmedBy",
].includes(key));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function invalid() {
  // Rejected private values and references never enter public error messages.
  return Object.assign(new Error("Bitte gültige Angaben zur datierten KV-Zuordnung übermitteln."), {
    status: 400, code: "PERSONNEL_RETAIL_KV_INVALID",
  });
}

function record(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !own(descriptor, "value")) throw invalid();
  }
}

function periodsArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > 32 || Reflect.ownKeys(value).length !== value.length + 1) throw invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)
        || Number(key) >= value.length)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !own(descriptor, "value")) throw invalid();
  }
}

function strictDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function reference(value, { required = false, max = 80, id = false } = {}) {
  if (typeof value !== "string" || value.length > max || (value === "" ? required
    : !(id ? /^[A-Za-z0-9._-]+$/ : /^[A-Za-z0-9._:/-]+$/).test(value))) throw invalid();
  return value;
}
const field = (value, key, fallback) => own(value, key) ? value[key] : fallback;
const covers = (period, date) => period.validFrom <= date && (!period.validTo || date <= period.validTo);
const overlap = (left, right) => left.validFrom <= (right.validTo || "9999-12-31")
  && right.validFrom <= (left.validTo || "9999-12-31");
const same = (left, right, key) => key === "averagingPeriod"
  ? JSON.stringify(left[key]) === JSON.stringify(right[key]) : left[key] === right[key];

function normalizeAveragingPeriod(value, previous, context) {
  if (value === null) return null;
  record(value, AVERAGING_KEYS);
  if (!strictDate(value.start) || !strictDate(value.end) || value.end < value.start
      || (own(value, "confirmed") && typeof value.confirmed !== "boolean")) throw invalid();
  const carryMinutes = field(value, "carryMinutes", null);
  if (carryMinutes !== null && !Number.isSafeInteger(carryMinutes)) throw invalid();
  const next = { start: value.start, end: value.end, confirmed: false, carryMinutes };
  const old = previous?.averagingPeriod;
  const basisChanged = !old || ["start", "end", "carryMinutes"].some(key => next[key] !== old[key])
    || BASIS_KEYS.some(key => !["confirmed", "averagingPeriod", "workplaceConfirmed"].includes(key)
      && context[key] !== previous[key]);
  next.confirmed = own(value, "confirmed") ? value.confirmed : old?.confirmed === true;
  if (basisChanged && value.confirmed !== true) next.confirmed = false;
  if (next.confirmed && (context.normalWorkModel !== "durchrechnung26Weeks"
      || context.agreementStatus !== "documented" || !context.sourceReference
      || !context.agreementReference || !context.agreementConfirmedBy || !context.agreementValidFrom
      || context.agreementValidFrom > next.start
      || (context.agreementValidTo && context.agreementValidTo < next.end))) throw invalid();
  return next;
}

function normalizePeriod(value, previousById) {
  record(value, PERIOD_KEYS);
  const id = reference(value.id, { required: true, id: true });
  const group = field(value, "group", "unknown");
  const validTo = field(value, "validTo", "");
  if (!GROUPS.has(group) || !strictDate(value.validFrom)
      || (validTo !== "" && (!strictDate(validTo) || validTo < value.validFrom))) throw invalid();
  if (own(value, "confirmed") && typeof value.confirmed !== "boolean") throw invalid();
  const sourceVersion = field(value, "sourceVersion", "");
  const sourceSha256 = field(value, "sourceSha256", "");
  if (typeof sourceVersion !== "string" || !["", RETAIL_KV_SOURCE.id].includes(sourceVersion)
      || typeof sourceSha256 !== "string"
      || !["", RETAIL_KV_SOURCE.sha256].includes(sourceSha256)) throw invalid();
  const contractWeeklyMinutes = field(value, "contractWeeklyMinutes", null);
  if (contractWeeklyMinutes !== null && (typeof contractWeeklyMinutes !== "number"
      || !Number.isInteger(contractWeeklyMinutes) || contractWeeklyMinutes < 1
      || contractWeeklyMinutes > 2310)) throw invalid();
  const normalWorkModel = field(value, "normalWorkModel", "unknown");
  const agreementStatus = field(value, "agreementStatus", "unknown");
  if (!MODELS.has(normalWorkModel) || !AGREEMENT_STATUSES.has(agreementStatus)) throw invalid();
  const workplaceKind = field(value, "workplaceKind", "unknown");
  const exceptionModel = field(value, "exceptionModel", "unknown");
  if (!WORKPLACE_KINDS.has(workplaceKind) || !EXCEPTION_MODELS.has(exceptionModel)
      || (own(value, "workplaceConfirmed") && typeof value.workplaceConfirmed !== "boolean")) throw invalid();
  const agreementValidFrom = field(value, "agreementValidFrom", "");
  const agreementValidTo = field(value, "agreementValidTo", "");
  if ((agreementValidFrom !== "" && !strictDate(agreementValidFrom))
      || (agreementValidTo !== "" && !strictDate(agreementValidTo))
      || (agreementValidTo && (!agreementValidFrom || agreementValidTo < agreementValidFrom))) throw invalid();
  const next = {
    id, group, confirmed: false, validFrom: value.validFrom, validTo,
    sourceReference: reference(field(value, "sourceReference", "")),
    collectiveAgreementVersionId: reference(field(value, "collectiveAgreementVersionId", ""), { max: 160 }),
    approvedAssignmentId: reference(field(value, "approvedAssignmentId", ""), { max: 160 }),
    sourceVersion, sourceSha256, contractWeeklyMinutes, normalWorkModel, agreementStatus,
    agreementReference: reference(field(value, "agreementReference", "")),
    agreementValidFrom, agreementValidTo,
    agreementConfirmedBy: reference(field(value, "agreementConfirmedBy", "")),
    workplaceKind, workplaceConfirmed: false, exceptionModel, averagingPeriod: null,
  };
  const previous = previousById.get(id);
  next.workplaceConfirmed = own(value, "workplaceConfirmed") ? value.workplaceConfirmed : previous?.workplaceConfirmed === true;
  const workplaceChanged = !previous || ["id", "group", "validFrom", "validTo", "sourceReference",
    "workplaceKind", "exceptionModel"].some(key => next[key] !== previous[key]);
  if (workplaceChanged && value.workplaceConfirmed !== true) next.workplaceConfirmed = false;
  if (next.workplaceConfirmed && (workplaceKind === "unknown" || !next.sourceReference)) throw invalid();
  next.averagingPeriod = normalizeAveragingPeriod(field(value, "averagingPeriod", null), previous, next);
  const basisChanged = !previous || BASIS_KEYS.some(key => !same(next, previous, key));
  next.confirmed = own(value, "confirmed") ? value.confirmed : previous?.confirmed === true;
  if (basisChanged && value.confirmed !== true) next.confirmed = false;
  if (next.confirmed) {
    if (group === "unknown" || !next.sourceReference) throw invalid();
    if (group !== "not_applicable" && (!next.collectiveAgreementVersionId || !next.approvedAssignmentId
        || sourceVersion !== RETAIL_KV_SOURCE.id || sourceSha256 !== RETAIL_KV_SOURCE.sha256)) throw invalid();
    if (agreementStatus !== "unknown" && (!next.agreementReference || !agreementValidFrom
        || !next.agreementConfirmedBy)) throw invalid();
  }
  if (agreementStatus === "none_confirmed" && !next.agreementConfirmedBy) throw invalid();
  return next;
}

function normalizeRecord(value, previous) {
  record(value, RECORD_KEYS);
  if (own(value, "version") && value.version !== 1) throw invalid();
  if (own(value, "planningEnabled") && typeof value.planningEnabled !== "boolean") throw invalid();
  const input = field(value, "periods", previous?.periods || []);
  periodsArray(input);
  const previousById = new Map((previous?.periods || []).map(period => [period.id, period]));
  const ids = new Set();
  const periods = input.map(value => {
    const period = normalizePeriod(value, previousById);
    if (ids.has(period.id)) throw invalid();
    ids.add(period.id);
    return period;
  });
  for (let index = 0; index < periods.length; index++) {
    for (const other of periods.slice(index + 1)) {
      if (periods[index].confirmed && other.confirmed && overlap(periods[index], other)
          && CONFLICT_KEYS.some(key => !same(periods[index], other, key))) throw invalid();
    }
  }
  return { version: 1, planningEnabled: field(value, "planningEnabled", previous?.planningEnabled || false), periods };
}

// This atomic field belongs in the existing encrypted employment record. The
// binding IDs are proposed facts; only the server can verify real approvals.
function normalizeRetailKv(value, { previous = null } = {}) {
  if (value === undefined || value === null) return null;
  const normalizedPrevious = previous == null ? null : normalizeRecord(previous, null);
  return normalizeRecord(value, normalizedPrevious);
}

function resolveRetailKvPeriod(value, date) {
  if (!strictDate(date)) throw invalid();
  const result = { enabled: false, state: "unrecorded", reason: "unrecorded", period: null, sourceVerified: false };
  let normalized;
  try { normalized = normalizeRetailKv(value); }
  catch (error) {
    if (error.code !== "PERSONNEL_RETAIL_KV_INVALID") throw error;
    return { ...result, enabled: true, state: "unknown", reason: "invalid_record" };
  }
  if (!normalized) return result;
  if (!normalized.planningEnabled) return { ...result, state: "disabled", reason: "disabled" };
  const matches = normalized.periods.filter(period => covers(period, date));
  if (matches.length !== 1) return { ...result, enabled: true, state: "unknown",
    reason: matches.length ? "ambiguous_period" : "missing_period" };
  const period = matches[0];
  const resolved = { ...result, enabled: true, state: "unknown", reason: "unconfirmed_period", period };
  if (!period.confirmed || period.group === "unknown") return resolved;
  if (period.group === "not_applicable") return { ...resolved, state: "not_applicable", reason: "not_applicable" };
  const sourceVerified = period.sourceVersion === RETAIL_KV_SOURCE.id && period.sourceSha256 === RETAIL_KV_SOURCE.sha256
    && RETAIL_KV_SOURCE.validFrom <= date && date <= RETAIL_KV_SOURCE.validTo;
  return { ...resolved, sourceVerified, state: sourceVerified ? "confirmed" : "unknown",
    reason: sourceVerified ? "personal_facts_confirmed_binding_required" : "source_outside_validity" };
}

function projectRetailKvForDate(value, date, { assignmentVerified = false } = {}) {
  const resolved = resolveRetailKvPeriod(value, date);
  const period = resolved.period;
  const state = resolved.state === "confirmed" && assignmentVerified !== true ? "unknown" : resolved.state;
  const agreementApplicable = state === "confirmed" && period?.agreementStatus !== "unknown"
    && Boolean(period.agreementReference && period.agreementConfirmedBy && period.agreementValidFrom)
    && period.agreementValidFrom <= date && (!period.agreementValidTo || date <= period.agreementValidTo)
    && (period.normalWorkModel !== "durchrechnung26Weeks" || Boolean(period.agreementValidTo
      || (period.averagingPeriod?.confirmed && period.averagingPeriod.start && period.averagingPeriod.end)));
  // No personnel source reference, register ID, period ID, confirmer or private
  // validity range is copied into public planning facts or their receipts.
  return {
    date, enabled: resolved.enabled, state,
    employeeGroup: ["confirmed", "not_applicable"].includes(state) ? period.group : "unknown",
    contractWeeklyMinutes: state === "confirmed" ? period.contractWeeklyMinutes : null,
    normalWorkModel: state === "confirmed" ? period.normalWorkModel : "unknown",
    agreementStatus: state === "confirmed" ? period.agreementStatus : "unknown",
    agreementApplicable, sourceVerified: resolved.sourceVerified,
    workplaceFacts: state === "confirmed" ? {
      kind: period.workplaceKind, confirmed: period.workplaceConfirmed, exceptionModel: period.exceptionModel,
    } : { kind: "unknown", confirmed: false, exceptionModel: "unknown" },
    averagingPeriod: state === "confirmed" && agreementApplicable && period.averagingPeriod
      ? { ...period.averagingPeriod } : null,
  };
}

module.exports = { RETAIL_KV_SOURCE, normalizeRetailKv, resolveRetailKvPeriod, projectRetailKvForDate };

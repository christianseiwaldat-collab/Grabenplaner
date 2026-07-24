"use strict";

const { canonicalSha256 } = require("./work-rules/receipt");

const LEAVE_GOVERNANCE_VERSION = "at-leave-governance-2026.1";
const LEAVE_LEDGER_SCHEMA_VERSION = 1;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_TRANCHE_STATUSES = Object.freeze(["active", "manual_review", "closed", "invalidated"]);
const ALLOWED_LEAVE_YEAR_TYPES = Object.freeze(["work_year", "calendar_year", "other_agreed_year"]);

const OFFICIAL_LEAVE_SOURCES = deepFreeze([
  {
    id: "at-urlg-2",
    authority: "Republik Oesterreich",
    title: "Urlaubsgesetz (UrlG) - Paragraph 2",
    url: "https://ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008376&Paragraf=2",
    jurisdiction: "AT",
    reference: "Urlaubsausmass, Urlaubsjahr und erstes Arbeitsjahr",
    checkedAt: "2026-07-23",
  },
  {
    id: "at-urlg-4",
    authority: "Republik Oesterreich",
    title: "Urlaubsgesetz (UrlG) - Paragraph 4",
    url: "https://ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008376&Paragraf=4",
    jurisdiction: "AT",
    reference: "Urlaubsvereinbarung und Verjaehrung",
    checkedAt: "2026-07-23",
  },
  {
    id: "at-urlg-8",
    authority: "Republik Oesterreich",
    title: "Urlaubsgesetz (UrlG) - Paragraph 8",
    url: "https://ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008376&Paragraf=8",
    jurisdiction: "AT",
    reference: "Urlaubsaufzeichnungen",
    checkedAt: "2026-07-23",
  },
  {
    id: "at-ogh-8oba23-23z",
    authority: "Oberster Gerichtshof",
    title: "OGH 8 ObA 23/23z",
    url: "https://ris.bka.gv.at/Dokumente/Justiz/JJT_20230627_OGH0002_008OBA00023_23Z0000_000/JJT_20230627_OGH0002_008OBA00023_23Z0000_000.html",
    jurisdiction: "AT/EU",
    reference: "Mitwirkungs-, Aufforderungs- und Warnobliegenheit beim unionsrechtlichen Mindesturlaub",
    checkedAt: "2026-07-23",
  },
  {
    id: "at-ogh-8obs1-25t",
    authority: "Oberster Gerichtshof",
    title: "OGH 8 ObS 1/25t",
    url: "https://www.ris.bka.gv.at/Dokumente/Justiz/JJT_20250930_OGH0002_008OBS00001_25T0000_000/JJT_20250930_OGH0002_008OBS00001_25T0000_000.html",
    jurisdiction: "AT/EU",
    reference: "Trennung des unionsrechtlichen Mindesturlaubs vom nationalen Mehrurlaub und Verbrauch der ältesten offenen Tranche",
    checkedAt: "2026-07-23",
  },
]);

class LeaveGovernanceError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = "LeaveGovernanceError";
    this.code = code;
  }
}

function leaveError(message, code) {
  return new LeaveGovernanceError(message, code);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label, code = "LEAVE_OBJECT_INVALID") {
  if (!isPlainObject(value)) throw leaveError(`${label} must be a plain object.`, code);
  return value;
}

function assertExactKeys(value, allowed, label, code = "LEAVE_FIELDS_INVALID") {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw leaveError(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}.`, code);
  }
}

function requiredString(value, label, { maximum = 500, identifier = false } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || (identifier && !IDENTIFIER_PATTERN.test(normalized))) {
    throw leaveError(`${label} is invalid.`, "LEAVE_STRING_INVALID");
  }
  return normalized;
}

function optionalString(value, label, { maximum = 1000, identifier = false } = {}) {
  if (value === undefined || value === null || value === "") return "";
  return requiredString(value, label, { maximum, identifier });
}

function isoDate(value, label) {
  const normalized = String(value || "").trim();
  const match = DATE_PATTERN.exec(normalized);
  if (!match) throw leaveError(`${label} must use YYYY-MM-DD.`, "LEAVE_DATE_INVALID");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw leaveError(`${label} is not a valid calendar date.`, "LEAVE_DATE_INVALID");
  }
  return normalized;
}

function isoInstant(value, label) {
  const normalized = String(value || "").trim();
  if (!INSTANT_PATTERN.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw leaveError(`${label} must be an ISO 8601 timestamp with a timezone.`, "LEAVE_INSTANT_INVALID");
  }
  return normalized;
}

function enumValue(value, allowed, label) {
  const normalized = String(value || "").trim();
  if (!allowed.includes(normalized)) throw leaveError(`${label} is unsupported.`, "LEAVE_ENUM_INVALID");
  return normalized;
}

function integer(value, label, { minimum = 0, maximum = 100000 } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw leaveError(`${label} must be an integer between ${minimum} and ${maximum}.`, "LEAVE_INTEGER_INVALID");
  }
  return normalized;
}

function leaveDays(value, label, { allowZero = true } = {}) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < (allowZero ? 0 : 0.01) || normalized > 366) {
    throw leaveError(`${label} must be between ${allowZero ? 0 : 0.01} and 366 days.`, "LEAVE_DAYS_INVALID");
  }
  const hundredths = Math.round(normalized * 100);
  if (Math.abs(hundredths / 100 - normalized) > Number.EPSILON * 100) {
    throw leaveError(`${label} may use no more than two decimal places.`, "LEAVE_DAYS_INVALID");
  }
  return hundredths / 100;
}

function toUtcDate(value) {
  return new Date(`${value}T12:00:00.000Z`);
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value, amount) {
  const date = toUtcDate(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return formatDate(date);
}

function addYears(value, amount) {
  const source = toUtcDate(value);
  const month = source.getUTCMonth();
  const date = source.getUTCDate();
  const target = new Date(Date.UTC(source.getUTCFullYear() + amount, month, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), month + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(date, lastDay));
  return formatDate(target);
}

function addMonths(value, amount) {
  const source = toUtcDate(value);
  const targetMonth = source.getUTCMonth() + amount;
  const target = new Date(Date.UTC(source.getUTCFullYear(), targetMonth, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(source.getUTCDate(), lastDay));
  return formatDate(target);
}

function daysInclusive(from, to) {
  return Math.floor((toUtcDate(to) - toUtcDate(from)) / 86_400_000) + 1;
}

function jsonSnapshot(value, label = "Snapshot") {
  function normalize(current, path, depth) {
    if (depth > 20) throw leaveError(`${label} is nested too deeply at ${path}.`, "LEAVE_SNAPSHOT_INVALID");
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw leaveError(`${label} contains a non-finite number at ${path}.`, "LEAVE_SNAPSHOT_INVALID");
      return current;
    }
    if (Array.isArray(current)) {
      if (current.length > 10000) throw leaveError(`${label} contains too many entries.`, "LEAVE_SNAPSHOT_INVALID");
      return current.map((entry, index) => normalize(entry, `${path}[${index}]`, depth + 1));
    }
    if (!isPlainObject(current)) throw leaveError(`${label} contains an unsupported value at ${path}.`, "LEAVE_SNAPSHOT_INVALID");
    const result = {};
    for (const key of Object.keys(current)) {
      if (!key || key.length > 128 || current[key] === undefined) {
        throw leaveError(`${label} contains an invalid field at ${path}.`, "LEAVE_SNAPSHOT_INVALID");
      }
      result[key] = normalize(current[key], `${path}.${key}`, depth + 1);
    }
    return result;
  }
  return normalize(value, "$", 0);
}

function officialSourceMetadata() {
  return OFFICIAL_LEAVE_SOURCES.map((source) => ({ ...source }));
}

function withReceipt(value, kind) {
  const body = { ...value };
  delete body.receiptSha256;
  return {
    ...body,
    receiptSha256: canonicalSha256({
      schemaVersion: LEAVE_LEDGER_SCHEMA_VERSION,
      governanceVersion: LEAVE_GOVERNANCE_VERSION,
      kind,
      value: body,
    }),
  };
}

function previewFirstEmploymentYearEntitlement(input) {
  const value = assertPlainObject(input, "First-employment-year preview");
  assertExactKeys(
    value,
    new Set(["employmentStart", "asOf", "annualEntitlementDays", "leaveYearType"]),
    "First-employment-year preview",
  );
  const employmentStart = isoDate(value.employmentStart, "Employment start");
  const asOf = isoDate(value.asOf, "Preview date");
  const annualEntitlementDays = leaveDays(value.annualEntitlementDays, "Annual entitlement", { allowZero: false });
  const leaveYearType = enumValue(value.leaveYearType || "work_year", ALLOWED_LEAVE_YEAR_TYPES, "Leave-year type");
  const firstYearEnd = addDays(addYears(employmentStart, 1), -1);
  const sixMonthThreshold = addMonths(employmentStart, 6);
  let previewDays = 0;
  let method = "before_employment";
  let firstEmploymentYear = asOf <= firstYearEnd;
  if (asOf >= employmentStart && asOf < sixMonthThreshold) {
    const elapsed = daysInclusive(employmentStart, asOf);
    const daysInFirstYear = daysInclusive(employmentStart, firstYearEnd);
    previewDays = Math.floor((annualEntitlementDays * elapsed / daysInFirstYear) * 100) / 100;
    method = "conservative_daily_pro_rata_preview";
  } else if (asOf >= sixMonthThreshold) {
    previewDays = annualEntitlementDays;
    method = firstEmploymentYear ? "full_after_six_months" : "outside_first_employment_year";
  }
  return withReceipt({
    schemaVersion: LEAVE_LEDGER_SCHEMA_VERSION,
    governanceVersion: LEAVE_GOVERNANCE_VERSION,
    employmentStart,
    asOf,
    firstYearEnd,
    sixMonthThreshold,
    leaveYearType,
    annualEntitlementDays,
    previewDays,
    firstEmploymentYear,
    previewOnly: true,
    automaticGrant: false,
    manualReview: true,
    method,
    notice: "This is a conservative preview and must not create or reduce an entitlement automatically.",
    sourceIds: ["at-urlg-2"],
    sources: officialSourceMetadata().filter(({ id }) => id === "at-urlg-2"),
  }, "first_employment_year_preview");
}

function normalizeLeaveTranche(input) {
  const value = assertPlainObject(input, "Leave tranche");
  assertExactKeys(
    value,
    new Set([
      "id", "leaveYearStart", "leaveYearEnd", "grantedOn", "euMinimumDays", "nationalAdditionalDays",
      "consumedEuMinimumDays", "consumedNationalAdditionalDays", "parentalLeaveExtensionDays", "status",
    ]),
    "Leave tranche",
  );
  const leaveYearStart = isoDate(value.leaveYearStart, "Leave-year start");
  const leaveYearEnd = isoDate(value.leaveYearEnd, "Leave-year end");
  if (leaveYearEnd < leaveYearStart) throw leaveError("Leave-year end must not precede its start.", "LEAVE_TRANCHE_RANGE_INVALID");
  const euMinimumDays = leaveDays(value.euMinimumDays, "EU minimum leave");
  const nationalAdditionalDays = leaveDays(value.nationalAdditionalDays, "National additional leave");
  const consumedEuMinimumDays = leaveDays(value.consumedEuMinimumDays || 0, "Consumed EU minimum leave");
  const consumedNationalAdditionalDays = leaveDays(
    value.consumedNationalAdditionalDays || 0,
    "Consumed national additional leave",
  );
  if (consumedEuMinimumDays > euMinimumDays || consumedNationalAdditionalDays > nationalAdditionalDays) {
    throw leaveError("Consumed leave must not exceed its component.", "LEAVE_TRANCHE_OVERCONSUMED");
  }
  return {
    id: requiredString(value.id, "Tranche ID", { identifier: true }),
    leaveYearStart,
    leaveYearEnd,
    grantedOn: isoDate(value.grantedOn, "Grant date"),
    euMinimumDays,
    nationalAdditionalDays,
    consumedEuMinimumDays,
    consumedNationalAdditionalDays,
    parentalLeaveExtensionDays: integer(
      value.parentalLeaveExtensionDays || 0,
      "Parental-leave extension",
      { minimum: 0, maximum: 3650 },
    ),
    status: enumValue(value.status || "active", ALLOWED_TRANCHE_STATUSES, "Tranche status"),
  };
}

function normalizeEmployerEvidence(input = {}) {
  const value = assertPlainObject(input, "Employer evidence");
  assertExactKeys(
    value,
    new Set(["enablementProvided", "formalInvitationProvided", "timelyWarningProvided", "evidenceIds"]),
    "Employer evidence",
  );
  if (!Array.isArray(value.evidenceIds || []) || (value.evidenceIds || []).length > 100) {
    throw leaveError("Evidence IDs must be an array with at most 100 entries.", "LEAVE_EVIDENCE_INVALID");
  }
  const evidenceIds = (value.evidenceIds || []).map((entry) => requiredString(
    entry,
    "Evidence ID",
    { identifier: true },
  ));
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw leaveError("Evidence IDs must be unique.", "LEAVE_EVIDENCE_INVALID");
  }
  return {
    enablementProvided: value.enablementProvided === true,
    formalInvitationProvided: value.formalInvitationProvided === true,
    timelyWarningProvided: value.timelyWarningProvided === true,
    evidenceIds,
  };
}

function assessLeaveLimitation(input) {
  const value = assertPlainObject(input, "Limitation assessment");
  assertExactKeys(value, new Set(["tranche", "asOf", "employerEvidence"]), "Limitation assessment");
  const tranche = normalizeLeaveTranche(value.tranche);
  const asOf = isoDate(value.asOf, "Assessment date");
  const employerEvidence = normalizeEmployerEvidence(value.employerEvidence || {});
  const candidateOn = addDays(
    addYears(tranche.leaveYearEnd, 2),
    tranche.parentalLeaveExtensionDays + 1,
  );
  const limitationCandidate = asOf >= candidateOn;
  const missingEvidence = [];
  if (!employerEvidence.enablementProvided) missingEvidence.push("actual_enablement");
  if (!employerEvidence.formalInvitationProvided) missingEvidence.push("formal_invitation");
  if (!employerEvidence.timelyWarningProvided) missingEvidence.push("clear_timely_warning");
  let state = "not_due";
  if (limitationCandidate && missingEvidence.length) state = "manual_review";
  else if (limitationCandidate) state = "candidate_with_evidence";
  return withReceipt({
    schemaVersion: LEAVE_LEDGER_SCHEMA_VERSION,
    governanceVersion: LEAVE_GOVERNANCE_VERSION,
    trancheId: tranche.id,
    asOf,
    candidateOn,
    parentalLeaveExtensionDays: tranche.parentalLeaveExtensionDays,
    limitationCandidate,
    state,
    manualReview: limitationCandidate,
    automaticExpiry: false,
    missingEvidence,
    employerEvidence,
    componentNotice: "EU minimum leave and national additional leave remain separate; no component is expired automatically.",
    sourceIds: ["at-urlg-4", "at-ogh-8oba23-23z", "at-ogh-8obs1-25t"],
    sources: officialSourceMetadata().filter(({ id }) => [
      "at-urlg-4",
      "at-ogh-8oba23-23z",
      "at-ogh-8obs1-25t",
    ].includes(id)),
  }, "leave_limitation_assessment");
}

function allocateLeaveConsumption(input) {
  const value = assertPlainObject(input, "Leave allocation");
  assertExactKeys(value, new Set(["tranches", "amountDays", "asOf"]), "Leave allocation");
  if (!Array.isArray(value.tranches) || value.tranches.length > 1000) {
    throw leaveError("Tranches must be an array with at most 1000 entries.", "LEAVE_TRANCHES_INVALID");
  }
  const tranches = value.tranches.map(normalizeLeaveTranche);
  if (new Set(tranches.map(({ id }) => id)).size !== tranches.length) {
    throw leaveError("Tranche IDs must be unique.", "LEAVE_TRANCHE_DUPLICATE");
  }
  const amountDays = leaveDays(value.amountDays, "Leave to allocate", { allowZero: false });
  const asOf = isoDate(value.asOf, "Consumption date");
  const candidates = tranches
    .filter(({ status }) => status === "active" || status === "manual_review")
    .sort((left, right) => (
      left.leaveYearEnd.localeCompare(right.leaveYearEnd)
      || left.leaveYearStart.localeCompare(right.leaveYearStart)
      || left.id.localeCompare(right.id)
    ));
  let remainingHundredths = Math.round(amountDays * 100);
  const allocations = [];
  let manualReview = false;
  for (const tranche of candidates) {
    if (remainingHundredths <= 0) break;
    if (tranche.status === "manual_review") manualReview = true;
    for (const component of [
      ["eu_minimum", tranche.euMinimumDays, tranche.consumedEuMinimumDays],
      ["national_additional", tranche.nationalAdditionalDays, tranche.consumedNationalAdditionalDays],
    ]) {
      if (remainingHundredths <= 0) break;
      const availableHundredths = Math.round((component[1] - component[2]) * 100);
      if (availableHundredths <= 0) continue;
      const allocatedHundredths = Math.min(remainingHundredths, availableHundredths);
      allocations.push({
        trancheId: tranche.id,
        leaveYearStart: tranche.leaveYearStart,
        leaveYearEnd: tranche.leaveYearEnd,
        component: component[0],
        days: allocatedHundredths / 100,
      });
      remainingHundredths -= allocatedHundredths;
    }
  }
  return withReceipt({
    schemaVersion: LEAVE_LEDGER_SCHEMA_VERSION,
    governanceVersion: LEAVE_GOVERNANCE_VERSION,
    asOf,
    requestedDays: amountDays,
    allocatedDays: (Math.round(amountDays * 100) - remainingHundredths) / 100,
    unallocatedDays: remainingHundredths / 100,
    allocations,
    allocationRule: "oldest_valid_tranche_first_eu_component_first",
    manualReview,
    mutatesEntitlement: false,
    sourceIds: ["at-urlg-4", "at-ogh-8oba23-23z", "at-ogh-8obs1-25t"],
    sources: officialSourceMetadata().filter(({ id }) => [
      "at-urlg-4",
      "at-ogh-8oba23-23z",
      "at-ogh-8obs1-25t",
    ].includes(id)),
  }, "leave_consumption_allocation");
}

function ledgerReceiptBody(ledger) {
  const body = { ...ledger };
  delete body.receiptSha256;
  return body;
}

function ledgerReceipt(ledger) {
  return canonicalSha256({
    schemaVersion: LEAVE_LEDGER_SCHEMA_VERSION,
    governanceVersion: LEAVE_GOVERNANCE_VERSION,
    kind: "leave_ledger",
    ledger: ledgerReceiptBody(ledger),
  });
}

function createLeaveLedger(input) {
  const value = assertPlainObject(input, "Leave ledger");
  assertExactKeys(
    value,
    new Set(["ledgerId", "employeeId", "createdAt", "employmentStart", "annualEntitlementDays", "workingDaysPerWeek", "leaveYearType"]),
    "Leave ledger",
  );
  const ledger = {
    schemaVersion: LEAVE_LEDGER_SCHEMA_VERSION,
    governanceVersion: LEAVE_GOVERNANCE_VERSION,
    ledgerId: requiredString(value.ledgerId, "Ledger ID", { identifier: true }),
    employeeId: requiredString(value.employeeId, "Employee ID", { identifier: true }),
    revision: 1,
    createdAt: isoInstant(value.createdAt, "Ledger creation time"),
    employmentStart: isoDate(value.employmentStart, "Employment start"),
    annualEntitlementDays: leaveDays(value.annualEntitlementDays, "Annual entitlement"),
    workingDaysPerWeek: integer(value.workingDaysPerWeek, "Working days per week", { minimum: 1, maximum: 7 }),
    leaveYearType: enumValue(value.leaveYearType || "work_year", ALLOWED_LEAVE_YEAR_TYPES, "Leave-year type"),
    previousReceiptSha256: null,
    entries: [],
    sources: officialSourceMetadata(),
  };
  return { ...ledger, receiptSha256: ledgerReceipt(ledger) };
}

function normalizeLedgerEntry(input, expectedEmployeeId, expectedSequence, previousEntrySha256) {
  const value = assertPlainObject(input, "Leave ledger entry");
  assertExactKeys(
    value,
    new Set(["entryId", "kind", "effectiveDate", "recordedAt", "actorId", "snapshot", "supersedesEntryId"]),
    "Leave ledger entry",
  );
  const body = {
    entryId: requiredString(value.entryId, "Entry ID", { identifier: true }),
    sequence: expectedSequence,
    employeeId: expectedEmployeeId,
    kind: requiredString(value.kind, "Entry kind", { identifier: true }),
    effectiveDate: isoDate(value.effectiveDate, "Effective date"),
    recordedAt: isoInstant(value.recordedAt, "Recorded time"),
    actorId: requiredString(value.actorId, "Actor ID", { identifier: true }),
    supersedesEntryId: optionalString(value.supersedesEntryId, "Superseded entry ID", { identifier: true }),
    snapshot: jsonSnapshot(value.snapshot, "Leave entry snapshot"),
    previousEntrySha256,
  };
  return {
    ...body,
    entrySha256: canonicalSha256({
      schemaVersion: LEAVE_LEDGER_SCHEMA_VERSION,
      governanceVersion: LEAVE_GOVERNANCE_VERSION,
      kind: "leave_ledger_entry",
      entry: body,
    }),
  };
}

function normalizeStoredLedger(input) {
  const value = assertPlainObject(input, "Stored leave ledger");
  const expectedKeys = new Set([
    "schemaVersion", "governanceVersion", "ledgerId", "employeeId", "revision", "createdAt", "employmentStart",
    "annualEntitlementDays", "workingDaysPerWeek", "leaveYearType", "previousReceiptSha256", "entries", "sources",
    "receiptSha256",
  ]);
  assertExactKeys(value, expectedKeys, "Stored leave ledger");
  if (value.schemaVersion !== LEAVE_LEDGER_SCHEMA_VERSION || value.governanceVersion !== LEAVE_GOVERNANCE_VERSION) {
    throw leaveError("The leave-ledger version is unsupported.", "LEAVE_LEDGER_VERSION_INVALID");
  }
  if (!Array.isArray(value.entries) || !Array.isArray(value.sources)) {
    throw leaveError("Stored ledger entries and sources must be arrays.", "LEAVE_LEDGER_INVALID");
  }
  return value;
}

function verifyLeaveLedger(input) {
  try {
    const ledger = normalizeStoredLedger(input);
    if (!SHA256_PATTERN.test(String(ledger.receiptSha256 || "")) || ledger.receiptSha256 !== ledgerReceipt(ledger)) return false;
    if (ledger.revision !== ledger.entries.length + 1) return false;
    let previous = null;
    const ids = new Set();
    for (let index = 0; index < ledger.entries.length; index += 1) {
      const entry = ledger.entries[index];
      if (!isPlainObject(entry) || ids.has(entry.entryId)) return false;
      if (entry.sequence !== index + 1 || entry.employeeId !== ledger.employeeId || entry.previousEntrySha256 !== previous) return false;
      const body = { ...entry };
      delete body.entrySha256;
      const expected = canonicalSha256({
        schemaVersion: LEAVE_LEDGER_SCHEMA_VERSION,
        governanceVersion: LEAVE_GOVERNANCE_VERSION,
        kind: "leave_ledger_entry",
        entry: body,
      });
      if (!SHA256_PATTERN.test(String(entry.entrySha256 || "")) || entry.entrySha256 !== expected) return false;
      if (entry.supersedesEntryId && !ids.has(entry.supersedesEntryId)) return false;
      ids.add(entry.entryId);
      previous = entry.entrySha256;
    }
    return true;
  } catch {
    return false;
  }
}

function appendLeaveLedgerSnapshot(inputLedger, inputEntry) {
  const ledger = normalizeStoredLedger(inputLedger);
  if (!verifyLeaveLedger(ledger)) throw leaveError("The current leave ledger failed receipt verification.", "LEAVE_LEDGER_TAMPERED");
  if (ledger.entries.some(({ entryId }) => entryId === inputEntry?.entryId)) {
    throw leaveError("Leave-ledger entry IDs must be unique.", "LEAVE_ENTRY_DUPLICATE");
  }
  if (inputEntry?.supersedesEntryId && !ledger.entries.some(({ entryId }) => entryId === inputEntry.supersedesEntryId)) {
    throw leaveError("A superseded entry must already exist in this ledger.", "LEAVE_SUPERSEDE_TARGET_INVALID");
  }
  const previousEntrySha256 = ledger.entries.at(-1)?.entrySha256 || null;
  const entry = normalizeLedgerEntry(inputEntry, ledger.employeeId, ledger.entries.length + 1, previousEntrySha256);
  const next = {
    ...ledgerReceiptBody(ledger),
    revision: ledger.revision + 1,
    previousReceiptSha256: ledger.receiptSha256,
    entries: [...ledger.entries.map((item) => jsonSnapshot(item)), entry],
  };
  return { ...next, receiptSha256: ledgerReceipt(next) };
}

module.exports = {
  ALLOWED_LEAVE_YEAR_TYPES,
  LEAVE_GOVERNANCE_VERSION,
  LEAVE_LEDGER_SCHEMA_VERSION,
  LeaveGovernanceError,
  OFFICIAL_LEAVE_SOURCES,
  allocateLeaveConsumption,
  appendLeaveLedgerEntry: appendLeaveLedgerSnapshot,
  appendLeaveLedgerSnapshot,
  assessLeaveLimitation,
  createLeaveLedger,
  normalizeLeaveTranche,
  officialSourceMetadata,
  previewFirstEmploymentYearEntitlement,
  verifyLeaveLedger,
};

"use strict";

const { normalizeRetailKv, resolveRetailKvPeriod, projectRetailKvForDate, RETAIL_KV_SOURCE } = require("../personnel-retail-kv");
const { addDays, mondayOfWeek } = require("./calendar");
const { strictIsoDate } = require("./vocational-school");
const { canonicalJson, canonicalSha256 } = require("./receipt");
const { getWorkRuleProfileVersion, recordWorkRuleEvaluation, versionSnapshot } = require("./store");
const { loadRetailKvBindingSnapshot, resolveRetailKvApproval } = require("./retail-kv-binding");
const { RETAIL_KV_PROFILE, RETAIL_KV_RULES, RETAIL_KV_SOURCES, evaluateRetailKvPlanning } = require("./retail-kv");

const QUERY_RANGE = Object.freeze({ start: "0001-01-01", end: "9999-12-31" });
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ordered = rows => rows.map(row => ({ row, key: canonicalJson(row) }))
  .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(value => value.row);
function invalid() { return new TypeError("Die KV-Änderung benötigt vollständige gebundene Prüfdaten."); }

function assertCiphertext(value) {
  if (typeof value !== "string" || !/^enc:v2:[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const payload = Buffer.from(value.slice(7), "base64url");
  if (!payload[0] || payload.length <= 1 + payload[0] + 12 + 16
      || payload.toString("base64url") !== value.slice(7)) throw invalid();
}

function assertBound(repositories) {
  const required = {
    absenceManagement: ["shiftsForTimeOffRange"],
    planningSettings: ["listGlobalDayBlocks", "listOverlappingWeekOptions"],
    workRules: ["getProfileVersion", "getProfileVersionHash", "insertEvaluation", "getEvaluation"],
    workRuleGovernance: ["allCollectiveAssignmentEvents", "collectiveAssignment", "businessUnitScopes"],
    collectiveAgreements: ["listVersions", "listAssignments", "getScopeTarget"],
    organizationPersonnel: ["getPersonnelSensitiveRecord"],
  };
  for (const [name, methods] of Object.entries(required)) {
    if (methods.some(method => typeof repositories?.[name]?.[method] !== "function")
        || (name !== "collectiveAgreements" && typeof repositories[name].transaction === "function")) throw invalid();
    // This existing factory exposes a transaction method even on bound read
    // access. It is never called here; the caller must supply its bound reader.
  }
}

function currentMonday() {
  return mondayOfWeek(new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date()));
}

function shiftFact(value, raw, employeeNumber) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || String(value.id) !== String(raw.id) || value.employeeId !== employeeNumber
      || value.date !== raw.shift_date || !strictIsoDate(value.date)
      || !TIME.test(value.startTime) || !TIME.test(value.endTime)) throw invalid();
  const locationId = String(value.locationId ?? raw.location_id ?? "");
  const departmentId = value.departmentId ?? raw.department_id ?? null;
  if (!locationId || locationId !== String(raw.location_id || "")
      || String(departmentId || "") !== String(raw.department_id || "")) throw invalid();
  const result = { id: String(value.id), employeeId: employeeNumber, date: value.date,
    startTime: value.startTime, endTime: value.endTime, breakMinutes: value.breakMinutes ?? null,
    breakSource: value.breakSource || "none", locationId, departmentId };
  if (value.breakIntervals !== undefined) {
    if (!Array.isArray(value.breakIntervals)) throw invalid();
    result.breakIntervals = value.breakIntervals.map(interval => ({ startTime: interval?.startTime, endTime: interval?.endTime }));
  }
  return result;
}

function boundaryWeeks(recorded, weeks) {
  for (const period of recorded?.periods || []) {
    const intervals = [{ start: period.validFrom, end: period.validTo },
      { start: period.agreementValidFrom, end: period.agreementValidTo }, period.averagingPeriod];
    for (const interval of intervals) {
      if (interval?.start) weeks.add(mondayOfWeek(interval.start));
      if (interval?.end) {
        weeks.add(mondayOfWeek(interval.end));
        const following = addDays(interval.end, 1);
        if (!strictIsoDate(following)) throw invalid();
        weeks.add(mondayOfWeek(following));
      }
    }
  }
}

function publicFinding(value, employeeNumber) {
  const ruleIds = new Set(Object.keys(RETAIL_KV_RULES));
  if (!ruleIds.has(value.ruleId) && value.ruleId !== "at.input.shift") throw invalid();
  const scope = {};
  for (const key of ["type", "date", "weekStart", "weekEnd", "start", "end", "from", "to", "windowWeeks", "shiftId", "employeeId", "dates"]) {
    if (value.scope?.[key] !== undefined) scope[key] = value.scope[key];
  }
  const evidence = { enforcementBasis: "controlled_retail_kv_monitor", coverageBasis: "declared_planned_schedule" };
  for (const key of ["metric", "actualMinutes", "normalMinutes", "maximumMinutes", "threshold", "completeWeek",
    "completePeriod", "coveredDays", "requiredDays", "reviewRequired", "plannedShiftCount", "state", "date",
    "normalWorkModel", "agreementStatus", "agreementApplicable", "sourceVerified", "coverageConfirmed",
    "classification", "previousSaturday", "currentSaturday", "actualDays", "maximumDays", "carryMinutes",
    "applicabilityConfirmed", "notApplicable", "standardModel", "averagingModel", "normalTimeClassificationOnly",
    "redistributionProved", "workingDayBoundaryReview", "normalTimeEnd", "latePlannedWork", "nationalHoliday",
    "precedingSaturday", "followingSaturday", "nextSaturdayShiftCount", "defaultModelConfirmed",
    "futureCoverageConfirmed", "christmasExceptionReview", "contractMinutes", "agreementConfirmed", "agreedTimely",
    "sundayFree", "otherWholeCalendarDayFree", "saturday18ToMonday07Free", "existingYouthProtectionUnchanged",
    "standardRestMinutes", "compensationReviewRequired", "actualMinutesPerWeek", "maximumMinutesPerWeek",
    "unquantifiedAdditionalWork", "schoolReview", "additionalWorkReview"]) {
    if (value.evidence?.[key] !== undefined) evidence[key] = value.evidence[key];
  }
  const core = { ruleId: value.ruleId, profileId: RETAIL_KV_PROFILE.id, profileVersion: RETAIL_KV_PROFILE.version,
    state: value.state, severity: value.severity, baseEnforcement: value.baseEnforcement,
    effectiveEnforcement: value.effectiveEnforcement, message: value.message, scope, evidence,
    sourceRefs: [], employeeNumber };
  return { ...core, fingerprint: canonicalSha256(core) };
}

// Runs only on repositories bound to the caller's already active SERIALIZABLE
// personnel transaction. A failed receipt write must roll back that same write.
async function recordRetailKvChange(repositories, {
  employeeNumber, previousStatus, status, protectedPayload, actor, normalizeShifts, employee = {},
} = {}) {
  const previous = normalizeRetailKv(previousStatus);
  const next = normalizeRetailKv(status);
  if (!(previous?.planningEnabled || next?.planningEnabled) || canonicalJson(previous) === canonicalJson(next)) return [];
  assertBound(repositories);
  if (typeof employeeNumber !== "string" || !employeeNumber.trim()
      || /[\u0000-\u001f\u007f]/.test(employeeNumber) || typeof normalizeShifts !== "function") throw invalid();
  assertCiphertext(protectedPayload);
  const protectedRecord = await repositories.organizationPersonnel.getPersonnelSensitiveRecord(employeeNumber);
  if (protectedRecord?.protected_payload !== protectedPayload) throw invalid();
  const raw = await repositories.absenceManagement.shiftsForTimeOffRange({ employeeNumber,
    dateFrom: QUERY_RANGE.start, dateTo: QUERY_RANGE.end });
  if (!Array.isArray(raw) || raw.some(row => !row || !strictIsoDate(row.shift_date)
      || String(row.employee_number) !== employeeNumber)) throw invalid();
  const normalized = await normalizeShifts(raw, repositories);
  if (!Array.isArray(normalized) || normalized.length !== raw.length) throw invalid();
  const rawById = new Map(raw.map(row => [String(row.id), row]));
  if (rawById.size !== raw.length) throw invalid();
  const ids = new Set();
  const shifts = ordered(normalized.map(value => {
    const id = String(value?.id);
    if (!rawById.has(id) || ids.has(id)) throw invalid();
    ids.add(id);
    return shiftFact(value, rawById.get(id), employeeNumber);
  }));
  const weeks = new Set(shifts.map(shift => mondayOfWeek(shift.date)));
  for (const shift of shifts) if (shift.endTime <= shift.startTime) weeks.add(mondayOfWeek(addDays(shift.date, 1)));
  boundaryWeeks(previous, weeks); boundaryWeeks(next, weeks);
  if (!shifts.length) weeks.add(currentMonday());
  const weekStarts = [...weeks].sort();
  if (weekStarts.some(week => !strictIsoDate(week) || !strictIsoDate(addDays(week, 6)))) throw invalid();
  const versionId = `${RETAIL_KV_PROFILE.id}@${RETAIL_KV_PROFILE.version}`;
  const expectedHash = canonicalSha256(versionSnapshot(RETAIL_KV_PROFILE,
    Object.values(RETAIL_KV_RULES), Object.values(RETAIL_KV_SOURCES)));
  const version = await getWorkRuleProfileVersion(repositories.workRules, versionId);
  if (!version || version.profile.id !== RETAIL_KV_PROFILE.id || version.profile.version !== RETAIL_KV_PROFILE.version
      || version.profile.status !== "active" || version.layer !== "collective_agreement"
      || version.contentSha256 !== expectedHash
      || !version.sources.some(source => source.id === RETAIL_KV_SOURCE.id && source.sha256 === RETAIL_KV_SOURCE.sha256)) throw invalid();
  const binding = await loadRetailKvBindingSnapshot({ collectiveAgreements: repositories.collectiveAgreements,
    governance: repositories.workRuleGovernance, workRuleStore: repositories.workRules },
  { expectedProfileVersionId: versionId, expectedProfileContentSha256: expectedHash });
  const blocks = await repositories.planningSettings.listGlobalDayBlocks();
  if (!Array.isArray(blocks)) throw invalid();
  const options = await repositories.planningSettings.listOverlappingWeekOptions({ employeeNumber,
    dateFrom: QUERY_RANGE.start, dateTo: QUERY_RANGE.end, existingId: 0, excludedGroupId: null });
  if (!Array.isArray(options)) throw invalid();
  const schoolAttendance = ordered(options.filter(option => option.option_type === "vocational_school").map(option => {
    if (String(option.employee_number) !== employeeNumber || !strictIsoDate(option.date_from)
        || !strictIsoDate(option.date_to) || option.date_to < option.date_from) throw invalid();
    return { employeeId: employeeNumber, dateFrom: option.date_from, dateTo: option.date_to };
  }));
  const additionalWorkEvents = ordered(options.filter(option => ["vocational_school", "school", "branch",
    "external_appointment", "team_meeting", "other"].includes(option.option_type)).map(option => {
    if (String(option.employee_number) !== employeeNumber || !strictIsoDate(option.date_from)
        || !strictIsoDate(option.date_to) || option.date_to < option.date_from) throw invalid();
    return { employeeId: employeeNumber, dateFrom: option.date_from, dateTo: option.date_to, type: option.option_type };
  }));
  const locationIds = new Set(shifts.map(shift => shift.locationId));
  const holidays = [...new Set(blocks.filter(block => block.is_public_holiday
    && locationIds.has(String(block.location_id || "01"))).map(block => block.block_date))].sort();
  if (holidays.some(date => !strictIsoDate(date))) throw invalid();
  const ruleEmployee = { id: employeeNumber };
  for (const key of ["birthDate", "birthDateConfirmed", "apprenticeshipStatus", "apprenticeshipConfirmed",
    "apprenticeshipValidFrom", "apprenticeshipValidTo", "apprenticeshipSourceReference"]) {
    if (employee[key] !== undefined) ruleEmployee[key] = employee[key];
  }
  const assessments = [];
  for (const weekStart of weekStarts) {
    const weekEnd = addDays(weekStart, 6);
    const from = addDays(weekStart, -183), to = addDays(weekEnd, 183);
    const applicability = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const resolved = resolveRetailKvPeriod(next, date);
      const contexts = shifts.filter(shift => shift.date === date
        || (shift.endTime <= shift.startTime && addDays(shift.date, 1) === date))
        .map(shift => ({ locationId: shift.locationId, departmentId: shift.departmentId }));
      const approval = resolveRetailKvApproval(binding, resolved.period, date, contexts);
      applicability.push(projectRetailKvForDate(next, date, { assignmentVerified: approval.verified }));
    }
    const evaluated = evaluateRetailKvPlanning({ applicability, shifts, employee: ruleEmployee, schoolAttendance, additionalWorkEvents,
      holidays, calendarScope: { start: weekStart, end: weekEnd },
      planningCoverage: { ...QUERY_RANGE, complete: true }, timeZone: "Europe/Vienna" });
    const findings = evaluated.findings.map(value => publicFinding(value, employeeNumber));
    const outcome = findings.some(value => value.state === "unknown") ? "manual_review"
      : findings.some(value => value.state === "fail") ? "attention" : "pass";
    const counts = { pass: 0, attention: 0, manualReview: 0, blocked: 0 };
    counts[outcome === "manual_review" ? "manualReview" : outcome] = 1;
    const assessment = { engineVersion: evaluated.engineVersion, catalogVersion: RETAIL_KV_PROFILE.catalogVersion,
      targetType: "planned_schedule", mode: "monitor", outcome, periodFrom: weekStart, periodTo: weekEnd,
      evaluatedEmployees: 1, counts, profiles: [{ id: RETAIL_KV_PROFILE.id, version: RETAIL_KV_PROFILE.version,
        versionId, name: "Handelsangestellte und Lehrlinge · KV-Planprüfung (Monitor)" }], findings, sources: [],
      disclaimer: "Die Prüfung bewertet die aktiv modellierten KV-Planungsregeln und ersetzt keine fachliche Planfreigabe." };
    const result = { ...assessment, employeeResults: [{ employeeNumber, profileVersionIds: [versionId],
      result: { profile: { id: RETAIL_KV_PROFILE.id, version: RETAIL_KV_PROFILE.version }, findings,
        summary: { state: outcome === "manual_review" ? "unknown" : outcome === "attention" ? "fail" : "pass" } } }] };
    const inputSha256 = canonicalSha256({ schemaVersion: 1, employeeNumber,
      protectedPayloadSha256: canonicalSha256(protectedPayload), bindingInputSha256: binding.inputSha256,
      profileContentSha256: expectedHash, employee: ruleEmployee, applicability,
      shifts, schoolAttendance, additionalWorkEvents, holidays, queryRange: QUERY_RANGE, calendarScope: { start: weekStart, end: weekEnd } });
    await recordWorkRuleEvaluation(repositories.workRules, { targetType: "planned_schedule",
      scopeType: "employee", scopeKey: employeeNumber, periodFrom: weekStart, periodTo: weekEnd,
      profileVersionIds: [versionId], inputSha256, result, outcome, actor });
    assessments.push(assessment);
  }
  return assessments;
}

module.exports = { recordRetailKvChange };

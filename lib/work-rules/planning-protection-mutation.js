"use strict";

const { normalizeProtectionStatus } = require("../personnel-protection-status");
const { addDays, mondayOfWeek } = require("./calendar");
const { strictIsoDate } = require("./vocational-school");
const { canonicalJson, canonicalSha256 } = require("./receipt");
const { evaluatePlannedSchedule } = require("./evaluator");
const { PLANNING_PROTECTION_PROFILE, projectPlanningProtection } = require("./planning-protection");
const { getWorkRuleProfileVersion, recordWorkRuleEvaluation } = require("./store");

function invalid() {
  return new TypeError("Die Änderung der geschützten Planungsauflagen benötigt vollständige gebundene Prüfdaten.");
}

function ordered(rows) {
  return rows.map(row => ({ row, key: canonicalJson(row) }))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0).map(({ row }) => row);
}

function assertCiphertext(value) {
  if (typeof value !== "string" || !/^enc:v2:[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const payload = Buffer.from(value.slice(7), "base64url");
  // Match the existing protected-record envelope: key-id length, key-id,
  // random 12-byte IV, 16-byte authentication tag and encrypted JSON bytes.
  if (!payload[0] || payload.length <= 1 + payload[0] + 12 + 16
      || payload.toString("base64url") !== value.slice(7)) throw invalid();
}

function assertBoundRepositories(repositories) {
  const required = {
    absenceManagement: ["shiftsForTimeOffRange"],
    planningSettings: ["listGlobalDayBlocks", "listOverlappingWeekOptions"],
    workRules: ["getProfileVersion", "getProfileVersionHash", "insertEvaluation", "getEvaluation"],
  };
  for (const [name, methods] of Object.entries(required)) {
    if (methods.some(method => typeof repositories?.[name]?.[method] !== "function")) throw invalid();
    // A bound repository has no transaction starter. Do not let the receipt
    // helper silently open a second transaction outside the caller's write.
    if (typeof repositories[name].transaction === "function") throw invalid();
  }
}

function currentMonday() {
  const date = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return mondayOfWeek(date);
}

function knownShiftFacts(value, raw, employeeNumber) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || String(value.id) !== String(raw.id) || value.employeeId !== employeeNumber
      || value.date !== raw.shift_date || !strictIsoDate(value.date)
      || typeof value.startTime !== "string" || typeof value.endTime !== "string") throw invalid();
  const result = { id: String(value.id), employeeId: employeeNumber, date: value.date,
    startTime: value.startTime, endTime: value.endTime,
    breakMinutes: value.breakMinutes ?? null, breakSource: value.breakSource || "none",
    locationId: String(value.locationId ?? raw.location_id ?? ""),
    departmentId: value.departmentId ?? raw.department_id ?? null };
  if (value.breakIntervals !== undefined) {
    if (!Array.isArray(value.breakIntervals)) throw invalid();
    result.breakIntervals = value.breakIntervals.map(interval => ({
      startTime: interval?.startTime, endTime: interval?.endTime,
    }));
  }
  return result;
}

function neutralFinding(finding, employeeNumber) {
  if (!(String(finding.ruleId).startsWith("at.protection.") || finding.ruleId === "at.input.shift")) throw invalid();
  const scope = {};
  for (const key of ["type", "date", "weekStart", "weekEnd", "start", "end", "shiftId", "employeeId"]) {
    if (finding.scope?.[key] !== undefined) scope[key] = finding.scope[key];
  }
  const evidence = { enforcementBasis: "controlled_protection_monitor" };
  for (const key of ["metric", "coverageConfirmed", "actualMinutes", "maximumMinutes", "completeWeek",
    "plannedShiftCount", "earliestStart", "latestEnd", "date", "reviewRequired"]) {
    if (finding.evidence?.[key] !== undefined) evidence[key] = finding.evidence[key];
  }
  const core = { ruleId: finding.ruleId, profileId: PLANNING_PROTECTION_PROFILE.id,
    profileVersion: PLANNING_PROTECTION_PROFILE.version, state: finding.state,
    severity: finding.severity, baseEnforcement: finding.baseEnforcement,
    effectiveEnforcement: finding.effectiveEnforcement, message: finding.message,
    scope, evidence, sourceRefs: [], employeeNumber };
  return { ...core, fingerprint: canonicalSha256(core) };
}

// The caller has already written the encrypted field and its neutral audit
// inside a SERIALIZABLE transaction. Only that transaction's repositories may
// be supplied here; every failed receipt write propagates to its rollback.
async function recordPlanningProtectionChange(repositories, {
  employeeNumber, previousStatus, status, protectedPayload, actor, normalizeShifts,
} = {}) {
  const previous = normalizeProtectionStatus(previousStatus);
  const next = normalizeProtectionStatus(status);
  if (!(previous?.planningEnabled || next?.planningEnabled)
      || canonicalJson(previous) === canonicalJson(next)) return [];
  assertBoundRepositories(repositories);
  if (typeof employeeNumber !== "string" || !employeeNumber.trim()
      || /[\u0000-\u001f\u007f]/.test(employeeNumber) || typeof normalizeShifts !== "function") throw invalid();
  assertCiphertext(protectedPayload);
  const rawShifts = await repositories.absenceManagement.shiftsForTimeOffRange({
    employeeNumber, dateFrom: "0001-01-01", dateTo: "9999-12-31",
  });
  if (!Array.isArray(rawShifts) || rawShifts.some(row => !row || !strictIsoDate(row.shift_date)
      || String(row.employee_number) !== employeeNumber)) throw invalid();
  const normalized = await normalizeShifts(rawShifts, repositories);
  if (!Array.isArray(normalized) || normalized.length !== rawShifts.length) throw invalid();
  const rawById = new Map(rawShifts.map(row => [String(row.id), row]));
  if (rawById.size !== rawShifts.length) throw invalid();
  const normalizedIds = new Set();
  const shifts = ordered(normalized.map(row => {
    const id = String(row?.id), raw = rawById.get(id);
    if (!raw || normalizedIds.has(id)) throw invalid();
    normalizedIds.add(id);
    return knownShiftFacts(row, raw, employeeNumber);
  }));
  const weeks = new Set(shifts.map(shift => mondayOfWeek(shift.date)));
  for (const shift of shifts) {
    if (shift.endTime <= shift.startTime) weeks.add(mondayOfWeek(addDays(shift.date, 1)));
  }
  for (const recorded of [previous, next]) {
    const earliest = recorded?.periods.map(period => period.validFrom).sort()[0];
    if (earliest) weeks.add(mondayOfWeek(earliest));
  }
  if (!shifts.length) weeks.add(currentMonday());
  const weekStarts = [...weeks].sort();
  if (weekStarts.some(week => !strictIsoDate(week) || !strictIsoDate(addDays(week, 6)))) throw invalid();
  const versionId = `${PLANNING_PROTECTION_PROFILE.id}@${PLANNING_PROTECTION_PROFILE.version}`;
  const version = await getWorkRuleProfileVersion(repositories.workRules, versionId);
  if (!version || version.profile.id !== PLANNING_PROTECTION_PROFILE.id
      || version.profile.version !== PLANNING_PROTECTION_PROFILE.version
      || version.profile.status !== "active") throw invalid();
  const blocks = await repositories.planningSettings.listGlobalDayBlocks();
  if (!Array.isArray(blocks)) throw invalid();
  const assessments = [];
  for (const weekStart of weekStarts) {
    const weekEnd = addDays(weekStart, 6);
    // Include Sunday's carryover into Monday. The evaluator clips daily facts
    // to its explicit full-week range, while counting every planned location.
    const weekShifts = shifts.filter(shift => shift.date >= addDays(weekStart, -1) && shift.date <= weekEnd);
    const locationIds = new Set(weekShifts.map(shift => shift.locationId));
    const holidays = [...new Set(blocks.filter(block => block.is_public_holiday
      && locationIds.has(String(block.location_id || "01"))
      && block.block_date >= weekStart && block.block_date <= weekEnd).map(block => block.block_date))].sort();
    const options = await repositories.planningSettings.listOverlappingWeekOptions({
      employeeNumber, dateFrom: weekStart, dateTo: weekEnd, existingId: 0, excludedGroupId: null,
    });
    if (!Array.isArray(options)) throw invalid();
    const schoolAttendance = ordered(options.filter(option => option.option_type === "vocational_school").map(option => {
      if (String(option.employee_number) !== employeeNumber || !strictIsoDate(option.date_from)
          || !strictIsoDate(option.date_to) || option.date_to < option.date_from) throw invalid();
      return { employeeId: employeeNumber, dateFrom: option.date_from, dateTo: option.date_to };
    }));
    const planningProtection = projectPlanningProtection(next, { scopeFrom: weekStart, scopeTo: weekEnd });
    const evaluated = evaluatePlannedSchedule({ basis: "planned_schedule", profile: version.profile,
      ruleDefinitions: version.rules, sourceCatalog: version.sources, enforcementMode: "monitor",
      employee: { id: employeeNumber }, planningProtection, shifts: weekShifts,
      schoolAttendance, rangeStart: weekStart, rangeEnd: weekEnd, holidays, timeZone: "Europe/Vienna" });
    const findings = evaluated.findings.map(finding => neutralFinding(finding, employeeNumber));
    const outcome = findings.some(finding => finding.state === "unknown") ? "manual_review"
      : findings.some(finding => finding.state === "fail") ? "attention" : "pass";
    const counts = { pass: 0, attention: 0, manualReview: 0, blocked: 0 };
    counts[outcome === "manual_review" ? "manualReview" : outcome] = 1;
    const assessment = { engineVersion: evaluated.engineVersion, catalogVersion: version.profile.catalogVersion,
      targetType: "planned_schedule", mode: "monitor", outcome, periodFrom: weekStart, periodTo: weekEnd,
      evaluatedEmployees: 1, counts, profiles: [{ id: version.profile.id, version: version.profile.version,
        versionId, name: "Individuelle Planungsauflagen (Monitor)" }], findings, sources: [],
      disclaimer: "Die Prüfung bewertet die aktiv modellierten Planungsauflagen und ersetzt keine fachliche Einsatzfreigabe." };
    const result = { ...assessment, employeeResults: [{ employeeNumber, profileVersionIds: [versionId],
      result: { profile: { id: version.profile.id, version: version.profile.version }, findings,
        summary: { state: outcome === "manual_review" ? "unknown" : outcome === "attention" ? "fail" : "pass" } } }] };
    const inputSha256 = canonicalSha256({ schemaVersion: 1, employeeNumber,
      protectedPayloadSha256: canonicalSha256(protectedPayload), planningProtection,
      shifts: weekShifts, schoolAttendance, holidays, range: { start: weekStart, end: weekEnd },
      profileSnapshot: { profile: version.profile, rules: version.rules, sources: version.sources,
        contentSha256: version.contentSha256 } });
    await recordWorkRuleEvaluation(repositories.workRules, { targetType: "planned_schedule",
      scopeType: "employee", scopeKey: employeeNumber, periodFrom: weekStart, periodTo: weekEnd,
      profileVersionIds: [versionId], inputSha256, result, outcome, actor });
    assessments.push(assessment);
  }
  return assessments;
}

module.exports = { recordPlanningProtectionChange };

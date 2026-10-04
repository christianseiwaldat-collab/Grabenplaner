"use strict";

const { canonicalJson, canonicalSha256 } = require("./receipt");
const { BUILTIN_WORK_RULE_PROFILES, CATALOG_VERSION, PLANNING_PROTECTION_PROFILE_ID } = require("./catalog");
const { addDays } = require("./calendar");
const { strictIsoDate } = require("./vocational-school");
const { publicSettingsRows } = require("../privacy-organization-settings");
const { RETAIL_KV_PROFILE, RETAIL_KV_RULES, RETAIL_KV_SOURCES } = require("./retail-kv");
const { versionSnapshot } = require("./store");
const { loadRetailKvBindingSnapshot } = require("./retail-kv-binding");

const REQUIRED_READS = Object.freeze({
  planningSettings: ["listSettings", "listGlobalDayBlocks", "listWorkRuleShiftsForRange", "listOverlappingWeekOptions"],
  absenceManagement: ["workRuleEvaluationEmployee"],
  organizationPersonnel: ["getPersonnelSensitiveRecord", "listLocations", "listDepartments"],
  workRules: ["listAssignments", "getProfileVersion"],
  collectiveAgreements: ["listVersions", "listAssignments", "getScopeTarget"],
  workRuleGovernance: ["assignmentRevisionsWithProfile", "assignmentEvents", "listGovernanceEvents",
    "allCollectiveAssignmentEvents", "collectiveAssignment", "businessUnitScopes", "activeScopeTarget",
    "reviewRequestById", "reviewDecisions", "conflictRunById", "governanceEventsForReview",
    "collectiveAssignmentEvents", "schemaTables"],
});

function invalid() {
  return new TypeError("Die Berufsschuländerung benötigt vollständige Repository-Lesezugriffe und gültige Prüfwochen.");
}

function monday(value) {
  return strictIsoDate(value) && new Date(`${value}T12:00:00Z`).getUTCDay() === 1;
}

function normalizedTargets(targets) {
  if (!Array.isArray(targets)) throw invalid();
  const unique = new Map();
  for (const target of targets) {
    if (!target || typeof target !== "object" || Array.isArray(target)
        || typeof target.employeeNumber !== "string" || !target.employeeNumber.trim()
        || target.employeeNumber.includes("\0") || !monday(target.weekStart)) throw invalid();
    const throughWeekStart = target.throughWeekStart === undefined ? target.weekStart : target.throughWeekStart;
    if (!monday(throughWeekStart) || throughWeekStart < target.weekStart) throw invalid();
    const normalized = {
      employeeNumber: target.employeeNumber.trim(), weekStart: target.weekStart, throughWeekStart,
      // KV rules also inspect the following week of the final evaluated week.
      dateFrom: addDays(target.weekStart, -112), dateTo: addDays(throughWeekStart, 13),
    };
    unique.set(canonicalJson(normalized), normalized);
  }
  return [...unique.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, value]) => value);
}

function ordered(rows) {
  if (!Array.isArray(rows)) throw invalid();
  return rows.map((row) => ({ row, key: canonicalJson(row) }))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0).map(({ row }) => row);
}

// Capture through the caller's provider-bound repositories. The second capture
// must run inside the write transaction, before either the option or its receipt
// is written. This function starts no transaction and exposes only one digest.
async function captureVocationalSchoolMutationGuard(repositories, targets) {
  const periods = normalizedTargets(targets);
  for (const [repository, methods] of Object.entries(REQUIRED_READS)) {
    if (methods.some((method) => typeof repositories?.[repository]?.[method] !== "function")) throw invalid();
  }
  const fingerprintBasis = { version: 2, catalogVersion: CATALOG_VERSION, targets: periods };
  if (!periods.length) return canonicalSha256(fingerprintBasis);

  const planning = repositories.planningSettings;
  const organization = repositories.organizationPersonnel;
  const workRules = repositories.workRules;
  const governance = repositories.workRuleGovernance;
  const employeeNumbers = [...new Set(periods.map((period) => period.employeeNumber))].sort();
  const employees = [];
  const locationIds = new Set();
  const departmentIds = new Set();
  for (const employeeNumber of employeeNumbers) {
    const employee = await repositories.absenceManagement.workRuleEvaluationEmployee(employeeNumber);
    const protectedRecord = await organization.getPersonnelSensitiveRecord(employeeNumber);
    // Do not decrypt or return private personnel data. Any change in the stored
    // protected basis, including confirmation/dates, invalidates preparation.
    employees.push({ employeeNumber, employee, protectedRecordSha256: canonicalSha256(protectedRecord) });
    if (employee?.home_location_id) locationIds.add(String(employee.home_location_id));
    if (employee?.preferred_department_id) departmentIds.add(String(employee.preferred_department_id));
  }

  const ranges = [];
  for (const period of periods) {
    const shifts = (await planning.listWorkRuleShiftsForRange({ dateFrom: period.dateFrom, dateTo: period.dateTo }))
      .filter((row) => String(row.employee_number) === period.employeeNumber
        && row.shift_date >= period.dateFrom && row.shift_date <= period.dateTo);
    const options = (await planning.listOverlappingWeekOptions({
      employeeNumber: period.employeeNumber, dateFrom: period.dateFrom, dateTo: period.dateTo,
      existingId: 0, excludedGroupId: null,
    })).filter((row) => String(row.employee_number) === period.employeeNumber
      && row.date_from <= period.dateTo && row.date_to >= period.dateFrom);
    for (const shift of shifts) {
      if (shift.location_id) locationIds.add(String(shift.location_id));
      if (shift.department_id) departmentIds.add(String(shift.department_id));
    }
    ranges.push({ ...period, shifts: ordered(shifts), options: ordered(options) });
  }

  // Both assignment rows and their lifecycle events are needed. A governed
  // assignment's activation/deactivation is derived from immutable events,
  // whereas the legacy assignment table carries its active flag directly.
  const legacyAssignments = ordered(await workRules.listAssignments(true));
  const governedRevisions = ordered(await governance.assignmentRevisionsWithProfile());
  const governanceEvents = ordered(await governance.listGovernanceEvents());
  const governedEvents = [];
  for (const revision of governedRevisions) {
    governedEvents.push({ revisionId: revision.id, events: ordered(await governance.assignmentEvents(revision.id)) });
  }
  const profileVersionIds = new Set(legacyAssignments.map((row) => row.profileVersionId));
  profileVersionIds.add("at-retail-youth-monitor@2026.2");
  const retailKvVersionId = `${RETAIL_KV_PROFILE.id}@${RETAIL_KV_PROFILE.version}`;
  profileVersionIds.add(retailKvVersionId);
  for (const revision of governedRevisions) profileVersionIds.add(revision.profile_version_id);
  for (const id of ["at-retail-adult-monitor", "at-retail-youth-monitor", PLANNING_PROTECTION_PROFILE_ID]) {
    const profile = BUILTIN_WORK_RULE_PROFILES[id];
    profileVersionIds.add(`${profile.id}@${profile.version}`);
  }
  if ([...profileVersionIds].some((id) => typeof id !== "string" || !id || id.includes("\0"))) throw invalid();
  const profiles = [];
  for (const id of [...profileVersionIds].sort()) {
    // Include the actual immutable rules/sources snapshot, not only a mutable
    // current-version pointer or a claimed content hash.
    profiles.push({ id, snapshot: await workRules.getProfileVersion(id) });
  }

  // Reuse the exact source/scope/review proof consumed by KV evaluation.
  // Missing approval remains unknown; failed or incomplete reads abort capture.
  const retailKvBinding = await loadRetailKvBindingSnapshot({
    collectiveAgreements: repositories.collectiveAgreements, governance, workRuleStore: workRules,
  }, { expectedProfileVersionId: retailKvVersionId,
    expectedProfileContentSha256: canonicalSha256(versionSnapshot(RETAIL_KV_PROFILE,
      Object.values(RETAIL_KV_RULES), Object.values(RETAIL_KV_SOURCES))),
    failOnInvalidSnapshot: true });

  const locations = (await organization.listLocations(true)).filter((row) => locationIds.has(String(row.id)))
    .map((row) => ({ id: row.id, active: row.active, day_settings_json: row.day_settings_json }));
  const departments = (await organization.listDepartments(true)).filter((row) => (
    locationIds.has(String(row.location_id)) || departmentIds.has(String(row.id))
  )).map((row) => ({ id: row.id, location_id: row.location_id, active: row.active }));
  const holidays = (await planning.listGlobalDayBlocks()).filter((row) => (
    locationIds.has(String(row.location_id || "01"))
      && periods.some((period) => row.block_date >= period.dateFrom && row.block_date <= period.dateTo)
  ));

  return canonicalSha256({
    ...fingerprintBasis, employees, ranges,
    settings: ordered(publicSettingsRows(await planning.listSettings())),
    locations: ordered(locations), departments: ordered(departments), holidays: ordered(holidays),
    legacyAssignments, governedRevisions, governedEvents, governanceEvents, profiles,
    retailKvBindingSha256: retailKvBinding.inputSha256,
  });
}

module.exports = { captureVocationalSchoolMutationGuard };

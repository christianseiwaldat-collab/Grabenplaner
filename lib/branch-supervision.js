"use strict";

const BRANCH_SUPERVISION_MODES = Object.freeze(["off", "yellow", "red", "block"]);
const BRANCH_SUPERVISION_INTENSITIES = Object.freeze(["relaxed", "standard", "strict", "custom"]);
const BRANCH_SUPERVISION_PRIMARY_POSITION_IDS = Object.freeze([
  "teamleitung",
  "fl-stellvertretung",
]);
const BRANCH_SUPERVISION_FALLBACK_POSITION_IDS = Object.freeze([
  "abteilungsleitung",
]);

const BRANCH_SUPERVISION_PRESETS = Object.freeze({
  relaxed: Object.freeze({
    minimumPrimaryCoveragePercent: 50,
    maximumDepartmentGapMinutes: 240,
  }),
  standard: Object.freeze({
    minimumPrimaryCoveragePercent: 60,
    maximumDepartmentGapMinutes: 180,
  }),
  strict: Object.freeze({
    minimumPrimaryCoveragePercent: 75,
    maximumDepartmentGapMinutes: 120,
  }),
});

const DAY_KEY_BY_NUMBER = Object.freeze({
  1: "monday",
  2: "tuesday",
  3: "wednesday",
  4: "thursday",
  5: "friday",
  6: "saturday",
});

const DAY_LABELS = Object.freeze({
  monday: "Montag",
  tuesday: "Dienstag",
  wednesday: "Mittwoch",
  thursday: "Donnerstag",
  friday: "Freitag",
  saturday: "Samstag",
});

function integerInRange(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function settingValue(settings, snakeKey, camelKey) {
  if (Object.hasOwn(settings || {}, snakeKey)) return settings[snakeKey];
  return settings?.[camelKey];
}

function normalizeBranchSupervisionSettings(settings = {}) {
  const submittedMode = String(settingValue(settings, "branch_supervision_mode", "mode") || "off");
  const mode = BRANCH_SUPERVISION_MODES.includes(submittedMode) ? submittedMode : "off";
  const submittedIntensity = String(
    settingValue(settings, "branch_supervision_intensity", "intensity") || "standard",
  );
  const intensity = BRANCH_SUPERVISION_INTENSITIES.includes(submittedIntensity)
    ? submittedIntensity
    : "standard";
  const preset = BRANCH_SUPERVISION_PRESETS[intensity] || BRANCH_SUPERVISION_PRESETS.standard;
  const minimumPrimaryCoveragePercent = intensity === "custom"
    ? integerInRange(
      settingValue(settings, "branch_supervision_min_primary_coverage_percent", "minimumPrimaryCoveragePercent"),
      BRANCH_SUPERVISION_PRESETS.standard.minimumPrimaryCoveragePercent,
      10,
      100,
    )
    : preset.minimumPrimaryCoveragePercent;
  const maximumDepartmentGapMinutes = intensity === "custom"
    ? integerInRange(
      settingValue(settings, "branch_supervision_max_department_gap_minutes", "maximumDepartmentGapMinutes"),
      BRANCH_SUPERVISION_PRESETS.standard.maximumDepartmentGapMinutes,
      0,
      480,
    )
    : preset.maximumDepartmentGapMinutes;
  return {
    mode,
    intensity,
    minimumPrimaryCoveragePercent,
    maximumDepartmentGapMinutes,
  };
}

function branchSupervisionSettingsValuesFromInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Die Einstellungen zur Filialaufsicht müssen als Objekt übermittelt werden.");
  }
  const mode = String(input.mode || "");
  const intensity = String(input.intensity || "");
  if (!BRANCH_SUPERVISION_MODES.includes(mode)) {
    throw new TypeError("Bitte einen gültigen Prüfmodus für die Filialaufsicht auswählen.");
  }
  if (!BRANCH_SUPERVISION_INTENSITIES.includes(intensity)) {
    throw new TypeError("Bitte eine gültige Prüfintensität für die Filialaufsicht auswählen.");
  }
  const normalized = normalizeBranchSupervisionSettings(input);
  if (intensity === "custom") {
    if (!Number.isInteger(Number(input.minimumPrimaryCoveragePercent))
      || Number(input.minimumPrimaryCoveragePercent) < 10
      || Number(input.minimumPrimaryCoveragePercent) > 100) {
      throw new TypeError("Die Mindestabdeckung durch Filialleitung oder Stellvertretung muss zwischen 10 und 100 Prozent liegen.");
    }
    if (!Number.isInteger(Number(input.maximumDepartmentGapMinutes))
      || Number(input.maximumDepartmentGapMinutes) < 0
      || Number(input.maximumDepartmentGapMinutes) > 480) {
      throw new TypeError("Die maximale Überbrückung durch eine Abteilungsleitung muss zwischen 0 und 480 Minuten liegen.");
    }
  }
  return {
    branch_supervision_mode: normalized.mode,
    branch_supervision_intensity: normalized.intensity,
    branch_supervision_min_primary_coverage_percent: String(
      normalized.minimumPrimaryCoveragePercent,
    ),
    branch_supervision_max_department_gap_minutes: String(
      normalized.maximumDepartmentGapMinutes,
    ),
  };
}

function timeToMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(String(value || ""))) return null;
  const [hours, minutes] = String(value).split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)
    || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function minutesToTime(value) {
  const minutes = Math.max(0, Math.min(1439, Number(value) || 0));
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function mergeIntervals(intervals = []) {
  const sorted = intervals
    .filter((interval) => Number(interval?.start) < Number(interval?.end))
    .map((interval) => ({ start: Number(interval.start), end: Number(interval.end) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end) merged.push({ ...interval });
    else previous.end = Math.max(previous.end, interval.end);
  }
  return merged;
}

function subtractIntervals(sourceIntervals = [], subtractingIntervals = []) {
  const subtracting = mergeIntervals(subtractingIntervals);
  return mergeIntervals(sourceIntervals).flatMap((source) => {
    let remaining = [{ ...source }];
    for (const mask of subtracting) {
      remaining = remaining.flatMap((part) => {
        if (mask.end <= part.start || mask.start >= part.end) return [part];
        const pieces = [];
        if (mask.start > part.start) pieces.push({ start: part.start, end: Math.min(mask.start, part.end) });
        if (mask.end < part.end) pieces.push({ start: Math.max(mask.end, part.start), end: part.end });
        return pieces;
      });
    }
    return remaining;
  });
}

function intervalMinutes(intervals = []) {
  return mergeIntervals(intervals).reduce((sum, interval) => sum + interval.end - interval.start, 0);
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayKeyForDate(isoDate) {
  return DAY_KEY_BY_NUMBER[new Date(`${isoDate}T12:00:00Z`).getUTCDay()] || null;
}

function percentage(part, whole) {
  if (!(whole > 0)) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function shiftInterval(shift, opening, closing) {
  const start = timeToMinutes(shift?.start_time ?? shift?.startTime);
  const end = timeToMinutes(shift?.end_time ?? shift?.endTime);
  if (start === null || end === null || end <= start) return null;
  const clipped = { start: Math.max(opening, start), end: Math.min(closing, end) };
  return clipped.end > clipped.start ? clipped : null;
}

function formattedSegments(intervals = []) {
  return mergeIntervals(intervals).map((interval) => ({
    startTime: minutesToTime(interval.start),
    endTime: minutesToTime(interval.end),
    minutes: interval.end - interval.start,
  }));
}

function branchSupervisionOutcome(mode, issueCount) {
  if (mode === "off") return "off";
  if (!issueCount) return "pass";
  return mode === "block" ? "blocked" : mode;
}

function assessBranchSupervision({
  weekStart,
  weekEnd = addDays(weekStart, 6),
  locationId = "",
  settings = {},
  employees = [],
  shifts = [],
  blockedDates = [],
  dates = null,
} = {}) {
  const policy = normalizeBranchSupervisionSettings(settings);
  const blockedDateSet = new Set((blockedDates || []).map(String));
  const requestedDateSet = Array.isArray(dates) ? new Set(dates.map(String)) : null;
  const positionByEmployee = new Map(employees.map((employee) => [
    String(employee?.personnel_number ?? employee?.employeeNumber ?? ""),
    String(employee?.position_id ?? employee?.positionId ?? ""),
  ]));
  const primaryPositions = new Set(BRANCH_SUPERVISION_PRIMARY_POSITION_IDS);
  const fallbackPositions = new Set(BRANCH_SUPERVISION_FALLBACK_POSITION_IDS);
  const days = [];

  for (let date = String(weekStart || ""); date && date <= String(weekEnd || ""); date = addDays(date, 1)) {
    if (requestedDateSet && !requestedDateSet.has(date)) continue;
    const dayKey = dayKeyForDate(date);
    if (!dayKey || settings[`${dayKey}_open`] === "0" || blockedDateSet.has(date)) continue;
    const opening = timeToMinutes(settings[`${dayKey}_start_time`]);
    const closing = timeToMinutes(settings[`${dayKey}_end_time`]);
    if (opening === null || closing === null || closing <= opening) continue;
    const dayShifts = shifts.filter((shift) => (
      String(shift?.shift_date ?? shift?.shiftDate ?? "") === date
      && (!locationId || String(shift?.location_id ?? shift?.locationId ?? "") === String(locationId))
    ));
    const primaryIntervals = [];
    const departmentIntervals = [];
    for (const shift of dayShifts) {
      // Duty never grants a qualification. Empty legacy rows retain their
      // previous position-based assessment; explicit other duties do not.
      const dutyCode = String(shift?.duty_code ?? shift?.dutyCode ?? "");
      if (dutyCode && dutyCode !== "branch_supervision") continue;
      const interval = shiftInterval(shift, opening, closing);
      if (!interval) continue;
      const employeeNumber = String(shift?.employee_number ?? shift?.employeeNumber ?? "");
      const positionId = positionByEmployee.get(employeeNumber) || "";
      if (primaryPositions.has(positionId)) primaryIntervals.push(interval);
      else if (fallbackPositions.has(positionId)) departmentIntervals.push(interval);
    }
    const primaryCoverage = mergeIntervals(primaryIntervals);
    const departmentOnlyCoverage = subtractIntervals(departmentIntervals, primaryCoverage);
    const combinedCoverage = mergeIntervals([...primaryCoverage, ...departmentIntervals]);
    const openingInterval = [{ start: opening, end: closing }];
    const uncovered = subtractIntervals(openingInterval, combinedCoverage);
    const openingMinutes = closing - opening;
    const primaryMinutes = intervalMinutes(primaryCoverage);
    const departmentOnlyMinutes = intervalMinutes(departmentOnlyCoverage);
    const uncoveredMinutes = intervalMinutes(uncovered);
    const requiredPrimaryMinutes = Math.ceil(
      openingMinutes * policy.minimumPrimaryCoveragePercent / 100,
    );
    const primaryDeficitMinutes = Math.max(0, requiredPrimaryMinutes - primaryMinutes);
    const excessiveDepartmentGapMinutes = departmentOnlyCoverage.reduce((sum, interval) => (
      sum + Math.max(0, interval.end - interval.start - policy.maximumDepartmentGapMinutes)
    ), 0);
    const reasons = [];
    if (uncoveredMinutes > 0) reasons.push("Nicht durch Filialleitung, Stellvertretung oder Abteilungsleitung abgedeckte Zeit");
    if (primaryDeficitMinutes > 0) reasons.push(`Mindestanteil ${policy.minimumPrimaryCoveragePercent} % durch Filialleitung oder Stellvertretung unterschritten`);
    if (excessiveDepartmentGapMinutes > 0) reasons.push(`Abteilungsleitung länger als ${policy.maximumDepartmentGapMinutes} Minuten ohne Filialleitung oder Stellvertretung`);
    const issue = reasons.length > 0;
    days.push({
      date,
      dayKey,
      dayLabel: DAY_LABELS[dayKey] || dayKey,
      openingTime: minutesToTime(opening),
      closingTime: minutesToTime(closing),
      openingMinutes,
      plannedShiftCount: dayShifts.length,
      primaryCoverageMinutes: primaryMinutes,
      primaryCoveragePercent: percentage(primaryMinutes, openingMinutes),
      departmentCoverageMinutes: departmentOnlyMinutes,
      uncoveredMinutes,
      uncoveredSegments: formattedSegments(uncovered),
      departmentOnlySegments: formattedSegments(departmentOnlyCoverage),
      primaryDeficitMinutes,
      excessiveDepartmentGapMinutes,
      issue,
      reasons,
      deficitScore: uncoveredMinutes * 10_000
        + primaryDeficitMinutes * 100
        + excessiveDepartmentGapMinutes,
    });
  }

  const issues = days.filter((day) => day.issue);
  const deficitScore = issues.reduce((sum, day) => sum + day.deficitScore, 0);
  return {
    version: 1,
    locationId: String(locationId || ""),
    weekStart: String(weekStart || ""),
    weekEnd: String(weekEnd || ""),
    ...policy,
    outcome: branchSupervisionOutcome(policy.mode, issues.length),
    blocking: policy.mode === "block" && issues.length > 0,
    evaluatedDays: days.length,
    compliantDays: days.length - issues.length,
    issueCount: issues.length,
    deficitScore,
    days,
    issues,
  };
}

module.exports = {
  BRANCH_SUPERVISION_FALLBACK_POSITION_IDS,
  BRANCH_SUPERVISION_INTENSITIES,
  BRANCH_SUPERVISION_MODES,
  BRANCH_SUPERVISION_PRESETS,
  BRANCH_SUPERVISION_PRIMARY_POSITION_IDS,
  assessBranchSupervision,
  branchSupervisionSettingsValuesFromInput,
  normalizeBranchSupervisionSettings,
};

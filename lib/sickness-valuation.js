"use strict";

const ALLOWANCE_VERSION = "aum-allowance-v1";
const VALUATION_VERSION = "sickness-valuation-v1";
const DAY_MS = 86_400_000;
const WEEKDAY_KEYS = Object.freeze(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function addDays(value, amount) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function calendarDaysInclusive(startDate, endDate) {
  if (!isIsoDate(startDate) || !isIsoDate(endDate) || endDate < startDate) return 0;
  return Math.round((new Date(`${endDate}T12:00:00Z`) - new Date(`${startDate}T12:00:00Z`)) / DAY_MS) + 1;
}

function normalizedPolicy(policy = {}) {
  return {
    enabled: policy.enabled === true,
    maxCasesPerYear: Math.min(20, Math.max(1, Math.trunc(Number(policy.maxCasesPerYear) || 3))),
    maxCalendarDaysPerCase: Math.min(3, Math.max(1, Math.trunc(Number(policy.maxCalendarDaysPerCase) || 1))),
  };
}

function createAumAllowanceSnapshot({
  policy,
  employeeEnabled = false,
  trustLevel = "C",
  usedCases = 0,
  startDate,
  endDate,
  evaluatedAt = new Date().toISOString(),
  hasAum = false,
} = {}) {
  const normalized = normalizedPolicy(policy);
  const calendarDays = Math.max(1, calendarDaysInclusive(startDate, endDate || startDate));
  const used = Math.max(0, Math.trunc(Number(usedCases) || 0));
  let reason = "eligible";
  let required = false;
  let consumesQuota = true;
  if (hasAum) {
    reason = "aum_received";
    consumesQuota = false;
  } else if (!normalized.enabled) {
    reason = "policy_disabled";
    required = true;
    consumesQuota = false;
  } else if (!employeeEnabled) {
    reason = "employee_disabled";
    required = true;
    consumesQuota = false;
  } else if (String(trustLevel || "C").toUpperCase() !== "A") {
    reason = "trust_level";
    required = true;
    consumesQuota = false;
  } else if (used >= normalized.maxCasesPerYear) {
    reason = "quota_exhausted";
    required = true;
    consumesQuota = false;
  } else if (calendarDays > normalized.maxCalendarDaysPerCase) {
    reason = "duration_exceeded";
    required = true;
    consumesQuota = false;
  }
  return {
    version: ALLOWANCE_VERSION,
    policyYear: isIsoDate(startDate) ? Number(startDate.slice(0, 4)) : null,
    policyEnabledAtReport: normalized.enabled,
    employeeEnabledAtReport: employeeEnabled === true,
    trustLevelAtReport: String(trustLevel || "C").toUpperCase(),
    maxCasesPerYear: normalized.maxCasesPerYear,
    maxCalendarDaysPerCase: normalized.maxCalendarDaysPerCase,
    usedCasesBefore: used,
    remainingCasesAfter: Math.max(0, normalized.maxCasesPerYear - used - (consumesQuota ? 1 : 0)),
    calendarDays,
    required,
    reason,
    consumesQuota,
    evaluatedAt,
    releasedAt: "",
    releaseReason: "",
  };
}

function reconcileAumAllowanceSnapshot(snapshot, {
  startDate,
  endDate,
  evaluatedAt = new Date().toISOString(),
  aumReviewed = false,
} = {}) {
  if (!snapshot || snapshot.version !== ALLOWANCE_VERSION) return snapshot;
  const next = { ...snapshot };
  const calendarDays = Math.max(1, calendarDaysInclusive(startDate, endDate || startDate));
  const durationChanged = calendarDays !== Number(next.calendarDays || 0);
  let releasedForDuration = false;
  next.calendarDays = calendarDays;
  if (aumReviewed) {
    next.required = false;
    next.reason = "aum_reviewed";
    next.consumesQuota = false;
    next.releasedAt = evaluatedAt;
    next.releaseReason = "aum_reviewed";
    next.remainingCasesAfter = Math.max(0, Number(next.maxCasesPerYear || 0) - Number(next.usedCasesBefore || 0));
  } else if (next.consumesQuota && next.calendarDays > Number(next.maxCalendarDaysPerCase || 1)) {
    next.required = true;
    next.reason = "duration_exceeded";
    next.consumesQuota = false;
    next.releasedAt = evaluatedAt;
    next.releaseReason = "duration_exceeded";
    next.remainingCasesAfter = Math.max(0, Number(next.maxCasesPerYear || 0) - Number(next.usedCasesBefore || 0));
    releasedForDuration = true;
  }
  if (durationChanged || aumReviewed || releasedForDuration) next.evaluatedAt = evaluatedAt;
  return next;
}

function normalizeTargetWorkdays(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 6 ? numeric : 5;
}

function normalizedFixedWorkdays(value) {
  const submitted = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(submitted.map((day) => String(day || "").trim()).filter((day) => WEEKDAY_KEYS.includes(day)))];
}

function standardWorkdayKeys(targetWorkdays, preferredDayOff = "") {
  const target = normalizeTargetWorkdays(targetWorkdays);
  const preferred = String(preferredDayOff || "");
  const candidates = [...WEEKDAY_KEYS];
  if (target < 5 && candidates.includes(preferred)) candidates.splice(candidates.indexOf(preferred), 1);
  return candidates.slice(0, target);
}

function createSicknessValuationSnapshot({
  contractedHours = 0,
  targetWorkdays = 5,
  fixedWorkdays = [],
  preferredDayOff = "",
  capturedAt = new Date().toISOString(),
  legacyBackfill = false,
} = {}) {
  const weeklyMinutes = Math.max(0, Math.round((Number(contractedHours) || 0) * 60));
  const normalizedTarget = normalizeTargetWorkdays(targetWorkdays);
  return {
    version: VALUATION_VERSION,
    contractedWeeklyMinutes: weeklyMinutes,
    targetWorkdays: normalizedTarget,
    minutesPerWorkday: Math.round(weeklyMinutes / normalizedTarget),
    fixedWorkdays: normalizedFixedWorkdays(fixedWorkdays),
    preferredDayOff: String(preferredDayOff || ""),
    standardWorkdays: standardWorkdayKeys(normalizedTarget, preferredDayOff),
    capturedAt,
    legacyBackfill: legacyBackfill === true,
    creditedDates: [],
    totalMinutes: 0,
  };
}

function valuationWorkday(snapshot, date, { plannedShift = false, weekHasPlan = false, holiday = false } = {}) {
  if (!snapshot || snapshot.version !== VALUATION_VERSION || holiday || !isIsoDate(date)) return { credited: false, reason: holiday ? "holiday" : "invalid" };
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (day === 0) return { credited: false, reason: "sunday" };
  const dayKey = WEEKDAY_KEYS[day - 1] || "";
  if (snapshot.fixedWorkdays.length) {
    return { credited: snapshot.fixedWorkdays.includes(dayKey), reason: snapshot.fixedWorkdays.includes(dayKey) ? "fixed_workday" : "contract_free_day" };
  }
  if (weekHasPlan) return { credited: plannedShift === true, reason: plannedShift ? "planned_shift" : "planned_free_day" };
  const credited = snapshot.standardWorkdays.includes(dayKey);
  return { credited, reason: credited ? "contract_pattern" : "contract_free_day" };
}

function extendSicknessValuationSnapshot(snapshot, {
  startDate,
  endDate,
  dayContext = () => ({}),
} = {}) {
  if (!snapshot || snapshot.version !== VALUATION_VERSION || !isIsoDate(startDate) || !isIsoDate(endDate) || endDate < startDate) return snapshot;
  const entries = new Map((Array.isArray(snapshot.creditedDates) ? snapshot.creditedDates : []).map((entry) => [entry.date, { ...entry }]));
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    if (entries.has(date)) continue;
    const context = dayContext(date) || {};
    const workday = valuationWorkday(snapshot, date, context);
    entries.set(date, {
      date,
      minutes: workday.credited ? Number(snapshot.minutesPerWorkday || 0) : 0,
      reason: workday.reason,
    });
  }
  const creditedDates = [...entries.values()].sort((left, right) => left.date.localeCompare(right.date));
  return {
    ...snapshot,
    creditedDates,
    totalMinutes: creditedDates.reduce((sum, entry) => sum + Math.max(0, Number(entry.minutes) || 0), 0),
  };
}

function creditedMinutesForDate(snapshot, date) {
  if (!snapshot || snapshot.version !== VALUATION_VERSION) return 0;
  return Math.max(0, Number((snapshot.creditedDates || []).find((entry) => entry.date === date)?.minutes) || 0);
}

module.exports = {
  ALLOWANCE_VERSION,
  VALUATION_VERSION,
  calendarDaysInclusive,
  createAumAllowanceSnapshot,
  createSicknessValuationSnapshot,
  creditedMinutesForDate,
  extendSicknessValuationSnapshot,
  normalizeTargetWorkdays,
  reconcileAumAllowanceSnapshot,
  standardWorkdayKeys,
  valuationWorkday,
};

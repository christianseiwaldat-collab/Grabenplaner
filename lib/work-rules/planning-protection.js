"use strict";

const { addDays, dayOfWeek, localDateTimeToEpoch, mondayOfWeek } = require("./calendar");
const { strictIsoDate } = require("./vocational-school");

const PLANNING_PROTECTION_PROFILE_ID = "at-planning-protection-monitor";
const PLANNING_PROTECTION_CATALOG_VERSION = "at-work-rules-2026.4";
const source = (paragraph, title) => Object.freeze({
  id: `ris.mschg.${paragraph}`, jurisdiction: "AT", title: `MSchG § ${paragraph} – ${title}`,
  url: `https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008464&Paragraf=${paragraph}`,
  retrievedOn: "2026-10-03",
});
const PLANNING_PROTECTION_SOURCES = Object.freeze(Object.fromEntries([
  ["1", "Geltungsbereich"], ["2a", "Arbeitsplatzprüfung"], ["2b", "Maßnahmen"],
  ["3", "Beschäftigungsverbote"], ["4", "Tätigkeitsbeschränkungen"],
  ["4a", "Tätigkeitsbeschränkungen"], ["5", "Beschäftigungsverbote nach der Entbindung"],
  ["6", "Nachtarbeit"], ["7", "Sonn- und Feiertagsarbeit"], ["8", "Arbeitszeitgrenzen"],
  ["8a", "Ruhemöglichkeit"], ["9", "Gesonderte Freistellung"],
].map(([paragraph, title]) => [`ris.mschg.${paragraph}`, source(paragraph, title)])));
const PLANNING_PROTECTION_RULE_DEFINITIONS = Object.freeze(Object.fromEntries([
  ["applicability", "Bestätigte Planungsauflagen", ["1"]],
  ["no-employment", "Zeitraum ohne Einsatz", ["3", "5"]],
  ["daily-max", "Individuelle Tagesgrenze", ["8"]],
  ["weekly-max", "Individuelle Wochengrenze", ["8"]],
  ["normal-daily", "Bestätigte tägliche Normalarbeitszeit", ["8"]],
  ["time-window", "Zulässiges Einsatzfenster", ["6"]],
  ["rest-days", "Einsatz an Ruhetagen", ["7"]],
  ["workplace-review", "Fachliche Prüfung des konkreten Arbeitsplatzes", ["2a", "2b", "4", "4a", "5", "8a"]],
  ["break-review", "Gesonderte Freistellung fachlich prüfen", ["9"]],
  ["school-combination", "Unterricht und Einsatz gemeinsam fachlich prüfen", ["1", "8"]],
].map(([suffix, title, paragraphs]) => {
  const id = `at.protection.${suffix}`;
  return [id, Object.freeze({ id, title, severity: "warning", enforcement: "manual_review",
    sourceRefs: Object.freeze(paragraphs.map(paragraph => `ris.mschg.${paragraph}`)) })];
})));
const PLANNING_PROTECTION_PROFILE = Object.freeze({
  id: PLANNING_PROTECTION_PROFILE_ID, version: "2026.4", catalogVersion: PLANNING_PROTECTION_CATALOG_VERSION,
  snapshotSchemaVersion: 2, title: "Österreich – individuelle Planungsauflagen (Monitor)",
  status: "active", assignable: false, validFrom: "2026-10-03", validTo: null,
  applicability: Object.freeze({ jurisdiction: "AT", automaticByPlanningProtection: true, confirmationRequired: true,
    note: "Nur bei ausdrücklich aktivierter, berechtigter Zuordnung der datierten Planungsauflagen." }),
  defaultEnforcementMode: "monitor", limits: Object.freeze({}),
  ruleIds: Object.freeze(Object.keys(PLANNING_PROTECTION_RULE_DEFINITIONS)),
  sourceRefs: Object.freeze(Object.keys(PLANNING_PROTECTION_SOURCES)),
});

const PERIOD_KEYS = new Set(["dateFrom", "dateTo", "confirmed", "unavailable", "nightStart", "nightEnd",
  "sundayAllowed", "holidayAllowed", "maxDailyMinutes", "maxWeeklyMinutes", "normalDailyMinutes",
  "manualWorkplaceReview", "breastfeedingBreakReview"]);
const PROJECTION_KEYS = new Set(["enabled", "scopeFrom", "scopeTo", "periods"]);
const object = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} muss ein Objekt sein.`);
};
const keys = (value, allowed) => {
  if (Object.keys(value).some(key => !allowed.has(key))) throw new TypeError("Nicht zulässiges Feld in Planungsauflagen.");
};
const minutes = (value, maximum) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError("Ungültige Minutengrenze in Planungsauflagen.");
  }
  return value;
};
const nullableFlag = (value, allowed) => {
  if (value === undefined || value === null) return null;
  if (value !== allowed) throw new TypeError("Nicht unterstützte Ausnahme in Planungsauflagen.");
  return value;
};

function normalizePlanningProtection(value) {
  if (value === undefined || value === null) return null;
  object(value, "Planungsauflagen"); keys(value, PROJECTION_KEYS);
  if (typeof value.enabled !== "boolean") throw new TypeError("Planungsauflagen benötigen einen ausdrücklichen Aktivierungsstatus.");
  const scopeFrom = value.scopeFrom || "";
  const scopeTo = value.scopeTo || "";
  if ((value.scopeFrom !== undefined && typeof value.scopeFrom !== "string")
    || (value.scopeTo !== undefined && typeof value.scopeTo !== "string")) throw new TypeError("Ungültiger Gültigkeitszeitraum der Planungsauflagen.");
  if ((scopeFrom && !strictIsoDate(scopeFrom)) || (scopeTo && !strictIsoDate(scopeTo))
    || (scopeFrom && scopeTo && scopeTo < scopeFrom)) throw new TypeError("Ungültiger Gültigkeitszeitraum der Planungsauflagen.");
  if (!Array.isArray(value.periods) || value.periods.length > 32) throw new TypeError("Planungsauflagen benötigen höchstens 32 Zeiträume.");
  const periods = value.periods.map(period => {
    object(period, "Auflagenzeitraum"); keys(period, PERIOD_KEYS);
    if (period.dateTo !== undefined && typeof period.dateTo !== "string") throw new TypeError("Ungültiger Auflagenzeitraum.");
    if (!strictIsoDate(period.dateFrom) || (period.dateTo && !strictIsoDate(period.dateTo))
      || (period.dateTo && period.dateTo < period.dateFrom)) throw new TypeError("Ungültiger Auflagenzeitraum.");
    if (typeof period.confirmed !== "boolean" || typeof period.unavailable !== "boolean") {
      throw new TypeError("Auflagenzeitraum benötigt ausdrückliche Bestätigungs- und Einsatzangaben.");
    }
    const nightStart = period.nightStart ?? null;
    const nightEnd = period.nightEnd ?? null;
    if (!((nightStart === null && nightEnd === null) || (nightStart === "20:00" && nightEnd === "06:00"))) {
      throw new TypeError("Nicht unterstütztes Einsatzfenster.");
    }
    return { dateFrom: period.dateFrom, dateTo: period.dateTo || "", confirmed: period.confirmed && !(period.unavailable && !period.dateTo),
      unavailable: period.unavailable, nightStart, nightEnd,
      sundayAllowed: nullableFlag(period.sundayAllowed, false), holidayAllowed: nullableFlag(period.holidayAllowed, false),
      maxDailyMinutes: minutes(period.maxDailyMinutes, 540), maxWeeklyMinutes: minutes(period.maxWeeklyMinutes, 2400),
      normalDailyMinutes: minutes(period.normalDailyMinutes, 540),
      manualWorkplaceReview: nullableFlag(period.manualWorkplaceReview, true),
      breastfeedingBreakReview: nullableFlag(period.breastfeedingBreakReview, true) };
  });
  return { enabled: value.enabled, scopeFrom, scopeTo, periods };
}

function projectPlanningProtection(status, { scopeFrom = "", scopeTo = "" } = {}) {
  const normalized = require("../personnel-protection-status").normalizeProtectionStatus(status);
  return normalizePlanningProtection({ enabled: normalized?.planningEnabled === true, scopeFrom, scopeTo,
    periods: normalized?.planningEnabled !== true ? [] : normalized.periods.map(period => {
      const timedRestrictions = ["pregnancy", "breastfeeding"].includes(period.phase);
      const contradiction = normalized.periods.some(other => other !== period && other.confirmed === true && period.confirmed === true
        && ((period.phase === "not_applicable" && !["not_applicable", "unknown"].includes(other.phase))
          || (other.phase === "not_applicable" && !["not_applicable", "unknown"].includes(period.phase)))
        && period.validFrom <= (other.validTo || "9999-12-31") && other.validFrom <= (period.validTo || "9999-12-31"));
      return { dateFrom: period.validFrom, dateTo: period.validTo,
        confirmed: period.confirmed === true && !contradiction && period.phase !== "unknown"
          && !(period.phase === "employment_prohibition" && !period.validTo),
        unavailable: period.phase === "employment_prohibition", nightStart: timedRestrictions ? "20:00" : null,
        nightEnd: timedRestrictions ? "06:00" : null, sundayAllowed: timedRestrictions ? false : null,
        holidayAllowed: timedRestrictions ? false : null, maxDailyMinutes: timedRestrictions ? 540 : null,
        maxWeeklyMinutes: timedRestrictions ? 2400 : null, normalDailyMinutes: timedRestrictions ? period.normalDailyMinutes : null,
        manualWorkplaceReview: ["pregnancy", "postpartum", "breastfeeding"].includes(period.phase) ? true : null,
        breastfeedingBreakReview: period.phase === "breastfeeding" ? true : null };
    }) });
}

function protectedDates(range) {
  if (!range?.valid || !strictIsoDate(range.start) || !strictIsoDate(range.end)) return [];
  const result = [];
  for (let date = range.start; date <= range.end; date = addDays(date, 1)) {
    if (result.length >= 3660) throw new TypeError("Prüfzeitraum der Planungsauflagen ist zu groß.");
    result.push(date);
  }
  return result;
}
const applies = (period, date) => period.dateFrom <= date && (!period.dateTo || date <= period.dateTo);

// Only neutral facts reach findings. Legal provenance lives in the global catalog,
// never in a person's planning response, fingerprint, or evidence.
function evaluatePlanningProtectionRules({ planningProtection, shifts, range, holidays, schoolAttendance,
  employee, timeZone, finding }) {
  const projection = normalizePlanningProtection(planningProtection) || { enabled: true, scopeFrom: "", scopeTo: "", periods: [] };
  if (!projection?.enabled) return [];
  const findings = [];
  const add = (suffix, state, scope, evidence, message) => findings.push(finding({
    ruleId: `at.protection.${suffix}`, state, scope,
    evidence: { ...evidence, enforcementBasis: "controlled_protection_monitor" }, message, sourceRefs: [],
    enforcementMode: "monitor", baseEnforcement: state === "fail" ? "block" : "manual_review",
  }));
  const dates = protectedDates(range);
  const active = date => ((projection.scopeFrom && date < projection.scopeFrom) || (projection.scopeTo && date > projection.scopeTo))
    ? [] : projection.periods.filter(period => applies(period, date));
  const coverage = dates.length > 0 && dates.every(date => {
    const periods = active(date);
    return (!projection.scopeFrom || date >= projection.scopeFrom) && (!projection.scopeTo || date <= projection.scopeTo)
      && periods.length > 0 && periods.every(period => period.confirmed);
  });
  add("applicability", coverage ? "pass" : "unknown", { type: "employee", employeeId: String(employee?.id || employee?.employeeId || "") },
    { metric: "dated_planning_constraints", coverageConfirmed: coverage },
    coverage ? "Die datierten Planungsauflagen sind für den Prüfzeitraum bestätigt."
      : "Die Planungsauflagen sind im Prüfzeitraum nicht vollständig bestätigt; fehlende Zeiträume sind fachlich zu prüfen.");
  const byDate = new Map();
  for (const shift of shifts) {
    for (let date = shift.date; date <= shift.endDate; date = addDays(date, 1)) {
      if (range.start && date < range.start || range.end && date > range.end) continue;
      const dayStart = localDateTimeToEpoch(date, "00:00", timeZone);
      const dayEnd = localDateTimeToEpoch(addDays(date, 1), "00:00", timeZone);
      const start = Math.max(dayStart, shift.startEpoch), end = Math.min(dayEnd, shift.endEpoch);
      if (end <= start) continue;
      if (!byDate.has(date)) byDate.set(date, []);
      const portionGross = (end - start) / 60000;
      let portionNet = null;
      if (shift.breakMinutes === 0 && shift.breakSource !== "configured_assumption") portionNet = portionGross;
      else if (shift.breakMinutes !== null && shift.breakSource !== "configured_assumption") {
        if (shift.breakIntervalsValid) {
          const portionBreak = shift.breakIntervals.reduce((total, interval) => total
            + Math.max(0, Math.min(end, interval.endEpoch) - Math.max(start, interval.startEpoch)) / 60000, 0);
          portionNet = portionGross - portionBreak;
        } else if (shift.date === shift.endDate && !shift.breakIntervalsSupplied && shift.breakMinutes <= portionGross) {
          portionNet = shift.netMinutes;
        }
      }
      byDate.get(date).push({ shift, start, end, net: portionNet });
    }
  }
  const minutesByDate = new Map();
  const knownByDate = new Map();
  for (const [date, entries] of byDate) {
    const sorted = [...entries].sort((a, b) => a.start - b.start);
    const known = entries.every(entry => entry.net !== null) && sorted.every((entry, index) => index === 0 || entry.start >= sorted[index - 1].end);
    knownByDate.set(date, known);
    minutesByDate.set(date, known ? entries.reduce((sum, entry) => sum + entry.net, 0) : null);
  }
  // A calendar-day total does not settle the legal work-period boundary. A
  // proven cross-date excess therefore requires review, never a rolling fail.
  const dayReferenceReviews = new Map();
  const workEntries = [...byDate].flatMap(([date, entries]) => entries.map(entry => ({ ...entry, date })));
  const horizon = 24 * 60 * 60000;
  const boundaries = workEntries.flatMap(entry => [entry.start, entry.end,
    ...(entry.shift.breakIntervalsValid ? entry.shift.breakIntervals.flatMap(interval => [interval.startEpoch, interval.endEpoch]) : [])]);
  for (const windowStart of new Set(boundaries.flatMap(epoch => [epoch, epoch - horizon]))) {
    const windowEnd = windowStart + horizon;
    const entries = workEntries.filter(entry => entry.start < windowEnd && entry.end > windowStart);
    const windowDates = [...new Set(entries.map(entry => entry.date))];
    if (windowDates.length < 2 || !windowDates.every(date => knownByDate.get(date))) continue;
    const provenMinutes = entries.reduce((sum, entry) => {
      const start = Math.max(entry.start, windowStart), end = Math.min(entry.end, windowEnd);
      const gross = (end - start) / 60000;
      const breaks = entry.shift.breakIntervalsValid
        ? entry.shift.breakIntervals.reduce((total, interval) => total
          + Math.max(0, Math.min(end, interval.endEpoch) - Math.max(start, interval.startEpoch)) / 60000, 0)
        // With an unlocated but known break, put the entire break in this
        // window. Only this conservative lower bound can justify review.
        : (entry.end - entry.start) / 60000 - entry.net;
      return sum + Math.max(0, gross - breaks);
    }, 0);
    for (const field of ["maxDailyMinutes", "normalDailyMinutes"]) {
      const caps = windowDates.map(date => {
        const periods = active(date);
        if (!periods.length || periods.some(period => !period.confirmed)) return null;
        const values = periods.map(period => period[field]).filter(value => value !== null);
        return values.length ? Math.min(...values) : null;
      });
      if (caps.some(cap => cap === null) || windowDates.some((date, index) => minutesByDate.get(date) > caps[index])) continue;
      for (let index = 0; index < windowDates.length; index += 1) {
        if (provenMinutes <= caps[index]) continue;
        const key = `${windowDates[index]}:${field}`;
        if (!dayReferenceReviews.has(key) || provenMinutes > dayReferenceReviews.get(key)) dayReferenceReviews.set(key, provenMinutes);
      }
    }
  }
  for (const [date, entries] of byDate) {
    const known = knownByDate.get(date);
    const periods = active(date).filter(period => period.confirmed);
    if (!periods.length) continue;
    const scope = { type: "day", date };
    if (periods.some(period => period.unavailable && period.dateTo)) add("no-employment", "fail", scope,
      { metric: "employment_in_unavailable_period", plannedShiftCount: entries.length }, "Im bestätigten Zeitraum ohne Einsatz ist ein Dienst geplant.");
    const cap = field => { const values = periods.map(period => period[field]).filter(value => value !== null); return values.length ? Math.min(...values) : null; };
    const dailyCap = cap("maxDailyMinutes");
    const actual = minutesByDate.get(date);
    if (dailyCap !== null) {
      const dailyReferenceReview = dayReferenceReviews.get(`${date}:maxDailyMinutes`);
      add("daily-max", !known ? "unknown" : actual > dailyCap ? "fail" : dailyReferenceReview ? "unknown" : "pass", scope,
        { metric: "individual_daily_minutes", actualMinutes: actual, maximumMinutes: dailyCap,
          ...(dailyReferenceReview ? { dayReferenceReviewRequired: true, crossDateWindowMinutes: dailyReferenceReview } : {}) },
        !known ? "Die Tagesdauer ist ohne belastbare Zeit- und Pausenangaben unbekannt."
          : actual > dailyCap ? "Die geplante Tagesdauer überschreitet die bestätigte Grenze."
            : dailyReferenceReview ? "Der Tagesbezug der kalenderübergreifenden Arbeitsperiode ist fachlich zu prüfen."
              : "Die geplante Tagesdauer hält die bestätigte Grenze ein.");
      const normalCap = cap("normalDailyMinutes");
      const normalReferenceReview = dayReferenceReviews.get(`${date}:normalDailyMinutes`);
      add("normal-daily", !known || normalCap === null ? "unknown" : actual > normalCap ? "fail" : normalReferenceReview ? "unknown" : "pass", scope,
        { metric: "individual_normal_daily_minutes", actualMinutes: actual, maximumMinutes: normalCap,
          ...(normalReferenceReview ? { dayReferenceReviewRequired: true, crossDateWindowMinutes: normalReferenceReview } : {}) },
        !known || normalCap === null ? "Die rechtlich zulässige tägliche Normalarbeitszeit ist noch fachlich zu bestätigen."
          : actual > normalCap ? "Die geplante Tagesdauer überschreitet die bestätigte Normalarbeitszeit."
            : normalReferenceReview ? "Der Tagesbezug der kalenderübergreifenden Normalarbeitszeit ist fachlich zu prüfen."
              : "Die geplante Tagesdauer hält die bestätigte Normalarbeitszeit ein.");
    }
    if (periods.some(period => period.nightStart)) {
      const allowedFrom = localDateTimeToEpoch(date, "06:00", timeZone);
      const allowedTo = localDateTimeToEpoch(date, "20:00", timeZone);
      const outside = entries.some(entry => entry.start < allowedFrom || entry.end > allowedTo);
      add("time-window", outside ? "fail" : "pass", scope, { metric: "individual_planned_time_window", earliestStart: "06:00", latestEnd: "20:00" },
        outside ? "Ein geplanter Dienst liegt außerhalb des bestätigten Einsatzfensters."
          : "Die geplanten Dienste liegen im bestätigten Einsatzfenster.");
    }
    if ((dayOfWeek(date) === 0 && periods.some(period => period.sundayAllowed === false))
      || (holidays.has(date) && periods.some(period => period.holidayAllowed === false))) {
      add("rest-days", "fail", scope, { metric: "individual_restricted_calendar_day", date },
        "Am bestätigten freien Kalendertag ist ein Dienst geplant; eine Ausnahme wurde nicht freigegeben.");
    }
    if (periods.some(period => period.manualWorkplaceReview)) add("workplace-review", "unknown", scope,
      { metric: "individual_workplace_review", reviewRequired: true }, "Die konkreten Tätigkeiten, Bedingungen und individuellen Auflagen sind fachlich zu prüfen.");
    if (periods.some(period => period.breastfeedingBreakReview)) add("break-review", "unknown", scope,
      { metric: "individual_separate_release", reviewRequired: true }, "Bedarf und gesonderte Freistellung sind fachlich zu klären; reguläre Pausen belegen diese Auflage nicht.");
    if (Array.isArray(schoolAttendance) && schoolAttendance.some(row => {
      if (String(row.employeeId || row.employee_id || "") !== String(employee?.id || employee?.employeeId || "")) return false;
      const from = row.dateFrom || row.date, to = row.dateTo || row.date || from;
      return from && from <= date && date <= to;
    }) && dailyCap !== null) add("school-combination", "unknown", scope,
      { metric: "individual_instruction_work_combination", reviewRequired: true }, "Die gemeinsame Anrechnung von Unterricht und Einsatz auf die individuellen Grenzen ist fachlich zu prüfen.");
  }
  const weeks = [...new Set(dates.map(mondayOfWeek))];
  for (const week of weeks) {
    const weekDates = Array.from({ length: 7 }, (_, index) => addDays(week, index));
    const caps = weekDates.flatMap(date => active(date).filter(period => period.confirmed)
      .map(period => period.maxWeeklyMinutes).filter(value => value !== null));
    if (!caps.length) continue;
    const cap = Math.min(...caps);
    const complete = weekDates.every(date => dates.includes(date) && active(date).length > 0 && active(date).every(period => period.confirmed)
      && active(date).some(period => period.maxWeeklyMinutes !== null));
    const durationKnown = weekDates.every(date => !byDate.has(date) || knownByDate.get(date));
    const actual = durationKnown ? weekDates.reduce((sum, date) => sum + (minutesByDate.get(date) || 0), 0) : null;
    const state = !complete || !durationKnown ? "unknown" : actual > cap ? "fail" : "pass";
    add("weekly-max", state, { type: "week", weekStart: week, weekEnd: weekDates[6] },
      { metric: "individual_weekly_minutes", actualMinutes: actual, maximumMinutes: cap, completeWeek: complete },
      state === "fail" ? "Die geplante Wochendauer überschreitet die bestätigte Grenze."
        : state === "unknown" ? "Die Wochengrenze ist nur mit einer vollständig bestätigten Kalenderwoche bewertbar."
          : "Die geplante Wochendauer hält die bestätigte Grenze ein.");
    if (Array.isArray(schoolAttendance) && schoolAttendance.some(row => {
      if (String(row.employeeId || row.employee_id || "") !== String(employee?.id || employee?.employeeId || "")) return false;
      const from = row.dateFrom || row.date, to = row.dateTo || row.date || from;
      return from && from <= weekDates[6] && to >= week;
    })) add("school-combination", "unknown", { type: "week", weekStart: week, weekEnd: weekDates[6] },
      { metric: "individual_instruction_work_week", reviewRequired: true },
      "Die gemeinsame Wochenanrechnung von Unterricht und Einsatz auf die individuellen Grenzen ist fachlich zu prüfen.");
  }
  return findings;
}

module.exports = { PLANNING_PROTECTION_PROFILE_ID, PLANNING_PROTECTION_CATALOG_VERSION,
  PLANNING_PROTECTION_SOURCES, PLANNING_PROTECTION_RULE_DEFINITIONS, PLANNING_PROTECTION_PROFILE,
  projectPlanningProtection, normalizePlanningProtection, evaluatePlanningProtectionRules };

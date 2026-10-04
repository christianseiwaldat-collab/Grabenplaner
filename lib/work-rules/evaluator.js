"use strict";

const {
  DAY_MS,
  addDays,
  austrianNationalHolidays,
  dayOfWeek,
  daysBetween,
  isIsoDate,
  localDateTimeToEpoch,
  mondayOfWeek,
} = require("./calendar");
const {
  CATALOG_VERSION,
  RULE_DEFINITIONS,
  SOURCE_CATALOG,
  getProfile,
} = require("./catalog");
const { fingerprint } = require("./receipt");
const {
  apprenticeshipApplicabilityOnDate,
  normalizeSchoolAttendance,
  strictIsoDate,
} = require("./vocational-school");
const {
  PLANNING_PROTECTION_PROFILE_ID,
  projectPlanningProtection,
  normalizePlanningProtection,
  evaluatePlanningProtectionRules,
} = require("./planning-protection");

const ENGINE_VERSION = "at-planned-work-evaluator-v2";
const TIME_ZONE = "Europe/Vienna";
const STATE_RANK = Object.freeze({ pass: 0, unknown: 1, fail: 2 });
const SEVERITY_RANK = Object.freeze({ info: 0, warning: 1, error: 2, critical: 3 });

function numeric(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
}

function normalizeShift(shift, index, timeZone) {
  const date = String(shift?.date || shift?.shiftDate || "");
  const startTime = String(shift?.startTime || shift?.start || "");
  const endTime = String(shift?.endTime || shift?.end || "");
  let startEpoch = localDateTimeToEpoch(date, startTime, timeZone);
  let endDate = date;
  let endEpoch = localDateTimeToEpoch(endDate, endTime, timeZone);
  if (Number.isFinite(startEpoch) && Number.isFinite(endEpoch) && endEpoch <= startEpoch) {
    endDate = addDays(date, 1);
    endEpoch = localDateTimeToEpoch(endDate, endTime, timeZone);
  }
  const breakMinutes = numeric(shift?.breakMinutes);
  const valid = isIsoDate(date) && Number.isFinite(startEpoch) && Number.isFinite(endEpoch) && endEpoch > startEpoch;
  const grossMinutes = valid ? Math.round((endEpoch - startEpoch) / 60_000) : null;
  const normalizedBreak = breakMinutes === null ? null : Math.max(0, Math.round(breakMinutes));
  const suppliedBreakIntervals = Array.isArray(shift?.breakIntervals);
  let breakIntervalsValid = suppliedBreakIntervals;
  const breakIntervals = suppliedBreakIntervals ? shift.breakIntervals.map(interval => {
    const start = localDateTimeToEpoch(date, String(interval?.startTime || ""), timeZone);
    let end = localDateTimeToEpoch(date, String(interval?.endTime || ""), timeZone);
    if (end <= start && endDate !== date) end = localDateTimeToEpoch(endDate, String(interval?.endTime || ""), timeZone);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < startEpoch || end > endEpoch) breakIntervalsValid = false;
    return { startEpoch: start, endEpoch: end };
  }).sort((left, right) => left.startEpoch - right.startEpoch) : [];
  if (breakIntervals.some((interval, i) => i > 0 && interval.startEpoch < breakIntervals[i - 1].endEpoch)) breakIntervalsValid = false;
  const intervalMinutes = breakIntervalsValid ? breakIntervals.reduce((sum, interval) => sum + (interval.endEpoch - interval.startEpoch) / 60_000, 0) : null;
  if (intervalMinutes !== null && normalizedBreak !== null && intervalMinutes !== normalizedBreak) breakIntervalsValid = false;
  const netMinutes = grossMinutes === null || normalizedBreak === null
    ? null
    : Math.max(0, grossMinutes - normalizedBreak);
  return {
    id: String(shift?.id || `shift-${index + 1}`),
    employeeId: String(shift?.employeeId || shift?.employee_id || ""),
    date,
    endDate,
    startTime,
    endTime,
    startEpoch,
    endEpoch,
    breakMinutes: normalizedBreak,
    breakSource: String(shift?.breakSource || (normalizedBreak === null ? "missing" : "planned")),
    breakIntervals,
    breakIntervalsValid,
    breakIntervalsSupplied: suppliedBreakIntervals,
    grossMinutes,
    netMinutes,
    valid,
  };
}

function dateRangeFromShifts(shifts, suppliedStart, suppliedEnd) {
  const validDates = shifts.filter((shift) => shift.valid).flatMap((shift) => [shift.date, shift.endDate]).sort();
  const start = isIsoDate(suppliedStart) ? suppliedStart : (validDates[0] || null);
  const end = isIsoDate(suppliedEnd) ? suppliedEnd : (validDates.at(-1) || null);
  return { start, end, valid: Boolean(start && end && end >= start) };
}

function ageOnDate(birthDate, referenceDate) {
  if (!strictIsoDate(birthDate) || !strictIsoDate(referenceDate)) return null;
  if (birthDate > referenceDate) return null;
  let age = Number(referenceDate.slice(0, 4)) - Number(birthDate.slice(0, 4));
  if (referenceDate.slice(5) < birthDate.slice(5)) age -= 1;
  return age;
}

function determineAdultApplicability(employee, referenceDate) {
  if (employee?.birthDateConfirmed === false) return { state: "unknown", reason: "age_not_confirmed" };
  if (employee?.isAdult === true) return { state: "pass", reason: "explicit_adult" };
  if (employee?.isAdult === false) return { state: "unknown", reason: "minor_requires_kjbg_profile" };
  const birthDate = String(employee?.birthDate || employee?.dateOfBirth || "");
  const age = ageOnDate(birthDate, referenceDate);
  if (age === null) return { state: "unknown", reason: "age_not_confirmed" };
  return age >= 18
    ? { state: "pass", reason: "birth_date", age }
    : { state: "unknown", reason: "minor_requires_kjbg_profile", age };
}

function determineYouthApplicability(employee, referenceDate) {
  if (employee?.birthDateConfirmed === false) return { state: "unknown", reason: "age_not_confirmed" };
  const birthDate = String(employee?.birthDate || employee?.dateOfBirth || "");
  const age = ageOnDate(birthDate, referenceDate);
  if (age === null) return { state: "unknown", reason: "age_not_confirmed" };
  if (age < 15) return { state: "unknown", reason: "under_fifteen_eligibility_requires_review", age };
  return age < 18
    ? { state: "pass", reason: "youth_birth_date", age }
    : { state: "unknown", reason: "adult_requires_adult_profile", age };
}

function youthEmployeeLabel(employee, referenceDate) {
  const datedStatus = referenceDate ? apprenticeshipApplicabilityOnDate(employee, referenceDate) : null;
  if (datedStatus?.state === "pass") return "Lehrling unter 18";
  if (datedStatus?.state === "not_applicable") return "Jugendliche beschäftigte Person unter 18";
  const personalStatus = String(employee?.apprenticeshipStatus || "");
  return (!["completed", "not_apprentice"].includes(personalStatus)
    && (personalStatus === "active" || employee?.isApprentice === true || employee?.employmentClassification === "apprentice"))
    ? "Lehrling unter 18"
    : "Jugendliche beschäftigte Person unter 18";
}

function isYouthProfile(profile) {
  return String(profile?.id || "") === "at-retail-youth-monitor";
}

function completedYouthProfile(profile) {
  const [year, revision] = String(profile?.version || "").split(".").map(Number);
  return isYouthProfile(profile) && (year > 2026 || (year === 2026 && revision >= 3));
}

function effectiveEnforcement(baseEnforcement, mode) {
  return mode === "monitor" ? "advisory" : baseEnforcement;
}

function catalogById(submitted, fallback) {
  if (submitted === undefined || submitted === null) return fallback;
  if (Array.isArray(submitted)) {
    return Object.fromEntries(submitted
      .filter((entry) => entry && typeof entry === "object" && entry.id)
      .map((entry) => [String(entry.id), entry]));
  }
  return submitted && typeof submitted === "object" ? submitted : {};
}

function createFinding({
  ruleId,
  state,
  profile,
  enforcementMode,
  message,
  scope,
  evidence,
  severity,
  baseEnforcement,
  sourceRefs,
  ruleDefinitions = RULE_DEFINITIONS,
  sourceCatalog = SOURCE_CATALOG,
}) {
  const definition = ruleDefinitions[ruleId] || {};
  const normalizedSources = [...new Set(
    (sourceRefs || definition.sourceRefs || [])
      .map((source) => (source && typeof source === "object" ? source.id : source))
      .map(String)
      .filter(Boolean),
  )];
  const core = {
    ruleId,
    profileId: profile.id,
    profileVersion: profile.version,
    state,
    severity: severity || definition.severity || "warning",
    baseEnforcement: baseEnforcement || definition.enforcement || "manual_review",
    effectiveEnforcement: effectiveEnforcement(baseEnforcement || definition.enforcement || "manual_review", enforcementMode),
    message,
    scope: scope || {},
    evidence: evidence || {},
    sourceRefs: normalizedSources.map((id) => ({
      id,
      title: sourceCatalog[id]?.title || id,
      url: sourceCatalog[id]?.url || "",
    })),
  };
  return { ...core, fingerprint: fingerprint(core) };
}

function minutesText(minutes) {
  if (!Number.isFinite(minutes)) return "unbekannt";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

function groupByDate(shifts) {
  const result = new Map();
  for (const shift of shifts) {
    if (!result.has(shift.date)) result.set(shift.date, []);
    result.get(shift.date).push(shift);
  }
  return result;
}

function groupByWeek(shifts) {
  const result = new Map();
  for (const shift of shifts) {
    const week = mondayOfWeek(shift.date);
    if (!result.has(week)) result.set(week, []);
    result.get(week).push(shift);
  }
  return result;
}

function sumKnownMinutes(shifts) {
  if (shifts.some((shift) => shift.netMinutes === null)) return null;
  return shifts.reduce((sum, shift) => sum + shift.netMinutes, 0);
}

function thresholdFinding({
  ruleId, actual, threshold, unit = "minutes", profile, enforcementMode, scope,
  passMessage, failMessage, unknownMessage, sourceRefs, ruleDefinitions, sourceCatalog,
}) {
  const state = actual === null ? "unknown" : (actual > threshold ? "fail" : "pass");
  return createFinding({
    ruleId,
    state,
    profile,
    enforcementMode,
    scope,
    evidence: {
      metric: ruleId,
      actual,
      threshold,
      comparator: "<=",
      unit,
    },
    message: state === "pass" ? passMessage : (state === "fail" ? failMessage : unknownMessage),
    sourceRefs,
    ruleDefinitions,
    sourceCatalog,
  });
}

function evaluateThresholds({ profile, enforcementMode, shifts, ruleDefinitions, sourceCatalog }) {
  const findings = [];
  const daily = groupByDate(shifts);
  for (const [date, entries] of daily) {
    const actual = sumKnownMinutes(entries);
    const scope = { type: "day", date, shiftIds: entries.map((entry) => entry.id) };
    findings.push(thresholdFinding({
      ruleId: "at.azg.normal.daily",
      actual,
      threshold: profile.limits.normalDailyMinutes,
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope,
      sourceRefs: profile.id === "at-retail-adult-monitor" ? ["ris.azg.4"] : ["ris.azg.3"],
      passMessage: `Die geplante Arbeitszeit am ${date} liegt innerhalb der profilierten täglichen Normalarbeitszeit.`,
      failMessage: `Die geplante Arbeitszeit am ${date} (${minutesText(actual)}) überschreitet die profilierte tägliche Normalarbeitszeit.`,
      unknownMessage: `Die tägliche Arbeitszeit am ${date} kann ohne geplante Pausenlage nicht abschließend bewertet werden.`,
    }));
    findings.push(thresholdFinding({
      ruleId: "at.azg.consent.daily",
      actual,
      threshold: profile.limits.consentDailyMinutes,
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope,
      passMessage: `Die geplante Arbeitszeit am ${date} löst keinen Hinweis für mehr als zehn Stunden aus.`,
      failMessage: `Mehr als zehn geplante Stunden am ${date}: Das gesetzliche Ablehnungsrecht für weitere Überstunden ist zu beachten.`,
      unknownMessage: `Der Zehn-Stunden-Hinweis am ${date} kann ohne geplante Pausenlage nicht bewertet werden.`,
    }));
    findings.push(thresholdFinding({
      ruleId: "at.azg.maximum.daily",
      actual,
      threshold: profile.limits.maximumDailyMinutes,
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope,
      passMessage: `Die geplante Arbeitszeit am ${date} liegt nicht über zwölf Stunden.`,
      failMessage: `Die geplante Arbeitszeit am ${date} (${minutesText(actual)}) liegt über der täglichen Höchstgrenze von zwölf Stunden.`,
      unknownMessage: `Die tägliche Höchstgrenze am ${date} kann ohne geplante Pausenlage nicht bewertet werden.`,
    }));

    const gross = entries.reduce((sum, entry) => sum + (entry.grossMinutes || 0), 0);
    const breakKnown = entries.every((entry) => entry.breakMinutes !== null);
    const totalBreak = breakKnown ? entries.reduce((sum, entry) => sum + entry.breakMinutes, 0) : null;
    let breakState = "pass";
    if (gross > profile.limits.breakTriggerMinutes && totalBreak === null) breakState = "unknown";
    else if (gross > profile.limits.breakTriggerMinutes && totalBreak < profile.limits.breakRequiredMinutes) breakState = "fail";
    findings.push(createFinding({
      ruleId: "at.azg.break.after-six",
      state: breakState,
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope,
      evidence: {
        metric: "planned_break",
        grossMinutes: gross,
        plannedBreakMinutes: totalBreak,
        triggerMinutes: profile.limits.breakTriggerMinutes,
        requiredBreakMinutes: profile.limits.breakRequiredMinutes,
        comparator: gross > profile.limits.breakTriggerMinutes ? ">=" : "not_applicable",
        breakSources: [...new Set(entries.map((entry) => entry.breakSource))],
      },
      message: breakState === "pass"
        ? (gross > profile.limits.breakTriggerMinutes
          ? `Für den ${date} sind mindestens 30 Minuten Pause geplant.`
          : `Am ${date} wird die Pausenpflicht von mehr als sechs Stunden nicht ausgelöst.`)
        : (breakState === "fail"
          ? `Am ${date} sind bei mehr als sechs Stunden weniger als 30 Minuten Pause geplant.`
          : `Am ${date} fehlt bei mehr als sechs Stunden eine prüfbare geplante Pausenangabe.`),
    }));
  }

  const weekly = groupByWeek(shifts);
  for (const [weekStart, entries] of weekly) {
    const actual = sumKnownMinutes(entries);
    const scope = { type: "week", weekStart, weekEnd: addDays(weekStart, 6), shiftIds: entries.map((entry) => entry.id) };
    findings.push(thresholdFinding({
      ruleId: "at.azg.normal.weekly",
      actual,
      threshold: profile.limits.normalWeeklyMinutes,
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope,
      sourceRefs: profile.id === "at-retail-adult-monitor" ? ["ris.azg.4"] : ["ris.azg.3"],
      passMessage: `Die geplante Arbeitszeit ab ${weekStart} liegt innerhalb der profilierten wöchentlichen Normalarbeitszeit.`,
      failMessage: `Die geplante Arbeitszeit ab ${weekStart} (${minutesText(actual)}) überschreitet die profilierte wöchentliche Normalarbeitszeit.`,
      unknownMessage: `Die Wochenarbeitszeit ab ${weekStart} kann ohne geplante Pausenlage nicht bewertet werden.`,
    }));
    findings.push(thresholdFinding({
      ruleId: "at.azg.consent.weekly",
      actual,
      threshold: profile.limits.consentWeeklyMinutes,
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope,
      passMessage: `Die Woche ab ${weekStart} löst keinen Hinweis für mehr als fünfzig Stunden aus.`,
      failMessage: `Mehr als fünfzig geplante Stunden in der Woche ab ${weekStart}: Das gesetzliche Ablehnungsrecht für weitere Überstunden ist zu beachten.`,
      unknownMessage: `Der Fünfzig-Stunden-Hinweis ab ${weekStart} kann ohne geplante Pausenlage nicht bewertet werden.`,
    }));
    findings.push(thresholdFinding({
      ruleId: "at.azg.maximum.weekly",
      actual,
      threshold: profile.limits.maximumWeeklyMinutes,
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope,
      passMessage: `Die Woche ab ${weekStart} liegt nicht über sechzig Stunden.`,
      failMessage: `Die geplante Arbeitszeit ab ${weekStart} (${minutesText(actual)}) liegt über der wöchentlichen Höchstgrenze von sechzig Stunden.`,
      unknownMessage: `Die wöchentliche Höchstgrenze ab ${weekStart} kann ohne geplante Pausenlage nicht bewertet werden.`,
    }));
  }
  return findings;
}

function completeWeekStarts(range) {
  if (!range.valid) return [];
  let cursor = mondayOfWeek(range.start);
  if (cursor < range.start) cursor = addDays(cursor, 7);
  const weeks = [];
  while (addDays(cursor, 6) <= range.end) {
    weeks.push(cursor);
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

function weeklyMinutesMap(shifts, weekStarts) {
  const grouped = groupByWeek(shifts);
  return new Map(weekStarts.map((weekStart) => [
    weekStart,
    sumKnownMinutes(grouped.get(weekStart) || []) ?? null,
  ]));
}

function evaluateRollingAverage({
  ruleId, weeks, weeklyMinutes, windowSize, threshold, profile, enforcementMode,
  ruleDefinitions, sourceCatalog,
}) {
  if (weeks.length < windowSize) {
    return [createFinding({
      ruleId,
      state: "unknown",
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope: { type: "rolling_weeks", windowWeeks: windowSize },
      evidence: {
        metric: "average_weekly_minutes",
        availableCompleteWeeks: weeks.length,
        requiredCompleteWeeks: windowSize,
        threshold,
        unit: "minutes_per_week",
      },
      message: `Für den ${windowSize}-Wochen-Schnitt liegen nur ${weeks.length} vollständige Kalenderwochen vor.`,
    })];
  }
  const findings = [];
  for (let index = 0; index <= weeks.length - windowSize; index += 1) {
    const window = weeks.slice(index, index + windowSize);
    const values = window.map((week) => weeklyMinutes.get(week));
    const actual = values.some((value) => value === null)
      ? null
      : Math.round(values.reduce((sum, value) => sum + value, 0) / windowSize);
    findings.push(thresholdFinding({
      ruleId,
      actual,
      threshold,
      unit: "minutes_per_week",
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope: {
        type: "rolling_weeks",
        windowWeeks: windowSize,
        start: window[0],
        end: addDays(window.at(-1), 6),
      },
      passMessage: `Der ${windowSize}-Wochen-Schnitt ab ${window[0]} liegt innerhalb des profilierten Grenzwerts.`,
      failMessage: `Der ${windowSize}-Wochen-Schnitt ab ${window[0]} (${minutesText(actual)} pro Woche) überschreitet den profilierten Grenzwert.`,
      unknownMessage: `Der ${windowSize}-Wochen-Schnitt ab ${window[0]} kann wegen fehlender Pausenangaben nicht bewertet werden.`,
    }));
  }
  return findings;
}

function evaluateRest({
  profile, enforcementMode, shifts, range, timeZone, ruleDefinitions, sourceCatalog,
}) {
  const findings = [];
  const sorted = [...shifts].sort((left, right) => left.startEpoch - right.startEpoch);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const actual = Math.round((current.startEpoch - previous.endEpoch) / 60_000);
    findings.push(createFinding({
      ruleId: "at.azg.daily-rest",
      state: actual >= profile.limits.dailyRestMinutes ? "pass" : "fail",
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope: {
        type: "between_shifts",
        previousShiftId: previous.id,
        nextShiftId: current.id,
        from: `${previous.endDate}T${previous.endTime}`,
        to: `${current.date}T${current.startTime}`,
      },
      evidence: {
        metric: "continuous_rest",
        actual,
        threshold: profile.limits.dailyRestMinutes,
        comparator: ">=",
        unit: "minutes",
        timeZone,
      },
      message: actual >= profile.limits.dailyRestMinutes
        ? `Zwischen den Diensten ${previous.id} und ${current.id} liegen mindestens elf Stunden Ruhezeit.`
        : `Zwischen den Diensten ${previous.id} und ${current.id} liegen nur ${minutesText(actual)} Ruhezeit.`,
    }));
  }

  const weeks = completeWeekStarts(range);
  for (const weekStart of weeks) {
    const weekEnd = addDays(weekStart, 7);
    const startEpoch = localDateTimeToEpoch(weekStart, "00:00", timeZone);
    const endEpoch = localDateTimeToEpoch(weekEnd, "00:00", timeZone);
    const inWeek = sorted
      .filter((shift) => shift.endEpoch > startEpoch && shift.startEpoch < endEpoch)
      .map((shift) => ({
        start: Math.max(startEpoch, shift.startEpoch),
        end: Math.min(endEpoch, shift.endEpoch),
        id: shift.id,
      }));
    let cursor = startEpoch;
    let longest = 0;
    for (const shift of inWeek) {
      longest = Math.max(longest, Math.round((shift.start - cursor) / 60_000));
      cursor = Math.max(cursor, shift.end);
    }
    longest = Math.max(longest, Math.round((endEpoch - cursor) / 60_000));
    findings.push(createFinding({
      ruleId: "at.arg.weekly-rest",
      state: longest >= profile.limits.weeklyRestMinutes ? "pass" : "fail",
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope: { type: "calendar_week", weekStart, weekEnd: addDays(weekStart, 6) },
      evidence: {
        metric: "longest_continuous_rest_within_calendar_week",
        actual: longest,
        threshold: profile.limits.weeklyRestMinutes,
        comparator: ">=",
        unit: "minutes",
        timeZone,
      },
      message: longest >= profile.limits.weeklyRestMinutes
        ? `In der Kalenderwoche ab ${weekStart} sind mindestens 36 Stunden ununterbrochene Ruhe erkennbar.`
        : `In der Kalenderwoche ab ${weekStart} sind innerhalb der vorliegenden Planabdeckung keine 36 Stunden ununterbrochene Ruhe erkennbar.`,
    }));
  }
  if (!weeks.length) {
    findings.push(createFinding({
      ruleId: "at.arg.weekly-rest",
      state: "unknown",
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope: { type: "calendar_week" },
      evidence: {
        metric: "complete_calendar_week_coverage",
        rangeStart: range.start,
        rangeEnd: range.end,
        required: true,
      },
      message: "Die wöchentliche Ruhezeit ist ohne vollständige Kalenderwoche in der Planabdeckung manuell zu prüfen.",
    }));
  }
  return findings;
}

function holidaySetForRange(range, suppliedHolidays = []) {
  const result = new Set((Array.isArray(suppliedHolidays) ? suppliedHolidays : []).map(String).filter(isIsoDate));
  if (!range.valid) return result;
  const firstYear = Number(range.start.slice(0, 4));
  const lastYear = Number(range.end.slice(0, 4));
  for (let year = firstYear; year <= lastYear; year += 1) {
    for (const holiday of austrianNationalHolidays(year)) result.add(holiday);
  }
  return result;
}

function evaluateRestDayWork({
  profile, enforcementMode, shifts, holidays, ruleDefinitions, sourceCatalog,
}) {
  const findings = [];
  for (const shift of shifts) {
    if (dayOfWeek(shift.date) === 0) {
      findings.push(createFinding({
        ruleId: "at.arg.sunday-work",
        state: "fail",
        profile,
        enforcementMode,
        ruleDefinitions,
        sourceCatalog,
        scope: { type: "shift", shiftId: shift.id, date: shift.date },
        evidence: { metric: "work_on_sunday", actual: true, expected: false },
        message: `Der Dienst ${shift.id} liegt an einem Sonntag; eine anwendbare Ausnahme ist nachzuweisen.`,
      }));
    }
    if (holidays.has(shift.date)) {
      findings.push(createFinding({
        ruleId: "at.arg.holiday-work",
        state: "fail",
        profile,
        enforcementMode,
        ruleDefinitions,
        sourceCatalog,
        scope: { type: "shift", shiftId: shift.id, date: shift.date },
        evidence: { metric: "work_on_national_holiday", actual: true, expected: false },
        message: `Der Dienst ${shift.id} liegt an einem österreichischen gesetzlichen Feiertag; eine anwendbare Ausnahme ist nachzuweisen.`,
      }));
    }
    if (profile.limits.saturdaySalesEndMinute !== null && dayOfWeek(shift.date) === 6) {
      const endMinute = Number(shift.endTime.slice(0, 2)) * 60 + Number(shift.endTime.slice(3, 5));
      if (shift.endDate !== shift.date || endMinute > profile.limits.saturdaySalesEndMinute) {
        findings.push(createFinding({
          ruleId: "at.trade.saturday-after-18",
          state: "fail",
          profile,
          enforcementMode,
          ruleDefinitions,
          sourceCatalog,
          scope: { type: "shift", shiftId: shift.id, date: shift.date },
          evidence: {
            metric: "saturday_sales_end",
            actual: shift.endTime,
            threshold: "18:00",
            comparator: "<=",
            timeZone: TIME_ZONE,
          },
          message: `Der Samstagsdienst ${shift.id} endet nach 18:00 Uhr; Öffnungszeit und arbeitsrechtliche Ausnahme sind zu prüfen.`,
        }));
      }
    }
  }
  for (const ruleId of ["at.arg.sunday-work", "at.arg.holiday-work", "at.trade.saturday-after-18"]) {
    if (!profile.ruleIds.includes(ruleId) || findings.some((finding) => finding.ruleId === ruleId)) continue;
    findings.push(createFinding({
      ruleId,
      state: "pass",
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope: { type: "evaluation_range" },
      evidence: { metric: ruleId, occurrences: 0 },
      message: ruleId === "at.arg.sunday-work"
        ? "Im bewerteten Plan ist keine Sonntagsarbeit enthalten."
        : (ruleId === "at.arg.holiday-work"
          ? "Im bewerteten Plan ist keine Arbeit an einem österreichischen gesetzlichen Feiertag enthalten."
          : "Im bewerteten Handelsplan ist kein Samstagsdienst nach 18:00 Uhr enthalten."),
    }));
  }
  return findings;
}

function timeMinute(value) {
  const [hour, minute] = String(value || "").split(":").map(Number);
  return Number.isInteger(hour) && Number.isInteger(minute) ? (hour * 60) + minute : null;
}

function lastFourSaturdaysBeforeChristmas(year) {
  const result = new Set();
  let cursor = `${year}-12-23`;
  while (result.size < 4) {
    if (dayOfWeek(cursor) === 6) result.add(cursor);
    cursor = addDays(cursor, -1);
  }
  return result;
}

function youthBreakProof(entries, profile) {
  const sorted = [...entries].sort((left, right) => left.startEpoch - right.startEpoch);
  const first = Math.min(...sorted.map(entry => entry.startEpoch));
  const last = Math.max(...sorted.map(entry => entry.endEpoch));
  const intervals = sorted.flatMap(entry => entry.breakIntervalsValid ? entry.breakIntervals : []);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].startEpoch > sorted[index - 1].endEpoch) {
      intervals.push({ startEpoch: sorted[index - 1].endEpoch, endEpoch: sorted[index].startEpoch });
    }
  }
  const overlap = (from, to, start, end) => Math.max(0, Math.min(to, end) - Math.max(from, start)) / 60_000;
  const workBetween = (from, to) => sorted.reduce((sum, entry) => (
    sum + overlap(from, to, entry.startEpoch, entry.endEpoch)
      - (entry.breakIntervalsValid ? entry.breakIntervals.reduce((pause, interval) => (
        pause + overlap(from, to, interval.startEpoch, interval.endEpoch)
      ), 0) : 0)
  ), 0);
  const workingMinutes = workBetween(first, last);
  if (workingMinutes <= profile.limits.breakTriggerMinutes) return { state: "pass", reason: "below_working_time_trigger", workingMinutes };
  const qualifying = intervals.filter(interval => (
    interval.startEpoch > first && interval.endEpoch < last
    && (interval.endEpoch - interval.startEpoch) / 60_000 >= profile.limits.breakRequiredMinutes
  )).sort((left, right) => left.startEpoch - right.startEpoch);
  let cursor = first;
  let longestWorkingPeriod = 0;
  for (const interval of qualifying) {
    longestWorkingPeriod = Math.max(longestWorkingPeriod, workBetween(cursor, interval.startEpoch));
    cursor = Math.max(cursor, interval.endEpoch);
  }
  longestWorkingPeriod = Math.max(longestWorkingPeriod, workBetween(cursor, last));
  const uncertain = sorted.some(entry => (
    (entry.breakIntervalsSupplied && !entry.breakIntervalsValid)
    || entry.breakMinutes === null
    || (entry.breakMinutes > 0 && !entry.breakIntervalsValid)
  ));
  const proven = qualifying.length > 0 && longestWorkingPeriod <= 6 * 60;
  return {
    state: proven ? "pass" : (uncertain ? "unknown" : "fail"),
    reason: proven ? "uninterrupted_break_and_timing_proven" : (uncertain ? "break_position_not_proven" : "uninterrupted_break_or_timing_missing"),
    workingMinutes,
    longestWorkingPeriod,
    qualifyingBreaks: qualifying.map(interval => ({
      start: new Date(interval.startEpoch).toISOString(), end: new Date(interval.endEpoch).toISOString(),
      minutes: (interval.endEpoch - interval.startEpoch) / 60_000,
    })),
  };
}

function evaluateYouthThresholds({
  profile, enforcementMode, shifts, employee, ruleDefinitions, sourceCatalog,
}) {
  const findings = [];
  const birthDate = String(employee?.birthDate || employee?.dateOfBirth || "");
  const employeeLabel = youthEmployeeLabel(employee, shifts[0]?.date);
  const daily = groupByDate(shifts);
  for (const [date, entries] of daily) {
    const actual = sumKnownMinutes(entries);
    const age = ageOnDate(birthDate, date);
    const absoluteThreshold = age !== null && age >= 16
      ? profile.limits.maximumDailyMinutesFrom16
      : profile.limits.maximumDailyMinutesUnder16;
    const state = actual === null ? "unknown" : (actual > profile.limits.normalDailyMinutes ? "fail" : "pass");
    const exceedsAbsolute = actual !== null && actual > absoluteThreshold;
    const scope = { type: "day", date, shiftIds: entries.map((entry) => entry.id) };
    findings.push(createFinding({
      ruleId: "at.kjbg.normal.daily",
      state,
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope,
      baseEnforcement: exceedsAbsolute ? "block" : "exception_required",
      evidence: {
        metric: "youth_daily_minutes",
        actual,
        threshold: profile.limits.normalDailyMinutes,
        absoluteThreshold,
        ageAtDate: age,
        comparator: "<=",
        unit: "minutes",
      },
      message: state === "pass"
        ? `${employeeLabel}: Die geplante Arbeitszeit am ${date} liegt bei höchstens acht Stunden.`
        : (state === "unknown"
          ? `${employeeLabel}: Die tägliche Arbeitszeit am ${date} kann ohne geplante Pausenlage nicht bewertet werden.`
          : (exceedsAbsolute
            ? `Achtung, ${employeeLabel}: ${minutesText(actual)} am ${date} überschreiten die für dieses Alter profilierten Höchstgrenzen.`
            : `Achtung, ${employeeLabel}: Mehr als acht Stunden am ${date} sind nur unter den besonderen Voraussetzungen des KJBG zulässig.`)),
    }));

    const gross = entries.reduce((sum, entry) => sum + (entry.grossMinutes || 0), 0);
    const breakKnown = entries.every((entry) => entry.breakMinutes !== null);
    const totalBreak = breakKnown ? entries.reduce((sum, entry) => sum + entry.breakMinutes, 0) : null;
    let breakState = "pass";
    if (gross > profile.limits.breakTriggerMinutes && totalBreak === null) breakState = "unknown";
    else if (gross > profile.limits.breakTriggerMinutes && totalBreak < profile.limits.breakRequiredMinutes) breakState = "fail";
    const breakProof = completedYouthProfile(profile) ? youthBreakProof(entries, profile) : null;
    if (breakProof) breakState = breakProof.state;
    findings.push(createFinding({
      ruleId: "at.kjbg.break.after-four-half",
      state: breakState,
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope,
      evidence: {
        metric: "youth_planned_break",
        grossMinutes: gross,
        plannedBreakMinutes: totalBreak,
        triggerMinutes: profile.limits.breakTriggerMinutes,
        requiredBreakMinutes: profile.limits.breakRequiredMinutes,
        ...(breakProof || {}),
        comparator: gross > profile.limits.breakTriggerMinutes ? ">=" : "not_applicable",
      },
      message: breakState === "pass"
        ? `${employeeLabel}: Die Pausenregel ab mehr als viereinhalb Stunden ist am ${date} eingehalten.`
        : (breakState === "fail"
          ? `Achtung, ${employeeLabel}: Am ${date} fehlt eine ungeteilte Pause von mindestens 30 Minuten spätestens nach sechs Arbeitsstunden.`
          : `${employeeLabel}: Am ${date} fehlt ein belastbarer Beleg für die ungeteilte Pause und ihre Lage.`),
    }));
  }

  for (const [weekStart, entries] of groupByWeek(shifts)) {
    const actual = sumKnownMinutes(entries);
    const ages = entries.map((entry) => ageOnDate(birthDate, entry.date)).filter((age) => age !== null);
    const under16 = ages.some((age) => age < 16);
    const absoluteThreshold = under16
      ? profile.limits.maximumWeeklyMinutesUnder16
      : profile.limits.maximumWeeklyMinutesFrom16;
    const state = actual === null ? "unknown" : (actual > profile.limits.normalWeeklyMinutes ? "fail" : "pass");
    const exceedsAbsolute = actual !== null && actual > absoluteThreshold;
    findings.push(createFinding({
      ruleId: "at.kjbg.normal.weekly",
      state,
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope: {
        type: "week",
        weekStart,
        weekEnd: addDays(weekStart, 6),
        shiftIds: entries.map((entry) => entry.id),
      },
      baseEnforcement: exceedsAbsolute ? "block" : "exception_required",
      evidence: {
        metric: "youth_weekly_minutes",
        actual,
        threshold: profile.limits.normalWeeklyMinutes,
        absoluteThreshold,
        comparator: "<=",
        unit: "minutes",
      },
      message: state === "pass"
        ? `${employeeLabel}: Die geplante Wochenarbeitszeit ab ${weekStart} liegt bei höchstens 40 Stunden.`
        : (state === "unknown"
          ? `${employeeLabel}: Die Wochenarbeitszeit ab ${weekStart} kann ohne geplante Pausenlage nicht bewertet werden.`
          : (exceedsAbsolute
            ? `Achtung, ${employeeLabel}: ${minutesText(actual)} ab ${weekStart} überschreiten die profilierten Höchstgrenzen.`
            : `Achtung, ${employeeLabel}: Mehr als 40 Stunden ab ${weekStart} sind nur unter den besonderen Voraussetzungen des KJBG zulässig.`)),
    }));
  }
  return findings;
}

function evaluateYouthDailyRest({
  profile, enforcementMode, shifts, employee, ruleDefinitions, sourceCatalog, timeZone,
}) {
  const findings = [];
  const employeeLabel = youthEmployeeLabel(employee, shifts[0]?.date);
  const birthDate = String(employee?.birthDate || employee?.dateOfBirth || "");
  const sorted = completedYouthProfile(profile)
    ? [...groupByDate(shifts).entries()].map(([date, entries]) => ({
      id: entries.map(entry => entry.id).join(","), date,
      startEpoch: Math.min(...entries.map(entry => entry.startEpoch)),
      endEpoch: Math.max(...entries.map(entry => entry.endEpoch)),
    })).sort((left, right) => left.startEpoch - right.startEpoch)
    : [...shifts].sort((left, right) => left.startEpoch - right.startEpoch);
  if (completedYouthProfile(profile)) {
    for (const day of sorted) {
      const age = ageOnDate(birthDate, day.date);
      const requiredRest = age !== null && age < 15 ? profile.limits.dailyRestMinutesUnder15 : profile.limits.dailyRestMinutes;
      const actual = 24 * 60 - Math.round((day.endEpoch - day.startEpoch) / 60_000);
      if (actual >= requiredRest) continue;
      findings.push(createFinding({
        ruleId: "at.kjbg.daily-rest", state: "fail", profile, enforcementMode, ruleDefinitions, sourceCatalog,
        scope: { type: "day", date: day.date, shiftIds: day.id.split(",") },
        evidence: { metric: "youth_rest_within_twenty_four_hours", actual, threshold: requiredRest, ageAtDate: age, timeZone },
        message: `Achtung, ${employeeLabel}: Die Tagesdienste lassen innerhalb von 24 Stunden nach dem ersten Arbeitsbeginn nicht die erforderliche ununterbrochene Ruhezeit zu.`,
      }));
    }
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const actual = Math.round((current.startEpoch - previous.endEpoch) / 60_000);
    const age = ageOnDate(birthDate, current.date);
    const requiredRest = age !== null && age < 15
      ? profile.limits.dailyRestMinutesUnder15
      : profile.limits.dailyRestMinutes;
    findings.push(createFinding({
      ruleId: "at.kjbg.daily-rest",
      state: actual >= requiredRest ? "pass" : "fail",
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope: {
        type: "between_shifts",
        date: current.date,
        dates: [previous.date, current.date],
        previousShiftId: previous.id,
        nextShiftId: current.id,
      },
      evidence: {
        metric: "youth_continuous_rest",
        actual,
        threshold: requiredRest,
        ageAtDate: age,
        comparator: ">=",
        unit: "minutes",
        timeZone,
      },
      message: actual >= requiredRest
        ? `${employeeLabel}: Zwischen den Diensten liegt die erforderliche Ruhezeit von ${minutesText(requiredRest)}.`
        : `Achtung, ${employeeLabel}: Vor dem Dienst am ${current.date} liegen nur ${minutesText(actual)} statt ${minutesText(requiredRest)} Ruhezeit.`,
    }));
  }
  return findings;
}

function evaluateYouthProtectedTimes({
  profile, enforcementMode, shifts, employee, holidays, ruleDefinitions, sourceCatalog,
}) {
  const findings = [];
  const employeeLabel = youthEmployeeLabel(employee, shifts[0]?.date);
  for (const shift of shifts) {
    const startMinute = timeMinute(shift.startTime);
    const endMinute = timeMinute(shift.endTime);
    const outsideDaytime = shift.endDate !== shift.date
      || startMinute < profile.limits.nightEndMinute
      || endMinute > profile.limits.nightStartMinute;
    if (outsideDaytime) {
      findings.push(createFinding({
        ruleId: "at.kjbg.night-work",
        state: "fail",
        profile,
        enforcementMode,
        ruleDefinitions,
        sourceCatalog,
        scope: { type: "shift", shiftId: shift.id, date: shift.date },
        evidence: {
          metric: "youth_night_rest",
          actual: `${shift.startTime}-${shift.endTime}`,
          allowedWindow: "06:00-20:00",
        },
        message: `Achtung, ${employeeLabel}: Der Dienst am ${shift.date} liegt außerhalb der regulär zulässigen Zeit von 06:00 bis 20:00 Uhr.`,
      }));
    }
    if (dayOfWeek(shift.date) === 0 || holidays.has(shift.date)) {
      const decemberEighth = shift.date.endsWith("-12-08");
      findings.push(createFinding({
        ruleId: "at.kjbg.sunday-holiday-work",
        state: "fail",
        profile,
        enforcementMode,
        ruleDefinitions,
        sourceCatalog,
        scope: { type: "shift", shiftId: shift.id, date: shift.date },
        baseEnforcement: decemberEighth ? "exception_required" : "block",
        evidence: {
          metric: dayOfWeek(shift.date) === 0 ? "youth_sunday_work" : "youth_holiday_work",
          date: shift.date,
          decemberEighth,
        },
        message: decemberEighth
          ? `Achtung, ${employeeLabel}: Eine Beschäftigung am 8. Dezember benötigt die anwendbare Handelsausnahme; die Ablehnung durch die jugendliche Person bleibt möglich.`
          : `Achtung, ${employeeLabel}: Der Dienst am ${shift.date} fällt unter die Sonn- oder Feiertagsruhe für Jugendliche.`,
      }));
    }
    if (dayOfWeek(shift.date) === 6 && (
      shift.endDate !== shift.date || endMinute > profile.limits.saturdaySalesEndMinute
    )) {
      findings.push(createFinding({
        ruleId: "at.kjbg.retail.saturday-after-18",
        state: "fail",
        profile,
        enforcementMode,
        ruleDefinitions,
        sourceCatalog,
        scope: { type: "shift", shiftId: shift.id, date: shift.date },
        evidence: {
          metric: "youth_saturday_sales_end",
          actual: shift.endTime,
          threshold: "18:00",
          comparator: "<=",
        },
        message: `Achtung, ${employeeLabel}: Der Samstagsdienst am ${shift.date} endet nach 18:00 Uhr.`,
      }));
    }
  }
  return findings;
}

function evaluateYouthRetailWeekends({
  profile, enforcementMode, shifts, employee, ruleDefinitions, sourceCatalog,
}) {
  const findings = [];
  const employeeLabel = youthEmployeeLabel(employee, shifts[0]?.date);
  const byDate = groupByDate(shifts);
  const saturdayDates = [...byDate.keys()].filter((date) => dayOfWeek(date) === 6).sort();
  for (const saturday of saturdayDates) {
    const monday = addDays(saturday, 2);
    const mondayShifts = byDate.get(monday) || [];
    if (!mondayShifts.length) continue;
    const saturdayShifts = byDate.get(saturday) || [];
    findings.push(createFinding({
      ruleId: "at.kjbg.retail.saturday-monday",
      state: "fail",
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope: {
        type: "shift_pair",
        date: monday,
        dates: [saturday, monday],
        shiftIds: [...saturdayShifts, ...mondayShifts].map((entry) => entry.id),
      },
      evidence: {
        metric: "youth_weekly_rest_after_saturday",
        saturday,
        monday,
        requiredMondayFree: true,
      },
      message: `Achtung, ${employeeLabel}: Der Dienst am Montag (${monday}) ist nach dem Samstagsdienst (${saturday}) nach der KJBG-Grundregel nicht zulässig. Eine zulässige und dokumentierte Teilung der Wochenfreizeit muss andernfalls nachgewiesen werden.`,
    }));
  }

  const afternoonSaturdays = saturdayDates.filter((date) => (
    (byDate.get(date) || []).some((shift) => (
      shift.endDate !== shift.date || timeMinute(shift.endTime) > 13 * 60
    ))
  ));
  const pairs = completedYouthProfile(profile)
    ? afternoonSaturdays.map(previous => [previous, addDays(previous, 7)])
      .filter(([, current]) => (byDate.get(current) || []).length)
    : afternoonSaturdays.slice(1).map((current, index) => [afternoonSaturdays[index], current])
      .filter(([previous, current]) => daysBetween(previous, current) === 7);
  for (const [previous, current] of pairs) {
    const christmasException = lastFourSaturdaysBeforeChristmas(Number(previous.slice(0, 4))).has(previous);
    findings.push(createFinding({
      ruleId: "at.kjbg.retail.consecutive-saturdays",
      state: christmasException ? "pass" : "fail",
      profile,
      enforcementMode,
      ruleDefinitions,
      sourceCatalog,
      scope: {
        type: "shift_pair",
        date: current,
        dates: [previous, current],
        shiftIds: [...(byDate.get(previous) || []), ...(byDate.get(current) || [])].map((entry) => entry.id),
      },
      evidence: {
        metric: completedYouthProfile(profile) ? "youth_next_saturday_entire_day_free" : "youth_consecutive_saturday_afternoons",
        previousSaturday: previous,
        currentSaturday: current,
        christmasException,
        exceptionBasis: christmasException ? "last_four_saturdays_before_december_24" : null,
      },
      message: christmasException
        ? `${employeeLabel}: Die aufeinanderfolgenden Samstagsdienste liegen in der gesetzlichen Vorweihnachtsausnahme; die übrige Wochenfreizeit bleibt einzuhalten.`
        : `Achtung, ${employeeLabel}: Nach einem Samstagsdienst nach 13:00 Uhr muss der folgende Samstag grundsätzlich vollständig frei bleiben. Eine anwendbare schriftliche oder kollektivvertragliche Ausnahme ist nachzuweisen.`,
    }));
  }
  return findings;
}

function evaluateYouthRules({
  profile, enforcementMode, shifts, employee, holidays, ruleDefinitions, sourceCatalog, timeZone,
}) {
  return [
    ...evaluateYouthThresholds({
      profile, enforcementMode, shifts, employee, ruleDefinitions, sourceCatalog,
    }),
    ...evaluateYouthDailyRest({
      profile, enforcementMode, shifts, employee, ruleDefinitions, sourceCatalog, timeZone,
    }),
    ...evaluateYouthProtectedTimes({
      profile, enforcementMode, shifts, employee, holidays, ruleDefinitions, sourceCatalog,
    }),
    ...evaluateYouthRetailWeekends({
      profile, enforcementMode, shifts, employee, ruleDefinitions, sourceCatalog,
    }),
  ];
}

function evaluateVocationalSchoolRules({
  profile, enforcementMode, shifts, employee, schoolAttendance, range, ruleDefinitions, sourceCatalog,
}) {
  const findings = [];
  const employeeId = String(employee?.id || employee?.employeeId || "");
  const attendance = normalizeSchoolAttendance(schoolAttendance, employeeId, range);
  const byDate = groupByDate(shifts);
  const schoolDates = groupByDate(attendance);
  const evaluatedSchoolDays = new Map();
  const publicApprenticeshipBasis = status => {
    const { sourceReference, ...basis } = status;
    return { ...basis, sourceReferenceSha256: sourceReference ? fingerprint(sourceReference) : null };
  };
  // School protection is a new additive pilot rule set. An unchanged adult
  // snapshot contains no school definitions or KJBG sources of its own.
  const schoolRuleDefinitions = { ...ruleDefinitions };
  for (const [id, definition] of Object.entries(RULE_DEFINITIONS)) {
    if (id.startsWith("at.kjbg.school.") || ["at.kjbg.apprenticeship", "at.kjbg.retail.school-rest"].includes(id)) schoolRuleDefinitions[id] = definition;
  }
  const schoolSourceCatalog = { ...sourceCatalog };
  for (const id of ["ris.kjbg.1", "ris.kjbg.11", "ris.kjbg.15", "ris.kjbg.16", "ris.kjbg.19"]) schoolSourceCatalog[id] = SOURCE_CATALOG[id];
  const add = (ruleId, state, scope, evidence, message, baseEnforcement) => findings.push(createFinding({
    ruleId, state, scope, evidence: { schoolRuleVersion: "2026.3", enforcementBasis: "controlled_monitor_pilot", ...evidence },
    message, baseEnforcement, profile, enforcementMode: "monitor", ruleDefinitions: schoolRuleDefinitions, sourceCatalog: schoolSourceCatalog,
  }));
  const indicatedApprenticeship = employee?.isApprentice === true || employee?.employmentClassification === "apprentice"
    || (employee?.apprenticeshipStatus && employee.apprenticeshipStatus !== "unknown");
  if (indicatedApprenticeship && !attendance.length) {
    const status = apprenticeshipApplicabilityOnDate(employee, shifts[0]?.date || range.end || range.start);
    if (status.state === "unknown") add("at.kjbg.apprenticeship", "unknown", { type: "employee", employeeId }, {
      metric: "dated_apprenticeship_applicability", ...publicApprenticeshipBasis(status),
    }, "Der Lehrlingsstatus ist nur angedeutet oder für den Prüfzeitraum noch nicht mit datierter Quelle bestätigt.");
  }
  for (const [date, records] of schoolDates) {
    const record = records[0];
    const status = apprenticeshipApplicabilityOnDate(employee, date);
    const details = record.details;
    let reason = record.error || (details === null ? "legacy_school_details_missing" : null);
    if (records.length !== 1) reason = "multiple_school_records_require_review";
    if (!reason && details.confirmed !== true) reason = "school_attendance_not_confirmed";
    if (!reason && details.specialCase !== "none") reason = `school_special_case_${details.specialCase}`;
    if (!reason && status.state !== "pass") reason = status.state === "not_applicable" ? "school_record_conflicts_with_personal_status" : status.reason;
    const dayShifts = byDate.get(date) || [];
    const workMinutes = sumKnownMinutes(dayShifts);
    const instructionMinutes = reason ? null : record.instructionMinutes;
    const necessaryTravelMinutes = dayShifts.length ? (details?.travelMinutes ?? null) : 0;
    const minuteEvidenceReason = !reason && instructionMinutes === null ? "daily_timetable_for_course_range_missing" : null;
    const state = reason || minuteEvidenceReason ? "unknown" : "pass";
    const day = { ...record, state, reason, instructionMinutes, necessaryTravelMinutes, workMinutes, shifts: dayShifts, apprenticeship: status };
    evaluatedSchoolDays.set(date, day);
    add("at.kjbg.school.data", state, { type: "day", date, schoolIds: records.map(row => row.id) }, {
      metric: "vocational_school_evidence", reason: reason || minuteEvidenceReason || "confirmed_school_attendance", instructionMinutes,
      necessaryTravelMinutes, schoolSourceReference: details?.sourceReference || "", schoolKind: details?.kind || null,
      specialCase: details?.specialCase || null, apprenticeship: publicApprenticeshipBasis(status),
    }, state === "unknown" ? "Berufsschulzeiten oder ihre Anwendbarkeit sind nicht ausreichend belegt; der Fall muss fachlich geprüft werden."
      : "Die Berufsschulzeit ist mit Unterrichtsintervall, Mittagspause, Quelle und datiertem Lehrlingsstatus belegt.");
    if (reason) continue;
    const scope = { type: "day", date, schoolIds: records.map(row => row.id), shiftIds: dayShifts.map(row => row.id) };
    const evidence = { instructionMinutes, necessaryTravelMinutes, workMinutes, schoolKind: details.kind, schoolSourceReference: details.sourceReference };
    if (["block", "seasonal"].includes(details.kind)) {
      add("at.kjbg.school.block-employment", dayShifts.length ? "fail" : "pass", scope, {
        metric: "employment_during_actual_school_visit", ...evidence, dateFrom: record.dateFrom, dateTo: record.dateTo,
      }, dayShifts.length ? "Während des bestätigten Block- oder Saisonberufsschulbesuchs ist kein Betriebsdienst zulässig, auch am Wochenende und für volljährige Lehrlinge."
        : "Während des bestätigten Block- oder Saisonberufsschulbesuchs ist kein Betriebsdienst geplant.");
    }
    if (instructionMinutes >= 480) {
      add("at.kjbg.school.eight-hours", dayShifts.length ? "fail" : "pass", scope, {
        metric: "school_day_eight_clock_hours", threshold: 480, ...evidence,
      }, dayShifts.length ? "Bei mindestens acht Zeitstunden Berufsschulunterricht ist am selben Tag kein Betriebsdienst zulässig."
        : "Nach mindestens acht Zeitstunden Berufsschulunterricht ist kein Betriebsdienst geplant.");
    }
    if (dayShifts.length) {
      const age = employee.birthDateConfirmed === false ? null : ageOnDate(String(employee.birthDate || employee.dateOfBirth || ""), date);
      const actual = instructionMinutes === null || necessaryTravelMinutes === null || workMinutes === null
        ? null : instructionMinutes + necessaryTravelMinutes + workMinutes;
      const threshold = profile.limits.normalDailyMinutes;
      const absoluteThreshold = isYouthProfile(profile)
        ? (age !== null && age >= 16 ? profile.limits.maximumDailyMinutesFrom16 : profile.limits.maximumDailyMinutesUnder16)
        : profile.limits.maximumDailyMinutes;
      const schoolStart = localDateTimeToEpoch(date, details.startTime, TIME_ZONE);
      const schoolEnd = localDateTimeToEpoch(date, details.endTime, TIME_ZONE);
      const overlapsInstruction = dayShifts.some(shift => shift.startEpoch < schoolEnd && shift.endEpoch > schoolStart);
      const adjoiningShifts = dayShifts.map(shift => ({
        shiftId: shift.id,
        gapMinutes: shift.endEpoch <= schoolStart ? (schoolStart - shift.endEpoch) / 60_000
          : (shift.startEpoch >= schoolEnd ? (shift.startEpoch - schoolEnd) / 60_000 : -1),
      }));
      const inadequateTravelGap = necessaryTravelMinutes !== null && adjoiningShifts.some(shift => shift.gapMinutes < necessaryTravelMinutes);
      const combinedState = overlapsInstruction || inadequateTravelGap ? "fail" : (actual === null || age === null || !Number.isFinite(threshold)
        ? "unknown" : (actual > threshold ? "fail" : "pass"));
      add("at.kjbg.school.daily-combination", combinedState, scope, {
        metric: "school_travel_and_work_daily_minutes", ...evidence, actual, threshold, absoluteThreshold, overlapsInstruction,
        inadequateTravelGap, adjoiningShifts,
        reason: actual === null ? "combined_minutes_not_proven" : (age === null ? "age_not_confirmed" : null),
      }, overlapsInstruction ? "Der Betriebsdienst überschneidet sich mit dem bestätigten Berufsschulunterricht."
        : (inadequateTravelGap ? "Zwischen Berufsschule und Betriebsdienst ist die belegte notwendige Wegzeit nicht vollständig eingeplant."
        : (combinedState === "unknown" ? "Für Schule, notwendige Wegzeit und Betriebsdienst fehlt eine belastbare kombinierte Tagesprüfung."
          : (combinedState === "fail" ? "Berufsschule, notwendige Wegzeit und Betriebsdienst überschreiten die profilierte tägliche Arbeitszeit; eine zulässige Ausnahme ist nachzuweisen."
            : "Berufsschule, notwendige Wegzeit und Betriebsdienst liegen innerhalb der profilierten Tagesgrenze."))),
      overlapsInstruction || inadequateTravelGap || (actual !== null && actual > absoluteThreshold) ? "block" : "exception_required");
    }
    const schoolAge = employee.birthDateConfirmed === false ? null : ageOnDate(String(employee.birthDate || employee.dateOfBirth || ""), date);
    if (state === "pass" && schoolAge !== null && schoolAge < 18) {
      // A credited school duration is not a proven uninterrupted school pause.
      // The current school contract records lunch length, not its position.
      // Keep the combined legal interpretation explicit instead of inferring
      // either compliance or an infringement from business intervals alone.
      const combinedInstructionAndWork = workMinutes === null ? null : instructionMinutes + workMinutes;
      if (dayShifts.length && combinedInstructionAndWork !== null && combinedInstructionAndWork > 270) {
        add("at.kjbg.school.pause", "unknown", scope, {
          metric: "school_and_business_pause_chronology", ...evidence,
          combinedInstructionAndWork, triggerMinutes: 270, requiredUninterruptedMinutes: 30,
          schoolLunchMinutes: details.lunchMinutes, schoolBreakPositionProven: false,
          ageAtDate: schoolAge, reason: "school_break_position_and_combined_applicability_require_review",
        }, "Bei Berufsschule und Betriebsdienst über insgesamt viereinhalb Stunden sind die kombinierte Pausenprüfung und die Lage einer ungeteilten Ruhepause noch fachlich zu belegen.");
      }
      const schoolStart = localDateTimeToEpoch(date, details.startTime, TIME_ZONE);
      const schoolEnd = localDateTimeToEpoch(date, details.endTime, TIME_ZONE);
      if (dayShifts.length) {
        const combinedStart = Math.min(schoolStart, ...dayShifts.map(shift => shift.startEpoch));
        const combinedEnd = Math.max(schoolEnd, ...dayShifts.map(shift => shift.endEpoch));
        const combinedSpanMinutes = Math.round((combinedEnd - combinedStart) / 60_000);
        const requiredRestMinutes = schoolAge < 15 ? 14 * 60 : 12 * 60;
        const maximumDaySpanMinutes = 24 * 60 - requiredRestMinutes;
        if (combinedSpanMinutes > maximumDaySpanMinutes) {
          add("at.kjbg.school.rest", "unknown", scope, {
            metric: "school_and_business_rest_within_twenty_four_hours",
            combinedSpanMinutes, maximumDaySpanMinutes, requiredRestMinutes,
            remainingRestMinutes: 24 * 60 - combinedSpanMinutes, ageAtDate: schoolAge,
            reason: "school_business_day_span_combined_applicability_requires_review",
          }, "Die bestätigten Schul- und Betriebszeiten desselben Tages lassen im kombinierten 24-Stunden-Horizont keine vollständige Jugendruhezeit erkennen; die fachliche Anwendbarkeit muss manuell geklärt werden.");
        }
      }
      for (const [businessDate, businessShifts] of byDate) {
        if (businessDate === date) continue;
        const laterDate = businessDate > date ? businessDate : date;
        const ageAtLaterDate = ageOnDate(String(employee.birthDate || employee.dateOfBirth || ""), laterDate);
        if (ageAtLaterDate === null || ageAtLaterDate >= 18) continue;
        const businessStart = Math.min(...businessShifts.map(shift => shift.startEpoch));
        const businessEnd = Math.max(...businessShifts.map(shift => shift.endEpoch));
        const businessBeforeSchool = businessStart < schoolStart;
        const gapMinutes = Math.round((businessBeforeSchool ? schoolStart - businessEnd : businessStart - schoolEnd) / 60_000);
        const requiredRestMinutes = ageAtLaterDate < 15 ? 14 * 60 : 12 * 60;
        if (gapMinutes >= requiredRestMinutes) continue;
        add("at.kjbg.school.rest", "unknown", {
          type: "between_school_and_business", date: laterDate, dates: [date, businessDate].sort(),
          schoolIds: records.map(row => row.id), shiftIds: businessShifts.map(shift => shift.id),
        }, {
          metric: "school_and_business_rest_chronology", schoolStartTime: details.startTime, schoolEndTime: details.endTime,
          businessBeforeSchool, gapMinutes, requiredRestMinutes, ageAtDate: ageAtLaterDate,
          reason: "short_school_business_gap_combined_applicability_requires_review",
        }, "Der Abstand zwischen bestätigter Berufsschule und Betriebsdienst an verschiedenen Tagen ist kürzer als die Jugendruhezeit; die kombinierte Ruheprüfung muss fachlich geklärt werden.");
      }
    }
  }
  const weeks = new Set([...evaluatedSchoolDays.keys()].filter(isIsoDate).map(mondayOfWeek));
  for (const weekStart of weeks) {
    const weekEnd = addDays(weekStart, 6);
    const days = [...evaluatedSchoolDays.values()].filter(day => day.date >= weekStart && day.date <= weekEnd);
    const weekShifts = shifts.filter(shift => shift.date >= weekStart && shift.date <= weekEnd);
    const workMinutes = sumKnownMinutes(weekShifts);
    const schoolMinutes = days.every(day => day.instructionMinutes !== null) ? days.reduce((sum, day) => sum + day.instructionMinutes, 0) : null;
    const travelMinutes = days.every(day => day.necessaryTravelMinutes !== null) ? days.reduce((sum, day) => sum + day.necessaryTravelMinutes, 0) : null;
    const actual = workMinutes === null || schoolMinutes === null || travelMinutes === null ? null : workMinutes + schoolMinutes + travelMinutes;
    const threshold = profile.limits.normalWeeklyMinutes;
    const ages = days.map(day => employee.birthDateConfirmed === false ? null : ageOnDate(String(employee.birthDate || employee.dateOfBirth || ""), day.date));
    const ageKnown = ages.every(age => age !== null);
    const absoluteThreshold = isYouthProfile(profile)
      ? (ages.some(age => age !== null && age < 16) ? profile.limits.maximumWeeklyMinutesUnder16 : profile.limits.maximumWeeklyMinutesFrom16)
      : profile.limits.maximumWeeklyMinutes;
    const completeWeek = range.valid && range.start <= weekStart && range.end >= weekEnd;
    const state = actual === null || !ageKnown || !completeWeek || !Number.isFinite(threshold) ? "unknown" : (actual > threshold ? "fail" : "pass");
    add("at.kjbg.school.weekly-credit", state, { type: "week", weekStart, weekEnd, schoolIds: days.map(day => day.id) }, {
      metric: "school_travel_and_work_weekly_minutes", workMinutes, schoolMinutes, necessaryTravelMinutes: travelMinutes,
      actual, threshold, absoluteThreshold, completeWeek,
      schoolSourceReferences: [...new Set(days.map(day => day.details?.sourceReference || "").filter(Boolean))],
    }, state === "unknown" ? "Die Wochenanrechnung der Berufsschulzeit ist wegen fehlender Belege oder einer unvollständigen Kalenderwoche offen."
      : (state === "fail" ? "Die Woche überschreitet unter Anrechnung von Berufsschulzeit, notwendiger Wegzeit und Betriebsdienst die profilierte Wochenarbeitszeit."
        : "Die belegten Berufsschulzeiten und notwendigen Wegzeiten sind in der Wochenarbeitszeit berücksichtigt."),
    actual !== null && actual > absoluteThreshold ? "block" : "exception_required");
  }
  if (completedYouthProfile(profile)) {
    for (const saturday of [...byDate.keys()].filter(date => dayOfWeek(date) === 6)) {
      const monday = addDays(saturday, 2);
      const mondaySchool = evaluatedSchoolDays.get(monday);
      if (!mondaySchool) continue;
      const nextWeekEnd = addDays(monday, 6);
      const schoolWeek = [0, 1, 2, 3, 4].map(offset => evaluatedSchoolDays.get(addDays(monday, offset)));
      const fullSchoolWeek = schoolWeek.every(day => day && !day.reason);
      let checkedDates = [1, 2, 3, 4].map(offset => addDays(monday, offset));
      let complete = range.start <= monday && range.end >= addDays(monday, 4);
      if (fullSchoolWeek) {
        const courseEnd = schoolWeek.map(day => day.dateTo).sort().at(-1);
        const endWeek = mondayOfWeek(courseEnd);
        const candidateWeeks = [addDays(endWeek, -7), addDays(endWeek, 7)];
        checkedDates = candidateWeeks.flatMap(start => [0, 1, 2, 3, 4].map(offset => addDays(start, offset)));
        complete = candidateWeeks.every(start => range.start <= start && range.end >= addDays(start, 4));
      }
      const provenFreeDate = checkedDates.find(date => date >= range.start && date <= range.end && !(byDate.get(date) || []).length && !evaluatedSchoolDays.has(date));
      const known = !mondaySchool.reason && (Boolean(provenFreeDate) || complete);
      const state = known ? (provenFreeDate ? "pass" : "fail") : "unknown";
      add("at.kjbg.retail.school-rest", state, { type: "week", weekStart: monday, weekEnd: nextWeekEnd, dates: [saturday, monday] }, {
        metric: "school_replacement_rest_after_saturday", saturday, monday, fullSchoolWeek,
        checkedDates, provenFreeDate: provenFreeDate || null, complete,
      }, state === "unknown" ? "Die Ersatzfreizeit nach Samstagsdienst und Berufsschulmontag muss anhand vollständiger Schul- und Dienstpläne fachlich geprüft werden."
        : (state === "fail" ? "Nach Samstagsdienst und Berufsschulmontag fehlt der gesetzliche ersatzfreie Arbeitstag; eine anwendbare Ausnahme ist nachzuweisen."
          : "Der ersatzfreie Arbeitstag bei Berufsschule nach Samstagsdienst ist im Plan nachgewiesen."));
    }
  }
  return findings;
}

function replaceWithApplicabilityUnknown(
  findings,
  applicability,
  profile,
  enforcementMode,
  ruleDefinitions,
  sourceCatalog,
) {
  if (applicability.state === "pass") return findings;
  return findings.map((finding) => createFinding({
    ...finding,
    state: "unknown",
    profile,
    enforcementMode,
    ruleDefinitions,
    sourceCatalog,
    evidence: {
      ...finding.evidence,
      conditionalResult: finding.state,
      applicabilityReason: applicability.reason,
    },
    message: applicability.reason === "minor_requires_kjbg_profile"
      ? `${finding.message} Die abschließende Bewertung benötigt jedoch ein KJBG-/Jugendlichenprofil.`
      : `${finding.message} Die abschließende Bewertung benötigt eine bestätigte Alters- und Profilanwendbarkeit.`,
    baseEnforcement: "manual_review",
  }));
}

function summarize(findings) {
  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const finding of findings) counts[finding.state] = (counts[finding.state] || 0) + 1;
  const worstFinding = [...findings].sort((left, right) => (
    STATE_RANK[right.state] - STATE_RANK[left.state]
    || SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]
  ))[0];
  return {
    state: worstFinding?.state || "unknown",
    severity: worstFinding?.severity || "warning",
    counts,
    requiresManualReview: findings.some((finding) => (
      finding.state === "unknown"
      || (finding.state === "fail" && ["manual_review", "exception_required", "acknowledge"].includes(finding.baseEnforcement))
    )),
  };
}

function invalidProfileResult(profileId, reason) {
  const core = {
    engineVersion: ENGINE_VERSION,
    catalogVersion: CATALOG_VERSION,
    basis: "planned_schedule",
    timeZone: TIME_ZONE,
    profile: { id: String(profileId || ""), version: null },
    enforcementMode: "monitor",
    range: { start: null, end: null },
    findings: [{
      ruleId: "at.profile.applicability",
      state: "unknown",
      severity: "warning",
      baseEnforcement: "manual_review",
      effectiveEnforcement: "advisory",
      message: reason,
      scope: {},
      evidence: { profileId: String(profileId || "") },
      sourceRefs: [],
    }],
  };
  core.findings[0].fingerprint = fingerprint(core.findings[0]);
  return {
    ...core,
    summary: summarize(core.findings),
    fingerprint: fingerprint(core),
    legalNotice: "Technische Planprüfung; keine Rechtsberatung oder Bestätigung der Rechtskonformität.",
  };
}

const CUSTOM_PLANNED_METRICS = Object.freeze({
  maximum_planned_daily_minutes: { operator: "lte", unit: "minutes", valueType: "integer" },
  maximum_planned_weekly_minutes: { operator: "lte", unit: "minutes", valueType: "integer" },
  minimum_planned_rest_minutes: { operator: "gte", unit: "minutes", valueType: "integer" },
  maximum_consecutive_workdays: { operator: "lte", unit: "days", valueType: "integer" },
  maximum_saturdays_per_month: { operator: "lte", unit: "days", valueType: "integer" },
  earliest_shift_start_time: { operator: "gte", unit: "time", valueType: "time" },
  latest_shift_end_time: { operator: "lte", unit: "time", valueType: "time" },
});

function customRuleDefinition(profile) {
  const submittedRules = Array.isArray(profile?.rules)
    ? profile.rules
    : (Array.isArray(profile?.ruleDefinitions)
      ? profile.ruleDefinitions
      : Object.values(profile?.ruleDefinitions || {}));
  const preferredRuleIds = new Set(Array.isArray(profile?.ruleIds) ? profile.ruleIds.map(String) : []);
  const rule = submittedRules.find((entry) => preferredRuleIds.has(String(entry?.id || "")))
    || submittedRules[0]
    || {};
  const condition = rule?.condition && typeof rule.condition === "object"
    ? rule.condition
    : (profile?.limits || {});
  const metric = String(condition.metric || profile?.limits?.metric || "");
  const ruleId = String(rule.id || profile?.ruleIds?.[0] || `${profile?.id || "custom"}:rule`);
  const sources = Array.isArray(profile?.sources) ? profile.sources.filter(Boolean) : [];
  const sourceCatalog = Object.fromEntries(sources
    .filter((source) => source && source.id)
    .map((source) => [String(source.id), source]));
  const sourceRefs = Array.isArray(rule.sourceRefs)
    ? rule.sourceRefs
    : (Array.isArray(profile?.sourceRefs) ? profile.sourceRefs : []);
  return {
    rule,
    ruleId,
    metric,
    operator: String(condition.operator || profile?.limits?.operator || ""),
    threshold: condition.threshold ?? profile?.limits?.threshold,
    unit: String(condition.unit || profile?.limits?.unit || ""),
    severity: String(rule.severity || "warning"),
    enforcement: String(rule.enforcement || "manual_review"),
    message: String(rule.message || "").trim(),
    sourceRefs,
    sourceCatalog,
    ruleDefinitions: {
      [ruleId]: {
        ...rule,
        id: ruleId,
        severity: String(rule.severity || "warning"),
        enforcement: String(rule.enforcement || "manual_review"),
        sourceRefs,
      },
    },
  };
}

function customMetricThreshold(definition, configuration) {
  if (definition.operator !== configuration.operator) {
    throw new TypeError(`Die Vergleichsart der eigenen Regel ${definition.metric} ist nicht ausführbar.`);
  }
  if (configuration.valueType === "time") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(definition.threshold || ""))) {
      throw new TypeError(`Der Uhrzeit-Grenzwert der eigenen Regel ${definition.metric} ist ungültig.`);
    }
    const comparable = timeMinute(definition.threshold);
    if (comparable === null) {
      throw new TypeError(`Der Uhrzeit-Grenzwert der eigenen Regel ${definition.metric} ist ungültig.`);
    }
    return { stored: String(definition.threshold), comparable };
  }
  const comparable = numeric(definition.threshold);
  if (comparable === null || !Number.isInteger(comparable) || comparable < 0) {
    throw new TypeError(`Der Grenzwert der eigenen Regel ${definition.metric} ist ungültig.`);
  }
  return { stored: comparable, comparable };
}

function customRuleContext({
  employee,
  employeeNumber,
  locationId,
  departmentId,
  assignment,
}) {
  return {
    employeeNumber: String(
      employeeNumber
      || employee?.id
      || employee?.employeeId
      || employee?.employeeNumber
      || "",
    ),
    locationId: String(locationId || ""),
    departmentId: String(departmentId || ""),
    assignmentId: String(assignment?.id || ""),
    assignmentScopeType: String(assignment?.scopeType || ""),
    assignmentScopeKey: String(assignment?.scopeKey || ""),
  };
}

function submittedShiftContextValue(shift, keys) {
  for (const key of keys) {
    if (shift?.[key] !== undefined && shift?.[key] !== null && String(shift[key]) !== "") {
      return String(shift[key]);
    }
  }
  return "";
}

function customShiftMatchesContext(shift, context) {
  const employeeId = submittedShiftContextValue(
    shift,
    ["employeeId", "employee_id", "employeeNumber", "employee_number"],
  );
  const shiftLocationId = submittedShiftContextValue(shift, ["locationId", "location_id"]);
  const shiftDepartmentId = submittedShiftContextValue(shift, ["departmentId", "department_id"]);
  return (!context.employeeNumber || !employeeId || employeeId === context.employeeNumber)
    && (!context.locationId || !shiftLocationId || shiftLocationId === context.locationId)
    && (!context.departmentId || !shiftDepartmentId || shiftDepartmentId === context.departmentId);
}

function isoDateFromNow(now) {
  if (isIsoDate(now)) return String(now);
  const submitted = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
  if (Number.isNaN(submitted.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(submitted)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function customEffectiveRange(profile, assignment, shifts, rangeStart, rangeEnd, now) {
  if (rangeStart && !isIsoDate(rangeStart)) throw new TypeError("Der Beginn des Prüfzeitraums ist ungültig.");
  if (rangeEnd && !isIsoDate(rangeEnd)) throw new TypeError("Das Ende des Prüfzeitraums ist ungültig.");
  if (rangeStart && rangeEnd && rangeEnd < rangeStart) {
    throw new TypeError("Das Ende des Prüfzeitraums darf nicht vor seinem Beginn liegen.");
  }
  const submittedRange = dateRangeFromShifts(shifts, rangeStart, rangeEnd);
  const fallbackDate = isoDateFromNow(now);
  const startCandidates = [
    submittedRange.start || fallbackDate,
    isIsoDate(profile?.validFrom) ? profile.validFrom : null,
    isIsoDate(assignment?.validFrom) ? assignment.validFrom : null,
  ].filter(Boolean);
  const endCandidates = [
    submittedRange.end || fallbackDate,
    isIsoDate(profile?.validTo) ? profile.validTo : null,
    isIsoDate(assignment?.validTo) ? assignment.validTo : null,
  ].filter(Boolean);
  const start = startCandidates.sort().at(-1) || null;
  const end = endCandidates.sort()[0] || null;
  return {
    start,
    end,
    valid: Boolean(start && end && end >= start),
  };
}

function customComparisonState(operator, actual, threshold) {
  if (actual === null || actual === undefined) return "unknown";
  if (operator === "lte") return actual <= threshold ? "pass" : "fail";
  if (operator === "gte") return actual >= threshold ? "pass" : "fail";
  throw new TypeError("Die Vergleichsart der eigenen Regel ist nicht ausführbar.");
}

function customFinding({
  definition,
  profile,
  enforcementMode,
  state,
  scope,
  evidence,
  passMessage,
  failMessage,
  unknownMessage,
}) {
  const message = state === "fail" && definition.message
    ? definition.message
    : (state === "pass" ? passMessage : (state === "fail" ? failMessage : unknownMessage));
  return createFinding({
    ruleId: definition.ruleId,
    state,
    profile,
    enforcementMode,
    scope,
    evidence,
    message,
    severity: definition.severity,
    baseEnforcement: definition.enforcement,
    sourceRefs: definition.sourceRefs,
    ruleDefinitions: definition.ruleDefinitions,
    sourceCatalog: definition.sourceCatalog,
  });
}

function customThresholdFinding({
  definition,
  profile,
  enforcementMode,
  actual,
  threshold,
  scope,
  context,
  passMessage,
  failMessage,
  unknownMessage,
  extraEvidence = {},
}) {
  const state = customComparisonState(definition.operator, actual, threshold.comparable);
  return customFinding({
    definition,
    profile,
    enforcementMode,
    state,
    scope,
    evidence: {
      metric: definition.metric,
      actual,
      threshold: threshold.stored,
      comparator: definition.operator === "lte" ? "<=" : ">=",
      unit: definition.unit,
      ...context,
      ...extraEvidence,
    },
    passMessage,
    failMessage,
    unknownMessage,
  });
}

function customNoOccurrenceFinding({
  definition,
  profile,
  enforcementMode,
  threshold,
  range,
  context,
}) {
  return customFinding({
    definition,
    profile,
    enforcementMode,
    state: "pass",
    scope: { type: "evaluation_range", start: range.start, end: range.end },
    evidence: {
      metric: definition.metric,
      actual: null,
      threshold: threshold.stored,
      comparator: definition.operator === "lte" ? "<=" : ">=",
      unit: definition.unit,
      ...context,
      occurrences: 0,
    },
    passMessage: "Im Prüfzeitraum ist kein geplanter Dienst von dieser Regel betroffen.",
    failMessage: definition.message || "Die eigene Regel ist verletzt.",
    unknownMessage: "Die eigene Regel kann für diesen Zeitraum nicht bewertet werden.",
  });
}

function evaluateCustomDailyMinutes({
  definition, profile, enforcementMode, shifts, threshold, context,
}) {
  return [...groupByDate(shifts)].map(([date, entries]) => {
    const actual = sumKnownMinutes(entries);
    return customThresholdFinding({
      definition,
      profile,
      enforcementMode,
      actual,
      threshold,
      scope: { type: "day", date, shiftIds: entries.map((entry) => entry.id) },
      context,
      passMessage: `Die geplante Arbeitszeit am ${date} hält die eigene Tagesgrenze ein.`,
      failMessage: `Die geplante Arbeitszeit am ${date} (${minutesText(actual)}) überschreitet die eigene Tagesgrenze.`,
      unknownMessage: `Die eigene Tagesgrenze am ${date} kann ohne vollständige Pausenangaben nicht bewertet werden.`,
    });
  });
}

function evaluateCustomWeeklyMinutes({
  definition, profile, enforcementMode, shifts, threshold, context,
}) {
  return [...groupByWeek(shifts)].map(([weekStart, entries]) => {
    const actual = sumKnownMinutes(entries);
    return customThresholdFinding({
      definition,
      profile,
      enforcementMode,
      actual,
      threshold,
      scope: {
        type: "week",
        weekStart,
        weekEnd: addDays(weekStart, 6),
        shiftIds: entries.map((entry) => entry.id),
      },
      context,
      passMessage: `Die geplante Arbeitszeit in der Woche ab ${weekStart} hält die eigene Wochengrenze ein.`,
      failMessage: `Die geplante Arbeitszeit in der Woche ab ${weekStart} (${minutesText(actual)}) überschreitet die eigene Wochengrenze.`,
      unknownMessage: `Die eigene Wochengrenze ab ${weekStart} kann ohne vollständige Pausenangaben nicht bewertet werden.`,
    });
  });
}

function evaluateCustomRestMinutes({
  definition, profile, enforcementMode, shifts, threshold, context,
}) {
  const sorted = [...shifts].sort((left, right) => left.startEpoch - right.startEpoch);
  const findings = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const actual = Math.round((current.startEpoch - previous.endEpoch) / 60_000);
    findings.push(customThresholdFinding({
      definition,
      profile,
      enforcementMode,
      actual,
      threshold,
      scope: {
        type: "between_shifts",
        previousShiftId: previous.id,
        nextShiftId: current.id,
        from: `${previous.endDate}T${previous.endTime}`,
        to: `${current.date}T${current.startTime}`,
      },
      context,
      passMessage: `Zwischen den Diensten ${previous.id} und ${current.id} wird die eigene Mindestruhezeit eingehalten.`,
      failMessage: `Zwischen den Diensten ${previous.id} und ${current.id} liegen nur ${minutesText(actual)} Ruhezeit.`,
      unknownMessage: "Die eigene Mindestruhezeit kann für dieses Dienstpaar nicht bewertet werden.",
      extraEvidence: { timeZone: TIME_ZONE },
    }));
  }
  return findings;
}

function customLongestConsecutiveRun(shifts) {
  const dates = [...new Set(shifts.map((shift) => shift.date))].sort();
  if (!dates.length) return { count: 0, start: null, end: null };
  let currentStart = dates[0];
  let currentEnd = dates[0];
  let currentCount = 1;
  let longest = { count: 1, start: dates[0], end: dates[0] };
  for (let index = 1; index < dates.length; index += 1) {
    if (daysBetween(currentEnd, dates[index]) === 1) {
      currentEnd = dates[index];
      currentCount += 1;
    } else {
      currentStart = dates[index];
      currentEnd = dates[index];
      currentCount = 1;
    }
    if (currentCount > longest.count) {
      longest = { count: currentCount, start: currentStart, end: currentEnd };
    }
  }
  return longest;
}

function evaluateCustomConsecutiveWorkdays({
  definition, profile, enforcementMode, shifts, threshold, context, range,
}) {
  const longest = customLongestConsecutiveRun(shifts);
  return [customThresholdFinding({
    definition,
    profile,
    enforcementMode,
    actual: longest.count,
    threshold,
    scope: {
      type: "consecutive_workdays",
      start: longest.start || range.start,
      end: longest.end || range.end,
    },
    context,
    passMessage: "Die maximale Anzahl aufeinanderfolgender Arbeitstage wird eingehalten.",
    failMessage: `${longest.count} aufeinanderfolgende Arbeitstage überschreiten die eigene Regelgrenze.`,
    unknownMessage: "Die Folge geplanter Arbeitstage kann nicht bewertet werden.",
  })];
}

function monthEnd(monthStart) {
  const year = Number(monthStart.slice(0, 4));
  const month = Number(monthStart.slice(5, 7));
  const next = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return addDays(next, -1);
}

function monthsInRange(range) {
  if (!range.valid) return [];
  const result = [];
  let cursor = `${range.start.slice(0, 7)}-01`;
  const last = `${range.end.slice(0, 7)}-01`;
  while (cursor <= last) {
    result.push(cursor);
    cursor = addDays(monthEnd(cursor), 1);
  }
  return result;
}

function evaluateCustomSaturdays({
  definition, profile, enforcementMode, shifts, threshold, context, range,
}) {
  const saturdayDates = new Set(
    shifts.filter((shift) => dayOfWeek(shift.date) === 6).map((shift) => shift.date),
  );
  return monthsInRange(range).map((monthStart) => {
    const end = monthEnd(monthStart);
    const actual = [...saturdayDates].filter((date) => date >= monthStart && date <= end).length;
    const coverageComplete = range.start <= monthStart && range.end >= end;
    const comparedState = customComparisonState(definition.operator, actual, threshold.comparable);
    const state = comparedState === "fail" || coverageComplete ? comparedState : "unknown";
    return customFinding({
      definition,
      profile,
      enforcementMode,
      state,
      scope: { type: "calendar_month", start: monthStart, end },
      evidence: {
        metric: definition.metric,
        actual,
        threshold: threshold.stored,
        comparator: "<=",
        unit: definition.unit,
        coverageComplete,
        saturdayDates: [...saturdayDates].filter((date) => date >= monthStart && date <= end).sort(),
        ...context,
      },
      passMessage: `Im Monat ${monthStart.slice(0, 7)} wird die eigene Samstagsgrenze eingehalten.`,
      failMessage: `${actual} geplante Samstage im Monat ${monthStart.slice(0, 7)} überschreiten die eigene Regelgrenze.`,
      unknownMessage: `Die Samstagsgrenze für ${monthStart.slice(0, 7)} benötigt einen vollständigen Kalendermonat.`,
    });
  });
}

function evaluateCustomShiftTimes({
  definition, profile, enforcementMode, shifts, threshold, context,
}) {
  const earliest = definition.metric === "earliest_shift_start_time";
  return shifts.map((shift) => {
    const rawMinute = timeMinute(earliest ? shift.startTime : shift.endTime);
    const actual = rawMinute === null
      ? null
      : rawMinute + (!earliest && shift.endDate !== shift.date ? 1440 : 0);
    const actualLabel = earliest
      ? shift.startTime
      : `${shift.endDate !== shift.date ? `${shift.endDate} ` : ""}${shift.endTime}`;
    return customThresholdFinding({
      definition,
      profile,
      enforcementMode,
      actual,
      threshold,
      scope: { type: "shift", shiftId: shift.id, date: shift.date },
      context,
      passMessage: `Der Dienst ${shift.id} hält die eigene Uhrzeitgrenze ein.`,
      failMessage: `Der Dienst ${shift.id} mit ${actualLabel} verletzt die eigene Uhrzeitgrenze.`,
      unknownMessage: `Die Uhrzeitgrenze kann für den Dienst ${shift.id} nicht bewertet werden.`,
      extraEvidence: {
        actualTime: actualLabel,
        thresholdTime: threshold.stored,
        timeZone: TIME_ZONE,
      },
    });
  });
}

function customUnsupportedResult(profile, assignment, definition, context, range) {
  const core = {
    supported: false,
    unsupportedMetric: definition.metric || null,
    reason: "unsupported_metric",
    engineVersion: ENGINE_VERSION,
    catalogVersion: profile?.catalogVersion || CATALOG_VERSION,
    basis: "planned_schedule",
    timeZone: TIME_ZONE,
    profile: { id: String(profile?.id || ""), version: profile?.version || null },
    assignment: { id: String(assignment?.id || ""), enforcementMode: String(assignment?.enforcementMode || "monitor") },
    enforcementMode: String(assignment?.enforcementMode || "monitor"),
    range,
    employeeId: context.employeeNumber,
    findings: [],
  };
  return {
    ...core,
    summary: { ...summarize([]), requiresManualReview: true },
    fingerprint: fingerprint(core),
    legalNotice: "Diese eigene Regel besitzt keinen freigegebenen Dienstplanadapter und wurde nicht ausgewertet.",
  };
}

function evaluateCustomPlannedSchedule({
  profile,
  assignment = {},
  shifts = [],
  rangeStart,
  rangeEnd,
  employee = {},
  employeeNumber = "",
  locationId = "",
  departmentId = "",
  now,
} = {}) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TypeError("Für die eigene Dienstplanregel fehlt ein Regelprofil.");
  }
  if (profile.profile && typeof profile.profile === "object" && !Array.isArray(profile.profile)) {
    profile = {
      ...profile.profile,
      rules: Array.isArray(profile.rules) ? profile.rules : profile.profile.rules,
      sources: Array.isArray(profile.sources) ? profile.sources : profile.profile.sources,
    };
  }
  if (!profile.id) throw new TypeError("Für die eigene Dienstplanregel fehlt eine Profil-ID.");
  let definition = customRuleDefinition(profile);
  const context = customRuleContext({
    employee,
    employeeNumber,
    locationId,
    departmentId,
    assignment,
  });
  const submittedShifts = (Array.isArray(shifts) ? shifts : [])
    .filter((shift) => customShiftMatchesContext(shift, context));
  const normalized = submittedShifts.map((shift, index) => normalizeShift(shift, index, TIME_ZONE));
  const range = customEffectiveRange(profile, assignment, normalized, rangeStart, rangeEnd, now);
  const configuration = CUSTOM_PLANNED_METRICS[definition.metric];
  if (!configuration) return customUnsupportedResult(profile, assignment, definition, context, range);
  definition = { ...definition, unit: definition.unit || configuration.unit };
  const threshold = customMetricThreshold(definition, configuration);
  const enforcementMode = String(assignment.enforcementMode || profile.defaultEnforcementMode || "monitor");
  if (!["monitor", "enforced"].includes(enforcementMode)) {
    throw new TypeError("Der Durchsetzungsmodus der eigenen Regel ist ungültig.");
  }
  if (!range.valid) {
    const core = {
      supported: true,
      applicable: false,
      reason: "outside_validity_or_missing_range",
      engineVersion: ENGINE_VERSION,
      catalogVersion: profile.catalogVersion || CATALOG_VERSION,
      basis: "planned_schedule",
      timeZone: TIME_ZONE,
      profile: { id: profile.id, version: profile.version || null },
      assignment: { id: String(assignment.id || ""), enforcementMode },
      enforcementMode,
      range,
      employeeId: context.employeeNumber,
      findings: [],
    };
    return {
      ...core,
      summary: { ...summarize([]), requiresManualReview: true },
      fingerprint: fingerprint(core),
      legalNotice: "Technische Planprüfung; keine Rechtsberatung oder Bestätigung der Rechtskonformität.",
    };
  }
  const invalidShifts = normalized.filter((shift) => (
    !shift.valid && (!isIsoDate(shift.date) || (shift.date >= range.start && shift.date <= range.end))
  ));
  const validShifts = normalized.filter((shift) => (
    shift.valid && shift.date >= range.start && shift.date <= range.end
  ));
  let findings;
  const common = {
    definition,
    profile,
    enforcementMode,
    shifts: validShifts,
    threshold,
    context,
    range,
  };
  if (definition.metric === "maximum_planned_daily_minutes") {
    findings = evaluateCustomDailyMinutes(common);
  } else if (definition.metric === "maximum_planned_weekly_minutes") {
    findings = evaluateCustomWeeklyMinutes(common);
  } else if (definition.metric === "minimum_planned_rest_minutes") {
    findings = evaluateCustomRestMinutes(common);
  } else if (definition.metric === "maximum_consecutive_workdays") {
    findings = evaluateCustomConsecutiveWorkdays(common);
  } else if (definition.metric === "maximum_saturdays_per_month") {
    findings = evaluateCustomSaturdays(common);
  } else {
    findings = evaluateCustomShiftTimes(common);
  }
  if (!findings.length) {
    findings.push(customNoOccurrenceFinding({
      definition,
      profile,
      enforcementMode,
      threshold,
      range,
      context,
    }));
  }
  for (const shift of invalidShifts) {
    findings.push(createFinding({
      ruleId: `${definition.ruleId}:input`,
      state: "unknown",
      profile,
      enforcementMode,
      severity: "warning",
      baseEnforcement: "manual_review",
      scope: { type: "shift", shiftId: shift.id },
      evidence: {
        metric: "valid_planned_shift",
        date: shift.date,
        startTime: shift.startTime,
        endTime: shift.endTime,
        ...context,
      },
      message: `Der geplante Dienst ${shift.id} enthält kein auswertbares Datum/Zeitintervall.`,
      sourceRefs: [],
      ruleDefinitions: {},
      sourceCatalog: {},
    }));
  }
  if (enforcementMode === "enforced" && assignment.applicabilityConfirmed !== true) {
    findings = findings.map((finding) => createFinding({
      ...finding,
      state: "unknown",
      profile,
      enforcementMode,
      baseEnforcement: "manual_review",
      evidence: {
        ...finding.evidence,
        conditionalResult: finding.state,
        applicabilityReason: "assignment_not_confirmed",
      },
      message: `${finding.message} Die betriebliche Anwendbarkeit der eigenen Regel ist nicht bestätigt.`,
      ruleDefinitions: definition.ruleDefinitions,
      sourceCatalog: definition.sourceCatalog,
    }));
  }
  const resultCore = {
    supported: true,
    applicable: true,
    engineVersion: ENGINE_VERSION,
    catalogVersion: profile.catalogVersion || CATALOG_VERSION,
    basis: "planned_schedule",
    timeZone: TIME_ZONE,
    profile: { id: profile.id, version: profile.version || null },
    assignment: {
      id: String(assignment.id || ""),
      enforcementMode,
      scopeType: String(assignment.scopeType || ""),
      scopeKey: String(assignment.scopeKey || ""),
    },
    enforcementMode,
    range,
    employeeId: context.employeeNumber,
    locationId: context.locationId,
    departmentId: context.departmentId,
    findings,
  };
  return {
    ...resultCore,
    summary: summarize(findings),
    fingerprint: fingerprint(resultCore),
    legalNotice: "Technische Planprüfung; keine Rechtsberatung oder Bestätigung der Rechtskonformität.",
  };
}

function evaluatePlannedSchedule({
  basis = "planned",
  profileId = "at-retail-adult-monitor",
  profile: submittedProfile,
  enforcementMode,
  shifts = [],
  schoolAttendance = [],
  planningProtection = null,
  employee = {},
  rangeStart,
  rangeEnd,
  holidays = [],
  applicabilityConfirmed = false,
  timeZone = TIME_ZONE,
  ruleDefinitions: submittedRuleDefinitions,
  sourceCatalog: submittedSourceCatalog,
} = {}) {
  if (!["planned", "planned_schedule"].includes(String(basis))) {
    throw new TypeError("Die Arbeitszeitregel-Engine bewertet ausschließlich geplante Dienste, keine Ist-Zeiterfassung.");
  }
  if (timeZone !== TIME_ZONE) {
    throw new TypeError(`Dieses Regelprofil ist ausschließlich für die Zeitzone ${TIME_ZONE} definiert.`);
  }
  const profile = submittedProfile || getProfile(profileId);
  if (!profile) return invalidProfileResult(profileId, "Das angeforderte Regelprofil ist nicht vorhanden.");
  if (profile.id === PLANNING_PROTECTION_PROFILE_ID) {
    if (profile.status !== "active" || profile.version !== "2026.4") {
      return invalidProfileResult(profile.id, "Die Version des Auflagenprofils wird nicht unterstützt.");
    }
    const normalized = (Array.isArray(shifts) ? shifts : []).map((shift, index) => {
      const normalizedShift = normalizeShift(shift, index, timeZone);
      return { ...normalizedShift, valid: normalizedShift.valid && strictIsoDate(normalizedShift.date) && strictIsoDate(normalizedShift.endDate) };
    });
    const valid = normalized.filter(shift => shift.valid);
    const range = dateRangeFromShifts(valid, rangeStart, rangeEnd);
    const ruleDefinitions = catalogById(submittedRuleDefinitions, RULE_DEFINITIONS);
    const sourceCatalog = catalogById(submittedSourceCatalog, SOURCE_CATALOG);
    const findings = evaluatePlanningProtectionRules({ planningProtection, shifts: valid, range,
      holidays: holidaySetForRange(range, holidays), schoolAttendance, employee, timeZone,
      finding: params => createFinding({ profile, ruleDefinitions, sourceCatalog, ...params }) });
    for (const shift of normalized.filter(shift => !shift.valid)) findings.push(createFinding({
      ruleId: "at.input.shift", state: "unknown", profile, enforcementMode: "monitor", sourceRefs: [],
      scope: { type: "shift", shiftId: shift.id }, evidence: { metric: "valid_planned_shift", enforcementBasis: "controlled_protection_monitor" },
      message: "Ein geplanter Dienst enthält ungültige Zeitangaben und muss fachlich geprüft werden.",
    }));
    const core = { engineVersion: ENGINE_VERSION, catalogVersion: profile.catalogVersion,
      basis: "planned_schedule", timeZone, profile: { id: profile.id, version: profile.version },
      enforcementMode: "monitor", range, employeeId: String(employee?.id || employee?.employeeId || ""), findings };
    return { ...core, summary: summarize(findings), fingerprint: fingerprint(core),
      legalNotice: "Die technische Planprüfung im Monitorbetrieb ersetzt keine fachliche Freigabe des konkreten Einsatzes." };
  }
  if (
    profile.status !== "active"
    || (profile.assignable !== true && profile.applicability?.automaticByBirthDate !== true)
  ) {
    return invalidProfileResult(profile.id, "Das Regelprofil ist ein nicht zuweisbarer Entwurf und muss fachlich bestätigt werden.");
  }
  const mode = String(enforcementMode || profile.defaultEnforcementMode || "monitor");
  if (!["monitor", "enforced"].includes(mode)) throw new TypeError("Ungültiger Durchsetzungsmodus.");

  const ruleDefinitions = catalogById(submittedRuleDefinitions, RULE_DEFINITIONS);
  const sourceCatalog = catalogById(submittedSourceCatalog, SOURCE_CATALOG);
  const normalizedShifts = (Array.isArray(shifts) ? shifts : []).map((shift, index) => normalizeShift(shift, index, timeZone));
  const invalidShifts = normalizedShifts.filter((shift) => !shift.valid);
  const validShifts = normalizedShifts.filter((shift) => shift.valid);
  const range = dateRangeFromShifts(validShifts, rangeStart, rangeEnd);
  const referenceDate = range.start || new Date().toISOString().slice(0, 10);
  const youthProfile = isYouthProfile(profile);
  let applicability = youthProfile
    ? determineYouthApplicability(employee, referenceDate)
    : determineAdultApplicability(employee, referenceDate);
  if (
    !youthProfile
    && mode === "enforced"
    && profile.applicability?.confirmationRequired
    && applicabilityConfirmed !== true
  ) {
    applicability = { state: "unknown", reason: "profile_not_confirmed" };
  }

  let findings = [createFinding({
    ruleId: youthProfile ? "at.applicability.youth" : "at.applicability.adult",
    state: applicability.state,
    profile,
    enforcementMode: mode,
    ruleDefinitions,
    sourceCatalog,
    scope: { type: "employee", employeeId: String(employee?.id || employee?.employeeId || "") },
    evidence: {
      metric: "profile_applicability",
      reason: applicability.reason,
      ageAtRangeStart: applicability.age ?? null,
      profileConfirmed: applicabilityConfirmed === true,
    },
    message: applicability.state === "pass"
      ? (youthProfile
        ? "Das Geburtsdatum bestätigt die Anwendbarkeit des Jugendprofils unter 18."
        : (applicabilityConfirmed === true
          ? "Das Erwachsenenprofil und seine betriebliche Anwendbarkeit sind für diese Bewertung bestätigt."
          : "Die Volljährigkeit ist bestätigt; das Erwachsenenprofil wird ausschließlich im Monitorbetrieb geprüft."))
      : (applicability.reason === "minor_requires_kjbg_profile"
        ? "Für minderjährige Beschäftigte ist ein gesondertes KJBG-/Jugendlichenprofil erforderlich."
        : (applicability.reason === "age_not_confirmed"
          ? "Das Geburtsdatum fehlt oder ist nicht auswertbar; die passende Altersregel kann noch nicht automatisch gewählt werden."
          : "Das ausgewählte Altersprofil ist für diese Bewertung nicht anwendbar.")),
  })];

  for (const shift of invalidShifts) {
    findings.push(createFinding({
      ruleId: "at.input.shift",
      state: "unknown",
      severity: "error",
      baseEnforcement: "manual_review",
      profile,
      enforcementMode: mode,
      ruleDefinitions,
      sourceCatalog,
      scope: { type: "shift", shiftId: shift.id },
      evidence: {
        metric: "valid_planned_shift",
        date: shift.date,
        startTime: shift.startTime,
        endTime: shift.endTime,
      },
      message: `Der geplante Dienst ${shift.id} enthält kein auswertbares Datum/Zeitintervall.`,
      sourceRefs: [],
    }));
  }

  if (validShifts.length) {
    const activeRuleIds = new Set(profile.ruleIds);
    const thresholdFindings = youthProfile
      ? evaluateYouthRules({
        profile,
        enforcementMode: mode,
        shifts: validShifts,
        employee,
        holidays: holidaySetForRange(range, holidays),
        ruleDefinitions,
        sourceCatalog,
        timeZone,
      }).filter((finding) => activeRuleIds.has(finding.ruleId))
      : evaluateThresholds({
        profile,
        enforcementMode: mode,
        shifts: validShifts,
        ruleDefinitions,
        sourceCatalog,
      }).filter((finding) => activeRuleIds.has(finding.ruleId));
    if (!youthProfile) {
      const weeks = completeWeekStarts(range);
      const weeklyMinutes = weeklyMinutesMap(validShifts, weeks);
      if (activeRuleIds.has("at.azg.trade.average.4weeks")) {
        thresholdFindings.push(...evaluateRollingAverage({
          ruleId: "at.azg.trade.average.4weeks",
          weeks,
          weeklyMinutes,
          windowSize: 4,
          threshold: profile.limits.average4WeeksMinutes,
          profile,
          enforcementMode: mode,
          ruleDefinitions,
          sourceCatalog,
        }));
      }
      if (activeRuleIds.has("at.azg.average.17weeks")) {
        thresholdFindings.push(...evaluateRollingAverage({
          ruleId: "at.azg.average.17weeks",
          weeks,
          weeklyMinutes,
          windowSize: 17,
          threshold: profile.limits.average17WeeksMinutes,
          profile,
          enforcementMode: mode,
          ruleDefinitions,
          sourceCatalog,
        }));
      }
      thresholdFindings.push(...evaluateRest({
        profile,
        enforcementMode: mode,
        shifts: validShifts,
        range,
        timeZone,
        ruleDefinitions,
        sourceCatalog,
      }).filter((finding) => activeRuleIds.has(finding.ruleId)));
      thresholdFindings.push(...evaluateRestDayWork({
        profile,
        enforcementMode: mode,
        shifts: validShifts,
        holidays: holidaySetForRange(range, holidays),
        ruleDefinitions,
        sourceCatalog,
      }).filter((finding) => activeRuleIds.has(finding.ruleId)));
    }
    findings.push(...replaceWithApplicabilityUnknown(
      thresholdFindings,
      applicability,
      profile,
      mode,
      ruleDefinitions,
      sourceCatalog,
    ));
  }

  if (!youthProfile || completedYouthProfile(profile)) {
    findings.push(...evaluateVocationalSchoolRules({
      profile, enforcementMode: mode, shifts: validShifts, employee, schoolAttendance, range, ruleDefinitions, sourceCatalog,
    }));
  }

  const resultCore = {
    engineVersion: ENGINE_VERSION,
    catalogVersion: schoolAttendance.length ? CATALOG_VERSION : (profile.catalogVersion || CATALOG_VERSION),
    basis: "planned_schedule",
    timeZone,
    profile: { id: profile.id, version: profile.version },
    enforcementMode: mode,
    range,
    employeeId: String(employee?.id || employee?.employeeId || ""),
    findings,
  };
  return {
    ...resultCore,
    summary: summarize(findings),
    fingerprint: fingerprint(resultCore),
    legalNotice: "Technische Planprüfung; keine Rechtsberatung oder Bestätigung der Rechtskonformität.",
  };
}

module.exports = {
  PLANNING_PROTECTION_PROFILE_ID,
  projectPlanningProtection,
  normalizePlanningProtection,
  ageOnDate,
  ENGINE_VERSION,
  TIME_ZONE,
  WORK_RULE_ENGINE_VERSION: ENGINE_VERSION,
  determineAdultApplicability,
  determineYouthApplicability,
  evaluateCustomPlannedSchedule,
  evaluatePlannedSchedule,
  normalizeShift,
  summarize,
};

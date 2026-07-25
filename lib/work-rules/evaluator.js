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

const ENGINE_VERSION = "at-planned-work-evaluator-v1";
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
  if (!isIsoDate(birthDate) || !isIsoDate(referenceDate)) return null;
  let age = Number(referenceDate.slice(0, 4)) - Number(birthDate.slice(0, 4));
  if (referenceDate.slice(5) < birthDate.slice(5)) age -= 1;
  return age;
}

function determineAdultApplicability(employee, referenceDate) {
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
  const birthDate = String(employee?.birthDate || employee?.dateOfBirth || "");
  const age = ageOnDate(birthDate, referenceDate);
  if (age === null) return { state: "unknown", reason: "age_not_confirmed" };
  return age < 18
    ? { state: "pass", reason: "youth_birth_date", age }
    : { state: "unknown", reason: "adult_requires_adult_profile", age };
}

function youthEmployeeLabel(employee) {
  return employee?.isApprentice === true || String(employee?.positionId || "") === "lehrling"
    ? "Lehrling unter 18"
    : "Jugendliche beschäftigte Person unter 18";
}

function isYouthProfile(profile) {
  return String(profile?.id || "") === "at-retail-youth-monitor";
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

function evaluateYouthThresholds({
  profile, enforcementMode, shifts, employee, ruleDefinitions, sourceCatalog,
}) {
  const findings = [];
  const birthDate = String(employee?.birthDate || employee?.dateOfBirth || "");
  const employeeLabel = youthEmployeeLabel(employee);
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
        comparator: gross > profile.limits.breakTriggerMinutes ? ">=" : "not_applicable",
      },
      message: breakState === "pass"
        ? `${employeeLabel}: Die Pausenregel ab mehr als viereinhalb Stunden ist am ${date} eingehalten.`
        : (breakState === "fail"
          ? `Achtung, ${employeeLabel}: Am ${date} sind bei mehr als viereinhalb Stunden weniger als 30 Minuten Pause geplant.`
          : `${employeeLabel}: Am ${date} fehlt eine prüfbare Pausenangabe.`),
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
  const employeeLabel = youthEmployeeLabel(employee);
  const birthDate = String(employee?.birthDate || employee?.dateOfBirth || "");
  const sorted = [...shifts].sort((left, right) => left.startEpoch - right.startEpoch);
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
  const employeeLabel = youthEmployeeLabel(employee);
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
  const employeeLabel = youthEmployeeLabel(employee);
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
  for (let index = 1; index < afternoonSaturdays.length; index += 1) {
    const previous = afternoonSaturdays[index - 1];
    const current = afternoonSaturdays[index];
    if (daysBetween(previous, current) !== 7) continue;
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
        metric: "youth_consecutive_saturday_afternoons",
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

function evaluatePlannedSchedule({
  basis = "planned",
  profileId = "at-retail-adult-monitor",
  profile: submittedProfile,
  enforcementMode,
  shifts = [],
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

  const resultCore = {
    engineVersion: ENGINE_VERSION,
    catalogVersion: profile.catalogVersion || CATALOG_VERSION,
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
  ageOnDate,
  ENGINE_VERSION,
  TIME_ZONE,
  WORK_RULE_ENGINE_VERSION: ENGINE_VERSION,
  determineAdultApplicability,
  determineYouthApplicability,
  evaluatePlannedSchedule,
  normalizeShift,
  summarize,
};

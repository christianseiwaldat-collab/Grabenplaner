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

function determineAdultApplicability(employee, referenceDate) {
  if (employee?.isAdult === true) return { state: "pass", reason: "explicit_adult" };
  if (employee?.isAdult === false) return { state: "unknown", reason: "minor_requires_kjbg_profile" };
  const birthDate = String(employee?.birthDate || employee?.dateOfBirth || "");
  if (!isIsoDate(birthDate) || !isIsoDate(referenceDate)) {
    return { state: "unknown", reason: "age_not_confirmed" };
  }
  let age = Number(referenceDate.slice(0, 4)) - Number(birthDate.slice(0, 4));
  if (referenceDate.slice(5) < birthDate.slice(5)) age -= 1;
  return age >= 18
    ? { state: "pass", reason: "birth_date", age }
    : { state: "unknown", reason: "minor_requires_kjbg_profile", age };
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
  if (profile.status !== "active" || profile.assignable !== true) {
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
  let applicability = determineAdultApplicability(employee, referenceDate);
  if (profile.applicability?.confirmationRequired && applicabilityConfirmed !== true) {
    applicability = { state: "unknown", reason: "profile_not_confirmed" };
  }

  let findings = [createFinding({
    ruleId: "at.applicability.adult",
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
      ? "Das Erwachsenenprofil und seine betriebliche Anwendbarkeit sind für diese Bewertung bestätigt."
      : (applicability.reason === "minor_requires_kjbg_profile"
        ? "Für minderjährige Beschäftigte ist ein gesondertes KJBG-/Jugendlichenprofil erforderlich."
        : "Alter oder betriebliche Profilanwendbarkeit sind nicht vollständig bestätigt."),
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
    const thresholdFindings = evaluateThresholds({
      profile,
      enforcementMode: mode,
      shifts: validShifts,
      ruleDefinitions,
      sourceCatalog,
    })
      .filter((finding) => activeRuleIds.has(finding.ruleId));
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
    })
      .filter((finding) => activeRuleIds.has(finding.ruleId)));
    thresholdFindings.push(...evaluateRestDayWork({
      profile,
      enforcementMode: mode,
      shifts: validShifts,
      holidays: holidaySetForRange(range, holidays),
      ruleDefinitions,
      sourceCatalog,
    }).filter((finding) => activeRuleIds.has(finding.ruleId)));
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
  ENGINE_VERSION,
  TIME_ZONE,
  WORK_RULE_ENGINE_VERSION: ENGINE_VERSION,
  determineAdultApplicability,
  evaluatePlannedSchedule,
  normalizeShift,
  summarize,
};

"use strict";

const { addDays, austrianNationalHolidays, dayOfWeek, daysBetween, localDateTimeToEpoch, mondayOfWeek } = require("./calendar");
const { apprenticeshipApplicabilityOnDate, strictIsoDate } = require("./vocational-school");
const { fingerprint } = require("./receipt");
const { RETAIL_KV_SOURCE } = require("../personnel-retail-kv");

const RETAIL_KV_PROFILE_ID = "at-retail-kv-angestellte-2026";
const RETAIL_KV_ENGINE_VERSION = "at-retail-kv-planned-evaluator-v1";
const RETAIL_KV_CATALOG_VERSION = "at-retail-kv-angestellte-2026.1";
const RETAIL_KV_SOURCE_ID = RETAIL_KV_SOURCE.id;
const RETAIL_KV_SOURCES = Object.freeze({ [RETAIL_KV_SOURCE_ID]: RETAIL_KV_SOURCE });
const RETAIL_KV_RULES = Object.freeze(Object.fromEntries([
  ["applicability", "Bestätigte datierte KV-Geltung", "1.A", "manual_review"],
  ["model", "Belegtes Arbeitszeitmodell", "2.A.2–7", "manual_review"],
  ["normal.daily", "Planung der täglichen Normalarbeitszeit", "2.A.2;2.G.1", "advisory"],
  ["normal.weekly", "Planung der wöchentlichen Normalarbeitszeit", "2.A.1;2.E;2.G.1", "advisory"],
  ["contract.weekly", "Planung gegenüber vereinbarten Wochenstunden", "2.A.2;2.G.1.4", "advisory"],
  ["averaging", "Belegte Durchrechnungsperiode", "2.A.7", "manual_review"],
  ["daily-rest", "Ruhe zwischen Arbeitsperioden", "2.A.8", "exception_required"],
  ["saturday-free", "Freier Folgesamstag", "2.B.2;2.C.2–3", "exception_required"],
  ["free-time", "Ganze oder halbe freie Werktage", "2.B.1;2.C.1", "manual_review"],
  ["special-date", "Einsatz am 24. oder 31. Dezember", "2.B.1.4;2.C.1.4–1.5", "exception_required"],
  ["rest-day", "Einsatz an Sonn- und Feiertagen", "2.I", "exception_required"],
  ["youth-free-time", "Zusätzliche KV-Wochenfreizeit Jugendlicher", "2.D", "exception_required"],
  ["school-combination", "Schule und KV-Normalzeit gemeinsam prüfen", "2.A;2.D", "manual_review"],
  ["schedule-agreement", "Vereinbarte Lage der Arbeitszeit", "2.A.2.1–2.3;2.A.7.3–7.4", "manual_review"],
  ["input", "Prüfbare Dienste und Pausen", "2.A.2.1", "manual_review"],
].map(([suffix, title, section, enforcement]) => {
  const id = `at.retail-kv.${suffix}`;
  return [id, Object.freeze({ id, title, section, severity: "warning", enforcement,
    sourceRefs: Object.freeze([RETAIL_KV_SOURCE_ID]) })];
})));
const RETAIL_KV_PROFILE = Object.freeze({
  id: RETAIL_KV_PROFILE_ID, version: "2026.5", catalogVersion: RETAIL_KV_CATALOG_VERSION,
  snapshotSchemaVersion: 2, title: "Österreich – Handelsangestellte und Lehrlinge 2026 (Monitor)",
  status: "active", assignable: false, validFrom: RETAIL_KV_SOURCE.validFrom, validTo: RETAIL_KV_SOURCE.validTo,
  defaultEnforcementMode: "monitor",
  applicability: Object.freeze({ jurisdiction: "AT", sector: "retail", employeeGroups: Object.freeze(["salaried", "apprentice"]),
    confirmationRequired: true, governedBindingRequired: true,
    note: "Nur mit verifizierter KV-Zuordnung und datierten persönlichen sowie betrieblichen Fakten." }),
  limits: Object.freeze({ normalWeeklyMinutes: 2310, basicDailyMinutes: 480, redistributionDailyMinutes: 540,
    averagingWeeklyMinutes: 2640, standardRestMinutes: 660, saturdayAfternoonMinute: 780 }),
  ruleIds: Object.freeze(Object.keys(RETAIL_KV_RULES)), sourceRefs: Object.freeze([RETAIL_KV_SOURCE_ID]),
});

const time = value => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const idOf = row => String(row?.employeeId ?? row?.employee_id ?? row?.employeeNumber ?? row?.employee_number ?? "");
const dateList = (start, end) => {
  if (!strictIsoDate(start) || !strictIsoDate(end) || end < start || daysBetween(start, end) > 370) throw new TypeError("Ungültiger KV-Prüfzeitraum.");
  return Array.from({ length: daysBetween(start, end) + 1 }, (_, index) => addDays(start, index));
};
const ageAt = (employee, date) => {
  if (employee?.birthDateConfirmed === false || !strictIsoDate(employee?.birthDate) || employee.birthDate > date) return null;
  return Number(date.slice(0, 4)) - Number(employee.birthDate.slice(0, 4)) - (date.slice(5) < employee.birthDate.slice(5) ? 1 : 0);
};

function normalizeShift(row, index, timeZone) {
  const date = row?.date ?? row?.shiftDate;
  const startTime = row?.startTime ?? row?.start, endTime = row?.endTime ?? row?.end;
  const start = strictIsoDate(date) && time(startTime) ? localDateTimeToEpoch(date, startTime, timeZone) : NaN;
  const endDate = time(startTime) && time(endTime) && endTime <= startTime && strictIsoDate(date) ? addDays(date, 1) : date;
  const end = strictIsoDate(endDate) && time(endTime) ? localDateTimeToEpoch(endDate, endTime, timeZone) : NaN;
  const gross = (end - start) / 60000;
  const breakMinutes = row?.breakMinutes;
  const durationKnown = Number.isFinite(gross) && gross > 0 && Number.isInteger(breakMinutes)
    && breakMinutes >= 0 && breakMinutes <= gross && row?.breakSource !== "configured_assumption";
  let intervalsKnown = Array.isArray(row?.breakIntervals);
  const breaks = intervalsKnown ? row.breakIntervals.map(interval => {
    const from = time(interval?.startTime) ? localDateTimeToEpoch(date, interval.startTime, timeZone) : NaN;
    let to = time(interval?.endTime) ? localDateTimeToEpoch(date, interval.endTime, timeZone) : NaN;
    if (to <= from && endDate !== date) to = localDateTimeToEpoch(endDate, interval.endTime, timeZone);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < start || to > end || to <= from) intervalsKnown = false;
    return { start: from, end: to };
  }).sort((a, b) => a.start - b.start) : [];
  if (breaks.some((interval, i) => i > 0 && interval.start < breaks[i - 1].end)) intervalsKnown = false;
  if (intervalsKnown && breaks.reduce((sum, interval) => sum + (interval.end - interval.start) / 60000, 0) !== breakMinutes) intervalsKnown = false;
  return { id: String(row?.id ?? `kv-shift-${index + 1}`), employeeId: idOf(row), date, endDate, start, end, gross,
    valid: strictIsoDate(date) && Number.isFinite(start) && Number.isFinite(end) && end > start,
    breakMinutes, breaks, intervalsKnown, durationKnown: durationKnown && (!Array.isArray(row?.breakIntervals) || intervalsKnown),
    net: durationKnown ? gross - breakMinutes : null };
}

function evaluateRetailKvPlanning({ employee = {}, shifts = [], calendarScope, planningCoverage = {}, applicability = [],
  timeZone = "Europe/Vienna", holidays = [], schoolAttendance = [], additionalWorkEvents = [], scheduleAgreement = null } = {}) {
  const dates = dateList(calendarScope?.start, calendarScope?.end);
  const employeeId = String(employee.id ?? employee.employeeId ?? employee.employeeNumber ?? "");
  const findings = [];
  const add = (suffix, state, scope, evidence, message) => {
    const definition = RETAIL_KV_RULES[`at.retail-kv.${suffix}`];
    const core = { ruleId: definition.id, profileId: RETAIL_KV_PROFILE.id, profileVersion: RETAIL_KV_PROFILE.version,
      state, severity: definition.severity, baseEnforcement: definition.enforcement, effectiveEnforcement: "advisory", scope,
      evidence: { ...evidence, enforcementBasis: "controlled_retail_kv_monitor", coverageBasis: "declared_planned_schedule" }, message,
      sourceRefs: [{ id: RETAIL_KV_SOURCE_ID, title: RETAIL_KV_SOURCE.title, url: RETAIL_KV_SOURCE.url }] };
    findings.push({ ...core, fingerprint: fingerprint(core) });
  };
  const facts = new Map();
  for (const row of Array.isArray(applicability) ? applicability : []) {
    if (!strictIsoDate(row?.date)) continue;
    facts.set(row.date, facts.has(row.date) ? null : row);
  }
  const resolved = date => {
    const row = facts.get(date);
    if (!row) return { state: "unknown", row: null };
    if (row.enabled === false || row.state === "disabled") return { state: "disabled", row };
    if (date < RETAIL_KV_SOURCE.validFrom || date > RETAIL_KV_SOURCE.validTo) return { state: "unknown", row: null };
    if (row.state === "not_applicable" && row.employeeGroup === "not_applicable") return { state: "not_applicable", row };
    if (row.enabled !== true || row.state !== "confirmed" || row.sourceVerified !== true
      || !["salaried", "apprentice"].includes(row.employeeGroup)) return { state: "unknown", row };
    const apprentice = apprenticeshipApplicabilityOnDate(employee, date);
    if (row.employeeGroup === "apprentice" && apprentice.state !== "pass") return { state: "unknown", row };
    if (row.employeeGroup === "salaried" && (apprentice.state === "pass"
      || (apprentice.state === "unknown" && (employee.isApprentice === true || employee.apprenticeshipStatus === "active")))) return { state: "unknown", row };
    return { state: "confirmed", row };
  };
  const covers = (start, end) => planningCoverage.complete === true && strictIsoDate(planningCoverage.start)
    && strictIsoDate(planningCoverage.end) && planningCoverage.start <= start && planningCoverage.end >= end;
  const wholeConfirmed = (start, end) => dateList(start, end).every(date => resolved(date).state === "confirmed");
  const schoolOn = date => (Array.isArray(schoolAttendance) ? schoolAttendance : []).some(row => {
    if (idOf(row) && idOf(row) !== employeeId) return false;
    const from = row.dateFrom || row.date, to = row.dateTo || row.date || from;
    return strictIsoDate(from) && strictIsoDate(to) && from <= date && date <= to;
  });
  const potentialWork = (Array.isArray(additionalWorkEvents) ? additionalWorkEvents : []).filter(row => !idOf(row) || idOf(row) === employeeId);
  const additionalOn = date => potentialWork.some(row => {
    const from = row?.dateFrom || row?.date, to = row?.dateTo || row?.date || from;
    // Invalid dates cannot safely establish an empty day. Only event timing is
    // consumed; notes, private identifiers and unproved zero minutes are not.
    return !strictIsoDate(from) || !strictIsoDate(to) || to < from || (from <= date && date <= to);
  });
  const allDisabled = dates.every(date => resolved(date).state === "disabled");
  if (!allDisabled) for (const date of dates) {
    const state = resolved(date).state;
    add("applicability", ["confirmed", "not_applicable"].includes(state) ? "pass" : "unknown", { type: "day", date },
      { metric: "verified_dated_kv_applicability", applicabilityConfirmed: state === "confirmed", notApplicable: state === "not_applicable" },
      ["confirmed", "not_applicable"].includes(state) ? "Die datierte KV-Geltung ist für diesen Tag verifiziert."
        : "KV-Geltung, persönliche Gruppe, gültige Quelle oder echte Freigabebindung sind für diesen Tag ungeklärt.");
  }
  const normalized = (Array.isArray(shifts) ? shifts : []).filter(row => !idOf(row) || idOf(row) === employeeId)
    .map((row, index) => normalizeShift(row, index, timeZone));
  const byDate = new Map();
  const unreliableDates = new Set();
  let undatedShiftReview = false;
  for (const shift of normalized) {
    if (!shift.valid || !shift.employeeId || !employeeId) {
      if (strictIsoDate(shift.date)) {
        unreliableDates.add(shift.date);
        unreliableDates.add(addDays(shift.date, 1));
      } else undatedShiftReview = true;
      if (!allDisabled) add("input", "unknown", { type: "input", shiftId: shift.id }, { metric: "valid_employee_shift", reviewRequired: true },
        "Ein Dienst besitzt keine eindeutige Person oder kein prüfbares Datum/Zeitintervall.");
      continue;
    }
    for (let date = shift.date; date <= shift.endDate; date = addDays(date, 1)) {
      const start = Math.max(shift.start, localDateTimeToEpoch(date, "00:00", timeZone));
      const end = Math.min(shift.end, localDateTimeToEpoch(addDays(date, 1), "00:00", timeZone));
      if (end <= start) continue;
      let net = null;
      if (shift.durationKnown && shift.breakMinutes === 0) net = (end - start) / 60000;
      else if (shift.durationKnown && shift.intervalsKnown) net = (end - start) / 60000 - shift.breaks.reduce((sum, interval) => sum
        + Math.max(0, Math.min(end, interval.end) - Math.max(start, interval.start)) / 60000, 0);
      else if (shift.durationKnown && shift.date === shift.endDate) net = shift.net;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push({ shift, start, end, net });
    }
  }
  const total = date => {
    if (undatedShiftReview || unreliableDates.has(date)) return null;
    const entries = [...(byDate.get(date) || [])].sort((a, b) => a.start - b.start);
    return entries.some((entry, i) => entry.net === null || (i > 0 && entry.start < entries[i - 1].end))
      ? null : entries.reduce((sum, entry) => sum + entry.net, 0);
  };
  // Calendar portions give a reproducible lower bound. They do not decide the
  // legal boundary of a working day across midnight. A proved excess inside a
  // cross-date 24-hour window therefore withdraws a calendar-only pass rather
  // than inventing a rolling statutory failure or an automatic daily reset.
  const crossDateExcess = (date, limit) => {
    const candidates = normalized.filter(shift => shift.valid && shift.durationKnown && shift.employeeId === employeeId);
    for (const shift of candidates) {
      for (const start of [shift.start, shift.end - 86400000]) {
        const end = start + 86400000;
        const entries = candidates.filter(item => item.start < end && item.end > start);
        const involvedDates = new Set(entries.flatMap(item => [item.date, item.endDate]));
        if (involvedDates.size < 2 || !involvedDates.has(date)) continue;
        const lowerBound = entries.reduce((sum, item) => sum + Math.max(0,
          (Math.min(end, item.end) - Math.max(start, item.start)) / 60000 - item.breakMinutes), 0);
        if (lowerBound > limit) return true;
      }
    }
    return false;
  };
  const holidayDates = new Set((Array.isArray(holidays) ? holidays : []).filter(strictIsoDate));
  for (const year of new Set(dates.map(date => Number(date.slice(0, 4))))) for (const date of austrianNationalHolidays(year)) holidayDates.add(date);
  for (const date of dates) {
    const { state, row } = resolved(date);
    if (state !== "confirmed") continue;
    const scope = { type: "day", date };
    const modelKnown = row.normalWorkModel === "standard" && row.agreementStatus === "none_confirmed" && row.agreementApplicable === true;
    const averageKnown = row.normalWorkModel === "durchrechnung26Weeks" && row.agreementStatus === "documented" && row.agreementApplicable === true;
    add("model", modelKnown || averageKnown ? "pass" : "unknown", scope, { metric: "evidenced_work_time_model", standardModel: modelKnown,
      averagingModel: averageKnown }, modelKnown || averageKnown ? "Das ausgewählte Arbeitszeitmodell ist für diesen Tag belegt."
      : "Arbeitszeitmodell und mögliche Betriebs- oder Einzelvereinbarungen sind fachlich zu klären; es wird keine Ausnahme angenommen.");
    const entries = byDate.get(date) || [];
    if (!entries.length && !additionalOn(date) && total(date) !== null) continue;
    const actual = total(date), week = mondayOfWeek(date), weekEnd = addDays(week, 6);
    const weekDates = dateList(week, weekEnd);
    const distributionKnown = covers(week, weekEnd) && wholeConfirmed(week, weekEnd)
      && weekDates.every(day => total(day) !== null && resolved(day).row?.normalWorkModel === "standard"
        && resolved(day).row?.agreementStatus === "none_confirmed" && resolved(day).row?.agreementApplicable === true && !additionalOn(day)
        && !(resolved(day).row?.employeeGroup === "apprentice" && schoolOn(day)));
    const redistributionProved = distributionKnown
      && weekDates.filter(day => dayOfWeek(day) !== 0).some(day => total(day) !== null && total(day) < 480);
    const threshold = redistributionProved ? 540 : 480;
    const schoolCombined = row.employeeGroup === "apprentice" && schoolOn(date);
    const workingDayBoundaryReview = actual !== null && actual <= threshold && crossDateExcess(date, 540);
    const dailyState = actual === null || !modelKnown || schoolCombined || additionalOn(date) || workingDayBoundaryReview
      || (actual > 480 && actual <= 540 && !distributionKnown)
      ? "unknown" : actual > threshold ? "fail" : "pass";
    add("normal.daily", dailyState, scope, { metric: "kv_daily_normal_time_classification", actualMinutes: actual, maximumMinutes: threshold,
      normalTimeClassificationOnly: true, redistributionProved, workingDayBoundaryReview, unquantifiedAdditionalWork: additionalOn(date) }, dailyState === "unknown" ? "Die tägliche KV-Normalzeit ist wegen ungeklärter Verteilung, zusätzlicher Arbeitsereignisse, Arbeitsperioden über Datumsgrenzen, Pausen oder Schul-Kombination fachlich zu prüfen."
      : dailyState === "fail" ? "Der Plan überschreitet die modellierte tägliche Normalzeit; mögliche Überstunden und Schutzgrenzen sind gesondert zu prüfen."
        : "Die bekannte Planzeit liegt innerhalb der modellierten täglichen Normalzeit; weitere Schutzregeln gelten zusätzlich.");
    const workplace = row.workplaceFacts || {};
    const businessKnown = workplace.confirmed === true && ["retail_sales", "retail_other", "wholesale_sales", "wholesale_other"].includes(workplace.kind);
    if (["12-24", "12-31"].includes(date.slice(5))) {
      const retail = workplace.kind?.startsWith("retail_");
      const endTime = date.endsWith("12-24") ? (retail ? "13:00" : dayOfWeek(date) === 6 ? "12:00" : "13:00")
        : retail ? "17:00" : dayOfWeek(date) === 6 ? "12:00" : "13:00";
      const late = entries.some(entry => entry.end > localDateTimeToEpoch(date, endTime, timeZone));
      add("special-date", !businessKnown || workplace.exceptionModel !== "none_confirmed" ? "unknown" : late ? "unknown" : "pass", scope,
        { metric: "kv_special_date_end", normalTimeEnd: endTime, latePlannedWork: late, reviewRequired: late || !businessKnown },
        late || !businessKnown ? "Besondere Beschäftigungs-/Normalzeitgrenzen und belegte notwendige Abschlussarbeiten oder Öffnungszeitenausnahmen sind fachlich zu prüfen."
          : "Der Plan liegt vor dem für das bestätigte Betriebsmodell erfassten besonderen Normalzeitende.");
    }
    if (dayOfWeek(date) === 0 || holidayDates.has(date)) add("rest-day", "unknown", scope,
      { metric: "kv_rest_day_work", reviewRequired: true, nationalHoliday: holidayDates.has(date) },
      "Der Einsatz liegt an einem Ruhetag; gesetzliche Erlaubnis, Tätigkeit und erforderliche individuelle Voraussetzungen sind gesondert zu prüfen.");
    if (schoolCombined) add("school-combination", "unknown", scope, { metric: "kv_instruction_business_combination", reviewRequired: true },
      "Schulzeit, notwendige Wegzeit und Betriebsdienst sind gemeinsam auf die KV-Normalzeit anzurechnen; diese Prüfung erteilt keine pauschale Freigabe.");
  }
  // Inspect both ends of the pair. Changing the following Saturday must also
  // expose an existing preceding afternoon, provided its facts were supplied.
  const saturdayCandidates = [...new Set(dates.flatMap(date => dayOfWeek(date) === 6 ? [addDays(date, -7), date] : []))].sort();
  for (const date of saturdayCandidates) {
    const next = addDays(date, 7), entries = byDate.get(date) || [], previous = resolved(date), following = resolved(next);
    const afternoon = entries.some(entry => entry.end > localDateTimeToEpoch(date, "13:00", timeZone));
    if (!afternoon && !additionalOn(date) && total(date) !== null && previous.state === "confirmed" && covers(date, date)) continue;
    // A missing preceding plan must not turn a worked current Saturday green.
    if (!afternoon && !additionalOn(date) && !(dates.includes(next) && ((byDate.get(next) || []).length || additionalOn(next)))) continue;
    if (previous.state !== "confirmed" && following.state !== "confirmed") continue;
    const row = previous.row || {}, workplace = row.workplaceFacts || {}, nextEntries = byDate.get(next) || [];
    const christmasSaturday = date < `${date.slice(0, 4)}-12-24` && daysBetween(date, `${date.slice(0, 4)}-12-24`) <= 28;
    const defaultProved = previous.state === "confirmed" && workplace.confirmed === true
      && ["retail_sales", "wholesale_sales"].includes(workplace.kind) && workplace.exceptionModel === "none_confirmed"
      && row.normalWorkModel === "standard" && row.agreementStatus === "none_confirmed" && row.agreementApplicable === true && !christmasSaturday;
    const nextWorkplace = following.row?.workplaceFacts || {};
    const futureKnown = afternoon && covers(date, next) && total(date) !== null && total(next) !== null && following.state === "confirmed"
      && following.row?.normalWorkModel === "standard" && following.row?.agreementStatus === "none_confirmed" && following.row?.agreementApplicable === true
      && nextWorkplace.confirmed === true && nextWorkplace.exceptionModel === "none_confirmed"
      && nextWorkplace.kind === workplace.kind;
    const schoolReview = previous.row?.employeeGroup === "apprentice" && schoolOn(next);
    const additionalWorkReview = additionalOn(date) || additionalOn(next);
    const state = !defaultProved || !futureKnown ? "unknown" : nextEntries.length ? "fail" : schoolReview || additionalWorkReview ? "unknown" : "pass";
    add("saturday-free", state, { type: "day", date: dates.includes(next) ? next : date, dates: [date, next] },
      { metric: "kv_entire_following_saturday_free", precedingSaturday: date, followingSaturday: next,
        nextSaturdayShiftCount: nextEntries.length, defaultModelConfirmed: defaultProved, futureCoverageConfirmed: futureKnown,
        christmasExceptionReview: christmasSaturday, schoolReview, additionalWorkReview }, state === "unknown"
        ? "Samstagsmodell, gesetzliche/vertragliche Ausnahmen oder die vollständige benachbarte Planabdeckung sind ungeklärt."
        : state === "fail" ? "Nach dem bestätigten Standard-Samstagsnachmittagsdienst ist am folgenden Samstag ein weiterer Dienst geplant; eine zulässige Ausnahme wurde nicht belegt."
          : "Der folgende Samstag ist im bestätigten Standardmodell nach dem vorhandenen Plan vollständig frei.");
  }
  const weeks = [...new Set(dates.map(mondayOfWeek))];
  for (const week of weeks) {
    const end = addDays(week, 6), weekDates = dateList(week, end), rows = weekDates.map(date => resolved(date));
    if (!rows.some(row => row.state === "confirmed")) continue;
    const complete = covers(week, end) && rows.every(row => row.state === "confirmed");
    const known = complete && weekDates.every(date => total(date) !== null);
    const actual = known ? weekDates.reduce((sum, date) => sum + total(date), 0) : null;
    const school = rows.some((row, i) => row.row?.employeeGroup === "apprentice" && schoolOn(weekDates[i]));
    const additionalWork = weekDates.some(additionalOn);
    const standard = rows.every(row => row.row?.normalWorkModel === "standard" && row.row?.agreementStatus === "none_confirmed" && row.row?.agreementApplicable === true);
    const average = rows.every(row => row.row?.normalWorkModel === "durchrechnung26Weeks" && row.row?.agreementStatus === "documented" && row.row?.agreementApplicable === true);
    const threshold = average ? 2640 : 2310;
    const scope = { type: "week", weekStart: week, weekEnd: end };
    const state = !known || (!standard && !average) || school || additionalWork ? "unknown" : actual > threshold ? "fail" : "pass";
    add("normal.weekly", state, scope, { metric: "kv_weekly_normal_time_classification", actualMinutes: actual, maximumMinutes: threshold,
      completeWeek: complete, normalTimeClassificationOnly: true, unquantifiedAdditionalWork: additionalWork }, state === "unknown" ? "Die KV-Wochennormalzeit ist wegen ungeklärter Geltung, Abdeckung, zusätzlicher Arbeitsereignisse, Modell-/Pausen- oder Schulangaben offen."
      : state === "fail" ? "Der Plan überschreitet die modellierte KV-Wochennormalzeit; Mehr-/Überstunden sind gesondert zu prüfen. Dies ist kein pauschales Beschäftigungsverbot."
        : "Die bekannte Planzeit hält die modellierte KV-Wochennormalzeit ein; die weiteren gesetzlichen und individuellen Auflagen gelten zusätzlich.");
    const contracts = rows.map(row => row.row?.contractWeeklyMinutes);
    const contract = contracts.every(value => Number.isInteger(value) && value > 0 && value <= 2310 && value === contracts[0]) ? contracts[0] : null;
    add("contract.weekly", !known || contract === null || school || additionalWork ? "unknown" : actual > contract ? "fail" : "pass", scope,
      { metric: "kv_contract_weekly_time_classification", actualMinutes: actual, contractMinutes: contract, normalTimeClassificationOnly: true },
      !known || contract === null || school || additionalWork ? "Vereinbarte Wochenstunden, zusätzliche Arbeitsereignisse oder ihre einheitliche datierte Geltung sind noch zu prüfen."
        : actual > contract ? "Der Plan enthält Zeit über den vereinbarten Wochenstunden; zusätzliche Arbeit, Anordnung und Schutzgrenzen sind getrennt zu beurteilen."
          : "Die bekannte Planzeit überschreitet die dokumentierten vereinbarten Wochenstunden nicht.");
    if (school) add("school-combination", "unknown", scope, { metric: "kv_instruction_business_week", reviewRequired: true },
      "Die Wochenanrechnung von Schule, notwendiger Wegzeit und Betriebsdienst auf die KV-Normalzeit bleibt fachlich zu prüfen.");
    const hasWork = weekDates.some(date => byDate.has(date) || additionalOn(date));
    if (hasWork) {
      add("free-time", "unknown", scope, { metric: "kv_free_half_days_and_longer_period", reviewRequired: true },
        "Freie ganze/halbe Werktage, Betriebsöffnung und die maßgebliche mehrwöchige Freizeitperiode benötigen belegte Betriebs- und Planangaben.");
      // These generic facts only attest the standard weekly location timing.
      // A period longer than thirteen weeks needs the separately evidenced
      // advance agreement under A.7.3; no such typed facts exist in this MVP.
      const agreementKnown = standard && complete && scheduleAgreement?.confirmed === true && scheduleAgreement?.weekStart === week
        && scheduleAgreement?.changedAfterAgreement === false && typeof scheduleAgreement?.variable === "boolean";
      const timely = agreementKnown && (scheduleAgreement.variable === false || (strictIsoDate(scheduleAgreement.agreedOn)
        && daysBetween(scheduleAgreement.agreedOn, week) >= 14));
      add("schedule-agreement", timely ? "pass" : "unknown", scope, { metric: "kv_work_time_location_agreement", agreementConfirmed: agreementKnown,
        agreedTimely: timely, reviewRequired: !timely }, timely ? "Die übergebenen datierten Vereinbarungsfakten belegen die vereinbarte Wochenlage."
          : average ? "Die vorausgehende Vereinbarung der Wochenstunden einer Durchrechnungsperiode ist gesondert zu belegen; generische Wochenlage-/14-Tage-Angaben beweisen keine 13-Wochen-Vereinbarung."
            : "Vereinbarte Arbeitszeitlage, rechtzeitiger Zugang und spätere Änderungen sind anhand belastbarer Angaben zu prüfen; Veröffentlichung allein beweist keine Vereinbarung.");
    }
    if (rows.some((row, i) => row.state === "confirmed" && ageAt(employee, weekDates[i]) !== null && ageAt(employee, weekDates[i]) < 18)) {
      const saturday = addDays(week, 5), monday = addDays(week, 7);
      const protectedStart = localDateTimeToEpoch(saturday, "18:00", timeZone), protectedEnd = localDateTimeToEpoch(monday, "07:00", timeZone);
      const ageKnown = rows.every((row, i) => ageAt(employee, weekDates[i]) !== null && ageAt(employee, weekDates[i]) >= 15 && ageAt(employee, weekDates[i]) < 18);
      const sundayFree = !(byDate.get(end) || []).length;
      const otherFree = weekDates.some(date => dayOfWeek(date) !== 0 && !(byDate.get(date) || []).length && !schoolOn(date) && !additionalOn(date));
      const protectedFree = !normalized.some(shift => shift.valid && shift.start < protectedEnd && shift.end > protectedStart);
      const protectedSchoolReview = [saturday, end, monday].some(schoolOn);
      const defaultYouthModel = rows.every(row => row.row?.normalWorkModel === "standard"
        && row.row?.agreementStatus === "none_confirmed" && row.row?.agreementApplicable === true && row.row?.workplaceFacts?.confirmed === true
        && row.row?.workplaceFacts?.exceptionModel === "none_confirmed");
      const protectedAdditionalReview = [saturday, end, monday].some(additionalOn);
      const youthState = !complete || !ageKnown || !covers(week, monday) || !defaultYouthModel
        || [saturday, end, monday].some(day => total(day) === null) || protectedSchoolReview || protectedAdditionalReview
        ? "unknown" : sundayFree && otherFree && protectedFree ? "pass" : "fail";
      add("youth-free-time", youthState, scope, { metric: "kv_additional_youth_weekly_rest", sundayFree, otherWholeCalendarDayFree: otherFree,
        saturday18ToMonday07Free: protectedFree, existingYouthProtectionUnchanged: true }, youthState === "unknown"
        ? "Die zusätzliche KV-Jugendfreizeit ist wegen ungeklärtem Alter, Modell oder Randplan nicht abschließend prüfbar."
        : youthState === "fail" ? "Der Standardplan weist die zusätzliche KV-Jugendfreizeit nicht vollständig nach; die gesonderten KJBG-Regeln gelten weiterhin."
          : "Die zusätzliche Standard-KV-Jugendfreizeit ist im Plan erkennbar; der gesetzliche Jugend- und Schulschutz wird dadurch nicht ersetzt.");
    }
  }
  // Work-period boundaries use the first and last work of a calendar day. A
  // split shift is not mistaken for a new day's statutory daily rest.
  const workedDates = [...byDate.keys()].sort();
  for (let i = 1; i < workedDates.length; i += 1) {
    const previous = workedDates[i - 1], date = workedDates[i];
    if (!dates.includes(date) || resolved(date).state !== "confirmed") continue;
    if (byDate.get(date).every(entry => byDate.get(previous).some(prior => prior.shift === entry.shift))) continue;
    const actual = (Math.min(...byDate.get(date).map(entry => entry.start)) - Math.max(...byDate.get(previous).map(entry => entry.end))) / 60000;
    const row = resolved(date).row, age = ageAt(employee, date);
    const restWindowBounded = daysBetween(previous, date) <= 370;
    const defaultProved = row.normalWorkModel === "standard" && row.agreementStatus === "none_confirmed" && row.agreementApplicable === true && age !== null && age >= 18
      && !(row.employeeGroup === "apprentice" && (schoolOn(previous) || schoolOn(date)))
      && restWindowBounded && !dateList(previous, date).some(day => additionalOn(day) || total(day) === null);
    add("daily-rest", !defaultProved || !covers(previous, date) ? "unknown" : actual >= 660 ? "pass" : "unknown",
      { type: "between_shifts", from: previous, to: date }, { metric: "kv_work_period_rest", actualMinutes: actual, standardRestMinutes: 660,
        compensationReviewRequired: actual < 660, existingYouthProtectionUnchanged: true, restWindowBounded }, actual >= 660 && defaultProved
        ? "Zwischen den erfassten Arbeitsperioden liegen mindestens elf Stunden; weitere Auflagen gelten zusätzlich."
        : "Arbeitsperioden, gegebenenfalls kürzere KV-Ruhe mit vollständigem Ausgleich und der eigene Jugend-/Schutzlayer sind fachlich zu prüfen.");
  }
  const periods = new Map();
  for (const date of dates) {
    const row = resolved(date).row;
    if (row?.normalWorkModel === "durchrechnung26Weeks") {
      const period = row.averagingPeriod;
      periods.set(period && strictIsoDate(period.start) && strictIsoDate(period.end) ? `${period.start}:${period.end}` : "missing", period);
    }
  }
  for (const period of periods.values()) {
    const valid = period?.confirmed === true && strictIsoDate(period.start) && strictIsoDate(period.end)
      && daysBetween(period.start, period.end) === 181 && Number.isSafeInteger(period.carryMinutes);
    const days = valid ? dateList(period.start, period.end) : [];
    const complete = valid && covers(period.start, period.end) && wholeConfirmed(period.start, period.end);
    const known = complete && days.every(date => total(date) !== null && !schoolOn(date) && !additionalOn(date) && resolved(date).row?.normalWorkModel === "durchrechnung26Weeks"
      && resolved(date).row?.agreementApplicable === true && resolved(date).row?.averagingPeriod?.start === period.start
      && resolved(date).row?.averagingPeriod?.end === period.end && resolved(date).row?.averagingPeriod?.confirmed === true
      && resolved(date).row?.averagingPeriod?.carryMinutes === period.carryMinutes
      && Number.isInteger(resolved(date).row?.contractWeeklyMinutes) && resolved(date).row.contractWeeklyMinutes > 0
      && resolved(date).row.contractWeeklyMinutes <= 2310 && Math.abs(period.carryMinutes) <= resolved(date).row.contractWeeklyMinutes / 2);
    const actual = known ? (days.reduce((sum, date) => sum + total(date), 0) + period.carryMinutes) / 26 : null;
    add("averaging", actual === null ? "unknown" : actual > 2310 ? "fail" : "pass",
      { type: "rolling_weeks", start: valid ? period.start : calendarScope.start, end: valid ? period.end : calendarScope.end, windowWeeks: 26 },
      { metric: "kv_agreed_period_normal_time_classification", actualMinutesPerWeek: actual, maximumMinutesPerWeek: 2310,
        completePeriod: complete, normalTimeClassificationOnly: true }, actual === null ? "Vereinbarter Beginn/Ende, Übertrag und vollständige belegte 26-Wochen-Abdeckung fehlen oder sind widersprüchlich."
        : actual > 2310 ? "Die Planzeit liegt über dem modellierten Normalzeitdurchschnitt; Anrechnung und Mehr-/Überstunden sind gesondert zu prüfen."
          : "Die vollständig übergebene Planperiode hält den modellierten Normalzeitdurchschnitt ein; dies ist keine Istzeit- oder Gesamtfreigabe.");
  }
  const counts = { pass: 0, unknown: 0, fail: 0 };
  for (const finding of findings) counts[finding.state] += 1;
  const summary = { state: counts.fail ? "fail" : counts.unknown ? "unknown" : "pass", severity: "warning", counts,
    requiresManualReview: counts.unknown > 0 || findings.some(finding => finding.state === "fail" && finding.baseEnforcement !== "advisory") };
  const core = { engineVersion: RETAIL_KV_ENGINE_VERSION, catalogVersion: RETAIL_KV_CATALOG_VERSION, basis: "planned_schedule", timeZone,
    profile: { id: RETAIL_KV_PROFILE.id, version: RETAIL_KV_PROFILE.version }, enforcementMode: "monitor",
    range: { start: calendarScope.start, end: calendarScope.end, valid: true },
    employeeId, findings, summary };
  return { ...core, fingerprint: fingerprint(core), legalNotice: "Technische KV-Planprüfung im Monitorbetrieb. Gesetzlicher Jugend-/Schulschutz und vertrauliche Auflagen gelten zusätzlich; keine Gesamtfreigabe, Istzeit- oder Entgeltprüfung." };
}

module.exports = { RETAIL_KV_SOURCE_ID, RETAIL_KV_ENGINE_VERSION, RETAIL_KV_CATALOG_VERSION, RETAIL_KV_PROFILE_ID,
  RETAIL_KV_PROFILE, RETAIL_KV_RULES, RETAIL_KV_SOURCES, evaluateRetailKvPlanning };

"use strict";

const TIME_ZONE = "Europe/Vienna";
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

class SicknessWorkflowError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = "SicknessWorkflowError";
    this.code = code;
  }
}

function workflowError(message, code) {
  return new SicknessWorkflowError(message, code);
}

function nonNegativeInteger(value, label, code) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw workflowError(`${label} muss eine nichtnegative ganze Zahl sein.`, code);
  }
  return parsed;
}

/**
 * Normalisiert die zwei AUM-Fristen.
 * @returns {{localDays: number, hrDays: number}}
 * @throws {SicknessWorkflowError} bei negativen/gebrochenen Werten oder wenn localDays >= hrDays.
 */
function validateSicknessDeadlines({ localDays, hrDays } = {}) {
  const normalizedLocalDays = nonNegativeInteger(localDays, "Die lokale AUM-Frist", "SICKNESS_LOCAL_DEADLINE_INVALID");
  const normalizedHrDays = nonNegativeInteger(hrDays, "Die Frist der Personalleitung", "SICKNESS_HR_DEADLINE_INVALID");
  if (normalizedLocalDays >= normalizedHrDays) {
    throw workflowError(
      "Die lokale Warnfrist muss kleiner als die Frist der Personalleitung sein.",
      "SICKNESS_DEADLINE_ORDER_INVALID",
    );
  }
  return { localDays: normalizedLocalDays, hrDays: normalizedHrDays };
}

function validDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseDateKey(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return validDateParts(parts.year, parts.month, parts.day) ? parts : null;
}

function dateKey(parts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function dateOrdinal(parts) {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS);
}

function dateKeyFromOrdinal(ordinal) {
  const value = new Date(ordinal * DAY_MS);
  return dateKey({ year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() });
}

const viennaFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function viennaParts(instant) {
  const values = {};
  for (const part of viennaFormatter.formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function parseInstant(value, label = "Zeitpunkt") {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw workflowError(`${label} ist ungültig.`, "SICKNESS_TIMESTAMP_INVALID");
    return new Date(value.getTime());
  }
  if (typeof value === "number") {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw workflowError(`${label} ist ungültig.`, "SICKNESS_TIMESTAMP_INVALID");
    return date;
  }
  let text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(text)) {
    text = `${text.replace(" ", "T")}Z`;
  } else if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    throw workflowError(`${label} muss eine eindeutige Zeitzone enthalten.`, "SICKNESS_TIMESTAMP_INVALID");
  }
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw workflowError(`${label} ist ungültig.`, "SICKNESS_TIMESTAMP_INVALID");
  return date;
}

function localDateParts(value, label) {
  const direct = typeof value === "string" ? parseDateKey(value.trim()) : null;
  if (direct) return direct;
  return viennaParts(parseInstant(value, label));
}

function calculateSicknessEscalation({ startAt, asOf = new Date(), localDays, hrDays } = {}) {
  const deadlines = validateSicknessDeadlines({ localDays, hrDays });
  const start = localDateParts(startAt, "Der Fristbeginn");
  const current = localDateParts(asOf, "Der Prüfzeitpunkt");
  const startOrdinal = dateOrdinal(start);
  const currentOrdinal = dateOrdinal(current);
  const calendarDaysElapsed = Math.max(0, currentOrdinal - startOrdinal);
  const localOverdueDays = Math.max(0, calendarDaysElapsed - deadlines.localDays);
  const hrOverdueDays = Math.max(0, calendarDaysElapsed - deadlines.hrDays);
  const severity = hrOverdueDays > 0 ? "red" : localOverdueDays > 0 ? "yellow" : "none";

  return {
    timeZone: TIME_ZONE,
    startDate: dateKey(start),
    asOfDate: dateKey(current),
    calendarDaysElapsed,
    localDeadlineDate: dateKeyFromOrdinal(startOrdinal + deadlines.localDays),
    hrDeadlineDate: dateKeyFromOrdinal(startOrdinal + deadlines.hrDays),
    localOverdueDays,
    hrOverdueDays,
    severity,
  };
}

/**
 * Ermittelt die Fristlage ausschließlich aus Wiener Kalendertagen.
 * @returns {{timeZone: string, startDate: string, asOfDate: string, calendarDaysElapsed: number,
 *   localDeadlineDate: string, hrDeadlineDate: string, localOverdueDays: number,
 *   hrOverdueDays: number, severity: "none"|"yellow"|"red"}}
 * @throws {SicknessWorkflowError} bei ungültigen Fristen oder Zeitpunkten.
 */
function sicknessDeadlineState(options) {
  return calculateSicknessEscalation(options);
}

function parseClock(value, { allowEndOfDay = false } = {}) {
  const text = String(value || "").trim();
  if (allowEndOfDay && text === "24:00") return 24 * 60;
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw workflowError("Die Versand- oder Slot-Uhrzeit muss im Format HH:MM angegeben werden.", "SICKNESS_TIME_INVALID");
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatClock(minutes) {
  if (minutes === 24 * 60) return "24:00";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function resolveViennaWallTime(localDate, targetMinutes) {
  const targetHour = Math.floor(targetMinutes / 60);
  const targetMinute = targetMinutes % 60;
  const approximateUtc = Date.UTC(localDate.year, localDate.month - 1, localDate.day, targetHour, targetMinute);
  const searchRadiusMinutes = 16 * 60;
  let firstValidAfterGap = null;

  for (let offset = -searchRadiusMinutes; offset <= searchRadiusMinutes; offset += 1) {
    const instant = new Date(approximateUtc + (offset * MINUTE_MS));
    const parts = viennaParts(instant);
    if (parts.year !== localDate.year || parts.month !== localDate.month || parts.day !== localDate.day) continue;
    const wallMinutes = parts.hour * 60 + parts.minute;
    if (wallMinutes === targetMinutes && parts.second === 0) return instant;
    if (wallMinutes > targetMinutes && firstValidAfterGap === null) firstValidAfterGap = instant;
  }

  if (firstValidAfterGap) return firstValidAfterGap;
  throw workflowError("Die konfigurierte Versandzeit konnte in Europe/Vienna nicht aufgelöst werden.", "SICKNESS_TIME_RESOLUTION_FAILED");
}

function calculateNotificationNotBefore({ reportAt, sendAfter } = {}) {
  const report = parseInstant(reportAt, "Der Meldezeitpunkt");
  const targetMinutes = parseClock(sendAfter);
  const local = viennaParts(report);
  const reportWallMinutes = (local.hour * 60) + local.minute + (local.second / 60) + (report.getUTCMilliseconds() / 60000);

  if (reportWallMinutes >= targetMinutes) {
    return {
      timeZone: TIME_ZONE,
      reportLocalDate: dateKey(local),
      configuredTime: formatClock(targetMinutes),
      delayed: false,
      notBefore: report.toISOString(),
    };
  }

  const scheduled = resolveViennaWallTime(local, targetMinutes);
  return {
    timeZone: TIME_ZONE,
    reportLocalDate: dateKey(local),
    configuredTime: formatClock(targetMinutes),
    delayed: scheduled.getTime() > report.getTime(),
    notBefore: new Date(Math.max(report.getTime(), scheduled.getTime())).toISOString(),
  };
}

/**
 * Legt den frühesten externen Versandzeitpunkt fest. Vor sendAfter wird bis zur
 * Wiener Uhrzeit gewartet, danach ist die Meldung sofort versandbereit.
 * @returns {{timeZone: string, reportLocalDate: string, configuredTime: string,
 *   delayed: boolean, notBefore: string}}
 * @throws {SicknessWorkflowError} bei mehrdeutigen/ungültigen Zeitpunkten oder Uhrzeiten.
 */
function externalAlertNotBefore(options) {
  return calculateNotificationNotBefore(options);
}

function normalizedInterval(input, kind, index) {
  const start = parseClock(input?.start);
  const end = parseClock(input?.end, { allowEndOfDay: true });
  if (start >= end) {
    throw workflowError(`${kind} ${index + 1} hat keinen gültigen Zeitraum.`, kind === "Slot" ? "STAFFING_SLOT_INVALID" : "STAFFING_MINIMUM_INVALID");
  }
  return { start, end };
}

function normalizedCount(value, label, code) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw workflowError(`${label} muss eine nichtnegative ganze Zahl sein.`, code);
  return count;
}

function mergeRiskWindows(windows) {
  const merged = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && previous.end === window.start && previous.staffed === window.staffed && previous.required === window.required) {
      previous.end = window.end;
      previous.minutes += window.minutes;
      continue;
    }
    merged.push({ ...window });
  }
  return merged;
}

function aggregateStaffingRisk({ slots = [], minimums = [], defaultMinimum = 0 } = {}) {
  if (!Array.isArray(slots) || !Array.isArray(minimums)) {
    throw workflowError("Zeit-Slots und Mindestwerte müssen als Listen angegeben werden.", "STAFFING_INPUT_INVALID");
  }
  const fallbackMinimum = normalizedCount(defaultMinimum, "Die Standard-Mindestbesetzung", "STAFFING_MINIMUM_INVALID");
  const normalizedSlots = slots.map((slot, index) => ({
    ...normalizedInterval(slot, "Slot", index),
    staffed: normalizedCount(slot?.staffed, `Die Besetzung in Slot ${index + 1}`, "STAFFING_SLOT_INVALID"),
  })).sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < normalizedSlots.length; index += 1) {
    if (normalizedSlots[index].start < normalizedSlots[index - 1].end) {
      throw workflowError("Aggregierte Zeit-Slots dürfen sich nicht überschneiden.", "STAFFING_SLOT_OVERLAP");
    }
  }
  const normalizedMinimums = minimums.map((minimum, index) => ({
    ...normalizedInterval(minimum, "Mindestwert", index),
    required: normalizedCount(minimum?.required ?? minimum?.minimum, `Der Mindestwert ${index + 1}`, "STAFFING_MINIMUM_INVALID"),
  }));

  const boundaries = new Set();
  for (const interval of [...normalizedSlots, ...normalizedMinimums]) {
    boundaries.add(interval.start);
    boundaries.add(interval.end);
  }
  const sortedBoundaries = [...boundaries].sort((left, right) => left - right);
  const risks = [];
  let peakShortfall = 0;
  let affectedMinutes = 0;
  let staffMinutesShortfall = 0;

  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const start = sortedBoundaries[index];
    const end = sortedBoundaries[index + 1];
    if (start >= end) continue;
    const slot = normalizedSlots.find((item) => item.start <= start && item.end >= end);
    const activeMinimums = normalizedMinimums.filter((item) => item.start < end && item.end > start);
    const required = Math.max(fallbackMinimum, ...activeMinimums.map((item) => item.required));
    if (!slot && required === 0) continue;
    const staffed = slot?.staffed || 0;
    const shortfall = Math.max(0, required - staffed);
    if (!shortfall) continue;
    const minutes = end - start;
    peakShortfall = Math.max(peakShortfall, shortfall);
    affectedMinutes += minutes;
    staffMinutesShortfall += shortfall * minutes;
    risks.push({
      start: formatClock(start),
      end: formatClock(end),
      staffed,
      required,
      shortfall,
      minutes,
    });
  }

  return {
    belowMinimum: risks.length > 0,
    peakShortfall,
    affectedMinutes,
    staffMinutesShortfall,
    riskWindows: mergeRiskWindows(risks),
  };
}

module.exports = {
  SicknessWorkflowError,
  TIME_ZONE,
  aggregateStaffingRisk,
  calculateNotificationNotBefore,
  calculateSicknessEscalation,
  externalAlertNotBefore,
  sicknessDeadlineState,
  validateSicknessDeadlines,
};

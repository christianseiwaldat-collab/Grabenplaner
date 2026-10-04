"use strict";

const { addDays, isIsoDate } = require("./calendar");

const DETAIL_KEYS = new Set([
  "version", "kind", "startTime", "endTime", "lunchMinutes", "travelMinutes",
  "confirmed", "sourceReference", "specialCase",
]);
const SCHOOL_KINDS = new Set(["regular", "block", "seasonal"]);
const SPECIAL_CASES = new Set(["none", "cancelled_lessons", "elective", "school_event", "support_course"]);
const APPRENTICESHIP_STATUSES = new Set(["active", "completed", "not_apprentice", "unknown"]);

function strictIsoDate(value) {
  if (typeof value !== "string" || !isIsoDate(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function timeMinutes(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

function nullableMinutes(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1440) {
    throw new TypeError(`${field} muss eine ganze Minutenzahl zwischen 0 und 1440 oder null sein.`);
  }
  return value;
}

function normalizeVocationalSchoolDetails(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("Berufsschulangaben müssen ein Objekt sein.");
  if (!Object.keys(value).length) return null;
  if (Object.keys(value).some(key => !DETAIL_KEYS.has(key))) throw new TypeError("Unbekanntes Feld in den Berufsschulangaben.");
  if (value.version !== 1) throw new TypeError("Die Berufsschulangaben benötigen version 1.");
  if (!SCHOOL_KINDS.has(value.kind)) throw new TypeError("Ungültige Berufsschulart.");
  const specialCase = value.specialCase === undefined ? "none" : value.specialCase;
  if (!SPECIAL_CASES.has(specialCase)) throw new TypeError("Ungültiger Berufsschul-Spezialfall.");
  if (value.confirmed !== undefined && typeof value.confirmed !== "boolean") throw new TypeError("confirmed muss ein Wahrheitswert sein.");
  if (value.sourceReference !== undefined && typeof value.sourceReference !== "string") throw new TypeError("Die Berufsschulquelle muss Text sein.");
  const sourceReference = (value.sourceReference || "").trim();
  if (sourceReference.length > 1000 || /[\u0000-\u001f]/.test(sourceReference)) throw new TypeError("Ungültige Berufsschulquelle.");
  const startTime = value.startTime === undefined || value.startTime === null || value.startTime === "" ? null : value.startTime;
  const endTime = value.endTime === undefined || value.endTime === null || value.endTime === "" ? null : value.endTime;
  const start = startTime === null ? null : timeMinutes(startTime);
  const end = endTime === null ? null : timeMinutes(endTime);
  if ((startTime !== null && start === null) || (endTime !== null && end === null)) throw new TypeError("Ungültige Berufsschulzeit.");
  if (start !== null && end !== null && end <= start) throw new TypeError("Die Berufsschule muss am selben Tag nach ihrem Beginn enden.");
  const lunchMinutes = nullableMinutes(value.lunchMinutes, "lunchMinutes");
  const travelMinutes = nullableMinutes(value.travelMinutes, "travelMinutes");
  if (start !== null && end !== null && lunchMinutes !== null && lunchMinutes >= end - start) {
    throw new TypeError("Die Mittagspause muss kürzer als der Berufsschultag sein.");
  }
  const confirmed = value.confirmed === true;
  if (confirmed && (start === null || end === null || lunchMinutes === null || !sourceReference)) {
    throw new TypeError("Bestätigte Berufsschulangaben benötigen Beginn, Ende, Mittagspause und Quelle.");
  }
  return { version: 1, kind: value.kind, startTime, endTime, lunchMinutes, travelMinutes, confirmed, sourceReference, specialCase };
}

function apprenticeshipApplicabilityOnDate(employee = {}, date) {
  const status = APPRENTICESHIP_STATUSES.has(employee.apprenticeshipStatus) ? employee.apprenticeshipStatus : "unknown";
  const validFrom = typeof employee.apprenticeshipValidFrom === "string" ? employee.apprenticeshipValidFrom : "";
  const validTo = typeof employee.apprenticeshipValidTo === "string" ? employee.apprenticeshipValidTo : "";
  const sourceReference = typeof employee.apprenticeshipSourceReference === "string" ? employee.apprenticeshipSourceReference.trim() : "";
  const core = { status, validFrom: validFrom || null, validTo: validTo || null, sourceReference };
  if (employee.apprenticeshipConfirmed !== true || status === "unknown") {
    return { ...core, state: "unknown", reason: "apprenticeship_not_confirmed" };
  }
  if (!sourceReference || !strictIsoDate(validFrom)
      || (employee.apprenticeshipValidTo !== null && employee.apprenticeshipValidTo !== undefined && typeof employee.apprenticeshipValidTo !== "string")
      || (validTo && (!strictIsoDate(validTo) || validTo < validFrom)) || (status === "completed" && !validTo)) {
    return { ...core, state: "unknown", reason: "apprenticeship_basis_missing" };
  }
  if (!strictIsoDate(date) || date < validFrom) {
    return { ...core, state: "unknown", reason: "apprenticeship_outside_confirmed_period" };
  }
  // A completed record describes the evidenced apprenticeship from its start
  // through the last apprentice day (inclusive), then its confirmed completion.
  if (status === "completed") {
    return date <= validTo
      ? { ...core, recordedStatus: status, status: "active", state: "pass", reason: "confirmed_historical_apprenticeship" }
      : { ...core, state: "not_applicable", reason: "confirmed_completed_apprenticeship" };
  }
  if (validTo && date > validTo) {
    return { ...core, state: "unknown", reason: "apprenticeship_outside_confirmed_period" };
  }
  return { ...core, state: status === "active" ? "pass" : "not_applicable", reason: status === "active" ? "confirmed_active_apprenticeship" : "confirmed_personal_status" };
}

function normalizeSchoolAttendance(rows = [], employeeId = "", range = {}) {
  if (!Array.isArray(rows)) throw new TypeError("schoolAttendance muss eine Liste sein.");
  const result = [];
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      result.push({ id: `invalid-school-${index + 1}`, date: range.start || null, details: null, error: "invalid_school_record" });
      continue;
    }
    if (row.employeeId && String(row.employeeId) !== String(employeeId)) continue;
    const from = String(row.date || row.dateFrom || "");
    const to = String(row.date || row.dateTo || from);
    let details = null;
    let error = null;
    try { details = normalizeVocationalSchoolDetails(row.details); } catch { error = "invalid_school_details"; }
    const core = { id: String(row.id || `school-${index + 1}`), employeeId: String(row.employeeId || employeeId), dateFrom: from, dateTo: to, allDay: row.allDay === true || row.allDay === 1, details, error };
    if (!strictIsoDate(from) || !strictIsoDate(to) || to < from) {
      result.push({ ...core, date: range.start || null, error: "invalid_school_dates" });
      continue;
    }
    const start = strictIsoDate(range.start) && range.start > from ? range.start : from;
    const end = strictIsoDate(range.end) && range.end < to ? range.end : to;
    let count = 0;
    for (let date = start; date <= end; date = addDays(date, 1)) {
      if (++count > 3660) throw new TypeError("Der Berufsschulzeitraum ist zu groß.");
      const multiDayCourse = from !== to && ["block", "seasonal"].includes(details?.kind);
      const instructionMinutes = details?.confirmed && !error && !multiDayCourse
        ? timeMinutes(details.endTime) - timeMinutes(details.startTime) - details.lunchMinutes
        : null;
      result.push({ ...core, date, instructionMinutes });
    }
  }
  return result;
}

module.exports = {
  apprenticeshipApplicabilityOnDate,
  normalizeSchoolAttendance,
  normalizeVocationalSchoolDetails,
  strictIsoDate,
};

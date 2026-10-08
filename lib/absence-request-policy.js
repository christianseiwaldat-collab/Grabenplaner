"use strict";

const PERSONAL_ABSENCE_REQUEST_FUTURE_DAYS = 365;
const STAFFING_ADVISORY_CODES = new Set([
  "VACATION_STAFFING_INSUFFICIENT",
  "TIME_OFF_STAFFING_INSUFFICIENT",
]);

function isoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Use the server's Vienna calendar day, rather than a browser/UTC boundary.
function personalAbsenceRequestPeriod(dateFrom, dateTo, today, kind = "vacation") {
  const prefix = kind === "time_off" ? "TIME_OFF" : "VACATION";
  const label = kind === "time_off" ? "ZA" : "Urlaub";
  if (!isoDate(dateFrom) || !isoDate(dateTo) || !isoDate(today) || dateTo < dateFrom) {
    return { trafficLight: "red", allowed: false, submissionAllowed: false,
      code: `${prefix}_DATES_INVALID`, reason: `Bitte einen gültigen ${label}-Zeitraum eingeben.` };
  }
  const maximum = new Date(`${today}T12:00:00Z`);
  maximum.setUTCDate(maximum.getUTCDate() + PERSONAL_ABSENCE_REQUEST_FUTURE_DAYS);
  const maximumDate = maximum.toISOString().slice(0, 10);
  if (dateFrom < today || dateTo > maximumDate) {
    return { trafficLight: "red", allowed: false, submissionAllowed: false,
      code: `${prefix}_REQUEST_HORIZON`, minimumDate: today, maximumDate,
      reason: `${label} kann ab heute bis ${maximumDate} (365 Tage im Voraus) beantragt werden.` };
  }
  return null;
}

// A staffing warning permits a pending request, never an approval or direct
// schedule entry. Explicit blackouts, invalid periods and overlaps still block.
function absenceRequestSubmissionAllowed(assessment) {
  return assessment?.allowed === true || (assessment?.trafficLight === "red"
    && STAFFING_ADVISORY_CODES.has(assessment?.code));
}

function absenceRequestSubmissionAssessment(assessment) {
  return { ...assessment, submissionAllowed: absenceRequestSubmissionAllowed(assessment) };
}

module.exports = { PERSONAL_ABSENCE_REQUEST_FUTURE_DAYS, personalAbsenceRequestPeriod,
  absenceRequestSubmissionAllowed, absenceRequestSubmissionAssessment };

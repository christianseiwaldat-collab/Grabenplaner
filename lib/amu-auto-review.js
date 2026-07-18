"use strict";

const AUTO_REVIEW_VERSION = "aum-auto-review-v1";

function validIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function evaluateAutomaticAumReview({
  enabled = false,
  trustLevelAtReport = "",
  identityStatus = "not_detected",
  dateEvidence = null,
  submittedDateFrom = "",
  submittedDateTo = "",
  ocrAssisted = false,
  ocrConfirmed = false,
  scanStatuses = [],
} = {}) {
  const criteria = {
    policyEnabled: enabled === true,
    trustLevelA: String(trustLevelAtReport || "").toUpperCase() === "A",
    identityMatched: identityStatus === "matched",
    datesDetected: dateEvidence?.status === "detected",
    datesPlausible: validIsoDate(submittedDateFrom)
      && validIsoDate(submittedDateTo)
      && submittedDateTo >= submittedDateFrom,
    datesMatch: dateEvidence?.status === "detected"
      && dateEvidence.dateFrom === submittedDateFrom
      && dateEvidence.dateTo === submittedDateTo,
    employeeConfirmed: ocrAssisted === true && ocrConfirmed === true,
    securityPassed: Array.isArray(scanStatuses)
      && scanStatuses.length > 0
      && scanStatuses.every((status) => status === "clean"),
  };
  const order = [
    ["policyEnabled", "policy_disabled"],
    ["trustLevelA", "trust_level_not_a"],
    ["identityMatched", "identity_not_matched"],
    ["datesDetected", "dates_not_detected"],
    ["datesPlausible", "dates_not_plausible"],
    ["datesMatch", "dates_not_matching"],
    ["employeeConfirmed", "employee_confirmation_missing"],
    ["securityPassed", "security_scan_not_clean"],
  ];
  const failed = order.find(([criterion]) => criteria[criterion] !== true);
  return {
    version: AUTO_REVIEW_VERSION,
    completed: !failed,
    reason: failed ? failed[1] : "all_criteria_met",
    criteria,
  };
}

module.exports = {
  AUTO_REVIEW_VERSION,
  evaluateAutomaticAumReview,
};

"use strict";

// Fixed company entitlement confirmed on 2026-09-06. This is not an AZG rule
// or a complete KV calculator. The caller must supply a verified, dated sales
// assignment and actual work intervals with breaks already excluded.
// No persistence, activation or historical recalculation occurs in this module.
const { canonicalSha256 } = require("./receipt");
const POLICY = Object.freeze({
  id: "company-retail-saturday-credit", version: "2026.1",
  title: "Samstagsgutschrift Verkauf", basis: "confirmed_company_rule",
  confirmedOn: "2026-09-06", weekday: 6, fromMinute: 13 * 60,
  toMinute: 24 * 60, percent: 50, settlement: "time_account",
  rounding: "nearest_minute_once_per_employee_day",
  sourceRef: "company-confirmation-2026-09-06",
  kvReference: "wko.kv.handel.angestellte.2026:F1.7.3",
  kvReferenceWindow: "13:00-18:00; additional applicability conditions",
});

function dateValid(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const present = value => typeof value === "string" && Boolean(value.trim()) && value.length <= 160;
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function seal(value) {
  const copy = JSON.parse(JSON.stringify(value));
  return freeze({ ...copy, receiptSha256: canonicalSha256(copy) });
}

function verifySaturdayCreditReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const { receiptSha256, ...body } = receipt;
  return body.format === "gp-company-saturday-credit-v1"
    && body.status === "calculated" && body.calculationReady === true
    && body.automaticPostingAllowed === false
    && /^[a-f0-9]{64}$/.test(String(receiptSha256))
    && canonicalSha256(body) === receiptSha256;
}

function evaluateCompanySaturdayCredit(input = {}) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const { workDate, employeeNumber, assignment, cutoverDate, segments, previousReceipt } = value;
  // A hash is an integrity check, not authorization. These inputs are a service
  // boundary for the future repository integration, never a posting HTTP body.
  if (previousReceipt) {
    if (!verifySaturdayCreditReceipt(previousReceipt)
      || previousReceipt.workDate !== workDate || previousReceipt.employeeNumber !== employeeNumber) {
      throw new TypeError("SATURDAY_CREDIT_RECEIPT_INVALID");
    }
    return freeze(JSON.parse(JSON.stringify(previousReceipt)));
  }
  const issues = [];
  const base = { format: "gp-company-saturday-credit-v1", policy: POLICY,
    employeeNumber: present(employeeNumber) ? employeeNumber : null,
    workDate: dateValid(workDate) ? workDate : null,
    automaticPostingAllowed: false, integrationStatus: "not_activated",
    workedMinutes: null, eligibleMinutes: null, bonusMinutes: null, valuedMinutes: null };
  const blocked = () => freeze({ ...base, status: "review_required", calculationReady: false, issues });
  if (!dateValid(workDate)) issues.push("invalid_work_date");
  if (!present(employeeNumber)) issues.push("missing_employee");
  if (!dateValid(cutoverDate)) issues.push("missing_cutover_date");
  if (issues.length) return blocked();
  if (workDate < cutoverDate) return freeze({ ...base, status: "historical_unchanged",
    calculationReady: false, issues: ["before_cutover_use_existing_valuation"] });
  if (!assignment || assignment.policyId !== POLICY.id || assignment.policyVersion !== POLICY.version
    || !present(assignment.id) || !present(assignment.receiptId)
    || !present(assignment.confirmedBy) || assignment.applicabilityConfirmed !== true
    || assignment.employeeNumber !== employeeNumber || assignment.activity !== "retail_sales"
    || !dateValid(assignment.validFrom)
    || (assignment.validTo != null && !dateValid(assignment.validTo))) {
    issues.push("confirmed_dated_sales_assignment_required");
    return blocked();
  }
  if (assignment.validFrom < cutoverDate || assignment.validFrom > workDate
    || (assignment.validTo && assignment.validTo < workDate)) {
    issues.push("assignment_outside_effective_period");
    return blocked();
  }
  if (value.breaksResolved !== true) issues.push("exact_break_placement_required");
  if (value.dayComplete !== true) issues.push("complete_work_day_required");
  if (value.premiumReviewComplete !== true) issues.push("premium_competition_review_required");
  if (!Array.isArray(segments) || segments.length > 96) issues.push("invalid_work_segments");
  if (issues.length) return blocked();
  const ordered = [...segments].sort((left, right) => (left?.startMinute ?? 0) - (right?.startMinute ?? 0));
  let previousEnd = 0;
  for (const segment of ordered) {
    if (!segment || !Number.isFinite(segment.startMinute) || !Number.isFinite(segment.endMinute)
      || segment.startMinute < 0 || segment.endMinute > 1440 || segment.endMinute <= segment.startMinute
      || segment.startMinute < previousEnd) {
      issues.push("invalid_or_overlapping_work_segments");
      continue;
    }
    previousEnd = segment.endMinute;
    if (!["normal", "additional", "overtime"].includes(segment.workClassification)) issues.push("work_classification_required");
    const competition = segment.competingPremium;
    if (segment.workClassification === "overtime" || value.publicHoliday === true || competition) {
      // A reviewed entitlement can replace the company floor on the same
      // minutes. Cumulative and cash settlements need their own integration.
      if (!competition || !Number.isFinite(competition.percent) || competition.percent < 0
        || competition.percent > 1000 || !present(competition.receiptId)
        || competition.combination !== "highest" || competition.settlement !== "time_account") {
        issues.push("reviewed_competing_time_entitlement_required");
      }
    }
  }
  if (typeof value.publicHoliday !== "boolean") issues.push("holiday_classification_required");
  if (issues.length) return blocked();
  const saturday = new Date(`${workDate}T00:00:00Z`).getUTCDay() === POLICY.weekday;
  let workedMinutes = 0, eligibleMinutes = 0, exactBonusMinutes = 0;
  const components = [];
  for (const segment of ordered) {
    const minutes = segment.endMinute - segment.startMinute;
    const eligible = saturday ? Math.max(0, segment.endMinute - Math.max(segment.startMinute, POLICY.fromMinute)) : 0;
    const competingPercent = segment.competingPremium?.percent || 0;
    const companyCredit = eligible * POLICY.percent / 100;
    const totalCredit = (minutes - eligible) * competingPercent / 100
      + eligible * Math.max(POLICY.percent, competingPercent) / 100;
    workedMinutes += minutes;
    eligibleMinutes += eligible;
    exactBonusMinutes += totalCredit;
    components.push({ startMinute: segment.startMinute, endMinute: segment.endMinute,
      workClassification: segment.workClassification, eligibleMinutes: eligible,
      companyCreditMinutes: companyCredit, combinedCreditMinutes: totalCredit,
      competingPercent, competingReceiptId: segment.competingPremium?.receiptId || null });
  }
  const bonusMinutes = Math.round(exactBonusMinutes);
  return seal({ ...base, status: "calculated", calculationReady: true,
    cutoverDate, assignment: JSON.parse(JSON.stringify(assignment)),
    publicHoliday: value.publicHoliday, workedMinutes, eligibleMinutes, bonusMinutes,
    valuedMinutes: workedMinutes + bonusMinutes, components, issues: [] });
}

module.exports = { SATURDAY_CREDIT_POLICY: POLICY, evaluateCompanySaturdayCredit, verifySaturdayCreditReceipt };

"use strict";

// Preparation only. This contract is deliberately not part of shiftMetrics,
// actualDayMetrics, account postings or payroll export. Recorded cash/time
// balances must not be revalued through a change to a dynamic settings lookup.
const CONTRACT_VERSION = "at-retail-compensation-review-2026.1";
const SOURCE = Object.freeze({
  id: "wko.kv.handel.angestellte.2026",
  title: "Kollektivvertrag für Angestellte und Lehrlinge in Handelsbetrieben 2026",
  url: "https://www.wko.at/oe/kollektivvertrag/kollektivvertrag-handel-angestellte-2026.pdf",
  retrievedOn: "2026-09-06",
  printedPages: [22, 23, 24, 25],
});

// Each numeric value is source metadata, NOT a default entitlement. Conditions
// are intentionally explicit; neither a position nor a day-of-week proves them.
const RULES = Object.freeze([
  { id: "F1.4", kind: "time_credit", percent: 30, conditions: ["extended_retail_hours", "normal_or_additional", "written_linked_rest_day_agreement"] },
  { id: "F1.5", kind: "time_credit", percent: 50, conditions: ["extended_retail_hours", "normal_or_additional", "written_full_day_agreement"] },
  { id: "F1.7.1", kind: "time_credit", percent: 70, weekdays: [1, 2, 3, 4, 5], from: "18:30", to: "20:00", conditions: ["extended_retail_hours", "normal_or_additional", "other_time_credit_settlement"] },
  { id: "F1.7.2", kind: "time_credit", percent: 100, weekdays: [1, 2, 3, 4, 5], from: "20:00", conditions: ["F1.2_covered_hours_including_related_closing_work", "normal_or_additional", "other_time_credit_settlement"] },
  { id: "F1.7.3", kind: "time_credit", percent: 50, weekdays: [6], from: "13:00", to: "18:00", conditions: ["extended_retail_hours", "normal_or_additional", "other_time_credit_settlement"] },
  { id: "F1.8", kind: "cash_alternative", conditions: ["F1.7_entitlement", "cash_settlement_agreement"] },
  { id: "F1.11", kind: "exclusion", conditions: ["saturday_only_contract", "temporary_contract_change_and_calendar_month_review"] },
  { id: "F2.3", kind: "time_credit", percent: 100, from: "21:00", conditions: ["special_sales_event_authorized_under_OeZG_4a", "normal_or_additional", "event_and_related_closing_work", "F2.4_exclusive_event_hire_exclusion_checked"] },
  { id: "G1.2", kind: "classification", weekdays: [7], classification: "overtime", conditions: ["applicable_agreement", "sunday_work_legality_separately_reviewed"] },
  { id: "G2.3", kind: "overtime_premium", percent: 50, conditions: ["classified_overtime", "higher_or_special_premium_not_applicable"] },
  { id: "G2.4", kind: "overtime_premium", percent: 100, conditions: ["classified_overtime", "night_20_to_06_or_sunday_or_public_holiday"] },
  { id: "G2.5", kind: "overtime_premium", percent: 70, conditions: ["classified_overtime", "extended_retail_hours", "weekday_18_30_to_20_or_saturday_13_to_18_and_related_closing_work"] },
  { id: "G2.7", kind: "overtime_premium", percent: 100, conditions: ["classified_overtime", "open_advent_saturday_after_13"] },
  { id: "G4", kind: "time_alternative", conditions: ["overtime_entitlement", "time_settlement_agreement", "premium_preserved_when_base_hours_settled_one_to_one"] },
]);
const EMPLOYEE_GROUPS = Object.freeze(["salaried", "apprentice"]);
const ACTIVITIES = Object.freeze(["retail_sales", "retail_related_work", "trade_fair", "special_sales_event", "inventory", "other"]);
const WORK_CLASSES = Object.freeze(["normal", "additional", "overtime"]);
const SETTLEMENTS = Object.freeze(["time_other", "time_full_day", "time_linked_rest_day", "cash"]);
const REQUIRED_CONTEXT = Object.freeze([
  "workDate", "jurisdiction", "agreementCode", "agreementVersion", "employeeGroup",
  "applicabilityConfirmed", "applicabilityReceiptId", "activity", "workClassification",
  "settlement", "settlementAgreementConfirmed", "settlementReceiptId", "saturdayOnlyEmployment",
]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function receiptPresent(value) { return typeof value === "string" && Boolean(value.trim()) && value.length <= 160; }

function getCompensationRuleContract() {
  return clone({
    version: CONTRACT_VERSION, status: "prepared_not_activated", automaticPostingAllowed: false,
    coverage: "partial_source_register_not_a_payroll_calculator", sources: [SOURCE], rules: RULES,
    requiredContext: REQUIRED_CONTEXT,
    supportedAgreement: { code: "AT-HANDEL-ANGESTELLTE", version: "2026", jurisdiction: "AT", employeeGroups: EMPLOYEE_GROUPS },
    unsupportedAutomaticCases: ["manual_workers_agreement", "unconfirmed_assignment", "trade_fair", "special_sales_event",
      "inventory", "public_holiday_entitlement", "overtime_classification", "premium_combination", "saturday_only_contract_variation"],
    integrationPrerequisites: ["confirmed_dated_employment_and_agreement_assignment", "evidenced_work_and_settlement_classification",
      "immutable_evaluation_receipt_with_source_and_rule_version", "explicit_cutover_and_historical_balance_preservation",
      "payroll_and_time_account_integration_approval"],
    historicalBehavior: {
      legacyCalculationStillActive: true,
      legacySettingsEditable: false,
      historicalEvaluationsAreDynamic: true,
      automaticHistoricalRewriteAllowed: false,
    },
  });
}

function reviewCompensationApplicability(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const missing = [];
  const unsupported = [];
  for (const key of REQUIRED_CONTEXT) {
    const valid = key === "workDate" ? validDate(input[key])
      : key === "saturdayOnlyEmployment" ? typeof input[key] === "boolean"
        : key.endsWith("Confirmed") ? input[key] === true
          : key.endsWith("ReceiptId") ? receiptPresent(input[key])
            : typeof input[key] === "string" && Boolean(input[key].trim());
    if (!valid) missing.push(key);
  }
  if (input.jurisdiction && input.jurisdiction !== "AT") unsupported.push("jurisdiction");
  if (input.agreementCode && input.agreementCode !== "AT-HANDEL-ANGESTELLTE") unsupported.push("agreementCode");
  if (input.agreementVersion && input.agreementVersion !== "2026") unsupported.push("agreementVersion");
  if (validDate(input.workDate) && !input.workDate.startsWith("2026-")) unsupported.push("sourceYearReview");
  if (input.employeeGroup && !EMPLOYEE_GROUPS.includes(input.employeeGroup)) unsupported.push("employeeGroup");
  if (input.activity && !ACTIVITIES.includes(input.activity)) unsupported.push("activity");
  if (input.workClassification && !WORK_CLASSES.includes(input.workClassification)) unsupported.push("workClassification");
  if (input.settlement && !SETTLEMENTS.includes(input.settlement)) unsupported.push("settlement");
  const specialistReviews = ["work_legality_independent_of_compensation", "hours_and_breaks_evidence",
    "normal_additional_overtime_classification", "applicable_exclusions_and_higher_entitlements"];
  if (["trade_fair", "special_sales_event", "inventory", "other"].includes(input.activity)) specialistReviews.push("special_activity_scope");
  if (input.saturdayOnlyEmployment === true) specialistReviews.push("saturday_only_contract_and_temporary_changes");
  if (input.employeeGroup === "apprentice") specialistReviews.push("apprentice_age_and_compensation_basis");
  return {
    version: CONTRACT_VERSION, status: "review_required", reviewRequired: true,
    automaticPostingAllowed: false, activationRequired: true,
    prerequisiteFieldsPresent: missing.length === 0 && unsupported.length === 0,
    missing, unsupported, specialistReviews,
    sourceRefs: [SOURCE.id],
  };
}

module.exports = { CONTRACT_VERSION, getCompensationRuleContract, reviewCompensationApplicability };

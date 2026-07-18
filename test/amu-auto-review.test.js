"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { AUTO_REVIEW_VERSION, evaluateAutomaticAumReview } = require("../lib/amu-auto-review");

function eligible(overrides = {}) {
  return evaluateAutomaticAumReview({
    enabled: true,
    trustLevelAtReport: "A",
    identityStatus: "matched",
    dateEvidence: { status: "detected", dateFrom: "2026-07-10", dateTo: "2026-07-17" },
    submittedDateFrom: "2026-07-10",
    submittedDateTo: "2026-07-17",
    ocrAssisted: true,
    ocrConfirmed: true,
    scanStatuses: ["clean"],
    ...overrides,
  });
}

test("AUM Block 5: schließt nur einen vollständig bestätigten Stufe-A-Treffer automatisch ab", () => {
  const result = eligible();
  assert.equal(result.version, AUTO_REVIEW_VERSION);
  assert.equal(result.completed, true);
  assert.equal(result.reason, "all_criteria_met");
  assert.ok(Object.values(result.criteria).every(Boolean));
});

test("AUM Block 5: jede einzelne Sicherheitsbedingung führt sonst zur manuellen Prüfung", () => {
  const cases = [
    [{ enabled: false }, "policy_disabled"],
    [{ trustLevelAtReport: "B" }, "trust_level_not_a"],
    [{ identityStatus: "not_detected" }, "identity_not_matched"],
    [{ dateEvidence: { status: "not_detected", dateFrom: "", dateTo: "" } }, "dates_not_detected"],
    [{ submittedDateTo: "" }, "dates_not_plausible"],
    [{ submittedDateTo: "2026-07-18" }, "dates_not_matching"],
    [{ ocrAssisted: false, ocrConfirmed: false }, "employee_confirmation_missing"],
    [{ scanStatuses: ["unavailable"] }, "security_scan_not_clean"],
    [{ scanStatuses: [] }, "security_scan_not_clean"],
  ];
  for (const [overrides, reason] of cases) {
    const result = eligible(overrides);
    assert.equal(result.completed, false, reason);
    assert.equal(result.reason, reason);
  }
});

test("AUM Block 5: ein bloßes Client-Signal ohne unabhängigen Datumsabgleich genügt nicht", () => {
  const result = eligible({
    dateEvidence: { status: "not_detected", dateFrom: "", dateTo: "" },
    ocrAssisted: true,
    ocrConfirmed: true,
  });
  assert.equal(result.completed, false);
  assert.equal(result.reason, "dates_not_detected");
});

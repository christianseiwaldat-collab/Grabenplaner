"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { SATURDAY_CREDIT_POLICY, evaluateCompanySaturdayCredit: evaluate, verifySaturdayCreditReceipt: verify } = require("../lib/work-rules/saturday-credit");
function fixture(overrides = {}) {
  return { employeeNumber: "synthetic-901", workDate: "2026-09-12", cutoverDate: "2026-09-07",
    assignment: { id: "synthetic-assignment", receiptId: "synthetic-confirmation", confirmedBy: "synthetic-hr",
      policyId: SATURDAY_CREDIT_POLICY.id, policyVersion: SATURDAY_CREDIT_POLICY.version,
      employeeNumber: "synthetic-901", activity: "retail_sales", applicabilityConfirmed: true,
      validFrom: "2026-09-07", validTo: null },
    breaksResolved: true, dayComplete: true, premiumReviewComplete: true, publicHoliday: false,
    segments: [{ startMinute: 600, endMinute: 720, workClassification: "normal" },
      { startMinute: 750, endMinute: 1020, workClassification: "normal" }], ...overrides };
}
test("bestätigtes Beispiel: 10-17, Pause vor 13 Uhr ergibt 6,5 + 2 = 8,5 Stunden", () => {
  const result = evaluate(fixture());
  assert.equal(result.workedMinutes, 390);
  assert.equal(result.eligibleMinutes, 240);
  assert.equal(result.bonusMinutes, 120);
  assert.equal(result.valuedMinutes, 510);
  assert.equal(result.calculationReady, true);
  assert.equal(result.automaticPostingAllowed, false);
  assert.ok(verify(result));
});
test("Pausen nach und über 13 Uhr werden ausschließlich aus den betroffenen Minuten abgezogen", () => {
  for (const [from, to, credit] of [[810, 840, 105], [765, 795, 112.5]]) {
    const result = evaluate(fixture({ segments: [
      { startMinute: 600, endMinute: from, workClassification: "normal" },
      { startMinute: to, endMinute: 1020, workClassification: "additional" }] }));
    assert.equal(result.workedMinutes, 390);
    assert.equal(result.eligibleMinutes / 2, credit);
    assert.equal(result.bonusMinutes, Math.round(credit));
  }
});
test("geteilte Dienste runden einmal am Tag; vor 13 Uhr und außerhalb Samstag keine Firmenzeitgutschrift", () => {
  const result = evaluate(fixture({ segments: [
    { startMinute: 780, endMinute: 781, workClassification: "normal" },
    { startMinute: 840, endMinute: 841, workClassification: "normal" }] }));
  assert.equal(result.bonusMinutes, 1);
  assert.equal(evaluate(fixture({ workDate: "2026-09-11" })).bonusMinutes, 0);
  assert.equal(evaluate(fixture({ segments: [{ startMinute: 600, endMinute: 780, workClassification: "normal" }] })).bonusMinutes, 0);
});
test("Firmenregel gilt ab 13 Uhr auch nach 18 Uhr und für ausdrücklich zugeordnete Samstagskräfte", () => {
  const input = fixture({ saturdayOnlyEmployment: true,
    segments: [{ startMinute: 1080, endMinute: 1140, workClassification: "normal" }] });
  assert.equal(evaluate(input).bonusMinutes, 30);
  assert.equal(SATURDAY_CREDIT_POLICY.basis, "confirmed_company_rule");
});
test("bestätigter höherer Zuschlag ersetzt 50 Prozent auf denselben Minuten statt Doppeladdition", () => {
  const result = evaluate(fixture({ segments: [{ startMinute: 780, endMinute: 840, workClassification: "overtime",
    competingPremium: { percent: 70, receiptId: "review-70", combination: "highest", settlement: "time_account" } }] }));
  assert.equal(result.bonusMinutes, 42);
  assert.equal(result.valuedMinutes, 102);
});
test("unklare Zuordnung, Pause, Feiertage, Zuschlagskonkurrenz oder offene Buchungsfolge liefern keinen Abrechnungsbetrag", () => {
  const cases = [null, {}, fixture({ assignment: null }), fixture({ breaksResolved: false }),
    fixture({ dayComplete: false }), fixture({ premiumReviewComplete: false }), fixture({ publicHoliday: true }),
    fixture({ publicHoliday: undefined }), fixture({ cutoverDate: null }), fixture({ workDate: "2026-02-30" }),
    fixture({ segments: [{ startMinute: 780, endMinute: 840, workClassification: "overtime" }] }),
    fixture({ segments: [null] }), fixture({ segments: [{ startMinute: 780, endMinute: 900, workClassification: "normal" },
      { startMinute: 800, endMinute: 901, workClassification: "normal" }] })];
  for (const input of cases) {
    const result = evaluate(input);
    assert.equal(result.calculationReady, false);
    assert.equal(result.bonusMinutes, null);
    assert.equal(result.automaticPostingAllowed, false);
  }
  for (const change of [{ activity: "other" }, { employeeNumber: "other" }, { policyVersion: "2025.1" },
    { applicabilityConfirmed: false }, { validFrom: "2026-09-13" }, { validFrom: "2026-01-01" }, { validTo: "2026-09-11" }]) {
    const input = fixture(); Object.assign(input.assignment, change);
    assert.equal(evaluate(input).calculationReady, false);
  }
  for (const change of [{ settlement: "cash" }, { combination: "additive" }, { receiptId: "" }, { percent: -1 }]) {
    const input = fixture({ segments: [{ startMinute: 780, endMinute: 840, workClassification: "overtime",
      competingPremium: { percent: 70, receiptId: "review", combination: "highest", settlement: "time_account", ...change } }] });
    assert.equal(evaluate(input).calculationReady, false);
  }
});
test("vor dem Stichtag keine Neubewertung; bestehender Beleg bleibt bei späteren Eingabeänderungen erhalten", () => {
  assert.equal(evaluate(fixture({ workDate: "2026-09-05" })).status, "historical_unchanged");
  const receipt = evaluate(fixture());
  const result = evaluate(fixture({ previousReceipt: receipt, segments: [] }));
  assert.equal(result.valuedMinutes, 510);
  assert.equal(result.receiptSha256, receipt.receiptSha256);
  assert.deepEqual(result, receipt);
  assert.ok(verify(result));
  assert.throws(() => evaluate(fixture({ previousReceipt: { ...receipt, bonusMinutes: 999 } })), /RECEIPT_INVALID/);
  assert.throws(() => evaluate(fixture({ previousReceipt: receipt, employeeNumber: "another" })), /RECEIPT_INVALID/);
  assert.ok(Object.isFrozen(receipt.components));
});

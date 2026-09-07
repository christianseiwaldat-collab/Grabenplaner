"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { getCompensationRuleContract, reviewCompensationApplicability } = require("../lib/work-rules/compensation");
const complete = () => ({ workDate: "2026-09-05", jurisdiction: "AT", agreementCode: "AT-HANDEL-ANGESTELLTE",
  agreementVersion: "2026", employeeGroup: "salaried", applicabilityConfirmed: true,
  applicabilityReceiptId: "synthetic-review", activity: "retail_sales", workClassification: "normal",
  settlement: "time_other", settlementAgreementConfirmed: true, settlementReceiptId: "synthetic-agreement",
  saturdayOnlyEmployment: false });

test("Kompensationsvertrag ist quellenbelegte Vorbereitung, niemals aktive Berechnung", () => {
  const contract = getCompensationRuleContract();
  assert.equal(contract.status, "prepared_not_activated");
  assert.equal(contract.automaticPostingAllowed, false);
  assert.match(contract.sources[0].url, /^https:\/\/www\.wko\.at\//);
  assert.equal(contract.rules.find(rule => rule.id === "F1.7.3").percent, 50);
  assert.equal(contract.rules.find(rule => rule.id === "G2.5").percent, 70);
  assert.ok(contract.rules.find(rule => rule.id === "F1.11").conditions.includes("saturday_only_contract"));
  assert.ok(contract.rules.every(rule => rule.conditions.length > 0));
  assert.equal(contract.historicalBehavior.automaticHistoricalRewriteAllowed, false);
  assert.equal(contract.historicalBehavior.legacyCalculationStillActive, true);
  assert.equal(contract.historicalBehavior.historicalEvaluationsAreDynamic, true);
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.doesNotMatch(server, /require\(["']\.\/lib\/work-rules\/compensation["']\)/);
  contract.rules[0].percent = 999;
  assert.equal(getCompensationRuleContract().rules[0].percent, 30);
});

test("Auch vollständige Angaben sind keine fachliche Freigabe und keine Buchung", () => {
  const result = reviewCompensationApplicability(complete());
  assert.equal(result.prerequisiteFieldsPresent, true);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.activationRequired, true);
  assert.equal(result.automaticPostingAllowed, false);
  assert.equal(result.status, "review_required");
  for (const field of ["bonusMinutes", "payableAmount", "valuedMinutes", "factor"]) assert.equal(Object.hasOwn(result, field), false);
});

test("Fehlender KV-Kontext, Arbeiter, andere Länder und unbestätigte Ausgleichsformen bleiben offen", () => {
  for (const input of [null, [], {}, { ...complete(), applicabilityConfirmed: false },
    { ...complete(), settlementAgreementConfirmed: "true" }, { ...complete(), workDate: "2026-02-30" },
    { ...complete(), employeeGroup: "manual_worker" }, { ...complete(), jurisdiction: "DE" },
    { ...complete(), agreementVersion: "2027" }, { ...complete(), workDate: "2027-01-01" }]) {
    const result = reviewCompensationApplicability(input);
    assert.equal(result.prerequisiteFieldsPresent, false);
    assert.equal(result.automaticPostingAllowed, false);
    assert.ok(result.missing.length + result.unsupported.length > 0);
  }
});

test("Messe, Samstagskräfte und Lehrlinge verlangen eigenständige Prüfung statt pauschalem Faktor", () => {
  const result = reviewCompensationApplicability({ ...complete(), activity: "trade_fair",
    employeeGroup: "apprentice", saturdayOnlyEmployment: true });
  assert.ok(result.specialistReviews.includes("special_activity_scope"));
  assert.ok(result.specialistReviews.includes("saturday_only_contract_and_temporary_changes"));
  assert.ok(result.specialistReviews.includes("apprentice_age_and_compensation_basis"));
  assert.equal(result.automaticPostingAllowed, false);
});

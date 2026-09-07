"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { planTradeFotoMeasurementBudget, verifyTradeFotoMeasurementStart } = require('../test-support/tradefoto-measurement-budget');
const GiB = 1024 ** 3;
test('local measurement rejects the earlier 47 GiB lower bound before importing', () => {
  const plan = planTradeFotoMeasurementBudget();
  assert.throws(() => verifyTradeFotoMeasurementStart(plan, 47 * GiB), /MEASUREMENT_START_SPACE_REQUIRED/);
  assert.throws(() => verifyTradeFotoMeasurementStart(plan, plan.requiredStartFreeBytes - 1), /MEASUREMENT_START_SPACE_REQUIRED/);
  assert.equal(verifyTradeFotoMeasurementStart(plan, plan.requiredStartFreeBytes).remainingAboveBudgetBytes, 0);
  assert.ok(plan.requiredStartFreeBytes < 100 * GiB);
  assert.equal(plan.productionQualified, false);
});
test('all three full archive copies and a simultaneous restore fit the declared bound without deletion credit', () => {
  const plan = planTradeFotoMeasurementBudget();
  assert.ok(plan.archiveBudgetBytes >= 3 * plan.coupledBudgetBytes);
  assert.ok(plan.requiredStartFreeBytes >= plan.archiveBudgetBytes + plan.coupledBudgetBytes + plan.reserveBytes);
  assert.equal(plan.existingBackupDeletionCreditBytes, 0);
  for (const value of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => planTradeFotoMeasurementBudget({ databaseBudgetBytes: value }), /MEASUREMENT_BUDGET_INVALID/);
  }
});

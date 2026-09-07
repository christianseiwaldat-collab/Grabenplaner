"use strict";
// A bounded local experiment, not a forecast or a production capacity approval.
// Three logical archive points are budgeted as three full copies: no compression,
// deduplication or deletion of existing files is credited to the starting budget.
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
function planTradeFotoMeasurementBudget({ databaseBudgetBytes = 20 * GiB, walBudgetBytes = 2 * GiB } = {}) {
  for (const value of [databaseBudgetBytes, walBudgetBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('MEASUREMENT_BUDGET_INVALID');
  }
  const reserveBytes = 10 * GiB, overheadBytes = 256 * MiB;
  const coupledBudgetBytes = databaseBudgetBytes + 64 * MiB;
  const archiveMetadataBudgetBytes = GiB;
  const archiveBudgetBytes = 3 * coupledBudgetBytes + archiveMetadataBudgetBytes;
  const phases = [
    { phase: 'import', bytes: databaseBudgetBytes + walBudgetBytes },
    { phase: 'initial-compaction', bytes: 2 * databaseBudgetBytes + 64 * MiB },
    { phase: 'baseline-and-unchanged-backup', bytes: 3 * coupledBudgetBytes + archiveMetadataBudgetBytes },
    { phase: 'stress-compaction', bytes: 2 * databaseBudgetBytes + 2 * coupledBudgetBytes + archiveMetadataBudgetBytes + 64 * MiB },
    { phase: 'third-backup', bytes: coupledBudgetBytes + archiveBudgetBytes },
    { phase: 'sequential-restore-after-stage-removal', bytes: coupledBudgetBytes + archiveBudgetBytes },
  ].map(entry => ({ ...entry, bytes: entry.bytes + overheadBytes }));
  const peakWorkspaceBudgetBytes = Math.max(...phases.map(p => p.bytes));
  const requiredStartFreeBytes = peakWorkspaceBudgetBytes + reserveBytes;
  if (!Number.isSafeInteger(requiredStartFreeBytes)) throw new Error('MEASUREMENT_BUDGET_INVALID');
  return Object.freeze({ format: 'grabenplaner.tradefoto.measurement-budget.v1',
    scope: 'isolated-local-test-only', productionQualified: false,
    databaseBudgetBytes, walBudgetBytes, coupledBudgetBytes, archiveBudgetBytes,
    reserveBytes, overheadBytes, peakWorkspaceBudgetBytes, requiredStartFreeBytes,
    compressionCreditBytes: 0, deduplicationCreditBytes: 0, existingBackupDeletionCreditBytes: 0,
    phases: Object.freeze(phases.map(Object.freeze)) });
}
function verifyTradeFotoMeasurementStart(plan, freeBytes) {
  if (!Number.isSafeInteger(freeBytes) || freeBytes < plan.requiredStartFreeBytes) {
    throw new Error('MEASUREMENT_START_SPACE_REQUIRED');
  }
  return { freeBytes, requiredStartFreeBytes: plan.requiredStartFreeBytes,
    remainingAboveBudgetBytes: freeBytes - plan.requiredStartFreeBytes };
}
module.exports = { planTradeFotoMeasurementBudget, verifyTradeFotoMeasurementStart };

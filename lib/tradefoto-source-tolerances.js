"use strict";
const { defineDataImportSourceTolerance } = require('./data-import-source-tolerance');
// Explicit user approval, 05.09.2026. Never a percentage or a future-file waiver.
const common = {
  recordedAt: '2026-09-05T20:13:41.000Z', approvalReference: 'user-approval:2026-09-05:q01-source-count-tolerance',
  reason: 'Confirmed source-count discrepancy accepted for this snapshot. Cause unproven; no rows, bookings or stock corrected.',
  evidenceReference: 'docs/tradefoto-gesamtimport-v0.1/Q01-FEHLERTOLERANZ-2026-09-05.md',
  sourceInstance: 'tradefoto-trade', schemaSha256: '6eb145ac270d384c290e3f8f67d888c31b6bf75f13b04ac312cbcc1255d6ef7e',
  fileSha256: '42a40cb19d867fcc5d6e6f3429065ba0ff77f65a7b9b7fcfaae3d0b61f8154f3',
};
const TRADEFOTO_SOURCE_TOLERANCES = Object.freeze([
  defineDataImportSourceTolerance({ ...common, id: 'q01-20260905-artikel-stamm', sourceSystem: 'tradefoto.master-data', sourceTable: 'ARTIKEL_STAMM',
    profileHash: '833056b61642df18b6deb3db04fc94b388fc83ba0486cb6655b6c9d60082316c', declaredRows: 19187, expectedRows: 19186 }),
  defineDataImportSourceTolerance({ ...common, id: 'q01-20260905-artikel-filialen', sourceSystem: 'tradefoto.history.trade', sourceTable: 'ARTIKEL_FILIALEN',
    profileHash: 'b362ea563e927c4c7366670bbc96bf1f26ce548572c80870ab8f9430872c6b05', declaredRows: 231355, expectedRows: 231351 }),
]);
module.exports = { TRADEFOTO_SOURCE_TOLERANCES };

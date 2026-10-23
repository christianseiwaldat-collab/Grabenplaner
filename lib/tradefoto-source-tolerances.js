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
// Independently verified and explicitly approved on 14.10.2026. Both lower
// and higher logical counts are bound to this exact snapshot and profile.
const verifiedOctober = {
  recordedAt: '2026-10-14T16:42:03.000Z', approvalReference: 'user-approval:2026-10-14:verified-source-counts',
  reason: 'Independent Jackcess logical scans and all 34 index cursors agree with the import reader. Only the declared count differs; no row or business-data error is waived.',
  evidenceReference: 'docs/tradefoto-gesamtimport-v0.1/SOURCE-COUNTS-2026-10-14.md',
  sourceInstance: 'tradefoto-trade', schemaSha256: '6eb145ac270d384c290e3f8f67d888c31b6bf75f13b04ac312cbcc1255d6ef7e',
  fileSha256: '9ea7fd850aa69259488f41fccdf5b70fdb3b85552fa4200483b6d2fa11a698d3',
};
const TRADEFOTO_SOURCE_TOLERANCES = Object.freeze([
  defineDataImportSourceTolerance({ ...common, id: 'q01-20260905-artikel-stamm', sourceSystem: 'tradefoto.master-data', sourceTable: 'ARTIKEL_STAMM',
    profileHash: '833056b61642df18b6deb3db04fc94b388fc83ba0486cb6655b6c9d60082316c', declaredRows: 19187, expectedRows: 19186 }),
  defineDataImportSourceTolerance({ ...common, id: 'q01-20260905-artikel-filialen', sourceSystem: 'tradefoto.history.trade', sourceTable: 'ARTIKEL_FILIALEN',
    profileHash: 'b362ea563e927c4c7366670bbc96bf1f26ce548572c80870ab8f9430872c6b05', declaredRows: 231355, expectedRows: 231351 }),
  defineDataImportSourceTolerance({ ...verifiedOctober, id: 'verified-20261014-artikel-stamm', sourceSystem: 'tradefoto.master-data', sourceTable: 'ARTIKEL_STAMM',
    profileHash: '833056b61642df18b6deb3db04fc94b388fc83ba0486cb6655b6c9d60082316c', declaredRows: 19631, expectedRows: 19630 }),
  defineDataImportSourceTolerance({ ...verifiedOctober, id: 'verified-20261014-artikel-filialen', sourceSystem: 'tradefoto.history.trade', sourceTable: 'ARTIKEL_FILIALEN',
    profileHash: 'b362ea563e927c4c7366670bbc96bf1f26ce548572c80870ab8f9430872c6b05', declaredRows: 237188, expectedRows: 237201 }),
  defineDataImportSourceTolerance({ ...verifiedOctober, id: 'verified-20261014-artikel-zweitean', sourceSystem: 'tradefoto.master-data', sourceTable: 'ARTIKEL_ZWEITEAN',
    profileHash: '5938051c7f0199067e1bd2c6eab4a1d69f1af31bcfbcd63b80dc5c60261326af', declaredRows: 38649, expectedRows: 38650 }),
]);
module.exports = { TRADEFOTO_SOURCE_TOLERANCES };

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createDataImportProtection } = require('../lib/data-import-protection');
const C = require('../lib/data-import-contract'), H = require('../lib/tradefoto-history-profiles');
const { openCashSnapshotPrototype, tableMap } = require('../test-support/cash-history-snapshot-prototype');
function fixture() {
  const parent = fs.realpathSync(path.resolve(__dirname, '../tmp')), directory = fs.mkdtempSync(path.join(parent, 'cash-snapshot-test-'));
  const file = path.join(directory, 'synthetic.db');
  const protection = createDataImportProtection({ encryptionKey: crypto.randomBytes(32), indexKey: crypto.randomBytes(32), keyId: 'test-cash-snapshot', compression: true });
  const manifest = { purpose: 'isolated-storage-experiment', fileSha256: 'a'.repeat(64), asOfDay: '2026-09-04' };
  const store = openCashSnapshotPrototype({ file, protection, manifest });
  return { file, protection, manifest, store, cleanup() {
    try { store.close(); } catch {} protection.destroy();
    assert.equal(path.dirname(fs.realpathSync(directory)), parent); assert.match(path.basename(directory), /^cash-snapshot-test-/);
    fs.rmSync(directory, { recursive: true });
  } };
}
function prepared(name, extra, row = 1) {
  const raw = { ...Object.fromEntries(H.tableFor('cash', name).columns.map(c => [c.name, null])), ...extra };
  return C.normalizeDataImportRow(H.profileFor('cash', name), H.prepareTradeFotoHistoryRow('cash', name, raw, { fileSha256: 'a'.repeat(64), rowNumber: row }));
}
test('single encrypted source copy preserves normalized values and full source ordinals on reopen', () => {
  const f = fixture();
  try {
    const row = prepared('Tagesbericht', { Filialid: 18, Bondatum: new Date('2026-09-04T00:00:00Z') }, 99);
    f.store.transaction(() => f.store.append('Tagesbericht', 99, row, { businessDate: '2026-09-04', dateState: 'within' }));
    const proof = f.store.finish(); assert.equal(f.store.verify(proof).rows, 1);
    assert.throws(() => f.store.transaction(() => {}), /SNAPSHOT_IMMUTABLE/);
    f.store.close(); const reopened = openCashSnapshotPrototype({ ...f, readOnly: true });
    try { assert.equal(reopened.verify(proof).rows, 1); assert.equal(reopened.readForVerification('Tagesbericht', 99).Filialid, '18'); } finally { reopened.close(); }
  } finally { f.cleanup(); }
});
test('foreign key checks reject a selected receipt line without its head', () => {
  const f = fixture();
  try {
    const line = prepared('Umsatz_Kasse_Details', { RepID: '11111111-1111-4111-8111-111111111111' });
    assert.throws(() => f.store.transaction(() => {
      f.store.append('Tagesbericht', 1, prepared('Tagesbericht', {}));
      f.store.append('Umsatz_Kasse_Details', 1, line, { parentRow: 999 });
    }));
    assert.equal(f.store.database.prepare(`SELECT count(*) AS n FROM ${tableMap.get('Umsatz_Kasse_Details').sqlName}`).get().n, 0);
    assert.equal(f.store.verify(f.store.finish()).rows, 0);
  } finally { f.cleanup(); }
});
test('changing indexed dates is rejected by authenticated row context', () => {
  const f = fixture();
  try {
    f.store.transaction(() => f.store.append('Tagesbericht', 1, prepared('Tagesbericht', {})));
    const proof = f.store.finish();
    f.store.database.exec(`UPDATE ${tableMap.get('Tagesbericht').sqlName} SET business_date='2026-09-04'`);
    assert.throws(() => f.store.verify(proof), error => error.code === 'IMPORT_PROTECTED_PAYLOAD_INVALID');
  } finally { f.cleanup(); }
});
test('another snapshot manifest and another encryption key are rejected', () => {
  const f = fixture(); let wrong;
  try {
    f.store.finish(); f.store.close();
    assert.throws(() => openCashSnapshotPrototype({ ...f, manifest: { ...f.manifest, asOfDay: '2026-09-05' }, readOnly: true }));
    wrong = createDataImportProtection({ encryptionKey: crypto.randomBytes(32), indexKey: crypto.randomBytes(32), keyId: 'test-cash-snapshot' });
    assert.throws(() => openCashSnapshotPrototype({ ...f, protection: wrong, readOnly: true }));
  } finally { wrong?.destroy(); f.cleanup(); }
});

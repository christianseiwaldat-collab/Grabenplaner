'use strict';
// Fixed synthetic in-memory SQL experiment. No application database or vault.
const { DatabaseSync } = require('node:sqlite');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const { SQLITE_CASH_PUBLICATIONS_CATALOG: catalog } = require('../lib/persistence/sqlite/cash-publications-catalog');
const { CASH_PUBLICATION_STATEMENTS: S } = require('../lib/persistence/statements/cash-publications');
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE cash_publication_bindings(publication_id TEXT,kind TEXT,source_key BLOB,target_id TEXT,PRIMARY KEY(publication_id,kind,source_key)) WITHOUT ROWID;
CREATE INDEX cash_publication_binding_target ON cash_publication_bindings(publication_id,kind,target_id,source_key);`);
for (const index of [1, 6]) db.exec(`CREATE TABLE cash_snapshot_${index}(dataset_slot INTEGER,source_row INTEGER,business_date TEXT,parent_row INTEGER,location_key BLOB,seller_key BLOB,customer_key BLOB,PRIMARY KEY(dataset_slot,source_row)) WITHOUT ROWID;
CREATE INDEX cash_snapshot_${index}_date ON cash_snapshot_${index}(dataset_slot,business_date,source_row);
CREATE INDEX cash_snapshot_${index}_location_key ON cash_snapshot_${index}(dataset_slot,location_key,business_date,source_row);`);
const keys = Array.from({ length: 20 }, (_, i) => Buffer.alloc(32, i + 1));
const binding = db.prepare("INSERT INTO cash_publication_bindings VALUES('synthetic','FILIALEN',?,?)");
keys.forEach((key, i) => binding.run(key, 'branch-' + i));
const head = db.prepare('INSERT INTO cash_snapshot_1 VALUES(1,?,?,NULL,?,NULL,NULL)'), line = db.prepare('INSERT INTO cash_snapshot_6 VALUES(1,?,?,?,?,NULL,NULL)');
db.exec('BEGIN');
for (let i = 1; i <= 30000; i++) {
  const date = new Date(Date.UTC(2020, 0, 1 + (i % 366))).toISOString().slice(0, 10), location = keys[i % 20];
  head.run(i, date, location);
  for (let n = 0; n < 4; n++) line.run((i - 1) * 4 + n + 1, date, i, location);
}
db.exec('COMMIT; ANALYZE;');
function measure(statement, params) {
  const sql = catalog.find(e => e.statement === statement).sql, prepared = db.prepare(sql), times = []; let rows;
  for (let i = 0; i < 6; i++) { const start = performance.now(); rows = prepared.all(params); if (i) times.push(performance.now() - start); }
  return { rows, medianMs: +times.sort((a, b) => a - b)[2].toFixed(3), plan: db.prepare('EXPLAIN QUERY PLAN ' + sql).all(params).map(r => r.detail) };
}
const results = [];
for (const table of ['Umsatz_KASSE', 'Umsatz_Kasse_Details']) for (const dateFrom of ['2020-01-01', '2020-12-01']) {
  const params = { publicationId: 'synthetic', datasetSlot: 1, dateFrom, dateTo: '2020-12-31', afterDate: '9999-12-31', afterRow: 2000001,
    locationId: 'branch-1', unassigned: 0, sellerId: null, sellerMode: 'none', sellerRole: 'line_seller', customerId: null, limit: 50 };
  const before = measure(S.search[table], params), after = measure(S.searchAssigned[table], params);
  assert.deepEqual(after.rows, before.rows);
  results.push({ table, dateFrom, resultCount: after.rows.length, beforeMedianMs: before.medianMs, afterMedianMs: after.medianMs, equalResults: true, afterPlan: after.plan });
}
console.log(JSON.stringify({ fixture: 'synthetic in-memory SQL only; 30000 receipts, 120000 positions, 20 branches; ANALYZE; no encryption or network costs', node: process.version,
  sqlite: db.prepare('SELECT sqlite_version() AS version').get().version, results }, null, 2));
db.close();

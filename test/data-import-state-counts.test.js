"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { DATA_IMPORT_SCHEMA_SQL, ensureSqliteDataImportSchema } = require('../lib/persistence/sqlite/operations/data-import-schema');
const { SQLITE_DATA_IMPORT_CATALOG } = require('../lib/persistence/sqlite/data-import-catalog');
function fixture(t, legacy = false) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  if (legacy) {
    db.exec(DATA_IMPORT_SCHEMA_SQL); db.exec('DROP TABLE data_import_run_state_counts');
  } else ensureSqliteDataImportSchema(db);
  db.exec(`INSERT INTO data_import_runs(id,scope_id,owner_id,attempt_id,profile_hash,profile,manifest,status,revision,received_count,created_at,updated_at,expires_at)
    VALUES('run','scope','owner','attempt','${'a'.repeat(64)}','{}','{}','staging',1,0,'2026-09-01','2026-09-01','2026-10-01')`);
  const insert = db.prepare(`INSERT INTO data_import_rows(run_id,row_number,identity_hash,content_hash,state,issue,payload) VALUES('run',?,NULL,?,'staged','','synthetic')`);
  return { db, insert: i => insert.run(i, 'b'.repeat(64)) };
}
function verify(db) {
  const direct = db.prepare('SELECT run_id,state,count(*) AS count FROM data_import_rows GROUP BY run_id,state ORDER BY run_id,state').all();
  const fast = db.prepare('SELECT run_id,state,count FROM data_import_run_state_counts ORDER BY run_id,state').all();
  assert.deepEqual(fast, direct);
}
test('counts follow inserts, state transitions, deletes and rollback in the same transaction', t => {
  const { db, insert } = fixture(t); insert(1); insert(2); verify(db);
  db.exec("UPDATE data_import_rows SET state='create' WHERE row_number=1"); verify(db);
  db.exec('BEGIN'); insert(3); db.exec("UPDATE data_import_rows SET state='applied'"); verify(db); db.exec('ROLLBACK'); verify(db);
  db.exec("UPDATE data_import_rows SET payload='other'"); verify(db);
  db.exec('DELETE FROM data_import_rows WHERE row_number=1'); verify(db);
  db.exec('DELETE FROM data_import_rows'); verify(db);
});
test('existing rows are counted once during migration, missing guards stop reuse', t => {
  const { db, insert } = fixture(t, true); insert(1); insert(2);
  ensureSqliteDataImportSchema(db); verify(db); ensureSqliteDataImportSchema(db); verify(db);
  db.exec('DROP TRIGGER data_import_count_update');
  assert.throws(() => ensureSqliteDataImportSchema(db), /DATA_IMPORT_COUNT_SCHEMA_INCOMPLETE/);
});
test('progress query stays bounded by states even for a large source table', t => {
  const { db, insert } = fixture(t);
  db.exec('BEGIN'); for (let i = 1; i <= 100000; i++) insert(i); db.exec('COMMIT'); verify(db);
  const sql = SQLITE_DATA_IMPORT_CATALOG.find(e => e.statement.id.endsWith('.counts')).sql;
  const start = performance.now();
  for (let i = 0; i < 500; i++) db.prepare(sql).all({ runId: 'run' });
  const cachedMs = performance.now() - start;
  const directStart = performance.now();
  for (let i = 0; i < 500; i++) db.prepare('SELECT state,count(*) AS count FROM data_import_rows WHERE run_id=? GROUP BY state').all('run');
  const directMs = performance.now() - directStart;
  t.diagnostic(JSON.stringify({ rows: 100000, reads: 500, cachedMs, directMs }));
  assert.ok(db.prepare('EXPLAIN QUERY PLAN ' + sql).all({ runId: 'run' }).every(row => !row.detail.includes('data_import_rows')));
});

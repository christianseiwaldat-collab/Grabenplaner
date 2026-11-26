'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ensureSqliteDataImportSchema}=require('../lib/persistence/sqlite/operations/data-import-schema');
const {ensureSqliteImportMasterSchema}=require('../lib/persistence/sqlite/operations/import-master-schema');
const {ensureSqliteImportHistorySchema}=require('../lib/persistence/sqlite/operations/import-history-schema');
const {ensureSqliteImportHistorySnapshotsSchema}=require('../lib/persistence/sqlite/operations/import-history-snapshots-schema');
const {S}=require('../lib/persistence/statements/import-history-snapshots');
const TIME='2026-10-15T12:00:00.000Z';
function seed(db){
 db.prepare('INSERT INTO import_history_records VALUES(?,?,?,?,?,?,?,?)').run('record','scope','source','trade','ARTIKEL_FILIALEN','a'.repeat(64),'b'.repeat(64),2);
 for(const revision of [1,2])db.prepare(`INSERT INTO import_history_versions(record_id,revision,file_sha256,snapshot_at,imported_by,imported_at,run_id,master_source_instance,payload)
  VALUES(?,?,?,?,?,?,?,?,?)`).run('record',revision,'c'.repeat(64),TIME,'owner',TIME,'old-run-'+revision,'source','synthetic');
 db.prepare('INSERT INTO import_history_snapshots VALUES(?,?,?,?,?,?,?,?,?,?)').run('new-run','scope','source','a'.repeat(64),'d'.repeat(64),TIME,'owner',1,'building','synthetic');
}
test('Snapshot PostgreSQL catalog qualifies additive tables and keeps the building-only bulk guard',()=>{
 const {CATALOG}=require('../lib/persistence/postgresql/sales/import-history-snapshots-catalog');
 const sqlite=require('../lib/persistence/sqlite/import-history-snapshots-catalog').CATALOG;
 assert.equal(CATALOG.length,sqlite.length);assert.ok(CATALOG.every(e=>e.sql.includes('integration.')));
 const put=CATALOG.find(e=>e.statement===S.membersPut);assert.deepEqual(put.parameterOrder,['rows']);
 assert.match(put.sql,/jsonb_to_recordset\(\$1::jsonb\)/);assert.match(put.sql,/s\.status='building'/);
 assert.match(put.sql,/ON CONFLICT\(run_id,row_number\) DO UPDATE/);
 const app=require('../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG;
 assert.equal(app.filter(e=>e.statement.id.startsWith('import-history-snapshots.')).length,sqlite.length);
 const {qualify,tables,stageTables}=require('../lib/persistence/postgresql/sales/layout');
 for(const name of ['import_history_snapshots','import_history_snapshot_members']){
  assert.equal(tables.has(name),false);assert.equal(stageTables(8).some(t=>t.name===name),false);
  assert.match(qualify('SELECT run_id FROM '+name),new RegExp('integration\\.\\"'+name+'\\"'));
 }
});

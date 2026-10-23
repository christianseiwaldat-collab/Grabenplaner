'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {openSqliteLegacyDatabase}=require('../lib/persistence/sqlite/provider');
const {ensureSqliteDataImportSchema}=require('../lib/persistence/sqlite/operations/data-import-schema');
const {ensureSqliteImportMasterSchema}=require('../lib/persistence/sqlite/operations/import-master-schema');
const {ensureSqliteImportHistorySchema}=require('../lib/persistence/sqlite/operations/import-history-schema');
const {ensureSqliteImportHistorySnapshotsSchema}=require('../lib/persistence/sqlite/operations/import-history-snapshots-schema');
const {S}=require('../lib/persistence/statements/import-history-snapshots');
const TIME='2026-10-15T12:00:00.000Z';
function fixture(work){const db=openSqliteLegacyDatabase(':memory:');try{db.exec('PRAGMA foreign_keys=ON');for(const ensure of [ensureSqliteDataImportSchema,ensureSqliteImportMasterSchema,ensureSqliteImportHistorySchema])ensure(db);return work(db);}finally{db.close();}}
function seed(db){
 db.prepare('INSERT INTO import_history_records VALUES(?,?,?,?,?,?,?,?)').run('record','scope','source','trade','ARTIKEL_FILIALEN','a'.repeat(64),'b'.repeat(64),2);
 for(const revision of [1,2])db.prepare(`INSERT INTO import_history_versions(record_id,revision,file_sha256,snapshot_at,imported_by,imported_at,run_id,master_source_instance,payload)
  VALUES(?,?,?,?,?,?,?,?,?)`).run('record',revision,'c'.repeat(64),TIME,'owner',TIME,'old-run-'+revision,'source','synthetic');
 db.prepare('INSERT INTO import_history_snapshots VALUES(?,?,?,?,?,?,?,?,?,?)').run('new-run','scope','source','a'.repeat(64),'d'.repeat(64),TIME,'owner',1,'building','synthetic');
}
test('Snapshot schema preserves an exact older version independently of disposable import staging',()=>fixture(db=>{
 seed(db);ensureSqliteImportHistorySnapshotsSchema(db);
 db.prepare('INSERT INTO import_history_snapshot_members VALUES(?,?,?,?,?)').run('new-run',1,'record',1,'synthetic');
 assert.equal(db.prepare('SELECT revision FROM import_history_snapshot_members').get().revision,1);
 assert.equal(db.prepare('SELECT revision FROM import_history_records').get().revision,2);
 assert.throws(()=>db.prepare('DELETE FROM import_history_versions WHERE record_id=? AND revision=?').run('record',1),/FOREIGN KEY/);
 assert.throws(()=>db.prepare('DELETE FROM import_history_snapshots WHERE run_id=?').run('new-run'),/FOREIGN KEY/);
 const parents=db.prepare('PRAGMA foreign_key_list(import_history_snapshot_members)').all();
 assert.deepEqual([...new Set(parents.map(r=>r.table))].sort(),['import_history_snapshots','import_history_versions']);
 assert.deepEqual(db.prepare('PRAGMA foreign_key_list(import_history_snapshots)').all(),[]);
 db.exec('DELETE FROM data_import_rows;DELETE FROM data_import_changes;DELETE FROM data_import_runs;');
 assert.equal(db.prepare('SELECT count(*) AS n FROM import_history_snapshot_members').get().n,1);
 assert.equal(db.prepare('PRAGMA foreign_key_check').get(),undefined);
}));
test('Snapshot schema rejects duplicate rows/records, dangling revisions and invalid lifecycle values',()=>fixture(db=>{
 seed(db);const member=db.prepare('INSERT INTO import_history_snapshot_members VALUES(?,?,?,?,?)');
 for(const args of [['new-run',0,'record',1,'x'],['new-run',1,'record',0,'x'],['new-run',1,'record',9,'x'],['missing-run',1,'record',1,'x']])assert.throws(()=>member.run(...args));
 member.run('new-run',1,'record',1,'x');
 assert.throws(()=>member.run('new-run',2,'record',2,'x'),/UNIQUE/);
 assert.throws(()=>member.run('new-run',1,'record',1,'x'),/UNIQUE/);
 assert.throws(()=>db.exec("UPDATE import_history_snapshots SET status='unknown'"),/CHECK/);
 assert.throws(()=>db.exec('UPDATE import_history_snapshots SET expected_rows=-1'),/CHECK/);
 for(const status of ['published','withdrawn'])db.prepare('UPDATE import_history_snapshots SET status=?').run(status);
 const indexes=db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'import_history_snapshot%'").all();
 assert.deepEqual(indexes.map(r=>r.name).sort(),['import_history_snapshot_members_version','import_history_snapshots_source']);
}));
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

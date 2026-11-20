'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../lib/sales-article-report-statements');
const H=require('../lib/tradefoto-history-profiles');
const connectionString=process.env.GP_REPORT_SQL_READER_URL||process.env.GP_SALES_READER_URL||process.env.TEST_POSTGRESQL_URL;
// SELECT-only CTE fixtures exercise the real PostgreSQL engine without creating
// schemas, changing business rows or requiring a migrator account.
test('native report stock selection matches the portable snapshot rule for revisions, scope, legacy and empty publications',
 {skip:!connectionString},async()=>{
 const {Client}=require('pg'),client=new Client({connectionString});
 await client.connect();try{
 await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='8000ms'");
 const native=S.postgresql().find(e=>e.statement===S.stockCandidates);
 const portable=require('../lib/persistence/postgresql/sales/catalog').compileSalesEntry(S.sqlite.find(e=>e.statement===S.stockCandidates),8).providerEntry;
 for(const [i,b] of portable.parameterBindings.entries())if(['articles','locations'].includes(b.parameter))portable.sql=portable.sql.replace(`gp . json_each ( ( $${i+1} :: text ) )`,`jsonb_array_elements_text($${i+1}::jsonb)`);
 const modern='f'.repeat(64),legacy=H.profilesFor('trade','ARTIKEL_FILIALEN').find(p=>!H.usesSnapshotMembership(p)).fingerprint;
 const records=Array.from({length:10},(_,i)=>({id:'r'+(i+1),revision:i===0||i===9?2:1,scope_id:i===2?'foreign':'scope',source_instance:i===3?'foreign':'tradefoto-trade',source:'trade',source_table:'ARTIKEL_FILIALEN',profile_hash:i>=8?legacy:i===4?'wrong':modern}));
 const references=records.flatMap(r=>[1,...(r.revision===2?[2]:[])].flatMap(revision=>[
  {record_id:r.id,revision,role:'article',master_record_id:r.id==='r8'?'b':'a'},
  {record_id:r.id,revision,role:'location.filialid',master_record_id:r.id==='r7'?'19':'18'}]));
 const versions=records.filter(r=>r.id!=='r6').flatMap(r=>[1,...(r.revision===2?[2]:[])].map(revision=>({record_id:r.id,revision,run_id:r.id==='r9'||r.id==='r10'&&revision===1?'legacy':'producer',file_sha256:'source-file'})));
 const snapshots=[{run_id:'snap',scope_id:'scope',source_instance:'tradefoto-trade',status:'published',profile_hash:modern,file_sha256:'snapshot-file'},
  {run_id:'empty',scope_id:'scope',source_instance:'tradefoto-trade',status:'published',profile_hash:modern,file_sha256:'empty-file'}];
 const members=['r1','r3','r4','r5','r6','r7','r8'].map(record_id=>({run_id:'snap',record_id,revision:1}));
 const tables=[['import_history_references','record_id text,revision bigint,role text,master_record_id text'],
  ['import_history_records','id text,revision bigint,scope_id text,source_instance text,source text,source_table text,profile_hash text'],
  ['import_history_versions','record_id text,revision bigint,run_id text,file_sha256 text'],
  ['import_history_snapshots','run_id text,scope_id text,source_instance text,status text,profile_hash text,file_sha256 text'],
  ['import_history_snapshot_members','run_id text,record_id text,revision bigint']];
 const prefix='WITH '+tables.map(([name,columns],i)=>`${name} AS (SELECT * FROM jsonb_to_recordset($${i+7}::jsonb) AS data(${columns}))`).join(', ');
 const defaults={articles:JSON.stringify(['a','b']),locations:JSON.stringify(['18']),scopeId:'scope',snapshot:'snap',after:'',limit:201};
 const execute=async(entry,changes={},extra=[])=>{
  const params={...defaults,...changes},order=entry.parameterBindings?.map(b=>b.parameter)??entry.parameterOrder;
  const sql=entry.sql.replace(/integration\s*\.\s*/g,''),statement=prefix+(/^WITH\b/i.test(sql)?', '+sql.replace(/^WITH\s+/i,''):' '+sql);
  return (await client.query(statement,[...order.map(k=>params[k]),...[references,records,versions,[...snapshots,...extra],members].map(JSON.stringify)])).rows;
 };
 const cases=[
  [{},['r1','r8']], [{articles:JSON.stringify(['a'])},['r1']], [{locations:JSON.stringify(['18','19'])},['r1','r7','r8']],
  [{locations:JSON.stringify(['19'])},['r7']], [{locations:'[]'},[]], [{articles:'[]'},[]],
  [{scopeId:'foreign'},[]], [{snapshot:'missing'},[]], [{snapshot:'empty'},[]],
  [{snapshot:'legacy'},['r9']], [{after:'r1'},['r8']], [{limit:1},['r1']]
 ];
 for(const [changes,ids] of cases){const actual=await execute(native,changes);assert.deepEqual(actual,await execute(portable,changes),JSON.stringify(changes));assert.deepEqual(actual.map(r=>r.id),ids);}
 const blocking=[{run_id:'not-published',scope_id:'scope',source_instance:'tradefoto-trade',status:'draft',profile_hash:modern,file_sha256:'legacy'}];
 assert.deepEqual(await execute(native,{snapshot:'legacy'},blocking),[]);
 assert.deepEqual(await execute(native,{snapshot:'legacy'},blocking),await execute(portable,{snapshot:'legacy'},blocking));
 await client.query('ROLLBACK');
 }finally{await client.end();}
});

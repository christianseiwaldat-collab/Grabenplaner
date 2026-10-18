'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const Model=require('../lib/sales-article-report-model');
const H=require('../lib/tradefoto-history-profiles');
// Call only on an admitted, isolated QA connection. Every fixture relation is
// pg_temp-owned by that connection and copies the installed table/index shape.
async function runArticleReportPostgresqlRegression(client,{entry=require('../lib/sales-article-report-statements').postgresql()[1]}={}){
 const suffix=crypto.randomBytes(8).toString('hex'),names=['import_history_records','import_history_versions','import_history_references','import_history_snapshots','import_history_snapshot_members'];
 const temp=new Map(names.map(name=>[name,'article_qa_'+name.replace('import_history_','')+'_'+suffix]));
 let sql=entry.sql;
 for(const name of names){
  assert.ok((await client.query('SELECT to_regclass($1) AS relation',['integration.'+name])).rows[0].relation,name+' must already exist');
  await client.query('CREATE TEMP TABLE '+temp.get(name)+' (LIKE integration.'+name+' INCLUDING ALL)');
  const pattern=new RegExp('integration\\.(?:"'+name+'"|'+name+')(?![A-Za-z0-9_])','g');
  assert.match(sql,pattern,'candidate must reference '+name);sql=sql.replace(pattern,'pg_temp.'+temp.get(name));
 }
 assert.doesNotMatch(sql,/\bintegration\s*\./,'all candidate relations must be temporary');
 const table=name=>'pg_temp.'+temp.get('import_history_'+name),scope='synthetic-article-qa',legacy=H.profilesFor('trade','ARTIKEL_FILIALEN').find(p=>!H.usesSnapshotMembership(p)).fingerprint,
  published=H.profilesFor('trade','ARTIKEL_FILIALEN').find(p=>H.usesSnapshotMembership(p)).fingerprint;
 const articles=Array.from({length:241},(_,i)=>'article-'+String(i).padStart(4,'0'));
 const payload=i=>JSON.stringify({quantity:i%3===0?'5':i%3===1?'0':'-1'});
 async function record(id,{profile=legacy,revision=1,scopeId=scope}={}){
  await client.query('INSERT INTO '+table('records')+' (id,scope_id,source_instance,source,source_table,profile_hash,identity_hash,revision) VALUES($1,$2,\'tradefoto-trade\',\'trade\',\'ARTIKEL_FILIALEN\',$3,$4,$5)',[id,scopeId,profile,crypto.createHash('sha256').update(id).digest('hex'),revision]);
 }
 async function version(id,{revision=1,run='legacy-run',file='a'.repeat(64),article=articles[0],location='branch-18',value='5'}={}){
  await client.query('INSERT INTO '+table('versions')+' (record_id,revision,file_sha256,snapshot_at,imported_by,imported_at,run_id,master_source_instance,payload) VALUES($1,$2,$3,\'2026-10-18T00:00:00.000Z\',\'synthetic\',\'2026-10-18T00:00:00.000Z\',$4,\'tradefoto-trade\',$5)',[id,revision,file,run,JSON.stringify({quantity:value})]);
  await client.query('INSERT INTO '+table('references')+' (record_id,revision,role,data_class,master_record_id) VALUES($1,$2,\'article\',\'internal_business\',$3),($1,$2,\'location.filialid\',\'internal_business\',$4)',[id,revision,article,location]);
 }
 for(let i=0;i<241;i++){const id='l'+String(i).padStart(5,'0');await record(id);await version(id,{article:articles[i],value:JSON.parse(payload(i)).quantity});}
 await record('legacy-wrong-branch');await version('legacy-wrong-branch',{location:'branch-19'});
 await record('legacy-wrong-scope',{scopeId:'other-scope'});await version('legacy-wrong-scope');
 // The large irrelevant relation is genuine indexed PG data, never decrypted
 // or returned by the selective query. It stresses candidate-first planning.
 await client.query('INSERT INTO '+table('records')+" SELECT 'z'||lpad(i::text,6,'0'),$1,'tradefoto-trade','trade','ARTIKEL_FILIALEN',$2,md5(i::text)||md5('identity:'||i::text),1 FROM generate_series(1,20000) i",[scope,legacy]);
 await client.query('INSERT INTO '+table('versions')+" (record_id,revision,file_sha256,snapshot_at,imported_by,imported_at,run_id,master_source_instance,payload) SELECT id,1,$1,'2026-10-18T00:00:00.000Z','synthetic','2026-10-18T00:00:00.000Z','legacy-run','tradefoto-trade','not-selected' FROM "+table('records')+" WHERE id LIKE 'z%'",['a'.repeat(64)]);
 await client.query('INSERT INTO '+table('references')+" (record_id,revision,role,data_class,master_record_id) SELECT id,1,role,'internal_business',CASE WHEN role='article' THEN 'irrelevant-article' ELSE 'branch-18' END FROM "+table('records')+" CROSS JOIN (VALUES ('article'),('location.filialid')) roles(role) WHERE id LIKE 'z%'");
 for(const [run,status,file] of [['published-run','published','b'],['withdrawn-run','withdrawn','c'],['building-run','building','d']])
  await client.query('INSERT INTO '+table('snapshots')+' (run_id,scope_id,source_instance,profile_hash,file_sha256,snapshot_at,owner_id,expected_rows,status,payload) VALUES($1,$2,\'tradefoto-trade\',$3,$4,\'2026-10-18T00:00:00.000Z\',\'synthetic\',7,$5,\'synthetic\')',[run,scope,published,file.repeat(64),status]);
 for(const id of ['p-current','p-reused','p-omitted','p-withdrawn','p-building','p-wrong-profile','p-missing-version','p-wrong-branch']){
  await record(id,{profile:id==='p-wrong-profile'?legacy:published,revision:id==='p-reused'?2:1});
  if(id!=='p-missing-version')await version(id,{run:id==='p-reused'?'older-run':'published-run',file:'b'.repeat(64),location:id==='p-wrong-branch'?'branch-19':'branch-18'});
 }
 await version('p-reused',{revision:2,run:'newer-run',file:'e'.repeat(64),article:'irrelevant-article',location:'branch-19',value:'99'});
 let position=0;for(const id of ['p-current','p-reused','p-wrong-profile','p-missing-version','p-wrong-branch'])await client.query('INSERT INTO '+table('snapshot_members')+' (run_id,row_number,record_id,revision,payload) VALUES($1,$2,$3,1,\'synthetic\')',['published-run',++position,id]);
 for(const [run,id] of [['withdrawn-run','p-withdrawn'],['building-run','p-building']])await client.query('INSERT INTO '+table('snapshot_members')+' (run_id,row_number,record_id,revision,payload) VALUES($1,1,$2,1,\'synthetic\')',[run,id]);
 await record('legacy-file-blocked');await version('legacy-file-blocked',{run:'published-run',file:'b'.repeat(64)});
 for(const name of names)await client.query('ANALYZE pg_temp.'+temp.get(name));
 const result={synthetic:true,productionAccess:false,persistentSchemaWrites:false,persistentBusinessWrites:false,selectedCandidates:241,irrelevantRecords:20000,measurements:[],checks:[]};
 const parameters=({snapshot='legacy-run',after='',limit=201,selected=articles,locations=['branch-18']}={})=>{
  const input={articles:JSON.stringify(selected),locations:JSON.stringify(locations),scopeId:scope,snapshot,after,limit};
  return entry.parameterBindings.map(binding=>{assert.ok(Object.hasOwn(input,binding.parameter),binding.parameter);return input[binding.parameter];});
 };
 async function query(input={}){const start=performance.now(),rows=(await client.query(sql,parameters(input))).rows.map(r=>({id:r.id,revision:Number(r.revision)}));result.measurements.push({snapshot:input.snapshot||'legacy-run',after:input.after||'',rows:rows.length,milliseconds:performance.now()-start});return rows;}
 const first=await query({limit:200}),second=await query({after:first.at(-1).id,limit:200}),all=[...first,...second];
 assert.equal(first.length,200);assert.equal(second.length,41);assert.deepEqual(all,Array.from({length:241},(_,i)=>({id:'l'+String(i).padStart(5,'0'),revision:1})));result.checks.push('legacy-keyset-241-exact-no-duplicates');
 assert.deepEqual(await query({snapshot:'a'.repeat(64),limit:300}),all);result.checks.push('legacy-file-and-run-match');
 const quantities=all.map(({id},i)=>({id,articleNumber:String(i),description:'Synthetic',locationId:'18',quantity:JSON.parse(payload(i)).quantity,ordered:'0'}));
 assert.equal(Model.resultFor(quantities,Model.normalizeFilters({stock:'positive',limit:200}),null,{}).total,81);
 assert.equal(Model.resultFor(quantities,Model.normalizeFilters({stock:'all',limit:200}),null,{}).total,241);result.checks.push('positive-zero-negative-filtering');
 assert.deepEqual(await query({snapshot:'published-run'}),[{id:'p-current',revision:1},{id:'p-reused',revision:1}]);result.checks.push('published-exact-membership-and-reused-v1-over-head-v2');
 for(const snapshot of ['withdrawn-run','building-run','b'.repeat(64),'c'.repeat(64),'missing-run'])assert.deepEqual(await query({snapshot}),[]);result.checks.push('omitted-withdrawn-building-wrong-profile-missing-version-excluded');
 assert.deepEqual(await query({selected:['no-article']}),[]);assert.deepEqual(await query({locations:['no-branch']}),[]);result.checks.push('unselected-article-and-branch-isolation');
 const plan=(await client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,parameters({snapshot:'published-run'}))).rows[0]['QUERY PLAN'][0];
 result.plan=plan;result.querySha256=crypto.createHash('sha256').update(entry.sql).digest('hex');result.temporaryQuerySha256=crypto.createHash('sha256').update(sql).digest('hex');
 result.temporaryTables=[...temp.values()];return result;
}
module.exports={runArticleReportPostgresqlRegression};

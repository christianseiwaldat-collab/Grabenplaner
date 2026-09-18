'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
test('qualified PostgreSQL files retain LF bytes in Windows checkouts',()=>{
 const {spawnSync}=require('node:child_process');
 const manifest=require('../lib/persistence/postgresql/contracts/manifest.json');
 const files=['lib/persistence/postgresql/core/compatibility.sql',
  ...manifest.files.flatMap(file=>['lib/persistence/postgresql/contracts/'+file.name,file.source])];
 const checked=spawnSync('git',['check-attr','-z','text','eol','--',...files],{cwd:ROOT,encoding:'utf8'});
 assert.equal(checked.status,0,checked.stderr);
 const fields=checked.stdout.split('\0');assert.equal(fields.pop(),'');
 assert.equal(fields.length,files.length*6);
 for(let index=0;index<fields.length;index+=3){
  const [file,attribute,value]=fields.slice(index,index+3);
  assert.equal(value,attribute==='text'?'set':'lf',`${file}: ${attribute}`);
 }
});
test('installed PostgreSQL contracts retain the qualified source bytes without docs/test-support dependencies',()=>{
 const folder=path.join(ROOT,'lib/persistence/postgresql/contracts'),manifest=require('../lib/persistence/postgresql/contracts/manifest.json');
 assert.equal(manifest.version,1);assert.equal(manifest.files.length,9);
 for(const file of manifest.files){
  assert.match(file.name,/^[a-z0-9-]+\.json$/);
  const packaged=fs.readFileSync(path.join(folder,file.name)),source=fs.readFileSync(path.join(ROOT,file.source));
  assert.equal(crypto.createHash('sha256').update(packaged).digest('hex'),file.sha256,file.name);
  assert.deepEqual(packaged,source,file.name);
 }
 for(const file of ['core/schema.js','core/catalog.js','sales/layout.js','sales/catalog.js','boundary/catalog.js','reporting/catalog.js','application-operations/startup.js']){
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT,'lib/persistence/postgresql',file),'utf8'),/require\([^\n]*(?:test-support|docs)\//,file);
 }
});
test('default and ordinary test environments cannot activate the paired runtime',()=>{
 const {resolvePersistenceConfiguration}=require('../lib/persistence/configuration');
 for(const rehearsal of [undefined,'application-11','paired-restore','anything'])for(const NODE_ENV of ['production','test']){
  assert.throws(()=>resolvePersistenceConfiguration({environment:{DB_PROVIDER:'postgresql',NODE_ENV,GRABENPLANER_POSTGRESQL_REHEARSAL:rehearsal}}));
 }
});
const intent=()=>({id:crypto.randomUUID(),actorKind:'employee',actorId:'synthetic',actionType:'sales.article-catalog.import',entityType:'sales_article_import_snapshot',entityId:'a'.repeat(64),scope:'Synthetischer Import',summary:'Importiert',compensatorKey:'sales.article-catalog.import.restore.v1',undoPayload:{snapshotId:'a'.repeat(64)},resultRevision:null,resultFingerprint:'b'.repeat(64),sourceAuditId:12,undoExpiresAt:'2026-09-13T12:00:00.000Z',compensatesActionId:null,createdAt:'2026-09-13T11:00:00.000Z'});
test('Sales receipt delivery retains compensation and audit bindings and rejects altered actor/envelope',()=>{
 const {receiptIntent,readReceiptIntent}=require('../lib/persistence/postgresql/boundary/personal-actions');
 const original=intent(),event={actor:original.actorId,entity_id:original.id,entity_type:'personal_action_receipt',detail:JSON.stringify(original)};
 assert.deepEqual(receiptIntent(original),original);assert.deepEqual(readReceiptIntent(event),original);
 assert.throws(()=>readReceiptIntent({...event,actor:'someone-else'}),/BINDING/);
 assert.throws(()=>readReceiptIntent({...event,entity_id:crypto.randomUUID()}),/BINDING/);
 assert.throws(()=>receiptIntent({...original,actorKind:'organization'}),/SHAPE/);
 assert.throws(()=>receiptIntent({...original,extra:'unmodeled'}));
 assert.throws(()=>receiptIntent({...original,undoPayload:{snapshotId:'changed'}}));
});
test('historical work-rule verification is bounded and a late corrupt receipt fails the full scan',async()=>{
 const {createPostgresqlStartupOperations}=require('../lib/persistence/postgresql/application-operations/startup');
 const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
 const rows=Array.from({length:23},(_,i)=>{
  const result={passed:true,synthetic:i},r={id:String(i+1).padStart(4,'0'),target_type:'synthetic',scope_type:'location',scope_key:'test',period_from:'2026-01-01',period_to:'2026-01-07',profile_version_ids_json:'[]',input_sha256:'a'.repeat(64),result_json:JSON.stringify(result),result_sha256:digest(result),outcome:'pass',created_by:'test',created_at:'2026-01-08T00:00:00.000Z'};
  r.receipt_sha256=digest({schemaVersion:1,id:r.id,targetType:r.target_type,scopeType:r.scope_type,scopeKey:r.scope_key,periodFrom:r.period_from,periodTo:r.period_to,profileVersionIds:[],inputSha256:r.input_sha256,resultSha256:r.result_sha256,outcome:r.outcome,result,createdBy:r.created_by,createdAt:r.created_at});return r;
 });let batches=[];
 const operations=createPostgresqlStartupOperations({prepare(sql){return {get:async()=>undefined,all:async after=>{assert.match(sql,/LIMIT 10$/);const batch=rows.filter(r=>r.id>after).slice(0,10);batches.push(batch.length);return batch;}};}},{workRuleSha256:digest});
 assert.equal(await operations.ensureWorkRuleEvaluationReceiptIntegrity(),0);assert.deepEqual(batches,[]);
 assert.equal(await operations.ensureWorkRuleEvaluationReceiptIntegrity({deep:true}),23);assert.deepEqual(batches,[10,10,3,0]);
 rows[22].receipt_sha256='0'.repeat(64);await assert.rejects(operations.ensureWorkRuleEvaluationReceiptIntegrity({deep:true}),/RECEIPT_INVALID/);
});

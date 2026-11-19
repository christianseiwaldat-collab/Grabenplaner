'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=path.resolve(__dirname,'../lib/persistence/postgresql/sales/import-delete.js');
function harness({existingReference=false,drift=false}={}){
 const queries=[],writes=[];let subject;
 const stages=[5,6,7,8],plan=stage=>({digest:'plan-'+stage,sourceSchemaSha256:'source-'+stage});
 const client={async query(sql){
  queries.push(sql);
  assert.doesNotMatch(sql,/^(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/,'Core admission may not execute DDL or DML');
  if(sql.startsWith('SELECT stage,'))return {rows:stages.map(stage=>({stage,source_sha256:plan(stage).sourceSchemaSha256,plan_sha256:plan(stage).digest,target_sha256:'baseline'}))};
  if(sql.startsWith('SELECT to_regclass'))return {rows:[{name:'gp.import_delete_migration_history'}]};
  if(sql==='SELECT * FROM gp.import_delete_migration_history')return {rows:[{version:1,plan_sha256:subject.digest,base_target_sha256:'baseline',target_sha256:'deleted'}]};
  return {rows:[]};
 }};
 const extension=(target,name)=>({digest:name,async target(){return target;},async migrateWithinTransaction(){writes.push(name);throw Error('An earlier schema extension must already exist');}});
 const reference={digest:'reference',async target(){return existingReference?'reference':'publication';},async migrateWithinTransaction(){writes.push('reference');return {applied:true,target:'reference'};}};
 const modules={
  '../core/fingerprint':{async schemaFingerprint(){return drift?'unexpected':existingReference?'reference':'publication';}},
  './layout':{SCHEMAS:['gp','integration','trade'],SEARCH_PATH:'pg_catalog,gp'},
  '../core/environment':{async verifyEnvironment(c,options){assert.equal(c,client);assert.equal(options.purpose,'migrator');}},
  './schema':{createSalesSchemaPlan:plan},
  './import-delete-performance':extension('performance','performance'),
  './import-history-snapshots':extension('snapshots','snapshots'),
  './import-history-attestations':extension('attestations','attestations'),
  './import-history-publication-performance':extension('publication','publication'),
  './import-history-publication-reference-proof':reference,
 };
 const m={exports:{}};
 vm.runInNewContext('(function(require,module,exports){'+fs.readFileSync(file,'utf8')+'\n})',{})
  (name=>Object.hasOwn(modules,name)?modules[name]:require(name),m,m.exports);
 subject=m.exports;
 return {run:options=>subject.migrate(client,{binding:{},...options}),queries,writes};
}
for(const existingReference of [false,true])test('Core code update preserves the accepted Sales schema with reference extension '+(existingReference?'present':'absent'),async()=>{
 const h=harness({existingReference}),result=await h.run({deferReferenceProof:true});
 assert.equal(result.applied,false);assert.equal(result.referenceProofDeferred,true);
 assert.equal(result.target,existingReference?'reference':'publication');assert.deepEqual(h.writes,[]);
 assert.ok(h.queries.includes('COMMIT'));assert.match(h.queries.at(-1),/pg_advisory_unlock/);
});
test('the complete migration path still applies the independently supported SQL performance extension',async()=>{
 const h=harness(),result=await h.run();assert.equal(result.applied,true);assert.equal(result.referenceProofDeferred,undefined);
 assert.deepEqual(h.writes,['reference']);
});
test('Core migration rejects unexplained schema drift before invoking any writer',async()=>{
 const h=harness({drift:true});await assert.rejects(h.run({deferReferenceProof:true}),/schema drift/);
 assert.deepEqual(h.writes,[]);assert.ok(h.queries.includes('ROLLBACK'));
});

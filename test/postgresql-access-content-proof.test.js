'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createIntegrationSecretVault}=require('../lib/integration-secret-vault');
const {createDataImportProtection}=require('../lib/data-import-protection');
const {contentProof}=require('../test-support/access-recovery-content-proof.cjs');
const TIME='2026-11-16T12:00:00.000Z';
function fixture(tag,{changed=false,identityChanged=false,missing=false,tampered=false,publicationMissing=false,publicationBroken=false}={}){
 const bytes=Buffer.alloc(64,7),vault=createIntegrationSecretVault({activeKeyId:'test',keys:{test:Buffer.alloc(32,9)}});
 const protection=createDataImportProtection({encryptionKey:bytes.subarray(0,32),indexKey:bytes.subarray(32),keyId:'data-import-v1',compression:true});
 const key=vault.seal(bytes,{namespace:'data-import',connectorId:'data-import-v1',field:'data-and-index-keys',purpose:'source-archive-and-recovery'});bytes.fill(0);
 const core={async query(){return {rows:[{payload:key}]};}},masters=[],segments=[];
 for(let i=0;i<(missing?1:2);i++){
  const id=tag+(tag==='old'?i:2-i),r={id,scope_id:'scope',source_instance:'tradefoto-trade',source_table:'ARTIKEL_STAMM',profile_hash:'a'.repeat(64),identity_hash:(identityChanged&&i===0?'different-':'identity-')+i,revision:String(tag==='old'?1:4)};
  const s={record_id:id,kind:'source',data_class:'article'},value={description:'source article '+i,amount:changed&&i===0?'22.00':'12.34'};
  s.payload=protection.seal(value,['master-segment',r.scope_id,r.source_instance,r.source_table,r.identity_hash,id,r.profile_hash,Number(r.revision),s.kind,s.data_class]);
  masters.push(r);segments.push(s);
 }
 const history={id:tag+'-history',scope_id:'scope',source_instance:'tradefoto-weum',source:'weum',source_table:'WE',profile_hash:'b'.repeat(64),identity_hash:'history-identity',revision:tag==='old'?'1':'3'};
 const version={record_id:history.id,revision:history.revision,file_sha256:'c'.repeat(64),snapshot_at:TIME,imported_by:'00001',imported_at:TIME,run_id:tag+'-run',master_source_instance:'tradefoto-trade',business_date:'2026-11-16',parent_id:null,parent_revision:null};
 const context=['history-version',history.scope_id,history.source_instance,history.source,history.source_table,history.id,history.identity_hash,history.profile_hash,Number(version.revision),version.file_sha256,version.snapshot_at,version.imported_by,version.imported_at,version.run_id,version.master_source_instance,version.business_date,null,null];
 const data={quantity:'2.5',memo:'synthetic history'};
 version.payload=protection.seal({dataHash:protection.digest(data)},context);
 const hsegment={record_id:history.id,revision:history.revision,data_class:'facts',payload:protection.seal(data,[...context,'segment','facts'])};
 if(tampered)hsegment.payload=hsegment.payload.slice(0,-2)+'xx';
 const sales={async query(sql,args){
  if(sql.startsWith('SELECT * FROM trade.import_master_records'))return {rows:masters.filter(r=>r.id>args[0]).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,args[1])};
  if(sql.startsWith('SELECT * FROM trade.import_master_segments'))return {rows:segments.filter(r=>args[0].includes(r.record_id))};
  if(sql.startsWith('SELECT * FROM integration.import_history_records'))return {rows:history.id>args[0]?[history]:[]};
  if(sql.startsWith('SELECT v.*'))return {rows:[version]};
  if(sql.startsWith('SELECT s.*'))return {rows:[hsegment]};
  if(sql.includes('FROM integration.import_history_snapshots'))return {rows:publicationMissing?[]:[{scope_id:'scope',source_instance:'tradefoto-trade',profile_hash:'d'.repeat(64),file_sha256:'e'.repeat(64),snapshot_at:TIME,expected_rows:'1',member_rows:'1',coverage_verified:!publicationBroken}]};
  throw Error('Unexpected content proof query');
 }};
 return {core,sales,vault,close:()=>protection.destroy()};
}
async function proof(tag,options){const f=fixture(tag,options);try{return await contentProof(f);}finally{f.close();}}
test('source business fingerprint survives regenerated IDs, revisions, run IDs, row order and encryption nonces',async()=>{
 assert.deepEqual(await proof('new'),await proof('old'));
});
test('business changes, source identity changes and omitted records change the semantic proof',async()=>{
 const original=await proof('old');
 for(const options of [{changed:true},{identityChanged:true},{missing:true}])assert.notDeepEqual(await proof('new',options),original);
});
test('a broken protected history segment cannot produce a successful comparison',async()=>{
 await assert.rejects(proof('new',{tampered:true}));
});
test('published stock membership must remain present and authenticated after replay',async()=>{
 assert.notDeepEqual(await proof('new',{publicationMissing:true}),await proof('old'));
 await assert.rejects(proof('new',{publicationBroken:true}),/PG_RECOVERY_CONTENT_PUBLICATION/);
});

'use strict';
// Read-only semantic comparison for isolated recovery qualification. Technical
// row UUIDs and regenerated encryption nonces are deliberately outside the
// fingerprint; source identity and authenticated business values are included.
const crypto=require('node:crypto');
const C=require('../lib/data-import-contract');
const {withProtection}=require('../lib/persistence/postgresql/operations/owned-recovery');
const MOD=1n<<256n,BATCH=200;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const number=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)fail('PG_RECOVERY_CONTENT_INTEGER');return n;};
function accumulator(){
 let count=0,sum=0n,xor=0n;
 return {add(value){const h=BigInt('0x'+crypto.createHash('sha256').update(C.canonical(value)).digest('hex'));count++;sum=(sum+h)%MOD;xor^=h;},
  result(){return {rows:count,sumSha256:sum.toString(16).padStart(64,'0'),xorSha256:xor.toString(16).padStart(64,'0')};}};
}
function merge(target,value){for(const [key,item] of Object.entries(value)){if(Object.hasOwn(target,key))fail('PG_RECOVERY_CONTENT_DUPLICATE_FIELD');target[key]=item;}}
function masterContext(r,s){return ['master-segment',r.scope_id,r.source_instance,r.source_table,r.identity_hash,r.id,r.profile_hash,number(r.revision),s.kind,s.data_class];}
function historyContext(r,v){return ['history-version',r.scope_id,r.source_instance,r.source,r.source_table,r.id,r.identity_hash,r.profile_hash,number(v.revision),
 v.file_sha256,v.snapshot_at,v.imported_by,v.imported_at,v.run_id,v.master_source_instance,v.business_date,v.parent_id,v.parent_revision===null?null:number(v.parent_revision)];}
async function contentProof({core,sales,vault,onProgress=()=>{}}){
 return withProtection(core,vault,async protection=>{
  const master=accumulator(),history=accumulator();
  for(const kind of ['master','history']){
   let after='';
   for(;;){
    const records=(await sales.query(kind==='master'
     ?'SELECT * FROM trade.import_master_records WHERE id>$1 ORDER BY id LIMIT $2'
     :'SELECT * FROM integration.import_history_records WHERE id>$1 ORDER BY id LIMIT $2',[after,BATCH])).rows;
    if(!records.length)break;if(records.length>BATCH)fail('PG_RECOVERY_CONTENT_BATCH');
    const ids=records.map(r=>r.id),parts=new Map();let versions;
    if(kind==='master'){
     for(const segment of (await sales.query('SELECT * FROM trade.import_master_segments WHERE record_id=ANY($1::text[]) ORDER BY record_id,kind,data_class',[ids])).rows){
      if(!parts.has(segment.record_id))parts.set(segment.record_id,[]);parts.get(segment.record_id).push(segment);
     }
    }else{
     versions=new Map((await sales.query('SELECT v.* FROM integration.import_history_versions v JOIN integration.import_history_records r ON r.id=v.record_id AND r.revision=v.revision WHERE r.id=ANY($1::text[])',[ids])).rows.map(v=>[v.record_id,v]));
     for(const segment of (await sales.query('SELECT s.* FROM integration.import_history_segments s JOIN integration.import_history_records r ON r.id=s.record_id AND r.revision=s.revision WHERE r.id=ANY($1::text[]) ORDER BY s.record_id,s.data_class',[ids])).rows){
      if(!parts.has(segment.record_id))parts.set(segment.record_id,[]);parts.get(segment.record_id).push(segment);
     }
    }
    for(const record of records){
     const data={},segments=parts.get(record.id)||[];
     if(kind==='master'){
      for(const segment of segments)merge(data,protection.open(segment.payload,masterContext(record,segment)));
      master.add([record.scope_id,record.source_instance,record.source_table,record.profile_hash,record.identity_hash,data]);
     }else{
      const version=versions.get(record.id);if(!version)fail('PG_RECOVERY_CONTENT_VERSION');
      const context=historyContext(record,version),meta=protection.open(version.payload,context);
      for(const segment of segments)merge(data,protection.open(segment.payload,[...context,'segment',segment.data_class]));
      if(protection.digest(data)!==meta.dataHash)fail('PG_RECOVERY_CONTENT_HASH');
      history.add([record.scope_id,record.source_instance,record.source,record.source_table,record.profile_hash,record.identity_hash,data]);
     }
    }
    after=records.at(-1).id;
    onProgress({phase:'business-content-proof',kind,rows:(kind==='master'?master:history).result().rows});
   }
  }
  const publications=(await sales.query(`SELECT DISTINCT ON(h.scope_id,h.source_instance,h.profile_hash)
    h.scope_id,h.source_instance,h.profile_hash,h.file_sha256,h.snapshot_at,h.expected_rows::text AS expected_rows,
    (a.run_id IS NOT NULL AND a.header_payload=h.payload) AS coverage_verified,
    (SELECT count(*)::text FROM integration.import_history_snapshot_members m WHERE m.run_id=h.run_id) AS member_rows
    FROM integration.import_history_snapshots h LEFT JOIN integration.import_history_snapshot_attestations a ON a.run_id=h.run_id
    WHERE h.status='published' ORDER BY h.scope_id,h.source_instance,h.profile_hash,h.snapshot_at DESC,h.run_id DESC`)).rows;
  const latestPublishedSnapshots=publications.map(row=>{
   if(row.coverage_verified!==true||number(row.member_rows)!==number(row.expected_rows))fail('PG_RECOVERY_CONTENT_PUBLICATION');
   return {scopeId:row.scope_id,sourceInstance:row.source_instance,profileHash:row.profile_hash,fileSha256:row.file_sha256,snapshotAt:row.snapshot_at,rows:number(row.expected_rows)};
  });
  return {format:'gp-authenticated-source-content-multiset-v1',master:master.result(),history:history.result(),latestPublishedSnapshots};
 });
}
module.exports={contentProof};

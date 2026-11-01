'use strict';
const crypto=require('node:crypto');
const C=require('../../data-import-contract');
const H=require('../../tradefoto-history-profiles');
const {S}=require('../statements/import-history-snapshots');
const {IMPORT_HISTORY_STATEMENTS:HS}=require('../statements/import-history');
// A page can compose several service instances in the same read transaction.
// Share only successfully authenticated publication checks, never permissions.
const publicationChecks=new WeakMap();
// These small, authenticated memberships outlive staging rows and change logs.
// A reused version retains its original provenance; the snapshot is separate.
const headerContext=h=>['history-snapshot',h.runId,h.scopeId,h.sourceInstance,h.profileHash,h.fileSha256,h.snapshotAt,h.ownerId,h.expectedRows,h.status];
const memberContext=(h,m)=>[...headerContext({...h,status:'building'}),'member',m.rowNumber,m.recordId,m.revision];
const publicSnapshot=h=>({runId:h.runId,fileSha256:h.fileSha256,snapshotAt:h.snapshotAt});
async function expectOne(tx,statement,parameters){if((await tx.execute(statement,parameters)).rowsAffected!==1)C.fail('IMPORT_CONCURRENT_CHANGE',409);}
function createHistorySnapshots({protection}){
 function cacheFor(tx){let keys=publicationChecks.get(tx);if(!keys){keys=new WeakMap();publicationChecks.set(tx,keys);}let cache=keys.get(protection);if(!cache){cache=new Map();keys.set(protection,cache);}return cache;}
 const invalidate=tx=>publicationChecks.get(tx)?.delete(protection);
 function checkHeader(h){
  if(!h||!['building','published','withdrawn'].includes(h.status))C.fail('IMPORT_HISTORY_SNAPSHOT_MISSING',409);
  C.sha(h.runId);C.sha(h.profileHash);C.sha(h.fileSha256);C.integer(h.expectedRows,0,C.LIMITS.rows);
  if(!H.usesSnapshotMembership(H.profileFor('trade','ARTIKEL_FILIALEN',h.profileHash)))C.fail('IMPORT_HISTORY_INTEGRITY');
  if(!C.equal(protection.open(h.payload,headerContext(h)),{version:1}))C.fail('IMPORT_HISTORY_INTEGRITY');
  return h;
 }
 function fromContext(c){
  if(c.sourceTable!=='ARTIKEL_FILIALEN'||!H.usesSnapshotMembership(H.profileFor('trade',c.sourceTable,c.profileHash)))C.fail('IMPORT_HISTORY_CONTEXT_INVALID');
  C.sha(c.runId);C.id(c.scopeId);C.id(c.sourceInstance);C.id(c.ownerId);C.sha(c.fileSha256);C.utc(c.snapshotAt);C.integer(c.expectedRows,0,C.LIMITS.rows);
  return {runId:c.runId,scopeId:c.scopeId,sourceInstance:c.sourceInstance,profileHash:c.profileHash,fileSha256:c.fileSha256,snapshotAt:c.snapshotAt,ownerId:c.ownerId,expectedRows:c.expectedRows};
 }
 async function ensure(tx,c){
  const expected=fromContext(c),saved=await tx.queryOne(S.get,{runId:c.runId});
  if(saved){const h=checkHeader(saved);if(Object.entries(expected).some(([key,value])=>h[key]!==value))C.fail('IMPORT_HISTORY_INTEGRITY');return h;}
  const h={...expected,status:'building'};h.payload=protection.seal({version:1},headerContext(h));
  await expectOne(tx,S.insert,h);return checkHeader(await tx.queryOne(S.get,{runId:h.runId}));
 }
 async function transition(tx,h,status){
  const next={...h,status};next.payload=protection.seal({version:1},headerContext(next));
  await expectOne(tx,S.transition,{runId:h.runId,expectedStatus:h.status,status,payload:next.payload});
  await expectOne(tx,HS.advanceEpoch,{scopeId:h.scopeId,token:crypto.randomUUID()});invalidate(tx);return next;
 }
 async function coverage(tx,h){
  const c=await tx.queryOne(S.coverage,{runId:h.runId});
  // Validate before stock selectors filter by header context. A foreign member
  // must fail closed, rather than silently disappear from an otherwise complete page.
  if(c.count!==h.expectedRows||c.first!==(h.expectedRows?1:0)||c.last!==h.expectedRows||c.qualified!==h.expectedRows)C.fail('IMPORT_HISTORY_SNAPSHOT_INCOMPLETE',409);
 }
 async function publication(tx,run){
  const cache=cacheFor(tx);
  let h=cache.get(run.id||run);
  if(!h){
   h=checkHeader(await tx.queryOne(S.get,{runId:run.id||run}));
   if(h.status!=='published')C.fail('IMPORT_HISTORY_SNAPSHOT_UNPUBLISHED',409);
   if(h.publicationCheck==='guarded'){
    // The database certified the complete membership at publication and
    // invalidates that proof on every coverage-relevant write. This point read
    // is in the same snapshot as the authenticated header and selected members.
    if(h.coverageVerified!==1)C.fail('IMPORT_HISTORY_SNAPSHOT_INCOMPLETE',409);
   }else if(h.publicationCheck==='scan')await coverage(tx,h);
   else C.fail('IMPORT_HISTORY_INTEGRITY');
   cache.set(h.runId,h);
  }
  if(typeof run==='object'&&(h.scopeId!==run.scopeId||h.ownerId!==run.ownerId||h.profileHash!==run.profileHash||h.fileSha256!==run.manifest.fileSha256
   ||h.sourceInstance!==run.manifest.sourceInstance||h.snapshotAt!==run.manifest.snapshotAt||h.expectedRows!==run.manifest.expectedRows))C.fail('IMPORT_HISTORY_INTEGRITY');
  return h;
 }
 return Object.freeze({
  publication,
  async recordRows(tx,entries,context){
   const h=await ensure(tx,context);if(h.status!=='building')C.fail('IMPORT_HISTORY_SNAPSHOT_IMMUTABLE',409);
   if(!Array.isArray(entries)||entries.length>C.LIMITS.batch)C.fail('IMPORT_WRITER_CONTRACT');
   const rows=entries.map(({rowNumber,target})=>{
    C.integer(rowNumber,1,h.expectedRows);C.id(target.id);C.integer(target.revision,1,Number.MAX_SAFE_INTEGER);
    const m={runId:h.runId,rowNumber,recordId:target.id,revision:target.revision};
    return {...m,payload:protection.seal({dataHash:protection.digest(target.data)},memberContext(h,m))};
   });
   if(rows.length&&(await tx.execute(S.membersPut,{rows})).rowsAffected!==rows.length)C.fail('IMPORT_CONCURRENT_CHANGE',409);
   invalidate(tx);
  },
  async finish(tx,context){
   const h=await ensure(tx,context);if(h.status!=='building')C.fail('IMPORT_HISTORY_SNAPSHOT_IMMUTABLE',409);
   if(h.publicationCheck==='scan')await coverage(tx,h);
   else if(h.publicationCheck!=='guarded')C.fail('IMPORT_HISTORY_INTEGRITY');
   // In guarded mode, the transition trigger validates and certifies atomically.
   await transition(tx,h,'published');
  },
  async withdraw(tx,context){
   const saved=await tx.queryOne(S.get,{runId:context.runId});if(!saved)return;
   const h=await ensure(tx,context);
   if(h.status!=='withdrawn')await transition(tx,h,'withdrawn');
   await tx.execute(S.membersClear,{runId:h.runId});invalidate(tx);
  },
  async canRemove(tx,id,context){return (await tx.queryOne(S.dependencies,{runId:context.runId,recordId:id,fromRevision:1})).count===0;},
  async canRestore(tx,id,revision,context){return (await tx.queryOne(S.dependencies,{runId:context.runId,recordId:id,fromRevision:revision})).count===0;},
  async verify(tx,record,loaded,snapshot){
   if(!snapshot)return null;
   C.sha(snapshot);
   const profile=H.profileFor(record.source,record.sourceTable,record.profileHash);
   if(!H.usesSnapshotMembership(profile)){
    if(record.sourceTable==='ARTIKEL_FILIALEN'&&snapshot!==loaded.version.runId&&snapshot!==loaded.version.fileSha256)C.fail('IMPORT_HISTORY_SNAPSHOT_MISMATCH');
    return null;
   }
   const h=await publication(tx,snapshot);
   if(h.scopeId!==record.scopeId||h.sourceInstance!==record.sourceInstance||h.profileHash!==record.profileHash)C.fail('IMPORT_HISTORY_SNAPSHOT_MISMATCH');
   const m=await tx.queryOne(S.member,{runId:h.runId,recordId:record.id});
   if(!m||m.revision!==loaded.target.revision)C.fail('IMPORT_HISTORY_SNAPSHOT_MISMATCH');
   if(!C.equal(protection.open(m.payload,memberContext(h,m)),{dataHash:protection.digest(loaded.target.data)}))C.fail('IMPORT_HISTORY_INTEGRITY');
   return publicSnapshot(h);
  },
 });
}
module.exports={createHistorySnapshots};

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const C=require('../lib/data-import-contract'),P=require('../lib/data-import-known-af-proof'),V=require('../lib/data-import-af-verifier');
const T=require('../lib/data-import-source-tolerance'),H=require('../lib/tradefoto-history-profiles'),F=require('../test-support/data-import-known-af-fixture');
const policy=C.freeze({protocol:P.FORMAT,descriptorSha256:'a'.repeat(64),completeTreeSha256:'b'.repeat(64)}),code=wanted=>e=>e?.code===wanted;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function result(r){return {format:P.FORMAT,passed:true,binding:Object.fromEntries(['fileSha256','bytes','sourceSystem','sourceInstance','sourceTable','profileHash','applicationSchemaSha256','physicalContractSha256'].map(k=>[k,r[k]])),
  counts:{headerRows:r.declaredRows,logicalRows:r.expectedRows,uniqueLogicalRowIds:r.expectedRows},metadataMatchedBeforeRowCursor:true,physicalOrdinaryTable:true,externalLinksDenied:true,primaryIndexChecked:true,
  indexes:P.INDEX_NAMES.map(name=>({name,rows:r.expectedRows,uniqueRowIds:r.expectedRows,duplicates:0,extra:0,missing:0,exactCoverage:true})),allFourIndexesExact:true};}
const copy=x=>JSON.parse(JSON.stringify(x));
function request(buffer=F.sourceBuffer()){return {sourceId:'c'.repeat(64),scopeId:'synthetic-scope',ownerId:'synthetic-owner',sourceRevision:7,...P.KNOWN,
  fileSha256:hash(buffer),bytes:buffer.length,runId:'d'.repeat(64),declaredRows:2,expectedRows:3};}
function fakeVerifier(extra={}){return V.createKnownAfSourceVerifier({clock:()=>F.TIME,toolchain:policy,
  executor:async({request:r})=>({stdout:Buffer.from(JSON.stringify(result(r))),stderr:Buffer.alloc(0),exitCode:0}),...extra});}
async function withReviewedSource(tag,work){const eans=[1,2,3].map(n=>String(n).padStart(13,'0'));
  const stocks=eans.map((EAN,n)=>({...Object.fromEntries(H.tableFor('trade','ARTIKEL_FILIALEN').columns.map(c=>[c.name,null])),EAN,FilialID:1,FBestand:n+1}));
  return F.withFixture({values:{ARTIKEL_STAMM:eans.map(EAN=>F.rawMaster('ARTIKEL_STAMM',{EAN,Artikelbezeichnung:'Synthetic item'})),
    FILIALEN:[F.rawMaster('FILIALEN',{FilialID:'1'})],ARTIKEL_FILIALEN:stocks},counts:{ARTIKEL_FILIALEN:2}},async f=>{
  f.options.acceptedVerifierAssets=[policy];f.reload();const buffer=F.sourceBuffer();buffer[4000]=tag;
  let source=await f.upload(Buffer.from(buffer));source=await f.finish(source,'review');
  await work({...f,buffer,source,get runtime(){return f.runtime;}});});}
async function countEvents(f){return (await f.sales.query('SELECT count(*)::integer n FROM integration.data_import_events')).rows[0].n;}
async function sourceRow(f,id){
 const row=(await f.core.query('SELECT * FROM gp.data_import_sources WHERE id=$1',[id])).rows[0];
 return {...row,revision:Number(row.revision)};
}
async function attach(f){const r=await f.runtime.verificationRequest(f.getSession,f.source.id);assert(r);const evidence=await fakeVerifier().verify({request:r,buffer:f.buffer});
  const source=await f.runtime.attachIndependentCountProof(f.getSession,f.source.id,{expectedRevision:r.sourceRevision,evidence});return {r,evidence,source};}

test('closed known-AF helper protocol rejects wrong counts, scope and coverage',()=>{
 const r=request(),valid=result(r);assert.equal(P.helperResult(valid,r),valid);
 const changes=[x=>x.binding.profileHash='0'.repeat(64),x=>x.binding.bytes++,x=>x.counts.headerRows++,x=>x.counts.logicalRows++,
  x=>x.counts.uniqueLogicalRowIds--,x=>x.externalLinksDenied=false,x=>x.indexes[0].missing=1,x=>x.indexes[1].duplicates=1,
  x=>x.indexes[2].rows--,x=>x.indexes[3].name='Unknown',x=>x.indexes.reverse(),x=>x.indexes.push(copy(x.indexes[0])),
  x=>x.untrusted='extra',x=>x.binding.sourcePath='must-never-appear',x=>x.counts.headerRows=2.5,x=>x.passed='true'];
 for(const change of changes){const bad=copy(valid);change(bad);assert.throws(()=>P.helperResult(bad,r));}
 assert.throws(()=>P.request({...r,sourceTable:'Other'}));assert.throws(()=>P.request({...r,declaredRows:3}));
 assert.deepEqual(P.verificationSummary({sourceRow:{},sourceData:{kind:'trade',complete:false,tables:[{name:P.KNOWN.sourceTable,profileHash:P.KNOWN.profileHash,run:{gates:['SOURCE_ROW_COUNT_MISMATCH']}}]},registry:[]}),{required:false,verified:false});
});
test('verifier is lazy, verifies bytes before its explicit executor and brands only validated closed results',async()=>{
 let calls=0;const bytes=F.sourceBuffer(),r=request(bytes),v=fakeVerifier({executor:async({request:r})=>{calls++;return {stdout:Buffer.from(JSON.stringify(result(r))),stderr:Buffer.alloc(0),exitCode:0};}});
 assert.equal(calls,0);const bad=Buffer.from(bytes);bad[4000]^=1;await assert.rejects(v.verify({request:r,buffer:bad}),code('IMPORT_SOURCE_HASH_MISMATCH'));assert.equal(calls,0);
 const controller=new AbortController();controller.abort();await assert.rejects(v.verify({request:r,buffer:bytes,signal:controller.signal}),code('IMPORT_SOURCE_INTERRUPTED'));
 const value=await v.verify({request:r,buffer:bytes});assert.equal(calls,1);assert.equal(V.assertVerifiedHelperEvidence(value),value);assert(Object.isFrozen(value));assert(Object.isFrozen(value.result.indexes));
 assert.throws(()=>V.assertVerifiedHelperEvidence(copy(value)),code('IMPORT_SOURCE_PROOF_UNTRUSTED'));
 await assert.rejects(V.createKnownAfSourceVerifier({assetRoot:path.join(__dirname,'missing-known-af-assets'),appRoot:path.resolve(__dirname,'..')}).verify({request:r,buffer:bytes}),code('IMPORT_SOURCE_VERIFIER_UNAVAILABLE'));
 for(const reply of [{stdout:Buffer.from('{}'),stderr:Buffer.alloc(0),exitCode:0},{stdout:Buffer.from(JSON.stringify(result(r))),stderr:Buffer.from('bounded technical failure'),exitCode:0},
   {stdout:Buffer.alloc(65537),stderr:Buffer.alloc(0),exitCode:0},{stdout:Buffer.from(JSON.stringify(result(r))+'\n{}'),stderr:Buffer.alloc(0),exitCode:0}])
  await assert.rejects(fakeVerifier({executor:async()=>reply}).verify({request:r,buffer:bytes}));
});
test('source AEAD loader rejects tamper/foreign source, unavailable policy and destroyed keys',async()=>{
 const protection=require('../lib/data-import-protection').createDataImportProtection({encryptionKey:Buffer.alloc(32,7),indexKey:Buffer.alloc(32,8),keyId:'test-key'});
 const buffer=F.sourceBuffer(),r=request(buffer),data={kind:'trade',fileSha256:r.fileSha256,bytes:buffer.length,status:'ready',complete:true,
  tables:[{name:P.KNOWN.sourceTable,profileHash:P.KNOWN.profileHash,declaredRows:2,run:{id:r.runId,status:'ready',receivedRows:3,expectedRows:3,gates:['SOURCE_ROW_COUNT_MISMATCH']}}]};
 r.sourceId=protection.digest(['source',{scopeId:r.scopeId,ownerId:r.ownerId},'trade',r.fileSha256]);
 const ev=await fakeVerifier().verify({request:r,buffer});data.independentCountProof=P.createReceipt(ev);
 const row={id:r.sourceId,scopeId:r.scopeId,ownerId:r.ownerId,revision:r.sourceRevision,payload:protection.seal(data,['source',r.scopeId,r.ownerId,r.sourceId,r.sourceRevision])};
 const args={protection,sourceRow:row,acceptedVerifierAssets:[policy]};const loaded=P.loadSourceProofRegistry(args);
 assert.equal(loaded.proof.requiresExplicitApproval,true);assert.equal(loaded.registry.length,1);
 const manifest={sourceInstance:r.sourceInstance,schemaSha256:r.applicationSchemaSha256,fileSha256:r.fileSha256,declaredRows:2,expectedRows:3,gates:['SOURCE_ROW_COUNT_MISMATCH','SOURCE_TYPE_MISMATCH']};
 const profile=H.profileFor('trade',P.KNOWN.sourceTable),receipt={action:T.SOURCE_TOLERANCE_EVENT_PREFIX+loaded.proof.fingerprint};
 assert.deepEqual(T.effectiveSourceGates(manifest,profile,loaded.registry),manifest.gates);
 assert.deepEqual(T.effectiveSourceGates(manifest,profile,loaded.registry,[receipt]),['SOURCE_TYPE_MISMATCH']);
 assert.equal(P.loadSourceProofRegistry({...args,acceptedVerifierAssets:[]}).available,false);
 assert.throws(()=>P.loadSourceProofRegistry({...args,sourceRow:{...row,ownerId:'foreign'}}));
 const bad=copy(data);bad.independentCountProof.result.counts.logicalRows=4;
 assert.throws(()=>P.loadSourceProofRegistry({...args,sourceRow:{...row,payload:protection.seal(bad,P.sourceContext(row))}}));
 protection.destroy();assert.throws(()=>P.loadSourceProofRegistry(args),code('IMPORT_PROTECTION_UNAVAILABLE'));
});
test('PostgreSQL new-hash proof persists privately, does not approve, survives reload and lost reply',F.nativeImport,()=>withReviewedSource(17,async f=>{
 const before=await countEvents(f);
 assert.equal(f.source.independentCountVerification.required,true);const {r,evidence,source}=await attach(f);
 assert.equal(source.independentCountVerification.verified,true);assert.equal(Object.hasOwn(source,'independentCountProof'),false);
 assert.equal(await countEvents(f),before);
 const stock=source.tables.find(t=>t.name===P.KNOWN.sourceTable);assert(stock.run.gates.includes('SOURCE_ROW_COUNT_MISMATCH'));assert.equal(stock.run.sourceToleranceReceipts.length,0);assert.equal(stock.run.canApply,false);
 f.reload();assert.equal(await f.runtime.verificationRequest(f.getSession,source.id),null);
 const reopened=await f.runtime.attachIndependentCountProof(f.getSession,source.id,{expectedRevision:r.sourceRevision,evidence});assert.equal(reopened.revision,source.revision);
 assert.equal(reopened.tables.find(t=>t.name===P.KNOWN.sourceTable).run.availableSourceTolerances[0].fingerprint,stock.run.availableSourceTolerances[0].fingerprint);
 await assert.rejects(f.runtime.attachIndependentCountProof(f.getSession,source.id,{expectedRevision:source.revision,evidence:copy(evidence)}),code('IMPORT_SOURCE_PROOF_UNTRUSTED'));
}));
test('PostgreSQL separate owner receipt, shared retention and paired-key restore preserve exact proof semantics',F.nativeImport,()=>withReviewedSource(18,async f=>{
 const installed=(await attach(f)).source,table=installed.tables.find(t=>t.name===P.KNOWN.sourceTable);
 const readManifest=async()=> (await f.sales.query('SELECT manifest FROM integration.data_import_runs WHERE id=$1',[table.run.id])).rows[0].manifest;
 const original=await readManifest();
 const accepted=await f.runtime.sourceOperation(f.getSession,installed.id,'approve-counts',{expectedRevision:installed.revision});
 const stock=accepted.tables.find(t=>t.name===P.KNOWN.sourceTable);assert.equal(stock.run.id,table.run.id);assert.equal(stock.run.gates.length,0);assert.equal(stock.run.sourceToleranceReceipts.length,1);
 assert.deepEqual(await readManifest(),original);
 const applied=await f.finish(accepted,'apply');assert.equal(applied.status,'applied');
 const R=require('../lib/persistence/postgresql/operations/import-retention'),protection=await require('../lib/data-import-managed-protection').loadManagedDataImportProtection({access:f.provider,vault:f.keyVault,clock:()=>F.TIME});
 let row=await sourceRow(f,applied.id);
 const data=protection.open(row.payload,['source',row.scope_id,row.owner_id,row.id,row.revision]);
 const runs=new Map((await f.sales.query('SELECT id,scope_id,owner_id,profile_hash,manifest,status,revision::integer,received_count::integer FROM integration.data_import_runs')).rows.map(run=>[run.id,run]));
 for(const event of (await f.sales.query('SELECT * FROM integration.data_import_events WHERE action LIKE $1',[T.SOURCE_TOLERANCE_EVENT_PREFIX+'%'])).rows){
  (runs.get(event.run_id).sourceToleranceEvents??=[]).push({runId:event.run_id,actorId:event.actor_id,revision:Number(event.revision),action:event.action,at:event.at});}
 assert.equal(R.completeSuccessor({row,data},runs,{protection,acceptedVerifierAssets:[policy]}),false,'catalog completion remains required');
 // Isolate retention from the separately qualified catalog: this fixture supplies its completed predicate.
 data.catalog={complete:true};row={...row,revision:row.revision+1};row.payload=protection.seal(data,['source',row.scope_id,row.owner_id,row.id,row.revision]);
 const source={row,data},options={protection,acceptedVerifierAssets:[policy]};
 assert.equal(R.completeSuccessor(source,runs,options),true);assert.equal(R.completeSuccessor(source,runs,{protection,acceptedVerifierAssets:[]}),false);
 assert.equal(R.completeSuccessor(source,runs,{acceptedVerifierAssets:[policy]}),false);
 const missing=new Map([...runs].map(([id,run])=>[id,{...run,sourceToleranceEvents:[]}]));assert.equal(R.completeSuccessor(source,missing,options),false);
 const altered=copy(data);altered.independentCountProof.result.indexes[0].missing=1;
 const changedRow={...row,payload:protection.seal(altered,['source',row.scope_id,row.owner_id,row.id,row.revision])};assert.equal(R.completeSuccessor({row:changedRow,data:altered},runs,options),false);
 protection.destroy();assert.equal(R.completeSuccessor(source,runs,options),false);
 const restored=await require('../lib/data-import-managed-protection').loadManagedDataImportProtection({access:f.provider,vault:f.keyVault,clock:()=>F.TIME});
 assert.equal(R.completeSuccessor(source,runs,{protection:restored,acceptedVerifierAssets:[policy]}),true,'same source/Sales/vault pair reconstructs identical proof');
 const provenance=copy(data);provenance.status='purged';provenance.retirement={complete:true};
 for(const table of provenance.tables)table.run={id:table.run.id,status:'purged',receivedRows:table.run.receivedRows};
 const purgedRow={id:row.id,scopeId:row.scope_id,ownerId:row.owner_id,revision:row.revision+1};purgedRow.payload=restored.seal(provenance,P.sourceContext(purgedRow));
 assert.equal(P.loadSourceProofRegistry({protection:restored,sourceRow:purgedRow,acceptedVerifierAssets:[policy]}).available,true,'small proof survives provenance-only source shape');
 restored.destroy();
}));
test('PostgreSQL stale source revision, foreign capability, expiry and absent policy fail closed',F.nativeImport,()=>withReviewedSource(19,async f=>{
 const r=await f.runtime.verificationRequest(f.getSession,f.source.id),evidence=await fakeVerifier().verify({request:r,buffer:f.buffer});
 const protection=await require('../lib/data-import-managed-protection').loadManagedDataImportProtection({access:f.provider,vault:f.keyVault,clock:()=>F.TIME});
 const row=await sourceRow(f,f.source.id);
 const data=protection.open(row.payload,['source',row.scope_id,row.owner_id,row.id,row.revision]);data.error='SYNTHETIC_CONCURRENT_SOURCE_UPDATE';
 const payload=protection.seal(data,['source',row.scope_id,row.owner_id,row.id,row.revision+1]);
 await f.core.query('UPDATE gp.data_import_sources SET revision=revision+1,payload=$1 WHERE id=$2 AND revision=$3',[payload,row.id,row.revision]);protection.destroy();
 await assert.rejects(f.runtime.attachIndependentCountProof(f.getSession,f.source.id,{expectedRevision:r.sourceRevision,evidence}),code('IMPORT_REVISION_CONFLICT'));
 const fresh=await f.runtime.verificationRequest(f.getSession,f.source.id),foreign=await fakeVerifier().verify({request:{...fresh,ownerId:'foreign'},buffer:f.buffer});
 await assert.rejects(f.runtime.attachIndependentCountProof(f.getSession,f.source.id,{expectedRevision:fresh.sourceRevision,evidence:foreign}),code('IMPORT_SOURCE_PROOF_INVALID'));
 f.options.acceptedVerifierAssets=[];f.reload();const next=await f.runtime.verificationRequest(f.getSession,f.source.id),ev=await fakeVerifier().verify({request:next,buffer:f.buffer});
 await assert.rejects(f.runtime.attachIndependentCountProof(f.getSession,f.source.id,{expectedRevision:next.sourceRevision,evidence:ev}),code('IMPORT_SOURCE_VERIFIER_UNAVAILABLE'));
 f.options.clock=()=>new Date(Date.parse(F.TIME)+31*24*60*60*1000).toISOString();f.reload();await assert.rejects(f.runtime.verificationRequest(f.getSession,f.source.id),code('IMPORT_RUN_EXPIRED'));
}));
test('static exact proof remains the original trusted object/fingerprint and suppresses dynamic verification',F.nativeImport,()=>withReviewedSource(20,async f=>{
 const profile=H.profileFor('trade',P.KNOWN.sourceTable);
 const proof=T.defineDataImportSourceTolerance({id:'synthetic-static-af',recordedAt:F.TIME,approvalReference:'explicit-owner-receipt-required',reason:'Synthetic exact static proof',evidenceReference:'synthetic-test-only',
  sourceSystem:profile.sourceSystem,sourceInstance:'tradefoto-trade',sourceTable:profile.sourceTable,profileHash:profile.fingerprint,schemaSha256:profile.schemaSha256,fileSha256:hash(f.buffer),declaredRows:2,expectedRows:3,requiresExplicitApproval:true});
 const fp=proof.fingerprint;f.options.sourceTolerances=[proof];f.reload();assert.equal(await f.runtime.verificationRequest(f.getSession,f.source.id),null);
 const source=await f.runtime.sourceOperation(f.getSession,f.source.id,'read'),stock=source.tables.find(t=>t.name===P.KNOWN.sourceTable);
 assert.equal(stock.run.availableSourceTolerances.length,1);assert.equal(stock.run.availableSourceTolerances[0],proof);assert.equal(proof.fingerprint,fp);
}));


test('real Runtime, encrypted JobStore and controlled helper transport persist new-hash evidence before unlink without owner approval',F.nativeImport,async t=>{
 const os=require('node:os'),{createDataImportLifecycle}=require('../lib/data-import-lifecycle');
 const eans=[1,2,3].map(n=>String(n).padStart(13,'0'));
 const rows=eans.map((EAN,n)=>({...Object.fromEntries(H.tableFor('trade',P.KNOWN.sourceTable).columns.map(c=>[c.name,null])),EAN,FilialID:1,FBestand:n+1}));
 await F.withFixture({values:{ARTIKEL_STAMM:eans.map(EAN=>F.rawMaster('ARTIKEL_STAMM',{EAN})),FILIALEN:[F.rawMaster('FILIALEN',{FilialID:'1'})],[P.KNOWN.sourceTable]:rows},counts:{[P.KNOWN.sourceTable]:2}},async f=>{
 const lifecycle=createDataImportLifecycle();f.options.acceptedVerifierAssets=[policy];f.options.lifecycle=lifecycle;f.reload();
 const bytes=F.sourceBuffer();bytes[4000]=31;const sourceSha=hash(bytes);
 const tempRoot=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(tempRoot,'known-af-jobs-'));
 const originalStore=require('../lib/data-import-job-store').createDataImportJobStore({directory:path.join(directory,'spool'),vault:f.keyVault,now:()=>Date.parse(F.TIME)});
 const decrypted=[],errors=[];let rawRemoved=0,verifiedCalls=0,sourceId;
 const store={...originalStore,async decrypt(blob,signal){if(decrypted.length===1)assert(decrypted[0].every(byte=>byte===0),'post-upload buffer must be zero before the next decrypt');
  const buffer=await originalStore.decrypt(blob,signal);decrypted.push(buffer);return buffer;},async remove(name){
  if(name.endsWith('.source')){rawRemoved++;assert.equal(verifiedCalls,1);const view=await f.runtime.sourceOperation(f.getSession,sourceId,'read');
   assert.equal(view.independentCountVerification.verified,true,'durable Source proof and readback must precede unlink');
   assert.equal((await f.sales.query('SELECT count(*)::int n FROM integration.data_import_events WHERE action LIKE $1',[T.SOURCE_TOLERANCE_EVENT_PREFIX+'%'])).rows[0].n,0);
   assert.equal((await f.sales.query('SELECT count(*)::int n FROM integration.import_history_records')).rows[0].n,0);}
  return originalStore.remove(name);}};
 const transport=fakeVerifier();
 const countVerifier={async verify(input){verifiedCalls++;assert.equal(decrypted.length,2);assert.equal(input.buffer,decrypted[1]);assert.equal(input.request.fileSha256,sourceSha);
  assert.equal(input.request.declaredRows,2);assert.equal(input.request.expectedRows,3);return transport.verify(input);}};
 const jobs=require('../lib/data-import-jobs').createDataImportJobs({directory:path.join(directory,'spool'),vault:f.keyVault,runtime:f.runtime,countVerifier,store,lifecycle,
  resolvePrincipal:async()=>f.state.session,now:()=>Date.parse(F.TIME),onError:error=>errors.push(error)});
 t.after(async()=>{await jobs.stop();await lifecycle.stop();assert.equal(path.dirname(fs.realpathSync(directory)),tempRoot);fs.rmSync(directory,{recursive:true,force:true});});
 let source=await jobs.enqueue(f.getSession,{buffer:Buffer.from(bytes),kind:'trade',fileName:'Trade_Daten.accdb'});sourceId=source.id;
 for(let n=0;n<5;n++){await jobs.tick();source=await f.runtime.sourceOperation(f.getSession,sourceId,'read');if(['ready','needs_review'].includes(source.status))break;}
 assert.deepEqual(errors,[]);assert.equal(source.status,'needs_review');assert.equal(verifiedCalls,1);assert.equal(decrypted.length,2);assert.equal(rawRemoved,1);
 assert(decrypted.every(buffer=>buffer.every(byte=>byte===0)));assert.equal(source.independentCountVerification.verified,true);assert.equal(Object.hasOwn(source,'independentCountProof'),false);
 assert.equal((await f.sales.query('SELECT count(*)::int n FROM integration.import_history_records')).rows[0].n,0);
 const stock=source.tables.find(table=>table.name===P.KNOWN.sourceTable);assert.equal(stock.run.sourceToleranceReceipts.length,0);assert(stock.run.gates.includes('SOURCE_ROW_COUNT_MISMATCH'));
 source=await f.runtime.sourceOperation(f.getSession,source.id,'approve-counts',{expectedRevision:source.revision});assert.equal(source.tables.find(table=>table.name===P.KNOWN.sourceTable).run.gates.length,0);
 bytes.fill(0);
 });
});

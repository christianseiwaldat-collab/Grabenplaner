'use strict';
// Direct product imports; synthetic job state and the real encrypted spool.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const C=require('../lib/data-import-contract'),Jobs=require('../lib/data-import-jobs');
const {createDataImportLifecycle}=require('../lib/data-import-lifecycle'),{createIntegrationSecretVault}=require('../lib/integration-secret-vault'),{createDataImportJobStore}=require('../lib/data-import-job-store');
const {DATA_IMPORT_PERMISSIONS:P}=require('../lib/data-import-access');
const principal=()=>({employeeNumber:'synthetic',accountId:null,isEmployee:true,permissions:[...Object.values(P),'sales:analytics:access','sales:analytics:company:read']});
const raw=()=>{const b=Buffer.alloc(4096);b.write('Standard ACE DB',4);b[0x14]=3;b.write('private synthetic input',256);return b;};
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function fixture(t,{needed=true,completed=false}={}){
 const temp=await fsp.realpath(os.tmpdir());if(process.platform==='win32')assert.equal(path.parse(temp).root.toUpperCase(),'C:\\');
 const parent=await fsp.mkdtemp(path.join(temp,'gp-af-jobs-')),directory=path.join(parent,'spool');
 const vault=createIntegrationSecretVault({activeKeyId:'test',keys:{test:Buffer.alloc(32,9)}}),state={now:Date.now(),principal:principal(),needed,events:[],uploads:0,verifies:0,attaches:0,reviews:0,decrypts:0,sources:new Map(),capability:Object.freeze({kind:'synthetic-private-evidence'}),requestGate:null,verifyGate:null,verifiedBuffer:null};
 const get=async()=>state.principal;
 const view=s=>({...s,independentCountVerification:{required:state.needed&&!s.verified,verified:!!s.verified},tables:[{run:{gates:state.needed&&!s.ownerAccepted?['SOURCE_ROW_COUNT_MISMATCH']:[]}}]});
 const runtime={
  async reserve(getSession,{buffer,kind}){const who=await getSession(),id=crypto.createHash('sha256').update(who.employeeNumber).update(kind).update(buffer).digest('hex');if(!state.sources.has(id))state.sources.set(id,{id,kind,revision:1,complete:completed,status:completed?'needs_review':'queued',activationEnabled:true,fileSha256:crypto.createHash('sha256').update(buffer).digest('hex'),bytes:buffer.length,ownerAccepted:false,verified:false,archiveMarker:'unchanged'});return view(state.sources.get(id));},
  async upload(getSession,{buffer}){await getSession();state.events.push('upload');state.uploads++;state.firstBuffer=buffer;assert.ok(buffer.includes(Buffer.from('private synthetic input')));const s=[...state.sources.values()][0];s.complete=true;s.status='reviewing';return view(s);},
  async verificationRequest(getSession,id){await getSession();const s=state.sources.get(id);state.events.push('request');if(state.requestGate)await state.requestGate.promise;if(!s.complete||!state.needed||s.verified)return null;return state.request=Object.freeze({sourceId:id,sourceRevision:s.revision,fileSha256:s.fileSha256,bytes:s.bytes,kind:s.kind});},
  async attachIndependentCountProof(getSession,id,{expectedRevision,evidence}){await getSession();state.events.push('attach');state.attaches++;assert.equal(evidence,state.capability);assert.equal(state.childClosed,true);const s=state.sources.get(id);if(s.revision!==expectedRevision)C.fail('IMPORT_REVISION_CONFLICT',409);if(state.attachFailBefore)C.fail('PERSISTENCE_CONNECTION_UNAVAILABLE',503);if(Object.hasOwn(state,'attachAck'))return state.attachAck;s.verified=true;s.revision++;if(state.attachGate){state.attachEntered.resolve();await state.attachGate.promise;}if(state.lostReply){state.lostReply=false;C.fail('PERSISTENCE_CONNECTION_UNAVAILABLE',503);}return view(s);},
  async sourceOperation(getSession,id,action){await getSession();const s=state.sources.get(id);if(action==='review'){state.events.push('review');state.reviews++;s.status=state.needed&&!s.ownerAccepted?'needs_review':'ready';s.revision++;}return view(s);}
 };
 const verifier={async verify({request,buffer,signal}){state.events.push('verify');state.verifies++;state.verifiedBuffer=buffer;state.childClosed=false;assert.equal(request,state.request);assert.equal(crypto.createHash('sha256').update(buffer).digest('hex'),request.fileSha256);assert.ok(!state.firstBuffer||state.firstBuffer.every(n=>n===0));if(state.entered)state.entered.resolve();if(state.verifyGate)await state.verifyGate.promise;state.childClosed=true;if(signal.aborted)C.fail('IMPORT_SOURCE_INTERRUPTED',409);if(state.verifyFailure)C.fail(state.verifyFailure,409);return state.capability;}};
 const store=createDataImportJobStore({directory,vault,now:()=>state.now}),decrypt=store.decrypt,remove=store.remove;
 store.decrypt=async(...a)=>{state.decrypts++;return decrypt(...a);};
 store.remove=async name=>{if(name.endsWith('.source')){state.events.push('unlink');if(state.unlinkFailure){state.unlinkFailure=false;C.fail('IMPORT_SOURCE_BUSY',409);}}return remove(name);};
 let queue;const make=(extra={})=>{queue=Jobs.createDataImportJobs({directory,vault,runtime,countVerifier:verifier,resolvePrincipal:get,lifecycle:createDataImportLifecycle(),store,now:()=>state.now,...extra});return queue;};make();
 const enqueue=()=>queue.enqueue(get,{buffer:raw(),kind:'trade'});
 t.after(async()=>{state.requestGate?.resolve();state.verifyGate?.resolve();state.attachGate?.resolve();await queue.stop();assert.equal(await fsp.realpath(parent),parent);assert.equal(path.dirname(parent),temp);await fsp.rm(parent,{recursive:true,force:true});});
 return {state,runtime,verifier,store,enqueue,get,make,get queue(){return queue;},source:()=>[...state.sources.values()][0]};
}

test('count evidence is durable before unlink, retains owner gate, and zeroes both plaintext buffers',async t=>{
 const f=await fixture(t),s=await f.enqueue();await f.queue.tick();
 assert.equal(f.state.verifies,1);assert.equal(f.state.attaches,1);assert.equal(f.source().verified,true);assert.equal(f.source().ownerAccepted,false);assert.equal(f.source().status,'needs_review');
 assert.ok(f.state.events.indexOf('attach')<f.state.events.indexOf('unlink'));assert.ok(f.state.events.indexOf('unlink')<f.state.events.indexOf('review'));assert.ok(f.state.firstBuffer.every(n=>n===0));assert.ok(f.state.verifiedBuffer.every(n=>n===0));assert.equal(f.state.decrypts,2);assert.deepEqual(await f.store.list(),[]);
 await assert.rejects(f.queue.enqueueApply(f.get,s.id,{expectedRevision:f.source().revision}),{code:'IMPORT_DECISION_GATE'});
});
test('ordinary matching counts skip verifier and second decryption',async t=>{
 const f=await fixture(t,{needed:false});await f.enqueue();await f.queue.tick();assert.equal(f.state.verifies,0);assert.equal(f.state.attaches,0);assert.equal(f.state.decrypts,1);assert.equal(f.source().status,'ready');
});
test('exact completed-source verification reupload never repeats upload/read or changes archived records',async t=>{
 const f=await fixture(t,{completed:true}),s=await f.enqueue();const job=await f.store.read(s.id);assert.equal(job.phase,'reviewing');assert.ok(job.blob);assert.equal(job.operation,undefined);await f.queue.tick();assert.equal(f.state.uploads,0);assert.equal(f.state.reviews,0);assert.equal(f.state.verifies,1);assert.equal(f.state.decrypts,1);assert.equal(f.source().archiveMarker,'unchanged');assert.equal(f.source().ownerAccepted,false);
});
test('verifier failure retains encrypted original and retry verifies without rereading the Access source',async t=>{
 const f=await fixture(t);f.state.verifyFailure='IMPORT_SOURCE_VERIFICATION_FAILED';const s=await f.enqueue();await f.queue.tick();let j=await f.store.read(s.id);assert.equal(j.status,'failed');assert.ok(j.blob);assert.equal(f.source().verified,false);assert.ok(f.state.verifiedBuffer.every(n=>n===0));assert.equal(f.state.events.includes('unlink'),false);
 f.state.verifyFailure=null;await f.queue.action(f.get,s.id,'retry');await f.queue.tick();assert.equal(f.state.uploads,1);assert.equal(f.state.verifies,2);assert.equal(f.source().verified,true);
});
test('pause keeps the RAM slot until child cleanup closes, retains raw reference and cannot attach',async t=>{
 const f=await fixture(t);f.state.entered=defer();f.state.verifyGate=defer();const s=await f.enqueue(),running=f.queue.tick();await f.state.entered.promise;
 assert.equal((await f.queue.overlay(f.source())).background.independentCountVerification,true);await f.queue.action(f.get,s.id,'pause');assert.throws(()=>f.queue.beginUpload(),{code:'IMPORT_SOURCE_BUSY'});await assert.rejects(f.enqueue(),{code:'IMPORT_SOURCE_BUSY'});assert.equal(f.source().verified,false);
 f.state.verifyGate.resolve();await running;assert.equal((await f.store.read(s.id)).status,'paused');assert.ok(f.state.verifiedBuffer.every(n=>n===0));const release=f.queue.beginUpload();release();assert.equal(f.state.attaches,0);
});
test('an upload admitted during request lookup defers verification before allocating its plaintext buffer',async t=>{
 const f=await fixture(t);f.state.requestGate=defer();const original=f.runtime.verificationRequest;let entered;const seen=new Promise(r=>{entered=r;});f.runtime.verificationRequest=async(...a)=>{entered();return original(...a);};const s=await f.enqueue(),running=f.queue.tick();await seen;const release=f.queue.beginUpload();f.state.requestGate.resolve();await running;assert.equal(f.state.decrypts,1);assert.equal(f.state.verifies,0);const job=await f.store.read(s.id);assert.equal(job.status,'retrying');assert.ok(job.blob);release();f.state.requestGate=null;f.state.now+=30001;await f.queue.tick();assert.equal(f.state.verifies,1);
});
test('revocation after the helper starts prevents attachment and preserves retry material',async t=>{
 const f=await fixture(t);f.state.entered=defer();f.state.verifyGate=defer();const s=await f.enqueue(),running=f.queue.tick();await f.state.entered.promise;f.state.principal={...principal(),permissions:[]};f.state.verifyGate.resolve();await running;assert.equal(f.state.attaches,0);assert.equal(f.source().verified,false);assert.equal((await f.store.read(s.id)).error,'IMPORT_FORBIDDEN');assert.ok(f.state.verifiedBuffer.every(n=>n===0));
});
test('an expired job cannot persist evidence returned after expiry',async t=>{
 const f=await fixture(t);f.state.entered=defer();f.state.verifyGate=defer();const s=await f.enqueue(),running=f.queue.tick();await f.state.entered.promise;f.state.now=(await f.store.read(s.id)).expires+1;f.state.verifyGate.resolve();await running;assert.equal(f.state.attaches,0);assert.equal(f.source().verified,false);assert.equal((await f.store.read(s.id)).error,'IMPORT_JOB_EXPIRED');assert.ok(f.state.verifiedBuffer.every(n=>n===0));
});
test('lost acknowledgement after proof commit resumes by readback and does not repeat the helper',async t=>{
 const f=await fixture(t);f.state.lostReply=true;const s=await f.enqueue();await f.queue.tick();assert.equal(f.source().verified,true);assert.ok((await f.store.read(s.id)).blob);f.state.now+=30001;await f.queue.tick();assert.equal(f.state.verifies,1);assert.equal(f.state.attaches,1);assert.equal(f.state.uploads,1);assert.deepEqual(await f.store.list(),[]);
});
test('unlink failure after proof commit remains restart-safe and does not repeat decryption or verification',async t=>{
 const f=await fixture(t);f.state.unlinkFailure=true;const s=await f.enqueue();await f.queue.tick();assert.equal(f.source().verified,true);assert.ok((await f.store.read(s.id)).blob);await f.queue.stop();f.make();f.state.now+=30001;await f.queue.tick();assert.equal(f.state.verifies,1);assert.equal(f.state.decrypts,2);assert.equal(f.state.uploads,1);assert.deepEqual(await f.store.list(),[]);
});
test('missing verifier fails closed while keeping encrypted upload and releasing admission',async t=>{
 const f=await fixture(t);await f.queue.stop();f.make({countVerifier:null});const s=await f.enqueue();await f.queue.tick();assert.equal((await f.store.read(s.id)).error,'IMPORT_SOURCE_VERIFIER_UNAVAILABLE');assert.ok((await f.store.read(s.id)).blob);assert.equal(f.state.decrypts,1);assert.equal(f.source().verified,false);const release=f.queue.beginUpload();release();
});
test('missing runtime verification APIs reject composition instead of silently deleting original',async t=>{
 const f=await fixture(t);for(const missing of ['verificationRequest','attachIndependentCountProof']){const runtime={...f.runtime};delete runtime[missing];assert.throws(()=>Jobs.createDataImportJobs({directory:'synthetic',vault:{},runtime,lifecycle:{}}),{code:'IMPORT_COMPOSITION_INVALID'});}
});
test('shutdown waits for verifier child close and reconstruction resumes from the retained encrypted original',async t=>{
 const f=await fixture(t);f.state.entered=defer();f.state.verifyGate=defer();const s=await f.enqueue(),running=f.queue.tick();await f.state.entered.promise;let ended=false;const stopping=f.queue.stop().then(()=>{ended=true;});await new Promise(r=>setImmediate(r));assert.equal(ended,false);assert.equal(f.state.childClosed,false);assert.ok(f.state.verifiedBuffer.includes(Buffer.from('private synthetic input')));
 f.state.verifyGate.resolve();await stopping;await running;assert.ok(f.state.verifiedBuffer.every(n=>n===0));assert.equal(f.state.attaches,0);assert.equal((await f.store.read(s.id)).status,'queued');assert.ok((await f.store.read(s.id)).blob);f.make();f.state.now+=2001;await f.queue.tick();assert.equal(f.state.uploads,1);assert.equal(f.state.verifies,2);assert.equal(f.source().verified,true);
});
test('explicitly deleting a failed verifier upload preserves archive and permits an exact verification-only reupload',async t=>{
 const f=await fixture(t);f.state.verifyFailure='IMPORT_SOURCE_VERIFICATION_FAILED';const s=await f.enqueue();await f.queue.tick();const deleted=await f.queue.deleteUpload(f.get,s.id,{expectedRevision:f.source().revision});assert.equal(deleted.uploadFileAvailable,false);assert.equal(f.source().archiveMarker,'unchanged');assert.equal(f.source().verified,false);f.state.verifyFailure=null;await f.enqueue();await f.queue.tick();assert.equal(f.state.uploads,1);assert.equal(f.state.verifies,2);assert.equal(f.source().verified,true);assert.equal(f.source().ownerAccepted,false);
});

test('incomplete, foreign-source and absent proof acknowledgements retain the original instead of unlinking',async t=>{
 for(const mode of ['missing','foreign','unverified']){const f=await fixture(t),s=await f.enqueue();f.state.attachAck=mode==='missing'?undefined:{id:mode==='foreign'?'f'.repeat(64):s.id,independentCountVerification:{verified:mode==='foreign'}};await f.queue.tick();const job=await f.store.read(s.id);assert.equal(job.error,'IMPORT_SOURCE_VERIFICATION_INCOMPLETE');assert.ok(job.blob);assert.equal(f.state.events.includes('unlink'),false);assert.equal(f.source().verified,false);assert.ok(f.state.verifiedBuffer.every(n=>n===0));}
});
test('pause during proof commit/readback retains original even after a durable receipt; retry only cleans up',async t=>{
 const f=await fixture(t);f.state.attachEntered=defer();f.state.attachGate=defer();const s=await f.enqueue(),running=f.queue.tick();await f.state.attachEntered.promise;assert.equal(f.source().verified,true);await f.queue.action(f.get,s.id,'pause');f.state.attachGate.resolve();await running;const job=await f.store.read(s.id);assert.equal(job.status,'paused');assert.ok(job.blob);assert.equal(f.state.events.includes('unlink'),false);assert.ok(f.state.verifiedBuffer.every(n=>n===0));await f.queue.action(f.get,s.id,'retry');await f.queue.tick();assert.equal(f.state.verifies,1);assert.equal(f.state.attaches,1);assert.deepEqual(await f.store.list(),[]);assert.equal(f.source().ownerAccepted,false);
});

test('an admitted pause while a null verification request is pending prevents cleanup from starting',async t=>{
 const f=await fixture(t,{needed:false});f.state.requestGate=defer();const entered=defer(),original=f.runtime.verificationRequest;f.runtime.verificationRequest=async(...args)=>{entered.resolve();return original(...args);};const s=await f.enqueue(),running=f.queue.tick();await entered.promise;await f.queue.action(f.get,s.id,'pause');f.state.requestGate.resolve();await running;const job=await f.store.read(s.id);assert.equal(job.status,'paused');assert.ok(job.blob);assert.equal(f.state.events.includes('unlink'),false);assert.equal(f.state.verifies,0);assert.ok(f.state.firstBuffer.every(n=>n===0));f.state.requestGate=null;await f.queue.action(f.get,s.id,'retry');await f.queue.tick();assert.equal(f.state.uploads,1);assert.equal(f.source().status,'ready');assert.deepEqual(await f.store.list(),[]);
});


test('a paused current worker cannot be replaced by same-source reupload before its final checkpoint',async t=>{
 const f=await fixture(t),entered=defer(),pending=defer(),original=f.runtime.verificationRequest;
 let calls=0;
 f.runtime.verificationRequest=async(...args)=>{if(++calls===1){entered.resolve();await pending.promise;}return original(...args);};
 const source=await f.enqueue(),running=f.queue.tick();await entered.promise;
 await f.queue.action(f.get,source.id,'pause');const paused=await f.store.read(source.id);assert.equal(paused.status,'paused');assert.ok(paused.blob);
 try {
  await assert.rejects(f.enqueue(),{code:'IMPORT_SOURCE_BUSY'});
  const stillPaused=await f.store.read(source.id);assert.equal(stillPaused.status,'paused');assert.equal(stillPaused.blob.name,paused.blob.name);
  assert.equal(f.state.uploads,1);assert.equal(f.state.verifies,0);
 } finally {pending.resolve();await running;}
 await f.queue.action(f.get,source.id,'retry');await f.queue.tick();
 assert.equal(f.state.uploads,1);assert.equal(f.state.verifies,1);assert.equal(f.source().verified,true);assert.equal(f.source().ownerAccepted,false);assert.deepEqual(await f.store.list(),[]);
});

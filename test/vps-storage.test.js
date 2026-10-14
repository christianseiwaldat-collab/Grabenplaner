'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const C = require('../lib/vps-storage-contract');
const B = require('../lib/persistence/postgresql/operations/paired-bundle');
const R = require('../lib/persistence/postgresql/operations/storage-residuals');
const I = require('../lib/persistence/postgresql/operations/import-retention');
const { definitions } = require('../lib/tradefoto-full-import-source');
const { createDataImportProtection } = require('../lib/data-import-protection');
const uuid = () => crypto.randomUUID();
test('storage requests reject arbitrary paths, weak policy and missing technical role', () => {
  assert.throws(() => C.validateRequest({ format:C.FORMAT,action:'cleanup',requestId:uuid(),planSha256:'f'.repeat(64),path:'/tmp' }));
  assert.throws(() => C.validateRequest({ format:C.FORMAT,action:'cleanup',requestId:uuid() }));
  assert.throws(() => C.validateSettings({ warningGiB:1,orphanAgeDays:7 }));
  assert.throws(() => C.validateSettings({ warningGiB:5,orphanAgeDays:1 }));
  const actor = { role:'developer', permissions:['system:diagnostics:technical'] };
  assert.equal(C.requireActor(actor),actor); assert.throws(() => C.requireActor(actor,true));
  assert.throws(() => C.requireActor({ role:'manager',permissions:['system:diagnostics:technical','system:write'] }));
});
async function fixture(t, count = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'gp-storage-')); fs.chmodSync(root,0o700);
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const now = Date.now() + 10 * 86400000;
  for (let n=0;n<count;n++) {
    const directory = path.join(root,uuid()+'.pair'); fs.mkdirSync(directory,{mode:0o700});
    for (const name of ['core.dump','sales.dump','configuration.env','roles.sql']) fs.writeFileSync(path.join(directory,name),'synthetic-'+n,{mode:0o600});
    await B.sealPairBundle(directory,{databases:[{domain:'core',database:'synthetic_core',file:'core.dump'},{domain:'sales',database:'synthetic_sales',file:'sales.dump'}],checkpoint:{},createdAt:new Date(now-n*60000).toISOString()});
  }
  const orphan = path.join(root,uuid()+'.pair'); fs.mkdirSync(orphan,{mode:0o700});
  fs.writeFileSync(path.join(orphan,'core.dump'),'PGDMP-partial-core',{mode:0o600});fs.writeFileSync(path.join(orphan,'sales.dump'),'PGDMP-partial-sales',{mode:0o600});
  return {root,orphan,now};
}
test('residual cleanup removes only the exact preview, preserving complete backups and unknown directories', async t => {
  const f = await fixture(t), unknown = path.join(f.root,uuid()+'.pair');fs.mkdirSync(unknown,{mode:0o700});fs.writeFileSync(path.join(unknown,'notes'),'do not remove');
  const plan = await R.inspectResiduals(f.root,{now:f.now});assert.equal(plan.candidates.length,1);assert.equal(plan.complete.length,2);assert.equal(plan.unknown.length,1);
  const proofs=[];const result=await R.removeResiduals(f.root,plan.planSha256,{now:f.now,assertUnused:()=>{},record:p=>proofs.push(p)});
  assert.equal(result.removed.length,1);assert.equal(fs.existsSync(f.orphan),false);assert.equal(fs.existsSync(unknown),true);
  assert.equal((await R.inspectResiduals(f.root,{now:f.now})).complete.length,2);assert.equal(proofs[0].retained.length,2);assert.equal(proofs[0].files[0].files.length,2);
});
test('cleanup refuses changed previews, active users and fewer than two recovery points', async t => {
  const f = await fixture(t,1), plan=await R.inspectResiduals(f.root,{now:f.now});
  await assert.rejects(R.removeResiduals(f.root,plan.planSha256,{now:f.now,assertUnused:()=>{}}),/TWO_BACKUPS_REQUIRED/);
  assert.equal(fs.existsSync(f.orphan),true);
  const g = await fixture(t), preview=await R.inspectResiduals(g.root,{now:g.now});
  await assert.rejects(R.removeResiduals(g.root,preview.planSha256,{now:g.now,assertUnused:()=>{throw Error('VPS_STORAGE_RESIDUAL_IN_USE');}}),/RESIDUAL_IN_USE/);
  fs.writeFileSync(path.join(g.orphan,'sales.dump'),'changed-source',{mode:0o600});
  await assert.rejects(R.removeResiduals(g.root,preview.planSha256,{now:g.now,assertUnused:()=>{}}),/PLAN_CHANGED/);
  assert.equal(fs.existsSync(g.orphan),true);
});
test('a damaged sealed backup blocks cleanup before the first deletion', async t => {
  const f = await fixture(t), preview=await R.inspectResiduals(f.root,{now:f.now});
  const point=path.join(f.root,preview.complete[0].name,'sales.dump');const bytes=fs.readFileSync(point);bytes[0]^=1;fs.writeFileSync(point,bytes);
  await assert.rejects(R.removeResiduals(f.root,preview.planSha256,{now:f.now,assertUnused:()=>{}}),/COMPONENT_HASH/);assert.equal(fs.existsSync(f.orphan),true);
});
test('a single leftover dump is recognized while unknown dump contents are protected',async t=>{
 const f=await fixture(t);fs.unlinkSync(path.join(f.orphan,'core.dump'));
 const plan=await R.inspectResiduals(f.root,{now:f.now});assert.equal(plan.candidates.length,1);assert.equal(plan.candidates[0].files.length,1);
 await R.removeResiduals(f.root,plan.planSha256,{now:f.now,assertUnused:()=>{}});assert.equal(fs.existsSync(f.orphan),false);
 const g=await fixture(t);fs.writeFileSync(path.join(g.orphan,'sales.dump'),'unknown-content');
 const blocked=await R.inspectResiduals(g.root,{now:g.now});assert.equal(blocked.candidates.length,0);assert.equal(blocked.unknown.length,1);
});
function source({kind='trade',owner='a',at='2026-09-01T12:00:00.000Z',complete=true,catalog=true,status='applied',seed='old'}={}) {
  const fileSha256=C.digest(seed),row={id:C.digest('source-'+seed),scope_id:'synthetic',owner_id:owner,revision:1,created_at:at,payload:''},runs=new Map();
  const tables=definitions(kind).map((def,n)=>{
    const id=C.digest(seed+':'+n),manifest={sourceInstance:'tradefoto-'+kind,fileSha256,schemaSha256:def.profile.schemaSha256,expectedRows:0,declaredRows:0,gates:[]};
    runs.set(id,{id,scope_id:row.scope_id,owner_id:owner,profile_hash:def.profile.fingerprint,status,revision:1,received_count:0,manifest});
    return {name:def.name,profileHash:def.profile.fingerprint,declaredRows:0,run:{id,receivedRows:0,counts:{},gates:[],status}};
  });
  return {source:{row,data:{kind,fileSha256,tables,complete,status,catalog:{complete:catalog}}},runs};
}
test('old import copies qualify only with a complete current successor of the same source and account',()=>{
  const old=source(),next=source({seed:'next',at:'2026-10-01T12:00:00.000Z'}),runs=new Map([...old.runs,...next.runs]);
  const plan=I.planSources([old.source,next.source],runs);assert.equal(plan.pairs.length,1);assert.equal(plan.pairs[0].sourceId,old.source.row.id);
  next.source.data.complete=false;assert.equal(I.planSources([old.source,next.source],runs).pairs.length,0);
  next.source.data.complete=true;next.source.data.catalog.complete=false;assert.equal(I.planSources([old.source,next.source],runs).pairs.length,0);
  next.source.data.catalog.complete=true;next.runs.values().next().value.status='applying';assert.equal(I.planSources([old.source,next.source],runs).pairs.length,0);
  const other=source({seed:'other',owner:'b',at:'2026-10-02T12:00:00.000Z'});
  assert.equal(I.planSources([old.source,other.source],new Map([...old.runs,...other.runs])).pairs.length,0);
});
test('missing tables, count mismatch, review gates and invalid rows keep previous imports protected',()=>{
  for (const mutate of [s=>s.source.data.tables.pop(),s=>s.runs.values().next().value.received_count=1,
    s=>s.runs.values().next().value.manifest.gates.push('SOURCE_ROW_COUNT_MISMATCH'),s=>s.source.data.tables[0].run.counts.invalid=1]) {
    const old=source(),next=source({seed:'next',at:'2026-10-01T12:00:00.000Z'});mutate(next);
    assert.equal(I.planSources([old.source,next.source],new Map([...old.runs,...next.runs])).pairs.length,0);
  }
});
function approvedCountSource() {
  const T = require('../lib/data-import-source-tolerance');
  const f = source({seed:'approved-count',at:'2026-10-01T12:00:00.000Z'}), table = f.source.data.tables[0];
  const run = f.runs.get(table.run.id), profile = definitions('trade')[0].profile;
  Object.assign(run.manifest,{expectedRows:1,declaredRows:2,gates:['SOURCE_ROW_COUNT_MISMATCH']});
  Object.assign(run,{received_count:1,revision:2});
  table.declaredRows=2;table.run.receivedRows=1;table.run.counts={applied:1};
  const proof=T.defineDataImportSourceTolerance({id:'synthetic-retention-count',recordedAt:'2026-10-01T12:01:00.000Z',
    approvalReference:'synthetic:approval',reason:'Synthetic exact source-count qualification',evidenceReference:'synthetic:row-counts',
    sourceSystem:profile.sourceSystem,sourceInstance:run.manifest.sourceInstance,sourceTable:profile.sourceTable,
    profileHash:profile.fingerprint,schemaSha256:profile.schemaSha256,fileSha256:f.source.data.fileSha256,declaredRows:2,expectedRows:1});
  run.sourceToleranceEvents=[{runId:run.id,actorId:run.owner_id,revision:2,at:'2026-10-01T12:01:00.000Z',
    action:'import.source-tolerance.accepted:'+proof.fingerprint}];
  return {...f,run,table,proof,options:{sourceTolerances:[proof]}};
}
test('an exact registered count approval qualifies a complete successor without rewriting the manifest',()=>{
  const old=source(),f=approvedCountSource(),manifest=JSON.stringify(f.run.manifest);
  assert.equal(I.completeSuccessor(f.source,f.runs,f.options),true);
  const plan=I.planSources([old.source,f.source],new Map([...old.runs,...f.runs]),f.options);
  assert.equal(plan.pairs.length,1);assert.equal(plan.pairs[0].sourceId,old.source.row.id);
  assert.equal(JSON.stringify(f.run.manifest),manifest);assert.deepEqual(f.run.manifest.gates,['SOURCE_ROW_COUNT_MISMATCH']);
});
test('count receipts never replace an exact trusted proof or bypass other import defects',()=>{
  const alterations=[
    f=>{f.options.sourceTolerances=[];},
    f=>{f.run.sourceToleranceEvents=[];},
    f=>{f.run.sourceToleranceEvents[0].action='import.source-tolerance.accepted:'+'0'.repeat(64);},
    f=>{f.run.sourceToleranceEvents[0].action='import.source-tolerance.accepted';},
    f=>{f.run.sourceToleranceEvents[0].runId='0'.repeat(64);},
    f=>{f.run.sourceToleranceEvents[0].actorId='different-account';},
    f=>{f.run.sourceToleranceEvents[0].revision=3;},
    f=>{f.run.sourceToleranceEvents.push({...f.run.sourceToleranceEvents[0],actorId:'different-account'});},
    f=>{f.run.sourceToleranceEvents.push({...f.run.sourceToleranceEvents[0],revision:3});},
    f=>{f.run.sourceToleranceEvents.push({...f.run.sourceToleranceEvents[0],action:'import.source-tolerance.accepted:malformed'});},
    f=>{f.run.manifest.fileSha256='0'.repeat(64);f.source.data.fileSha256='0'.repeat(64);},
    f=>{f.run.manifest.declaredRows=3;f.table.declaredRows=3;},
    f=>{f.run.manifest.gates.push('SOURCE_SCHEMA_MISMATCH');},
    f=>{f.table.run.counts.invalid=1;},
    f=>{f.table.run.counts.conflict=1;},
    f=>{f.table.run.counts.staged=1;},
    f=>{f.table.run.gates=['SOURCE_ROW_COUNT_MISMATCH'];},
    f=>{f.run.status='needs_review';},
    f=>{f.source.data.catalog.complete=false;},
  ];
  for(const alter of alterations){const f=approvedCountSource();alter(f);assert.equal(I.completeSuccessor(f.source,f.runs,f.options),false);}
  const f=approvedCountSource();f.options.sourceTolerances=[{...f.proof}];
  assert.throws(()=>I.completeSuccessor(f.source,f.runs,f.options),{code:'IMPORT_TOLERANCE_UNTRUSTED'});
});
test('native source readers authenticate the exact source context and logical database identity',()=>{
  const protection=createDataImportProtection({encryptionKey:Buffer.alloc(32,7),indexKey:Buffer.alloc(32,8),keyId:'synthetic'});
  try {
    const f=source();f.source.row.id=protection.digest(['source',{scopeId:f.source.row.scope_id,ownerId:f.source.row.owner_id},f.source.data.kind,f.source.data.fileSha256]);
    f.source.row.payload=protection.seal(f.source.data,I.context(f.source.row));assert.equal(I.authenticatedSource(f.source.row,protection).data.kind,'trade');
    assert.throws(()=>I.authenticatedSource({...f.source.row,owner_id:'different'},protection));
  } finally {protection.destroy();}
});

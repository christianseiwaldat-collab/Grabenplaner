'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {sealPairBundle,verifyPairBundle}=require('../lib/persistence/postgresql/operations/paired-bundle');
const {copyRecoveryFiles}=require('../lib/persistence/postgresql/operations/runtime');
const {prunePairedSnapshots,configuredPairedRetention}=require('../lib/persistence/postgresql/operations/paired-retention');
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-pair-test-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const bundle=path.join(root,'point.pair');fs.mkdirSync(bundle,{mode:0o700});
 for(const [name,value] of Object.entries({'core.dump':'synthetic core component','sales.dump':'synthetic sales component','roles.sql':'synthetic roles','configuration.env':'SYNTHETIC_KEY=not-a-real-secret'}))fs.writeFileSync(path.join(bundle,name),value,{mode:0o600});
 const result=await sealPairBundle(bundle,{databases:[{domain:'core',database:'test_core',file:'core.dump'},{domain:'sales',database:'test_sales',file:'sales.dump'}],checkpoint:{kind:'synthetic-component-contract'}});
 return {root,bundle,result};
}
test('recovery copies committed AMU and branding files but excludes volatile scanner probes',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-pair-copy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),target=path.join(root,'target');fs.mkdirSync(path.join(source,'private','amu','blobs'),{recursive:true});fs.mkdirSync(path.join(source,'private','amu','tmp'),{recursive:true});fs.mkdirSync(path.join(source,'branding-kits','kit'),{recursive:true});fs.mkdirSync(target);
 fs.writeFileSync(path.join(source,'private','amu','blobs','record.amu'),'committed');fs.writeFileSync(path.join(source,'private','amu','tmp','.scanner-probe-test.txt'),'temporary');fs.writeFileSync(path.join(source,'branding-kits','kit','manifest.json'),'{}');
 copyRecoveryFiles(source,target);
 assert.equal(fs.readFileSync(path.join(target,'private','amu','blobs','record.amu'),'utf8'),'committed');
 assert.equal(fs.readFileSync(path.join(target,'branding-kits','kit','manifest.json'),'utf8'),'{}');
 assert.equal(fs.existsSync(path.join(target,'private','amu','tmp')),false);
});
test('paired backup detects a changed database, missing keys and swapped marker',async t=>{
 const {bundle,result,root}=await fixture(t);assert.equal((await verifyPairBundle(bundle,result.commitMarker)).files,4);
 const sales=path.join(bundle,'sales.dump'),content=fs.readFileSync(sales);fs.appendFileSync(sales,'changed');
 await assert.rejects(verifyPairBundle(bundle,result.commitMarker),/PG_PAIR_COMPONENT_HASH/);fs.writeFileSync(sales,content);
 const config=path.join(bundle,'configuration.env'),configContent=fs.readFileSync(config);fs.unlinkSync(config);
 await assert.rejects(verifyPairBundle(bundle,result.commitMarker),/PG_PAIR_COMPONENT_HASH/);fs.writeFileSync(config,configContent);
 const marker=JSON.parse(fs.readFileSync(result.commitMarker,'utf8'));marker.snapshotId='different-checkpoint';fs.writeFileSync(result.commitMarker,JSON.stringify(marker));
 await assert.rejects(verifyPairBundle(bundle,result.commitMarker),/PG_PAIR_MANIFEST/);
 assert.equal(fs.existsSync(path.join(root,'point.pair.pending.complete.json')),false);
});
test('offsite stage v2 preserves both databases and rejects a component replacement',async t=>{
 const {root,bundle,result}=await fixture(t),stage=path.join(root,'stage'),backup=path.join(stage,'backup');fs.mkdirSync(backup,{recursive:true});
 fs.cpSync(bundle,path.join(backup,path.basename(bundle)),{recursive:true});fs.copyFileSync(result.commitMarker,path.join(backup,path.basename(result.commitMarker)));
 const resultFile=path.join(root,'result.json');fs.writeFileSync(resultFile,JSON.stringify(result));
 const run=(...args)=>spawnSync(process.execPath,[path.resolve(__dirname,'../server-tools/linux/offsite/lib/offsite-stage.js'),...args],{encoding:'utf8'});
 const created=run('create',stage,resultFile);assert.equal(created.status,0,created.stderr);
 const verified=run('verify',stage);assert.equal(verified.status,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).providerId,'postgresql-pair');
 assert.equal(run('verify-result',stage,resultFile).status,0);
 fs.appendFileSync(path.join(backup,path.basename(bundle),'sales.dump'),'from another checkpoint');assert.notEqual(run('verify',stage).status,0);
});
test('nightly pair retention preserves the most recent daily points and every unknown directory',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-pair-retention-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const results=[];
 for(const stamp of ['2026-09-10T10:00:00Z','2026-09-11T09:00:00Z','2026-09-11T15:00:00Z','2026-09-12T10:00:00Z']){
  const id=require('node:crypto').randomUUID(),directory=path.join(root,id+'.pair');fs.mkdirSync(directory,{mode:0o700});
  for(const name of ['core.dump','sales.dump','configuration.env','roles.sql'])fs.writeFileSync(path.join(directory,name),'synthetic component',{mode:0o600});
  results.push(await sealPairBundle(directory,{snapshotId:id,createdAt:stamp,databases:[{domain:'core',database:'core',file:'core.dump'},{domain:'sales',database:'sales',file:'sales.dump'}]}));
 }
 const unknown=path.join(root,'unknown-backup');fs.mkdirSync(unknown);fs.writeFileSync(path.join(unknown,'keep.txt'),'retain');
 const result=await prunePairedSnapshots(root,{keepDays:2,now:Date.parse('2026-09-12T12:00:00Z')});
 assert.equal(result.removed.length,2);assert.equal(fs.existsSync(results[2].bundle),true);assert.equal(fs.existsSync(results[3].bundle),true);assert.equal(fs.readFileSync(path.join(unknown,'keep.txt'),'utf8'),'retain');
});

async function countFixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-pair-count-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const results=[];
 for(const stamp of ['2026-09-12T08:00:00Z','2026-09-12T09:00:00Z','2026-09-12T10:00:00Z']){
  const id=require('node:crypto').randomUUID(),directory=path.join(root,id+'.pair');fs.mkdirSync(directory,{mode:0o700});
  for(const name of ['core.dump','sales.dump','configuration.env','roles.sql'])fs.writeFileSync(path.join(directory,name),'synthetic component',{mode:0o600});
  results.push(await sealPairBundle(directory,{snapshotId:id,createdAt:stamp,databases:[{domain:'core',database:'core',file:'core.dump'},{domain:'sales',database:'sales',file:'sales.dump'}]}));
 }
 return {root,results,now:Date.parse('2026-09-12T12:00:00Z')};
}

test('two total complete points survive even on the same day, including a failed next backup',async t=>{
 const {root,results,now}=await countFixture(t);
 const pending=path.join(root,require('node:crypto').randomUUID()+'.pair');fs.mkdirSync(pending,{mode:0o700});fs.writeFileSync(path.join(pending,'core.dump'),'incomplete');
 const result=await prunePairedSnapshots(root,{keepCount:2,now});
 assert.equal(result.policy,'latest-count');assert.equal(result.retainedPoints,2);assert.equal(result.retainedDays,1);
 assert.deepEqual(results.map(r=>fs.existsSync(r.bundle)),[false,true,true]);assert.ok(fs.existsSync(pending));
 const again=await prunePairedSnapshots(root,{keepCount:2,now});assert.equal(again.removed.length,0);assert.equal(again.retainedPoints,2);
});

test('a damaged newest or oldest point prevents every retention deletion',async t=>{
 for(const index of [0,2]){
  const {root,results,now}=await countFixture(t);fs.appendFileSync(path.join(results[index].bundle,'sales.dump'),'damaged');
  await assert.rejects(prunePairedSnapshots(root,{keepCount:2,now}),/PG_PAIR_COMPONENT_HASH/);
  assert.ok(results.every(r=>fs.existsSync(r.bundle)&&fs.existsSync(r.commitMarker)));
 }
});

test('a protected server count policy is explicit and fails closed on invalid values',()=>{
 assert.equal(configuredPairedRetention({}),null);
 assert.deepEqual(configuredPairedRetention({localBackupRetention:{keepCount:2}}),{keepCount:2});
 for(const policy of [null,[],{}, {keepCount:1},{keepCount:'2'},{keepCount:2,keepDays:20}])assert.throws(()=>configuredPairedRetention({localBackupRetention:policy}),/PG_PAIR_RETENTION_POLICY/);
});

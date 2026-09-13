'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {sealPairBundle,verifyPairBundle}=require('../lib/persistence/postgresql/operations/paired-bundle');
const {prunePairedSnapshots}=require('../lib/persistence/postgresql/operations/paired-retention');
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-pair-test-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const bundle=path.join(root,'point.pair');fs.mkdirSync(bundle,{mode:0o700});
 for(const [name,value] of Object.entries({'core.dump':'synthetic core component','sales.dump':'synthetic sales component','roles.sql':'synthetic roles','configuration.env':'SYNTHETIC_KEY=not-a-real-secret'}))fs.writeFileSync(path.join(bundle,name),value,{mode:0o600});
 const result=await sealPairBundle(bundle,{databases:[{domain:'core',database:'test_core',file:'core.dump'},{domain:'sales',database:'test_sales',file:'sales.dump'}],checkpoint:{kind:'synthetic-component-contract'}});
 return {root,bundle,result};
}
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

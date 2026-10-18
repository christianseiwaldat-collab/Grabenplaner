'use strict';
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const assert=require('node:assert/strict'), {createRequire}=require('node:module'), {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function checkPolicy(policy,{patchHash,installedHash,workspace,lock},now=new Date()){
  assert.equal(policy.schemaVersion,1);assert.equal(policy.package,'brace-expansion');assert.equal(policy.version,'5.0.12');
  assert.deepEqual(policy.advisoryExceptions,[]);assert.ok(policy.owner&&policy.reason&&policy.removalCondition);
  assert.match(policy.expiresOn,/^\d{4}-\d{2}-\d{2}$/);
  const expiry=new Date(policy.expiresOn+'T23:59:59Z'),review=new Date(policy.reviewedOn+'T00:00:00Z');
  assert.ok(Number.isFinite(+expiry)&&review<=now&&expiry>=now&&new Date(policy.expiresOn+'T00:00:00Z')-review<=30*86400000,'Expired or overbroad patch approval');
  assert.equal(patchHash,policy.patchSha256);assert.equal(installedHash,policy.installedCommonJsSha256);
  const ws=workspace.match(/patchedDependencies:\s*\n((?:[ \t]+[^\n]*\n?)*)/)?.[1]?.trim();
  assert.equal(ws,`${policy.package}@${policy.version}: ${policy.patch}`,'Unexpected patched dependency declaration');
  const lk=lock.match(/patchedDependencies:\s*\n((?:[ \t]+[^\n]*\n?)*)/)?.[1]?.trim();
  assert.equal(lk,`${policy.package}@${policy.version}: ${policy.patchSha256}`,'Unexpected patched lock entry');
}
function consumer(...packages){let parent=createRequire(path.join(root,'package.json'));for(const name of packages)parent=createRequire(parent.resolve(name));return parent;}
function verify(){
  const policy=JSON.parse(fs.readFileSync(path.join(__dirname,'patch-policy.json'),'utf8'));
  for(const chain of [['exceljs','archiver','archiver-utils','glob','minimatch'],['exceljs','archiver','readdir-glob','minimatch']]){
    const req=consumer(...chain),entry=req.resolve('brace-expansion');
    checkPolicy(policy,{patchHash:hash(path.join(root,policy.patch)),installedHash:hash(entry),workspace:fs.readFileSync(path.join(root,'pnpm-workspace.yaml'),'utf8'),lock:fs.readFileSync(path.join(root,'pnpm-lock.yaml'),'utf8')});
    const expand=req('brace-expansion');assert.equal(typeof expand,'function');assert.equal(expand.expand,expand);
    for(const key of ['EXPANSION_MAX','EXPANSION_MAX_LENGTH','EXPANSION_MAX_DEPTH','EXPANSION_MAX_REWRITES'])assert.ok(Number.isFinite(expand[key])&&expand[key]>0,key);
    assert.deepEqual(expand('file-{a,b}-{1..2}'),['file-a-1','file-a-2','file-b-1','file-b-2']);assert.equal(expand('{a,b,c}',{max:2}).length,2);
  }
  for(const scenario of ['brace-nesting','brace-comma','brace-rewrite']){
    const result=spawnSync(process.execPath,['--max-old-space-size=192',path.join(root,'test-support/security-audit/ops-dependency-remediation.probe.cjs'),scenario],{timeout:15000,encoding:'utf8'});
    assert.ifError(result.error);assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'completed');
  }
  console.log(JSON.stringify({passed:true,package:policy.package,version:policy.version,patchSha256:policy.patchSha256,expiresOn:policy.expiresOn,consumers:2,boundedSecurityRegressions:3,advisoryWaivers:0}));
}
module.exports={checkPolicy};
if(require.main===module)verify();

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const source=fs.readFileSync(path.resolve(__dirname,'../server-tools/linux/test-grabenplaner-server.sh'),'utf8');
const marker="const [readerPath, statusPath, deployChecks, qualifiedCore] = process.argv.slice(2);";
const start=source.indexOf(marker),end=source.indexOf('\nNODE',start);
assert.ok(start>=0&&end>start);
const program=source.slice(start,end);
function run(t,diagnostics,{deploy='1',core='0'}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-core-offsite-check-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const reader=path.join(root,'reader.cjs'),status=path.join(root,'status.json');
 fs.writeFileSync(reader,"exports.readOffsiteBackupStatus=({statusPath})=>JSON.parse(require('node:fs').readFileSync(statusPath,'utf8'));\n");
 const bytes=JSON.stringify(diagnostics);fs.writeFileSync(status,bytes);
 const result=spawnSync(process.execPath,['-',reader,status,deploy,core],{input:program,encoding:'utf8'});
 assert.equal(fs.readFileSync(status,'utf8'),bytes,'a deploy never clears or rewrites the failed nightly status');
 return result;
}
const failedNight={statusAvailable:true,blocksMainReadiness:false,state:'error',
 unresolvedFailures:{backup:true,fullCheck:false,restoreTest:false},
 agesHours:{backup:30,repositoryCheck:19,restoreTest:18}};
test('a target-qualified Core deploy accepts the existing signed external basis while preserving a failed full-nightly status',t=>{
 const result=run(t,failedNight,{core:'1'});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'qualified-core-plus');
});
test('a failed nightly backup still rejects a deploy without the verified Core alternative',t=>{
 const result=run(t,failedNight);assert.equal(result.status,1);assert.equal(result.stdout,'');
});
test('a nondeploy check cannot use the Core-deploy allowance',t=>{
 const result=run(t,failedNight,{deploy:'0',core:'1'});assert.equal(result.status,1);
});
for(const [name,change]of[
 ['unavailable status',d=>d.statusAvailable=false],
 ['main readiness blocked',d=>d.blocksMainReadiness=true],
])test('Core qualification does not bypass '+name,t=>{
 const status=structuredClone(failedNight);change(status);
 assert.equal(run(t,status,{core:'1'}).status,1);
});
test('the complete external-proof path remains available independently',t=>{
 const result=run(t,{...failedNight,state:'ok',unresolvedFailures:{backup:false,fullCheck:false,restoreTest:false}});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'complete');
});

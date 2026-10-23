'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process'),test=require('node:test');
const cli=path.resolve(__dirname,'../server-tools/linux/lib/postgresql-operations.js');
function run(t,action,{invalid=false,args=[]}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-pg-backup-policy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const trace=path.join(root,'trace.json'),preload=path.join(root,'controlled-runtime.cjs');
 fs.writeFileSync(preload,`'use strict';
const Module=require('node:module'),fs=require('node:fs'),path=require('node:path');
const original=Module._load,trace=[],config={backupDirectory:'/synthetic-no-files',localBackupRetention:{keepCount:2}};
const entry=${JSON.stringify(cli)};
Module._load=function(request,parent,isMain){
 const name=parent&&path.resolve(path.dirname(parent.filename),request);
 if(name===path.resolve(path.dirname(entry),'../../../lib/persistence/postgresql/operations/runtime'))return {
  loadConfiguration(file){trace.push(['load',file]);return config;},
  async createBackup(value){if(value!==config)throw Error('unexpected configuration');trace.push(['backup']);return {path:'synthetic-point',fresh:true};}};
 if(name===path.resolve(path.dirname(entry),'../../../lib/persistence/postgresql/operations/paired-retention'))return {
  configuredPairedRetention(value){if(value!==config)throw Error('unexpected configuration');trace.push(['policy']);if(${JSON.stringify(invalid)})throw Error('PG_PAIR_RETENTION_POLICY');return value.localBackupRetention;},
  async prunePairedSnapshots(directory,policy){trace.push(['prune',directory,policy]);return {removed:['prior-synthetic-point']};}};
 return original.call(this,request,parent,isMain);
};
process.on('exit',()=>fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify(trace)));
`);
 const result=spawnSync(process.execPath,['--require',preload,cli,action,'synthetic-config',...args],{encoding:'utf8',windowsHide:true,timeout:10000});
 return {...result,trace:JSON.parse(fs.readFileSync(trace,'utf8'))};
}
test('explicit PostgreSQL transition backup creates a fresh point without pruning existing points',t=>{
 const result=run(t,'backup-preserve');assert.equal(result.status,0,result.stderr);
 assert.deepEqual(result.trace,[['load','synthetic-config'],['policy'],['backup']]);
 assert.deepEqual(JSON.parse(result.stdout),{path:'synthetic-point',fresh:true,retention:{policy:'preserve-existing',removed:[]}});
});
test('ordinary PostgreSQL backups retain their configured pruning policy',t=>{
 const result=run(t,'backup');assert.equal(result.status,0,result.stderr);
 assert.deepEqual(result.trace,[['load','synthetic-config'],['policy'],['backup'],['prune','/synthetic-no-files',{keepCount:2}]]);
 assert.deepEqual(JSON.parse(result.stdout).retention,{removed:['prior-synthetic-point']});
});
test('preservation refuses invalid policy and unknown arguments before creating a point',t=>{
 const policy=run(t,'backup-preserve',{invalid:true});assert.equal(policy.status,1);assert.match(policy.stderr,/PG_PAIR_RETENTION_POLICY/);
 assert.deepEqual(policy.trace,[['load','synthetic-config'],['policy']]);
 const extra=run(t,'backup-preserve',{args:['unrecognized']});assert.equal(extra.status,1);assert.match(extra.stderr,/PG_OPERATIONS_ARGUMENTS/);
 assert.deepEqual(extra.trace,[['load','synthetic-config']]);
});

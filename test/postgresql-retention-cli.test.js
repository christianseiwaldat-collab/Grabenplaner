'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {configuredPairedRetention}=require('../lib/persistence/postgresql/operations/paired-retention');
const source=fs.readFileSync(path.join(__dirname,'../server-tools/linux/lib/postgresql-operations.js'),'utf8');
async function run(action,{policy={keepCount:2},backupFails=false,pruneFails=false}={}){
 const events=[],process={argv:['node','helper',action,'synthetic-config',...(action==='prune'?['20']:[])],stdout:{write(v){events.push(['output',JSON.parse(v)]);}},stderr:{write(v){events.push(['error',JSON.parse(v)]);}}};
 vm.runInNewContext(source,{process,require(name){
  if(name.endsWith('/runtime'))return {loadConfiguration(){return {backupDirectory:'synthetic',localBackupRetention:policy};},async createBackup(){events.push(['backup']);if(backupFails)throw new Error('PG_BACKUP_FAILED');return {ok:true,bundle:'new-complete-pair'};}};
  if(name.endsWith('/paired-monitor'))return {};
  if(name.endsWith('/paired-retention'))return {configuredPairedRetention,async prunePairedSnapshots(root,options){events.push(['prune',root,options]);if(pruneFails)throw new Error('PG_PAIR_COMPONENT_HASH');return {retainedPoints:2};}};
  throw new Error('Unexpected dependency');
 }});
 await new Promise(resolve=>setImmediate(resolve));return {events,exitCode:process.exitCode};
}
test('backup rotates under the caller lease only after a complete new pair',async()=>{
 const {events,exitCode}=await run('backup');assert.equal(exitCode,undefined);
 assert.deepEqual(events.map(e=>e[0]),['backup','prune','output']);assert.deepEqual(events[1][2],{keepCount:2});assert.equal(events[2][1].retention.retainedPoints,2);
});
test('failed backup and invalid policy cannot remove either existing pair',async()=>{
 for(const options of [{backupFails:true},{policy:{keepCount:1}}]){
  const {events,exitCode}=await run('backup',options);assert.equal(exitCode,1);assert.ok(events.every(e=>e[0]!=='prune'));
 }
});
test('nightly legacy day argument cannot override an explicit two-count server policy',async()=>{
 const {events}=await run('prune');assert.deepEqual(events[0],['prune','synthetic',{keepCount:2}]);
});
test('a failed integrity check is reported and cannot be claimed as backup success',async()=>{
 const {events,exitCode}=await run('backup',{pruneFails:true});assert.equal(exitCode,1);assert.ok(events.every(e=>e[0]!=='output'));assert.equal(events.at(-1)[1].error,'PG_PAIR_COMPONENT_HASH');
});

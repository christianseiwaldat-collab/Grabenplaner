'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {waitForRestoreTool}=require('../lib/persistence/postgresql/operations/paired-restore');
function child(){const c=new EventEmitter();c.signals=[];c.kill=signal=>{c.signals.push(signal);c.emit('close',0);};return c;}
function harness(c,{active=true,broken=false}={}){
 let clock=0;const reports=[];
 return {reports,watch:{now:()=>clock,pause:async ms=>{clock+=ms;if(clock>=45*60*1000)c.emit('close',0);},report:value=>reports.push(value),
  sample:()=>{if(broken)throw new Error('sensitive native detail');return {cpuUsec:active?clock*1000:0,ioBytes:0,sequence:0,phase:'native-tool'};}}};
}
test('large native pg_restore continues after 30 minutes while its isolated backend works',async()=>{
 const c=child(),h=harness(c);await waitForRestoreTool(c,{name:'pg_restore',commandNumber:5,watch:h.watch});
 assert.deepEqual(c.signals,[]);assert.ok(h.reports.some(r=>r.elapsedSeconds>30*60));
});
test('a stalled native restore terminates and a close code of zero cannot override the watchdog failure',async()=>{
 const c=child(),h=harness(c,{active:false});
 await assert.rejects(waitForRestoreTool(c,{name:'pg_restore',commandNumber:5,watch:h.watch}),{code:'PG_RECOVERY_STALLED'});
 assert.deepEqual(c.signals,['SIGTERM']);
});
test('unobservable native activity fails closed with no native details in the error',async()=>{
 const c=child(),h=harness(c,{broken:true});
 await assert.rejects(waitForRestoreTool(c,{name:'pg_restore',commandNumber:5,watch:h.watch}),{message:'PG_RECOVERY_ACTIVITY_UNAVAILABLE'});
 assert.deepEqual(c.signals,['SIGTERM']);
});
test('native tool start and nonzero completion errors retain strict verification',async()=>{
 const broken=child(),failed=waitForRestoreTool(broken,{name:'pg_restore',commandNumber:6});
 const refused=assert.rejects(failed,{message:'PG_PAIR_RESTORE_TOOL_START'});broken.emit('error',new Error('private native detail'));await refused;
 const c=child(),done=waitForRestoreTool(c,{name:'psql',commandNumber:3});
 const rejected=assert.rejects(done,{message:'PG_PAIR_RESTORE_TOOL_FAILED',tool:'psql',commandNumber:3});c.emit('close',1);await rejected;
});


test('restore disables autovacuum only in its disposable cluster before starting PostgreSQL',async()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
 const file=path.resolve(__dirname,'../lib/persistence/postgresql/operations/paired-restore.js'),source=fs.readFileSync(file,'utf8'),localRequire=createRequire(file);
 // Stop at the real orchestration's cluster-start boundary: no database or
 // native program runs, and every filesystem mutation is checked for scope.
 for(const privateApplicationNetwork of [false,true]){
  const workRoot='/synthetic/restore',socket='/tmp/gp-pg-recovery-synthetic',writes=[],started=new Error('synthetic cluster start boundary');
  const accounts=Object.fromEntries(['gp_migration_admin','gp_operations_monitor',...['core','sales'].flatMap(d=>['app','reader','migrator'].map(p=>'gp_'+d+'_'+p))].map(name=>[name,'x'.repeat(24)]));
  const config={format:'grabenplaner-postgresql-operations-v1',recoveryAccounts:accounts,domains:['core','sales'].map(domain=>({domain,database:'grabenplaner_'+domain}))};
  const verified={manifest:{files:[{file:'postgresql-operations.json',bytes:1024}],databases:config.domains,checkpoint:{domains:{core:{restore:{}},sales:{restore:{}}}}}};
  function scope(name){assert.ok(name.startsWith(workRoot+'/')||name===socket,'unexpected filesystem mutation: '+name);}
  const virtualFs={
   statSync:()=>({uid:500}),readdirSync:()=>[],statfsSync:()=>({bavail:20,bsize:1024**3}),
   mkdtempSync:prefix=>{assert.equal(prefix,'/tmp/gp-pg-recovery-');return socket;},chmodSync:scope,unlinkSync:scope,rmSync:scope,
   writeFileSync(name,text){scope(name);writes.push([name,text]);},appendFileSync(name,text){scope(name);writes.push([name,text]);},
   readFileSync:name=>{assert.equal(name,'/synthetic/bundle/postgresql-operations.json');return JSON.stringify(config);},
   lstatSync:()=>({uid:0,mode:0o755,isFile:()=>true}),realpathSync:name=>name,openSync:name=>{scope(name);return 3;},closeSync(){},
  };
  const mocks={
   'node:fs':virtualFs,'node:path':path.posix,'node:os':{networkInterfaces:()=>({lo:[{internal:true}]})},
   './paired-bundle':{safeRoot:root=>assert.equal(root,workRoot),verifyPairBundle:async()=>verified},
   '../../../../server-tools/linux/recovery/lib/postgresql-recovery-activity':{childCompletion:()=>Promise.resolve({code:0}),monitorActivity:({completion})=>completion},
   'node:child_process':{spawn(binary,args){
    if(binary.endsWith('/initdb'))return {once(){}};
    assert.ok(binary.endsWith('/pg_ctl'));assert.equal(args.at(-1),'start');
    const configText=writes.filter(([name])=>name===workRoot+'/data/postgresql.conf').map(([,text])=>text).join('');
    assert.match(configText,/^autovacuum=off$/m);assert.equal((configText.match(/^autovacuum=/gm)||[]).length,1);
    assert.match(configText,/^max_connections=20$/m);
    throw started;
   }},
  };
  const context={module:{exports:{}},process:{platform:'linux',getuid:()=>500},performance,require:name=>Object.hasOwn(mocks,name)?mocks[name]:localRequire(name)};
  vm.runInNewContext(source,context,{filename:file});
  await assert.rejects(context.module.exports.restorePair({bundle:'/synthetic/bundle',commitMarker:'/synthetic/marker',workRoot,privateApplicationNetwork}),error=>error===started);
 }
});

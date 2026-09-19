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

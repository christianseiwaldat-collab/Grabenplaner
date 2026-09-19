'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {monitorActivity,terminateAndConfirm}=require('../server-tools/linux/recovery/lib/postgresql-recovery-activity');

function simulation(){
 let milliseconds=0,ticks=0,resolve,reject;
 const completion=new Promise((yes,no)=>{resolve=yes;reject=no;});
 const reports=[],terminations=[];
 return {
  now:()=>milliseconds,
  pause:async duration=>{milliseconds+=duration;if(++ticks>1000)throw new Error('simulated watchdog exceeded bounded test horizon');},
  completion,resolve,reject,reports,terminations,
  report:value=>reports.push(value),terminate:async reason=>{terminations.push(reason);},
 };
}
function snapshot(overrides={}){return {cpuUsec:0,ioBytes:0,sequence:0,phase:'restore-core',...overrides};}

for(const kind of ['cpu','io','phase']){
 test('active '+kind+' restoration continues beyond 30 minutes and returns its completion',async()=>{
  const clock=simulation();let samples=0;
  const result=await monitorActivity({...clock,sample:async()=>{
   samples++;
   if(samples===168)clock.resolve({code:0,verified:true});
   return snapshot({cpuUsec:kind==='cpu'?samples*200000:0,ioBytes:kind==='io'?samples*131072:0,sequence:kind==='phase'?samples:0});
  }});
  assert.deepEqual(result,{code:0,verified:true});
  assert.ok(clock.now()>42*60*1000,'the completion is beyond both former 30-minute limits');
  assert.deepEqual(clock.terminations,[]);
  assert.ok(clock.reports.some(report=>report.elapsedSeconds>1800));
  assert.ok(clock.reports.every(report=>report.observable&&report.idleSeconds===0));
  assert.deepEqual(Object.keys(clock.reports[0]).sort(),['elapsedSeconds','idleSeconds','observable','phase']);
 });
}

test('genuinely unchanged activity is terminated within one polling interval of the idle lease',async()=>{
 const clock=simulation();
 await assert.rejects(monitorActivity({...clock,sample:async()=>snapshot()}),{code:'PG_RECOVERY_STALLED'});
 assert.deepEqual(clock.terminations,['PG_RECOVERY_STALLED']);
 assert.equal(clock.now(),10*60*1000+15000);
 assert.equal(clock.reports.at(-1).phase,'restore-core');
 assert.equal(clock.reports.at(-1).observable,true);
});

test('small watchdog accounting increases cannot perpetually renew an otherwise idle restore',async()=>{
 const clock=simulation();let samples=0;
 await assert.rejects(monitorActivity({...clock,sample:async()=>snapshot({cpuUsec:++samples*1000,ioBytes:samples*4096})}),{code:'PG_RECOVERY_STALLED'});
 assert.deepEqual(clock.terminations,['PG_RECOVERY_STALLED']);
 assert.equal(clock.now(),10*60*1000+15000);
});

test('unavailable monitoring terminates after its observation grace and redacts sample failures',async()=>{
 const clock=simulation();
 await assert.rejects(monitorActivity({...clock,sample:async()=>{throw new Error('sensitive source path or database error');}}),{code:'PG_RECOVERY_ACTIVITY_UNAVAILABLE'});
 assert.deepEqual(clock.terminations,['PG_RECOVERY_ACTIVITY_UNAVAILABLE']);
 assert.equal(clock.now(),75000);
 assert.deepEqual(clock.reports,[{phase:'starting',elapsedSeconds:60,idleSeconds:60,observable:false}]);
 assert.doesNotMatch(JSON.stringify(clock.reports),/sensitive|database|path/);
});

test('a short observation outage can recover without discarding the running restore',async()=>{
 const clock=simulation();let samples=0;
 const result=await monitorActivity({...clock,sample:async()=>{
  samples++;
  if(samples>=3&&samples<=5)throw new Error('temporary accounting outage');
  if(samples===12)clock.resolve('complete');
  return snapshot({cpuUsec:samples*200000});
 }});
 assert.equal(result,'complete');assert.deepEqual(clock.terminations,[]);
 assert.ok(clock.reports.some(value=>!value.observable));
 assert.equal(clock.reports.at(-1).observable,true);
});

test('reset activity counters are treated as lost monitoring rather than fresh progress',async()=>{
 const clock=simulation();let samples=0;
 await assert.rejects(monitorActivity({...clock,sample:async()=>snapshot({cpuUsec:++samples===1?200000:1})}),{code:'PG_RECOVERY_ACTIVITY_UNAVAILABLE'});
 assert.deepEqual(clock.terminations,['PG_RECOVERY_ACTIVITY_UNAVAILABLE']);
 assert.equal(clock.now(),90000);
});

test('normal completion and worker start failure preserve the completion contract',async()=>{
 const success=simulation();success.resolve({code:1,signal:null});
 assert.deepEqual(await monitorActivity({...success,sample:async()=>{throw new Error('sample should not run');}}),{code:1,signal:null});
 assert.deepEqual(success.terminations,[]);
 const failure=simulation();const reason=Object.assign(new Error('PG_RECOVERY_WORKER_START'),{code:'PG_RECOVERY_WORKER_START'});
 failure.reject(reason);
 await assert.rejects(monitorActivity({...failure,sample:async()=>snapshot()}),error=>error===reason);
 assert.deepEqual(failure.terminations,[]);
});

test('already stopped process group requires no signals',async()=>{
 const clock=simulation(),signals=[];
 assert.deepEqual(await terminateAndConfirm({...clock,signal:async value=>signals.push(value),isStopped:async()=>true}),{confirmed:true,escalated:false});
 assert.deepEqual(signals,[]);assert.equal(clock.now(),0);
});

test('graceful termination waits for explicit stopped confirmation',async()=>{
 const clock=simulation(),signals=[];
 const result=await terminateAndConfirm({...clock,signal:async value=>signals.push({value,at:clock.now()}),isStopped:async()=>clock.now()>=3000});
 assert.deepEqual(result,{confirmed:true,escalated:false});
 assert.deepEqual(signals,[{value:'SIGTERM',at:0}]);assert.equal(clock.now(),3000);
});

test('unresponsive group escalates to SIGKILL after the TERM grace, then confirms stopped',async()=>{
 const clock=simulation(),signals=[];let stopped=false;
 const result=await terminateAndConfirm({...clock,signal:async value=>{signals.push({value,at:clock.now()});if(value==='SIGKILL')stopped=true;},isStopped:async()=>stopped});
 assert.deepEqual(result,{confirmed:true,escalated:true});
 assert.deepEqual(signals,[{value:'SIGTERM',at:0},{value:'SIGKILL',at:30000}]);
});

test('neither a signal failure nor an unreadable group is accepted as stopped',async()=>{
 const clock=simulation(),signals=[];
 await assert.rejects(terminateAndConfirm({...clock,signal:async value=>{signals.push({value,at:clock.now()});throw new Error('signal failed');},isStopped:async()=>{throw new Error('cannot read cgroup');}}),{code:'PG_RECOVERY_STOP_UNCONFIRMED'});
 assert.deepEqual(signals,[{value:'SIGTERM',at:0},{value:'SIGKILL',at:30000}]);
 assert.equal(clock.now(),45000);
});

test('a still populated group cannot report success after SIGKILL',async()=>{
 const clock=simulation(),signals=[];
 await assert.rejects(terminateAndConfirm({...clock,signal:async value=>signals.push(value),isStopped:async()=>false}),{code:'PG_RECOVERY_STOP_UNCONFIRMED'});
 assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(clock.now(),45000);
});

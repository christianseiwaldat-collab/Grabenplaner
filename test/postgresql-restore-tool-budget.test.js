'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {waitForRestoreTool}=require('../lib/persistence/postgresql/operations/paired-restore');
function child(){const c=new EventEmitter();c.signals=[];c.kill=signal=>c.signals.push(signal);return c;}
test('large paired restore can complete after the former 15-minute child limit',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const c=child(),done=waitForRestoreTool(c,{name:'pg_restore',commandNumber:5});
 t.mock.timers.tick(29*60*1000);assert.deepEqual(c.signals,[]);
 c.emit('close',0);await done;t.mock.timers.tick(2*60*1000);assert.deepEqual(c.signals,[]);
});
test('hung paired restore is terminated at 30 minutes and cannot report success',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const c=child(),done=waitForRestoreTool(c,{name:'pg_restore',commandNumber:5});
 t.mock.timers.tick(30*60*1000);assert.deepEqual(c.signals,['SIGTERM']);
 const rejected=assert.rejects(done,{message:'PG_PAIR_RESTORE_TOOL_FAILED',tool:'pg_restore',commandNumber:5});
 c.emit('close',0);await rejected;
});
test('other recovery tools retain their existing limit and start errors clear the timer',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const c=child(),done=waitForRestoreTool(c,{name:'psql',commandNumber:3});
 t.mock.timers.tick(15*60*1000);assert.deepEqual(c.signals,['SIGTERM']);
 const rejected=assert.rejects(done,{message:'PG_PAIR_RESTORE_TOOL_FAILED'});c.emit('close',1);await rejected;
 const broken=child(),failed=waitForRestoreTool(broken,{name:'pg_restore',commandNumber:6});
 const refused=assert.rejects(failed,{message:'PG_PAIR_RESTORE_TOOL_START'});broken.emit('error',new Error('private native detail'));await refused;
 t.mock.timers.tick(31*60*1000);assert.deepEqual(broken.signals,[]);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {finishWorkspace,unitController,cancellation}=require('../server-tools/linux/recovery/lib/postgresql-recovery-control');

function workspace(t){
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gp-recovery-cleanup-test-')));
 const root=path.join(base,crypto.randomUUID()),neighbor=path.join(base,crypto.randomUUID());
 fs.mkdirSync(root);fs.mkdirSync(neighbor);
 fs.writeFileSync(path.join(root,'postmaster.pid'),'stale process identifier');
 fs.writeFileSync(path.join(root,'disposable.dump'),'synthetic restore scratch');
 fs.writeFileSync(path.join(neighbor,'keep.dump'),'neighbor must survive');
 const identity=fs.statSync(root),receipt=path.join(base,path.basename(root)+'.run.json');
 t.after(()=>{
  assert.ok(base.startsWith(fs.realpathSync(os.tmpdir())+path.sep));
  for(const entry of fs.readdirSync(base))if(entry.endsWith('.run.json'))fs.chmodSync(path.join(base,entry),0o600);
  fs.rmSync(base,{recursive:true,force:true});
 });
 return {base,root,neighbor,identity,receipt,seal:false};
}

test('confirmed stopped restoration deletes only its own scratch, including stale postmaster.pid',async t=>{
 const fixture=workspace(t);let stopped=false;
 const outcome=await finishWorkspace({...fixture,code:'ok',stop:async()=>{assert.equal(fs.existsSync(fixture.root),true);stopped=true;}});
 assert.equal(stopped,true);assert.equal(outcome.stopped,true);assert.equal(outcome.cleaned,true);assert.equal(outcome.code,'ok');
 assert.equal(fs.existsSync(fixture.root),false);
 assert.equal(fs.readFileSync(path.join(fixture.neighbor,'keep.dump'),'utf8'),'neighbor must survive');
 const receipt=fs.readFileSync(fixture.receipt,'utf8');
 assert.ok(Buffer.byteLength(receipt)<1024);
 assert.deepEqual(JSON.parse(receipt),outcome);
 assert.doesNotMatch(receipt,/stale process|synthetic restore|disposable|keep\.dump/);
});

test('failed restoration still cleans confirmed stopped scratch and keeps a redacted diagnostic',async t=>{
 const fixture=workspace(t);
 const outcome=await finishWorkspace({...fixture,code:'raw private database or path message',stop:async()=>{}});
 assert.equal(outcome.code,'PG_RECOVERY_FAILED');assert.equal(outcome.cleaned,true);
 assert.equal(fs.existsSync(fixture.root),false);
 assert.doesNotMatch(fs.readFileSync(fixture.receipt,'utf8'),/raw private|database|path message/);
});

test('unconfirmed group termination retains scratch and writes the failure diagnostic',async t=>{
 const fixture=workspace(t),error=Object.assign(new Error('PG_RECOVERY_STOP_UNCONFIRMED'),{code:'PG_RECOVERY_STOP_UNCONFIRMED'});
 await assert.rejects(finishWorkspace({...fixture,code:'PG_RECOVERY_STALLED',stop:async()=>{throw error;}}),value=>value===error);
 assert.equal(fs.existsSync(path.join(fixture.root,'disposable.dump')),true);
 const receipt=JSON.parse(fs.readFileSync(fixture.receipt,'utf8'));
 assert.equal(receipt.stopped,false);assert.equal(receipt.cleaned,false);assert.equal(receipt.code,'PG_RECOVERY_STALLED');
 assert.equal(receipt.cleanupCode,'PG_RECOVERY_STOP_UNCONFIRMED');
 assert.equal(fs.readFileSync(path.join(fixture.neighbor,'keep.dump'),'utf8'),'neighbor must survive');
});

test('replacement workspace identity is never recursively deleted',async t=>{
 const fixture=workspace(t);
 await assert.rejects(finishWorkspace({...fixture,identity:{dev:fixture.identity.dev,ino:fixture.identity.ino===0?1:0},code:'ok',stop:async()=>{}}),{code:'PG_RECOVERY_CLEANUP_GUARD'});
 assert.equal(fs.existsSync(path.join(fixture.root,'postmaster.pid')),true);
 const receipt=JSON.parse(fs.readFileSync(fixture.receipt,'utf8'));
 assert.equal(receipt.stopped,true);assert.equal(receipt.cleaned,false);
 assert.equal(receipt.cleanupCode,'PG_RECOVERY_CLEANUP_GUARD');
});

test('diagnostic retains only safe activity projection and redacts failed-stop details',async t=>{
 const fixture=workspace(t),error=new Error('private connection details');
 const progress={phase:'restore-core',elapsedSeconds:2520,idleSeconds:17,observable:true,source:'/private/database/dump',sql:'private SQL text'};
 await assert.rejects(finishWorkspace({...fixture,code:'PG_RECOVERY_STALLED',progress,stop:async()=>{throw error;}}),value=>value===error);
 const receipt=JSON.parse(fs.readFileSync(fixture.receipt,'utf8'));
 assert.equal(receipt.phase,'restore-core');assert.equal(receipt.elapsedSeconds,2520);assert.equal(receipt.idleSeconds,17);assert.equal(receipt.observable,true);
 assert.equal(receipt.cleanupCode,'PG_RECOVERY_CLEANUP_FAILED');
 assert.doesNotMatch(JSON.stringify(receipt),/private|connection|source|SQL/);
 assert.equal(fs.existsSync(path.join(fixture.root,'disposable.dump')),true);
});

test('invalid phase and accounting values are omitted from the persisted diagnostic',async t=>{
 const fixture=workspace(t);
 const outcome=await finishWorkspace({...fixture,code:'ok',progress:{phase:'invalid /private/path',elapsedSeconds:Infinity,idleSeconds:-1,observable:'yes'},stop:async()=>{}});
 for(const key of ['phase','elapsedSeconds','idleSeconds','observable'])assert.equal(Object.hasOwn(outcome,key),false);
 assert.doesNotMatch(fs.readFileSync(fixture.receipt,'utf8'),/private|Infinity/);
});

test('a non-UUID path cannot be used as disposable recovery scratch',async t=>{
 const fixture=workspace(t),invalid=path.join(fixture.base,'live-data');
 fs.mkdirSync(invalid);fs.writeFileSync(path.join(invalid,'keep'),'unchanged');
 await assert.rejects(finishWorkspace({...fixture,root:invalid,identity:fs.statSync(invalid),code:'ok',stop:async()=>{}}),{code:'PG_RECOVERY_CLEANUP_GUARD'});
 assert.equal(fs.readFileSync(path.join(invalid,'keep'),'utf8'),'unchanged');
 assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.base,'live-data.run.json'),'utf8')).cleaned,false);
});

test('a nested UUID directory outside the immediate recovery base cannot be deleted',async t=>{
 const fixture=workspace(t),nested=path.join(fixture.neighbor,crypto.randomUUID());
 fs.mkdirSync(nested);fs.writeFileSync(path.join(nested,'keep'),'unchanged');
 await assert.rejects(finishWorkspace({...fixture,root:nested,identity:fs.statSync(nested),code:'ok',stop:async()=>{}}),{code:'PG_RECOVERY_CLEANUP_GUARD'});
 assert.equal(fs.readFileSync(path.join(nested,'keep'),'utf8'),'unchanged');
 assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.base,path.basename(nested)+'.run.json'),'utf8')).cleaned,false);
});

function controller({active='inactive',load='loaded',group,events='populated 0\nfrozen 0\n',closed=true,missing=false,result}={}){
 const unit='grabenplaner-pg-recovery-099b476b-e49d-4937-908c-8ce7eab2c95f',expected='/system.slice/'+unit+'.service',calls=[],reads=[];
 const value=unitController({unit,root:'/synthetic/recovery',uid:123,launcherClosed:()=>closed,
  run(executable,args,options){calls.push({executable,args,options});return result||{status:0,stdout:'LoadState='+load+'\nActiveState='+active+'\nControlGroup='+(group===undefined?expected:group)+'\n'};},
  read(file,encoding){reads.push(file);assert.equal(file,'/sys/fs/cgroup'+expected+'/cgroup.events');assert.equal(encoding,'utf8');if(missing)throw Object.assign(new Error('missing'),{code:'ENOENT'});return events;},
 });
 return {value,calls,reads,unit};
}

test('stopped confirmation requires inactive exact unit, empty cgroup, and closed launcher',()=>{
 for(const active of ['inactive','failed']){
  const fixture=controller({active});assert.equal(fixture.value.isStopped(),true);
  assert.equal(fixture.calls.length,1);assert.equal(fixture.reads.length,1);
  const call=fixture.calls[0];assert.equal(call.executable,'/usr/bin/systemctl');
  assert.deepEqual(call.args,['show',fixture.unit+'.service','--property=LoadState','--property=ActiveState','--property=ControlGroup']);
  assert.equal(call.options.timeout,5000);assert.deepEqual(call.options.env,{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'});
 }
 assert.equal(controller({closed:false}).value.isStopped(),false);
 assert.equal(controller({active:'active'}).value.isStopped(),false);
 assert.equal(controller({events:'populated 1\nfrozen 0\n'}).value.isStopped(),false);
});

test('collected unit and absent cgroup are accepted only after launcher exit',()=>{
 assert.equal(controller({load:'not-found',group:'',missing:true}).value.isStopped(),true);
 assert.equal(controller({load:'not-found',group:'',missing:true,closed:false}).value.isStopped(),false);
 assert.equal(controller({load:'not-found',group:'',missing:true,active:'activating'}).value.isStopped(),false);
});

test('a mismatched cgroup binding is rejected before inspecting or signalling that group',()=>{
 const fixture=controller({group:'/system.slice/grabenplaner.service'});
 assert.throws(()=>fixture.value.isStopped(),{code:'PG_RECOVERY_UNIT_BINDING'});
 assert.deepEqual(fixture.reads,[]);assert.equal(fixture.calls.length,1);assert.equal(fixture.calls[0].args[0],'show');
});

test('unknown cgroup state and unsuccessful systemctl observation fail closed',()=>{
 assert.throws(()=>controller({events:'frozen 0\n'}).value.isStopped(),{code:'PG_RECOVERY_CGROUP_EVENTS'});
 assert.throws(()=>controller({events:'populated 2\n'}).value.isStopped(),{code:'PG_RECOVERY_CGROUP_EVENTS'});
 assert.throws(()=>controller({result:{status:2,stdout:''}}).value.isStopped(),{code:'PG_RECOVERY_UNIT_OBSERVATION'});
 assert.throws(()=>controller({result:{status:0,error:new Error('spawn unavailable')}}).value.isStopped(),{code:'PG_RECOVERY_UNIT_OBSERVATION'});
});

test('unit name cannot select a production service or an extra command argument',()=>{
 for(const unit of ['grabenplaner','grabenplaner.service','--all','grabenplaner-pg-recovery-../production']){
  assert.throws(()=>unitController({unit,run(){assert.fail('no system command is permitted');}}),{code:'PG_RECOVERY_UNIT'});
 }
});

for(const signal of ['SIGTERM','SIGINT']){
 test(signal+' pending before a checkpoint rejects before more recovery work starts',async t=>{
  const emitter=new EventEmitter(),guard=cancellation(emitter);t.after(()=>guard.dispose());
  emitter.emit(signal);
  await assert.rejects(guard.promise,{code:'PG_RECOVERY_INTERRUPTED'});
  assert.throws(()=>guard.throwIfCancelled(),{code:'PG_RECOVERY_INTERRUPTED'});
  await assert.rejects(guard.checkpoint(),{code:'PG_RECOVERY_INTERRUPTED'});
 });
}

test('checkpoint yields to pending signal delivery before continuing',async t=>{
 const emitter=new EventEmitter(),guard=cancellation(emitter);t.after(()=>guard.dispose());
 setImmediate(()=>emitter.emit('SIGTERM'));
 await assert.rejects(guard.checkpoint(),{code:'PG_RECOVERY_INTERRUPTED'});
 await assert.rejects(guard.promise,{code:'PG_RECOVERY_INTERRUPTED'});
});

test('disposing cancellation removes only its own handlers',async()=>{
 const emitter=new EventEmitter();let otherTerm=0,otherInt=0;
 emitter.on('SIGTERM',()=>otherTerm++);emitter.on('SIGINT',()=>otherInt++);
 const guard=cancellation(emitter);
 assert.equal(emitter.listenerCount('SIGTERM'),2);assert.equal(emitter.listenerCount('SIGINT'),2);
 await guard.checkpoint();guard.throwIfCancelled();guard.dispose();guard.dispose();
 assert.equal(emitter.listenerCount('SIGTERM'),1);assert.equal(emitter.listenerCount('SIGINT'),1);
 emitter.emit('SIGTERM');emitter.emit('SIGINT');guard.throwIfCancelled();
 assert.equal(otherTerm,1);assert.equal(otherInt,1);
});

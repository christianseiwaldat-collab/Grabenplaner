'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const V=require('../lib/data-import-af-verifier'),C=require('../lib/data-import-contract');
test('exact final Linux asset descriptor validates without executing Linux bytes; malformed classpaths/manifests fail closed',()=>{
 const d=JSON.parse(fs.readFileSync(path.join(__dirname,'../test-support/fixtures/known-af-verifier-runtime-descriptor.json'),'utf8'));
 assert.equal(V.validateAssetDescriptor(d),d);assert.equal(C.fingerprint(d.files),d.completeTreeSha256);
 const mutations=[x=>x.helperClassesRoot='helper/classes:/tmp/unpinned',x=>x.jars[0].path='jars/../external.jar',x=>x.javaPath='/usr/bin/java',
  x=>x.files[0].mode=0o777,x=>x.files.push({...x.files[0]}),x=>x.completeTreeSha256='0'.repeat(64),x=>x.classFiles.pop(),
  x=>x.jars.reverse(),x=>x.executableAllowlist[0].sha256='0'.repeat(64),x=>x.unknown=true,x=>x.helperMainClass='Other',x=>x.platform.libc='unknown'];
 for(const mutation of mutations){const bad=structuredClone(d);mutation(bad);assert.throws(()=>V.validateAssetDescriptor(bad));}
 const defaults=require('../lib/data-import-af-verifier-policy');assert.equal(defaults.runtime.descriptorSha256,'5730aa3a7269b2283cbe879cb52123d42a238606cd5840ec3f8108e4ba523d93');
 assert.equal(defaults.acceptedVerifierAssets[0].descriptorSha256,defaults.runtime.descriptorSha256);assert.equal(defaults.acceptedVerifierAssets[0].completeTreeSha256,d.completeTreeSha256);
});
function fakeProcess(mode,controller){
 let observed,stopped=false,closed=false,writes=0,activeWrites=0,maxWrites=0,bytes=0,kills=0;
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new EventEmitter();child.exitCode=null;child.signalCode=null;
 const close=(code,sig=null)=>{if(closed)return;closed=true;stopped=true;child.exitCode=code;child.signalCode=sig;setImmediate(()=>child.emit('close',code,sig));};
 child.kill=()=>{kills++;close(null,'SIGKILL');return true;};
 child.stdin.write=(chunk,cb)=>{writes++;activeWrites++;maxWrites=Math.max(maxWrites,activeWrites);bytes+=chunk.length;setImmediate(()=>{
   activeWrites--;if(mode==='stdin-error'){child.stdin.emit('error',new Error('synthetic input failure'));cb(new Error('synthetic input failure'));}else cb();});return false;};
 child.stdin.end=()=>{if(stopped)return;setImmediate(()=>{
  if(mode==='stdout-error')child.stdout.emit('error',new Error('synthetic stdout failure'));
  else if(mode==='stderr-error')child.stderr.emit('error',new Error('synthetic stderr failure'));
  else if(mode==='output-limit')child.stdout.write(Buffer.alloc(65537));
  else if(mode==='abort')controller.abort();
  else{child.stdout.end(Buffer.from('{"technical":true}'));child.stderr.end();close(mode==='nonzero'?7:0);}
 });};
 const spawnImpl=(file,args,options)=>{observed={file,args,options};if(mode==='spawn-error')queueMicrotask(()=>{child.emit('error',new Error('synthetic spawn failure'));close(-1);});return child;};
 return {spawnImpl,get observed(){return observed;},get state(){return {closed,writes,maxWrites,bytes,kills};}};
}
const assets={root:'/synthetic-pinned-root',java:'/synthetic-pinned-root/jre/bin/java',classpath:'/synthetic-pinned-root/helper/classes:/synthetic-pinned-root/jars/known.jar'};
test('default process adapter serializes writes, uses fixed isolated argv/env and waits for successful close',async()=>{
 const controller=new AbortController(),f=fakeProcess('success',controller),buffer=Buffer.alloc(2*1024*1024+1);
 const reply=await V.runKnownAfVerifierProcess({assets,buffer,request:{bytes:buffer.length,fileSha256:'a'.repeat(64)},signal:controller.signal,spawnImpl:f.spawnImpl});
 assert.equal(reply.exitCode,0);assert.equal(reply.stderr.length,0);assert.equal(reply.stdout.toString(),'{"technical":true}');
 assert.deepEqual(f.state,{closed:true,writes:3,maxWrites:1,bytes:buffer.length,kills:0});
 assert.equal(f.observed.file,'/usr/bin/python3');assert.equal(f.observed.options.shell,false);assert.equal(f.observed.options.detached,true);
 assert.deepEqual(Object.keys(f.observed.options.env).sort(),['LANG','LC_ALL','PATH','TZ']);assert(f.observed.args.includes('-XX:-HeapDumpOnOutOfMemoryError'));assert(f.observed.args.includes('-XX:-UsePerfData'));
 assert(f.observed.args.some(arg=>arg.includes('RLIMIT_CORE')));assert(f.observed.args.includes('KnownAfCountVerifier'));
});
test('default process adapter contains stdout/stderr/stdin/spawn errors, abort and output overflow until child closes',async t=>{
 for(const mode of ['stdout-error','stderr-error','stdin-error','spawn-error','abort','output-limit'])await t.test(mode,async()=>{
  const controller=new AbortController(),f=fakeProcess(mode,controller),buffer=Buffer.alloc(4096);
  await assert.rejects(V.runKnownAfVerifierProcess({assets,buffer,request:{bytes:4096,fileSha256:'a'.repeat(64)},signal:controller.signal,spawnImpl:f.spawnImpl}),e=>e instanceof C.DataImportError&&/^IMPORT_/.test(e.code));
  assert.equal(f.state.closed,true);if(mode!=='spawn-error')assert(f.state.kills>0);
 });
});

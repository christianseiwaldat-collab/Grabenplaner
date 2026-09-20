'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {install,classify,frames}=require('../test-support/recovery-timeout-observer');
test('preload leaves the restore workspace empty, including its initial ready event',()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const root='/var/lib/grabenplaner-offsite/postgresql-recovery/11111111-1111-4111-8111-111111111111',written=[];
 const source=fs.readFileSync(path.join(__dirname,'../test-support/recovery-timeout-preload.js'),'utf8');
 const context={__dirname:root+'/candidate/test-support',process:{getuid:()=>993,pid:1},require(name){
  if(name==='node:fs')return {realpathSync:p=>p,appendFileSync(file,text,options){written.push({file,event:JSON.parse(text),mode:options.mode});}};
  if(name==='node:path')return path.posix;
  if(name==='node:os')return {networkInterfaces:()=>({lo:[{internal:true}]})};
  if(name==='node:worker_threads')return {threadId:0};
  if(name==='./recovery-timeout-observer')return {install({emit}){emit({event:'synthetic-error'});}};
  if(name==='pg'||name==='../lib/persistence/errors')return {};
  throw new Error('Unexpected import');
 }};
 vm.runInNewContext(source,context);
 assert.equal(written.length,2);
 for(const event of written){assert.equal(event.file,root+'/timeout-observer.jsonl');assert.equal(event.mode,0o600);assert.equal(event.file.startsWith(root+'/work/'),false);}
 assert.equal(written.at(-1).event.event,'observer-ready');
});
for(const [error,kind] of [
 [{code:'57014',message:'canceling statement due to statement timeout'},'statement-timeout'],
 [{message:'Query read timeout'},'driver-query-timeout'],
 [{message:'timeout exceeded when trying to connect'},'connection-timeout'],
 [{code:'57014',message:'canceling statement due to user request'},'query-cancelled'],
 [{code:'PERSISTENCE_TIMEOUT'},'provider-timeout'],
 [{code:'PRIVATE_SECRET',message:'PRIVATE_SECRET'},'database-error'],
])test('recovery observer distinguishes '+kind,()=>{
 const value=classify(error);assert.equal(value.kind,kind);assert.doesNotMatch(JSON.stringify(value),/PRIVATE_SECRET|message/);
});
function fixture(mode){
 const reason=Object.assign(new Error('Query read timeout'),{detail:'SECRET'}),events=[];
 class Client{constructor(){this.connectionParameters={query_timeout:12000,password:'SECRET'};}
  query(...args){if(mode==='callback'){args.at(-1)(reason);return undefined;}return Promise.reject(reason);}}
 class Pool{connect(){return Promise.resolve('connected');}}
 const errors={PersistenceError:require('../lib/persistence/errors').PersistenceError};
 install({pg:{Client,Pool},errors,emit:event=>events.push(event),root:path.resolve(__dirname,'..')});
 return {reason,events,Client,Pool,errors};
}
test('observer preserves the original rejected query and omits SQL and credentials',async()=>{
 const f=fixture();await assert.rejects(new f.Client().query('SELECT SECRET'),error=>error===f.reason);
 assert.equal(f.events[0].kind,'driver-query-timeout');assert.equal(f.events[0].limits.query_timeout,12000);
 assert.match(f.events[0].statementSha256,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(f.events),/SECRET|password|detail/);
 assert.equal(await new f.Pool().connect(),'connected');
});
test('observer preserves callback semantics and frozen persistence errors',()=>{
 const f=fixture('callback');let received;
 assert.equal(new f.Client().query('SELECT SECRET',error=>{received=error;}),undefined);assert.equal(received,f.reason);
 const error=new f.errors.PersistenceError('PERSISTENCE_TIMEOUT',{operation:'transaction'});
 assert.equal(Object.isFrozen(error),true);assert.equal(require('../lib/persistence/errors').isPersistenceError(error),true);
 assert.equal(f.events.at(-1).event,'provider-timeout');assert.equal(error.code,'PERSISTENCE_TIMEOUT');
});
test('observer failures cannot replace database results',async()=>{
 class Client{query(){return Promise.reject(new Error('original'));}}class Pool{connect(){return Promise.resolve(1);}}
 install({pg:{Client,Pool},errors:{PersistenceError:require('../lib/persistence/errors').PersistenceError},root:__dirname,emit(){throw new Error('observer failed');}});
 await assert.rejects(new Client().query('SELECT 1'),{message:'original'});
});
test('stack projection keeps only source locations without raw messages or external paths',()=>{
 const root=path.resolve(__dirname,'..');
 assert.deepEqual(frames('SECRET\n    at fn ('+path.join(root,'lib/persistence/postgresql/provider.js')+':640:20)\n    at /private/SECRET.js:1:2',root),[{file:'lib/persistence/postgresql/provider.js',line:640,column:20}]);
});
test('real provider acquisition timeout is recorded at its timer source before normalization',async()=>{
 const errors=require('../lib/persistence/errors'),Original=errors.PersistenceError,events=[];
 class Client{query(){return Promise.resolve({rows:[]});}}class Pool{connect(){return new Promise(()=>{});}}
 install({pg:{Client,Pool},errors,emit:event=>events.push(event),root:path.resolve(__dirname,'..')});
 try{
  const {createPostgresqlPersistenceProvider}=require('../lib/persistence/postgresql/provider');
  const provider=createPostgresqlPersistenceProvider({pool:{connect:()=>new Promise(()=>{}),end:async()=>{}},acquireTimeoutMilliseconds:100});
  await assert.rejects(provider.transaction(async()=>{}, {readOnly:true}),{code:'PERSISTENCE_TIMEOUT'});
  assert.equal(events.length,1);assert.equal(events[0].event,'provider-timeout');
  const locations=events[0].frames.filter(frame=>frame.file==='lib/persistence/postgresql/provider.js');
  assert.ok(locations.length>=2);assert.ok(locations.some(frame=>frame.line>600));
  await provider.close();
 }finally{errors.PersistenceError=Original;}
});

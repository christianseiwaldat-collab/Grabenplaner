'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const B=require('../lib/persistence/postgresql/operations/backup-budget');
const {createPairedSnapshot}=require('../lib/persistence/postgresql/operations/paired-backup');
const {sealPairBundle,digest}=require('../lib/persistence/postgresql/operations/paired-bundle');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function root(t){const value=fs.mkdtempSync(path.join(os.tmpdir(),'gp-backup-budget-'));fs.chmodSync(value,0o700);t.after(()=>fs.rmSync(value,{recursive:true,force:true}));return value;}
function fixture(t,budget){
 const directory=root(t),clients=[],events=[];
 const domains=['core','sales'].map(domain=>{
  const c=new EventEmitter();c.queries=[];c.release=e=>{events.push('release-'+domain);c.releaseError=e;};
  c.query=async sql=>{c.queries.push(sql);events.push(domain+':'+sql);return {rows:sql.includes('pg_database_size')?[{bytes:'1048576'}]:sql.includes('current_database')?[{name:domain}]:sql.includes('pg_tables')?[{schemaname:'gp',tablename:'example'}]:sql.includes('pg_export_snapshot')?[{id:'123-AB'}]:[]};};
  clients.push(c);return {domain,database:domain,ownerRole:'gp_'+domain+'_owner',pool:{connect:async()=>c}};
 });
 const options={backupDirectory:directory,domains,budget,withQuiescedWrites:work=>work({active:true,pendingMutations:0}),
  readCheckpoint:async()=>({synthetic:true}),runDump:async({targetFile})=>fs.writeFileSync(targetFile,'fixture',{mode:0o600}),
  captureRecoveryFiles:async({directory})=>{for(const n of ['configuration.env','roles.sql'])fs.writeFileSync(path.join(directory,n),'fixture',{mode:0o600});}};
 return {directory,clients,events,options};
}
test('a monotonic operation budget clamps tools and statements and cannot become unbounded',()=>{
 let now=0;const b=B.createBackupBudget({now:()=>now});
 assert.equal(b.toolMilliseconds(),20*60000);assert.equal(b.statementMilliseconds(),5*60000);now=21*60000;
 assert.equal(b.toolMilliseconds(),60000);assert.equal(b.statementMilliseconds(),60000);now=22*60000;
 assert.throws(()=>b.remaining(),{code:'PG_BACKUP_OPERATION_TIMEOUT'});
 for(const milliseconds of [0,-1,Infinity,NaN,'100',B.OPERATION_MS+1])assert.throws(()=>B.createBackupBudget({milliseconds}),{code:'PG_BACKUP_BUDGET_INVALID'});
});
test('both snapshots retain bounded idle budgets across the full serial pair while checkpoint queries use remaining time',async t=>{
 let now=0;const b=B.createBackupBudget({now:()=>now}),f=fixture(t,b);
 f.options.readCheckpoint=async({domain,client})=>{if(domain==='sales')now=21*60000;await client.query('SELECT synthetic_checkpoint');return {synthetic:true};};
 const value=await createPairedSnapshot(f.options);assert.ok(fs.existsSync(value.commitMarker));
 for(const c of f.clients){assert.ok(c.queries.some(s=>s.includes("idle_in_transaction_session_timeout='1500000ms'")));assert.ok(c.queries.some(s=>s.includes("lock_timeout='5s'")));assert.ok(c.queries.includes('COMMIT'));}
 assert.ok(f.clients[1].queries.includes("SET LOCAL statement_timeout='60000ms'"));
});
test('an expired full-pair deadline rolls both owned snapshots back without a complete marker',async t=>{
 let now=0;const b=B.createBackupBudget({now:()=>now,milliseconds:1000}),f=fixture(t,b);
 const dump=f.options.runDump;f.options.runDump=async x=>{await dump(x);if(x.domain==='sales')now=1001;};
 await assert.rejects(createPairedSnapshot(f.options),{code:'PG_BACKUP_OPERATION_TIMEOUT'});
 for(const c of f.clients){assert.ok(c.queries.includes('ROLLBACK'));assert.ok(!c.queries.includes('COMMIT'));}
 assert.equal(fs.readdirSync(f.directory).some(n=>n.endsWith('.complete.json')),false);
});
test('tool timeout waits for actual close before snapshot rollback, then terminates only the owned child',async t=>{
 const f=fixture(t,B.createBackupBudget()),child=new EventEmitter();child.pid=123;let closed=false,kills=[];
 child.kill=signal=>{kills.push(signal);if(signal==='SIGKILL')setTimeout(()=>{closed=true;f.events.push('tool-closed');child.emit('close',null);},10);};
 f.options.runDump=()=>B.runBackupTool('/synthetic/pg_dump',[],{timeoutMs:10,terminationMs:10,spawnImpl:()=>child});
 const work=createPairedSnapshot(f.options);work.catch(()=>{});await delay(16);
 assert.equal(closed,false);assert.equal(f.events.some(e=>e.endsWith(':ROLLBACK')),false);
 await assert.rejects(work,{code:'PG_OPERATIONS_TOOL_TIMEOUT'});assert.deepEqual(kills,['SIGTERM','SIGKILL']);
 for(const domain of ['core','sales'])assert.ok(f.events.indexOf('tool-closed')<f.events.indexOf(domain+':ROLLBACK'));
});
test('a lost snapshot connection never seals or retries the half pair',async t=>{
 const f=fixture(t,B.createBackupBudget());f.options.runDump=async()=>f.clients[0].emit('error',new Error('synthetic loss'));
 await assert.rejects(createPairedSnapshot(f.options),{code:'PG_PAIR_CONNECTION_LOST'});
 assert.ok(f.clients[0].releaseError);assert.equal(fs.readdirSync(f.directory).some(n=>n.endsWith('.complete.json')),false);
});
test('hashing checks the deadline inside large components and before the complete marker is published',async t=>{
 const directory=root(t),file=path.join(directory,'large.dump');fs.writeFileSync(file,Buffer.alloc(3*1024*1024));let calls=0;
 await assert.rejects(digest(file,{checkBudget(){if(++calls===3)throw Object.assign(new Error('expired'),{code:'PG_BACKUP_OPERATION_TIMEOUT'});}}),{code:'PG_BACKUP_OPERATION_TIMEOUT'});
 const bundle=path.join(directory,'snapshot.pair');fs.mkdirSync(bundle,{mode:0o700});for(const n of ['core.dump','sales.dump','roles.sql','configuration.env'])fs.writeFileSync(path.join(bundle,n),'fixture',{mode:0o600});
 const options={databases:['core','sales'].map(domain=>({domain,database:domain,file:domain+'.dump'})),checkpoint:{synthetic:true}};
 let checks=0;await sealPairBundle(bundle,{...options,checkBudget(){checks++;}});
 const late=path.join(directory,'late.pair');fs.mkdirSync(late,{mode:0o700});for(const n of ['core.dump','sales.dump','roles.sql','configuration.env'])fs.writeFileSync(path.join(late,n),'fixture',{mode:0o600});
 let seen=0;
 await assert.rejects(sealPairBundle(late,{...options,checkBudget(){if(++seen===checks)throw Object.assign(new Error('expired'),{code:'PG_BACKUP_OPERATION_TIMEOUT'});}}),{code:'PG_BACKUP_OPERATION_TIMEOUT'});
 assert.equal(seen,checks);assert.equal(fs.existsSync(late+'.pending.complete.json'),true);assert.equal(fs.existsSync(late+'.complete.json'),false);
});
test('long but bounded lifecycle operations retain ownership and recovery eligibility',()=>{
 const now=Date.now(),value={state:'preparing',requestId:'synthetic',acceptedAt:new Date(now-24*60000).toISOString()};
 assert.equal(B.lifecycleRequestCurrent(value,now),true);
 assert.equal(B.lifecycleRequestCurrent({...value,acceptedAt:new Date(now-B.LIFECYCLE_REQUEST_MS).toISOString()},now),false);
 assert.equal(B.lifecycleRequestCurrent({...value,acceptedAt:new Date(now+1).toISOString()},now),false);
 assert.equal(B.lifecycleRequestCurrent({...value,requestId:null},now),false);
 const status=fs.readFileSync(path.join(__dirname,'../server-tools/linux/postgresql/lifecycle-status.js'),'utf8');
 assert.ok(B.OPERATION_MS+B.TERMINATION_MS<B.LIFECYCLE_REQUEST_MS,'the bounded backup itself fits the original ownership window; outer lease and service waits are separate');
 assert.match(status,/age > 1800000/,'recovery window remains unchanged');assert.match(status,/age > 1500000/,'completed-point freshness remains separate from request duration');
});
test('native start failures never expose child errors and successful tools clear their timers',async()=>{
 await assert.rejects(B.runBackupTool('/fixture',[],{timeoutMs:10,spawnImpl(){throw new Error('private detail');}}),{code:'PG_OPERATIONS_TOOL_START'});
 const child=new EventEmitter();child.kill=()=>assert.fail('completed tool must not be killed');
 const work=B.runBackupTool('/fixture',[],{timeoutMs:10,spawnImpl:()=>child});queueMicrotask(()=>child.emit('close',0));await work;await delay(20);
});

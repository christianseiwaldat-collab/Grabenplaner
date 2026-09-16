'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {readPairedDatabaseStatus,connectionStateReasons,evaluatePairedStatus,IDLE_TRANSACTION_WARNING_SECONDS}=require('../lib/persistence/postgresql/operations/paired-monitor');
const healthy={total:4,active:1,idleInTransaction:2,idleInTransactionOverLimit:0,abortedInTransaction:0,blocked:0};

test('ordinary pauses between transaction statements do not make a live database unhealthy',()=>{
 assert.deepEqual(connectionStateReasons(healthy),[]);
 assert.deepEqual(connectionStateReasons({...healthy,idleInTransaction:0}),[]);
});

test('persistent idle transactions, aborted transactions and lock waits remain independently visible',()=>{
 assert.deepEqual(connectionStateReasons({...healthy,idleInTransactionOverLimit:1}),['IDLE_TRANSACTION']);
 assert.deepEqual(connectionStateReasons({...healthy,abortedInTransaction:1}),['ABORTED_TRANSACTION']);
 assert.deepEqual(connectionStateReasons({...healthy,blocked:1}),['LOCK_WAIT']);
 assert.deepEqual(connectionStateReasons({...healthy,idleInTransactionOverLimit:1,abortedInTransaction:1,blocked:1}),['LOCK_WAIT','IDLE_TRANSACTION','ABORTED_TRANSACTION']);
});

test('missing, malformed or inconsistent monitoring counters fail closed',()=>{
 for(const bad of [null,{}, {...healthy,idleInTransactionOverLimit:undefined}, {...healthy,blocked:-1}, {...healthy,blocked:NaN}, {...healthy,abortedInTransaction:'0'}, {...healthy,total:1}, {...healthy,idleInTransactionOverLimit:3}, {...healthy,idleInTransactionOverLimit:2,abortedInTransaction:1}]){
  assert.deepEqual(connectionStateReasons(bad),['CONNECTION_COUNTS_INVALID']);
 }
});

test('live monitor measures time in the idle state and preserves transaction cleanup',async()=>{
 assert.equal(IDLE_TRANSACTION_WARNING_SECONDS,5);
 const queries=[];let released=false;
 const row={database:'core',role:'monitor',dedicated_identity:true,privileged:false,monitor_role:true,read_only:'on',connections:healthy};
 const client={query:async sql=>{queries.push(sql);return {rows:[row]};},release(){released=true;}};
 assert.equal(await readPairedDatabaseStatus({pool:{connect:async()=>client},database:'core',role:'monitor'}),row);
 const sql=queries.find(q=>q.includes('pg_stat_activity'));
 assert.match(sql,/clock_timestamp\(\)-state_change>=interval '5 seconds'/);
 assert.match(sql,/state_change IS NULL/);
 assert.match(sql,/state='idle in transaction \(aborted\)'/);
 assert.doesNotMatch(sql,/xact_start|pg_terminate_backend|pg_cancel_backend/);
 assert.equal(queries[0],'BEGIN READ ONLY');assert.equal(queries.at(-1),'COMMIT');assert.equal(released,true);
});

test('monitor identity failures still roll back and release the connection',async()=>{
 const queries=[];let released=false;
 const client={query:async sql=>{queries.push(sql);return {rows:[{database:'other'}]};},release(){released=true;}};
 await assert.rejects(readPairedDatabaseStatus({pool:{connect:async()=>client},database:'core',role:'monitor'}),/PG_PAIR_MONITOR_IDENTITY/);
 assert.equal(queries.at(-1),'ROLLBACK');assert.equal(released,true);
});

test('paired status reports prolonged and aborted transactions without downgrading backup checks',()=>{
 const now=Date.now(),record={verified:true,checkedAt:new Date(now).toISOString(),manifestSha256:'a'.repeat(64),sourceManifestSha256:'a'.repeat(64)};
 const base={cluster_id:'123',in_recovery:false,connections:healthy};
 const options={core:{...base,database:'core'},sales:{...base,database:'sales'},backup:record,restore:record,offsite:record,freeBytes:20*1024**3,now};
 assert.equal(evaluatePairedStatus(options).healthy,true);
 const result=evaluatePairedStatus({...options,sales:{...options.sales,connections:{...healthy,idleInTransactionOverLimit:1,abortedInTransaction:1}},restore:null});
 assert.deepEqual(result.reasons,['SALES_IDLE_TRANSACTION','SALES_ABORTED_TRANSACTION','PAIRED_RESTORE_MISSING_OR_STALE']);
});

test('the actual operations CLI accepts ordinary pauses and rejects every unhealthy pair state',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../server-tools/linux/lib/postgresql-operations.js'),'utf8');
 const base=()=>({core:{cluster_id:'123',in_recovery:false,connections:{...healthy}},sales:{cluster_id:'123',in_recovery:false,connections:{...healthy}}});
 for(const scenario of ['healthy','long-idle','aborted','blocked','unknown-count','wrong-cluster','both-wrong-cluster','recovering','missing-domain','monitor-failed']){
  const states=base();
  if(scenario==='long-idle')states.sales.connections.idleInTransactionOverLimit=1;
  if(scenario==='aborted')states.core.connections.abortedInTransaction=1;
  if(scenario==='blocked')states.sales.connections.blocked=1;
  if(scenario==='unknown-count')delete states.sales.connections.idleInTransactionOverLimit;
  if(scenario==='wrong-cluster')states.sales.cluster_id='456';
  if(scenario==='both-wrong-cluster')states.core.cluster_id=states.sales.cluster_id='456';
  if(scenario==='recovering')states.sales.in_recovery=true;
  if(scenario==='missing-domain')delete states.core;
  let stdout='',stderr='';
  const processStub={argv:['node','operations','connection-health','config'],stdout:{write:text=>stdout+=text},stderr:{write:text=>stderr+=text}};
  await vm.runInNewContext(source,{process:processStub,require(name){
   if(name.endsWith('/runtime'))return {loadConfiguration:()=>({clusterId:'123'}),monitor:async()=>{if(scenario==='monitor-failed')throw new Error('PG_PROBE_FAILED');return states;}};
   if(name.endsWith('/paired-monitor'))return {connectionStateReasons};
   if(name.endsWith('/paired-retention'))return {
    configuredPairedRetention:()=>assert.fail('A connection probe must not select a retention policy'),
    prunePairedSnapshots:()=>assert.fail('A connection probe must not prune backups'),
   };
   throw new Error('Unexpected module '+name);
  }});
  if(scenario==='healthy'){assert.deepEqual(JSON.parse(stdout),{verified:true});assert.equal(stderr,'');assert.equal(processStub.exitCode,undefined);}
  else{assert.equal(stdout,'',scenario);assert.equal(processStub.exitCode,1,scenario);assert.equal(JSON.parse(stderr).failed,true,scenario);}
 }
});

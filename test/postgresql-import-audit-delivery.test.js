'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Module}=require('node:module');
const {createPersistenceProviderFacade}=require('../lib/persistence/contract');
const {POSTGRESQL_CAPABILITIES}=require('../lib/persistence/postgresql/provider');
const {DATA_IMPORT_RUNTIME_STATEMENTS:R}=require('../lib/persistence/statements/data-import-runtime');
const {DATA_IMPORT_STATEMENTS:I}=require('../lib/persistence/statements/data-import');
const {IMPORT_HISTORY_STATEMENTS:H}=require('../lib/persistence/statements/import-history');
const {PERSONAL_ACTION_LOG_STATEMENTS:PA}=require('../lib/persistence/statements/personal-action-log');
const {SALES_ARTICLE_CATALOG_STATEMENTS:A}=require('../lib/persistence/statements/sales-article-catalog');
const {B}=require('../lib/persistence/postgresql/boundary/catalog');
const receipts=require('../lib/persistence/postgresql/boundary/personal-actions');
const policy=require('../lib/persistence/postgresql/boundary/import-audit-delivery-policy');
const TIME='2026-11-11T08:00:00.000Z';
const runHeader=()=>({id:crypto.randomBytes(32).toString('hex'),scopeId:'synthetic-audit-delivery',ownerId:'synthetic-owner',attemptId:'synthetic',
  profileHash:'a'.repeat(64),profile:{},manifest:{},status:'staging',revision:1,receivedCount:0,createdAt:TIME,updatedAt:TIME,expiresAt:'2026-12-11T08:00:00.000Z'});
const runCheckpoint=(value,revision=1)=>({id:value.id,revision,status:'staging',receivedCount:0,updatedAt:TIME});
const audit=()=>({actor:'synthetic-owner',action:'synthetic.import-test',entityType:'synthetic',entityId:'synthetic-import',detail:{},timestamp:TIME});

async function mockedBoundary(){
  const state={allowed:true,scans:0,runWrites:0,commits:0,rollbacks:0,failAppend:0,outbox:[],delivered:new Set(),inbox:new Map(),personal:[],authorizations:[]};
  function query(domain,statement,parameters){
    if(statement===B.pendingAudits){state.scans++;return state.outbox.filter(row=>!state.delivered.has(row.event_id)).slice(0,parameters.limit).map(data=>({data}));}
    if(statement===B.getAuditReceipt){const row=state.inbox.get(parameters.id);return row?[row]:[];}
    if(statement===receipts.auditById){const data=state.outbox.find(row=>row.id===parameters.id);return data?[{data}]:[];}
    if(statement.id.startsWith('database-transaction-activity.'))return[{alive:1}];
    return[];
  }
  function execute(domain,statement,parameters){
    if(statement===A.insertAudit){
      const id=state.outbox.length+1;
      state.outbox.push({id,event_id:'synthetic-event-'+id,actor:parameters.actor,action:parameters.action,entity_type:parameters.entityType,
        entity_id:parameters.entityId,detail:JSON.stringify(parameters.detail),created_at:parameters.timestamp});
      return{rowsAffected:1,returnedRows:[{id}]};
    }
    if(statement===B.appendAudit){if(state.failAppend>0){state.failAppend--;throw Error('synthetic-core-audit-unavailable');}return{rowsAffected:1,returnedRows:[{id:state.inbox.size+1}]};}
    if(statement===B.ackAudit)state.inbox.set(parameters.id,{sha:parameters.sha,auditId:parameters.auditId});
    if(statement===B.deliveredAudit)state.delivered.add(parameters.id);
    if(statement===PA.insert)state.personal.push(parameters);
    if(statement===I.updateRun||statement===I.insertRun)state.runWrites++;
    return{rowsAffected:1,returnedRows:[]};
  }
  function provider(domain){return createPersistenceProviderFacade({providerId:'postgresql',capabilities:POSTGRESQL_CAPABILITIES,
    query:async(s,p)=>query(domain,s,p),execute:async(s,p)=>execute(domain,s,p),close:async()=>{},
    async beginTransaction(){
      const snapshot={outbox:state.outbox.length,delivered:new Set(state.delivered),inbox:new Map(state.inbox),personal:state.personal.length,runWrites:state.runWrites};
      return{query:async(s,p)=>query(domain,s,p),execute:async(s,p)=>execute(domain,s,p),
        commit:async()=>{state.commits++;},rollback:async()=>{state.rollbacks++;state.outbox.length=snapshot.outbox;state.delivered=snapshot.delivered;state.inbox=snapshot.inbox;state.personal.length=snapshot.personal;state.runWrites=snapshot.runWrites;}};
    }});}
  const core=provider('core'),sales=provider('sales');
  const filename=path.resolve(__dirname,'../lib/persistence/postgresql/boundary/application.js');
  const subject=new Module(filename,module);subject.filename=filename;subject.paths=Module._nodeModulePaths(path.dirname(filename));
  const realRequire=subject.require.bind(subject);
  subject.require=id=>id==='pg'?{Pool:class{on(){}async end(){}async connect(){return{on(){},release(){},query:async()=>({rows:[]})};}}}
    :id==='../core/environment'?{PROFILE:'synthetic-only',configuration:()=>({}),verifyEnvironment:async()=>{}}
    :id==='../core/application'?{openCoreDevelopmentApplication:async()=>({provider:core,close:()=>core.close()})}
    :id==='../sales/application'?{openSalesDevelopmentApplication:async()=>({provider:sales,close:()=>sales.close()})}
    :realRequire(id);
  subject._compile(fs.readFileSync(filename,'utf8'),filename);
  const app=await subject.exports.openTwoDatabaseDevelopmentApplication({coreUrl:'synthetic-core',salesUrl:'synthetic-sales',stage:8,autoDeliver:true,
    authorize:async input=>{state.authorizations.push(input);return state.allowed;}});
  return{state,app};
}

test('audit-free import writes are exact qualified staging statements with no outbox-writing targets or triggers',()=>{
  const {salesSourceEntries,compileSalesEntry}=require('../lib/persistence/postgresql/sales/catalog');
  const entries=new Map([...salesSourceEntries(8).map(entry=>compileSalesEntry(entry,8).providerEntry),
    ...require('../lib/persistence/postgresql/sales/import-recheck-catalog').IMPORT_RECHECK_CATALOG,
    ...require('../lib/persistence/postgresql/sales/import-batches').IMPORT_BATCH_CATALOG].map(entry=>[entry.statement,entry]));
  const tables=new Set();
  assert.equal(new Set(policy.IMPORT_WRITES_WITHOUT_AUDIT).size,policy.IMPORT_WRITES_WITHOUT_AUDIT.length);
  assert.ok(Object.isFrozen(policy.IMPORT_WRITES_WITHOUT_AUDIT));
  for(const statement of policy.IMPORT_WRITES_WITHOUT_AUDIT){
    assert.equal(statement.operation,'execute');assert.equal(policy.importWriteWithoutAudit(statement),true);
    assert.equal(policy.importWriteWithoutAudit({...statement}),false);
    const entry=entries.get(statement);assert.ok(entry,statement.id+' must be installed in the qualified Sales catalog');
    const target=/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+integration\s*\.\s*"?(data_import_[a-z_]+)"?/i.exec(entry.sql);
    assert.ok(target,statement.id+' must write only a reviewed technical import table');tables.add(target[1]);
    assert.doesNotMatch(entry.sql,/core_audit_outbox|audit_log|\bCALL\b/i);
  }
  const triggers=require('../lib/persistence/postgresql/sales/layout').source.objects.filter(object=>object.type==='trigger'&&tables.has(object.table_name));
  assert.ok(triggers.length>0);
  for(const trigger of triggers)assert.doesNotMatch(trigger.sql,/core_audit_outbox|audit_log/i,trigger.name);
  assert.equal(policy.importWriteWithoutAudit(A.insertAudit),false);
  assert.equal(policy.importWriteWithoutAudit(PA.insert),false);
  assert.equal(policy.importWriteWithoutAudit(H.advanceEpoch),false);
  assert.equal(policy.importWriteWithoutAudit(R.updateSource),false,'Core-owned run checkpoints need no Sales delivery exemption');
  assert.equal(policy.importWriteWithoutAudit({id:'data-import-runtime.source.update',operation:'execute'}),false);
});

test('startup audit delivery remains mandatory while exact run checkpoints avoid repeated empty outbox scans',async()=>{
  const {state,app}=await mockedBoundary(),value=runHeader();
  try{
    await app.provider.execute(I.insertRun,value);assert.equal(state.scans,1);
    for(let revision=1;revision<=20;revision++)await app.provider.execute(I.updateRun,runCheckpoint(value,revision));
    assert.equal(state.scans,1);assert.equal(state.runWrites,21);
    await app.provider.execute(H.advanceEpoch,{scopeId:value.scopeId,token:'synthetic-conservative-write'});
    assert.equal(state.scans,2,'an unclassified but registered Sales write remains conservative');
    assert.ok(state.authorizations.length>=22);assert.ok(state.authorizations.every(input=>input.statementIds.length>0));
  }finally{await app.close();}
});

test('mixed technical checkpoints and actual audit producers still deliver exactly once',async()=>{
  const {state,app}=await mockedBoundary(),value=runHeader();
  try{
    await app.provider.execute(I.insertRun,value);
    await app.provider.transaction(async tx=>{await tx.execute(I.updateRun,runCheckpoint(value));await tx.execute(A.insertAudit,audit());});
    assert.equal(state.scans,2);assert.equal(state.outbox.length,1);assert.equal(state.inbox.size,1);assert.equal(state.delivered.size,1);
    await app.provider.execute(I.updateRun,runCheckpoint(value,2));
    assert.equal(state.scans,2);assert.equal((await app.deliverAudits()).delivered,0);
  }finally{await app.close();}
});

test('the special personal receipt branch remains an audit producer after only an audit-free Sales write',async()=>{
  const {state,app}=await mockedBoundary(),value=runHeader();
  try{
    await app.provider.execute(A.insertAudit,audit());assert.equal(state.delivered.size,1);
    const receipt={id:crypto.randomUUID(),actorKind:'employee',actorId:'synthetic-owner',actionType:'synthetic.import-test',entityType:'synthetic',
      entityId:'synthetic-import',scope:'synthetic',summary:'Synthetic import audit receipt',compensatorKey:null,undoPayload:null,
      resultRevision:null,resultFingerprint:null,sourceAuditId:1,undoExpiresAt:null,compensatesActionId:null,createdAt:TIME};
    await app.provider.transaction(async tx=>{await tx.execute(I.updateRun,runCheckpoint(value));await tx.execute(PA.insert,receipt);});
    assert.equal(state.outbox.length,2);assert.equal(state.delivered.size,2);assert.equal(state.personal.length,1);
    assert.equal(state.personal[0].id,receipt.id);assert.equal(state.personal[0].sourceAuditId,1);
  }finally{await app.close();}
});

test('rollback and revoked commit authorization preserve run state and never schedule a new delivery',async()=>{
  const {state,app}=await mockedBoundary(),value=runHeader();
  try{
    await app.provider.execute(I.insertRun,value);const before={scans:state.scans,writes:state.runWrites};
    await assert.rejects(app.provider.transaction(async tx=>{await tx.execute(I.updateRun,runCheckpoint(value));await tx.execute(A.insertAudit,audit());throw Error('synthetic-rollback');}),/synthetic-rollback/);
    assert.equal(state.scans,before.scans);assert.equal(state.runWrites,before.writes);assert.equal(state.outbox.length,0);
    await assert.rejects(app.provider.transaction(async tx=>{await tx.execute(I.updateRun,runCheckpoint(value));state.allowed=false;}));
    assert.equal(state.runWrites,before.writes);assert.equal(state.scans,before.scans);assert.ok(state.rollbacks>=2);
  }finally{await app.close();}
});

test('a failed producer delivery retries before the next audit-free checkpoint can execute',async()=>{
  const {state,app}=await mockedBoundary(),value=runHeader();
  try{
    await app.provider.execute(I.insertRun,value);state.failAppend=2;
    await app.provider.execute(A.insertAudit,audit());
    assert.equal(state.outbox.length,1);assert.equal(state.delivered.size,0);
    const writes=state.runWrites;
    await assert.rejects(app.provider.execute(I.updateRun,runCheckpoint(value)));
    assert.equal(state.runWrites,writes,'pending audit failure blocks the new run mutation');
    await app.provider.execute(I.updateRun,runCheckpoint(value));
    assert.equal(state.delivered.size,1);assert.equal(state.inbox.size,1);assert.equal(state.runWrites,writes+1);
  }finally{await app.close();}
});

const live={skip:process.env.GP_PG_MIGRATION_LIVE!=='1'};
async function nativeFixture(work){
  const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture');
  const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
  const {openTwoDatabaseDevelopmentApplication}=require('../lib/persistence/postgresql/boundary/application');
  return withCoreFixture(core=>withSalesFixture(8,async sales=>{
    const app=await openTwoDatabaseDevelopmentApplication({coreUrl:process.env.GP_CORE_APP_URL,salesUrl:process.env.GP_SALES_APP_URL,stage:8,authorize:async()=>true,autoDeliver:true});
    try{return await work({core,sales,app});}finally{await app.close();}
  }));
}

test('Live exact import checkpoints preserve CAS and actual audit producers deliver through the native boundary',live,()=>nativeFixture(async({core,sales,app})=>{
  const value=runHeader();await app.provider.execute(I.insertRun,value);
  assert.equal((await app.provider.execute(I.updateRun,runCheckpoint(value))).rowsAffected,1);
  assert.equal((await app.provider.execute(I.updateRun,runCheckpoint(value))).rowsAffected,0);
  await app.provider.transaction(async tx=>{await tx.execute(I.updateRun,runCheckpoint(value,2));await tx.execute(A.insertAudit,audit());});
  assert.equal((await sales.client.query('SELECT count(*)::int n FROM integration.core_audit_outbox')).rows[0].n,1);
  assert.equal((await sales.client.query('SELECT count(*)::int n FROM integration.core_audit_delivery')).rows[0].n,1);
  assert.equal((await core.migrator.query('SELECT count(*)::int n FROM gp.sales_audit_inbox')).rows[0].n,1);
  assert.equal((await app.deliverAudits()).delivered,0);
}));

test('Live volume: 100000 delivered audit rows do not add an outbox scan to each of 1000 run checkpoints',
  {skip:process.env.GP_PG_MIGRATION_LIVE!=='1'||process.env.GP_IMPORT_AUDIT_VOLUME_CHECK!=='1'},async t=>nativeFixture(async({sales,app})=>{
    const prefix='synthetic-delivered-'+crypto.randomUUID()+'-';
    // Dedicated fixture-only volume. These historical rows are already marked
    // delivered; pending/new audit correctness is exercised separately above.
    await sales.client.query(`INSERT INTO integration.core_audit_outbox(event_id,actor,action,entity_type,entity_id,detail,created_at)
      SELECT $1||n::text,'synthetic-volume','synthetic.volume','synthetic',n::text,'{}',$2 FROM generate_series(1,100000) n`,[prefix,TIME]);
    await sales.client.query(`INSERT INTO integration.core_audit_delivery(event_id,core_audit_id,source_sha256)
      SELECT event_id,id,repeat('a',64) FROM integration.core_audit_outbox WHERE event_id LIKE $1`,[prefix+'%']);
    const {Client}=require('pg'),original=Client.prototype.query;let scans=0;
    Client.prototype.query=function(...args){const sql=typeof args[0]==='string'?args[0]:args[0]?.text||'';
      if(/core_audit_outbox/.test(sql)&&/NOT EXISTS/.test(sql))scans++;return original.apply(this,args);};
    try{
      const value=runHeader(),startup=performance.now();await app.provider.execute(I.insertRun,value);
      const startupMs=performance.now()-startup,startupScans=scans;assert.equal(startupScans,1);
      const started=performance.now();
      for(let revision=1;revision<=1000;revision++)assert.equal((await app.provider.execute(I.updateRun,runCheckpoint(value,revision))).rowsAffected,1);
      const checkpointMs=performance.now()-started,checkpointScans=scans-startupScans;
      assert.equal(checkpointScans,0);
      assert.equal((await sales.client.query('SELECT revision::int FROM integration.data_import_runs WHERE id=$1',[value.id])).rows[0].revision,1001);
      await app.provider.execute(A.insertAudit,audit());assert.equal(scans-startupScans,1);
      t.diagnostic(JSON.stringify({rows:100000,checkpoints:1000,startupMs,startupScans,checkpointMs,checkpointScans,
        baselineScanCount:1000,measurement:'isolated-native-postgresql-autoDeliver-true; baseline count is former behavior, not a measured wall-time comparison'}));
    }finally{Client.prototype.query=original;}
  }));

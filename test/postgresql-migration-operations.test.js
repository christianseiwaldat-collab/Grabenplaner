'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {evaluatePairedStatus}=require('../lib/persistence/postgresql/operations/paired-monitor');
const {postgresqlPairIdentity,sameDatabaseIdentity,evaluateDeploy,FORMAT}=require('../server-tools/linux/lib/deploy-policy');
test('paired deploy identity detects a replaced Sales database and never reuses a SQLite proof',()=>{
 const core={database:'gp_core',clusterId:'123456789',environmentId:'isolated-core',schemaSha256:'a'.repeat(64)};
 const sales={database:'gp_sales',clusterId:'123456789',environmentId:'isolated-sales',schemaSha256:'b'.repeat(64)};
 const identity=postgresqlPairIdentity({core,sales}),proof={schemaVersion:2,...identity};
 assert.equal(sameDatabaseIdentity(proof,identity),true);
 assert.equal(sameDatabaseIdentity({schemaVersion:1,databasePath:'old.db',schemaSha256:identity.schemaSha256},identity),false);
 assert.equal(sameDatabaseIdentity(proof,postgresqlPairIdentity({core,sales:{...sales,schemaSha256:'c'.repeat(64)}})),false);
 assert.throws(()=>postgresqlPairIdentity({core,sales:{...sales,clusterId:'987654321'}}),/PAIR_INVALID/);
});
test('paired operational monitoring refuses a stale WAL return even with a current logical backup',()=>{
 const now=Date.parse('2026-09-12T10:00:00Z'),checkedAt=new Date(now).toISOString(),record={verified:true,checkedAt,manifestSha256:'a'.repeat(64),sourceManifestSha256:'a'.repeat(64)};
 const base={cluster_id:'123',archive_mode:'on',in_recovery:false,connections:{total:1,active:1,blocked:0,idleInTransaction:0,idleInTransactionOverLimit:0,abortedInTransaction:0},wal:{lastArchivedAt:checkedAt,lastFailureAt:null}};
 const options={core:{...base,database:'core'},sales:{...base,database:'sales'},backup:record,restore:record,offsite:record,walOffsite:record,freeBytes:20*1024**3,recoveryPolicy:'wal-15m',now};
 assert.equal(evaluatePairedStatus(options).healthy,true);
 assert.deepEqual(evaluatePairedStatus({...options,walOffsite:{...record,checkedAt:new Date(now-16*60000).toISOString()}}).reasons,['OFFSITE_WAL_MISSING_OR_STALE']);
 assert.ok(evaluatePairedStatus({...options,offsite:{...record,manifestSha256:'b'.repeat(64)}}).reasons.includes('OFFSITE_PAIR_BINDING_MISMATCH'));
 assert.equal(evaluatePairedStatus({...options,recoveryPolicy:'paired-daily',walOffsite:null,backup:{...record,manifestSha256:'c'.repeat(64)}}).healthy,true);
});
test('short PostgreSQL deploy requires the current pair and a confirmed full nightly recovery',()=>{
 const now=Date.parse('2026-09-12T10:00:00Z'),verifiedAt=new Date(now-60000).toISOString();
 const identity=postgresqlPairIdentity({core:{database:'gp_core',clusterId:'123',environmentId:'core',schemaSha256:'a'.repeat(64)},sales:{database:'gp_sales',clusterId:'123',environmentId:'sales',schemaSha256:'b'.repeat(64)}});
 const proof={format:FORMAT,schemaVersion:2,...identity,contractSha256:'c'.repeat(64),configurationSha256:'d'.repeat(64),verifiedAt,runId:'run',sequence:1,eventHash:'e'.repeat(64),receiptSha256:'f'.repeat(64)};
 const options={installed:{fingerprint:proof.contractSha256},candidate:{fingerprint:proof.contractSha256},proof,identity,configurationSha256:proof.configurationSha256,now,timerActive:true,history:{ok:true,events:[{sequence:1,eventHash:proof.eventHash,payload:{eventType:'full-assurance-passed',runId:'run',occurredAt:verifiedAt,evidence:{receiptSha256:proof.receiptSha256}}}]}};
 assert.equal(evaluateDeploy(options).mode,'short');
 assert.equal(evaluateDeploy({...options,timerActive:false}).mode,'full');
 assert.equal(evaluateDeploy({...options,proof:{...proof,databaseIdentitySha256:'0'.repeat(64)}}).mode,'full');
 assert.equal(evaluateDeploy({...options,history:{ok:true,events:[...options.history.events,{sequence:2,payload:{eventType:'full-assurance-failed'}}]}}).mode,'full');
});

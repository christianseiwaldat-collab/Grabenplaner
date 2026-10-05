'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {safeRoot,sealPairBundle}=require('./paired-bundle');
const {SCHEMAS}=require('../sales/layout');
const {phaseTimer}=require('./phase-timing');
const {createBackupBudget,boundedSnapshotClient,SNAPSHOT_IDLE_MS}=require('./backup-budget');
const quote=value=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(value))throw new Error('PG_PAIR_IDENTIFIER');return '"'+value+'"';};
// The application owns the mutation/file gate. Native tool and configuration
// access belong to the trusted operations process, never to a web request body.
async function createPairedSnapshot({backupDirectory,domains,withQuiescedWrites,runDump,captureRecoveryFiles,readCheckpoint,budget=createBackupBudget()}={}){
 budget.remaining();
 safeRoot(backupDirectory);
 if(!Array.isArray(domains)||domains.map(d=>d.domain).join(',')!=='core,sales'||domains.some(d=>!d.pool||!d.database||!d.ownerRole)
  ||domains[0].database===domains[1].database||[withQuiescedWrites,runDump,captureRecoveryFiles,readCheckpoint].some(f=>typeof f!=='function'))throw new Error('PG_PAIR_BACKUP_CONFIGURATION');
 for(const d of domains){quote(d.database);quote(d.ownerRole);}
 return withQuiescedWrites(async gate=>{
  if(!gate||gate.active!==true||gate.pendingMutations!==0)throw new Error('PG_PAIR_WRITERS_NOT_DRAINED');
  const snapshotId=crypto.randomUUID(),directory=path.join(backupDirectory,snapshotId+'.pair');
  fs.mkdirSync(directory,{mode:0o700});const clients=[],bounded=[],checkpoints={},databaseBytes={},snapshots={},timings=[],phaseTimings=[];const started=performance.now();
  const connectionErrors=new Map();
  const assertConnections=()=>{if(connectionErrors.size){const error=new Error('PG_PAIR_CONNECTION_LOST');error.code='PG_PAIR_CONNECTION_LOST';throw error;}};
  const listeners=new Map();
  const recordTiming=entry=>phaseTimings.push(entry),measure=phaseTimer(recordTiming);
  try{
   for(const domain of domains){
    budget.remaining();
    const client=await domain.pool.connect();clients.push(client);
    // Exported-snapshot clients remain idle during pg_dump. PostgreSQL restarts
    // emit asynchronous errors on them; retain the failure without crashing the
    // process, then fail the pair before COMMIT/sealing. Never retry a half pair.
    const onError=error=>connectionErrors.set(client,error);
    client.on?.('error',onError);listeners.set(client,onError);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    // Exact row counts in a drained backup can outlive the application role's
    // short query budget. Scope the bounded maintenance budget to this snapshot;
    // COMMIT/ROLLBACK restores the connection's original limits.
    await client.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='"+budget.statementMilliseconds()+"ms';SET LOCAL idle_in_transaction_session_timeout='"+SNAPSHOT_IDLE_MS+"ms'");
    const owned=boundedSnapshotClient(client,budget);bounded.push(owned);
    if((await owned.query('SELECT current_database() AS name')).rows[0].name!==domain.database)throw new Error('PG_PAIR_DATABASE_BINDING');
    await owned.query('SET LOCAL ROLE '+quote(domain.ownerRole));
    // Core is always acquired first, matching the application's pair protocol.
    await owned.query('SELECT pg_advisory_xact_lock(9261207)');
    const schemas=domain.domain==='core'?['gp']:SCHEMAS;
    const tables=(await owned.query('SELECT schemaname,tablename FROM pg_tables WHERE schemaname=ANY($1::text[]) ORDER BY schemaname,tablename',[schemas])).rows;
    if(!tables.length)throw new Error('PG_PAIR_EMPTY_DATABASE');
    await owned.query('LOCK TABLE '+tables.map(t=>quote(t.schemaname)+'.'+quote(t.tablename)).join(',')+' IN SHARE MODE');
   }
   for(let i=0;i<domains.length;i++){
    const domain=domains[i],client=bounded[i];
    const size=Number((await client.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0]?.bytes);
    if(!Number.isSafeInteger(size)||size<=0)throw new Error('PG_PAIR_BACKUP_SIZE_INVALID');
    databaseBytes[domain.domain]=size;
    checkpoints[domain.domain]=await measure('checkpoint-'+domain.domain,()=>readCheckpoint({domain:domain.domain,client,onTiming:entry=>recordTiming({...entry,domain:domain.domain})}));
    const snapshot=(await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    if(!/^[A-Fa-f0-9-]+$/.test(snapshot))throw new Error('PG_PAIR_EXPORTED_SNAPSHOT');
    snapshots[domain.domain]=snapshot;
   }
   for(const domain of domains){
    budget.remaining();
    const before=performance.now();await measure('dump-and-catalog-'+domain.domain,()=>runDump({domain:domain.domain,database:domain.database,snapshotId:snapshots[domain.domain],targetFile:path.join(directory,domain.domain+'.dump'),onTiming:entry=>recordTiming({...entry,domain:domain.domain})}));
    assertConnections();budget.remaining();timings.push({domain:domain.domain,milliseconds:Math.round(performance.now()-before)});
   }
   await measure('recovery-files',()=>captureRecoveryFiles({directory,checkpoints,onTiming:recordTiming}));
   assertConnections();budget.remaining();
   for(const client of [...bounded].reverse()){await client.query('COMMIT');assertConnections();}
   const result=await measure('hash-and-seal',()=>sealPairBundle(directory,{snapshotId,checkBudget:budget.remaining,databases:domains.map(d=>({domain:d.domain,database:d.database,file:d.domain+'.dump'})),checkpoint:{quiescence:'application-and-files-drained;both-databases-share-locked',domains:checkpoints,databaseBytes}}));
   return {...result,timings,phaseTimings,milliseconds:Math.round(performance.now()-started)};
  }catch(error){await Promise.allSettled(clients.filter(c=>!connectionErrors.has(c)).map(c=>c.query('ROLLBACK')));assertConnections();throw error;}
  finally{for(const client of clients){client.release(connectionErrors.get(client));client.removeListener?.('error',listeners.get(client));}}
 });
}
module.exports={createPairedSnapshot};

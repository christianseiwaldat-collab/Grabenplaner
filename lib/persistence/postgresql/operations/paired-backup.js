'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {safeRoot,sealPairBundle}=require('./paired-bundle');
const {SCHEMAS}=require('../sales/layout');
const quote=value=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(value))throw new Error('PG_PAIR_IDENTIFIER');return '"'+value+'"';};
// The application owns the mutation/file gate. Native tool and configuration
// access belong to the trusted operations process, never to a web request body.
async function createPairedSnapshot({backupDirectory,domains,withQuiescedWrites,runDump,captureRecoveryFiles,readCheckpoint}={}){
 safeRoot(backupDirectory);
 if(!Array.isArray(domains)||domains.map(d=>d.domain).join(',')!=='core,sales'||domains.some(d=>!d.pool||!d.database||!d.ownerRole)
  ||domains[0].database===domains[1].database||[withQuiescedWrites,runDump,captureRecoveryFiles,readCheckpoint].some(f=>typeof f!=='function'))throw new Error('PG_PAIR_BACKUP_CONFIGURATION');
 for(const d of domains){quote(d.database);quote(d.ownerRole);}
 return withQuiescedWrites(async gate=>{
  if(!gate||gate.active!==true||gate.pendingMutations!==0)throw new Error('PG_PAIR_WRITERS_NOT_DRAINED');
  const snapshotId=crypto.randomUUID(),directory=path.join(backupDirectory,snapshotId+'.pair');
  fs.mkdirSync(directory,{mode:0o700});const clients=[],checkpoints={},snapshots={},timings=[];const started=performance.now();
  try{
   for(const domain of domains){
    const client=await domain.pool.connect();clients.push(client);
    if((await client.query('SELECT current_database() AS name')).rows[0].name!==domain.database)throw new Error('PG_PAIR_DATABASE_BINDING');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL lock_timeout='5s';SET LOCAL idle_in_transaction_session_timeout='15min'");
    await client.query('SET LOCAL ROLE '+quote(domain.ownerRole));
    // Core is always acquired first, matching the application's pair protocol.
    await client.query('SELECT pg_advisory_xact_lock(9261207)');
    const schemas=domain.domain==='core'?['gp']:SCHEMAS;
    const tables=(await client.query('SELECT schemaname,tablename FROM pg_tables WHERE schemaname=ANY($1::text[]) ORDER BY schemaname,tablename',[schemas])).rows;
    if(!tables.length)throw new Error('PG_PAIR_EMPTY_DATABASE');
    await client.query('LOCK TABLE '+tables.map(t=>quote(t.schemaname)+'.'+quote(t.tablename)).join(',')+' IN SHARE MODE');
   }
   for(let i=0;i<domains.length;i++){
    const domain=domains[i],client=clients[i];
    checkpoints[domain.domain]=await readCheckpoint({domain:domain.domain,client});
    const snapshot=(await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    if(!/^[A-Fa-f0-9-]+$/.test(snapshot))throw new Error('PG_PAIR_EXPORTED_SNAPSHOT');
    snapshots[domain.domain]=snapshot;
   }
   for(const domain of domains){
    const before=performance.now();await runDump({domain:domain.domain,database:domain.database,snapshotId:snapshots[domain.domain],targetFile:path.join(directory,domain.domain+'.dump')});
    timings.push({domain:domain.domain,milliseconds:Math.round(performance.now()-before)});
   }
   await captureRecoveryFiles({directory,checkpoints});
   for(const client of [...clients].reverse())await client.query('COMMIT');
   const result=await sealPairBundle(directory,{snapshotId,databases:domains.map(d=>({domain:d.domain,database:d.database,file:d.domain+'.dump'})),checkpoint:{quiescence:'application-and-files-drained;both-databases-share-locked',domains:checkpoints}});
   return {...result,timings,milliseconds:Math.round(performance.now()-started)};
  }catch(error){await Promise.allSettled(clients.map(c=>c.query('ROLLBACK')));throw error;}
  finally{for(const client of clients)client.release();}
 });
}
module.exports={createPairedSnapshot};

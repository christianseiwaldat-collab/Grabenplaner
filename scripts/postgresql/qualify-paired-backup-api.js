'use strict';
const fs=require('node:fs'),path=require('node:path'),{Pool}=require('pg');
const R=require('../../lib/persistence/postgresql/operations/paired-development');
const {createPairedSnapshot}=require('../../lib/persistence/postgresql/operations/paired-backup');
const {verifyEnvironment}=require('../../lib/persistence/postgresql/core/environment');
const {verifyCoreSchema}=require('../../lib/persistence/postgresql/boundary/migrate');
const {schemaFingerprint}=require('../../lib/persistence/postgresql/core/fingerprint');
const {SCHEMAS,SEARCH_PATH}=require('../../lib/persistence/postgresql/sales/layout');
async function main(){
 R.guard();await R.verifyBundle();const backupDirectory=R.ROOT+'/api-snapshots';if(fs.existsSync(backupDirectory))throw new Error('PG_PAIR_API_TARGET_EXISTS');fs.mkdirSync(backupDirectory,{mode:0o700});
 const domains=['core','sales'].map(domain=>({domain,database:'gp_migration_'+domain,ownerRole:'gp_'+domain+'_owner',pool:new Pool({connectionString:R.connectionString(domain),max:1})}));
 try{
  for(const d of domains)await verifyEnvironment(d.pool,{domain:d.domain,purpose:'migrator'});
  const result=await createPairedSnapshot({backupDirectory,domains,
   async withQuiescedWrites(work){
    for(const d of domains){const others=(await d.pool.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rows[0].n;if(others)throw new Error('PG_PAIR_API_SOURCE_BUSY');}
    return work({active:true,pendingMutations:0});
   },
   async readCheckpoint({domain,client}){
    await client.query('SET LOCAL search_path='+(domain==='core'?'pg_catalog,gp':SEARCH_PATH));
    if(domain==='core')await verifyCoreSchema(client);
    const sha=await schemaFingerprint(client,domain==='core'?['gp']:SCHEMAS);
    return {schemaSha256:sha,source:'verified-immutable-historical-copy'};
   },
   async runDump({domain,database,snapshotId,targetFile}){
    await R.command('pg_dump',['--format=custom','--compress=gzip:1','--snapshot='+snapshotId,'--role=gp_'+domain+'_owner'],{env:R.environment('gp_'+domain+'_migrator',database),output:targetFile,log:R.ROOT+'/api-'+domain+'-dump.log'});
    await R.command('pg_restore',['--list',targetFile],{output:R.ROOT+'/api-'+domain+'-contents.txt'});
   },
   async captureRecoveryFiles({directory}){
    const source=await R.verifyBundle();for(const entry of source.files.filter(f=>!['core.dump','sales.dump'].includes(f.file))){const target=path.join(directory,entry.file);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.copyFileSync(R.ROOT+'/bundle/'+entry.file,target,fs.constants.COPYFILE_EXCL);fs.chmodSync(target,0o600);}
   }
  });
  fs.writeFileSync(R.ROOT+'/backup-api-verification.json',JSON.stringify({checkedAt:new Date().toISOString(),verified:true,...result,productActivation:false},null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify({verified:true,timings:result.timings,milliseconds:result.milliseconds}));
 }finally{await Promise.allSettled(domains.map(d=>d.pool.end()));}
}
main().catch(e=>{console.error(JSON.stringify({failed:true,code:e.code||null,error:e.message}));process.exitCode=1;});

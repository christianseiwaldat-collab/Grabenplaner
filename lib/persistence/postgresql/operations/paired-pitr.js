'use strict';
const fs=require('node:fs'),{Client}=require('pg');
const R=require('./paired-development');
const {fileHash}=require('../transfer/history');
const {verifyPair}=require('../transfer/verify-pair');
const {verifyCoreSchema}=require('../boundary/migrate');
const {schemaFingerprint}=require('../core/fingerprint');
const {SCHEMAS,SEARCH_PATH}=require('../sales/layout');
const {parseEnv}=require('node:util');
const {validateEncryptionKeyForStorage}=require('../../../amu-storage');
const data=R.ROOT+'/logical-data-3',base=R.ROOT+'/physical-base',target=R.ROOT+'/pitr-data';
const archive=R.ROOT+'/wal-archive',walScript=R.BASE+'/qualification/scripts/postgresql/development-wal-archive.py';
const targetName='grabenplaner_pair_recovery_block10';
async function client(domain,port){const c=new Client({connectionString:R.connectionString('admin','migrator',port).replace('/postgres','/gp_migration_'+domain)});await c.connect();return c;}
async function waitForRecoveryTarget(connection){
 const deadline=Date.now()+90000;
 while((await connection.query('SELECT pg_is_in_recovery() AS recovery')).rows[0].recovery){
  if(Date.now()>deadline)throw new Error('PG_PAIR_PITR_TARGET_TIMEOUT');
  await new Promise(resolve=>setTimeout(resolve,250));
 }
}
async function qualifyPitr(){
 R.guard();await R.verifyBundle();
 const logical=JSON.parse(fs.readFileSync(R.ROOT+'/logical-verification.json','utf8'));
 if(!logical.verified||logical.attempt!==3||fs.existsSync(base)||fs.existsSync(target)||fs.existsSync(archive)||fs.existsSync(data+'/postmaster.pid'))throw new Error('PG_PAIR_PITR_INITIAL_STATE');
 fs.mkdirSync(archive,{mode:0o700});
 fs.appendFileSync(data+'/postgresql.conf',`\narchive_mode=on\narchive_timeout='60s'\narchive_command='/usr/bin/python3 ${walScript} archive %p %f'\n`);
 await R.command('pg_ctl',['-D',data,'-l',R.ROOT+'/pitr-source.log','-w','start']);
 let core,sales,targetCore,targetSales,targetStarted=false;const timings=[];
 const started=performance.now();
 try{
  core=await client('core',55484);sales=await client('sales',55484);
  const system=(await core.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
  for(const c of [core,sales]){
   const other=(await c.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()")).rows[0].n;
   if(other)throw new Error('PG_PAIR_PITR_CLIENTS');
   await c.query('CREATE SCHEMA recovery_probe;CREATE TABLE recovery_probe.checkpoints(id integer PRIMARY KEY);INSERT INTO recovery_probe.checkpoints VALUES(1)');
  }
  console.log(JSON.stringify({phase:'physical-basebackup'}));
  timings.push(await R.command('pg_basebackup',['-D',base,'--format=plain','--wal-method=stream','--checkpoint=fast','--max-rate=16M','--manifest-checksums=SHA256'],{env:R.environment('gp_migration_admin','postgres',55484),log:R.ROOT+'/basebackup.log'}));
  timings.push(await R.command('pg_verifybackup',[base],{log:R.ROOT+'/basebackup-verify.log'}));
  for(const c of [core,sales])await c.query('INSERT INTO recovery_probe.checkpoints VALUES(2)');
  const point=(await core.query('SELECT pg_create_restore_point($1)::text AS lsn',[targetName])).rows[0].lsn;
  for(const c of [core,sales])await c.query('INSERT INTO recovery_probe.checkpoints VALUES(3)');
  const wal=(await core.query('SELECT pg_walfile_name($1::pg_lsn) AS name',[point])).rows[0].name;
  await core.query('SELECT pg_switch_wal()');
  const deadline=Date.now()+90000;
  while(!fs.existsSync(archive+'/'+wal+'.sha256')){
   if(Date.now()>deadline)throw new Error('PG_PAIR_WAL_ARCHIVE_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(await fileHash(archive+'/'+wal)!==fs.readFileSync(archive+'/'+wal+'.sha256','utf8').trim())throw new Error('PG_PAIR_WAL_HASH');
  const archiver=(await core.query('SELECT archived_count,failed_count,last_archived_time FROM pg_stat_archiver')).rows[0];
  if(Number(archiver.failed_count)!==0)throw new Error('PG_PAIR_WAL_ARCHIVER_FAILURE');
  console.log(JSON.stringify({phase:'physical-recovery',restorePoint:point,archivedSegments:archiver.archived_count}));
  R.guard();fs.cpSync(base,target,{recursive:true,errorOnExist:true,force:false});fs.chmodSync(target,0o700);
  fs.appendFileSync(target+'/postgresql.conf',`\nport=55485\narchive_mode=off\narchive_command=''\nrestore_command='/usr/bin/python3 ${walScript} restore %p %f'\nrecovery_target_name='${targetName}'\nrecovery_target_action='promote'\nrecovery_target_timeline='current'\n`);
  fs.writeFileSync(target+'/recovery.signal','',{mode:0o600,flag:'wx'});
  fs.writeFileSync(R.ROOT+'/pitr-prepared.json',JSON.stringify({system,point,targetName,baseManifestSha256:await fileHash(base+'/backup_manifest'),archiver,timings})+'\n',{flag:'wx',mode:0o600});
  const recoveryStarted=performance.now();
  await R.command('pg_ctl',['-D',target,'-l',R.ROOT+'/pitr-target.log','-w','-t','180','start']);targetStarted=true;
  targetCore=await client('core',55485);targetSales=await client('sales',55485);
  await waitForRecoveryTarget(targetCore);
  const restoredSystem=(await targetCore.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
  if(restoredSystem!==system||(await targetCore.query('SELECT pg_is_in_recovery() AS recovery')).rows[0].recovery)throw new Error('PG_PAIR_PITR_SYSTEM');
  for(const c of [targetCore,targetSales]){
   const rows=(await c.query('SELECT id FROM recovery_probe.checkpoints ORDER BY id')).rows;
   if(JSON.stringify(rows)!=='[{"id":1},{"id":2}]')throw new Error('PG_PAIR_PITR_CHECKPOINT');
  }
  await targetCore.query('SET search_path=pg_catalog,gp');await targetSales.query('SET search_path='+SEARCH_PATH);
  await verifyCoreSchema(targetCore);
  const expected=(await targetSales.query('SELECT target_sha256 FROM gp.sales_migration_history ORDER BY stage DESC LIMIT 1')).rows[0].target_sha256;
  if(expected!==await schemaFingerprint(targetSales,SCHEMAS))throw new Error('PG_PAIR_PITR_SCHEMA');
  const proof=await verifyPair(targetCore,targetSales,JSON.parse(fs.readFileSync(R.ROOT+'/bundle/content-evidence.json','utf8')));
  const env=parseEnv(fs.readFileSync(R.ROOT+'/bundle/configuration.env','utf8')),key=env.GRABENPLANER_AMU_KEY_ID;
  const protectedFiles=validateEncryptionKeyForStorage({sourceDirectory:R.ROOT+'/bundle/private/amu',encryptionKeys:{[key]:env.GRABENPLANER_AMU_KEY},activeKeyId:key});
  const result={checkedAt:new Date().toISOString(),physicalRestore:true,...proof,systemIdentifier:system,restorePoint:point,restorePointName:targetName,checkpointRowsInBothDatabases:[1,2],laterRowsExcluded:[3],encryptedFiles:protectedFiles.fileCount,archiver,timings,baseManifestSha256:await fileHash(base+'/backup_manifest'),walFiles:await R.regularDigest(archive),recoveryMilliseconds:Math.round(performance.now()-recoveryStarted),totalMilliseconds:Math.round(performance.now()-started),fileCheckpoint:'immutable-shared-bundle',offsiteWal:false,productActivation:false};
  fs.writeFileSync(R.ROOT+'/pitr-verification.json',JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return result;
 }finally{
  await Promise.allSettled([core?.end(),sales?.end(),targetCore?.end(),targetSales?.end()]);
  if(targetStarted||fs.existsSync(target+'/postmaster.pid'))await R.command('pg_ctl',['-D',target,'-m','fast','-w','stop']);
  await R.command('pg_ctl',['-D',data,'-m','fast','-w','stop']);
 }
}
// A failed startup leaves the owned restore directory available for diagnosis.
// Re-use the verified base/WAL and retry only that directory, never the source.
async function resumePitr({rebuildTarget=false}={}){
 R.guard();await R.verifyBundle();
 if(fs.existsSync(R.ROOT+'/pitr-verification.json')||fs.existsSync(data+'/postmaster.pid')||fs.existsSync(target+'/postmaster.pid'))throw new Error('PG_PAIR_PITR_RESUME_STATE');
 await R.command('pg_verifybackup',[base],{log:R.ROOT+'/resume-base-verify.log'});
 if(rebuildTarget){
  const failed=R.ROOT+'/pitr-interrupted-data';
  if(fs.realpathSync(target)!==target||fs.existsSync(failed)||fs.readFileSync(target+'/PG_VERSION','utf8').trim()!=='18')throw new Error('PG_PAIR_PITR_RETRY_TARGET');
  fs.renameSync(target,failed);R.guard();fs.cpSync(base,target,{recursive:true,errorOnExist:true,force:false});fs.chmodSync(target,0o700);
  fs.appendFileSync(target+'/postgresql.conf',`\nport=55485\narchive_mode=off\narchive_command=''\nrestore_command='/usr/bin/python3 ${walScript} restore %p %f'\nrecovery_target_name='${targetName}'\nrecovery_target_action='promote'\nrecovery_target_timeline='current'\n`);
  fs.writeFileSync(target+'/recovery.signal','',{mode:0o600,flag:'wx'});
 }
 let core,sales,targetCore,targetSales;
 const started=performance.now();
 try{
  await R.command('pg_ctl',['-D',data,'-l',R.ROOT+'/pitr-source.log','-w','start']);
  core=await client('core',55484);sales=await client('sales',55484);
  for(const c of [core,sales])if(JSON.stringify((await c.query('SELECT id FROM recovery_probe.checkpoints ORDER BY id')).rows)!=='[{"id":1},{"id":2},{"id":3}]')throw new Error('PG_PAIR_PITR_SOURCE_PROBE');
  const system=(await core.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
  // The first failed rehearsal predates the prepared-state file. Its bounded
  // phase receipt is sufficient only for this fixed, non-productive bootstrap.
  const phases=fs.readFileSync(R.BASE+'/paired-pitr.log','utf8').split('\n').filter(s=>s.startsWith('{')).map(s=>JSON.parse(s));
  const phase=phases.find(p=>p.phase==='physical-recovery');
  if(!phase||!/^\w+\/\w+$/.test(phase.restorePoint))throw new Error('PG_PAIR_PITR_PREPARED');
  const point=phase.restorePoint,wal=(await core.query('SELECT pg_walfile_name($1::pg_lsn) AS name',[point])).rows[0].name;
  if(await fileHash(archive+'/'+wal)!==fs.readFileSync(archive+'/'+wal+'.sha256','utf8').trim())throw new Error('PG_PAIR_WAL_HASH');
  const archiver=(await core.query('SELECT archived_count,failed_count,last_archived_time FROM pg_stat_archiver')).rows[0];
  if(Number(archiver.failed_count)!==0)throw new Error('PG_PAIR_WAL_ARCHIVER_FAILURE');
  await R.command('pg_ctl',['-D',target,'-l',R.ROOT+'/pitr-target.log','-w','-t','180','start']);
  targetCore=await client('core',55485);targetSales=await client('sales',55485);
  await waitForRecoveryTarget(targetCore);
  if((await targetCore.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id!==system||(await targetCore.query('SELECT pg_is_in_recovery() AS recovery')).rows[0].recovery)throw new Error('PG_PAIR_PITR_SYSTEM');
  for(const c of [targetCore,targetSales])if(JSON.stringify((await c.query('SELECT id FROM recovery_probe.checkpoints ORDER BY id')).rows)!=='[{"id":1},{"id":2}]')throw new Error('PG_PAIR_PITR_CHECKPOINT');
  await targetCore.query('SET search_path=pg_catalog,gp');await targetSales.query('SET search_path='+SEARCH_PATH);
  await verifyCoreSchema(targetCore);
  if((await targetSales.query('SELECT target_sha256 FROM gp.sales_migration_history ORDER BY stage DESC LIMIT 1')).rows[0].target_sha256!==await schemaFingerprint(targetSales,SCHEMAS))throw new Error('PG_PAIR_PITR_SCHEMA');
  const proof=await verifyPair(targetCore,targetSales,JSON.parse(fs.readFileSync(R.ROOT+'/bundle/content-evidence.json','utf8')));
  const env=parseEnv(fs.readFileSync(R.ROOT+'/bundle/configuration.env','utf8')),key=env.GRABENPLANER_AMU_KEY_ID;
  const protectedFiles=validateEncryptionKeyForStorage({sourceDirectory:R.ROOT+'/bundle/private/amu',encryptionKeys:{[key]:env.GRABENPLANER_AMU_KEY},activeKeyId:key});
  const result={checkedAt:new Date().toISOString(),physicalRestore:true,...proof,systemIdentifier:system,restorePoint:point,restorePointName:targetName,checkpointRowsInBothDatabases:[1,2],laterRowsExcluded:[3],encryptedFiles:protectedFiles.fileCount,archiver,baseManifestSha256:await fileHash(base+'/backup_manifest'),walFiles:await R.regularDigest(archive),recoveryMilliseconds:Math.round(performance.now()-started),resumedOwnedTarget:!rebuildTarget,rebuiltFromVerifiedBase:rebuildTarget,fileCheckpoint:'immutable-shared-bundle',offsiteWal:false,productActivation:false};
  fs.writeFileSync(R.ROOT+'/pitr-verification.json',JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});return result;
 }finally{
  await Promise.allSettled([core?.end(),sales?.end(),targetCore?.end(),targetSales?.end()]);
  if(fs.existsSync(target+'/postmaster.pid'))await R.command('pg_ctl',['-D',target,'-m','fast','-w','stop']);
  if(fs.existsSync(data+'/postmaster.pid'))await R.command('pg_ctl',['-D',data,'-m','fast','-w','stop']);
 }
}
module.exports={qualifyPitr,resumePitr};

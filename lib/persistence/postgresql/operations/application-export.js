'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {Client}=require('pg');
const {configuration,verifyEnvironment,PROFILE}=require('../core/environment');
const {SCHEMAS}=require('../sales/layout');
const OBSOLETE_SALES_TABLES=Object.freeze(['trade.import_master_bindings','trade.import_master_events','trade.import_master_holds']);
const OPERATIONS_ONLY_TABLES=Object.freeze({core:['gp.core_migration_history'],sales:['gp.sales_migration_history','gp.migration_fixture_owner']});
let active=false;
const error=code=>Object.assign(new Error(code),{code});
async function hashFile(file){
 const hash=crypto.createHash('sha256');let bytes=0;
 for await(const chunk of fs.createReadStream(file)){bytes+=chunk.length;hash.update(chunk);}
 return {bytes,sha256:hash.digest('hex')};
}
async function runTool(root,name,args,environment){
 const binary=name==='tar'?'/usr/bin/tar':'/usr/lib/postgresql/18/bin/'+name;
 if(!['tar','pg_dump','pg_restore'].includes(name))throw error('PG_EXPORT_TOOL');
 const stat=fs.lstatSync(binary);
 if(!stat.isFile()||stat.uid!==0||(stat.mode&0o022)||fs.realpathSync(binary)!==binary)throw error('PG_EXPORT_BINARY');
 const stderrPath=path.join(root,crypto.randomUUID()+'.error'),stderr=fs.openSync(stderrPath,'wx',0o600);
 try{
  const child=spawn(binary,args,{cwd:root,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',...environment},stdio:['ignore','ignore',stderr]});
  await new Promise((resolve,reject)=>{
   let expired=false;const timeout=setTimeout(()=>{expired=true;child.kill('SIGKILL');},600000);
   child.once('error',()=>{clearTimeout(timeout);reject(error('PG_EXPORT_TOOL_START'));});
   child.once('close',code=>{clearTimeout(timeout);code===0&&!expired?resolve():reject(Object.assign(error(expired?'PG_EXPORT_TIMEOUT':'PG_EXPORT_TOOL_FAILED'),{nativeTool:name,nativeError:fs.readFileSync(stderrPath,'utf8').slice(0,4096)}));});
  });
 }finally{fs.closeSync(stderr);}
}
// A database download contains database records only. The full server restore
// continues to use the protected pair backup with its files and key material.
async function createApplicationDatabaseExport({coreUrl,salesUrl,profile=PROFILE,binding,connectionOptions={},directory}){
 if(process.platform!=='linux'||process.getuid()===0)throw error('PG_EXPORT_APPLICATION_ACCOUNT');
 if(active)throw error('BACKUP_WORKSPACE_BUSY');
 const common={profile,binding,tlsMode:'disable-local-only',...connectionOptions};
 const lock=new Client(configuration({...common,databaseUrl:coreUrl}));
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw error('PG_EXPORT_DIRECTORY');
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 require('./paired-bundle').safeRoot(directory);
 if(fs.statSync(directory).uid!==process.getuid())throw error('PG_EXPORT_DIRECTORY_OWNER');
 const root=fs.mkdtempSync(path.join(directory,'grabenplaner-pg-export-'));fs.chmodSync(root,0o700);
 const capacity=fs.statfsSync(root);
 if(capacity.bavail*capacity.bsize<10*1024**3){fs.rmdirSync(root);throw error('PG_EXPORT_DISK_RESERVE');}
 const connections=[];let locked=false,lockConnected=false,completed=false;
 const cleanup=()=>{try{if(fs.existsSync(root)&&fs.realpathSync(root)===root&&path.dirname(root)===directory&&fs.statSync(root).uid===process.getuid())fs.rmSync(root,{recursive:true,force:true});}finally{active=false;}};
 active=true;
 try{
  await lock.connect();lockConnected=true;await verifyEnvironment(lock,{binding});
  await lock.query("SET lock_timeout='5s';SET statement_timeout='10s'");
  // Acquire the coordination lock BEFORE either repeatable-read snapshot.
  // Once both snapshots are pinned, normal application writes may resume.
  await lock.query('SELECT pg_advisory_lock(9261207)');locked=true;
  for(const domain of ['core','sales']){
   const databaseUrl=domain==='core'?coreUrl:salesUrl;
   const client=new Client(configuration({...common,domain,databaseUrl}));
   connections.push({domain,client,databaseUrl});await client.connect();await verifyEnvironment(client,{domain,binding});
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await client.query("SET LOCAL idle_in_transaction_session_timeout='15min';SET LOCAL statement_timeout='30s'");
   const snapshot=(await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
   if(!/^[A-Fa-f0-9-]+$/.test(snapshot))throw error('PG_EXPORT_SNAPSHOT');
   connections.at(-1).snapshot=snapshot;
  }
  await lock.query('SELECT pg_advisory_unlock(9261207)');locked=false;await lock.end();lockConnected=false;
  const files=[],schemaContracts={};
  for(const {domain,client,snapshot,databaseUrl} of connections){
   const url=new URL(databaseUrl),file=domain+'.dump';
   const nativeEnvironment={PGHOST:url.hostname,PGPORT:url.port,PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGCONNECT_TIMEOUT:'10',PGOPTIONS:'-c default_transaction_read_only=on'};
   schemaContracts[domain]=(await client.query(domain==='core'
    ?'SELECT version,source_sha256,plan_sha256,target_sha256 FROM gp.core_migration_history ORDER BY version'
    :'SELECT stage,source_sha256,plan_sha256,target_sha256 FROM gp.sales_migration_history ORDER BY stage')).rows;
   await runTool(root,'pg_dump',['--format=custom','--compress=gzip:1','--no-owner','--no-privileges','--snapshot='+snapshot,'--file='+file,
    ...(domain==='core'?['gp']:SCHEMAS).map(schema=>'--schema='+schema),
    ...(domain==='core'?['pgcrypto']:['pgcrypto','pg_trgm']).map(extension=>'--extension='+extension),
    ...[...OPERATIONS_ONLY_TABLES[domain],...(domain==='sales'?OBSOLETE_SALES_TABLES:[])].map(table=>'--exclude-table='+table)],nativeEnvironment);
   fs.chmodSync(path.join(root,file),0o600);
   await runTool(root,'pg_restore',['--list',file],{});
   files.push({domain,file,...await hashFile(path.join(root,file))});await client.query('COMMIT');
  }
  const createdAt=new Date().toISOString();
  fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({format:'grabenplaner-postgresql-database-export',version:1,createdAt,
   consistency:'coordinated-repeatable-read',files,schemaContracts,excludedObsoleteSalesTables:OBSOLETE_SALES_TABLES,operationsOnlyTables:OPERATIONS_ONLY_TABLES,
   protectedDocumentsIncluded:false,encryptionKeysIncluded:false,serverRecoveryBackup:false},null,2)+'\n',{flag:'wx',mode:0o600});
  const target=path.join(root,'grabenplaner-databases.tar');
  await runTool(root,'tar',['--create','--file='+target,'--','manifest.json','core.dump','sales.dump'],{});fs.chmodSync(target,0o600);
  const result=await hashFile(target);
  completed=true;
  return {temporaryRoot:root,path:target,size:result.bytes,sha256:result.sha256,createdAt,extension:'tar',contentType:'application/x-tar',releaseWorkspace(){active=false;},cleanup};
 }catch(e){cleanup();throw e;}
 finally{
  if(!completed)active=false;
  if(locked)await lock.query('SELECT pg_advisory_unlock(9261207)').catch(()=>{});
  if(lockConnected)await lock.end();
  await Promise.allSettled(connections.map(async({client})=>{await client.query('ROLLBACK').catch(()=>{});await client.end();}));
 }
}
module.exports={createApplicationDatabaseExport,hashFile,OBSOLETE_SALES_TABLES,OPERATIONS_ONLY_TABLES};

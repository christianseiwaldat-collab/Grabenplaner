'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{Pool,Client}=require('pg');
const {createPairedSnapshot}=require('./paired-backup');
const {safeRoot}=require('./paired-bundle');
const {verifyCoreSchema}=require('../boundary/migrate');
const {schemaFingerprint}=require('../core/fingerprint');
const {SCHEMAS,SEARCH_PATH}=require('../sales/layout');
const {readPairedDatabaseStatus}=require('./paired-monitor');
const FORMAT='grabenplaner-postgresql-operations-v1';
const DEVELOPMENT='/home/gpadmin/grabenplaner-pg-migration-20260912';
const BIN='/usr/lib/postgresql/18/bin';
function privateFile(file,{rootOnly=false}={}){
 if(!path.isAbsolute(file)||fs.realpathSync(file)!==file)throw new Error('PG_OPERATIONS_PATH');
 const info=fs.lstatSync(file);
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(info.mode&0o077)||rootOnly&&info.uid!==0)throw new Error('PG_OPERATIONS_PRIVATE_FILE');
 return file;
}
function loadConfiguration(file){
 if(process.platform!=='linux')throw new Error('PG_OPERATIONS_LINUX');
 privateFile(file);if(fs.statSync(file).size>65536)throw new Error('PG_OPERATIONS_CONFIG_SIZE');
 const config=JSON.parse(fs.readFileSync(file,'utf8'));
 if(config.format!==FORMAT||!['qualification','productive'].includes(config.mode)||!/^[0-9]+$/.test(config.clusterId||''))throw new Error('PG_OPERATIONS_CONFIG');
 if(config.mode==='qualification'){
  if(process.getuid()===0||file!==DEVELOPMENT+'/recovery-10/operations-config.json'||fs.readFileSync(DEVELOPMENT+'/ownership-marker','utf8').trim()!=='grabenplaner-postgresql-migration-development-v1')throw new Error('PG_OPERATIONS_QUALIFICATION');
 }else if(process.getuid()!==0||file!=='/etc/grabenplaner/postgresql-operations.json'||!config.activationReceipt||config.activationReceipt.productActivation!==true)throw new Error('PG_OPERATIONS_PRODUCTIVE_CONFIG');
 if(config.mode==='productive')privateFile(file,{rootOnly:true});
 if(config.host!=='127.0.0.1'||config.port!==(config.mode==='qualification'?55482:55486))throw new Error('PG_OPERATIONS_ENDPOINT');
 for(const name of ['backupDirectory','workDirectory'])safeRoot(config[name]);
 if(config.mode==='productive'&&['backupDirectory','workDirectory'].some(name=>fs.statSync(config[name]).uid!==0))throw new Error('PG_OPERATIONS_PRIVATE_OWNER');
 if(!path.isAbsolute(config.sourceFiles)||fs.realpathSync(config.sourceFiles)!==config.sourceFiles||!fs.statSync(config.sourceFiles).isDirectory()||(fs.statSync(config.sourceFiles).mode&0o022))throw new Error('PG_OPERATIONS_SOURCE_ROOT');
 if(config.mode==='qualification'&&['sourceFiles','backupDirectory','workDirectory','environmentFile'].some(name=>!config[name]?.startsWith(DEVELOPMENT+'/')))throw new Error('PG_OPERATIONS_QUALIFICATION_PATH');
 if(config.mode==='productive'&&(config.sourceFiles!=='/var/lib/grabenplaner'||config.environmentFile!=='/etc/grabenplaner/grabenplaner.env'||config.workDirectory!=='/var/lib/grabenplaner-postgresql/operations'))throw new Error('PG_OPERATIONS_PRODUCTIVE_PATH');
 privateFile(config.environmentFile,{rootOnly:config.mode==='productive'});
 if(config.domains?.map(d=>d.domain).join(',')!=='core,sales')throw new Error('PG_OPERATIONS_DOMAINS');
 for(const d of config.domains){
  if(d.database!==(config.mode==='qualification'?'gp_migration_':'grabenplaner_')+d.domain||d.role!=='gp_'+d.domain+'_migrator'||typeof d.password!=='string'||d.password.length<24||!d.environmentId||!d.profile)throw new Error('PG_OPERATIONS_DOMAIN');
 }
 if(config.administrator?.role!=='gp_migration_admin'||typeof config.administrator.password!=='string'||config.administrator.password.length<24)throw new Error('PG_OPERATIONS_ADMINISTRATOR');
 if(config.monitor?.role!=='gp_operations_monitor'||typeof config.monitor.password!=='string'||config.monitor.password.length<24||!config.recoveryAccounts||Object.keys(config.recoveryAccounts).length!==8||Object.keys(config.recoveryAccounts).some(name=>!/^gp_(?:(?:core|sales)_(?:app|reader|migrator)|migration_admin|operations_monitor)$/.test(name)))throw new Error('PG_OPERATIONS_RECOVERY_ACCOUNTS');
 for(const domain of ['core','sales'])for(const purpose of ['app','reader','migrator'])if(typeof config.recoveryAccounts?.['gp_'+domain+'_'+purpose]!=='string'||config.recoveryAccounts['gp_'+domain+'_'+purpose].length<24)throw new Error('PG_OPERATIONS_RECOVERY_ACCOUNTS');
 if(config.recoveryAccounts.gp_migration_admin!==config.administrator.password||config.domains.some(d=>config.recoveryAccounts[d.role]!==d.password)||config.recoveryAccounts[config.monitor?.role]!==config.monitor?.password)throw new Error('PG_OPERATIONS_RECOVERY_BINDING');
 if(config.mode==='productive'){
  const binding=require('../runtime-binding').validateBinding(config.binding);
  if(binding.clusterId!==config.clusterId||config.domains.some(d=>d.environmentId!==binding.environmentId||d.profile!==binding.profile))throw new Error('PG_OPERATIONS_RUNTIME_BINDING');
  const app=require('../productive-configuration');
  const document=app.readProtectedJson(app.FILE),anchor=app.readProtectedJson(app.ANCHOR);
  app.resolveDocument(document,anchor);
  if(document.binding.environmentId!==binding.environmentId||document.binding.clusterId!==binding.clusterId||Object.keys(document.accounts).some(name=>document.accounts[name]!==config.recoveryAccounts[name]))throw new Error('PG_OPERATIONS_APPLICATION_BINDING');
 }
 return Object.freeze(config);
}
function url(config,domain,purpose='migration'){
 const account=purpose==='administrator'?config.administrator:purpose==='monitor'?config.monitor:domain;
 if(!account?.role||!account?.password)throw new Error('PG_OPERATIONS_ACCOUNT');
 return {host:config.host,port:config.port,database:domain?.database||'postgres',user:account.role,password:account.password,connectionTimeoutMillis:5000,max:1};
}
async function nativeTool(config,name,args,{outputFile,errorFile}={}){
 if(!['pg_dump','pg_dumpall','pg_restore'].includes(name))throw new Error('PG_OPERATIONS_TOOL');
 const binary=BIN+'/'+name,info=fs.lstatSync(binary);if(!info.isFile()||info.uid!==0||(info.mode&0o022)||fs.realpathSync(binary)!==binary)throw new Error('PG_OPERATIONS_BINARY');
 for(const file of [outputFile,errorFile])if(!file?.startsWith(config.workDirectory+'/')&&!file?.startsWith(config.backupDirectory+'/'))throw new Error('PG_OPERATIONS_TOOL_OUTPUT');
 const account=args.account,argv=args.argv;
 const out=fs.openSync(outputFile,'wx',0o600),err=fs.openSync(errorFile,'wx',0o600);
 const child=spawn(binary,argv,{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PGHOST:config.host,PGPORT:String(config.port),PGDATABASE:args.database,PGUSER:account.role,PGPASSWORD:account.password,PGCONNECT_TIMEOUT:'10'},stdio:['ignore',out,err]});fs.closeSync(out);fs.closeSync(err);
 await new Promise((resolve,reject)=>{
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},15*60000);
  child.once('error',()=>{clearTimeout(timer);reject(new Error('PG_OPERATIONS_TOOL_START'));});
  child.once('close',code=>{clearTimeout(timer);code===0&&!timedOut?resolve():reject(new Error(timedOut?'PG_OPERATIONS_TOOL_TIMEOUT':'PG_OPERATIONS_TOOL_FAILED'));});
 });
}
async function inspectPair(config){
 const admin=new Client(url(config,null,'administrator')),result={};
 try{
  await admin.connect();const id=(await admin.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
  if(id!==config.clusterId)throw new Error('PG_OPERATIONS_CLUSTER_IDENTITY');
  const unexpected=(await admin.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname<>ALL($1::text[])",[['postgres',...config.domains.map(d=>d.database)]])).rows;
  if(unexpected.length)throw new Error('PG_OPERATIONS_SHARED_CLUSTER');
  for(const domain of config.domains){
   const client=new Client(url(config,domain));
   try{
    await client.connect();await client.query('BEGIN READ ONLY');await client.query('SET LOCAL search_path='+(domain.domain==='core'?'pg_catalog,gp':SEARCH_PATH));
    const role=(await client.query('SELECT current_user AS name,rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS elevated FROM pg_roles WHERE rolname=current_user')).rows[0];
    if(role?.name!==domain.role||role.elevated)throw new Error('PG_OPERATIONS_ROLE');
    const environment=(await client.query('SELECT environment_id,profile,domain FROM gp.environment_contract')).rows;
    if(environment.length!==1||environment[0].environment_id!==domain.environmentId||environment[0].profile!==domain.profile||environment[0].domain!==domain.domain)throw new Error('PG_OPERATIONS_ENVIRONMENT');
    if(domain.domain==='core')await verifyCoreSchema(client);
    const digest=await schemaFingerprint(client,domain.domain==='core'?['gp']:SCHEMAS);
    if(domain.domain==='sales'&&(await client.query('SELECT target_sha256 FROM gp.sales_migration_history ORDER BY stage DESC LIMIT 1')).rows[0]?.target_sha256!==digest)throw new Error('PG_OPERATIONS_SCHEMA');
    result[domain.domain]={clusterId:id,database:domain.database,environmentId:domain.environmentId,schemaSha256:digest};await client.query('COMMIT');
   }finally{await client.end();}
  }
  return result;
 }finally{await admin.end();}
}
async function createBackup(config){
 const identity=await inspectPair(config),runId=require('node:crypto').randomUUID();
 const domains=config.domains.map(d=>({...d,ownerRole:'gp_'+d.domain+'_owner',pool:new Pool(url(config,d))}));
 try{const result=await createPairedSnapshot({backupDirectory:config.backupDirectory,domains,
  async withQuiescedWrites(work){
   // Installed wrappers must stop/drain the application under the existing
   // maintenance lease. This second check rejects surviving application clients.
   for(const d of domains){const others=(await d.pool.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",[])).rows[0].n;if(others)throw new Error('PG_OPERATIONS_ACTIVE_CLIENTS');}
   return work({active:true,pendingMutations:0});
  },
  async readCheckpoint({domain,client}){return {...identity[domain],restore:await require('./paired-checkpoint').captureCheckpoint(client,domain)};},
  async runDump({domain,database,snapshotId,targetFile}){
   const account=domains.find(d=>d.domain===domain);
   await nativeTool(config,'pg_dump',{account,database,argv:['--format=custom','--compress=gzip:1','--snapshot='+snapshotId,'--role=gp_'+domain+'_owner']},{outputFile:targetFile,errorFile:config.workDirectory+'/'+runId+'-'+domain+'-dump.error'});
   await nativeTool(config,'pg_restore',{account,database,argv:['--list',targetFile]},{outputFile:config.workDirectory+'/'+runId+'-'+domain+'-catalog',errorFile:config.workDirectory+'/'+runId+'-'+domain+'-catalog.error'});
  },
  async captureRecoveryFiles({directory}){
   for(const name of ['private','branding-kits']){
    const source=path.join(config.sourceFiles,name);if(fs.existsSync(source))fs.cpSync(source,path.join(directory,name),{recursive:true,errorOnExist:true,force:false,dereference:false});
   }
   fs.copyFileSync(config.environmentFile,directory+'/configuration.env',fs.constants.COPYFILE_EXCL);fs.chmodSync(directory+'/configuration.env',0o600);
   fs.writeFileSync(directory+'/postgresql-operations.json',JSON.stringify(config)+'\n',{flag:'wx',mode:0o600});
   if(config.mode==='productive')for(const [name,source] of [['postgresql-application.json','/etc/grabenplaner/postgresql-application.json'],['postgresql-pair.json','/var/lib/grabenplaner/data/postgresql-pair.json']]){
    fs.copyFileSync(source,directory+'/'+name,fs.constants.COPYFILE_EXCL);fs.chmodSync(directory+'/'+name,0o600);
   }
   await nativeTool(config,'pg_dumpall',{account:config.administrator,database:'postgres',argv:['--roles-only','--no-role-passwords']},{outputFile:directory+'/roles.sql',errorFile:config.workDirectory+'/'+runId+'-roles.error'});
  }
 });
 if(config.mode==='productive'){
  const status=require('./status'),previous=status.readStatus(config.binding);
  const pending=previous.state==='preparing'&&previous.requestId&&Date.now()-Date.parse(previous.acceptedAt)<1500000;
  status.writeStatus(config,{state:pending?'preparing':'ok',code:null,...(pending?{}:{action:null,requestId:null,acceptedAt:null}),
   backup:{verified:true,createdAt:result.createdAt,manifestSha256:result.sha256,provider:'postgresql',databaseCount:2}});
 }
 return {ok:true,...result,path:result.bundle,amuBackup:result.bundle+'/private/amu'};}finally{await Promise.allSettled(domains.map(d=>d.pool.end()));}
}
async function monitor(config){
 const result={};for(const d of config.domains){const pool=new Pool(url(config,d,'monitor'));try{result[d.domain]=await readPairedDatabaseStatus({pool,database:d.database,role:config.monitor.role});}finally{await pool.end();}}return result;
}
async function latestBackup(config,{short=false,maximumAgeHours=36}={}){
 if(!Number.isInteger(maximumAgeHours)||maximumAgeHours<1||maximumAgeHours>168)throw new Error('PG_OPERATIONS_BACKUP_AGE');
 const markers=fs.readdirSync(config.backupDirectory).filter(n=>/^[a-f0-9-]{36}\.pair\.complete\.json$/.test(n)).map(n=>path.join(config.backupDirectory,n)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
 if(!markers.length)throw new Error('PG_OPERATIONS_BACKUP_MISSING');
 const marker=markers[0],directory=marker.replace(/\.complete\.json$/,'');
 const proof=await require('./paired-bundle').verifyPairBundle(directory,marker,{verifyContent:!short});
 const age=Date.now()-Date.parse(proof.manifest.createdAt);
 if(!Number.isFinite(age)||age< -300000||age>maximumAgeHours*3600000)throw new Error('PG_OPERATIONS_BACKUP_STALE');
 return {verified:true,verificationScope:proof.verificationScope,manifestSha256:proof.manifestSha256,createdAt:proof.manifest.createdAt,ageSeconds:Math.max(0,Math.floor(age/1000)),files:proof.files};
}
module.exports={FORMAT,loadConfiguration,inspectPair,createBackup,monitor,nativeTool,url,latestBackup};

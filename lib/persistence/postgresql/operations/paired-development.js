'use strict';
// Native two-database recovery qualification. Fixed private development roots
// and loopback ports prevent this tool from selecting the productive cluster.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {Client}=require('pg');
const {connect,fileHash,ownership}=require('../transfer/history');
const {verifyPair}=require('../transfer/verify-pair');
const {verifyEnvironment}=require('../core/environment');
const {verifyCoreSchema}=require('../boundary/migrate');
const {schemaFingerprint}=require('../core/fingerprint');
const {SCHEMAS,SEARCH_PATH}=require('../sales/layout');
const BASE='/home/gpadmin/grabenplaner-pg-migration-20260912';
const ROOT=BASE+'/recovery-10',BIN='/usr/lib/postgresql/18/bin';
const MARKER='grabenplaner-paired-recovery-10-v1';
const q=value=>'"'+value.replace(/"/g,'""')+'"';

function guard({reserve=true}={}){
  if(process.platform!=='linux'||process.getuid()===0||fs.realpathSync(BASE)!==BASE||fs.readFileSync(BASE+'/ownership-marker','utf8').trim()!=='grabenplaner-postgresql-migration-development-v1')throw new Error('PG_PAIR_ENVIRONMENT');
  if(fs.realpathSync(ROOT)!==ROOT||fs.readFileSync(ROOT+'/ownership-marker','utf8').trim()!==MARKER||(fs.statSync(ROOT).mode&0o077))throw new Error('PG_PAIR_OWNERSHIP');
  if(reserve&&fs.statfsSync(ROOT).bavail*fs.statfsSync(ROOT).bsize<12*1024**3)throw new Error('PG_PAIR_DISK_RESERVE');
}
function initialize(){
  if(process.platform!=='linux'||fs.realpathSync(BASE)!==BASE||fs.existsSync(ROOT))throw new Error('PG_PAIR_NEW_ROOT_REQUIRED');
  if(fs.readFileSync(BASE+'/ownership-marker','utf8').trim()!=='grabenplaner-postgresql-migration-development-v1')throw new Error('PG_PAIR_ENVIRONMENT');
  fs.mkdirSync(ROOT,{mode:0o700});fs.writeFileSync(ROOT+'/ownership-marker',MARKER+'\n',{flag:'wx',mode:0o600});guard();
}
function credentials(){return JSON.parse(fs.readFileSync(BASE+'/credentials.json','utf8'));}
function connectionString(domain,purpose='migrator',port=55482){
  const name=domain==='admin'?'gp_migration_admin':`gp_${domain}_${purpose}`;
  return `postgresql://${encodeURIComponent(name)}:${encodeURIComponent(credentials().accounts[name])}@127.0.0.1:${port}/${domain==='admin'?'postgres':'gp_migration_'+domain}`;
}
function environment(role,database,port=55482){
  return {PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PGHOST:'127.0.0.1',PGPORT:String(port),PGUSER:role,PGDATABASE:database,PGPASSWORD:credentials().accounts[role],PGCONNECT_TIMEOUT:'10'};
}
async function command(name,args,{env={},output,log,timeout=15*60*1000}={}){
  guard({reserve:!(name==='pg_ctl'&&args.includes('stop'))});if(!['pg_dump','pg_dumpall','pg_restore','initdb','pg_ctl','psql','pg_basebackup','pg_verifybackup'].includes(name))throw new Error('PG_PAIR_TOOL');
  if(['initdb','pg_ctl'].includes(name)){
    const target=args[args.indexOf('-D')+1];
    if(!args.includes('-D')||!target.startsWith(ROOT+'/')||path.resolve(target)!==target)throw new Error('PG_PAIR_CLUSTER_PATH');
    if(name==='pg_ctl'){
      if(fs.realpathSync(target)!==target||fs.readFileSync(target+'/PG_VERSION','utf8').trim()!=='18')throw new Error('PG_PAIR_CLUSTER_IDENTITY');
      if(fs.existsSync(target+'/postmaster.pid')){
        const lines=fs.readFileSync(target+'/postmaster.pid','utf8').split('\n');
        if(lines[1]!==target||!['55484','55485'].includes(lines[3])||fs.realpathSync('/proc/'+lines[0]+'/exe')!==BIN+'/postgres')throw new Error('PG_PAIR_PROCESS_IDENTITY');
      }
    }
  }
  for(const file of [output,log].filter(Boolean))if(path.dirname(file)!==ROOT&&!path.dirname(file).startsWith(ROOT+'/'))throw new Error('PG_PAIR_TOOL_OUTPUT');
  const out=fs.openSync(output||ROOT+'/tool.stdout','w',0o600),err=fs.openSync(log||ROOT+'/tool.stderr','w',0o600),started=performance.now();
  const child=spawn(BIN+'/'+name,args,{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',...env},stdio:['ignore',out,err]});
  fs.closeSync(out);fs.closeSync(err);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('PG_PAIR_TOOL_TIMEOUT'));},timeout);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('PG_PAIR_TOOL_START'));});
    child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Object.assign(new Error('PG_PAIR_TOOL_FAILED'),{tool:name,exitCode:code}));});
  });
  return {tool:name,milliseconds:Math.round(performance.now()-started)};
}
async function regularDigest(root){
  const entries=[];
  async function walk(directory){for(const name of fs.readdirSync(directory).sort()){
    const file=path.join(directory,name),stat=fs.lstatSync(file);
    if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())||fs.realpathSync(file)!==file)throw new Error('PG_PAIR_FILE_TYPE');
    if(stat.isDirectory())await walk(file);else{if(stat.nlink!==1)throw new Error('PG_PAIR_HARDLINK');entries.push({file:path.relative(root,file),bytes:stat.size,sha256:await fileHash(file)});}
  }}
  await walk(root);return entries;
}
async function verifyBundle(){
  guard();const directory=ROOT+'/bundle',commit=JSON.parse(fs.readFileSync(ROOT+'/bundle.complete.json','utf8'));
  if(commit.kind!==MARKER||commit.manifestSha256!==await fileHash(directory+'/manifest.json'))throw new Error('PG_PAIR_MANIFEST_HASH');
  const manifest=JSON.parse(fs.readFileSync(directory+'/manifest.json','utf8'));
  const actual=(await regularDigest(directory)).filter(e=>e.file!=='manifest.json');
  if(JSON.stringify(actual)!==JSON.stringify(manifest.files))throw new Error('PG_PAIR_COMPONENT_HASH');
  if(manifest.databases?.join(',')!=='gp_migration_core,gp_migration_sales')throw new Error('PG_PAIR_DATABASE_SET');
  return manifest;
}
// pg_dump omits explicit ACLs that are identical to PostgreSQL's defaults.
// Materialize those same defaults after restore so the strict source structure
// digest remains reproducible. No grant beyond the existing default is added.
const {materializeDefaultPrivileges}=require('./restore-privileges');

async function createBundle(){
  guard();if(fs.existsSync(ROOT+'/bundle')||fs.existsSync(ROOT+'/bundle.complete.json'))throw new Error('PG_PAIR_BUNDLE_EXISTS');
  const directory=ROOT+'/bundle';fs.mkdirSync(directory,{mode:0o700});
  const evidence=JSON.parse(fs.readFileSync(BASE+'/historical-9/transfer-second.json','utf8'));
  if(!evidence.verified)throw new Error('PG_PAIR_TRANSFER_REQUIRED');
  let core,sales;const clients={},timings=[];
  try{
    core=clients.core=await connect('core',connectionString('core'));sales=clients.sales=await connect('sales',connectionString('sales'));
    for(const [domain,client] of Object.entries(clients)){
      await client.query('SELECT pg_advisory_lock(9261207)');
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await client.query('SET LOCAL ROLE gp_'+domain+'_owner');await client.query("SET LOCAL lock_timeout='5s';SET LOCAL idle_in_transaction_session_timeout='15min'");
      const busy=(await client.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rows[0].count;
      if(busy)throw new Error('PG_PAIR_WRITERS_NOT_DRAINED');
      const tables=(await client.query('SELECT schemaname,tablename FROM pg_tables WHERE schemaname=ANY($1::text[])',[domain==='core'?['gp']:SCHEMAS])).rows;
      await client.query('LOCK TABLE '+tables.map(t=>q(t.schemaname)+'.'+q(t.tablename)).join(',')+' IN SHARE MODE');
    }
    const snapshots={};
    for(const [domain,client] of Object.entries(clients))snapshots[domain]=(await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    for(const domain of ['core','sales']){
      timings.push(await command('pg_dump',['--format=custom','--compress=gzip:1','--snapshot='+snapshots[domain],'--role=gp_'+domain+'_owner'],{env:environment('gp_'+domain+'_migrator','gp_migration_'+domain),output:directory+'/'+domain+'.dump',log:ROOT+'/'+domain+'-dump.log'}));
      await command('pg_restore',['--list',directory+'/'+domain+'.dump'],{output:ROOT+'/'+domain+'-contents.txt',log:ROOT+'/'+domain+'-list.log'});
    }
    await command('pg_dumpall',['--roles-only','--no-role-passwords'],{env:environment('gp_migration_admin','postgres'),output:directory+'/roles.sql',log:ROOT+'/roles-dump.log'});
    for(const name of ['private','branding-kits'])fs.cpSync(BASE+'/historical-9/source/'+name,directory+'/'+name,{recursive:true});
    fs.copyFileSync(BASE+'/historical-9/source/configuration.env',directory+'/configuration.env');fs.chmodSync(directory+'/configuration.env',0o600);
    fs.copyFileSync(BASE+'/credentials.json',directory+'/database-credentials.json');fs.chmodSync(directory+'/database-credentials.json',0o600);
    fs.copyFileSync(BASE+'/historical-9/transfer-second.json',directory+'/content-evidence.json');
    const manifest={version:1,kind:MARKER,createdAt:new Date().toISOString(),databases:['gp_migration_core','gp_migration_sales'],quiescence:'no-other-clients-and-share-locks-on-both-databases',contentSha256:evidence.contentSha256,files:await regularDigest(directory),timings,productActivation:false};
    fs.writeFileSync(directory+'/manifest.json',JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
    await sales.query('COMMIT');await core.query('COMMIT');
    fs.writeFileSync(ROOT+'/bundle.complete.json',JSON.stringify({kind:MARKER,manifestSha256:await fileHash(directory+'/manifest.json')})+'\n',{mode:0o600,flag:'wx'});
    await verifyBundle();return {bundleCreated:true,files:manifest.files.length,bytes:manifest.files.reduce((n,f)=>n+f.bytes,0),timings};
  }catch(error){await Promise.allSettled(Object.values(clients).map(c=>c.query('ROLLBACK')));throw error;}
  finally{await Promise.allSettled(Object.values(clients).map(c=>c.end()));}
}
async function restoreBundle({attempt=1,source='local'}={}){
  if(!['local','offsite'].includes(source))throw new Error('PG_PAIR_RESTORE_SOURCE');
  const proofFile=ROOT+(source==='local'?'/logical-verification.json':'/offsite-restore-verification.json');
  if(!Number.isInteger(attempt)||attempt<1||attempt>3||fs.existsSync(proofFile))throw new Error('PG_PAIR_RESTORE_ATTEMPT');
  let manifest,directory,offsite;
  if(source==='local'){manifest=await verifyBundle();directory=ROOT+'/bundle';}
  else{
    guard();directory=ROOT+'/offsite-return/postgresql-block10.pair';
    offsite=JSON.parse(fs.readFileSync(ROOT+'/offsite-return/return-receipt.json','utf8'));
    if(offsite.offsiteRoundTrip!==true||!/^[a-f0-9]{64}$/.test(offsite.snapshotId))throw new Error('PG_PAIR_OFFSITE_RECEIPT');
    const verified=await require('./paired-bundle').verifyPairBundle(directory,directory+'.complete.json',{expectedSha256:offsite.manifestSha256});manifest=verified.manifest;
  }
  const data=ROOT+(source==='local'?'/logical-data':'/offsite-data')+(attempt===1?'':'-'+attempt);
  if(fs.existsSync(data))throw new Error('PG_PAIR_RESTORE_TARGET_EXISTS');
  const password=ROOT+'/bootstrap.password';fs.writeFileSync(password,credentials().accounts.gp_migration_admin+'\n',{flag:'wx',mode:0o600});
  try{await command('initdb',['-D',data,'-U','gp_migration_admin','--auth-local=scram-sha-256','--auth-host=scram-sha-256','--encoding=UTF8','--locale=C.UTF-8','--pwfile='+password],{log:ROOT+'/initdb.log'});}finally{fs.unlinkSync(password);}
  fs.appendFileSync(data+'/postgresql.conf',"\nlisten_addresses='127.0.0.1'\nport=55484\nunix_socket_directories=''\nshared_buffers='64MB'\nwork_mem='4MB'\nmaintenance_work_mem='32MB'\nmax_connections=20\nmax_locks_per_transaction=256\nlog_min_messages=warning\n");
  await command('pg_ctl',['-D',data,'-l',ROOT+'/logical-server.log','-w','start'],{log:ROOT+'/logical-start.log'});
  let admin,core,sales;const timings=[];
  try{
    admin=new Client({connectionString:connectionString('admin','migrator',55484)});await admin.connect();
    const roles=fs.readFileSync(directory+'/roles.sql','utf8').replace(/^CREATE ROLE gp_migration_admin;\r?\n/m,'');
    const rolesFile=ROOT+'/roles.restore-'+source+'-'+attempt+'.sql';fs.writeFileSync(rolesFile,roles,{flag:'wx',mode:0o600});
    await command('psql',['--no-psqlrc','--set=ON_ERROR_STOP=1','--file='+rolesFile],{env:environment('gp_migration_admin','postgres',55484),log:ROOT+'/roles-restore-'+attempt+'.log'});
    for(const [name,password] of Object.entries(credentials().accounts)){
      if(!/^gp_(?:(?:core|sales)_(?:app|reader|migrator)|migration_admin)$/.test(name))throw new Error('PG_PAIR_ROLE_SET');
      const {rows}=await admin.query('SELECT format($1::text,$2::text,$3::text) AS command',['ALTER ROLE %I PASSWORD %L',name,password]);await admin.query(rows[0].command);
    }
    for(const domain of ['core','sales'])await admin.query('CREATE DATABASE gp_migration_'+domain+' OWNER gp_'+domain+'_owner TEMPLATE template0 ENCODING \'UTF8\' LOCALE \'C.UTF-8\'');
    for(const domain of ['core','sales']){
      timings.push(await command('pg_restore',['--exit-on-error','--single-transaction','--dbname=gp_migration_'+domain,directory+'/'+domain+'.dump'],{env:environment('gp_migration_admin','gp_migration_'+domain,55484),log:ROOT+'/'+domain+'-restore-'+attempt+'.log'}));
      const owner=new Client({connectionString:connectionString('admin','migrator',55484).replace('/postgres','/gp_migration_'+domain)});
      try{await owner.connect();await materializeDefaultPrivileges(owner,domain==='core'?['gp']:SCHEMAS);}finally{await owner.end();}
    }
    core=new Client({connectionString:connectionString('core','migrator',55484)});sales=new Client({connectionString:connectionString('sales','migrator',55484)});await core.connect();await sales.connect();
    for(const [domain,client] of [['core',core],['sales',sales]]){await verifyEnvironment(client,{domain,purpose:'migrator'});await client.query('SET search_path='+(domain==='core'?'pg_catalog,gp':SEARCH_PATH));}
    await verifyCoreSchema(core);
    const expected=(await sales.query('SELECT target_sha256 FROM gp.sales_migration_history ORDER BY stage DESC LIMIT 1')).rows[0].target_sha256;
    if(expected!==await schemaFingerprint(sales,SCHEMAS))throw new Error('PG_PAIR_RESTORED_SCHEMA');
    const evidence=JSON.parse(fs.readFileSync(directory+'/content-evidence.json','utf8'));
    const proof=await verifyPair(core,sales,evidence,{onProgress:value=>console.log(JSON.stringify(value))});
    const protectedEnvironment=require('node:util').parseEnv(fs.readFileSync(directory+'/configuration.env','utf8')),key=protectedEnvironment.GRABENPLANER_AMU_KEY_ID;
    const protectedFiles=require('../../../amu-storage').validateEncryptionKeyForStorage({sourceDirectory:directory+'/private/amu',encryptionKeys:{[key]:protectedEnvironment.GRABENPLANER_AMU_KEY},activeKeyId:key});
    const result={checkedAt:new Date().toISOString(),logicalRestore:true,...proof,timings,bundleManifestSha256:await fileHash(directory+'/manifest.json'),filesVerified:manifest.files.length,encryptedFiles:protectedFiles.fileCount,dataDirectory:data,port:55484,attempt,source,offsiteSnapshotId:offsite?.snapshotId||null,productActivation:false};
    fs.writeFileSync(proofFile,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});return result;
  }finally{
    await Promise.allSettled([core?.end(),sales?.end(),admin?.end()]);
    await command('pg_ctl',['-D',data,'-m','fast','-w','stop'],{log:ROOT+'/logical-stop.log'});
  }
}
module.exports={BASE,ROOT,BIN,MARKER,guard,initialize,credentials,connectionString,environment,command,regularDigest,verifyBundle,createBundle,restoreBundle,materializeDefaultPrivileges};

'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),{Client,Pool}=require('pg'),R=require('../../lib/persistence/postgresql/operations/paired-development');
const {readPairedDatabaseStatus,evaluatePairedStatus}=require('../../lib/persistence/postgresql/operations/paired-monitor');
async function main(){
 R.guard();const role='gp_operations_monitor',credentialFile=R.ROOT+'/monitor-credentials.json';
 const admin=new Client({connectionString:R.connectionString('admin')});const pools=[];
 try{
  await admin.connect();
  if(fs.existsSync(credentialFile)||(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)throw new Error('PG_PAIR_MONITOR_ALREADY_INITIALIZED');
  const password=crypto.randomBytes(32).toString('base64url');
  const sql=(await admin.query('SELECT format($1::text,$2::text,$3::text) AS sql',['CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',role,password])).rows[0].sql;
  await admin.query(sql);await admin.query('GRANT pg_monitor TO gp_operations_monitor;GRANT CONNECT ON DATABASE gp_migration_core,gp_migration_sales TO gp_operations_monitor');
  fs.writeFileSync(credentialFile,JSON.stringify({role,password})+'\n',{mode:0o600,flag:'wx'});
  const states={};
  for(const domain of ['core','sales']){
   const database='gp_migration_'+domain,pool=new Pool({connectionString:`postgresql://${role}:${password}@127.0.0.1:55482/${database}`,max:1});pools.push(pool);
   states[domain]=await readPairedDatabaseStatus({pool,database,role});
   await require('node:assert/strict').rejects(pool.query('SELECT * FROM gp.employees'),e=>['42501','42P01'].includes(e.code));
  }
  const offsite=JSON.parse(fs.readFileSync(R.ROOT+'/offsite-return/return-receipt.json','utf8'));
  const status=evaluatePairedStatus({...states,recoveryPolicy:'wal-15m',freeBytes:fs.statfsSync(R.ROOT).bavail*fs.statfsSync(R.ROOT).bsize,offsite:{verified:true,checkedAt:offsite.checkedAt,manifestSha256:offsite.manifestSha256,sourceManifestSha256:offsite.manifestSha256},backup:{verified:true,checkedAt:offsite.checkedAt,manifestSha256:offsite.manifestSha256},restore:JSON.parse(fs.readFileSync(R.ROOT+'/logical-verification.json','utf8'))});
  if(status.healthy||!status.reasons.includes('WAL_ARCHIVE_DISABLED')||!status.reasons.includes('OFFSITE_WAL_MISSING_OR_STALE'))throw new Error('PG_PAIR_MONITOR_FALSE_READY');
  fs.writeFileSync(R.ROOT+'/monitor-verification.json',JSON.stringify({verified:true,readOnlyIdentity:true,businessReadDenied:true,status,productActivation:false},null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify({verified:true,reasons:status.reasons}));
 }finally{await Promise.allSettled([admin.end(),...pools.map(p=>p.end())]);}
}
main().catch(e=>{console.error(JSON.stringify({failed:true,code:e.code||null,error:e.message}));process.exitCode=1;});

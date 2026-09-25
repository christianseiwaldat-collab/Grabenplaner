'use strict';
// Disposable local qualification only. No product URL, Windows service or host change.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process'),{Client}=require('pg');
const root=path.resolve(__dirname,'../../..'),bin=path.join(root,'tmp/trade-postgresql-runtime/pgsql/bin'),marker='trade-local-native-qualification-v1';
const stateFile=path.join(root,'tmp/trade-native-state.json');
function command(exe,args,options={}){const r=spawnSync(exe,args,{cwd:root,windowsHide:true,encoding:'utf8',...options});if(r.status!==0)throw Error(path.basename(exe)+' failed: '+(r.stderr||r.stdout||r.error));return r.stdout;}
const databaseUrl=(state,role,database)=>`postgresql://${role}:${state.accounts[role]}@127.0.0.1:${state.port}/${database}`;
function state(){const s=JSON.parse(fs.readFileSync(stateFile));if(s.marker!==marker||!s.directory.startsWith(path.join(root,'tmp')+path.sep)||fs.readFileSync(path.join(s.directory,'ownership-marker'),'utf8')!==marker)throw Error('Qualification ownership mismatch');return s;}
async function bootstrap(){
 if(fs.existsSync(stateFile))throw Error('Existing qualification state; refusing a second cluster');
 const directory=fs.mkdtempSync(path.join(root,'tmp/trade-native-')),port=55484;
 command('icacls.exe',[directory,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`,'SYSTEM:(OI)(CI)F']);
 fs.writeFileSync(path.join(directory,'ownership-marker'),marker);
 const accounts=Object.fromEntries(['gp_migration_admin',...['core','sales'].flatMap(d=>['migrator','app','reader'].map(p=>'gp_'+d+'_'+p))].map(r=>[r,crypto.randomBytes(32).toString('hex')]));
 const s={marker,directory,port,accounts};fs.writeFileSync(path.join(directory,'credentials.json'),JSON.stringify(s));
 // The public state pointer contains no credentials; credentials stay under its private ACL.
 fs.writeFileSync(stateFile,JSON.stringify({marker,directory,port}));
 fs.writeFileSync(path.join(directory,'admin-password'),accounts.gp_migration_admin+'\n');
 fs.writeFileSync(path.join(directory,'initdb.log'),command(path.join(bin,'initdb.exe'),['-D',path.join(directory,'data'),'-U','gp_migration_admin','--pwfile='+path.join(directory,'admin-password'),'--auth=scram-sha-256','--encoding=UTF8','--locale=C']));
 fs.appendFileSync(path.join(directory,'data/postgresql.conf'),`\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nmax_connections=30\nmax_locks_per_transaction=256\nshared_buffers='64MB'\nwork_mem='4MB'\nmaintenance_work_mem='32MB'\nmax_wal_size='256MB'\nstatement_timeout='30s'\nlock_timeout='3s'\nidle_in_transaction_session_timeout='60s'\nlog_statement='none'\nlog_min_error_statement='panic'\nlog_parameter_max_length_on_error=0\npassword_encryption='scram-sha-256'\n`);
 command(path.join(bin,'pg_ctl.exe'),['-D',path.join(directory,'data'),'-l',path.join(directory,'postgresql.log'),'-w','start'],{stdio:'ignore'});
 await provision(s);
}
async function provision(s){
 const {directory,port,accounts}=s;
 const admin=new Client({connectionString:databaseUrl(s,'gp_migration_admin','postgres')});await admin.connect();
 try{
  const actual=(await admin.query('SHOW data_directory')).rows[0].data_directory;if(path.resolve(actual)!==path.join(directory,'data'))throw Error('Unexpected local data directory');
  await admin.query('REVOKE CONNECT ON DATABASE postgres FROM PUBLIC; REVOKE CONNECT ON DATABASE template1 FROM PUBLIC');
  for(const domain of ['core','sales']){
   const owner='gp_'+domain+'_owner',db='gp_migration_'+domain;await admin.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
   for(const purpose of ['migrator','app','reader']){const role='gp_'+domain+'_'+purpose;await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${accounts[role]}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${purpose==='app'?8:5}; ALTER ROLE ${role} SET search_path TO pg_catalog`);}
   await admin.query(`GRANT ${owner} TO gp_${domain}_migrator`);await admin.query(`CREATE DATABASE ${db} OWNER ${owner}`);await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC; GRANT CONNECT ON DATABASE ${db} TO gp_${domain}_migrator,gp_${domain}_app,gp_${domain}_reader`);
   const c=new Client({connectionString:databaseUrl(s,'gp_migration_admin',db)});await c.connect();try{
    await c.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE SCHEMA gp AUTHORIZATION ${owner}; GRANT USAGE ON SCHEMA gp TO gp_${domain}_app,gp_${domain}_reader; SET ROLE ${owner}; CREATE TABLE gp.environment_contract(environment_id text PRIMARY KEY,domain text NOT NULL,profile text NOT NULL)`);
    const E=require('../../../lib/persistence/postgresql/core/environment');await c.query('INSERT INTO gp.environment_contract VALUES($1,$2,$3)',[E.ENVIRONMENT_ID,domain,E.PROFILE]);await c.query(`GRANT SELECT ON gp.environment_contract TO gp_${domain}_app,gp_${domain}_reader`);
   }finally{await c.end();}
  }
 }finally{await admin.end();}
 console.log('Private loopback PostgreSQL cluster created on port '+port);
}
async function main(){
 const mode=process.argv[2];if(mode==='bootstrap')return bootstrap();
 const pointer=state(),s=JSON.parse(fs.readFileSync(path.join(pointer.directory,'credentials.json')));
 if(mode==='provision')return provision(s);
 if(mode==='start'){command(path.join(bin,'pg_ctl.exe'),['-D',path.join(s.directory,'data'),'-l',path.join(s.directory,'postgresql.log'),'-w','start'],{stdio:'ignore'});console.log('Own local PostgreSQL cluster started');return;}
 if(mode==='stop'){command(path.join(bin,'pg_ctl.exe'),['-D',path.join(s.directory,'data'),'-m','fast','-w','stop']);console.log('Own local PostgreSQL cluster stopped');return;}
 if(mode==='migrate'){
  for(const domain of ['core','sales']){const c=new Client({connectionString:databaseUrl(s,'gp_'+domain+'_migrator','gp_migration_'+domain)});await c.connect();try{
   if(domain==='core'){console.log(await require('../../../lib/persistence/postgresql/core/migrate').migrateCoreDevelopment(c));console.log(await require('../../../lib/persistence/postgresql/boundary/migrate').migrateBoundaryCore(c));console.log(await require('../../../lib/persistence/postgresql/core/trade-annotations').migrate(c));}
   else for(let stage=5;stage<=8;stage++)console.log(await require('../../../lib/persistence/postgresql/sales/migrate').migrateSalesDevelopment(c,stage));
  }finally{await c.end();}}return;
 }
 if(mode==='test'){
  const env={...process.env};for(const d of ['core','sales'])for(const p of ['migrator','app','reader'])env['GP_'+d.toUpperCase()+'_'+p.toUpperCase()+'_URL']=databaseUrl(s,'gp_'+d+'_'+p,'gp_migration_'+d);
  const files=process.argv.slice(3);if(!files.length||files.some(p=>!/^test\/[a-z0-9-]+\.test\.js$/.test(p)))throw Error('Explicit local test files required');
  const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{cwd:root,windowsHide:true,encoding:'utf8',env,maxBuffer:8*1024*1024});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exitCode=result.status||0;return;
 }
 throw Error('Use bootstrap, migrate, test or stop');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

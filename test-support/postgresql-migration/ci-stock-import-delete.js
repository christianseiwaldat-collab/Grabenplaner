'use strict';
// Fresh GitHub Actions service container only; never connects to a product DB.
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),{Client}=require('pg');
async function main(){
 const diagnosticIndex=process.argv.indexOf('--diagnostic-api');
 const diagnosticGroups=Object.freeze({
  foundations:['test/portal-foundation-https.test.js','test/portal-foundation-loopback.test.js','test/portal-foundation-scope.test.js','test/v057-codespaces-demo.test.js'],
  rights:['test/personnel-learning-rights-hierarchy.test.js','test/portal-birthday-presentation-claim-api.test.js','test/portal-birthday-presentation-settings-api.test.js','test/v058-personnel-rights-encryption.test.js','test/v059-sickness-integration.test.js','test/v060-portal-mobile-foundation.test.js'],
  sales:['test/postgresql-api-native-fixture.test.js','test/postgresql-startup-category-defaults.test.js','test/postgresql-startup-policy-defaults.test.js','test/branch-sales-api.test.js','test/sales-analytics-production-hardening.test.js','test/sales-article-catalog-detail-route.test.js','test/sales-article-catalog-import-api.test.js','test/schedule-duty-persistence-api.test.js','test/v056-wifi-foundation.test.js','test/postgresql-ascii-nocase-parity.test.js'],
 });
 const diagnosticGroup=diagnosticIndex<0?null:process.argv[diagnosticIndex+1];
 if(diagnosticIndex>=0&&(!Object.hasOwn(diagnosticGroups,diagnosticGroup)||process.argv.includes('--full')||process.argv.includes('--bootstrap-only')))throw new Error('Explicit bounded diagnostic API group required');
 const connection=new URL(process.env.TEST_POSTGRESQL_URL||'');
 const local=process.env.GP_CI_POSTGRESQL_FIXTURE==='owned-local-service-v1';
 let marker;
 if(local){
  const file=process.env.GP_PG_LOCAL_FIXTURE_MARKER;
  if(!file||!path.isAbsolute(file)||fs.realpathSync(file)!==file)throw new Error('Owned local fixture marker required');
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077))throw new Error('Unsafe local fixture marker');
  marker=JSON.parse(fs.readFileSync(file,'utf8'));
  if(marker.format!=='gp-postgresql-only-owned-local-v1'||marker.host!=='127.0.0.1'||marker.port!==5432||marker.database!=='grabenplaner_test'||!/^\d+$/.test(marker.clusterId||''))throw new Error('Invalid local fixture marker');
 }
 if((!local&&(process.env.CI!=='true'||process.env.GITHUB_ACTIONS!=='true'))||connection.hostname!=='127.0.0.1'||connection.port!=='5432'||connection.pathname!=='/grabenplaner_test'||connection.username!=='postgres')throw new Error('CI synthetic database required');
 const client=new Client({connectionString:connection.href});await client.connect();
 const env={...process.env,GP_PG_MIGRATION_LIVE:'1',GP_MIGRATION_ADMIN_URL:connection.href,
  GP_CI_POSTGRESQL_FIXTURE:local?'owned-local-service-v1':'github-actions-service-v1'};
 if(diagnosticGroup){
  env.GP_PG_API_DIAGNOSTIC='bounded-errors-v1';
  env.NODE_OPTIONS=(env.NODE_OPTIONS||'')+' --require='+JSON.stringify(path.resolve(__dirname,'../postgresql-api/diagnostic-errors.js'));
  env.NODE_OPTIONS+=' --require='+JSON.stringify(path.resolve(__dirname,'../postgresql-api/diagnostic-shutdown.js'));
 }
 try {
  if(local&&(await client.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id!==marker.clusterId)throw new Error('Local fixture cluster identity changed');
  // Preserve the isolated development role contract on the service container.
  // Superuser setup retains access; application roles cannot enter maintenance DBs.
  await client.query('REVOKE CONNECT ON DATABASE postgres,template1,grabenplaner_test FROM PUBLIC');
  for(const domain of ['core','sales']){
   const owner='gp_'+domain+'_owner',database='gp_migration_'+domain;
   await client.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
   for(const purpose of ['migrator','app','reader']){
    const role='gp_'+domain+'_'+purpose,password=crypto.randomBytes(32).toString('hex');
    // Match the bounded reader budget used by transfer/staging: the server's
    // three receipt workers and authorization reader coexist with the fixture's
    // independent authority reader and a report worker. Five is insufficient.
    const limit=purpose==='reader'?8:purpose==='app'?(domain==='core'?8:7):5;
    await client.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${limit}`);
    await client.query(`ALTER ROLE ${role} SET search_path TO pg_catalog`);
    await client.query(`ALTER ROLE ${role} SET lock_timeout TO '2s'`);
    const url=new URL(connection);url.pathname='/'+database;url.username=role;url.password=password;env[role.toUpperCase()+'_URL']=url.href;
   }
   await client.query(`GRANT ${owner} TO gp_${domain}_migrator`);
   await client.query(`CREATE DATABASE ${database} OWNER ${owner}`);
   await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
   await client.query(`GRANT CONNECT ON DATABASE ${database} TO gp_${domain}_migrator,gp_${domain}_app,gp_${domain}_reader`);
   const url=new URL(connection);url.pathname='/'+database;
   const setup=new Client({connectionString:url.href});await setup.connect();
   try{
    await setup.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await setup.query(`CREATE SCHEMA gp AUTHORIZATION ${owner}`);
    await setup.query(`GRANT USAGE ON SCHEMA gp TO gp_${domain}_app,gp_${domain}_reader`);
    await setup.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA gp GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO gp_${domain}_app`);
    await setup.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA gp GRANT SELECT ON TABLES TO gp_${domain}_reader`);
    await setup.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA gp GRANT USAGE,SELECT ON SEQUENCES TO gp_${domain}_app`);
    await setup.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA gp REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
   }finally{await setup.end();}
  }
 }finally{await client.end();}
 const commands=[['scripts/postgresql/mark-development-environment.js'],['scripts/postgresql/apply-core-schema.js'],['scripts/postgresql/apply-sales-schema.js','5'],['scripts/postgresql/apply-sales-schema.js','6'],['scripts/postgresql/apply-boundary-schema.js'],['scripts/postgresql/apply-sales-schema.js','8'],
 ['-e',"const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.GP_CORE_MIGRATOR_URL});await c.connect();try{for(const name of ['trade-annotations','personnel-learning-runs','xoffi-snapshots','vocational-school','session-security'])await require('./lib/persistence/postgresql/core/'+name).migrate(c);}finally{await c.end();}})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;})"],
 // Qualify the rollback/upgrade path against the fresh schema first. This also
 // installs the snapshot extension required by imports earlier in discovery order.
 ['--test','--test-concurrency=1','--test-reporter=tap','test/postgresql-stock-import-delete.test.js'],
 ...(diagnosticGroup?[['--require','./test-support/postgresql-api/diagnostic-errors.js','--require','./test-support/postgresql-api/preload.js','--test','--test-concurrency=1','--test-reporter=tap','--test-timeout=180000',...diagnosticGroups[diagnosticGroup]]]:process.argv.includes('--bootstrap-only')?[]:process.argv.includes('--full')
   ? [['--require','./test-support/postgresql-api/preload.js','--test','--test-concurrency=1','--test-reporter=tap','--test-timeout=180000']]
   : [['--test','--test-concurrency=1','test/postgresql-cash-takeover.test.js']])];
 for(const args of commands){const result=spawnSync(process.execPath,args,{env,stdio:'inherit'});if(result.status!==0)throw new Error('Synthetic migration qualification failed: '+args[0]);}
 const outputIndex=process.argv.indexOf('--environment-file');
 if(outputIndex!==-1){
  if(!local||!process.argv.includes('--bootstrap-only'))throw new Error('Fixture environment export is local-bootstrap-only');
  const file=path.resolve(process.argv[outputIndex+1]||'');
  if(path.dirname(file)!==path.dirname(process.env.GP_PG_LOCAL_FIXTURE_MARKER))throw new Error('Fixture environment must remain with its owner marker');
  const selected=Object.fromEntries(Object.entries(env).filter(([key])=>/^(GP_(CORE|SALES)_(APP|READER|MIGRATOR)_URL|GP_MIGRATION_ADMIN_URL|GP_PG_MIGRATION_LIVE|GP_CI_POSTGRESQL_FIXTURE|GP_PG_LOCAL_FIXTURE_MARKER|TEST_POSTGRESQL_(URL|BIN))$/.test(key)));
  fs.writeFileSync(file,JSON.stringify(selected),{flag:'wx',mode:0o600});
 }
}
main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});

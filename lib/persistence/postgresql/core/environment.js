'use strict';
const {createPostgresqlPoolConfiguration}=require('../policy');
const PROFILE='core-migration-development';
const runtimeBinding=require('../runtime-binding');
const ENVIRONMENT_ID='grabenplaner-development-20260912';
function configuration({profile,databaseUrl,domain='core',purpose='app',tlsMode='verify-full',binding}={}) {
  const runtime=profile===runtimeBinding.PROFILE?runtimeBinding.validateBinding(binding):null;
  if((profile!==PROFILE&&!runtime) || !['core','sales'].includes(domain) || !['app','reader','migrator'].includes(purpose) || binding&&!runtime || runtime&&purpose==='migrator') throw new TypeError('Verified database profile required');
  let url;
  try {url=new URL(databaseUrl);} catch {throw new TypeError('Invalid development database configuration');}
  if(url.pathname!==`/${runtime?'grabenplaner':'gp_migration'}_${domain}` || decodeURIComponent(url.username)!==`gp_${domain}_${purpose}`
    || url.search || url.hash) throw new TypeError('Development database and role required');
  return createPostgresqlPoolConfiguration({databaseUrl,tlsMode,applicationName:`gp-migration-${domain}-${purpose}`,
    policy:{maximumConnections:purpose==='app'?(domain==='sales'?2:3):1,statementTimeoutMilliseconds:10000,queryTimeoutMilliseconds:12000,
      transactionTimeoutMilliseconds:30000},allowExitOnIdle:true});
}
async function verifyEnvironment(pool,{domain='core',purpose='app',binding}={}) {
  const runtime=binding?runtimeBinding.validateBinding(binding):null;
  const expectedId=runtime?.environmentId||ENVIRONMENT_ID,expectedProfile=runtime?.profile||PROFILE;
  const result=await pool.query(`SELECT current_database() AS database,current_user AS username,
    r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
    c.environment_id,c.domain,c.profile FROM pg_roles r CROSS JOIN gp.environment_contract c WHERE r.rolname=current_user`);
  const r=result.rows[0];
  if(result.rows.length!==1 || r.database!==`${runtime?'grabenplaner':'gp_migration'}_${domain}` || r.username!==`gp_${domain}_${purpose}`
    || r.rolsuper || r.rolcreatedb || r.rolcreaterole || r.rolreplication || r.rolbypassrls
    || r.environment_id!==expectedId || r.domain!==domain || r.profile!==expectedProfile) throw new Error('Isolated environment verification failed');
  return Object.freeze({environmentId:expectedId,domain,purpose,productActivation:Boolean(runtime)});
}
module.exports={PROFILE,ENVIRONMENT_ID,configuration,verifyEnvironment};

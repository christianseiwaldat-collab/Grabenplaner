'use strict';
const {Pool}=require('pg');
const {assertSyntheticEnvironment}=require('./guard');
const {verifyEnvironment}=require('../../lib/persistence/postgresql/core/environment');

// Current API fixtures only. This never accepts request-provided configuration,
// a default connection string, a productive database, or an unowned data pair.
async function withBackupPools(work){
 assertSyntheticEnvironment();
 if(typeof work!=='function')throw new TypeError('Synthetic backup callback required');
 const domains=[];let primaryFailure;
 try{
  let marker;
  for(const domain of ['core','sales']){
   const value=process.env['GP_'+domain.toUpperCase()+'_MIGRATOR_URL'],url=new URL(value);
   if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.port!=='5432'
    ||url.pathname!=='/gp_migration_'+domain||url.username!=='gp_'+domain+'_migrator'||url.search||url.hash)throw new Error('PG_API_BACKUP_ENDPOINT');
   const pool=new Pool({connectionString:value,max:1,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000});
   domains.push({domain,database:'gp_migration_'+domain,ownerRole:'gp_'+domain+'_owner',pool});
   const client=await pool.connect();let connectionFailure;
   try{
    await client.query('BEGIN READ ONLY');await verifyEnvironment(client,{domain,purpose:'migrator'});
    const rows=(await client.query(domain==='core'?"SELECT value AS id FROM gp.settings WHERE key='migration-test-owner'":'SELECT id FROM gp.migration_fixture_owner')).rows;
    if(rows.length!==1||!/^synthetic-api-[a-f0-9-]{36}$/.test(rows[0].id)||marker&&marker!==rows[0].id)throw new Error('PG_API_BACKUP_OWNED_PAIR_REQUIRED');
    marker=rows[0].id;await client.query('COMMIT');
   }catch(error){connectionFailure=error;try{await client.query('ROLLBACK');}catch{/* Preserve the original verification failure. */}throw error;}finally{client.release(connectionFailure);}
  }
  return await work(domains);
 }catch(error){primaryFailure=error;throw error;}
 finally{
  const ended=await Promise.allSettled(domains.map(domain=>domain.pool.end()));
  if(!primaryFailure&&ended.some(value=>value.status==='rejected'))throw new AggregateError(ended.filter(value=>value.status==='rejected').map(value=>value.reason),'Synthetic backup pool cleanup failed');
 }
}
module.exports={withBackupPools};

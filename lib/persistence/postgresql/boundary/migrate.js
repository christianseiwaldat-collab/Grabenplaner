'use strict';
const {verifyEnvironment}=require('../core/environment');
const {schemaFingerprint}=require('../core/fingerprint');
const {createSchemaPlan}=require('../core/schema');
const {createBoundaryCorePlan}=require('./schema');
async function verifyCoreSchema(client){
  const base=(await client.query('SELECT version,source_sha256,plan_sha256,target_sha256 FROM gp.core_migration_history')).rows,plan=createSchemaPlan();
  if(base.length!==1||base[0].version!==1||base[0].source_sha256!==plan.sourceSchemaSha256||base[0].plan_sha256!==plan.digest)throw new Error('Core base migration drift');
  const exists=(await client.query("SELECT to_regclass('gp.boundary_migration_history') AS name")).rows[0].name;
  let expected=base[0].target_sha256;
  if(exists){
    const rows=(await client.query('SELECT * FROM gp.boundary_migration_history')).rows;
    if(rows.length!==1||rows[0].version!==7||rows[0].plan_sha256!==createBoundaryCorePlan().digest||rows[0].base_target_sha256!==expected)throw new Error('Core boundary migration drift');
    expected=rows[0].target_sha256;
  }
  if(expected!==await schemaFingerprint(client))throw new Error('Core development schema contract mismatch');
  return {boundary:Boolean(exists),baseTarget:base[0].target_sha256};
}
async function migrateBoundaryCore(client){
  await verifyEnvironment(client,{purpose:'migrator'});await client.query('SELECT pg_advisory_lock(9261203)');
  try{
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await client.query('SET LOCAL ROLE gp_core_owner');await client.query('SET LOCAL search_path=pg_catalog,gp');
    const state=await verifyCoreSchema(client),plan=createBoundaryCorePlan();
    if(state.boundary){await client.query('COMMIT');return {applied:false,stage:7,digest:plan.digest};}
    for(const item of plan.statements)await client.query(item.sql);
    const digest=await schemaFingerprint(client);
    await client.query('INSERT INTO gp.boundary_migration_history VALUES(7,$1,$2,$3)',[plan.digest,state.baseTarget,digest]);await client.query('COMMIT');
    return {applied:true,stage:7,digest:plan.digest,statements:plan.statements.length,productActivation:false};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{await client.query('SELECT pg_advisory_unlock(9261203)');}
}
module.exports={migrateBoundaryCore,verifyCoreSchema};

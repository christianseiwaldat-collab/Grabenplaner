'use strict';
const q=value=>'"'+value.replace(/"/g,'""')+'"';
async function implicitLearningFunctions(client,schemas){
  if(!schemas.includes('gp'))return [];
  const exists=(await client.query("SELECT to_regclass('gp.learning_runs_migration_history') AS name")).rows[0].name;
  if(!exists)return [];
  const migration=require('../core/personnel-learning-runs');
  const rows=(await client.query('SELECT version,plan_sha256 FROM gp.learning_runs_migration_history')).rows;
  if(rows.length!==1||rows[0].version!==1||rows[0].plan_sha256!==migration.digest)throw new Error('PG_PAIR_RESTORE_LEARNING_PRIVILEGE_CONTRACT');
  // The additive v1 migration creates these functions with implicit default
  // privileges. Keep their NULL ACL representation; the original core schema
  // instead materialized its defaults explicitly. pg_dump omits both forms of
  // default grants, so blanket materialization changes the mixed schema hash.
  // The immutable migration plan identifies the exact functions, and the
  // subsequent checkpoint still requires the full original schema hash.
  return migration.statements.flatMap(sql=>{
    const match=/^CREATE FUNCTION gp\."(trigger_[a-f0-9]{20})"\(\)/.exec(sql);
    return match?[match[1]]:[];
  });
}
async function materializeDefaultPrivileges(client,schemas){
  const implicitFunctions=await implicitLearningFunctions(client,schemas);
  const functions=(await client.query(`SELECT p.oid::regprocedure::text AS name FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY($1::text[])
    AND p.prokind='f' AND p.proacl IS NULL
    AND NOT (n.nspname='gp' AND p.proname=ANY($2::text[]))`,[schemas,implicitFunctions])).rows;
  for(const row of functions)await client.query('GRANT EXECUTE ON FUNCTION '+row.name+' TO PUBLIC');
  const relations=(await client.query(`SELECT n.nspname,c.relname,pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','v') AND c.relacl IS NULL`,[schemas])).rows;
  for(const row of relations)await client.query('GRANT ALL PRIVILEGES ON TABLE '+q(row.nspname)+'.'+q(row.relname)+' TO '+q(row.owner));
  return {functions:functions.length,relations:relations.length};
}
module.exports={materializeDefaultPrivileges};

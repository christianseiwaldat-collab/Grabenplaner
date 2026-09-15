"use strict";
const crypto=require("node:crypto");
const {TABLES,INDEXES,TRIGGERS}=require("../../sqlite/operations/personnel-learning-runs-schema");
const {compileCoreEntry}=require("./catalog");
const {trigger,identifier}=require("./schema");
const {expression}=require("./sql");
const {schemaFingerprint}=require("./fingerprint");
const names=TABLES.map(t=>t.name);
const qualify=sql=>sql.replace(new RegExp(`(?<![."a-z_])(${names.join("|")})(?![a-z_])`,"g"),"gp.$1");
const CATALOG=require("../../sqlite/personnel-learning-runs-catalog").CATALOG.map(entry=>{const compiled=compileCoreEntry(entry).providerEntry;return {...compiled,sql:qualify(compiled.sql)};});
const statements=[];
for(const item of TABLES) statements.push(qualify(expression(item.sql.replace(/IF NOT EXISTS /g,"").replace(/\bTEXT\b/g,'TEXT COLLATE "C"'))));
for(const item of INDEXES) statements.push(qualify(expression(item.sql.replace(/IF NOT EXISTS /g,"")).replace(new RegExp(`\\b${item.name}\\b`),identifier(item.name))));
for(const item of TRIGGERS) {
  const sql=item.sql.replace(/IF NOT EXISTS /g,"").trim().replace(/;$/,"");
  const table=/\bON\s+(\w+)/i.exec(sql)[1];
  statements.push(...trigger({name:item.name,sql,table_name:table}).map(t=>qualify(t.sql)));
}
for(const table of names) statements.push(`REVOKE ALL ON gp.${table} FROM PUBLIC`,`GRANT SELECT,INSERT ON gp.${table} TO gp_core_app`,`GRANT SELECT ON gp.${table} TO gp_core_reader`);
statements.push("CREATE TABLE gp.learning_runs_migration_history(version INTEGER PRIMARY KEY CHECK(version=1),plan_sha256 TEXT NOT NULL,base_target_sha256 TEXT NOT NULL,target_sha256 TEXT NOT NULL)","REVOKE ALL ON gp.learning_runs_migration_history FROM PUBLIC,gp_core_app,gp_core_reader","GRANT SELECT ON gp.learning_runs_migration_history TO gp_core_app,gp_core_reader");
const digest=crypto.createHash("sha256").update(JSON.stringify(statements)).digest("hex");
async function target(client,base) {
  if(!(await client.query("SELECT to_regclass('gp.learning_runs_migration_history') name")).rows[0].name)return base;
  const rows=(await client.query("SELECT * FROM gp.learning_runs_migration_history")).rows;
  if(rows.length!==1||rows[0].version!==1||rows[0].plan_sha256!==digest||rows[0].base_target_sha256!==base)throw new Error("Learning runs migration contract mismatch");
  return rows[0].target_sha256;
}
async function migrate(client,{binding}={}) {
  await require("./environment").verifyEnvironment(client,{purpose:"migrator",binding});
  await client.query("SELECT pg_advisory_lock(9261215)");
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL ROLE gp_core_owner; SET LOCAL search_path=pg_catalog,gp");
    await require("../boundary/migrate").verifyCoreSchema(client);
    if((await client.query("SELECT to_regclass('gp.learning_runs_migration_history') name")).rows[0].name){await client.query("COMMIT");return {applied:false,digest};}
    const base=await schemaFingerprint(client);
    for(const sql of statements)await client.query(sql);
    const after=await schemaFingerprint(client);
    await client.query("INSERT INTO gp.learning_runs_migration_history VALUES(1,$1,$2,$3)",[digest,base,after]);
    await client.query("COMMIT");return {applied:true,digest,target:after};
  }catch(error){await client.query("ROLLBACK");throw error;}finally{await client.query("SELECT pg_advisory_unlock(9261215)");}
}
module.exports={CATALOG,statements,digest,target,migrate};

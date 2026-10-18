
"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {openSqliteLegacyDatabase}=require("../lib/persistence/sqlite/provider");
const {ensureSqliteSessionSecuritySchema,COLUMNS}=require("../lib/persistence/sqlite/operations/session-security-schema");
const migration=require("../lib/persistence/postgresql/core/session-security");
const BASE=[
 "CREATE TABLE portal_users(employee_number TEXT PRIMARY KEY,password_hash TEXT NOT NULL)",
 "CREATE TABLE portal_organization_accounts(id TEXT PRIMARY KEY,password_hash TEXT NOT NULL)",
 "CREATE TABLE portal_sessions(id TEXT PRIMARY KEY,revoked_at TEXT)",
 "CREATE TABLE portal_organization_sessions(id TEXT PRIMARY KEY,revoked_at TEXT)",
 "CREATE TABLE mobile_sessions(id TEXT PRIMARY KEY,revoked_at TEXT,revoked_reason TEXT,updated_at TEXT)",
 "CREATE TABLE portal_password_reset_tokens(id TEXT PRIMARY KEY,revoked_at TEXT,used_at TEXT)",
 "CREATE TABLE schema_migrations(id TEXT PRIMARY KEY,app_version TEXT NOT NULL)",
 "INSERT INTO portal_users VALUES('personal','legacy-scrypt-v1-preserved')",
 "INSERT INTO portal_organization_accounts VALUES('branch','legacy-org-hash-preserved')",
 "INSERT INTO portal_sessions VALUES('browser',NULL)",
 "INSERT INTO portal_organization_sessions VALUES('organization',NULL)",
 "INSERT INTO mobile_sessions VALUES('mobile',NULL,'',NULL)",
 "INSERT INTO portal_password_reset_tokens VALUES('reset',NULL,NULL)"
];
test("SQLite additive upgrade revokes old credentials once and preserves existing hashes",()=>{
 const db=openSqliteLegacyDatabase(":memory:");
 try{
  BASE.forEach(sql=>db.exec(sql));
  assert.equal(ensureSqliteSessionSecuritySchema(db).applied,true);
  for(const table of ["portal_sessions","portal_organization_sessions","mobile_sessions","portal_password_reset_tokens"])assert.ok(db.prepare("SELECT revoked_at FROM "+table).get().revoked_at);
  assert.equal(db.prepare("SELECT password_hash FROM portal_users").get().password_hash,"legacy-scrypt-v1-preserved");
  assert.equal(db.prepare("SELECT password_policy_version FROM portal_users").get().password_policy_version,0);
  assert.equal(db.prepare("SELECT authenticated_at FROM portal_sessions").get().authenticated_at,null);
  assert.match(db.prepare("SELECT app_version FROM schema_migrations").get().app_version,/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  db.exec("INSERT INTO portal_sessions(id,revoked_at,authenticated_at,absolute_expires_at) VALUES('new',NULL,'2026-10-18T12:00:00.000Z','2026-10-19T00:00:00.000Z')");
  assert.equal(ensureSqliteSessionSecuritySchema(db).applied,false);
  assert.equal(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id='new'").get().revoked_at,null);
 }finally{db.close();}
});
test("SQLite failed upgrade rolls back columns and revocation without a completion marker",()=>{
 const db=openSqliteLegacyDatabase(":memory:");
 try{
  BASE.forEach(sql=>db.exec(sql));
  db.exec("CREATE TRIGGER fail_upgrade BEFORE UPDATE ON mobile_sessions BEGIN SELECT RAISE(ABORT,'synthetic upgrade failure'); END");
  assert.throws(()=>ensureSqliteSessionSecuritySchema(db),/synthetic upgrade failure/);
  assert.equal(db.prepare("PRAGMA table_info(portal_sessions)").all().some(c=>c.name==="authenticated_at"),false);
  assert.equal(db.prepare("SELECT revoked_at FROM portal_sessions").get().revoked_at,null);
  assert.equal(db.prepare("SELECT count(*) n FROM schema_migrations").get().n,0);
  db.exec("DROP TRIGGER fail_upgrade");
  assert.equal(ensureSqliteSessionSecuritySchema(db).applied,true);
  db.exec("ALTER TABLE portal_sessions DROP COLUMN authenticated_at");
  assert.throws(()=>ensureSqliteSessionSecuritySchema(db),/SCHEMA_DRIFT/);
 }finally{db.close();}
});
test("PostgreSQL extension remains additive with a fixed semver ledger and no credential rewrite",()=>{
 assert.equal(migration.COLUMNS.length,6);
 assert.equal(migration.rollbackBoundary.automaticRollback,false);
 assert.equal(migration.rollbackBoundary.destructiveColumnDrop,false);
 assert.ok(migration.statements.every(sql=>!/DROP|password_hash\s*=|must_change_password\s*=/.test(sql)));
 assert.ok(migration.statements.some(sql=>/0\.92\.90-beta/.test(sql)));
 assert.deepEqual(migration.COLUMNS,COLUMNS);
});
test("PostgreSQL native DDL rolls back failure and revokes legacy rows without changing hashes",{skip:!process.env.GP_CORE_MIGRATOR_URL,timeout:30000},async()=>{
 const {Client}=require("pg"),{randomBytes}=require("node:crypto");
 const url=new URL(process.env.GP_CORE_MIGRATOR_URL);assert.equal(url.hostname,"127.0.0.1");assert.equal(url.pathname,"/gp_migration_core");
 const client=new Client({connectionString:url.href}),schema="session_security_test_"+randomBytes(8).toString("hex");
 assert.match(schema,/^session_security_test_[a-f0-9]{16}$/);
 let owned=false;
 const translate=sql=>sql.replace(/\bgp\./g,schema+".");
 try{
  await client.connect();await require("../lib/persistence/postgresql/core/environment").verifyEnvironment(client,{purpose:"migrator"});
  await client.query("BEGIN; SET LOCAL ROLE gp_core_owner");
  await client.query("CREATE SCHEMA "+schema);owned=true;
  await client.query("SET LOCAL search_path="+schema+",pg_catalog");
  for(const sql of BASE)await client.query(sql);
  await client.query("SAVEPOINT before_upgrade");
  for(const sql of migration.statements.slice(0,8))await client.query(translate(sql));
  await assert.rejects(client.query("SELECT 1/0"),error=>error.code==="22012");
  await client.query("ROLLBACK TO SAVEPOINT before_upgrade");
  assert.equal((await client.query("SELECT revoked_at FROM portal_sessions")).rows[0].revoked_at,null);
  assert.equal((await client.query("SELECT count(*) n FROM information_schema.columns WHERE table_schema=$1 AND column_name='authenticated_at'",[schema])).rows[0].n,"0");
  for(const sql of migration.statements)await client.query(translate(sql));
  for(const table of ["portal_sessions","portal_organization_sessions","mobile_sessions","portal_password_reset_tokens"])assert.ok((await client.query("SELECT revoked_at FROM "+table)).rows[0].revoked_at);
  assert.equal((await client.query("SELECT password_hash,password_policy_version FROM portal_users")).rows[0].password_hash,"legacy-scrypt-v1-preserved");
  assert.equal((await client.query("SELECT password_policy_version FROM portal_users")).rows[0].password_policy_version,0);
  assert.equal((await client.query("SELECT authenticated_at FROM portal_sessions")).rows[0].authenticated_at,null);
  await client.query("COMMIT");
 }finally{
  await client.query("ROLLBACK").catch(()=>{});
  if(owned){
   const existing=(await client.query("SELECT nspname,pg_get_userbyid(nspowner) owner FROM pg_namespace WHERE nspname=$1",[schema])).rows;
   if(existing.length){assert.deepEqual(existing,[{nspname:schema,owner:"gp_core_owner"}]);await client.query("SET ROLE gp_core_owner");await client.query("DROP SCHEMA "+schema+" CASCADE");}
  }
  await client.end();
 }
});

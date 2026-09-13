'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Client}=require('pg');
const {createSchemaPlan,identifier}=require('../lib/persistence/postgresql/core/schema');
const {verifyEnvironment}=require('../lib/persistence/postgresql/core/environment');
const {createSqliteSource,seedCoreFixture}=require('../test-support/postgresql-migration/sqlite-source');
const source=require('../test-support/postgresql-migration/source-schema-v09237.json');
const inventory=require('../docs/postgresql-migration/block-1-inventory.json');
const live={skip:!process.env.GP_PG_MIGRATION_LIVE};
test('Core schema has an explicit plan for every owned table and trigger',()=>{
  const plan=createSchemaPlan();assert.equal(plan.sourceCounts.tables,191);assert.equal(plan.sourceCounts.triggers,299);
  assert.equal(plan.productActivation,false);
  assert.equal(new Set(plan.statements.map(s=>s.id)).size,plan.statements.length);
  assert.ok(inventory.objects.filter(o=>o.database==='core').every(o=>plan.statements.some(s=>s.id===o.name)));
  const ids=source.objects.map(o=>identifier(o.name));assert.ok(ids.every(id=>Buffer.byteLength(id)<=63));
  assert.equal(new Set(ids).size,ids.length);
});
test('Live Core schema and organization rules preserve the SQLite business constraints',live,async()=>{
  const client=new Client({connectionString:process.env.GP_CORE_MIGRATOR_URL});await client.connect();
  const sqlite=createSqliteSource();
  try {
    await verifyEnvironment(client,{purpose:'migrator'});
    const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='gp'")).rows.map(r=>r.tablename);
    assert.ok(inventory.tables.filter(t=>t.database==='core').every(t=>tables.includes(t.name)));
    assert.equal((await client.query("SELECT count(*)::integer n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gp' AND NOT t.tgisinternal")).rows[0].n,299);
    await client.query('BEGIN');await client.query('SET LOCAL ROLE gp_core_owner');await client.query('SET LOCAL search_path=pg_catalog,gp');
    const operations=[];
    const proxy={exec(sql){operations.push([sql,[]]);},prepare(sql){return{run(...params){operations.push([sql,params]);}};}};
    seedCoreFixture(proxy,2);
    for(const [sql,params] of operations.filter(([sql])=>!['BEGIN','COMMIT'].includes(sql))){let n=0;await client.query(sql.replace(/\?/g,()=>'$'+(++n)),params);}
    seedCoreFixture(sqlite,2);
    const actual=(await client.query('SELECT personnel_number,cost_center_id,home_location_id FROM employees ORDER BY personnel_number')).rows;
    assert.deepEqual(actual,sqlite.prepare('SELECT personnel_number,cost_center_id,home_location_id FROM employees ORDER BY personnel_number').all().map(r=>({...r})));
    const rejected=[
      ["UPDATE employees SET cost_center_id='unknown' WHERE personnel_number='00001'",'COST_CENTER'],
      ["UPDATE employees SET position_id='unknown' WHERE personnel_number='00001'",'POSITION'],
      ["INSERT INTO departments(location_id,name) VALUES ('missing','Invalid')",null],
      ["INSERT INTO cost_center_types(id,code,name) VALUES ('duplicate','BRANCH','Duplicate')",null],
      ["UPDATE locations SET cost_center_id='' WHERE id='18'",'LOCATION_COST_CENTER'],
    ];
    for(const [sql,message] of rejected){
      assert.throws(()=>sqlite.prepare(sql).run());
      await client.query('SAVEPOINT rejected_case');
      await assert.rejects(client.query(sql),error=>['23514','23503','23505'].includes(error.code)&&(!message||error.message.includes(message)));
      await client.query('ROLLBACK TO SAVEPOINT rejected_case');await client.query('RELEASE SAVEPOINT rejected_case');
    }
    await client.query('ROLLBACK');
  } finally {sqlite.close();await client.end();}
});
test('Live stored history remains immutable and keeps exact payload text',live,async()=>{
  const client=new Client({connectionString:process.env.GP_CORE_MIGRATOR_URL});await client.connect();
  const sqlite=createSqliteSource();
  try {
    await verifyEnvironment(client,{purpose:'migrator'});await client.query('BEGIN');await client.query('SET LOCAL ROLE gp_core_owner');await client.query('SET LOCAL search_path=pg_catalog,gp');
    const sql="INSERT INTO work_rule_governance_events(id,aggregate_type,aggregate_id,sequence_no,event_type,payload_json,payload_sha256,actor_employee_number,actor_role,permission_used,occurred_at,receipt_sha256) VALUES ('historical-test','profile','old-profile',1,'created',?,?,'00001','developer','rules:write','2020-02-29T23:59:59.999Z',?)";
    const payload='{"amount":"000001.123456789012","identifier":"0018","nullable":null}',hash='a'.repeat(64);
    sqlite.prepare(sql).run(payload,hash,hash);let n=0;await client.query(sql.replace(/\?/g,()=>'$'+(++n)),[payload,hash,hash]);
    assert.equal((await client.query("SELECT payload_json FROM work_rule_governance_events WHERE id='historical-test'")).rows[0].payload_json,payload);
    for(const sql of ["UPDATE work_rule_governance_events SET payload_json='{}' WHERE id='historical-test'","DELETE FROM work_rule_governance_events WHERE id='historical-test'"]){
      assert.throws(()=>sqlite.prepare(sql).run());await client.query('SAVEPOINT immutable_case');
      await assert.rejects(client.query(sql),{code:'23514'});await client.query('ROLLBACK TO SAVEPOINT immutable_case');
    }
    await client.query('ROLLBACK');
  }finally{sqlite.close();await client.end();}
});
test('Live schema migration repeats without duplicate DDL or changes to historical markers',live,async()=>{
  const client=new Client({connectionString:process.env.GP_CORE_MIGRATOR_URL});await client.connect();
  try {
    const {migrateCoreDevelopment}=require('../lib/persistence/postgresql/core/migrate');
    const before=(await client.query('SELECT plan_sha256,applied_at FROM gp.core_migration_history')).rows;
    const result=await migrateCoreDevelopment(client);assert.equal(result.applied,false);
    assert.deepEqual((await client.query('SELECT plan_sha256,applied_at FROM gp.core_migration_history')).rows,before);
  }finally{await client.end();}
});
test('Live JSON, date, ASCII case and NULL compatibility match stored Core contracts',live,async()=>{
  const client=new Client({connectionString:process.env.GP_CORE_READER_URL});await client.connect();
  const sqlite=createSqliteSource();
  try {
    await verifyEnvironment(client,{purpose:'reader'});
    const cases=[
      ["SELECT lower('ÄBC') value","SELECT gp.lower('ÄBC') value"],
      ["SELECT json_type('{\"n\":2}', '$.n') value","SELECT gp.json_type('{\"n\":2}', '$.n') value"],
      ["SELECT json_extract('{\"text\":\"a\"}', '$.text') value","SELECT gp.json_extract('{\"text\":\"a\"}', '$.text') value"],
      ["SELECT date('2024-02-29','+1 day') value","SELECT gp.date('2024-02-29','+1 day') value"],
      ["SELECT date('2024-02-29','+1 year') value","SELECT gp.date('2024-02-29','+1 year') value"],
      ["SELECT date('2026-01-31','+1 month') value","SELECT gp.date('2026-01-31','+1 month') value"],
      ["SELECT date('2026-03-31','-1 month') value","SELECT gp.date('2026-03-31','-1 month') value"],
      ["SELECT datetime('2026-09-12T01:30:00+02:00') value","SELECT gp.datetime('2026-09-12T01:30:00+02:00') value"],
      ["SELECT strftime('%Y-%m-%dT%H:%M:%fZ','2026-09-12 10:11:12.123') value","SELECT gp.strftime('%Y-%m-%dT%H:%M:%fZ','2026-09-12 10:11:12.123') value"],
      ["SELECT substr('abcdef',-3,2) value","SELECT gp.substr('abcdef',-3,2) value"],
      ["SELECT substr('abcdef',4,-2) value","SELECT gp.substr('abcdef',4,-2) value"],
      ["SELECT substr('abcdef',0,3) value","SELECT gp.substr('abcdef',0,3) value"],
    ];
    for(const [a,b] of cases)assert.equal((await client.query(b)).rows[0].value,sqlite.prepare(a).get().value);
    const json='[true,false,null,12,"12",""]';
    const expected=sqlite.prepare('SELECT CAST(value AS TEXT) value,type FROM json_each(?) ORDER BY key').all(json).map(row=>({...row}));
    assert.deepEqual((await client.query('SELECT value,type FROM gp.json_each($1) ORDER BY key::integer',[json])).rows,expected);
  } finally {sqlite.close();await client.end();}
});

test('Live migrations reject changed target rules and refuse to rebuild occupied tables',live,async()=>{
  const {migrateCoreDevelopment}=require('../lib/persistence/postgresql/core/migrate');
  const client=new Client({connectionString:process.env.GP_CORE_MIGRATOR_URL});await client.connect();
  try {
    await verifyEnvironment(client,{purpose:'migrator'});
    await client.query('SET ROLE gp_core_owner');
    await client.query('ALTER TABLE gp.settings ADD CONSTRAINT development_drift_probe CHECK (true)');
    await client.query('RESET ROLE');
    await assert.rejects(migrateCoreDevelopment(client),/target schema drift/);
    await client.query('SET ROLE gp_core_owner');
    await client.query('ALTER TABLE gp.settings DROP CONSTRAINT development_drift_probe');
    await client.query("INSERT INTO gp.settings(key,value) VALUES ('migration-preserve-probe','keep-me')");
    await client.query('RESET ROLE');
    await assert.rejects(migrateCoreDevelopment(client,{rebuildEmptyDevelopment:true}),/empty application tables/);
    assert.equal((await client.query("SELECT value FROM gp.settings WHERE key='migration-preserve-probe'")).rows[0].value,'keep-me');
  }finally{
    await client.query('ROLLBACK');await client.query('SET ROLE gp_core_owner');
    await client.query('ALTER TABLE gp.settings DROP CONSTRAINT IF EXISTS development_drift_probe');
    await client.query("DELETE FROM gp.settings WHERE key='migration-preserve-probe'");
    await client.query('RESET ROLE');await client.end();
  }
});

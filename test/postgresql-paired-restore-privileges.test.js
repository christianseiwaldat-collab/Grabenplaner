'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {materializeDefaultPrivileges}=require('../lib/persistence/postgresql/operations/restore-privileges');
const migration=require('../lib/persistence/postgresql/core/personnel-learning-runs');
function client({ledger=null}={}){
  const calls=[];
  return {calls,async query(sql,args){calls.push({sql,args});
    if(sql.includes('to_regclass'))return {rows:[{name:ledger===null?null:'gp.learning_runs_migration_history'}]};
    if(sql.startsWith('SELECT version'))return {rows:ledger};
    if(sql.includes('FROM pg_proc'))return {rows:[{name:'gp.legacy_default()'}]};
    if(sql.includes('FROM pg_class'))return {rows:[{nspname:'gp',relname:'legacy_table',owner:'gp_core_owner'}]};
    if(sql.startsWith('GRANT'))return {rows:[]};
    throw new Error('Unexpected SQL');
  }};
}
test('old core backups still materialize the original explicit defaults',async()=>{
  const c=client();assert.deepEqual(await materializeDefaultPrivileges(c,['gp']),{functions:1,relations:1});
  assert.deepEqual(c.calls.find(x=>x.sql.includes('FROM pg_proc')).args,[['gp'],[]]);
  assert.ok(c.calls.some(x=>x.sql==='GRANT EXECUTE ON FUNCTION gp.legacy_default() TO PUBLIC'));
  assert.ok(c.calls.some(x=>x.sql==='GRANT ALL PRIVILEGES ON TABLE "gp"."legacy_table" TO "gp_core_owner"'));
});
test('the bound additive learning plan preserves exactly its implicit function ACLs',async()=>{
  const c=client({ledger:[{version:1,plan_sha256:migration.digest}]});
  await materializeDefaultPrivileges(c,['gp']);
  const query=c.calls.find(x=>x.sql.includes('FROM pg_proc')),names=query.args[1];
  assert.equal(names.length,18);assert.equal(new Set(names).size,18);
  assert.ok(names.every(n=>/^trigger_[a-f0-9]{20}$/.test(n)));
  assert.match(query.sql,/NOT \(n\.nspname='gp' AND p\.proname=ANY\(\$2::text\[\]\)\)/);
});
for(const ledger of [[],[{version:2,plan_sha256:migration.digest}],[{version:1,plan_sha256:'0'.repeat(64)}],[{version:1,plan_sha256:migration.digest},{version:1,plan_sha256:migration.digest}]]){
  test('an unbound learning ledger fails before any privilege mutation '+JSON.stringify(ledger),async()=>{
    const c=client({ledger});await assert.rejects(materializeDefaultPrivileges(c,['gp']),/PG_PAIR_RESTORE_LEARNING_PRIVILEGE_CONTRACT/);
    assert.equal(c.calls.some(x=>x.sql.startsWith('GRANT')),false);
  });
}
test('a schema scope without core does not inspect the core learning ledger',async()=>{
  const c=client();await materializeDefaultPrivileges(c,['trade']);
  assert.equal(c.calls.some(x=>x.sql.includes('learning_runs')),false);
});

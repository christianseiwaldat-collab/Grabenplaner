'use strict';
// Explicit recovery of a stopped synthetic qualification, never application data.
const assert=require('node:assert/strict');const {Client}=require('pg');
const {verifyEnvironment}=require('../../lib/persistence/postgresql/core/environment');
const {inventory,stageTables,relation}=require('../../lib/persistence/postgresql/sales/layout');
const marker=process.argv[2];if(!/^synthetic-sales-[a-f0-9-]{36}$/.test(marker||''))throw Error('Exact previously inspected fixture marker required');
async function main(){const clients={};
  try{
    for(const domain of ['core','sales']){const c=clients[domain]=new Client({connectionString:process.env['GP_'+domain.toUpperCase()+'_MIGRATOR_URL']});await c.connect();await verifyEnvironment(c,{domain,purpose:'migrator'});}
    assert.equal((await clients.core.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname IN ('gp_migration_core','gp_migration_sales') AND usename NOT IN ('gp_core_migrator','gp_sales_migrator')")).rows[0].n,0,'No application/reader may be connected');
    assert.deepEqual((await clients.core.query("SELECT value FROM gp.settings WHERE key='migration-test-owner'")).rows,[{value:'synthetic-core-parity-v1'}]);
    assert.deepEqual((await clients.sales.query('SELECT id FROM gp.migration_fixture_owner')).rows,[{id:marker}]);
    assert.equal((await clients.sales.query('SELECT pg_try_advisory_lock(9261250) AS locked')).rows[0].locked,true);
    const names={core:[...inventory.tables.filter(t=>t.database==='core').map(t=>'gp."'+t.name+'"'),...['article_reference_snapshots','import_master_bindings','import_master_events','import_master_holds','trade_source_references','trade_source_reference_versions','sales_audit_inbox'].map(t=>'gp.'+t)],sales:[...stageTables(8).map(t=>relation(t.name)),'integration.core_audit_outbox','integration.core_audit_delivery','integration.core_location_references','gp.migration_fixture_owner']};
    for(const domain of ['core','sales']){const c=clients[domain];await c.query('BEGIN');await c.query('SET LOCAL ROLE gp_'+domain+'_owner');await c.query('TRUNCATE '+names[domain].join(',')+' RESTART IDENTITY CASCADE');await c.query('COMMIT');console.log(domain+': inspected synthetic fixture cleared; schema and migration ledgers retained');}
  }finally{for(const c of Object.values(clients))await c.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Pool}=require('pg');
const {PROFILE,configuration,verifyEnvironment}=require('../lib/persistence/postgresql/core/environment');
test('Development configuration rejects production databases, roles and URL overrides',()=>{
  const input={profile:PROFILE,databaseUrl:'postgresql://gp_core_app:synthetic@127.0.0.1:55483/gp_migration_core',tlsMode:'disable-local-only'};
  assert.equal(configuration(input).max,3);
  for(const databaseUrl of [input.databaseUrl.replace('gp_migration_core','grabenplaner_core'),input.databaseUrl+'?options=unsafe',input.databaseUrl.replace('gp_core_app','postgres')]) assert.throws(()=>configuration({...input,databaseUrl}));
  assert.throws(()=>configuration({...input,profile:'production'}));
  assert.throws(()=>configuration({...input,databaseUrl:input.databaseUrl.replace('127.0.0.1','example.com')}));
});
test('Live development roles are isolated and cannot change ownership or environment marker',{skip:!process.env.GP_PG_MIGRATION_LIVE},async()=>{
  for(const domain of ['core','sales'])for(const purpose of ['app','reader','migrator']) {
    const databaseUrl=process.env[`GP_${domain}_${purpose}_URL`.toUpperCase()];
    const pool=new Pool(configuration({profile:PROFILE,databaseUrl,domain,purpose,tlsMode:'disable-local-only'}));
    try {
      assert.equal((await verifyEnvironment(pool,{domain,purpose})).productActivation,false);
      if(purpose!=='migrator') {
        await assert.rejects(pool.query('UPDATE gp.environment_contract SET profile=profile'),{code:'42501'});
        await assert.rejects(pool.query('CREATE TABLE gp.forbidden_probe(id integer)'),{code:'42501'});
        await assert.rejects(pool.query('SET ROLE gp_'+domain+'_owner'),{code:'42501'});
      }
      const opposite=new URL(databaseUrl);opposite.pathname='/gp_migration_'+(domain==='core'?'sales':'core');
      const foreign=new Pool({connectionString:opposite.href,connectionTimeoutMillis:3000});
      try{await assert.rejects(foreign.query('SELECT 1'),{code:'42501'});}finally{await foreign.end();}
      for(const database of ['postgres','template1']){
        const maintenanceUrl=new URL(databaseUrl);maintenanceUrl.pathname='/'+database;
        const maintenance=new Pool({connectionString:maintenanceUrl.href,connectionTimeoutMillis:3000});
        try{await assert.rejects(maintenance.query('SELECT 1'),{code:'42501'});}finally{await maintenance.end();}
      }
    } finally {await pool.end();}
  }
});
test('Live environment enforces bounded queries and recovers its connection after timeout',{skip:!process.env.GP_PG_MIGRATION_LIVE},async()=>{
  const config=configuration({profile:PROFILE,databaseUrl:process.env.GP_CORE_APP_URL,tlsMode:'disable-local-only'});
  const pool=new Pool({...config,max:1,statement_timeout:150,query_timeout:1000});
  try {
    await verifyEnvironment(pool);
    await assert.rejects(pool.query('SELECT pg_sleep(2)'),{code:'57014'});
    assert.equal((await pool.query('SELECT 42 value')).rows[0].value,42);
    const session=(await pool.query("SELECT current_setting('listen_addresses') host,current_setting('max_connections') maximum,current_setting('shared_buffers') buffers")).rows[0];
    assert.equal(session.host,'127.0.0.1');assert.equal(session.maximum,'20');assert.equal(session.buffers,'64MB');
  } finally {await pool.end();}
});

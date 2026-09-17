'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Pool}=require('pg');
const {createPairedSnapshot}=require('../lib/persistence/postgresql/operations/paired-backup');
const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');

test('native paired backup permits longer checkpoint reads and restores the original query budget on commit and rollback',{
 skip:!process.env.GP_PG_MIGRATION_LIVE,timeout:120000,
},async t=>withCoreFixture(async()=>withSalesFixture(8,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-backup-budget-'));fs.chmodSync(root,0o700);
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const domains=['core','sales'].map(domain=>({domain,database:'gp_migration_'+domain,ownerRole:'gp_'+domain+'_owner',
  pool:new Pool({connectionString:process.env['GP_'+domain.toUpperCase()+'_MIGRATOR_URL'],max:1})}));
 try{
  for(const d of domains){const c=await d.pool.connect();try{await c.query("SET statement_timeout='100ms'");await assert.rejects(c.query('SELECT pg_sleep(0.2)'),{code:'57014'});}finally{c.release();}}
  for(const fail of [false,true]){
   let checked=0;
   const result=createPairedSnapshot({backupDirectory:root,domains,
    withQuiescedWrites:work=>work({active:true,pendingMutations:0}),
    async readCheckpoint({client}){
     assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout,'5min');
     await client.query('SELECT pg_sleep(0.2)');checked++;
     if(fail)throw new Error('SYNTHETIC_CHECKPOINT_FAILURE');
     return {synthetic:true};
    },
    async runDump({targetFile}){fs.writeFileSync(targetFile,'synthetic dump',{mode:0o600});},
    async captureRecoveryFiles({directory}){for(const name of ['roles.sql','configuration.env'])fs.writeFileSync(path.join(directory,name),'synthetic',{mode:0o600});},
   });
   if(fail)await assert.rejects(result,/SYNTHETIC_CHECKPOINT_FAILURE/);else assert.ok((await result).commitMarker);
   assert.equal(checked,fail?1:2);
   for(const d of domains){
    const c=await d.pool.connect();try{
     assert.equal((await c.query('SHOW statement_timeout')).rows[0].statement_timeout,'100ms');
     await assert.rejects(c.query('SELECT pg_sleep(0.2)'),{code:'57014'});
    }finally{c.release();}
   }
  }
 }finally{await Promise.allSettled(domains.map(d=>d.pool.end()));}
})));

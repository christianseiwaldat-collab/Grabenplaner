'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSalesCatalog}=require('../lib/persistence/postgresql/sales/catalog');
const {indexedCashReferencePages}=require('../lib/persistence/postgresql/sales/cash-reference-pages');
const {createPostgresqlPersistenceProvider}=require('../lib/persistence/postgresql/provider');
const {CASH_PUBLICATION_STATEMENTS:S}=require('../lib/persistence/statements/cash-publications');
test('cash reference index scans qualify beside unchanged historical migration contracts',async()=>{
  const catalog=createSalesCatalog(8).entries,before=JSON.stringify(catalog),indexed=indexedCashReferencePages(catalog);
  const changed=indexed.filter((e,i)=>e!==catalog[i]);assert.equal(changed.length,4);
  const p=createPostgresqlPersistenceProvider({pool:{connect:async()=>{throw new Error('No connection expected');},end:async()=>{}},catalog:indexed});
  for(const entry of changed){assert.equal(entry.statement.operation,'queryAll');assert.match(entry.sql,/WITH RECURSIVE/);assert.match(entry.sql,/prior.step<\$3/);assert.doesNotMatch(entry.sql,/GROUP BY/);}
  assert.equal(JSON.stringify(catalog),before);await p.close();
});

test('native cash reference pages preserve all keys and active cross-database work survives the idle limit',
  {skip:process.env.GP_PG_MIGRATION_LIVE!=='1',timeout:150000},async()=>{
  await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async f=>{
    const {receipt,sourceRows}=require('../test-support/postgresql-migration/cash-fixture');
    const receipts=Array.from({length:40},(_,i)=>receipt(i+1,'960',Array.from({length:8},(_,j)=>({EAN:String(100+j).padStart(6,'0'),Verkäuferid:String(2+(j%3)).padStart(5,'0')}))));
    const built=await f.cash.build(sourceRows(receipts));
    await f.access.transaction(async tx=>{
      const {dataset,reader}=await f.cash.publications.candidate(tx,built.id,f.cash.actor.ownerId);
      for(const kind of Object.keys(S.references)){
        const statement=S.references[kind],old=createSalesCatalog(8).entries.find(e=>e.statement===statement);
        let after=Buffer.alloc(0),pages=0;
        for(;;){
          const input={datasetSlot:dataset.row.slot,after,limit:3};
          const values=(old.parameterBindings||old.parameterOrder.map(parameter=>({parameter}))).map(b=>input[b.parameter]);
          const legacy=(await f.client.query(old.sql,values)).rows;
          const rows=await tx.queryAll(statement,input);
          const keys=rs=>rs.map(r=>[Buffer.from(r.sourceKey).toString('hex'),Number(r.tableIndex)]);
          assert.deepEqual(keys(rows),keys(legacy));
          if(!rows.length)break;
          const verified=await f.cash.publications.references(tx,dataset,reader,kind,after.toString('hex'),2);
          assert.ok(verified.items.length>0);after=Buffer.from(rows.at(-1).sourceKey);
          assert.ok(++pages<20,'reference pages must advance');
        }
      }
    },{readOnly:true});
    const M=require('../lib/persistence/statements/import-master-data').IMPORT_MASTER_STATEMENTS;
    await f.access.transaction(async tx=>{
      assert.ok(await tx.queryOne(M.location,{id:'18'}));
      // Default PostgreSQL participant idle limit is 30 s. Actual sales work
      // must keep its core partner usable without disabling that safeguard.
      for(let i=0;i<34;i++){await new Promise(r=>setTimeout(r,1000));await tx.queryOne(S.state,{scopeId:f.cash.actor.scopeId});}
      assert.ok(await tx.queryOne(M.location,{id:'18'}));
    },{readOnly:true});
    const runtime=require('../lib/persistence/repositories/cash-publication-runtime').createCashPublicationRuntime({access:f.access,vault:f.vault,scopeId:f.cash.actor.scopeId,enabled:true,policies:require('../lib/cash-source-policies').CASH_SOURCE_POLICIES});
    const principal=async()=>({...await f.resolvePrincipal('00001'),employeeNumber:'00001',isEmployee:true,
      permissions:[...Object.values(require('../lib/data-import-access').DATA_IMPORT_PERMISSIONS),'sales:analytics:access','sales:analytics:company:read','locations:write','personnel:central:read','personnel:central:write','sales:articles:access','sales:articles:read','sales:articles:import']});
    const applied=await runtime.operation(principal,'apply',{sourceId:built.id,expectedRevision:0});
    assert.equal(applied.revision,1);
    const repeated=await runtime.operation(principal,'apply',{sourceId:built.id,expectedRevision:0});
    assert.equal(repeated.alreadyApplied,true);assert.equal(repeated.revision,1);
  },{warmWorkers:false});
});

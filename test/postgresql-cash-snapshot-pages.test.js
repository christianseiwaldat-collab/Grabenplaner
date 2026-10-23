'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSalesCatalog}=require('../lib/persistence/postgresql/sales/catalog');
const {createSalesSchemaPlan}=require('../lib/persistence/postgresql/sales/schema');
const {CASH_SNAPSHOT_TABLES:TABLES}=require('../lib/persistence/statements/cash-snapshots');
const {indexedCashSnapshotPages}=require('../lib/persistence/postgresql/sales/cash-snapshot-pages');

test('cash pages use the existing non-null primary key order without changing frozen catalogs or other queries',()=>{
  const historical=createSalesCatalog(8).entries,original=JSON.stringify(historical);
  const runtime=indexedCashSnapshotPages(historical),pageIds=new Set(TABLES.map(t=>t.statements.page.id));
  const changed=runtime.filter((entry,i)=>entry!==historical[i]);
  assert.equal(changed.length,7);
  assert.deepEqual(new Set(changed.map(e=>e.statement.id)),pageIds);
  const schema=createSalesSchemaPlan(5).statements;
  for(const table of TABLES){
    const ddl=schema.find(s=>s.id===table.sqlName).sql;
    assert.match(ddl,/dataset_slot BIGINT NOT NULL/);
    assert.match(ddl,/source_row BIGINT NOT NULL/);
    assert.match(ddl,/PRIMARY KEY \( dataset_slot , source_row \)/);
    const old=historical.find(e=>e.statement===table.statements.page);
    const current=runtime.find(e=>e.statement===table.statements.page);
    assert.match(old.sql,/ORDER BY source_row NULLS FIRST LIMIT/);
    assert.equal(current.sql,old.sql.replace('ORDER BY source_row NULLS FIRST LIMIT','ORDER BY source_row NULLS LAST LIMIT'));
    assert.deepEqual({...current,sql:old.sql},old);
    assert.equal(current.statement,old.statement);
    assert.equal(current.parameterOrder,old.parameterOrder);
    assert.equal(current.parameterBindings,old.parameterBindings);
    assert.ok(Object.isFrozen(current));
  }
  for(let i=0;i<historical.length;i++)if(!pageIds.has(historical[i].statement.id))assert.equal(runtime[i],historical[i]);
  assert.equal(JSON.stringify(historical),original);
  assert.deepEqual(createSalesCatalog(8).entries,historical);
  const unrelated={statement:{id:'unrelated.nullable-page'},sql:'SELECT source_row FROM other ORDER BY source_row NULLS FIRST'};
  assert.equal(indexedCashSnapshotPages([unrelated])[0],unrelated);
});

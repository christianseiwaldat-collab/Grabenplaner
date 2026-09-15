'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSalesCatalog}=require('../lib/persistence/postgresql/sales/catalog');
const {indexedImportWorkQueues}=require('../lib/persistence/postgresql/sales/import-work-queues');
const {IMPORT_RECHECK_CATALOG}=require('../lib/persistence/postgresql/sales/import-recheck-catalog');
const {DATA_IMPORT_SCHEMA_SQL}=require('../lib/persistence/sqlite/operations/data-import-schema');

test('PostgreSQL import queues preserve historical contracts and match existing non-null index order',()=>{
  const historical=createSalesCatalog(8).entries,original=JSON.stringify(historical),runtime=indexedImportWorkQueues(historical);
  const changed=runtime.filter((e,i)=>e!==historical[i]);assert.equal(changed.length,6);
  for(const entry of [...changed,...IMPORT_RECHECK_CATALOG]){
    assert.doesNotMatch(entry.sql,/\b(?:state|row_number) NULLS FIRST\b|\brow_number DESC NULLS LAST\b/);
    assert.match(entry.sql,/\b(?:state|row_number) (?:DESC NULLS FIRST|NULLS LAST)\b/);
  }
  for(const entry of changed){const old=historical.find(e=>e.statement.id===entry.statement.id);
    assert.equal(entry.statement,old.statement);assert.equal(entry.parameterOrder,old.parameterOrder);assert.equal(entry.parameterBindings,old.parameterBindings);
    assert.equal(entry.sql.replace(/NULLS (?:FIRST|LAST)/g,'NULL_ORDER'),old.sql.replace(/NULLS (?:FIRST|LAST)/g,'NULL_ORDER'));
  }
  assert.equal(JSON.stringify(historical),original);assert.deepEqual(createSalesCatalog(8).entries,historical);
  assert.match(DATA_IMPORT_SCHEMA_SQL,/row_number INTEGER NOT NULL/);assert.match(DATA_IMPORT_SCHEMA_SQL,/state TEXT NOT NULL/);
  const foreign={statement:{id:'unrelated-nullable-order'},sql:'SELECT state FROM other ORDER BY state NULLS FIRST'};
  assert.equal(indexedImportWorkQueues([foreign])[0],foreign);
});

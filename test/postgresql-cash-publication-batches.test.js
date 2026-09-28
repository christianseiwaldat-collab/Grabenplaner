'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSalesCatalog}=require('../lib/persistence/postgresql/sales/catalog');
const {createPostgresqlPersistenceProvider}=require('../lib/persistence/postgresql/provider');
test('cash publication batches qualify independently without changing historical migration catalogs',async()=>{
  const before=JSON.stringify(createSalesCatalog(8).entries);
  const catalog=require('../lib/persistence/postgresql/sales/cash-publication-batches').CASH_PUBLICATION_BATCH_CATALOG;
  const provider=createPostgresqlPersistenceProvider({pool:{connect:async()=>{throw new Error('Unexpected connection');},end:async()=>{},on(){},removeListener(){}},catalog});
  assert.equal(catalog.length,9);assert.equal(new Set(catalog.map(e=>e.statement.id)).size,9);
  assert.equal(catalog.filter(e=>e.statement.operation==='execute').length,1);
  assert.equal(JSON.stringify(createSalesCatalog(8).entries),before);
  await assert.rejects(provider.queryAll(catalog[0].statement,{sourceSystem:'synthetic',keys:[undefined]}),e=>e.code==='PERSISTENCE_STATEMENT_INVALID');
  await provider.close();
});

test('legacy zero-location reads qualify for PostgreSQL beside unchanged migration catalogs',async()=>{
  const pinned=JSON.stringify(createSalesCatalog(8).entries);
  const catalog=require('../lib/persistence/postgresql/sales/cash-location-reads').CATALOG;
  const provider=createPostgresqlPersistenceProvider({pool:{connect:async()=>{throw new Error('Unexpected connection');},end:async()=>{},on(){},removeListener(){}},catalog});
  assert.equal(catalog.length,15);
  assert.equal(new Set(catalog.map(e=>e.statement.id)).size,catalog.length);
  assert.ok(catalog.every(e=>e.statement.operation==='queryAll'&&e.sql.includes('kassa.')&&!e.sql.includes('INDEXED BY')));
  assert.equal(JSON.stringify(createSalesCatalog(8).entries),pinned);
  const search=catalog.find(e=>e.statement.id==='cash-location-reads.null-search.umsatz-kasse-details');
  assert.ok(!search.parameterOrder.includes('unassigned')&&!search.parameterOrder.includes('locationId'));
  await provider.close();
});

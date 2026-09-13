'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const inventory=require('../docs/postgresql-migration/block-1-inventory.json');
const source=require('../test-support/postgresql-migration/source-schema-v09237.json');
const {createSqliteSource,seedCoreFixture}=require('../test-support/postgresql-migration/sqlite-source');
test('Migration inventory covers every source object once and preserves every table',()=>{
  assert.equal(inventory.schemaSha256,source.schemaSha256);
  assert.equal(inventory.tables.length,248);
  assert.deepEqual(inventory.objects.map(o=>[o.type,o.name]),source.objects.map(o=>[o.type,o.name]));
  assert.equal(new Set(inventory.tables.map(t=>t.name)).size,248);
  assert.ok(inventory.tables.every(t=>['core','sales'].includes(t.database)&&Number.isSafeInteger(t.rowCount)&&t.rowCount>=0));
  assert.equal(inventory.statements.length,1354);
});
test('Migration source fixture creates the complete real schema without business data',()=>{
  const db=createSqliteSource();
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='trigger'").get().n,369);
    seedCoreFixture(db);
    assert.equal(db.prepare('SELECT count(*) n FROM employees').get().n,200);
    assert.equal(db.prepare('SELECT count(*) n FROM crm_customers').get().n,0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {db.close();}
});
test('Migration explicitly retains the Core/Sales article revision boundary and manual images',()=>{
  const loan=inventory.tables.find(t=>t.name==='loan_items');
  assert.equal(loan.database,'core');
  assert.ok(loan.foreignKeys.some(f=>f.table==='sales_article_revisions'&&f.targetDatabase==='sales'));
  assert.equal(inventory.tables.find(t=>t.name==='sales_article_own_images').schema,'trade');
  assert.equal(inventory.tables.find(t=>t.name==='crm_customers').database,'core');
});
test('Inventory builder refuses a new source schema until its database routing is reviewed',()=>{
  const {buildInventory}=require('../scripts/postgresql/build-inventory');
  assert.throws(()=>buildInventory({schemaSha256:'new'},{schemaSha256:'new'},{}),/routing review/);
});

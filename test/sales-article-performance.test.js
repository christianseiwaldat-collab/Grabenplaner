'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {fixture} = require('../test-support/trade-insights-sqlite');
const {seedWorkspace} = require('../test-support/sales-article-workspace-fixture');
const {loadSalesArticleDetailData} = require('../lib/sales-article-detail-source');
const W = require('../lib/persistence/statements/sales-article-workspace');
const {CATALOG} = require('../lib/persistence/sqlite/sales-article-workspace-catalog');

test('Article detail batches notes and branch reads without losing authentication across requests', async t => {
  let reads=0;
  const prepare=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql) {
    const statement=prepare.call(this,sql);
    return new Proxy(statement,{get(target,key) {
      const value=target[key];return typeof value!=='function' ? value : (...args)=>{
        if(key==='all'&&/^\s*(SELECT|WITH)\b/i.test(sql))reads++;
        return value.apply(target,args);
      };
    }});
  };
  t.after(()=>{DatabaseSync.prototype.prepare=prepare;});
  const f=await fixture(t), {article}=await seedWorkspace({access:f.app.provider,source:f});
  await f.ingest('Artikel_Bemerkungen',Array.from({length:40},(_,i)=>({EAN:'005479',Text:'Synthetic note '+i,LBAe:42})),{master:true});
  const load=()=>loadSalesArticleDetailData({access:f.app.provider,vault:f.vault,article,projection:{read:true}});
  reads=0;
  const value=await load();
  assert.equal(value.notes.items.length,40);assert.equal(value.branchStock.rows.length,2);
  assert.ok(reads<=25,`A detail with 40 notes should need bounded packets, not one read per note; got ${reads}`);
  assert.equal(value.priceMatrix.purchase,null);assert.equal(value.priceMatrix.sales,null);
  const stockRow=f.app.database.prepare("SELECT r.id,q.lookup_hash,q.master_record_id,v.file_sha256 FROM import_history_records r JOIN import_history_versions v ON v.record_id=r.id AND v.revision=r.revision JOIN import_history_references q ON q.record_id=r.id AND q.revision=r.revision WHERE r.source_table='ARTIKEL_FILIALEN' AND q.role='article' LIMIT 1").get();
  const stockParameters={scopeId:'grabenplaner-main',sourceInstance:'tradefoto-trade',snapshot:stockRow.file_sha256,
    articleHash:stockRow.lookup_hash || '',masterRecordId:stockRow.master_record_id || '',limit:101};
  const oldStock=f.app.database.prepare(require('../lib/persistence/sqlite/branch-article-stock-catalog').BRANCH_ARTICLE_STOCK_CATALOG[0].sql);
  const newStock=f.app.database.prepare(CATALOG.find(entry=>entry.statement===W.articleStock).sql);
  for(const change of [{},{articleHash:'missing'},{masterRecordId:'missing'},{scopeId:'other-scope'},
    {sourceInstance:'other-source'},{snapshot:'f'.repeat(64)},{limit:1}]) {
    const parameters={...stockParameters,...change};
    assert.deepEqual(newStock.all(parameters),oldStock.all(parameters),'Stock query must preserve both article link paths, scope, snapshot and limit');
  }
  f.app.database.prepare('UPDATE import_history_records SET revision=2 WHERE id=?').run(stockRow.id);
  assert.deepEqual(newStock.all(stockParameters),oldStock.all(stockParameters),'A reference from an older revision must not select stock');
  f.app.database.prepare('UPDATE import_history_records SET revision=1 WHERE id=?').run(stockRow.id);
  const record=f.app.database.prepare("SELECT id FROM import_master_records WHERE source_table='Artikel_Bemerkungen' LIMIT 1").get();
  const saved=f.app.database.prepare("SELECT kind,data_class,payload FROM import_master_segments WHERE record_id=?").all(record.id);
  f.app.database.prepare("UPDATE import_master_segments SET payload='invalid' WHERE record_id=?").run(record.id);
  await assert.rejects(load(),error=>String(error.code).startsWith('IMPORT_'),'A new transaction must authenticate the current ciphertext');
  for(const row of saved)f.app.database.prepare('UPDATE import_master_segments SET payload=? WHERE record_id=? AND kind=? AND data_class=?').run(row.payload,record.id,row.kind,row.data_class);
  const stock=f.app.database.prepare("SELECT id FROM import_history_records WHERE source_table='ARTIKEL_FILIALEN' LIMIT 1").get();
  f.app.database.prepare("UPDATE import_history_references SET lookup_hash=? WHERE record_id=? AND role='article'").run('a'.repeat(64),stock.id);
  await assert.rejects(load(),{code:'IMPORT_HISTORY_INTEGRITY'},'Batched history reads must still authenticate the reference index');
});

test('Note lookup starts from the article relation index and keeps exact scope, table and page boundaries', () => {
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(require('../lib/persistence/sqlite/operations/import-master-schema').IMPORT_MASTER_SCHEMA_SQL);
    const statement=CATALOG.find(entry=>entry.statement===W.notes),params={scopeId:'scope',articleIdentity:'a'.repeat(64),after:'',limit:1};
    const insert=db.prepare("INSERT INTO import_master_records VALUES(?,?,'tradefoto-trade',?,?,?,1,'synthetic','2026-09-28T00:00:00.000Z')");
    const link=db.prepare("INSERT INTO import_master_relations VALUES(?,?,'ARTIKEL_STAMM',?,'candidate','synthetic')");
    for(const [id,scope,table] of [['1','scope','Artikel_Bemerkungen'],['2','other','Artikel_Bemerkungen'],['3','scope','ARTIKEL_STAMM'],['4','scope','Artikel_Bemerkungen']]) {
      insert.run(id,scope,table,'f'.repeat(64),id.padStart(64,'0'));link.run(id,0,params.articleIdentity);
    }
    link.run('1',1,params.articleIdentity); // Multiple links must not duplicate a note.
    const query=db.prepare(statement.sql);
    assert.deepEqual(query.all(params).map(r=>r.id),['1']);
    assert.deepEqual(query.all({...params,after:'1'}).map(r=>r.id),['4']);
    const plan=db.prepare('EXPLAIN QUERY PLAN '+statement.sql).all(params).map(r=>r.detail).join('\n');
    assert.match(plan,/idx_import_master_parent/);
    assert.match(plan,/SEARCH r USING INDEX sqlite_autoindex_import_master_records_1 \(id=\?\)/);
    assert.doesNotMatch(plan,/SEARCH r USING INDEX idx_import_master_scope/);
  } finally {db.close();}
});

test('Portable article reader batches have native PostgreSQL counterparts', () => {
  const postgres=require('../lib/persistence/postgresql/reporting/sales-article-workspace-catalog').CATALOG;
  for(const {batch} of W.readerBatches) {
    const entry=postgres.find(candidate=>candidate.statement===batch);
    assert.ok(entry,batch.id);assert.match(entry.sql,/jsonb_array_elements/);assert.deepEqual(entry.parameterOrder,['requests']);
  }
});

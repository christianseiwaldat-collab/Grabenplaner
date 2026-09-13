'use strict';
const assert=require('node:assert/strict');
const {createSalesArticleCatalogRepository}=require('../../lib/persistence/repositories/sales-article-catalog');
const {articleSnapshot}=require('./trade-fixture');
const {relation}=require('../../lib/persistence/postgresql/sales/layout');
// Only the owned synthetic performance fixture uses bulk setup. Runtime import
// behavior is exercised independently; no historical or productive data is read.
async function seedLoadArticles(f,articles){
  await createSalesArticleCatalogRepository(f.sqliteProvider).importSnapshot(articleSnapshot(1,articles));
  const tables=['sales_article_import_snapshots','sales_articles','sales_article_revisions','sales_article_source_links','sales_article_identifiers','sales_article_price_snapshots','sales_article_import_findings','sales_article_import_run_metadata','sales_article_import_impacts','sales_article_search_projection'];
  assert.equal((await f.client.query('SELECT count(*)::int n FROM trade.sales_articles')).rows[0].n,0);
  await f.client.query('BEGIN');await f.client.query('SET CONSTRAINTS ALL DEFERRED');
  try{
    for(const table of tables){
      const rows=f.sqlite.prepare('SELECT * FROM "'+table+'"').all();
      const columns=require('./source-schema-v09237.json').tables.find(t=>t.name===table).columns.map(c=>'"'+c.name+'"').join(',');
      for(let i=0;i<rows.length;i+=500)await f.client.query('INSERT INTO '+relation(table)+' ('+columns+') SELECT '+columns+' FROM jsonb_populate_recordset(NULL::'+relation(table)+',$1::jsonb)',[JSON.stringify(rows.slice(i,i+500))]);
    }
    const inconsistent=(await f.client.query('SELECT count(*)::int n FROM trade.sales_articles a LEFT JOIN trade.sales_article_search_projection p ON a.product_id=p.product_id WHERE p.product_id IS NULL OR p.current_revision<>a.current_revision')).rows[0].n;assert.equal(inconsistent,0);
    assert.equal((await f.client.query('SELECT count(*)::int n FROM trade.sales_article_search_projection')).rows[0].n,articles.length);
    await f.client.query('DELETE FROM trade.sales_article_search_dirty');await f.client.query('COMMIT');
  }catch(e){await f.client.query('ROLLBACK');throw e;}
}
module.exports={seedLoadArticles};

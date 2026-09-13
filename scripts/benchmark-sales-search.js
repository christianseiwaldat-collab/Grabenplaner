"use strict";
// Synthetic, in-memory comparison. Never opens an application/source database.
// Run: node scripts/benchmark-sales-search.js > output/search-benchmark.json
const {DatabaseSync}=require('node:sqlite'),{performance}=require('node:perf_hooks'),assert=require('node:assert/strict');
const {SQLITE_SALES_ARTICLE_CATALOG}=require('../lib/persistence/sqlite/sales-article-catalog-catalog');
const baselineSql=require('../test/fixtures/article-search-before-optimization.json');
const {ensureSqliteArticleSearchProjection}=require('../lib/persistence/sqlite/operations/sales-article-search-projection-schema');
const Search=require('../lib/flexible-search');
const db=new DatabaseSync(':memory:');
db.function('gp_unicode_casefold',{deterministic:true,directOnly:true},v=>v==null?null:String(v).toLocaleLowerCase('de-AT'));
db.exec(`
 CREATE TABLE sales_articles(product_id TEXT PRIMARY KEY,article_number TEXT UNIQUE,current_revision INTEGER);
 CREATE TABLE sales_article_revisions(product_id TEXT,revision INTEGER,description TEXT,active INTEGER,source_snapshot_id TEXT,PRIMARY KEY(product_id,revision));
 CREATE TABLE sales_article_import_snapshots(id TEXT PRIMARY KEY,source_system TEXT);
 CREATE TABLE sales_article_identifiers(product_id TEXT,source_snapshot_id TEXT,identifier_value TEXT,canonical_gtin14 TEXT,is_primary INTEGER,source_rank INTEGER);
 CREATE INDEX idx_sales_article_identifiers_product ON sales_article_identifiers(product_id,source_snapshot_id);
 CREATE TABLE sales_article_price_snapshots(product_id TEXT,source_snapshot_id TEXT,price_type TEXT,price_basis TEXT,currency TEXT,quality_status TEXT,amount TEXT);
 CREATE INDEX synthetic_price_source ON sales_article_price_snapshots(product_id,source_snapshot_id);
 CREATE TABLE search_projection(product_id TEXT PRIMARY KEY,article_number TEXT,description TEXT,primary_identifier TEXT,search_text TEXT,sort_key TEXT);
 CREATE INDEX search_projection_order ON search_projection(sort_key,product_id);
 CREATE VIRTUAL TABLE search_fts USING fts5(search_text,content='search_projection',content_rowid='rowid',tokenize='trigram');
 INSERT INTO sales_article_import_snapshots VALUES ('synthetic','synthetic.trade');
 BEGIN;
`);
const count=19024,insertArticle=db.prepare('INSERT INTO sales_articles VALUES (?,?,1)'),insertRevision=db.prepare("INSERT INTO sales_article_revisions VALUES (?,1,?,1,'synthetic')"),insertIdentifier=db.prepare("INSERT INTO sales_article_identifiers VALUES (?,'synthetic',?,?,1,1)"),insertProjection=db.prepare('INSERT INTO search_projection VALUES (?,?,?,?,?,?)');
for(let i=1;i<=count;i++){
 const id='synthetic-'+i,number=String(i).padStart(8,'0'),description=`Testkamera Modell ${i} Zubehör`,barcode=String(1000000000000+i),normalized=[number,description,barcode].map(Search.text).join(' ');
 insertArticle.run(id,number);insertRevision.run(id,description);insertIdentifier.run(id,barcode,'0'+barcode);insertProjection.run(id,number,description,barcode,normalized,number);
}
db.exec("COMMIT; INSERT INTO search_fts(search_fts) VALUES('rebuild');");
const find=id=>SQLITE_SALES_ARTICLE_CATALOG.find(e=>e.statement.id.endsWith(id));
const original=db.prepare(baselineSql['sales-article-catalog.articles.search']),countOriginal=db.prepare(baselineSql['sales-article-catalog.articles.search.count']);
const buildStart=performance.now(), rebuilt=ensureSqliteArticleSearchProjection(db), buildMs=performance.now()-buildStart;
const implementedRead=db.prepare(find('articles.search').sql),implementedCount=db.prepare(find('articles.search.count').sql);
const fastRead=db.prepare(find('articles.list-active-by-number').sql),fastCount=db.prepare(find('articles.count-active').sql);
const pending=db.prepare('SELECT product_id FROM sales_article_search_dirty LIMIT 1');
const cases=['','Testkamera 17001','unauffindbar'];
function measured(work){const samples=[];let result;for(let i=0;i<4;i++){const start=performance.now();result=work();samples.push(performance.now()-start);}samples.shift();return {medianMs:Number(samples.sort((a,b)=>a-b)[1].toFixed(3)),result};}
const results=[];
for(const query of cases){
 const filter={...Search.parameters(query),identifierLike:'%',active:1,sourceSystem:null};
 const legacy=measured(()=>({ids:original.all({...filter,sort:'articleNumber',direction:'asc',limit:50,offset:0}).map(r=>r.productId),total:countOriginal.get(filter).total}));
 const implemented=measured(()=>{
  db.exec('BEGIN');
  try { assert.equal(pending.get(),undefined); return query ? {ids:implementedRead.all({...filter,sort:'articleNumber',direction:'asc',limit:50,offset:0}).map(r=>r.productId),total:implementedCount.get(filter).total} : {ids:fastRead.all({active:1,limit:50,offset:0}).map(r=>r.productId),total:fastCount.get({active:1}).total}; }
  finally {db.exec('COMMIT');}
 });
 assert.deepEqual(implemented.result,legacy.result);
 const terms=Search.terms(query),where=terms.length?terms.map((_,i)=>`search_text LIKE $t${i} ESCAPE '!'`).join(' AND '):'1';
 const bindings=Object.fromEntries(terms.map((term,i)=>['t'+i,Search.parameters(term).query0]));
 const read=db.prepare(`SELECT product_id FROM search_projection WHERE ${where} ORDER BY sort_key,product_id LIMIT 50`),total=db.prepare(`SELECT count(*) AS n FROM search_projection WHERE ${where}`);
 const projection=measured(()=>({ids:read.all(bindings).map(r=>r.product_id),total:total.get(bindings).n}));
 assert.deepEqual(projection.result,legacy.result);
 let fts=null;
 if(terms.length&&terms.every(t=>t.length>=3&&!/[*?]/.test(t))){
  const match=terms.map(t=>'"'+t.replaceAll('"','""')+'"').join(' AND ');
  const q=db.prepare('SELECT p.product_id FROM search_fts f JOIN search_projection p ON p.rowid=f.rowid WHERE search_fts MATCH ? ORDER BY p.sort_key,p.product_id LIMIT 50');
  const n=db.prepare('SELECT count(*) AS n FROM search_fts WHERE search_fts MATCH ?');
  fts=measured(()=>({ids:q.all(match).map(r=>r.product_id),total:n.get(match).n}));assert.deepEqual(fts.result,legacy.result);
 }
 results.push({query:query||'(leer)',hits:legacy.result.total,beforeMedianMs:legacy.medianMs,implementedMedianMs:implemented.medianMs,prototypeMedianMs:projection.medianMs,ftsPrototypeMedianMs:fts?.medianMs??null,equalResults:true});
}
console.log(JSON.stringify({fixture:'synthetic; in-memory; one revision and barcode per article',articles:count,node:process.version,sqlite:db.prepare('SELECT sqlite_version() AS v').get().v,projectionBuild:{rows:rebuilt,milliseconds:Number(buildMs.toFixed(3))},runs:'one warmup + three measured repetitions; median; list and count together; implemented includes transaction and dirty check',results},null,2));
db.close();

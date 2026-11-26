'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {resolveArticleReference:resolve}=require('../lib/trade-article-reference');
const {createTradeArticleReader}=require('../lib/persistence/repositories/trade-article-history');
const current={articleNumber:'000042',label:'Neue Kamera',origin:'current',createdAt:'2021-01-01T00:00:00.000',deletedAt:null};
const archived={articleNumber:'000042',label:'Alte Kamera',origin:'archive',createdAt:'2000-01-01T00:00:00.000',deletedAt:'2020-12-31T00:00:00.000'};
const grant=f=>{f.state.session={...f.state.session,permissions:[...f.state.session.permissions,'sales:articles:access','sales:articles:read']};};
const lookup=(f,key,day)=>f.app.provider.transaction(tx=>createTradeArticleReader({access:f.app.provider,tx,protection:f.protection,scopeId:'grabenplaner-main',ownerId:'synthetic-owner'}).resolve(key,day),{readOnly:true,isolation:'serializable'});
test('Exact article identity and historical periods never guess a target or a price',()=>{
 assert.equal(resolve('42',[current,archived]).status,'missing');
 assert.equal(resolve('000042',[current,archived]).status,'ambiguous');
 assert.equal(resolve('000042',[current,archived],{businessDate:'2019-06-30'}).label,'Alte Kamera');
 assert.equal(resolve('000042',[current,archived],{businessDate:'2022-06-30'}).label,'Neue Kamera');
 assert.equal(resolve('000042',[archived],{businessDate:'1999-12-31'}).status,'outside_period');
 assert.equal(resolve('000042',[archived],{businessDate:'2020-12-31'}).status,'archived');
 assert.equal(resolve('000042',[{...archived,deletedAt:null}],{businessDate:'2019-01-01'}).status,'period_unknown');
 assert.equal(resolve('000042',[{...archived,createdAt:'2020-02-30'}],{businessDate:'2019-01-01'}).label,null);
 assert.equal(resolve('000042',[current,archived],{businessDate:'2020-02-30'}).status,'period_unknown');
 assert.equal(resolve('000042',[current,{...archived,deletedAt:'2022-12-31'}],{businessDate:'2022-01-01'}).status,'ambiguous');
 assert.deepEqual(Object.keys(resolve('000042',[archived])).sort(),['articleNumber','businessDate','candidates','label','status']);
});
test('Reference markup retains original receipt text and escapes all supplemental source values',()=>{
 const UI=require('../public/trade-article-history'),Sales=require('../public/sales-history'),Receipt=require('../public/receipt-search');
 const display=resolve('000042',[{...archived,label:'<img src=x> Archiv'}],{businessDate:'2019-06-30'});
 const row={date:'2019-06-30',article:'000042',description:'Originalbezeichnung',displayDescription:'Originalbezeichnung',articleDisplay:display,quantity:'2',sourcePrice:'12.34',issues:[],kind:'receipts',positions:1,provenance:{},lines:[]};
 row.lines=[{...row}];
 for(const html of [UI.referenceMarkup(display,row.description),Sales.renderTable([row],'sales'),Receipt.renderDetail(row)]){
  assert.match(html,/Originalbezeichnung/);assert.match(html,/Archiviert/);assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img/);
 }
 assert.match(Receipt.renderDetail(row),/24,68/);
});
test('Article-source read statement also compiles for PostgreSQL',()=>{
 const entry=require('../lib/persistence/postgresql/reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG.find(e=>e.statement.id==='trade-insights.article-source-state');
 assert.ok(entry);assert.match(entry.sql,/data_import_runs/);assert.doesNotMatch(entry.sql,/\$scopeId|\$currentHash|\$archiveHash/);
});

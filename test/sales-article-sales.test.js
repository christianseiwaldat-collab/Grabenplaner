'use strict';
const test = require('node:test'),assert = require('node:assert/strict');
const Model = require('../lib/sales-article-sales-model');
const C = require('../lib/data-import-contract'),H = require('../lib/tradefoto-history-profiles');
const { SQLITE_APPLICATION_CATALOG } = require('../lib/persistence/sqlite/application-catalog');
const { ensureSqliteDataImportRuntimeSchema } = require('../lib/persistence/sqlite/operations/data-import-runtime-schema');
const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
const { loadManagedDataImportProtection } = require('../lib/data-import-managed-protection');
const { createCashSnapshotStore } = require('../lib/persistence/repositories/cash-snapshots');
const { createCashPublicationRuntime } = require('../lib/persistence/repositories/cash-publication-runtime');
const { createManagedSalesHistoryRuntime } = require('../lib/persistence/repositories/sales-history-runtime');
const { CASH_SNAPSHOT_TABLES: TABLES } = require('../lib/persistence/statements/cash-snapshots');
const { CASH_SOURCE_POLICIES } = require('../lib/cash-source-policies');
const TIME = '2026-09-07T12:00:00.000Z';
const raw = (name,fields) => ({...Object.fromEntries(H.tableFor('cash',name).columns.map(c => [c.name,null])),...fields});
function data() {
  const flags = CASH_SOURCE_POLICIES[0].policy.statusRules[3].flags,result = {Umsatz_KASSE:[],Umsatz_Kasse_Details:[]};
  for (const [index,[article,price,branch,date]] of [['00042','120','018','2010-02-03'],['00042','60','018','2010-01-02'],['42','24','018','2010-01-01'],['00042','240','019','2010-02-04']].entries()) {
    const head = raw('Umsatz_KASSE',{Bonnr:String(index+1),Filialid:branch,Kassenid:'01',Bondatum:date+'T00:00:00.000',Bonzeit:'1899-12-30T16:40:27.000',VerkäuferID:'08',KUND_NR:'00031',RechnungsBetrag:price});
    result.Umsatz_KASSE.push(head);result.Umsatz_Kasse_Details.push(raw('Umsatz_Kasse_Details',{...flags,
      Bonnr:head.Bonnr,Filialid:branch,Kassenid:'01',Bondatum:head.Bondatum,RepID:'00000000-0000-0000-0000-'+String(index+1).padStart(12,'0'),
      EAN:article,VKMenge:'1',VK_Preis:price,Sollpreis:'180',MWST:'20',RohertragDM:'20',KalkRohertrag:'9999',Verkäuferid:'07',Artikelbezeichnung:'Historical camera',KameraNr:'SN-'+index}));
  }
  return result;
}
test('Historical prices use checked source units and confirmed margin; list assumptions stay unavailable',()=>{
  const fields={VK_Preis:'120',Sollpreis:'180',MWST:'20',RohertragDM:'20.123456789'},policy={priceMeaning:'final_unit',priceBasis:'gross',vatRates:{20:'20'}};
  const values=Model.metrics(fields,{status:'sale'},policy,{field:'RohertragDM',meaning:'unit'},true);
  assert.equal(values.actualGross,'120.00');assert.equal(values.actualMargin,'20.12');assert.equal(values.actualMarginPercent,'20.12');assert.equal(values.listSourcePrice,'180');assert.equal(values.listGross,null);assert.equal(values.listMargin,null);
  const confirmed=Model.metrics(fields,{status:'sale'},policy,{field:'RohertragDM',meaning:'unit'},true,{field:'Sollpreis',meaning:'unit',basis:'gross',evidenceSha256:'1'.repeat(64)});
  assert.equal(confirmed.listGross,'180.00');assert.equal(confirmed.listMargin,'70.12');assert.equal(confirmed.listMarginPercent,'46.75');
  assert.equal(Model.metrics(fields,null,policy,null,true).actualGross,null);assert.equal(Model.metrics(fields,{status:'excluded'},policy,null,true).actualGross,null);
  assert.equal(Model.metrics({...fields,MWST:'unknown'},{status:'sale'},policy,null,true).actualGross,null);
  assert.ok(Model.compare({locationId:'aaa',sourceLocationId:'99',date:'2020-01-01',id:'one'},
    {locationId:'zzz',sourceLocationId:'3',date:'2020-01-01',id:'two'},'locationId','desc')<0);
});

test('HTTP route checks both article/history authority and refreshes all sensitive capabilities before sending',async()=>{
  const routes=new Map(),app={post:(path,fn)=>routes.set(path,fn)},state={calls:0,csrf:0};
  const session={employeeNumber:'252',accountId:'one',isEmployee:true,permissions:['sales:articles:access','sales:articles:read','sales:articles:costs:read','sales:analytics:access','sales:analytics:company:read','sales:analytics:margin:read','sales:history:read']};
  require('../lib/sales-article-sales-routes').registerSalesArticleSalesRoutes(app,{requireSession:()=>session,refreshSession:async()=>session,assertCsrf:()=>state.csrf++,runtime:{async run(getSession,work){state.calls++;await getSession();const value=await work({articleSales:{search:async()=>({rows:[{actualMargin:'123.00'}]})}});session.permissions=session.permissions.filter(p=>p!=='sales:articles:costs:read');return value;}}});
  const response={statusCode:200,set(){return this;},status(n){this.statusCode=n;return this;},json(value){this.value=value;return this;}};
  await routes.get('/api/sales/articles/history/sales')({body:{articleNumber:'00042'}},response);assert.equal(response.statusCode,403);assert.ok(!response.value.rows);assert.equal(state.csrf,1);
  session.permissions=session.permissions.filter(p=>p!=='sales:history:read');await routes.get('/api/sales/articles/history/sales')({body:{articleNumber:'00042'}},response);assert.equal(state.calls,1);
});
test('Exact-article catalog compiles to qualified PostgreSQL cash relations with protected binary filters',()=>{
  const entry=require('../lib/persistence/postgresql/sales/catalog').compileSalesEntry(require('../lib/sales-article-sales-catalog').CATALOG[0],8).providerEntry;
  assert.match(entry.sql,/kassa\."cash_snapshot_6"/);assert.match(entry.sql,/kassa\."cash_publication_bindings"/);assert.match(entry.sql,/article_key = \( \$\d+ :: bytea \)/);
  assert.match(entry.sql,/AS "parentRow"/);assert.equal(entry.statement.parameters.articleKey.kind,'bytes');assert.ok(!entry.sql.includes('SELECT *'));
  const sourceLinks=require('../lib/persistence/postgresql/sales/catalog').compileSalesEntry(require('../lib/sales-article-sales-catalog').CATALOG[1],8).providerEntry;
  assert.match(sourceLinks.sql,/trade\."sales_article_source_links"/);assert.match(sourceLinks.sql,/AS "sourceArticleKey"/);
});

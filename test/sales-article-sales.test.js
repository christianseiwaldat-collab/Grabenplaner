'use strict';
const test = require('node:test'),assert = require('node:assert/strict');
const Model = require('../lib/sales-article-sales-model');
const C = require('../lib/data-import-contract'),H = require('../lib/tradefoto-history-profiles');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
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
    const head = raw('Umsatz_KASSE',{Bonnr:String(index+1),Filialid:branch,Kassenid:'01',Bondatum:date+'T00:00:00.000',VerkäuferID:'08',KUND_NR:'00031',RechnungsBetrag:price});
    result.Umsatz_KASSE.push(head);result.Umsatz_Kasse_Details.push(raw('Umsatz_Kasse_Details',{...flags,
      Bonnr:head.Bonnr,Filialid:branch,Kassenid:'01',Bondatum:head.Bondatum,RepID:'00000000-0000-0000-0000-'+String(index+1).padStart(12,'0'),
      EAN:article,VKMenge:'1',VK_Preis:price,Sollpreis:'180',MWST:'20',RohertragDM:'20',KalkRohertrag:'9999',Verkäuferid:'07',Artikelbezeichnung:'Historical camera',KameraNr:'SN-'+index}));
  }
  return result;
}
async function fixture(t,{source=data()}={}) {
  const extra = require('../lib/sales-article-sales-catalog').CATALOG.filter(e => !SQLITE_APPLICATION_CATALOG.some(old => old.statement.id === e.statement.id));
  const app = openSqliteApplicationPersistence({databasePath:':memory:',catalog:[...SQLITE_APPLICATION_CATALOG,...extra]});ensureSqliteDataImportRuntimeSchema(app.database);
  require('../lib/persistence/sqlite/operations/sales-article-catalog-schema').ensureSqliteSalesArticleCatalogSchema(app.database);
  app.database.exec("CREATE TABLE locations(id TEXT PRIMARY KEY,name TEXT,active INTEGER); INSERT INTO locations VALUES ('branch-a','Branch A',1),('branch-b','Branch B',1); CREATE TABLE employees(personnel_number TEXT PRIMARY KEY,full_name TEXT,active INTEGER); INSERT INTO employees VALUES ('person-a','Person A',1),('person-b','Person B',1)");
  require('../lib/persistence/sqlite/operations/crm-schema').ensureSqliteCrmSchema(app.database);
  const vault = createIntegrationSecretVault({activeKeyId:'synthetic',keys:{synthetic:Buffer.alloc(32,17)}}),protection = await loadManagedDataImportProtection({access:app.provider,vault,create:true,clock:()=>TIME});
  const actor = {scopeId:'article-sales-test',ownerId:'admin-1'},policies = [];
  const session = {employeeNumber:actor.ownerId,accountId:'account-1',isEmployee:true,permissions:['data:imports:read','data:imports:prepare','data:imports:apply','locations:write','personnel:central:read','personnel:central:write',
    'sales:analytics:access','sales:analytics:location:read','sales:analytics:margin:read','sales:history:read','sales:history:sellers:read',
    'sales:articles:access','sales:articles:read','sales:articles:costs:read'],scopes:[{locationId:'branch-a'}]};
  const fileSha256 = C.fingerprint(source),id = protection.digest(['source',actor,'cash',fileSha256]),store = createCashSnapshotStore({access:app.provider,protection,actor,clock:()=>TIME});
  await store.begin(id,{kind:'cash',fileSha256,bytes:4096,tables:TABLES.map(table=>({name:table.name,profileHash:table.profile.fingerprint,declaredRows:source[table.name]?.length||0}))});
  for(const table of TABLES){const rows=source[table.name]||[];await store.startTable(id,table.name,rows.length);if(rows.length)await store.append(id,table.name,1,rows.map((r,i)=>H.prepareTradeFotoHistoryRow('cash',table.name,r,{fileSha256,rowNumber:i+1})));await store.finishTable(id,table.name);}
  let status=await store.seal(id,{tables:TABLES.length,rows:Object.values(source).reduce((count,rows)=>count+rows.length,0)});while(status.status==='reviewing')status=await store.review(id);
  policies.push({...CASH_SOURCE_POLICIES[0],fileSha256});const f={app,vault,protection,actor,session};f.get=async()=>f.session;
  const publication=createCashPublicationRuntime({access:app.provider,vault,policies,scopeId:actor.scopeId,enabled:true,clock:()=>TIME});
  const request={sourceId:id,expectedRevision:0,label:'Synthetic cash',policyId:policies[0].id,resolveArticles:false,mappings:[
    {kind:'FILIALEN',sourceId:'018',targetId:'branch-a',historical:false},{kind:'FILIALEN',sourceId:'019',targetId:'branch-b',historical:false},
    {kind:'MITARBEITER',sourceId:'07',targetId:'person-a',historical:false},{kind:'MITARBEITER',sourceId:'08',targetId:'person-b',historical:false}]};
  session.permissions.push('sales:analytics:company:read');
  const preview=await publication.operation(f.get,'preview',{request});await publication.operation(f.get,'activate',{request,planHash:preview.planHash});
  session.permissions=session.permissions.filter(p=>p!=='sales:analytics:company:read');
  const runtime=createManagedSalesHistoryRuntime({access:app.provider,vault,scopeId:actor.scopeId,cashEnabled:true,today:()=> '2026-09-07'});
  f.search=(query={})=>runtime.run(f.get,w=>w.articleSales.search({articleNumber:'00042',...query}));f.runtime=runtime;
  t.after(async()=>{protection.destroy();await app.provider.close();app.database.close();});return f;
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
test('Exact indexed article query preserves zeros, historical values, scopes and receipt IDs with globally sorted pagination',async t=>{
  const f=await fixture(t),page=await f.search({limit:1});assert.equal(page.total,2);assert.equal(page.rows[0].date,'2010-02-03');assert.ok(page.next);assert.ok(page.resultSet);
  assert.equal(page.rows[0].articleNumber,'00042');assert.equal(page.rows[0].actualGross,'120.00');assert.equal(page.rows[0].actualMargin,'20.00');assert.equal(page.rows[0].actualMarginPercent,'20.00');assert.equal(page.rows[0].listGross,null);
  const second=await f.search({limit:1,cursor:page.next});assert.equal(second.rows[0].actualGross,'60.00');assert.equal(second.next,null);
  const sorted=await f.search({limit:1,resultSet:page.resultSet,sort:'actualGross',direction:'asc'});assert.equal(sorted.rows[0].actualGross,'60.00');
  assert.equal((await f.search({articleNumber:'42'})).total,1);assert.equal((await f.search({dateFrom:'2010-02-01',dateTo:'2010-02-28'})).total,1);
  assert.ok(!Object.hasOwn(page.rows[0],'customerNumber'));assert.equal(page.rows[0].personnel,'07');
  const receipt=await f.runtime.run(f.get,w=>w.receipts.documents({ids:[page.rows[0].receiptId]}));assert.equal(receipt.items[0].lines[0].sourcePrice,'120.000000000000');
  await assert.rejects(f.search({locationId:'branch-b'}),e=>e.status===403);
  const plan=f.app.database.prepare('EXPLAIN QUERY PLAN SELECT source_row FROM cash_snapshot_6 WHERE dataset_slot=? AND article_key=? AND business_date>=? ORDER BY business_date DESC,source_row DESC LIMIT 20').all(1,Buffer.alloc(32),'1900-01-01');assert.match(plan.map(r=>r.detail).join(' '),/article_key/);
});

test('Displayed catalog numbers resolve only through explicit Trade source links, including legacy products',async t=>{
  const source=data();for(const line of source.Umsatz_Kasse_Details)if(line.EAN==='00042')line.EAN='0000000102607';
  const f=await fixture(t,{source});
  f.app.database.exec('CREATE TABLE audit_log(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail TEXT,created_at TEXT)');
  const repository=require('../lib/persistence/repositories/sales-article-catalog').createSalesArticleCatalogRepository(f.app.provider);
  async function importArticle(sourceSystem,sourceArticleKey,articleNumber,marker){
    const articles=[{sourceArticleKey,articleNumber,description:'Explicit identity fixture',active:true,sourceUpdatedAt:null,identifiers:[],prices:[]}];
    const snapshot={sourceSystem,sourceProfileVersion:'article-test-v1',sourceSchemaSha256:'a'.repeat(64),sourceFileSha256:marker.repeat(64),snapshotAt:TIME,articles,
      contentSha256:require('../lib/sales-article-catalog').salesArticleImportContentSha256(articles)};
    return repository.importSnapshot({snapshot,actor:f.actor.ownerId,timestamp:TIME});
  }
  await importArticle('legacy.article-catalog','legacy-102607','102607','b');
  const before=await f.search({articleNumber:'102607'});assert.equal(before.total,0);
  const legacy=await repository.getByArticleNumber('102607');assert.equal(legacy.sourceSystem,'legacy.article-catalog');
  await importArticle('tradefoto.artikel_stamm','0000000102607','102607','c');
  const linked=await repository.getByArticleNumber('102607');assert.equal(linked.productId,legacy.productId);assert.equal(linked.sourceArticleKey,'legacy-102607');
  await assert.rejects(f.search({articleNumber:'102607',resultSet:before.resultSet}),e=>e.code==='IMPORT_HISTORY_RESULTS_CHANGED');
  const resolved=await f.search({articleNumber:'102607',limit:1});assert.equal(resolved.total,2);assert.equal(resolved.rows[0].articleNumber,'102607');assert.equal(resolved.rows[0].articleSourceKey,'0000000102607');
  const next=await f.search({articleNumber:'102607',limit:1,cursor:resolved.next});assert.equal(next.rows[0].date,'2010-01-02');
  assert.equal((await f.search({articleNumber:'0000000102607'})).total,2);
  assert.equal((await f.search({articleNumber:'0102607'})).total,0);
  assert.equal((await f.search({articleNumber:'42'})).total,1);
  await importArticle('tradefoto.artikel_stamm','000042','004242','d');
  // An explicit older six-digit source key is valid, but does not match raw42.
  assert.equal((await f.search({articleNumber:'004242'})).total,0);
  const identity=await f.app.provider.transaction(tx=>require('../lib/sales-article-sales-identity').resolveArticleSalesIdentity(tx,'004242'),{readOnly:true});
  assert.deepEqual(identity.sourceKeys,['000042']);assert.equal(identity.basis,'catalog_source_link');
});
test('Personal/customer/cost fields require explicit grants; reduced rights invalidate cached pages',async t=>{
  const f=await fixture(t),page=await f.search({limit:1});f.session.permissions=f.session.permissions.filter(p=>!['sales:history:sellers:read','sales:articles:costs:read'].includes(p));
  await assert.rejects(f.search({limit:1,cursor:page.next}),e=>e.code==='IMPORT_HISTORY_RESULTS_CHANGED');
  const hidden=await f.search();assert.ok(!Object.hasOwn(hidden.rows[0],'personnel'));assert.ok(!Object.hasOwn(hidden.rows[0],'actualMargin'));assert.ok(!hidden.columns.personnel);assert.ok(!hidden.columns.actualMargin);
  await assert.rejects(f.search({sort:'actualMargin'}),e=>e.status===403);f.session.permissions=f.session.permissions.filter(p=>p!=='sales:history:read');await assert.rejects(f.search(),e=>e.status===403);
});
test('CRM source accounts remain anonymous for zero and unlinked accounts never fabricate a CRM link',async t=>{
  const f=await fixture(t);f.session.permissions.push('crm:access','crm:customers:read','crm:purchases:read');const result=await f.search();
  assert.equal(result.rows[0].customerAccount,'00031');assert.equal(result.rows[0].customerNumber,'00031');assert.equal(result.rows[0].customerNumberBasis,'trade_customer_account');assert.equal(result.rows[0].customerId,null);assert.equal(result.rows[0].customerName,'');assert.equal(result.rows[0].customerStatus,'unlinked');
});
test('Surnames and CRM links resolve only exact protected source identities, not numeric guesses',async t=>{
  const f=await fixture(t);f.session.permissions.push('crm:access','crm:customers:read','crm:purchases:read');
  f.app.database.exec('CREATE TABLE audit_log(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail TEXT,created_at TEXT)');
  const source=await require('../test-support/trade-insights-fixture').insightFixture({access:f.app.provider,protection:f.protection,...f.actor,seedBase:false});
  await source.ingest('MITARBEITER',[{Verkäufer_ID:'07',NACHNAME:'Exact surname',VORNAME:'Private first name'}],{master:true});
  await source.ingest('KUNDEN',[{KUND_NR:'00031',NACHNAME:'Customer surname',VORNAME:'Alex'}],{master:true});
  const record=(await source.masters.mappings({table:'KUNDEN',sourceInstance:'tradefoto-trade',key:'00031'})).items[0];
  const input={recordId:record.id,expectedSourceRevision:record.revision},preview=await source.masters.previewCustomer(input);
  const saved=await source.masters.syncCustomer(input,preview.planHash),result=await f.search();
  assert.equal(result.rows[0].personnelSurname,'Exact surname');assert.equal(result.rows[0].customerId,saved.targetId);assert.equal(result.rows[0].customerName,'Alex Customer surname');
  assert.notEqual(result.rows[0].customerId,'00031');assert.doesNotMatch(JSON.stringify(result),/Private first name/);
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

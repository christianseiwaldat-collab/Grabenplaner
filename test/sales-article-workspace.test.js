'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('../test-support/trade-insights-sqlite');
const {seedWorkspace}=require('../test-support/sales-article-workspace-fixture');
const {searchSalesArticleWorkspace:search}=require('../lib/persistence/repositories/sales-article-workspace');
const {normalizeSalesArticleSearch}=require('../lib/sales-article-catalog');
const {loadSalesArticleDetailData}=require('../lib/sales-article-detail-source');
const UI=require('../public/sales-article-layout');
const all={read:true,pricesRead:true,costsRead:true};
test('Current article search covers secondary EAN, both order sources, pagination and import invalidation',async t=>{
  const f=await fixture(t),seed=await seedWorkspace({access:f.app.provider,source:f});
  const query=(orderNumber='',extra={},projection=all)=>search({access:f.app.provider,vault:f.vault,
    search:normalizeSalesArticleSearch(extra),orderNumber,projection});
  assert.equal((await query('',{query:'4006381333931'})).items[0].articleNumber,'005479');
  let result=await query('h 5120',{limit:1});assert.equal(result.total,2);assert.equal(result.items.length,1);
  assert.equal((await query('h 5120',{limit:1,offset:1})).items[0].articleNumber,'005480');
  assert.equal((await query('L-98765')).items[0].articleNumber,'005479');
  const denied=await query('L-98765',{}, {read:true});assert.equal(denied.items[0].retailGross,undefined);
  assert.equal(denied.items[0].purchaseNet,undefined);
  await assert.rejects(query('',{sort:'purchaseNet'},{read:true}),{code:'IMPORT_ARTICLE_ACCESS_DENIED'});
  await f.ingest('ARTIKEL_ZWEITLIEFERANT',[{EAN:'005479',ZSuchname:'Ham',ZBestellnummer:'NEW-77'}],{master:true,snapshotAt:'2026-09-17T10:00:00.000Z'});
  assert.equal((await query('L-98765')).total,0,'Old keyless supplier snapshot must not match');
  assert.equal((await query('NEW-77')).total,1);
  await f.ingest('ARTIKEL_STAMM',[{...seed.master,Bestellnummer:'UPDATED-42'}],{master:true,snapshotAt:'2026-09-17T11:00:00.000Z'});
  assert.equal((await query('h 5120')).total,1);
  assert.equal((await query('UPDATED-42')).items[0].articleNumber,'005479');
  assert.equal((await query("' OR 1=1 --")).total,0);
});
test('Article detail resolves names, stock, links and VAT without crossing price permissions',async t=>{
  const f=await fixture(t),{article}=await seedWorkspace({access:f.app.provider,source:f});
  const get=projection=>loadSalesArticleDetailData({access:f.app.provider,vault:f.vault,article,projection});
  const data=await get(all);
  assert.equal(data.sourceSections.find(s=>s.id==='master').fields.find(f=>f.label==='MwSt.').value,'20 %');
  assert.match(data.sourceSections.find(s=>s.id==='supplier').fields.find(f=>f.label==='Lieferant').title,/Hama GmbH/);
  assert.deepEqual(data.branchStock.rows.map(r=>[r.id,r.quantity]),[['18','3'],['19','0']]);
  assert.equal(data.branchStock.rows[0].name,'Synthetic branch 18');
  assert.equal(data.sourceSections.find(s=>s.id==='links').fields.length,3);
  const eh=data.priceMatrix.sales.find(p=>p.id==='sales');
  assert.equal(Number(eh.gross.amount),229);assert.equal(eh.net.amount,'190.833333333333');
  assert.equal(eh.margin.amount,'20.833333333333');assert.equal(eh.marginA,null);
  assert.equal(data.priceMatrix.purchase.find(p=>p.id==='list_purchase').future.amount,'215.000000000000');
  assert.equal(data.priceMatrix.purchase.find(p=>p.id==='list_purchase').current.sourceValue,true);
  const denied=await get({read:true});
  assert.equal(denied.priceMatrix.purchase,null);assert.equal(denied.priceMatrix.sales,null);
  assert.doesNotMatch(JSON.stringify(denied),/211.25|190.833|215|170/);
  const salesOnly=await get({read:true,pricesRead:true});
  assert.equal(salesOnly.priceMatrix.sales.find(p=>p.id==='sales').margin,null);
  assert.equal(salesOnly.priceMatrix.costsRead,false);
  const restricted=UI.restrictPrices(data.priceMatrix,{pricesRead:true,costsRead:false});
  assert.equal(restricted.purchase,null);assert.equal(restricted.sales[2].margin,null);
  const formats={money:(amount)=>amount+' €',timestamp:v=>v,date:v=>v||'–'};
  const html=UI.overview({...article,...data,prices:{sales:[{priceType:'sales',priceBasis:'gross',currency:'EUR',amount:'229',usable:true}]},
    provenance:{updatedAt:'2026-09-16'},identifiers:article.identifiers},formats);
  assert.match(html,/im GP aktualisiert:/);assert.match(html,/tbm=isch/);assert.match(html,/target="_blank"/);
  assert.match(html,/title="Hama GmbH/);assert.match(html,/title="Synthetic branch 18"/);
  assert.doesNotMatch(html,/Datenherkunft|TradeFoto-Stammdaten|MwSt-Kennzeichen/);
  assert.match(UI.prices(data.priceMatrix,formats),/Aktuell[\s\S]*Zukunft[\s\S]*VK-Preise/);
  assert.equal(UI.link('javascript:alert(1)','X'), 'X');
  assert.equal(UI.fieldValue({value:'<img onerror=x>',title:'"><script>x</script>'}).includes('<script>'),false);
});

test('Manual price revisions use their current costs instead of previous TradeFoto costs',()=>{
  const article={sourceSystem:'tradefoto.artikel_stamm',currentSourceSystem:'manual.article-catalog',prices:[
    {priceType:'sales',priceBasis:'gross',currency:'EUR',qualityStatus:'confirmed',amount:'240'},
    {priceType:'average_purchase',priceBasis:'net',currency:'EUR',qualityStatus:'confirmed',amount:'100'},
  ]};
  const matrix=require('../lib/sales-article-price-matrix').buildSalesArticlePriceMatrix(article,{MWST:1,DurchschnittEK:'170'},all);
  assert.equal(Number(matrix.sales.find(p=>p.id==='sales').margin.amount),100);
  assert.equal(Number(matrix.purchase.find(p=>p.id==='average_purchase').current.amount),100);
  article.prices[1]={sourceField:'DurchschnittEK',priceType:'average_purchase',priceBasis:'unknown',currency:'EUR',qualityStatus:'unresolved',amount:'160'};
  const retained=require('../lib/sales-article-price-matrix').buildSalesArticlePriceMatrix(article,{MWST:1,DurchschnittEK:'999'},all);
  assert.equal(Number(retained.purchase.find(p=>p.id==='average_purchase').current.amount),160);
});

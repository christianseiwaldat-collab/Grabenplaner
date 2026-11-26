'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {seedWorkspace}=require('../test-support/sales-article-workspace-fixture');
const {searchSalesArticleWorkspace:search}=require('../lib/persistence/repositories/sales-article-workspace');
const {normalizeSalesArticleSearch}=require('../lib/sales-article-catalog');
const {loadSalesArticleDetailData}=require('../lib/sales-article-detail-source');
const UI=require('../public/sales-article-layout');
const all={read:true,pricesRead:true,costsRead:true};

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

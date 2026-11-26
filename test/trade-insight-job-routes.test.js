'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {createTradeInsightJobs}=require('../lib/persistence/repositories/trade-insight-jobs');
const {registerTradeInsightJobRoutes}=require('../lib/trade-insight-job-routes');

test('PDFs use understandable filters and do not expose supplier costs without permission',async()=>{
 const {createTradeInsightPdf}=require('../lib/trade-insight-pdf'),{getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const base={title:'Synthetische PDF-Prüfung',created:'2026-10-01T09:00:00Z',completedAt:'2026-10-01T09:00:02Z',durationMs:2000};
 const cases=[{...base,kind:'purchasing',projection:{costs:false},query:{locationId:'18',dateFrom:'2026-08-01',dateTo:'2026-09-17'},result:{rows:[]}},
 {...base,kind:'supplier-invoices',projection:{costs:false},query:{articleNumber:'42',dateField:'booked'},result:{article:{number:'42',label:'Synthetischer Artikel',saleGross:'399',averageNet:'123456.78'},rows:[{created:'2026-09-10',booked:'2026-09-08',number:'RE-001',supplier:'Demo',quantity:'2',priceMin:'98765.43',priceMax:'98765.43'}]}},
 {...base,kind:'article-history',projection:{costs:false},query:{query:'42',searchMode:'exact',status:'all'},result:{rows:[{articleNumber:'42',label:'Kamera',group:'10102',status:'current',candidates:[{source:'Trade_Daten.accdb'}]}]}}];
 for(const snapshot of cases){
  const buffer=await createTradeInsightPdf(snapshot),loading=getDocument({data:new Uint8Array(buffer),isEvalSupported:false}),pdf=await loading.promise;
  try{const parts=[];for(let n=1;n<=pdf.numPages;n++)parts.push((await (await pdf.getPage(n)).getTextContent()).items.map(v=>v.str).join(' '));const content=parts.join(' ');assert.match(parts.at(-1),/Abfragedauer: 2 s/);
   if(snapshot.kind==='purchasing'){assert.match(content,/Lieferfiliale der Bestellung: 18/);assert.match(content,/Bestelldatum von: 2026-08-01/);assert.match(content,/Diese Suche betrifft Lieferantenbestellungen/);}
   if(snapshot.kind==='supplier-invoices'){assert.match(content,/Zeitraum bezieht sich auf: Buchdatum/);assert.match(content,/Synthetischer Artikel/);assert.doesNotMatch(content,/123456|98765|Durchschnitts-EK|EK netto/);}
   if(snapshot.kind==='article-history'){assert.match(content,/Suchart: Artikelnummer exakt/);assert.match(content,/Referenzen: Alle Referenzen/);assert.doesNotMatch(content,/searchMode|status:|Filialauswahl/);}
  }finally{await loading.destroy();}
 }
});

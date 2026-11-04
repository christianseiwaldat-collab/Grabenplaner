'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const O=require('../public/sales-chart-options'),S=require('../public/sales-article-sheet-options'),M=require('../lib/sales-report-model');
const {articleFixture,reportFixture}=require('../test-support/report-design-preview.cjs'),{createSalesArticleSheetPdf}=require('../lib/sales-article-sheet-pdf');
async function pdfText(buffer){const{getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),task=getDocument({data:new Uint8Array(buffer),isEvalSupported:false}),pdf=await task.promise;let text='';try{for(let n=1;n<=pdf.numPages;n++){const p=await pdf.getPage(n),c=await p.getTextContent(),size=p.getViewport({scale:1});for(const i of c.items.filter(i=>i.str?.trim())){const x=i.transform[4],y=i.transform[5];assert.ok(x>=20&&x+i.width<=size.width-18&&y>=14&&y<=size.height-20,'PDF text outside page: '+i.str);}text+=c.items.map(i=>i.str).join(' ')+'\n';}return text;}finally{await task.destroy();}}
test('chart design survives query normalization while rejecting unknown properties and unselected private metrics',()=>{
 const design=O.normalize({palette:'ocean',corners:'square',showValues:false,annotations:['grossMargin']}),f=reportFixture({chartDesign:design});assert.deepEqual(f.query.chartDesign,design);
 assert.deepEqual(M.normalizeReportQuery(f.query,f.metadata),f.query);
 for(const patch of [{currentColor:'url(evil)'},{corners:'arbitrary'},{showValues:'yes'},{annotations:['grossMargin','grossMargin']},{annotations:['customerCount']},{palette:'__proto__'},{customScript:'no'}])assert.throws(()=>O.normalize(patch));
 assert.throws(()=>reportFixture({metrics:['netRevenue'],chartDesign:{annotations:['grossMargin']}}));
 assert.throws(()=>M.normalizeReportQuery(f.query,{...f.metadata,projection:{read:true,margin:false}}),{code:'IMPORT_FORBIDDEN'});
});
test('report diagrams print current and previous values, RE annotations and changes without changing their data',async()=>{
 const f=reportFixture({chartDesign:O.normalize({showAbsolute:true,annotations:['grossMargin']})}),before=JSON.stringify(f.report);
 const buffer=await require('../lib/sales-analysis-pdf').createSalesAnalysisPdf(f),text=await pdfText(buffer);
 assert.match(text,/RE:/);assert.match(text,/-10,00/);assert.match(text.replace(/[\s.]/g,''),/45000,00/);assert.equal(JSON.stringify(f.report),before);
 if(process.env.GP_REPORT_DESIGN_OUTPUT){fs.mkdirSync(process.env.GP_REPORT_DESIGN_OUTPUT,{recursive:true});fs.writeFileSync(path.join(process.env.GP_REPORT_DESIGN_OUTPUT,'Farbiger-Bericht-Beispiel.pdf'),buffer);}
});
test('master-only article PDFs omit all prices, selected master groups and stock when disabled',async()=>{
 const model=articleFixture();model.article.sourceSections[0].fields.push({id:'Verkaufspreis',label:'VK',value:'SOURCE-PRICE-LEAK'});
 const buffer=await createSalesArticleSheetPdf(model,{...S.defaults(),sections:['master'],masterGroups:['master','description'],includeStock:false,layout:'editorial',accentColor:'#2463b5'}),text=await pdfText(buffer);
 assert.match(text,/Beispielkamera/);assert.match(text,/Lieferumfang/);assert.doesNotMatch(text,/SOURCE-PRICE-LEAK|EK-Preise|VK-Preise|Lieferant & Bestellung|Filialbestand|1\.599,00|1\.234,50/);
 if(process.env.GP_REPORT_DESIGN_OUTPUT){fs.mkdirSync(process.env.GP_REPORT_DESIGN_OUTPUT,{recursive:true});fs.writeFileSync(path.join(process.env.GP_REPORT_DESIGN_OUTPUT,'Artikelstamm-ohne-Preise-Beispiel.pdf'),buffer);}
});
test('VK-only, RE-only and optional historical price details remain independent',async()=>{
 const model=articleFixture();model.sales={available:true,complete:true,capabilities:{margin:true},rows:[{date:'2026-10-12',articleNumber:'001234',quantity:'1',description:'SALE-ROW',receipt:'123',actualGross:'949.99',actualMargin:'76.54',status:'sale',issues:[]}]};
 const vk=await pdfText(await createSalesArticleSheetPdf(model,{sections:['prices'],priceParts:['sales'],includeImage:false}));
 assert.match(vk,/VK-Preise/);assert.doesNotMatch(vk,/EK-Preise|RE netto|Zuk\./);assert.match(vk,/1\.599,00/);
 const re=await pdfText(await createSalesArticleSheetPdf(model,{sections:['prices'],priceParts:['margin'],includeImage:false}));assert.match(re,/Rohertrag/);assert.match(re,/98,00/);assert.doesNotMatch(re,/Brutto-VK|1\.599,00|1\.234,50/);
 const hidden=await pdfText(await createSalesArticleSheetPdf(model,{sections:['sales'],showSalesPrices:false,includeImage:false}));assert.match(hidden,/SALE-ROW/);assert.doesNotMatch(hidden,/949,99|76,54|Preise und Rohertrag je Stück/);
 const historicalVk=await pdfText(await createSalesArticleSheetPdf(model,{sections:['sales'],showSalesPrices:true,showSalesMargin:false,includeImage:false}));assert.match(historicalVk,/949,99/);assert.doesNotMatch(historicalVk,/76,54|RE netto/);
 for(const bad of [{layout:'html'},{priceParts:['sales','sales']},{masterGroups:['unknown']},{showSalesPrices:'false'},{accentColor:'red'}])assert.throws(()=>S.normalize(bad));
});

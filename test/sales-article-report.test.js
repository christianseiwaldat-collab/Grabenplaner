'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Model=require('../lib/sales-article-report-model'),Pdf=require('../lib/sales-article-report-pdf');
const {SALES_ARTICLE_CATALOG_PERMISSION_IDS:catalogRights}=require('../lib/sales-article-catalog-access');
const full={prices:true,costs:true,margin:true};
const catalog=()=>({articleNumber:'000042',description:'BEISPIEL Kamera',retailGross:'120',retailNet:'100',internetGross:'114',sourceSystem:'tradefoto.artikel_stamm'});
const row=(overrides={},caps=full)=>Model.projectRow({key:'a',source:{EAN:'0000000000042',Artikelbezeichnung:'Quellbezeichnung',Abverkauf:true,DurchschnittEK:'70',MWST:1},stock:{EAN:'0000000000042',FilialID:18,FBestand:'2',Bestellt:'3'},location:{id:'18',label:'18 · BEISPIEL'},catalog:catalog(),...overrides},caps);
test('report calculation uses exact decimal net margin, source VAT, and distinguishes unavailable values',()=>{
 const a=row();assert.equal(a.marginPercent,'30');assert.equal(a.stockValue,'140');assert.equal(a.quantity,'2');assert.equal(a.articleNumber,'000042');assert.equal(a.assortment,'Abverkauf');
 const vat=row({catalog:{...catalog(),retailNet:null}});assert.equal(vat.marginPercent,'30');
 const missingVat=row({source:{EAN:'0000000000042',DurchschnittEK:'70',MWST:9},catalog:{...catalog(),retailNet:null}});assert.equal(missingVat.marginPercent,null);
 const zero=row({catalog:{...catalog(),retailNet:'0',retailGross:'0'}});assert.equal(zero.marginPercent,null);
 const missingCost=row({source:{EAN:'0000000000042',MWST:1}});assert.equal(missingCost.averageCost,null);assert.equal(missingCost.marginPercent,null);assert.equal(missingCost.stockValue,null);
 const zeroStock=row({stock:{EAN:'0000000000042',FilialID:18,FBestand:'0',Bestellt:'0'}});assert.equal(zeroStock.stockValue,'0','a confirmed zero quantity is zero value, not an unknown');
 const ambiguous=row({ambiguous:true});assert.equal(ambiguous.quantity,null);assert.equal(ambiguous.ordered,null);assert.equal(ambiguous.stockValue,null);
 const manual=row({catalog:{...catalog(),sourceSystem:'manual.article-catalog',purchaseNet:'50'}});assert.equal(manual.averageCost,'50');assert.equal(manual.marginPercent,'50');
 const manualMissing=row({catalog:{...catalog(),sourceSystem:'manual.article-catalog',purchaseNet:null}});assert.equal(manualMissing.averageCost,null,'manual revision never substitutes a newer source EK');
 const omitted=row({},{});for(const key of ['retailGross','internetGross','averageCost','marginPercent','stockValue'])assert.equal(Object.hasOwn(omitted,key),false,key);
});
test('global sort, null placement, totals and pagination are independent of the selected page',()=>{
 const rows=[row({key:'a'}),row({key:'b',stock:{FilialID:19,FBestand:'10',Bestellt:'0'},location:{id:'19',label:'19 · BEISPIEL'}}),row({key:'c',ambiguous:true})];
 const q=Model.normalizeFilters({stock:'all',sort:'quantity',direction:'desc',limit:1,offset:0},full),r=Model.resultFor(rows,q,'2026-10-08',full);
 assert.equal(r.rows[0].quantity,'10');assert.equal(r.total,3);assert.equal(r.hasMore,true);assert.equal(r.summary.quantity,'12');assert.equal(r.summary.missingQuantity,1);assert.equal(r.summary.stockValue,'840');
 const last=Model.resultFor(rows,{...q,offset:2},null,full);assert.equal(last.rows[0].quantity,null);assert.equal(last.hasMore,false);
 assert.deepEqual(Model.normalizeFilters({locations:'19,18,19'},full).locations,['18','19']);
 assert.throws(()=>Model.normalizeFilters({sort:'marginPercent'},{}),e=>e.status===403);assert.throws(()=>Model.normalizeFilters({limit:201},full));
 assert.throws(()=>Model.normalizeFilters({sql:'DROP TABLE'},full));assert.throws(()=>Model.normalizeFilters({assortment:'made-up'},full));
});
test('report preferences and PDF columns cannot restore withdrawn price or cost rights',()=>{
 assert.throws(()=>Model.normalizePreferences({columns:['articleNumber','marginPercent']},{}));
 assert.throws(()=>Pdf.normalize({filters:{},columns:['stockValue']},{}));
 assert.throws(()=>Model.normalizePreferences({columns:['articleNumber'],columnWidths:{articleNumber:900}},full));
 assert.equal(Pdf.filename('../../Stock<bad>.pdf'),'Stock.pdf');
 assert.equal(Model.articleNumber('0000000000042'),'000042');
});
test('PostgreSQL and SQLite reporting packets share a typed snapshot-revision contract',()=>{
 const S=require('../lib/sales-article-report-statements'),entries=S.postgresql(),entry=entries[0];assert.equal(entry.statement,S.catalog);assert.equal(entry.returning,false);assert.deepEqual(new Set(entry.parameterBindings.map(b=>b.parameter)),new Set(['keys','limit']));
 assert.match(entry.sql,/source_article_key/);assert.match(entry.sql,/sales_article_search_projection/);assert.match(entry.sql,/jsonb/);assert.match(entry.sql,/tradefoto\.artikel_stamm/);
 const registered=require('../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG.find(e=>e.statement===S.catalog);assert.ok(registered);
 const stock=entries.find(e=>e.statement===S.stockCandidates);
 for(const name of ['articles','locations']){const index=stock.parameterBindings.findIndex(binding=>binding.parameter===name)+1;assert.ok(index>0);assert.ok(stock.sql.includes(`jsonb_array_elements_text($${index}::jsonb)`));}
 assert.match(stock.sql,/import_history_snapshot_members/);assert.match(stock.sql,/chosen\s*\.\s*revision/);assert.doesNotMatch(stock.sql,/gp\s*\.\s*json_each/);assert.equal(stock.statement.operation,'queryAll');assert.equal(stock.returning,false);
});
test('real PDF has exact page metadata, selected columns, row text and correct A4 orientation',async()=>{
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const rows=Array.from({length:73},(_,i)=>row({key:String(i),catalog:{...catalog(),articleNumber:String(i+42).padStart(6,'0'),description:'BEISPIEL Kamera mit sehr langer eindeutiger Beschreibung '+i}}));
 for(const orientation of ['portrait','landscape']){const spec=Pdf.normalize({filters:{assortment:'sellout'},columns:['articleNumber','description','location','quantity','retailGross','marginPercent'],title:'BEISPIEL Abverkauf',orientation},full),report={available:true,rows,total:rows.length,hasMore:false,sourceAt:'2026-10-08T03:00:00Z'},pdf=await Pdf.render({spec,report,generatedAt:'2026-10-08T12:00:00Z'});
  const doc=await getDocument({data:new Uint8Array(pdf.buffer),disableFontFace:true}).promise;assert.equal(doc.numPages,pdf.pages);assert.ok(pdf.pages>1);assert.equal(pdf.rows,73);
  const first=await doc.getPage(1),viewport=first.getViewport({scale:1});assert.equal(viewport.width>viewport.height,orientation==='landscape');let text='';for(let i=1;i<=doc.numPages;i++)text+=(await (await doc.getPage(i)).getTextContent()).items.map(v=>v.str).join(' ')+' ';
  assert.match(text,/000042/);assert.match(text,/000114/);assert.match(text,/BEISPIEL Abverkauf/);assert.match(text,/EH-VK brutto/);assert.doesNotMatch(text,/Ø EK netto\s+Bestandswert/);assert.match(text,new RegExp(`${pdf.pages} / ${pdf.pages}`));await doc.cleanup();
 }
});
test('the unchanged 10,000 output cap is applied after search and positive-stock criteria',()=>{
 const base=row(),many=Array.from({length:10001},(_,i)=>({...base,id:String(i),quantity:i?'0':'2'})),q=Model.normalizeFilters({},full);
 assert.equal(Model.resultFor(many,q,null,full).total,1);
 assert.equal(Model.resultFor(many.map((r,i)=>({...r,quantity:'2',description:i?'Unpassend':'BEISPIEL passend'})),{...q,query:'passend BEISPIEL'},null,full).total,1);
 assert.throws(()=>Model.resultFor(many,{...q,stock:'all'},null,full),e=>e.status===413&&e.code==='ARTICLE_REPORT_LIMIT');
});

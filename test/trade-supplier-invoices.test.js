'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('../test-support/trade-insights-sqlite');
const {seedSupplierInvoices}=require('../test-support/trade-supplier-invoices-fixture');
const P=require('../lib/tradefoto-bestell/access').BESTELL_PERMISSIONS;
const {readTradeFotoFullSource,definitions}=require('../lib/tradefoto-full-import-source');
const F=require('./fixtures/trade-supplement-source');
test('supplier invoice import whitelists minimal fields, excludes payments, rejects ambiguous and orphaned heads',async()=>{
 const values={Rechnung_A:[{ID:1,Rechnungsnr:'X',Suchname:'ABC',BFirma:'Test',Anlegedatum:new Date('2026-09-10Z'),Bezahlt:999}],Rechnungsdetails_A:[{ID:77,we_id:55,Rechnungsnr:'X',Suchname:'abc',EAN:'000042',menge:-2,Rechnungspreis:42,WEVerkaeuferid:999}]};
 const seen=new Set(),messages=[];
 const read=(v,send)=>readTradeFotoFullSource({buffer:F.buffer(),kind:'lieferantenrechnungen',readerFactory:F.reader('lieferantenrechnungen',v,{columns:(n,c)=>c.forEach(x=>seen.add(x))}),send});
 await read(values,m=>messages.push(m));assert.deepEqual(messages[0].tables.map(t=>t.name),definitions('lieferantenrechnungen').map(t=>t.name));
 assert.deepEqual(messages[0].excludedTableNames,['Teilzahlungen_A']);assert.ok(!seen.has('Bezahlt')&&!seen.has('WEVerkaeuferid'));
 assert.equal(messages.find(m=>m.type==='rows'&&m.name==='Rechnungsdetails_A').rows[0].Rechnungspreis,'42');
 await assert.rejects(read({...values,Rechnung_A:[]},()=>{}),e=>e.code==='IMPORT_INVOICE_HEAD_MISSING');
 await assert.rejects(read({...values,Rechnung_A:[...values.Rechnung_A,{...values.Rechnung_A[0],Suchname:'abc'}]},()=>{}),e=>e.code==='IMPORT_INVOICE_HEAD_INVALID');
});
test('invoice lookup groups by supplier, retains decimals/dates/history and redacts costs with branch-specific authority',async t=>{
 const f=await fixture(t);await f.ingest('ARTIKEL_STAMM',[{EAN:'000042',Artikelbezeichnung:'Demo Fernglas',Verkaufspreis:'399',DurchschnittEK:'227.3212'}],{master:true});
 await seedSupplierInvoices(f);await require('../test-support/trade-supplier-invoices-fixture').seedInvoiceArticleCatalog(f.app.provider);
 const data=await f.run('supplier-invoices',{articleNumber:'000042'});
 assert.equal(data.rows.length,2);assert.equal(data.rows[0].quantity,'0.3');assert.equal(data.rows[0].priceMin,'247.06');assert.equal(data.rows[0].priceMax,'248.1');assert.equal(data.rows[0].positions.length,2);
 assert.equal(data.article.saleGross,'399');assert.equal(data.article.averageNet,'227.3212');assert.equal(data.rows[1].booked,null);assert.equal(data.rows[1].negative,true);
 const old=await f.run('supplier-invoices',{articleNumber:'OLD-0042'});assert.equal(old.article.current,false);assert.equal(old.article.saleGross,null);assert.equal(old.rows[0].quantity,null);
 assert.equal((await f.run('supplier-invoices',{articleNumber:'000042',dateFrom:'2026-09-10',dateField:'created'})).rows.length,2);
 assert.equal((await f.run('supplier-invoices',{articleNumber:'000042',dateFrom:'2026-09-10',dateField:'booked'})).rows.length,0);
 assert.equal((await f.run('supplier-invoices',{query:'OLD-0042'})).articles[0].number,'OLD-0042');
 assert.ok((await f.run('supplier-invoices',{query:'Fernglas'})).articles.some(a=>a.number==='000042'));
 f.state.session={...f.state.session,scopes:[{locationId:'18',departmentId:null}],permissions:['sales:analytics:access','sales:analytics:location:read','sales:history:read',P.SUPPLIER_INVOICES]};
 const safe=await f.run('supplier-invoices',{articleNumber:'000042'});assert.equal(safe.rows.length,2);assert.equal(safe.costs,false);assert.ok(!Object.hasOwn(safe.article,'averageNet'));assert.ok(!Object.hasOwn(safe.rows[0],'priceMin'));assert.ok(!Object.hasOwn(safe.rows[0].positions[0],'price'));
 f.state.session.permissions=f.state.session.permissions.filter(p=>p!==P.SUPPLIER_INVOICES);await assert.rejects(f.run('supplier-invoices',{articleNumber:'000042'}),e=>e.code==='IMPORT_FORBIDDEN');
});
test('replacement, replay and undo never combine invoices from different source files',async t=>{
 const f=await fixture(t),seed=await seedSupplierInvoices(f),query={articleNumber:'000042'};
 const initial=await f.run('supplier-invoices',query);await seedSupplierInvoices(f);assert.equal((await f.run('supplier-invoices',query)).rows.length,2);
 const options={...seed.options,fileSha256:'e'.repeat(64),snapshotAt:'2026-09-14T09:00:00.000Z'};
 const h=await f.ingest('Rechnung_A',seed.heads,options);
 await assert.rejects(f.run('supplier-invoices',query),e=>e.code==='IMPORT_BESTELL_SOURCE_INCOMPLETE');
 const l=await f.ingest('Rechnungsdetails_A',seed.details.slice(0,1),options);assert.equal((await f.run('supplier-invoices',query)).rows[0].quantity,'0.1');
 async function undo(run){let r=await f.engine.undo(run.id,run.revision);while(r.status==='reverting')r=await f.engine.undo(r.id,r.revision);assert.equal(r.status,'reverted');}
 await undo(l);await assert.rejects(f.run('supplier-invoices',query),e=>e.code==='IMPORT_BESTELL_SOURCE_INCOMPLETE');await assert.rejects(undo(h),e=>e.code==='IMPORT_UNDO_DEPENDENCIES');
 // Historical child versions protect their parent. A blocked rollback never exposes a mixed source.
 await assert.rejects(f.run('supplier-invoices',query),e=>e.code==='IMPORT_BESTELL_SOURCE_INCOMPLETE');
});
test('sorting, escaped content and copied invoice context preserve user-visible values',()=>{
 const ui=require('../public/trade-supplier-invoices');const rows=[{id:'1',quantity:'2',booked:null},{id:'2',quantity:'10',booked:'2026-09-01'}];
 assert.equal(ui.sorted(rows,'quantity','desc')[0].id,'2');assert.equal(ui.sorted(rows,'booked','asc')[1].id,'1');
 assert.equal(ui.escape('<script>'),'&lt;script&gt;');assert.match(ui.copyText({number:'000042',label:'Test'},{number:'RE-1',supplier:'Demo',supplierCode:'D',created:'2026-09-01',booked:null,quantity:'1'}),/Buchdatum: –/);
});

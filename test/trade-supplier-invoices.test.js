'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
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
test('sorting, escaped content and copied invoice context preserve user-visible values',()=>{
 const ui=require('../public/trade-supplier-invoices');const rows=[{id:'1',quantity:'2',booked:null},{id:'2',quantity:'10',booked:'2026-09-01'}];
 assert.equal(ui.sorted(rows,'quantity','desc')[0].id,'2');assert.equal(ui.sorted(rows,'booked','asc')[1].id,'1');
 assert.equal(ui.escape('<script>'),'&lt;script&gt;');assert.match(ui.copyText({number:'000042',label:'Test'},{number:'RE-1',supplier:'Demo',supplierCode:'D',created:'2026-09-01',booked:null,quantity:'1'}),/Buchdatum: –/);
});

test('supplier invoice source timestamps survive import and copy without UTC shifts or fabricated midnight',async t=>{
 const f=await fixture(t),seed=await seedSupplierInvoices(f);
 const heads=seed.heads.map((h,i)=>i? h : {...h,Anlegedatum:'2026-09-10T16:40:27.123',Buchdatum:'2026-09-08T09:12:03.000'});
 await seedSupplierInvoices(f,{headsOverride:heads,suffix:'times',snapshotAt:'2026-09-14T09:00:00.000Z'});
 const data=await f.run('supplier-invoices',{articleNumber:'000042'}),row=data.rows.find(r=>r.supplierCode==='Demo');
 assert.equal(row.created,'2026-09-10');assert.equal(row.timestamps.created.dateTime,'2026-09-10T16:40:27.123');
 assert.equal(row.timestamps.booked.time,'09:12:03.000');assert.equal(row.timestamps.booked.timeSource,'Rechnung_A.Buchdatum');
 const text=require('../public/trade-supplier-invoices').copyText(data.article,row);
 assert.match(text,/16:40:27\.123/);assert.match(text,/09:12:03/);assert.doesNotMatch(text,/18:40:27/);
 const dayOnly=data.rows.find(r=>r.supplierCode==='Zwei');assert.equal(dayOnly.timestamps.created.time,null);assert.equal(dayOnly.timestamps.created.timeStatus,'date_only');
});

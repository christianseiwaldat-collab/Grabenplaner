'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createModel,decimal}=require('../test-support/access-db-import/supplier-invoices/model.cjs');
const h=(n,s,id)=>({ID:id,Rechnungsnr:n,Suchname:s,BFirma:s,Anlegedatum:'2026-09-20 10:00:00',Buchdatum:'2026-09-15 00:00:00'});
const d=(n,s,ean,qty,price)=>({ID:'detail-id-unrelated-to-head',Rechnungsnr:n,Suchname:s,EAN:ean,Artikelbezeichnung:'Historische Kamera',menge:qty,Rechnungspreis:price,NNPreis:9});
test('supplier invoice lookup uses the compound key, retains leading zeros and sums exact quantities',()=>{
 const m=createModel({heads:[h('R-1','One',1),h('R-1','Two',2)],details:[d('R-1','ONE','00042',.1,10),d('R-1','One','00042',.2,10),d('R-1','Two','00042',1,20)],masters:[]});
 const a=m.article('00042');assert.equal(m.article('42'),null);assert.equal(a.rows.length,2);assert.equal(a.rows[0].quantity,'0.3');assert.equal(a.rows[0].positions.length,2);assert.equal(a.rows[0].created,'2026-09-20');assert.equal(a.rows[0].booked,'2026-09-15');assert.equal(a.article.saleGross,null);assert.equal(a.article.current,false);
});
test('different prices and negative or missing quantities remain explicit instead of inventing an average',()=>{
 const m=createModel({heads:[h('R','S',1)],details:[d('R','S','A',3,10),d('R','S','A',-1,20),d('R','S','B',null,null)],masters:[]});
 const r=m.article('A').rows[0];assert.equal(r.quantity,'2');assert.equal(r.negative,true);assert.equal(r.mixedPrice,true);assert.equal(r.priceMin,'10');assert.equal(r.priceMax,'20');assert.equal(m.article('B').rows[0].quantity,null);assert.equal(m.article('B').rows[0].priceMissing,true);
});
test('current article prices come only from the master and articles without invoices remain searchable',()=>{
 const m=createModel({heads:[h('R','S',1)],details:[d('R','S','00042',1,100)],masters:[{EAN:'00042',Artikelbezeichnung:'Kamera Grün',Verkaufspreis:499,DurchschnittEK:230.12},{EAN:'0042',Artikelbezeichnung:'Kamera ohne Rechnung'}]});
 assert.equal(m.search('00042')[0].number,'00042');assert.equal(m.search('grun')[0].label,'Kamera Grün');assert.equal(m.article('00042').article.averageNet,'230.12');assert.deepEqual(m.article('0042').rows,[]);assert.equal(m.search('unbekannt').length,0);
});
test('source ambiguities and missing parent links fail closed; tiny numbers retain precision',()=>{
 assert.throws(()=>createModel({heads:[h('R','S',1),h('r','s',2)],details:[],masters:[]}),/Ambiguous/);
 assert.throws(()=>createModel({heads:[h('R','S',1)],details:[d('R','X','A',1,2)],masters:[]}),/without matching/);
 assert.equal(decimal(1e-7),'0.0000001');assert.equal(decimal(-1e21),'-1000000000000000000000');assert.equal(decimal(null),null);
});

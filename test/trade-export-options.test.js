'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const E=require('../public/trade-export-options'),T=require('../public/trade-table-layout');
test('filename blocks use Vienna time, position and safe names, including the year boundary',()=>{
 const now=new Date('2026-12-31T23:05:00Z');
 assert.equal(E.filename('Monatsbestand',{},now),'270101-0005-Monatsbestand.pdf');
 assert.equal(E.filename('Bestellungen',{stamp:'date',position:'after',separator:'_'},now),'Bestellungen_270101.pdf');
 assert.equal(E.filename('Reparaturen.pdf',{stamp:'date-suffix',suffix:'Fil18'},now),'270101-Fil18-Reparaturen.pdf');
 assert.equal(E.filename('../Test"\r\n.pdf',{stamp:'none'},now),'Test.pdf');
 assert.throws(()=>E.options({stamp:'date',employeeNumber:'other'}));assert.throws(()=>E.options({position:'../'}));assert.throws(()=>E.options({suffix:[]}));
});
test('table options keep at least one data column, bounded widths and valid column identities',()=>{
 const allowed=['date','label'];assert.deepEqual(T.normalize({columns:['date'],widths:{date:210}},allowed),{columns:['date'],widths:{date:210}});
 for(const input of [{columns:[],widths:{}},{columns:['date','date']},{columns:['secret']},{columns:['date'],widths:{date:801}},{columns:['date'],widths:{secret:150}},{columns:['date'],employeeNumber:'other'}])assert.throws(()=>T.normalize(input,allowed));
});

test('empty purchasing reports explain the delivery-branch filter, including older saved results',()=>{
 const M=require('../public/trade-insight-results');assert.match(M.emptyReason('purchasing',{locationId:'18'},{rows:[]}),/Lieferfiliale.*Bestelldatum/);assert.equal(M.emptyReason('purchasing',{}, {rows:[{}]}),'');assert.equal(M.emptyReason('repairs',{}, {rows:[]}),'');assert.equal(M.emptyReason('purchasing',{}, {rows:[],emptyReason:'Genauer Prüfhinweis'}),'Genauer Prüfhinweis');
});

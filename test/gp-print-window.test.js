'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Print=require('../public/gp-print-window');
test('print defaults and orientation normalize without mixing filename and PDF title',()=>{
  assert.deepEqual(Print.normalizeValues(),{title:'PDF-Ausgabe',filename:'Auswertung',orientation:'portrait'});
  assert.deepEqual(Print.normalizeValues({title:'Artikel 42',name:'Artikel-42',orientation:'landscape'}),{title:'Artikel 42',filename:'Artikel-42',orientation:'landscape'});
  assert.deepEqual(Print.normalizeValues({title:'',filename:'',orientation:'invalid'}),{title:'',filename:'',orientation:'portrait'},'Empty inputs stay invalid, never silently replaced');
  assert.equal(Print.normalizeValues({title:'x'.repeat(500),filename:'y'.repeat(500)}).title.length,120);
  assert.equal(Print.normalizeValues({title:'x'.repeat(500),filename:'y'.repeat(500)}).filename.length,100);
});
test('download names are safe leaf names with exactly one PDF extension',()=>{
  assert.equal(Print.filename('Abverkauf.pdf'),'Abverkauf.pdf');
  assert.equal(Print.filename('C:\\temp/<camera>:?\u0000 .pdf'),'C--temp--camera----.pdf');
  assert.equal(Print.filename(' ... '),'Auswertung.pdf');
  assert.equal(Print.filename('x'.repeat(500)).length,104);
  assert.ok(!/[\\/:*?"<>|\u0000-\u001f]/.test(Print.filename('../Ausgabe')));
});
test('print window fails closed without its browser window and PDF dependencies',()=>{
  assert.throws(()=>Print.mount({}),/benötigt GP-Fenster/);
  assert.throws(()=>Print.mount({document:{defaultView:{GpWindow:{},GpPdfPreview:{}}}}),/Kontoschlüssel/);
});

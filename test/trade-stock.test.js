'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {inventoryMetrics}=require('../lib/persistence/repositories/trade-stock');
async function stock(f){
 await f.ingest('ARTIKEL_Warengruppen',[{Warengruppe:1,Bezeichnung:'Synthetic goods'}],{master:true});
 await f.ingest('ARTIKEL_Sortimente',[{Sortiment:10,Warengruppe:1,Bezeichnung:'Synthetic cameras'}],{master:true});
 await f.ingest('ARTIKEL_STAMM',[{EAN:'000042',Artikelbezeichnung:'Camera',Sortiment:10,DurchschnittEK:'123.45',Sachkonto:false,OhneBestand:false},{EAN:'000043',Artikelbezeichnung:'Service',Sortiment:10,DurchschnittEK:'0',Sachkonto:false,OhneBestand:true}],{master:true});
 await f.ingest('ARTIKEL_FILIALEN',[{EAN:'000042',FilialID:18,FBestand:'2'},{EAN:'000043',FilialID:18,FBestand:'4'},{EAN:'000042',FilialID:19,FBestand:'3'}],{sourceInstance:'tradefoto-trade'});
}
test('Slow mover and reach require confirmed goods, full coverage and reconciled quantities; returns do not count as positive sales',()=>{
 const period={from:'2026-06-01',to:'2026-08-29',branch:'18',company:true},kind={kind:'goods',confirmed:true};
 const sales={complete:true,coverage:true,stats:{stock:{18:{net:'3',positive:'5',lastSale:'2026-08-10'}},unverified:0,denied:0,unknownStock:0}};
 assert.deepEqual(inventoryMetrics('2',kind,sales,period),{eligible:true,reason:'Geprüfter Kassenstand',noRecordedSale:false,coverageDays:'60',soldNet:'3',lastSale:'2026-08-10'});
 const unsold={...sales,stats:{...sales.stats,stock:{}}};assert.equal(inventoryMetrics('2',kind,unsold,period).noRecordedSale,true);
 for(const bad of [{...sales,complete:false},{...sales,coverage:false},...['denied','unverified','unknownStock'].map(k=>({...sales,stats:{...sales.stats,[k]:1}}))])assert.equal(inventoryMetrics('2',kind,bad,period).noRecordedSale,null);
 for(const k of ['unknown','excluded','account','service'])assert.equal(inventoryMetrics('2',{kind:k,confirmed:true},sales,period).eligible,false);
 assert.equal(inventoryMetrics('0',kind,sales,period).eligible,false);assert.equal(inventoryMetrics('2',kind,sales,{...period,company:false}).eligible,false);
});
test('Annotation Core SQL has a separate owner and parameterized compare-and-set',()=>{
 const entries=require('../lib/persistence/postgresql/core/trade-annotations').CATALOG;
 assert.deepEqual(entries.map(e=>e.statement.id).sort(),[
  'sales-bwl-simulation.annotation-remove','trade-annotations.epoch','trade-annotations.get','trade-annotations.insert',
  'trade-annotations.protected-images','trade-annotations.update',
 ].sort());
 for(const e of entries){assert.match(e.sql,/gp\.trade_annotations/);assert.doesNotMatch(e.sql,/gp\.gp\./);}
 assert.match(entries.find(e=>e.statement.id.endsWith('update')).sql,/revision\s*=\s*\(\s*\$/);
 const removal=entries.find(e=>e.statement.id==='sales-bwl-simulation.annotation-remove');
 assert.match(removal.sql,/^DELETE FROM gp\.trade_annotations WHERE /);
 assert.deepEqual([...removal.parameterOrder].sort(),['expectedRevision','id','kind','scopeId']);
 for(const [column,parameter] of [['id','id'],['scope_id','scopeId'],['kind','kind'],['revision','expectedRevision']]){
  const index=removal.parameterOrder.indexOf(parameter);assert.notEqual(index,-1);
  assert.match(removal.sql,new RegExp('\\b'+column+'\\s*=\\s*\\(\\s*\\$'+(index+1)+'\\b'));
 }
});

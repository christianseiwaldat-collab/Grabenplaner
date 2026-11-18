'use strict';
const Time=require('../public/source-date-time');
function receipt(){return {
  id:'synthetic-receipt',kind:'receipts',date:'2026-11-14',...Time.cash({Bondatum:'2026-11-14T00:00:00.000',Bonzeit:'1899-12-30T16:40:27.000'}),
  receipt:'90770-TEST',location:'Filiale 18 · Testdaten',register:'01',personnel:'252',positions:2,currency:'EUR',
  gross:'60.00',net:'50.00',tax:'10.00',sourceAmount:'60.00',state:'Geprüft',
  reconciliation:{headerBasis:'gross',headerStatus:'checked',difference:'0.00',toleranceMinor:0},
  provenance:{sourceLabel:'Synthetischer Kassenstand · kein echter Kundenbeleg',importedAt:'2026-11-17T22:00:00Z',fileSha256:'a'.repeat(64)},
  lines:[{article:'000042',description:'Musterkamera · Verkauf',quantity:'1',sourcePrice:'120',gross:'120.00',net:'100.00',tax:'20.00',vatRate:'20',deviceNumber:'DEVICE-000042',personnel:'426',status:'sale'},
    {article:'000043',description:'Musterobjektiv · Rückgabe',quantity:'-1',sourcePrice:'60',gross:'-60.00',net:'-50.00',tax:'-10.00',vatRate:'20',deviceNumber:'',personnel:'13',status:'return'}]};}
function journal(){return {id:'synthetic-journal',kind:'journal',date:'2026-11-14',...Time.project('2026-11-14T00:00:00.000',{source:'KassenJournal_Details.Datum'}),
  receipt:'J-003',location:'Filiale 18 · Testdaten',register:'',description:'Kassenbewegung',descriptionSupplement:'Zusatz aus dem Kassenjournal: Wechselgeld eingelegt',
  account:'1000',inflow:'50',outflow:'0',lines:[],provenance:receipt().provenance};}
module.exports={receipt,journal};

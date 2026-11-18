'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const F=require('../test-support/receipt-information-fixture');
const UI=require('../public/receipt-search'),Branch=require('../public/portal-branch-sales'),Lines=require('../public/receipt-line-format');
const Model=require('../lib/receipt-search'),{createReceiptInfoPdf}=require('../lib/receipt-info-pdf');

test('personal and branch details expose source time, device, separate sellers and checked tax without leaking absent grants',()=>{
  const item=F.receipt();
  for(const html of [UI.renderDetail(item),Branch.receiptDetail(item,Lines)]) {
    for(const marker of ['16:40:27','DEVICE-000042','426','252','Netto','Steuer','Originaler Quellbetrag','Belegabgleich'])assert.ok(html.includes(marker),marker);
    assert.match(html,/-60,00/);assert.match(html,/-10,00/);
  }
  const hidden=F.receipt();delete hidden.personnel;
  for(const html of [UI.renderDetail(hidden),Branch.receiptDetail(hidden,Lines)])assert.doesNotMatch(html,/426|Positionsverkäufer|Personalnr/);
  const hostile=F.receipt();hostile.lines[0].deviceNumber='<script>hostile</script>';
  for(const html of [UI.renderDetail(hostile),Branch.receiptDetail(hostile,Lines)])assert.doesNotMatch(html,/<script>/);
  const placeholder=F.receipt();placeholder.sourceAmount='0';placeholder.reconciliation.headerStatus='unavailable_zero_placeholder';
  assert.match(UI.renderDetail(placeholder),/bestätigter Platzhalter/);assert.match(UI.renderDetail(placeholder),/Geprüfter Warenumsatz: 60,00/);
});

test('journal details preserve additional description and explicitly disclose the missing booking time',()=>{
  const item=F.journal(),html=UI.renderDetail(item);
  assert.match(html,/Zusatz aus dem Kassenjournal: Wechselgeld eingelegt/);assert.match(html,/Uhrzeit nicht erfasst/);
  assert.doesNotMatch(html,/00:00/);
  const hostile={...item,descriptionSupplement:'<img onerror=bad>'};assert.doesNotMatch(UI.renderDetail(hostile),/<img/);
});

test('dedicated device filter is bounded, receipt-only and part of the signed normalized query',()=>{
  const base={sourceId:'cash',dateFrom:'2026-11-01',dateTo:'2026-11-14'},options={today:'2026-11-18',projection:{read:true,finance:true}};
  assert.equal(Model.query({...base,deviceNumber:' DEVICE-000042 '},options).deviceNumber,'DEVICE-000042');
  assert.throws(()=>Model.query({...base,deviceNumber:'x'.repeat(81)},options));
  assert.throws(()=>Model.query({...base,deviceNumber:'DEVICE-000042',kind:'journal'},options));
});

test('receipt and journal PDFs contain the new business context and stay within page bounds',async()=>{
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  for(const [name,item,markers] of [['receipt',F.receipt(),['16:40:27','DEVICE-000042','426','Netto','Steuer','Originaler Quellbetrag','Belegabgleich']],
    ['journal',F.journal(),['Uhrzeit nicht erfasst','Zusatz aus dem Kassenjournal','Wechselgeld eingelegt']]]) {
    const pdf=await createReceiptInfoPdf({items:[item],sourceLabel:item.provenance.sourceLabel});
    const task=getDocument({data:new Uint8Array(pdf),isEvalSupported:false}),document=await task.promise;
    try {
      let text='';
      for(let i=1;i<=document.numPages;i++){
        const page=await document.getPage(i),content=await page.getTextContent();text+=content.items.map(v=>v.str).join(' ')+' ';
        for(const value of content.items.filter(v=>v.str)){
          assert.ok(value.transform[4]>=41&&value.transform[4]+value.width<=page.view[2]-41,value.str);
          assert.ok(value.transform[5]>=20&&value.transform[5]<=page.view[3]-35,value.str);
        }
      }
      for(const marker of markers)assert.ok(text.includes(marker),name+': '+marker);
      if(process.env.GP_RECEIPT_PREVIEW_DIR){fs.mkdirSync(process.env.GP_RECEIPT_PREVIEW_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.GP_RECEIPT_PREVIEW_DIR,name+'-information.pdf'),pdf);}
    }finally{await task.destroy();}
  }
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const UI=require('../public/data-import');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const projection={read:true,prepare:true,apply:true};
function invoiceSource(){return {id:'invoice',kind:'lieferantenrechnungen',status:'needs_review',complete:true,activationEnabled:true,tables:[
  {name:'Rechnung_A',declaredRows:2,run:{id:'heads',status:'ready',receivedRows:2,counts:{create:2},gates:[]}},
  {name:'Rechnungsdetails_A',declaredRows:5,run:{id:'lines',status:'needs_review',receivedRows:5,counts:{conflict:4,invalid:1},gates:['SOURCE_ROW_COUNT_MISMATCH']}},
]};}
function cashSource(){return {id:'cash',kind:'cash',storage:'cash-compact-v1',status:'ready',complete:true,revision:9,tables:[],cashPublication:{active:false,available:true,revision:2}};}
async function mount(t,source,intercept=()=>{}){
  const fields=Object.fromEntries(['next','sources','detail','message','log','stop','form'].map(name=>[name,{hidden:true,innerHTML:'',textContent:'',dataset:{},querySelector:()=>null,replaceChildren(){},setAttribute(){},removeAttribute(){}}]));
  const handlers={},requests=[],confirmations=[];
  const body={innerHTML:'',querySelector:s=>fields[/data-i="([^"]+)"/.exec(s)?.[1]],addEventListener:(n,h)=>handlers[n]=h,removeEventListener(){},replaceChildren(){}};
  const root={open:true,querySelector:()=>body,addEventListener(){},removeEventListener(){}};
  const view=UI.mount(root,{confirmAction:message=>{confirmations.push(message);return true;},api:async(url,options)=>{
    requests.push({url,options});const result=intercept(url,options);if(result!==undefined)return result;
    if(url.endsWith('/context'))return{available:true,projection,backgroundEnabled:true};
    if(url.endsWith('/sources/search'))return{items:[source],next:null};
    assert.equal(url,'/api/data-import/sources/'+source.id);return structuredClone(source);
  }});
  t.after(()=>view.destroy());
  const click=(dataset={},attribute='')=>handlers.click({target:{closest:()=>({dataset,hasAttribute:name=>name===attribute})}});
  await tick();await click({iSource:source.id});
  return {fields,requests,confirmations,click,view};
}

test('invoice preview explains the same-file sequence without clearing real issues or enabling unauthorized writes',()=>{
  const source=invoiceSource(),html=UI.renderSource(source,projection);
  assert.match(html,/Vorschau abgeschlossen · Übernahme ausstehend/);
  assert.match(html,/Rechnungsköpfe zuerst übernehmen/);assert.match(html,/Positionen danach erneut prüfen und übernehmen/);
  assert.match(html,/Die Kassen_Umsätze.accdb ist dafür nicht erforderlich/);
  assert.match(html,/4 offene Prüffälle/);assert.match(html,/1 ungültig/);assert.match(html,/SOURCE_ROW_COUNT_MISMATCH/);
  assert.match(UI.renderSource(source,{...projection,apply:false}),/data-i-action="apply" disabled/);
  for(const state of ['reviewing','applying','applied','reverting','interrupted'])
    assert.doesNotMatch(UI.renderSource({...source,status:state},projection),/Vorschau abgeschlossen · Übernahme ausstehend/);
  assert.doesNotMatch(UI.renderSource({...source,background:{status:'failed',phase:'applying'}},projection),/Es läuft derzeit kein Hintergrundauftrag/);
  assert.match(UI.renderSource({...source,background:{status:'failed',phase:'applying'}},projection),/Übernahme fortsetzen/);
});

test('invoice row explanations distinguish an expected parent from a parent still missing after apply',()=>{
  const source=invoiceSource(),row={rowNumber:1,state:'conflict',issue:'HISTORY_PARENT_REQUIRED'};
  assert.match(UI.rowStatusText(source,'lines',row),/noch nicht übernommen.*Rechnung_A derselben Datei/);
  source.tables[0].run.status='applied';
  assert.match(UI.rowStatusText(source,'lines',row),/fehlt auch nach der Übernahme/);
  assert.doesNotMatch(UI.renderSource(source,projection),/Erneute Prüfung nach Übernahme der Rechnungsköpfe/);
  assert.match(UI.rowStatusText(source,'lines',{...row,issue:'MANUAL_FIELD_CONFLICT'}),/MANUAL_FIELD_CONFLICT/);
  assert.match(UI.rowStatusText(source,'heads',row),/HISTORY_PARENT_REQUIRED/);
});

test('invoice confirmation describes parent-first apply and row feedback is escaped',async t=>{
  const source=invoiceSource();let applied=false;
  const ui=await mount(t,source,(url)=>{
    if(url.endsWith('/apply-background')){applied=true;return {...source,active:true,status:'applying'};}
    if(url.endsWith('/rows'))return {rows:[{rowNumber:1,state:'conflict',issue:'HISTORY_PARENT_REQUIRED'},{rowNumber:2,state:'conflict',issue:'<script>bad</script>'}]};
  });
  await ui.click({iRows:'lines'});assert.match(ui.fields.log.innerHTML,/Rechnung_A derselben Datei/);assert.doesNotMatch(ui.fields.log.innerHTML,/<script>/);
  await ui.click({iAction:'apply'});assert.equal(applied,true);
  assert.match(ui.confirmations[0],/Zuerst werden die Rechnungsköpfe übernommen/);assert.match(ui.confirmations[0],/Verbleibende Konflikte halten/);
});

test('accepted cash background job is shown as running without claiming a completed takeover',async t=>{
  const source=cashSource();const ui=await mount(t,source,url=>{
    if(url==='/api/data-import/cash/apply'){source.background={phase:'applying',status:'queued'};source.active=true;return structuredClone(source);}
  });
  await ui.click({iAction:'apply'});
  assert.match(ui.fields.message.textContent,/im Hintergrund übernommen/);
  assert.doesNotMatch(ui.fields.message.textContent,/Kassenstand übernommen\./);
  assert.match(ui.fields.detail.innerHTML,/Server arbeitet selbstständig weiter/);
  assert.equal(ui.requests.filter(r=>r.url==='/api/data-import/cash/apply').length,1);
});

for(const outcome of ['active','inactive','unavailable'])test(`cash lost response checks status once without retrying the write: ${outcome}`,async t=>{
  const source=cashSource();let attempted=false;
  const ui=await mount(t,source,(url)=>{
    if(url==='/api/data-import/cash/apply'){
      attempted=true;source.cashPublication.active=outcome==='active';
      return Promise.reject(new DOMException('signal is aborted without reason','AbortError'));
    }
    if(attempted&&outcome==='unavailable'&&url.endsWith('/sources/cash'))return Promise.reject(new Error('network unavailable'));
  });
  await ui.click({iAction:'apply'});
  assert.equal(ui.requests.filter(r=>r.url==='/api/data-import/cash/apply').length,1);
  assert.doesNotMatch(ui.fields.message.textContent,/signal is aborted|network unavailable/);
  if(outcome==='active'){
    assert.match(ui.fields.message.textContent,/Kassenstand übernommen/);assert.doesNotMatch(ui.fields.detail.innerHTML,/data-i-delete-source/);
  }else{
    assert.match(ui.fields.message.textContent,outcome==='inactive'?/bisher nicht als übernommen bestätigt/:/Ergebnis ist noch unklar/);
    assert.match(ui.fields.detail.innerHTML,/Ergebnis der Übernahme noch unklar/);
    assert.doesNotMatch(ui.fields.detail.innerHTML,/Es läuft derzeit kein Hintergrundauftrag/);
    assert.match(ui.fields.detail.innerHTML,/data-i-check-status/);
    if(outcome==='inactive'){
      source.cashPublication.active=true;await ui.click({},'data-i-check-status');
      assert.match(ui.fields.message.textContent,/Status aktualisiert: Übernommen/);
      assert.equal(ui.requests.filter(r=>r.url==='/api/data-import/cash/apply').length,1);
    }
  }
});

test('an aborted stale refresh cannot overwrite an in-flight cash takeover message',async t=>{
  const original=globalThis.document,events={};
  globalThis.document={hidden:false,addEventListener:(n,h)=>events[n]=h,removeEventListener:n=>delete events[n]};
  t.after(()=>{if(original===undefined)delete globalThis.document;else globalThis.document=original;});
  const source=cashSource();let delayRefresh=false,resolveApply,refreshStarted=false;
  const ui=await mount(t,source,(url,options)=>{
    if(url.endsWith('/sources/search')&&delayRefresh){
      delayRefresh=false;refreshStarted=true;
      return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('signal is aborted without reason','AbortError')),{once:true}));
    }
    if(url==='/api/data-import/cash/apply')return new Promise(resolve=>{resolveApply=()=>{source.cashPublication.active=true;resolve({revision:3});};});
  });
  delayRefresh=true;events.visibilitychange();await tick();assert.equal(refreshStarted,true);
  const applying=ui.click({iAction:'apply'});await tick();
  assert.match(ui.fields.message.textContent,/Gesamter Kassenstand wird übernommen/);
  assert.match(ui.fields.detail.innerHTML,/Kassenstand wird übernommen/);
  assert.doesNotMatch(ui.fields.detail.innerHTML,/Es läuft derzeit kein Hintergrundauftrag/);
  resolveApply();await applying;assert.match(ui.fields.message.textContent,/Kassenstand übernommen/);
});

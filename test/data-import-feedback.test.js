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

function issuePage(runId='lines',after=0){return {runId,table:'ARTIKEL_ZWEITEAN',rows:[{rowNumber:after+1,state:'invalid',issue:'IMPORT_TEXT_INVALID',fields:{EAN:'0000000000042',ZweitEAN:null},invalidFields:[{field:'ZweitEAN',code:'IMPORT_TEXT_INVALID',value:null}],impact:'optional_identifier',article:{status:'same_file',articleNumber:'000042',Artikelbezeichnung:'Camera <img src=x onerror=bad()>',Verkaufspreis:'5000',Filialbestand:null,Auslaufartikel:'false'}}],next:after?null:{after:1}};}
test('issue preview appears before takeover, shows price and unknown stock, escapes source text and pages only issues',async t=>{
 const source=invoiceSource(),ui=await mount(t,source,(url,options)=>{
  if(url.endsWith('/context'))return {available:true,projection,issuePreviewAvailable:true};
  if(url.endsWith('/issues')){const data=JSON.parse(options.body);return issuePage(data.runId,data.after);}
 });
 const html=ui.fields.detail.innerHTML;
 assert.ok(html.indexOf('Problematische Zeilen · vor der Übernahme prüfen')<html.indexOf('data-i-action="apply"'));
 assert.match(html,/5[.\s]000/);assert.match(html,/Filialbestand laut Artikelstamm: Unbekannt/);assert.match(html,/ohne diesen zweiten EAN übernommen/);
 assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
 assert.equal(ui.requests.filter(r=>r.url.endsWith('/issues')).length,1);
 await ui.click({},'data-i-check-status');assert.equal(ui.requests.filter(r=>r.url.endsWith('/issues')).length,1);
 await ui.click({},'data-i-issues-next');assert.match(ui.fields.detail.innerHTML,/Zeile 2/);
 assert.equal(ui.requests.filter(r=>r.url.endsWith('/issues')).length,2);
 assert.equal(ui.requests.filter(r=>r.url.endsWith('/rows')).length,0);
});
test('issue preview keeps a failed read visible and retries explicitly without claiming success',async t=>{
 let fail=true;const source=invoiceSource(),ui=await mount(t,source,url=>{
  if(url.endsWith('/context'))return {available:true,projection,issuePreviewAvailable:true};
  if(url.endsWith('/issues'))return fail?Promise.reject(new Error('synthetic unavailable')):issuePage();
 });
 assert.match(ui.fields.detail.innerHTML,/Prüffälle konnten nicht geladen werden/);assert.doesNotMatch(ui.fields.detail.innerHTML,/keine Prüffälle mehr/);
 fail=false;await ui.click({iIssues:'lines'});assert.match(ui.fields.detail.innerHTML,/Camera/);
});
test('late issue response cannot replace a newly selected source',async t=>{
 let delay=false,resolve;const source=invoiceSource(),other={...source,id:'other',tables:[]};
 const ui=await mount(t,source,url=>{
  if(url.endsWith('/context'))return {available:true,projection,issuePreviewAvailable:true};
  if(url.endsWith('/issues'))return delay?new Promise(r=>{resolve=r;}):issuePage();
  if(url.endsWith('/sources/other'))return other;
 });
 delay=true;const pending=ui.click({iIssues:'lines'});await tick();
 await ui.click({iSource:'other'});resolve(issuePage());await pending;
 assert.doesNotMatch(ui.fields.detail.innerHTML,/Camera|Problematische Zeilen/);
});
test('issue details require prepare permission; a stock issue explains snapshot preservation',()=>{
 const source=invoiceSource(),view={sourceId:source.id,runId:'lines',result:issuePage()};view.result.rows[0].impact='stock_snapshot';
 assert.doesNotMatch(UI.renderSource(source,{...projection,prepare:false,issuePreviewAvailable:true,issueView:view}),/Camera/);
 assert.match(UI.renderSource(source,{...projection,issuePreviewAvailable:true,issueView:view}),/bisherige vollständige Bestandsstand bleibt erhalten/);
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

test('invoice confirmation explains valid-row apply and deferred issues; row feedback is escaped',async t=>{
  const source=invoiceSource();let applied=false;
  const ui=await mount(t,source,(url)=>{
    if(url.endsWith('/apply-background')){applied=true;return {...source,active:true,status:'applying'};}
    if(url.endsWith('/rows'))return {rows:[{rowNumber:1,state:'conflict',issue:'HISTORY_PARENT_REQUIRED'},{rowNumber:2,state:'conflict',issue:'<script>bad</script>'}]};
  });
  await ui.click({iRows:'lines'});assert.match(ui.fields.log.innerHTML,/Rechnung_A derselben Datei/);assert.doesNotMatch(ui.fields.log.innerHTML,/<script>/);
  await ui.click({iAction:'apply'});assert.equal(applied,true);
  assert.match(ui.confirmations[0],/Gültige Rechnungsdaten.*übernehmen/);
  assert.match(ui.confirmations[0],/Positionen ohne passenden Rechnungskopf.*andere Prüffälle bleiben zurückgestellt/);
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

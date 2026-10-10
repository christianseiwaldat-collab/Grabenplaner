'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Sales=require('../public/gp-sales-analytics-print'),Existing=require('../public/gp-existing-pdf-window');
const options={orientation:'portrait',charts:['ranking','absolute_change','pareto'],topN:20,includeKpis:true,includeTable:true,filenamePrefix:'My report'};
function fixture({ui=false}={}){
  let passed,input,owner='one',allowed=true,active=true,selected={reportId:'a',horizon:'year_to_date',metric:'netRevenue'},model=1,rawApi;
  const blob=new Blob(['%PDF-1.7\nEXAMPLE unchanged sales PDF'],{type:'application/pdf'}),response={ok:true,headers:new Headers({'Content-Disposition':'attachment; filename="Actual-server-name.pdf"'}),blob:async()=>blob};
  const standard={open(value){input=value;return passed.canUse();},activate(){},deactivate(){},sync(){},reset(){}};
  const doc={defaultView:{location:{origin:'https://gp.example.test'},GpPrintWindow:{mount(config){passed=config;return standard;}},GpExistingPdfWindow:Existing}};
  if(ui){doc.createElement=tag=>new Node(tag);doc.createTextNode=text=>({textContent:text});}
  rawApi=async()=>response;
  const config={document:doc,key:()=>owner,canUse:()=>allowed,active:()=>active,selection:()=>selected,context:()=>({selected,model}),options:()=>options,normalizeOptions:value=>({...options,...value,topN:Number(value.topN??options.topN)}),rawApi:(...args)=>rawApi(...args)};
  return {doc,config,standard,blob,response,get passed(){return passed;},get input(){return input;},select(value){selected=value;},model(value){model=value;},owner(value){owner=value;},allow(value){allowed=value;},active(value){active=value;},api(value){rawApi=value;}};
}
test('single and series bodies preserve exact specialized PDF schema and copy report IDs',()=>{
  assert.deepEqual(Sales.body({reportId:'one',horizon:'year_to_date',metric:'netRevenue',privateData:'ignored'},options),{reportId:'one',horizon:'year_to_date',metric:'netRevenue',optionsVersion:1,options});
  const ids=['one','two'],selected=Sales.selection({reportIds:ids,horizon:'year_to_date',metric:'grossMargin'});ids.push('three');
  assert.deepEqual(Sales.body(selected,options),{reportIds:['one','two'],horizon:'period',metric:'grossMargin',optionsVersion:1,options});
  assert.equal(Sales.selection(null),null);assert.throws(()=>Sales.body({},options),/Verkaufsanalyse/);
});
test('actual shared adapter preserves original PDF bytes, all options and server filename',async()=>{
  const f=fixture(),calls=[];f.api(async(...args)=>{calls.push(args);return f.response;});const print=Sales.mount(f.config);print.open();
  const result=await f.passed.createPdf({payload:f.input.payload,values:{},options,actor:'one',signal:new AbortController().signal});
  assert.equal(result.blob,f.blob);assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()),new Uint8Array(await f.blob.arrayBuffer()));assert.equal(result.filename,'Actual-server-name.pdf');
  assert.equal(calls[0][0],'/api/sales-analytics/charts.pdf');assert.deepEqual(JSON.parse(calls[0][1].body),Sales.body({reportId:'a',horizon:'year_to_date',metric:'netRevenue'},options));assert.equal(calls[0][1].method,'POST');
  assert.equal(f.passed.commonFields,false);
});
test('scope changes hard invalidate; page activation stays separate from permission and preserves selected options',()=>{
  const f=fixture(),print=Sales.mount(f.config);print.open();f.active(false);assert.equal(f.passed.canUse(),true,'Navigation alone does not reset the options');assert.equal(f.passed.active(),false);
  f.active(true);f.model(2);assert.equal(f.passed.canUse(),false);assert.throws(()=>f.passed.request({payload:f.input.payload,options}),/Berichtsauswahl/);
  assert.equal(print.open(),true);f.select({reportIds:['a','b'],horizon:'period',metric:'quantity'});assert.equal(f.passed.canUse(),false);assert.equal(print.open(),true);f.allow(false);assert.equal(print.open(),false);
});
test('late PDFs are discarded after model/selection, actor, rights and page changes',async()=>{
  for(const change of [f=>f.model(2),f=>f.select({reportId:'b',horizon:'period',metric:'netRevenue'}),f=>f.owner('two'),f=>f.allow(false),f=>f.active(false)]){
    const f=fixture();Sales.mount(f.config).open();let release;f.api(()=>new Promise(resolve=>{release=resolve;}));
    const pending=f.passed.createPdf({payload:f.input.payload,values:{},options,actor:'one',signal:new AbortController().signal});await Promise.resolve();await Promise.resolve();change(f);release(f.response);await assert.rejects(pending,{name:'AbortError'});
  }
});
class Node {
  constructor(tag){this.tag=tag;this.children=[];this.listeners=new Map();this.value='';this.checked=false;this.disabled=false;this.textContent='';}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  setAttribute(){}
  addEventListener(type,fn){this.listeners.set(type,fn);}
  removeEventListener(type){this.listeners.delete(type);}
  closest(){return {reportValidity:()=>true};}
  all(){return this.children.flatMap(node=>node instanceof Node?[node,...node.all()]:[]);}
  querySelector(selector){return this.querySelectorAll(selector)[0];}
  querySelectorAll(selector){const name=selector.match(/name=["']?([^\]"']+)/)?.[1];return this.all().filter(node=>node.name===name&&(!selector.includes(':checked')||node.checked));}
  async fire(type){await this.listeners.get(type)?.({target:this});}
}
test('saving is explicit, retains all five chart choices and a delayed reply does not mark newer options saved',async()=>{
  const f=fixture({ui:true});let release,saved;f.config.saveOptions=value=>{saved=value;return new Promise(resolve=>{release=resolve;});};Sales.mount(f.config).open();
  const host=new Node('div');let refreshed=0;const cleanup=f.passed.renderOptions(host,{changed:()=>refreshed++});
  assert.equal(host.querySelectorAll('[name=chart]').length,5);assert.equal(host.querySelector('[name=topN]').min,'5');assert.equal(host.querySelector('[name=topN]').max,'20');
  assert.equal(saved,undefined,'Rendering/preview does not save preferences');
  const save=host.all().find(node=>node.textContent==='Als persönliche Vorgabe speichern'),reset=host.all().find(node=>node.textContent==='Standard wiederherstellen'),status=host.children.at(-1);
  const pending=save.fire('click');assert.deepEqual(saved,options);host.querySelector('[name=topN]').value='12';await host.fire('input');release();await pending;
  assert.match(status.textContent,/aktuellen Änderungen sind noch nicht gespeichert/);assert.equal(save.disabled,false);
  const again=save.fire('click');release();await again;assert.equal(status.textContent,'Für dein Konto gespeichert.');
  await reset.fire('click');assert.equal(refreshed,1);assert.match(status.textContent,/noch nicht/);cleanup();assert.equal(save.listeners.has('click'),false);
});
test('save replies cannot update another actor, revoked scope or destroyed options',async()=>{
  for(const change of [f=>f.owner('two'),f=>f.allow(false),f=>f.model(2),(_f,cleanup)=>cleanup()]){
    const f=fixture({ui:true});let release;f.config.saveOptions=()=>new Promise(resolve=>{release=resolve;});Sales.mount(f.config).open();const host=new Node('div'),cleanup=f.passed.renderOptions(host,{changed(){}}),save=host.all().find(node=>node.textContent==='Als persönliche Vorgabe speichern'),status=host.children.at(-1);
    const pending=save.fire('click');change(f,cleanup);release();await pending;assert.doesNotMatch(status.textContent,/Für dein Konto gespeichert/);
  }
});
test('only completed PDF jobs use their safely encoded original download endpoint',()=>{
  assert.deepEqual(Sales.completedJobRequest({status:'completed',format:'pdf',id:'job/one'}),{url:'/api/sales-report-jobs/job%2Fone/download'});
  for(const row of [null,{status:'running',format:'pdf',id:'a'},{status:'completed',format:'html',id:'a'}])assert.throws(()=>Sales.completedJobRequest(row),/noch nicht verfügbar/);
});
test('app explicit-save applies local preferences only after full actor, revision, scope and rights guard',async()=>{
  const source=fs.readFileSync(require.resolve('../public/app'),'utf8'),start=source.indexOf('async function saveSalesAnalyticsPrintOptions('),end=source.indexOf('function openSalesAnalyticsPdfOptions(',start);
  for(const mutate of [()=>{},s=>s.account='two',s=>s.allowed=false,s=>s.context='other',s=>s.state.salesAnalytics.preferencesRequestId++]){
    let release;const applied=[],sandbox={account:'one',allowed:true,context:'one',state:{salesAnalytics:{preferencesRequestId:0,preferencesSaving:false}},canUseSalesAnalyticsPrint:()=>sandbox.allowed,startDashboardWorkspaceActorKey:()=>sandbox.account,currentSalesAnalyticsActorKey:()=>sandbox.account,salesAnalyticsActorIsCurrent:key=>key===sandbox.account,salesAnalyticsPrintContext:()=>sandbox.context,saveSalesAnalyticsPreferences:()=>new Promise(resolve=>{release=resolve;}),applySalesAnalyticsPreferences:value=>applied.push(value)};
    vm.createContext(sandbox);vm.runInContext(source.slice(start,end),sandbox);const pending=sandbox.saveSalesAnalyticsPrintOptions(options);mutate(sandbox);release({pdf:options});
    if(sandbox.account==='one'&&sandbox.allowed&&sandbox.context==='one'&&sandbox.state.salesAnalytics.preferencesRequestId===1){await pending;assert.equal(applied.length,1);assert.equal(sandbox.state.salesAnalytics.preferencesSaving,false);}else{await assert.rejects(pending,/geändert/);assert.equal(applied.length,0);}
  }
});
test('completed-job UI preserves original bytes and rejects deleted jobs, hidden pages and changed accounts',async()=>{
  const source=fs.readFileSync(require.resolve('../public/sales-report-jobs'),'utf8'),start=source.indexOf('  let pdfWindow = null'),end=source.indexOf('  const selectors =',start);
  for(const change of [()=>{},s=>s.rows=[],s=>s.generation++,s=>s.allowed=false,s=>s.active=false,s=>s.owner='two']){
    let passed,input,release;const row={id:'job/one',title:'BEISPIEL Original title',status:'completed',format:'pdf'},blob=new Blob(['%PDF-1.7\nEXAMPLE stored job'],{type:'application/pdf'});
    const controller={open(value){input=value;return passed.canUse();},activate(){},deactivate(){},sync(){}};
    const doc={defaultView:{location:{origin:'https://gp.example.test'},GpPrintWindow:{mount(config){passed=config;return controller;}},GpExistingPdfWindow:Existing}};
    const sandbox={document:doc,window:{GpExistingPdfWindow:Existing,GpSalesAnalyticsPrint:Sales},owner:'one',allowed:true,active:true,rows:[row],generation:0,context:{projection:{read:true}},rawApi:()=>new Promise(resolve=>{release=resolve;}),accessKey:()=>sandbox.owner,canUse:()=>sandbox.allowed,printActive:()=>sandbox.active,windowPreferences:null,scale:()=>1};
    vm.createContext(sandbox);vm.runInContext(source.slice(start,end),sandbox);sandbox.openPdf(row,{id:'button'});
    assert.equal(input.values.title,row.title);assert.deepEqual(JSON.parse(JSON.stringify(passed.commonFields)),{title:'readonly',filename:true,orientation:false});
    const result=passed.createPdf({payload:input.payload,values:input.values,actor:'one',signal:new AbortController().signal});await Promise.resolve();await Promise.resolve();change(sandbox);release({ok:true,headers:new Headers({'Content-Disposition':'attachment; filename="Stored.pdf"'}),blob:async()=>blob});
    if(sandbox.rows.length&&sandbox.generation===0&&sandbox.allowed&&sandbox.active&&sandbox.owner==='one'){const pdf=await result;assert.equal(pdf.blob,blob);assert.equal(pdf.filename,'Stored.pdf');}else await assert.rejects(result,{name:'AbortError'});
  }
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Receipts=require('../public/gp-receipt-print'),Existing=require('../public/gp-existing-pdf-window');
function fixture(){
  let passed,input,owner='one',allowed=true,active=true,context='source-one',api;const calls=[];
  const blob=new Blob(['%PDF-1.7\nEXAMPLE original full receipt'],{type:'application/pdf'}),response={ok:true,headers:new Headers({'Content-Disposition':'attachment; filename="Original-receipt.pdf"'}),blob:async()=>blob};
  const state={open:false,loading:false},controller={state,open(value){input=value;state.open=state.loading=true;calls.push(value);return true;},activate(){},deactivate(){},reset(){state.open=state.loading=false;},sync(){},destroy(){}};
  const doc={defaultView:{location:{origin:'https://gp.example.test'},GpReceiptPrint:Receipts,GpExistingPdfWindow:Existing,GpPrintWindow:{mount(config){passed=config;return controller;}}}};api=async()=>response;
  const config={document:doc,key:()=>owner,canUse:()=>allowed,active:()=>active,contextKey:()=>context,rawApi:(...args)=>api(...args)};
  return {doc,config,controller,calls,blob,response,get passed(){return passed;},get input(){return input;},owner(value){owner=value;},allow(value){allowed=value;},active(value){active=value;},context(value){context=value;},api(value){api=value;}};
}
test('receipt selection copies every ID and validates the established 1-50 limit without truncating',()=>{
  const selected=Array.from({length:50},(_,i)=>'receipt-'+i),saved=Receipts.ids(selected);selected.pop();assert.equal(saved.length,50);
  for(const values of [[],['one','one'],[null],[1],[''],Array.from({length:51},(_,i)=>String(i))])assert.throws(()=>Receipts.ids(values),/1 bis 50/);
});
test('all selected receipt/cash IDs use the exact original POST body, fixed paper and unchanged PDF bytes',async()=>{
  const f=fixture(),requests=[],ids=Array.from({length:50},(_,i)=>'cash-'+i);f.api(async(...args)=>{requests.push(args);return f.response;});Receipts.mount(f.config).open(ids);ids.pop();
  const input={payload:f.input.payload,values:{filename:'Beleginformation-keine-Rechnung'},actor:'one',signal:new AbortController().signal};
  const pdf=await f.passed.createPdf(input);assert.equal(pdf.blob,f.blob);assert.equal(pdf.filename,'Original-receipt.pdf');assert.deepEqual(JSON.parse(requests[0][1].body),{ids:Array.from({length:50},(_,i)=>'cash-'+i)});assert.equal(requests[0][0],'/api/receipt-search/export.pdf');
  assert.deepEqual(f.passed.commonFields,{title:'readonly',filename:true,orientation:false});assert.equal(f.passed.summary(input),'50 ausgewählte Belege/Buchungen');
  input.values.filename='My selected receipts';assert.equal((await f.passed.createPdf(input)).filename,'My selected receipts');
});
test('branch adapter keeps its distinct endpoint and identical authorized request schema',async()=>{
  const f=fixture(),requests=[];f.config.endpoint='/api/portal/v1/branch-receipts/export.pdf';f.api(async(...args)=>{requests.push(args);return f.response;});Receipts.mount(f.config).open(['branch-one']);
  await f.passed.createPdf({payload:f.input.payload,values:{},actor:'one',signal:new AbortController().signal});assert.equal(requests[0][0],f.config.endpoint);assert.deepEqual(JSON.parse(requests[0][1].body),{ids:['branch-one']});
});
test('same selection double clicks retain one in-flight preview while changed selection can open immediately',()=>{
  const f=fixture(),print=Receipts.mount(f.config);assert.equal(print.open(['one']),true);assert.equal(print.open(['one']),false);assert.equal(f.calls.length,1);
  assert.equal(print.open(['two']),true);assert.equal(f.calls.length,2);assert.deepEqual(f.input.payload.ids,['two']);
});
test('ordinary navigation stays separate from authority; source, selection, rights and actors reject late bytes',async()=>{
  const f=fixture();Receipts.mount(f.config).open(['one']);f.active(false);assert.equal(f.passed.canUse(),true,'Navigation keeps the filename/options draft');assert.equal(f.passed.active(),false);
  for(const mutate of [f=>f.active(false),f=>f.context('source-two'),f=>f.context('selection-two'),f=>f.owner('two'),f=>f.allow(false)]){
    const s=fixture();Receipts.mount(s.config).open(['one']);let release;s.api(()=>new Promise(resolve=>{release=resolve;}));
    const pending=s.passed.createPdf({payload:s.input.payload,values:{},actor:'one',signal:new AbortController().signal});await Promise.resolve();await Promise.resolve();mutate(s);release(s.response);await assert.rejects(pending,{name:'AbortError'});
  }
});
function extract(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
test('desktop receipt action captures the full current selection and guards result/source/selection changes',async()=>{
  const source=fs.readFileSync(require.resolve('../public/receipt-search'),'utf8');
  const context=source.match(/    const printContext = [^\n]+/)[0],action=extract(source,'    function exportPdf(ids, target)','    async function detail(');
  const f=fixture(),sandbox={disposed:false,pdfWindow:null,pdfActive:true,authorized:()=>true,active:()=>true,context:{available:true,sources:[{id:'source-one'}]},generation:1,query:{sourceId:'source-one',kind:'daily'},resultSet:'results-one',selected:new Set(['one','two']),root:{ownerDocument:f.doc},rawApi:f.config.rawApi,accessKey:f.config.key,windowPreferences:null,scale:null,exporting:false,el:()=>({open:false}),message:()=>{}};
  vm.createContext(sandbox);vm.runInContext(context+'\n'+action,sandbox);sandbox.exportPdf([...sandbox.selected],{id:'export'});assert.deepEqual(Array.from(f.input.payload.ids),['one','two']);
  sandbox.selected.add('three');assert.equal(f.passed.canUse(),false);assert.throws(()=>f.passed.request({payload:f.input.payload}),/Belegauswahl/);
});
test('article receipt action submits only the selected receipt and invalidates changed article history filters',()=>{
  const source=fs.readFileSync(require.resolve('../public/sales-article-tools'),'utf8'),action=extract(source,'  function receipt(row,target)','  function history(kind)');
  const context=source.match(/  const receiptContext=[^\n]+/)[0],f=fixture(),filters={dateFrom:'2025-10-10',dateTo:'2026-10-10',locationId:'18',personnel:''};
  const sandbox={receiptPdf:null,states:{sales:{ticket:1,resultSet:'one',status:{}}},article:{articleNumber:'000042'},selectedFilters:()=>filters,context:{sales:true},authorized:()=>true,active:()=>true,root:{ownerDocument:f.doc},rawApi:f.config.rawApi,accessKey:f.config.key,windowPreferences:null,scale:null};
  vm.createContext(sandbox);vm.runInContext(context+'\n'+action,sandbox);sandbox.receipt({receiptId:'chosen',receipt:'123'},{id:'button'});assert.deepEqual(Array.from(f.input.payload.ids),['chosen']);assert.equal(f.passed.id,'article-receipt-pdf');
  filters.locationId='19';assert.equal(f.passed.canUse(),false);assert.throws(()=>f.passed.request({payload:f.input.payload}),/Belegauswahl/);
});
test('main and portal pages load the same shared PDF dependencies before their application',()=>{
  for(const page of ['index','portal']){
    const html=fs.readFileSync(require.resolve('../public/'+page+'.html'),'utf8');let previous=-1;
    for(const script of ['gp-window.js','sales-article-report-pdf-preview.js','gp-print-window.js','gp-existing-pdf-window.js','gp-receipt-print.js',page==='portal'?'portal.js':'app.js']){const at=html.indexOf('src="/'+script+'"');assert.ok(at>previous,script);previous=at;}
    assert.match(html,/href="\/gp-print-window.css"/);
  }
});

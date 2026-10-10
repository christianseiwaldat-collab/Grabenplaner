'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Existing=require('../public/gp-existing-pdf-window'),Print=require('../public/gp-print-window');
const origin='https://gp.example.test';
function setup(overrides={}){
  let owner='one',allowed=true,calls=[];
  const blob=new Blob(['%PDF-1.7\nEXAMPLE unchanged bytes'],{type:'application/pdf'});
  const response={ok:true,headers:new Headers({'Content-Disposition':"attachment; filename*=UTF-8''Beleg-%C3%A4.pdf"}),blob:async()=>blob};
  const args={origin,url:'/api/receipt-search/export.pdf',init:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:['doc-1']})},key:()=>owner,owner,canUse:()=>allowed,signal:new AbortController().signal,
    rawApi:async(url,init)=>{calls.push({url,init});return response;},...overrides};
  return {args,calls,blob,response,owner(value){owner=value;},allow(value){allowed=value;}};
}
test('existing PDF requests preserve endpoint schemas and return identical PDF Blob bytes',async()=>{
  const s=setup(),result=await Existing.fetchBlob(s.args);
  assert.equal(result.blob,s.blob);assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()),new Uint8Array(await s.blob.arrayBuffer()));
  assert.equal(result.filename,'Beleg-ä.pdf');assert.equal(s.calls[0].url,s.args.url);
  assert.deepEqual(JSON.parse(s.calls[0].init.body),{ids:['doc-1']});assert.equal(s.calls[0].init.signal,s.args.signal);
  assert.equal(s.calls[0].init.redirect,'error');assert.equal(s.calls[0].init.credentials,'same-origin');
});
test('foreign origins, credentials, fragments and non-API paths cannot be fetched',async()=>{
  for(const url of ['https://outside.example/api/a.pdf','//outside.example/api/a.pdf','https://someone:secret@gp.example.test/api/a.pdf','/api/a.pdf#other','/api/../outside.pdf','/other.pdf','']){
    const s=setup({url});await assert.rejects(Existing.fetchBlob(s.args),/PDF-Adresse/);assert.equal(s.calls.length,0);
  }
  assert.equal(Existing.protectedUrl(origin+'/api/a.pdf?location=18',origin),'/api/a.pdf?location=18');
});
test('missing owners, revocation and abort fail before fetching',async()=>{
  for(const change of [s=>s.owner('two'),s=>s.allow(false),s=>{s.args.owner='';},s=>{const c=new AbortController();c.abort();s.args.signal=c.signal;}]){
    const s=setup();change(s);await assert.rejects(Existing.fetchBlob(s.args),{name:'AbortError'});assert.equal(s.calls.length,0);
  }
});
test('owner changes and revocation while loading cannot reveal late PDF bytes',async()=>{
  for(const phase of ['response','blob']){
    const s=setup();let reads=0;
    s.response.blob=async()=>{reads++;if(phase==='blob')s.allow(false);return s.blob;};
    s.args.rawApi=async()=>{if(phase==='response')s.owner('two');return s.response;};
    await assert.rejects(Existing.fetchBlob(s.args),{name:'AbortError'});assert.equal(reads,phase==='response'?0:1);
  }
});
test('malformed MIME, empty/oversized results and failed responses remain errors',async()=>{
  for(const blob of [new Blob(['%PDF-some'],{type:'text/html'}),new Blob(['bad'],{type:'application/pdf'}),new Blob(['%PDF-123456'],{type:'application/pdf'})]){
    const s=setup({maxBytes:9});s.response.blob=async()=>blob;await assert.rejects(Existing.fetchBlob(s.args),/leer oder ungültig/);
  }
  const s=setup();s.response.ok=false;s.response.status=403;s.response.json=async()=>({error:'Berechtigung fehlt.'});
  await assert.rejects(Existing.fetchBlob(s.args),error=>error.status===403&&error.message==='Berechtigung fehlt.');
});
test('all existing-document common fields can be hidden or read-only, while custom paper can hide orientation',()=>{
  assert.deepEqual(Print.normalizeCommonFields(),{title:'editable',filename:'editable',orientation:'editable'});
  assert.deepEqual(Print.normalizeCommonFields(false),{title:'hidden',filename:'hidden',orientation:'hidden'});
  assert.deepEqual(Print.normalizeCommonFields('readonly'),{title:'readonly',filename:'readonly',orientation:'readonly'});
  assert.deepEqual(Print.normalizeCommonFields({title:'readonly',orientation:false}),{title:'readonly',filename:'editable',orientation:'hidden'});
  for(const v of [null,[],{other:true},{orientation:'pretend'}])assert.throws(()=>Print.normalizeCommonFields(v),/Druckfelder/);
});
test('adapter delegates window preferences/lifecycle/options and explicit request mapping to shared standard',async()=>{
  const s=setup();let passed,input;
  const controller={open(){},activate(){},deactivate(){},reset(){},destroy(){}};
  const preferences={subscribe(){},change(){}},doc={defaultView:{location:{origin},GpPrintWindow:{mount(config){passed=config;return controller;}}}};
  const request=values=>{input=values;return{url:s.args.url,init:s.args.init};};
  const renderOptions=()=>{},readOptions=()=>({detailed:true});
  const result=Existing.mount({document:doc,key:s.args.key,canUse:s.args.canUse,request,rawApi:s.args.rawApi,windowPreferences:preferences,renderOptions,readOptions});
  assert.equal(result,controller);assert.equal(passed.windowPreferences,preferences);assert.equal(passed.renderOptions,renderOptions);assert.equal(passed.readOptions,readOptions);
  assert.deepEqual(passed.commonFields,{title:'readonly',filename:true,orientation:false});
  const pdf=await passed.createPdf({actor:'one',signal:s.args.signal,values:{title:'Existing',filename:'My filename',orientation:'portrait'},payload:{documentId:'doc-1'},options:{detailed:true}});
  assert.equal(pdf.blob,s.blob);assert.equal(pdf.filename,'My filename');assert.deepEqual(input.payload,{documentId:'doc-1'});
  assert.deepEqual(JSON.parse(s.calls[0].init.body),{ids:['doc-1']},'Generic presentation values were not inserted into the exact API request');
});
test('Content-Disposition UTF-8 and fallback filenames are decoded without altering document content',()=>{
  assert.equal(Existing.responseName('attachment; filename="original.pdf"'),'original.pdf');
  assert.equal(Existing.responseName("attachment; filename=\"fallback.pdf\"; filename*=UTF-8''%GG"),'fallback.pdf');
  assert.equal(Existing.responseName('attachment'),'');
});

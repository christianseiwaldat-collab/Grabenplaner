'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Labels=require('../public/sales-price-labels');
const Project=require('../public/sales-price-label-project');
const Existing=require('../public/gp-existing-pdf-window');
const Print=require('../public/gp-price-label-pdf');
const options=Labels.normalizeOptions({paper:'custom',paperWidthMm:80.25,paperHeightMm:150.5,orientation:'landscape',labelWidthMm:70,labelHeightMm:40,marginMm:3});
const form=()=>({articleNumbers:['001234','001235'],priceType:'internet_3',options:structuredClone(options),name:'Regal Oktober',stamp:'date-suffix',position:'after',separator:'_',suffix:'Fil18'});
const input=()=>({url:'/api/sales/price-labels/export.pdf',body:form(),filename:'Regal_Oktober.pdf',dimensions:{...Labels.paperLayout(options),labels:[{width:70,height:40}]}});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};

test('Captured form keeps all existing mm, design and filename fields without adding PDF common controls',()=>{
 const source=input(),captured=Print.capture(source);source.body.options.labelWidthMm=99;source.body.articleNumbers.push('other');
 assert.deepEqual(JSON.parse(captured.body),form());assert.equal(Object.isFrozen(captured),true);
 assert.match(captured.summary,/Papier 150,5 × 80,25 mm/);assert.match(captured.summary,/Schilder 70 × 40 mm/);assert.match(captured.summary,/100 % \/ Tatsächliche Größe drucken/);
 assert.equal(Object.hasOwn(JSON.parse(captured.body),'orientation'),false);
});

test('Individual-label projects keep all labels, paper settings and project filename options',()=>{
 const paper=Object.fromEntries(Project.PAPER_KEYS.map(key=>[key,options[key]])),id='00000000-0000-0000-0000-000000000001',second='00000000-0000-0000-0000-000000000002';
 const project=Project.normalize({schemaVersion:1,name:'Fenster',paper,filenameOptions:{stamp:'none',position:'before',separator:' ',suffix:''},selectedLabelId:id,labels:[
  {id,articleNumber:'001234',priceType:'sales',options},
  {id:second,articleNumber:'001235',priceType:'internet_1',options:{...options,labelWidthMm:45,labelHeightMm:25}},
 ]},Labels.normalizeOptions);
 const captured=Print.capture({url:'/api/sales/price-labels/projects/export.pdf',body:{project,name:'Meine Schilder'},filename:'Meine Schilder.pdf',dimensions:{...Project.paperLayout(project),labels:project.labels.map(label=>({width:label.options.labelWidthMm,height:label.options.labelHeightMm}))}});
 assert.deepEqual(JSON.parse(captured.body),{project,name:'Meine Schilder'});assert.match(captured.summary,/70 × 40 mm, 45 × 25 mm/);assert.equal(JSON.parse(captured.body).project.labels.length,2);
});

test('Library request remains exactly one article number, including encoded template identity',()=>{
 const captured=Print.capture({url:'/api/sales/price-labels/library/template%2Fid/article.pdf',body:{articleNumber:'001234'},filename:'Vorlage.pdf',dimensions:{width:210,height:297,labels:[{width:70,height:40}]},metadata:{version:3}});
 assert.equal(captured.body,'{"articleNumber":"001234"}');assert.deepEqual(captured.metadata,{version:3});
 for(const value of [{...input(),body:{...form(),employeeNumber:'other'}},{...input(),url:'https://other.example/api/sales/price-labels/export.pdf'},{...input(),url:'/api/sales/price-labels/export.pdf?orientation=landscape'},{url:'/api/sales/price-labels/library/t/article.pdf',body:{articleNumber:'001234',version:3},dimensions:{width:210,height:297}}])assert.throws(()=>Print.capture(value));
});

function fixture({rawApi=async()=>{},validateResponse}={}){
 let actor='a',context='draft-1',active=true,rights=true,config,payload,abort,resets=0,blobRead=false;
 const doc={defaultView:{location:{origin:'https://gp.example'},GpExistingPdfWindow:Existing,GpPrintWindow:{mount(value){config=value;return{
  open(input){payload=input.payload;abort=new AbortController();return true;},reset(){resets++;abort?.abort();},sync(){return true;},activate(){},deactivate(){abort?.abort();},destroy(){},element:{},state:{},
 };}}}};
 const controller=Print.mount({document:doc,key:()=>actor,context:()=>context,canUse:()=>rights,active:()=>active,rawApi,validateResponse});
 return{controller,get config(){return config;},get payload(){return payload;},get resets(){return resets;},get signal(){return abort.signal;},
  change(kind){if(kind==='actor')actor='b';if(kind==='draft')context='draft-2';if(kind==='page')active=false;if(kind==='rights')rights=false;},
  draw(){return config.createPdf({payload,actor,signal:abort.signal,values:{filename:payload.filename}});},
 };
}

test('Mounted window delegates the exact POST and the same PDF Blob to the shared standard',async()=>{
 const bytes=new Blob(['%PDF-1.7\nOriginal server bytes'],{type:'application/pdf'});let request;
 const f=fixture({rawApi:async(url,init)=>{request={url,init};return{ok:true,headers:new Headers({'Content-Disposition':"attachment; filename*=UTF-8''Regal%20Oktober.pdf"}),blob:async()=>bytes};}});
 assert.equal(f.controller.open(input(),{id:'actual-button'}),true);const result=await f.draw();
 assert.equal(result.blob,bytes);assert.equal(result.filename,'Regal Oktober.pdf');assert.deepEqual(JSON.parse(request.init.body),form());assert.equal(request.init.method,'POST');
 assert.equal(f.config.commonFields,false);assert.match(result.summary,/150,5 × 80,25 mm/);assert.equal(request.init.signal,f.signal);
 f.controller.destroy();
});

test('Changed actor, rights, page or draft discard a late response before it is read',async()=>{
 for(const change of ['actor','rights','page','draft']){
  const pending=deferred();let read=false;
  const f=fixture({rawApi:()=>pending.promise});f.controller.open(input());const waiting=f.draw();
  f.change(change);if(change==='page')f.controller.deactivate();f.controller.sync();assert.equal(f.signal.aborted,true);
  pending.resolve({ok:true,headers:new Headers(),blob:async()=>{read=true;return new Blob(['%PDF-'],{type:'application/pdf'});}});
  await assert.rejects(waiting,{name:'AbortError'});assert.equal(read,false);assert.ok(f.resets>0);f.controller.destroy();
 }
});

test('Close/deactivation also invalidate a late PDF after a same-account reopen',async()=>{
 const pending=deferred();let reads=0;
 const f=fixture({rawApi:()=>pending.promise});f.controller.open(input());const first=f.draw();f.controller.deactivate();f.controller.open(input());
 pending.resolve({ok:true,headers:new Headers(),blob:async()=>{reads++;return new Blob(['%PDF-'],{type:'application/pdf'});}});
 await assert.rejects(first,{name:'AbortError'});assert.equal(reads,0);f.controller.destroy();
});

test('A concurrent template version change after the PDF response rejects misleading physical-size metadata',async()=>{
 let read=false,verified=false;
 const f=fixture({rawApi:async()=>({ok:true,headers:new Headers(),blob:async()=>{read=true;return new Blob(['%PDF-'],{type:'application/pdf'});}}),validateResponse:async(payload)=>{
  verified=true;const currentVersion=4;if(currentVersion!==payload.metadata.version)throw Error('Die Vorlage wurde inzwischen geändert. Bitte neu laden.');
 }});
 f.controller.open({url:'/api/sales/price-labels/library/one/article.pdf',body:{articleNumber:'001234'},filename:'Vorlage.pdf',dimensions:{width:210,height:297},metadata:{version:3}});
 await assert.rejects(f.draw(),/Vorlage wurde inzwischen geändert/);assert.equal(verified,true);assert.equal(read,false);f.controller.destroy();
});

test('Malformed paper dimensions are unknown, rather than silently becoming A4 or stretching labels',()=>{
 for(const dimensions of [{width:null,height:297},{width:0,height:297},{width:210,height:NaN},{width:'210',height:297}])assert.throws(()=>Print.paperSummary(dimensions));
});

test('Page deactivation retains captured print settings while domain permissions remain valid',()=>{
 const f=fixture();f.controller.open(input());const payload=f.payload,resets=f.resets;
 f.change('page');f.controller.deactivate();f.controller.sync();assert.equal(f.config.canUse(),true);assert.equal(f.config.active(),false);assert.equal(f.payload,payload);assert.equal(f.resets,resets);assert.equal(f.signal.aborted,true);
 f.controller.destroy();
});

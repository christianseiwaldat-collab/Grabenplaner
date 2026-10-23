'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Guide=require('../public/gp-usb-guide-print'),Existing=require('../public/gp-existing-pdf-window');
test('USB PDF uses a bound POST snapshot and discards responses after input or owner changes',async()=>{
 let owner='A',body={profile:'staff',firstSteps:{title:'Example'}},allowed=true,config,input,release;
 const controller={open(value){input=value;return true;}};
 const doc={defaultView:{location:{origin:'https://gp.example.test'},GpExistingPdfWindow:Existing,GpPrintWindow:{mount(value){config=value;return controller;}}}};
 const print=Guide.mount({document:doc,key:()=>owner,canUse:()=>allowed,context:()=>body,active:()=>true,rawApi:()=>new Promise(resolve=>release=resolve)});
 assert.equal(print.open(),true);const request=config.request({payload:input.payload});
 assert.deepEqual(request,{url:'/api/usb-provisioning/first-steps.pdf',init:{method:'POST',headers:{'Content-Type':'application/json','X-Grabenplaner-USB-Action':'provisioning'},body:JSON.stringify(body)}});
 const run={actor:owner,payload:input.payload,values:input.values,signal:new AbortController().signal};
 const pending=config.createPdf(run);await Promise.resolve();body.firstSteps.title='Changed';
 release(new Response(new Blob(['%PDF-1.7 Example'],{type:'application/pdf'})));await assert.rejects(pending,{name:'AbortError'});
 assert.equal(config.canUse(),false);assert.equal(print.open(),true);assert.equal(config.canUse(),true);
 const pendingOwner=config.createPdf({...run,payload:input.payload});await Promise.resolve();owner='B';release(new Response(new Blob(['%PDF-1.7 Example'],{type:'application/pdf'})));await assert.rejects(pendingOwner,{name:'AbortError'});
 allowed=false;assert.equal(print.open(),false);
});

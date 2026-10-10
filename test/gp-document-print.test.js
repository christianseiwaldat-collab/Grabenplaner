'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../public/gp-document-print.js');
const origin='http://127.0.0.1:3412';
test('only reviewed original PDF routes are intercepted',()=>{
  for(const url of ['/api/time-record-statements/abc/download','/api/portal/v1/self/time-record-statements/abc/download','/api/portal/v1/personnel-learning/assignments/abc/confirmation.pdf','/api/portal/v1/loans/documents/abc','/api/portal/v1/loans/photo-attachments/abc/download','/api/portal/v1/system-center/recovery-assurance/reports/'+ 'a'.repeat(64)+'.pdf']) assert.equal(api.matchUrl(url,origin),url);
  for(const url of ['https://example.org/api/time-record-statements/abc/download','http://name:secret@127.0.0.1:3412/api/time-record-statements/abc/download','/api/time-record-statements/abc/download?token=secret','/api/time-record-statements/abc/download#fragment','/api/portal/v1/loans/photo-attachments/abc/preview','/api/export.csv','blob:123','/api/portal/v1/system-center/recovery-assurance/reports/other.pdf']) assert.equal(api.matchUrl(url,origin),null);
});
test('navigation deactivates without reset; disconnected source invalidates original document window',()=>{
  let handler,captured,opened,resets=0,deactivations=0,page='timeTracking',actor='a';
  const print={open(input){opened=input;return true;},reset(){resets++;},activate(){},deactivate(){deactivations++;},sync(){},destroy(){}};
  const doc={addEventListener(t,h){handler=h;},removeEventListener(){},defaultView:{location:{origin},GpExistingPdfWindow:{mount(config){captured=config;return print;}}}};
  const manager=api.mount({document:doc,rawApi(){},key:()=>actor,page:()=>page});
  const anchor={href:origin+'/api/time-record-statements/abc/download',textContent:'Original',isConnected:true};
  let prevented=false;handler({button:0,target:{closest:()=>anchor},preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(opened.payload.url,'/api/time-record-statements/abc/download');
  assert.equal(captured.commonFields,false);assert.equal(captured.useServerFilename,true);assert.equal(captured.canUse(),true);
  page='other';assert.equal(captured.canUse(),true);assert.equal(captured.active(),false);manager.sync();assert.equal(resets,0);assert.equal(deactivations,1);manager.sync();assert.equal(deactivations,1);
  page='timeTracking';manager.sync();assert.equal(captured.active(),true);manager.open(anchor.href,anchor);anchor.isConnected=false;assert.equal(captured.canUse(),false);manager.sync();assert.equal(resets,2);
  actor='';assert.equal(manager.open(anchor.href,anchor),false);
});

test('actor, permission, domain context and visibility reject a pending original PDF',()=>{
  let captured,actor='A',allowed=true,version=1,visible=true;const doc={addEventListener(){},removeEventListener(){},defaultView:{location:{origin},GpExistingPdfWindow:{mount(c){captured=c;return {open(){return true;},reset(){},activate(){},deactivate(){},sync(){},destroy(){}};}}}};
  const manager=api.mount({document:doc,rawApi(){},key:()=>actor,page:()=> 'personnelAdministration',canUse:()=>allowed,context:()=>({version})});
  const target={isConnected:true,getClientRects:()=>visible?[{}]:[]};
  manager.open('/api/example/protected.pdf',target);assert.equal(captured.canUse(),true);
  version++;assert.equal(captured.canUse(),false);manager.sync();version--;assert.equal(captured.canUse(),false);
  manager.open('/api/example/protected.pdf',target);actor='B';assert.equal(captured.canUse(),false);manager.sync();actor='A';assert.equal(captured.canUse(),false);
  manager.open('/api/example/protected.pdf',target);allowed=false;assert.equal(captured.canUse(),false);manager.sync();assert.equal(manager.open('/api/example/protected.pdf',target),false);
  allowed=true;manager.open('/api/example/protected.pdf',target);visible=false;assert.equal(captured.canUse(),true);assert.equal(captured.active(),false);visible=true;
  let currentReceipt=true;manager.open('/api/example/protected.pdf',target,'Original',()=>currentReceipt);assert.equal(captured.canUse(),true);currentReceipt=false;assert.equal(captured.canUse(),false);
});

test('native-modal bridges use a visible opener and restore once only for the current source',()=>{
  let captured,page='loans',owner='A',valid=true,restored=0,discarded=0,closed=0,opened;
  const fallback={isConnected:true,getClientRects:()=>[{}]},anchor={href:origin+'/api/portal/v1/loans/documents/doc',isConnected:true,getClientRects:()=>[]};
  const doc={querySelectorAll:()=>[fallback],addEventListener(){},removeEventListener(){},defaultView:{location:{origin},GpExistingPdfWindow:{mount(c){captured=c;return {open(input){opened=input;return true;},reset(){},activate(){},deactivate(){},sync(){},destroy(){}};}}}};
  const manager=api.mount({document:doc,rawApi(){},key:()=>owner,page:()=>page,beforeOpen(){closed++;return {canUse:()=>valid,onClose(){restored++;},onDiscard(){discarded++;}};}});
  assert.equal(manager.open(anchor.href,anchor),true);assert.equal(closed,1);assert.equal(opened.target,fallback);assert.equal(captured.active(),true);
  captured.onClose();captured.onClose();assert.equal(restored,1);assert.equal(discarded,0);
  manager.open(anchor.href,anchor);page='other';manager.sync();assert.equal(discarded,1);captured.onClose();assert.equal(restored,1);
  page='loans';manager.open(anchor.href,anchor);valid=false;manager.sync();assert.equal(discarded,2);captured.onClose();assert.equal(restored,1);
  valid=true;manager.open(anchor.href,anchor);owner='B';manager.sync();assert.equal(discarded,3);captured.onClose();assert.equal(restored,1);
});

test('only ordinary local clicks delegate; source URL mutations and resets invalidate an open PDF',()=>{
  let click,captured,opened=0;const anchor={href:origin+'/api/time-record-statements/abc/download',textContent:'PDF',isConnected:true};
  const doc={addEventListener(_type,handler){click=handler;},removeEventListener(){},defaultView:{location:{origin},GpExistingPdfWindow:{mount(c){captured=c;return {open(){opened++;return true;},reset(){},activate(){},deactivate(){},sync(){},destroy(){}};}}}};
  const manager=api.mount({document:doc,rawApi(){},key:()=> 'A',page:()=> 'timeTracking'});
  for(const extra of [{defaultPrevented:true},{button:1},{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true}])click({button:0,target:{closest:()=>anchor},preventDefault(){throw Error('modified click intercepted');},...extra});
  assert.equal(opened,0);click({button:0,target:{closest:()=>anchor},preventDefault(){}});assert.equal(opened,1);
  anchor.href=origin+'/api/time-record-statements/other/download';assert.equal(captured.canUse(),false);manager.sync();assert.equal(captured.canUse(),false);
  assert.equal(manager.open('https://example.org/api/file.pdf',anchor),false);assert.equal(opened,1);
});

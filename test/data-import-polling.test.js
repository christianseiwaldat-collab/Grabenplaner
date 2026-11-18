'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const UI=require('../public/data-import');
const turn=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture(t,intercept=()=>{},{select=true}={}) {
  t.mock.timers.enable({apis:['setTimeout']});
  const previousDocument=globalThis.document,documentEvents={},rootEvents={};
  globalThis.document={hidden:false,addEventListener:(name,handler)=>documentEvents[name]=handler,removeEventListener:name=>delete documentEvents[name]};
  t.after(()=>{if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;});
  const fields=Object.fromEntries(['next','overview','sources','detail','message','log','form'].map(name=>[name,{
    hidden:true,innerHTML:'',textContent:'',dataset:{},querySelector:()=>null,querySelectorAll:()=>[],contains:()=>false,replaceChildren(){},
  }]));
  const handlers={},requests=[],source={id:'trade',kind:'trade',status:'reading',active:true,tables:[]};
  const body={innerHTML:'',textContent:'',querySelector:selector=>fields[/data-i="([^"]+)"/.exec(selector)?.[1]],addEventListener:(name,handler)=>handlers[name]=handler,removeEventListener(){},replaceChildren(){this.innerHTML='';}};
  const root={open:true,querySelector:()=>body,addEventListener:(name,handler)=>rootEvents[name]=handler,removeEventListener:name=>delete rootEvents[name]};
  const view=UI.mount(root,{api:async(url,options)=>{
    requests.push({url,options});
    const response=intercept(url,options);if(response!==undefined)return response;
    if(url.endsWith('/context'))return {available:true,projection:{read:true,prepare:false,apply:false},sourceCatalog:[]};
    if(url.endsWith('/sources/search'))return {items:[structuredClone(source)],next:null};
    if(url.endsWith('/overview'))return {items:[structuredClone(source)],complete:true};
    assert.equal(url,'/api/data-import/sources/trade');return structuredClone(source);
  }});
  t.after(()=>view.destroy());
  const click=(dataset={},attribute='')=>handlers.click({target:{closest:()=>({dataset,hasAttribute:name=>name===attribute})}});
  await turn();if(select)await click({iSource:source.id});
  const advance=async()=>{t.mock.timers.tick(2500);await turn();};
  const searches=()=>requests.filter(({url})=>url.endsWith('/sources/search')).length;
  return {fields,body,source,root,rootEvents,documentEvents,requests,click,advance,searches,view};
}

for(const failingRoute of ['/sources/search','/overview','/sources/trade'])test(`status polling recovers after a timeout in ${failingRoute} and stops when processing finishes`,async t=>{
  let fail=false;
  const ui=await fixture(t,url=>{
    if(fail&&url.endsWith(failingRoute)){fail=false;throw Object.assign(new Error('Status vorübergehend nicht erreichbar'),{code:'PERSISTENCE_TIMEOUT',status:503});}
  });
  const cached=ui.fields.detail.innerHTML;
  fail=true;await ui.advance();
  assert.match(ui.fields.message.textContent,/vorübergehend nicht erreichbar/);
  assert.equal(ui.fields.detail.innerHTML,cached);
  const afterFailure=ui.searches();
  ui.source.status='reviewing';ui.source.complete=true;
  await ui.advance();
  assert.equal(ui.searches(),afterFailure+1);
  assert.match(ui.fields.detail.innerHTML,/Prüfung läuft/);
  assert.equal(ui.fields.message.textContent,'');
  ui.source.active=false;ui.source.status='ready';
  await ui.advance();
  const finished=ui.searches();await ui.advance();assert.equal(ui.searches(),finished);
  assert.ok(ui.requests.every(({url})=>['/api/data-import/context','/api/data-import/overview','/api/data-import/sources/search','/api/data-import/sources/trade'].includes(url)));
});

test('a timeout in the first status read preserves the workspace and retries without a known active job',async t=>{
  let first=true;
  const ui=await fixture(t,url=>{
    if(first&&url.endsWith('/sources/search')){first=false;throw new Error('Verbindung unterbrochen');}
  },{select:false});
  assert.match(ui.body.innerHTML,/data-i="message"/);
  assert.notEqual(ui.body.textContent,'Verbindung unterbrochen');
  assert.equal(ui.fields.message.textContent,'Verbindung unterbrochen');
  assert.equal(ui.searches(),1);await ui.advance();assert.equal(ui.searches(),2);
  assert.equal(ui.fields.message.textContent,'');
});

test('manual status refresh failures also retry automatically',async t=>{
  let fail=false;
  const ui=await fixture(t,url=>{if(fail&&url.endsWith('/sources/search'))throw new Error('Netzwerk unterbrochen');});
  fail=true;await ui.click({},'data-i-check-status');
  assert.match(ui.fields.message.textContent,/Netzwerk unterbrochen/);
  const before=ui.searches();fail=false;await ui.advance();
  assert.equal(ui.searches(),before+1);assert.equal(ui.fields.message.textContent,'');
});

test('a status-read failure after selecting a source clears after automatic recovery',async t=>{
  let fail=false;
  const ui=await fixture(t,url=>{
    if(fail&&url.endsWith('/overview')){fail=false;throw new Error('Statusabfrage unterbrochen');}
  });
  fail=true;await ui.click({iSource:ui.source.id});
  assert.equal(ui.fields.message.textContent,'Statusabfrage unterbrochen');
  const before=ui.searches();await ui.advance();
  assert.equal(ui.searches(),before+1);assert.equal(ui.fields.message.textContent,'');
});

for(const error of [
  Object.assign(new Error('Nicht angemeldet'),{status:401}),
  Object.assign(new Error('Nicht berechtigt'),{status:403}),
  Object.assign(new Error('Konto gewechselt'),{code:'PORTAL_SESSION_CHANGED'}),
  new DOMException('Abgebrochen','AbortError'),
])test(`status polling does not retry after ${error.name==='AbortError'?error.name:error.code||error.status}`,async t=>{
  let fail=false;
  const ui=await fixture(t,url=>{if(fail&&url.endsWith('/sources/search'))throw error;});
  fail=true;await ui.advance();const stopped=ui.searches();await ui.advance();assert.equal(ui.searches(),stopped);
});

for(const stop of ['hidden','closed','destroyed'])test(`pending status retry stops when the view is ${stop}`,async t=>{
  let fail=false;
  const ui=await fixture(t,url=>{if(fail&&url.endsWith('/sources/search'))throw new Error('Timeout');});
  fail=true;await ui.advance();
  if(stop==='hidden'){globalThis.document.hidden=true;ui.documentEvents.visibilitychange();}
  if(stop==='closed'){ui.root.open=false;ui.rootEvents.toggle();}
  if(stop==='destroyed')ui.view.destroy();
  const stopped=ui.searches();await ui.advance();assert.equal(ui.searches(),stopped);
});

test('successful automatic refresh preserves an unrelated user-action message',async t=>{
  const ui=await fixture(t);
  // A successful explicit status check creates feedback owned by the user action.
  await ui.click({},'data-i-check-status');
  const feedback=ui.fields.message.textContent;
  assert.match(feedback,/Status aktualisiert/);
  await ui.advance();assert.equal(ui.fields.message.textContent,feedback);
});

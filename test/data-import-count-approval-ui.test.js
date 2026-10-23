'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const UI=require('../public/data-import');
const projection={read:true,prepare:true,apply:true};
const proof={id:'verified',fingerprint:'a'.repeat(64),expectedRows:4,declaredRows:3,evidenceReference:'checked <evidence>'};
function source(){return {id:'source',kind:'trade',revision:12,status:'needs_review',complete:true,activationEnabled:true,tables:[
  {name:'ARTIKEL',declaredRows:3,run:{id:'run',status:'needs_review',receivedRows:4,counts:{create:4},gates:['SOURCE_ROW_COUNT_MISMATCH'],availableSourceTolerances:[proof]}},
]};}

test('exact pending count evidence enables separate approval but never apply',()=>{
  const value=source(),html=UI.renderSource(value,projection);
  assert.match(html,/data-i-action="approve-counts" >Geprüfte/);
  assert.match(html,/data-i-action="apply" disabled/);
  assert.match(html,/checked &lt;evidence&gt;/);assert.doesNotMatch(html,/<evidence>/);
  assert.match(html,/4 gelesene \/ 3 deklarierte/);
  for(const permissions of [{...projection,prepare:false},{...projection,apply:false}])
    assert.match(UI.renderSource(value,permissions),/data-i-action="approve-counts" disabled/);
  value.tables[0].run.gates.push('SOURCE_TOLERANCE_UNAVAILABLE');
  assert.match(UI.renderSource(value,projection),/data-i-action="approve-counts" >Geprüfte/);
  value.tables[0].run.availableSourceTolerances=[];
  assert.doesNotMatch(UI.renderSource(value,projection),/data-i-action="approve-counts"/);
});

test('invalid rows and additional source gates continue blocking count approval',()=>{
  for(const issue of ['invalid','gate']){
    const value=source();
    if(issue==='invalid')value.tables[0].run.counts.invalid=1;
    else value.tables[0].run.gates.push('SOURCE_SCHEMA_CHANGED');
    const html=UI.renderSource(value,projection);
    assert.match(html,/data-i-action="approve-counts" disabled/);
    assert.match(html,/data-i-action="apply" disabled/);
  }
});

test('durable approval displays actor and revision; dependencies remain eligible for ordered recheck',()=>{
  const value=source(),run=value.tables[0].run;
  run.gates=[];run.availableSourceTolerances=[];run.acceptedDeviations=[proof];
  run.sourceToleranceReceipts=[{fingerprint:proof.fingerprint,recordedAt:'2026-10-14T12:00:00Z',actorId:'actor<&',revision:13}];
  run.counts={conflict:1,create:3};
  const html=UI.renderSource(value,projection);
  assert.doesNotMatch(html,/data-i-action="approve-counts"/);
  assert.match(html,/data-i-action="apply" >Übernehmen/);
  assert.match(html,/Akteur actor&lt;&amp; · Revision 13/);
  assert.match(html,/1 offene Prüffälle/);
});

test('UI approval sends only expected revision, once, without starting apply',async t=>{
  const value=source(),requests=[],confirmations=[],handlers={};
  const fields=Object.fromEntries(['next','sources','detail','message','log','stop','form'].map(name=>[name,{hidden:true,innerHTML:'',textContent:'',querySelector:()=>null,replaceChildren(){},setAttribute(){},removeAttribute(){}}]));
  const body={innerHTML:'',querySelector:s=>fields[/data-i="([^"]+)"/.exec(s)?.[1]],addEventListener:(n,h)=>handlers[n]=h,removeEventListener(){},replaceChildren(){}};
  const root={open:true,querySelector:()=>body,addEventListener(){},removeEventListener(){}};
  const view=UI.mount(root,{confirmAction:text=>{confirmations.push(text);return true;},api:async(url,options)=>{
    requests.push({url,options});
    if(url.endsWith('/context'))return{available:true,projection,backgroundEnabled:true};
    if(url.endsWith('/sources/search'))return{items:[value],next:null};
    if(url.endsWith('/approve-counts')){
      assert.deepEqual(JSON.parse(options.body),{expectedRevision:12});
      value.revision=13;value.tables[0].run.gates=[];value.tables[0].run.availableSourceTolerances=[];
      value.tables[0].run.acceptedDeviations=[proof];
    }else assert.equal(url,'/api/data-import/sources/source');
    return structuredClone(value);
  }});
  t.after(()=>view.destroy());
  const click=dataset=>handlers.click({target:{closest:()=>({dataset,hasAttribute:()=>false})}});
  await new Promise(resolve=>setImmediate(resolve));
  await click({iSource:'source'});await click({iAction:'approve-counts'});
  assert.equal(requests.filter(r=>r.url.endsWith('/approve-counts')).length,1);
  assert.equal(requests.filter(r=>/\/apply/.test(r.url)).length,0);
  assert.match(confirmations[0],/Nur dieser Dateistand/);
  assert.match(fields.message.textContent,/Zählerfreigabe protokolliert/);
  await click({iAction:'approve-counts'});
  assert.equal(requests.filter(r=>r.url.endsWith('/approve-counts')).length,1);
});

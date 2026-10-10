'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const Status=require('../public/gp-save-status.js');
const repo=path.resolve(__dirname,'..');
const Guard=require(path.join(repo,'public/form-draft-guard.js'));
const Window=require(path.join(repo,'public/gp-window.js'));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function formFixture(){const nodes={},listeners={};const root={ownerDocument:{getElementById:id=>nodes[id]},contains:node=>nodes[node.id]===node,addEventListener:(name,fn)=>listeners[name]=fn,removeEventListener(){}};
const guard=Guard.create(root),input=(id,type='text')=>nodes[id]={id,type,tagName:'INPUT',value:'',disabled:false};
const edit=(node,value)=>{node.value=value;listeners.input({target:node});};return{guard,input,edit};}
test('session-only print options never claim a completed durable save',()=>{const status=Status.create({key:()=> 'A:location18',persistence:'session'});assert.equal(status.state.state,'local');status.changed();assert.match(status.state.text,/in dieser Sitzung/);assert.equal(status.begin(),null);assert.equal(status.succeeded({}),false);assert.equal(status.loaded(),false);});
test('persisted status waits for actual read/write confirmation and suppresses duplicate saves',()=>{const status=Status.create({key:()=> 'A:general'});assert.equal(status.state.state,'none');assert.equal(status.loaded(),true);assert.equal(status.state.state,'saved');status.changed();const token=status.begin();assert.equal(status.state.state,'saving');assert.equal(status.begin(),null);assert.equal(status.succeeded(token),true);assert.equal(status.state.state,'saved');assert.equal(status.succeeded(token),false);});
test('a late save acknowledges sent settings but preserves a later real form edit and reports changed',async()=>{const f=formFixture(),input=f.input('pdfTitleSetting'),status=Status.create({key:()=> 'A:location18'}),save=deferred();
f.edit(input,'Gesendeter Titel');status.changed();const sent=f.guard.snapshot(),token=status.begin();const work=save.promise.then(()=>{f.guard.acknowledge(sent);f.guard.restore();status.succeeded(token,{remaining:f.guard.hasDraft()});});
f.edit(input,'Neuerer Titel');status.changed();assert.match(status.state.text,/neue Änderungen offen/);save.resolve();await work;assert.equal(input.value,'Neuerer Titel');assert.equal(status.state.state,'changed');assert.equal(f.guard.hasDraft(),true);
const current=f.guard.snapshot(),second=status.begin();f.guard.acknowledge(current);status.succeeded(second,{remaining:f.guard.hasDraft()});assert.equal(status.state.state,'saved');});
test('same-key return after an intervening account or scope invalidation rejects the old completion',()=>{let key='A:location18';const status=Status.create({key:()=>key});status.changed();const token=status.begin();key='B:location18';status.sync();key='A:location18';status.sync();assert.equal(status.succeeded(token),false);assert.equal(status.state.state,'none');key='A:location05';status.sync();assert.equal(status.failed(token,Error('Old account error')),false);assert.equal(status.state.error,'');});
test('a scope change prevents a late response from acknowledging an equal-valued new-scope form',async()=>{const f=formFixture(),input=f.input('pdfTitleSetting');let scope='A:location18';const status=Status.create({key:()=>scope}),response=deferred();f.edit(input,'Gleicher Titel');status.changed();const sent=f.guard.snapshot(),token=status.begin();
const work=response.promise.then(()=>{if(!status.current(token))return false;f.guard.acknowledge(sent);status.succeeded(token);return true;});scope='A:location05';status.sync();f.guard.clear();f.edit(input,'Gleicher Titel');status.changed();response.resolve();assert.equal(await work,false);assert.equal(f.guard.hasDraft(),true);assert.equal(status.state.state,'changed');});
test('permission withdrawal and explicit logout invalidate pending status and visible errors',()=>{let allowed=true;const status=Status.create({key:()=> 'A',canUse:()=>allowed});status.changed();const token=status.begin();allowed=false;status.sync();assert.equal(status.state.state,'none');assert.equal(status.failed(token,Error('Private old error')),false);allowed=true;status.invalidate();status.changed();const next=status.begin();status.invalidate();assert.equal(status.succeeded(next),false);});
test('a partial confirmed settings save leaves other drafts changed',()=>{const status=Status.create({key:()=> 'A'});status.changed();const token=status.begin();status.succeeded(token,{remaining:true});assert.equal(status.state.state,'changed');});
test('save errors retain drafts, permit explicit retry and never announce saved',()=>{const f=formFixture(),input=f.input('setting'),status=Status.create({key:()=> 'A'});f.edit(input,'Entwurf');status.changed();const token=status.begin();status.failed(token,Error('Server nicht erreichbar'));assert.equal(status.state.state,'error');assert.equal(f.guard.hasDraft(),true);assert.equal(status.state.error,'Server nicht erreichbar');status.changed();assert.equal(status.state.error,'');assert.ok(status.begin());});
test('existing draft guard excludes credentials and uploads rather than introducing new persistence',()=>{const f=formFixture();f.edit(f.input('password','password'),'PRIVATE');f.edit(f.input('upload','file'),'PRIVATE');f.edit(f.input('plain'),'Beispiel');assert.deepEqual([...f.guard.snapshot().keys()],['plain']);f.guard.clear();assert.equal(f.guard.hasDraft(),false);});
test('real account window preferences retain geometry through navigation and reject late old-account writes',async()=>{let actor='A';const requests=[];const prefs=Window.createPreferences({actorKey:()=>actor,canUse:()=>true,api:(url,options)=>{const request=deferred();requests.push({url,options,...request});return request.promise;}});
const load=prefs.activate();requests[0].resolve({gpWindows:{version:1,windows:{}}});await load;
const changed=prefs.change('print-example',{x:10,y:20,width:700,height:500,minimized:false});await tick();prefs.suspend();assert.equal(requests[1].options.signal.aborted,false);requests[1].resolve({});assert.equal(await changed,true);await prefs.activate();assert.equal(prefs.value.windows['print-example'].width,700);
const stale=prefs.change('print-example',{x:30,y:20,width:700,height:500,minimized:false});await tick();actor='B';prefs.invalidate();assert.equal(requests[2].options.signal.aborted,true);requests[2].resolve({});assert.equal(await stale,false);assert.deepEqual(prefs.value.windows,{});prefs.destroy();});

test('session status resumes after initial denial or temporary rights loss without reviving confirmed status/tokens', () => {
  let allowed=false; const local=Status.create({key:()=> 'A',canUse:()=>allowed,persistence:'session'});
  assert.equal(local.state.state,'none');allowed=true;local.sync();assert.equal(local.state.state,'local');allowed=false;local.sync();allowed=true;local.sync();assert.equal(local.state.state,'local');
  const confirmed=Status.create({key:()=> 'A',canUse:()=>allowed});confirmed.loaded();const token=confirmed.begin();allowed=false;confirmed.sync();allowed=true;confirmed.sync();
  assert.equal(confirmed.state.state,'none');assert.equal(confirmed.succeeded(token),false);assert.equal(confirmed.failed(token,Error('stale')),false);
});

test('actual price-label and branch-order authority callbacks restore local status when an initially denied source is opened',()=>{
  const Existing=require('../public/gp-existing-pdf-window'),Price=require('../public/gp-price-label-pdf'),Branch=require('../public/gp-branch-order-pdf-window');
  for(const kind of ['price','branch']) {
    let allowed=false, status, config;
    const doc={defaultView:{GpExistingPdfWindow:Existing,location:{origin:'https://gp.example'},GpPrintWindow:{mount(value){config=value;status=Status.create({key:value.key,canUse:value.canUse,persistence:'session'});return{open(){status.sync();return true;},reset(){status.sync();},sync(){return status.sync();},activate(){},deactivate(){},destroy(){}};}}}};
    const common={document:doc,key:()=> 'A',canUse:()=>allowed,active:()=>true,rawApi:async()=>{throw Error('No provider');}};
    const adapter=kind==='price'?Price.mount({...common,context:()=> 'draft'}):Branch.mount({...common,scopeKey:()=> '18',orders:()=>[{id:'order',calendarWeek:42}]});
    assert.equal(status.state.state,'none');allowed=true;
    if(kind==='price') adapter.open({url:'/api/sales/price-labels/library/t/article.pdf',body:{articleNumber:'001'},filename:'Beispiel.pdf',dimensions:{width:210,height:297}});
    else adapter.open({id:'order',calendarWeek:42});
    assert.equal(status.state.state,'local');allowed=false;adapter.sync();assert.equal(status.state.state,'none');allowed=true;adapter.sync();assert.equal(status.state.state,'local');
    assert.equal(require('../public/gp-print-window').normalizeCommonFields(config.commonFields).title,kind==='branch'?'readonly':'hidden');
  }
});

test('discarded save tokens release a replaced form without claiming completion or losing later changes',()=>{
 const status=Status.create({key:()=> 'A:personal-pdf'});const first=status.begin();status.changed();assert.equal(status.cancel(first),true);assert.equal(status.state.busy,false);assert.equal(status.state.state,'changed');assert.equal(status.succeeded(first),false);assert.ok(status.begin());
});

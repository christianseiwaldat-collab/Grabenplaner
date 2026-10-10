'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const GpWindow=require('../public/gp-window');
const source=fs.readFileSync(path.join(__dirname,'../public/portal.js'),'utf8');
const start=source.indexOf('function syncPortalWindows(){'),end=source.indexOf('\nlet branchPriceLabelsWorkspace',start);
assert.ok(start>=0 && end>start);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const user=id=>({accountId:id,sessionKind:'organization',accountType:'branch',isEmployee:false,permissions:[],scopes:[{locationId:'18'}],mustChangePassword:false});
const empty={version:1,windows:{}};
test('real portal window adapter binds revisions to the actor and ignores late aborted old-account acknowledgements',async()=>{
  const calls=[],errors=[],state={session:{authenticated:true,user:user('branch-a')}};
  const sandbox={window:{GpWindow:{installDocument(_doc,options){const preferences=GpWindow.createPreferences({actorKey:options.actorKey,canUse:options.canUse,
    read:options.readPreferences,write:options.writePreferences,error:options.error});return{preferences,synchronize(){preferences.invalidate();}};}}},
    document:{},portalState:state,portalUser:()=>state.session.user,el:{portalLogoutStatus:{}},message:(_node,text)=>errors.push(text),
    branchSalesWorkspaces:new Map(),syncBranchOrderPrintWindows(){},branchPriceLabelsWorkspace:null,syncPortalDocumentPrint(){},
    api:(url,options)=>{const request=deferred();calls.push({url,options,...request});return request.promise;}};
  vm.createContext(sandbox);vm.runInContext("let portalWindowManager=null,portalWindowActor='';\n"+source.slice(start,end)+"\nglobalThis.sync=syncPortalWindows;globalThis.getManager=()=>portalWindowManager;",sandbox);
  sandbox.sync();const prefs=sandbox.getManager().preferences,loading=prefs.activate();
  assert.equal(calls[0].url,'/api/portal/v1/branch-window-preferences');calls[0].resolve({revision:7,gpWindows:empty});await loading;
  const old=prefs.change('price-label-search',{x:4,y:4,width:500,height:300,minimized:false});await tick();
  assert.equal(JSON.parse(calls[1].options.body).revision,7);
  state.session.user=user('branch-b');sandbox.sync();assert.equal(calls[1].options.signal.aborted,true);
  const next=prefs.activate();calls[2].resolve({revision:2,gpWindows:empty});await next;
  const changed=prefs.change('price-label-search',{x:8,y:9,width:500,height:300,minimized:true});
  calls[1].resolve({revision:8,gpWindows:empty});assert.equal(await old,false);await tick();
  assert.equal(JSON.parse(calls[3].options.body).revision,2);calls[3].resolve({revision:3,gpWindows:prefs.value});assert.equal(await changed,true);
  state.session.user={employeeNumber:'42',sessionKind:'employee',isEmployee:true,permissions:[],scopes:[],mustChangePassword:false};sandbox.sync();
  const personal=prefs.activate();assert.equal(calls[4].url,'/api/portal/v1/ui-preferences');calls[4].resolve({gpWindows:empty});await personal;
  const personalEdit=prefs.change('passwordDialog',{x:1,y:2,width:500,height:300,minimized:false});await tick();
  assert.equal(calls[5].url,'/api/portal/v1/ui-preferences');assert.deepEqual(Object.keys(JSON.parse(calls[5].options.body)),['gpWindows']);
  calls[5].resolve({});assert.equal(await personalEdit,true);assert.deepEqual(errors,[]);prefs.destroy();
});

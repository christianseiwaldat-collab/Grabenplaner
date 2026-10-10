'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../public/learning-assessment.js'),'utf8');
const loaded=receipt=>({title:'BEISPIEL Schulung',learner:'BEISPIEL',assessment:null,attempts:[],evidence:[],canConfirm:true,expectedReceipt:receipt});
function fixture(printPdf){
  const events=new Map(),documentEvents=new Map(),status={textContent:''},dialog={open:false,html:'',shows:0,closes:0,
    setAttribute(){},addEventListener:(type,fn)=>events.set(type,fn),querySelector:()=>status,
    showModal(){this.open=true;this.shows++;},close(){this.open=false;this.closes++;},replaceChildren(){this.html='';},
    set innerHTML(value){this.html=value;},get innerHTML(){return this.html;}};
  let data=loaded('receipt-one');const reads=[];
  const document={body:{append(){}},createElement:()=>dialog,addEventListener:(type,fn)=>documentEvents.set(type,fn)};
  const context={document};vm.createContext(context);vm.runInContext(source,context);
  const panel=context.GrabenplanerLearningAssessment.init({api:async(url)=>{reads.push(url);return data;},printPdf});
  const proof=(id='assignment-one',visible=true)=>({dataset:{learningProof:id},isConnected:true,getClientRects:()=>visible?[{}]:[]});
  const click=async(extra={})=>{const event={button:0,prevented:false,preventDefault(){this.prevented=true;},target:{closest:selector=>selector==='[data-learning-confirmation-pdf]'?{}:null},...extra};await events.get('click')(event);return event;};
  const launch=async(target=proof())=>{documentEvents.get('click')({target:{closest:()=>target}});for(let i=0;i<6;i++)await Promise.resolve();return target;};
  return {panel,dialog,reads,status,proof,click,launch,setData(value){data=value;},get data(){return data;}};
}
test('confirmation closes the native modal before shared printing and retains the visible proof opener',async()=>{
  let captured;const f=fixture(value=>{assert.equal(f.dialog.open,false,'Top-layer dialog must close first');captured=value;return true;});
  const opener=await f.launch();assert.match(f.dialog.html,/data-learning-confirmation-pdf/);const event=await f.click();
  assert.equal(event.prevented,true);assert.equal(captured.url,'/api/portal/v1/personnel-learning/assignments/assignment-one/confirmation.pdf');assert.equal(captured.title,'Schulungsbestätigung');assert.equal(captured.target,opener);assert.equal(captured.canUse(),true);assert.equal(f.dialog.open,false);assert.match(f.dialog.html,/BEISPIEL Schulung/,'Closing preserves source data instead of clear');
});
test('new assignments, changed expected receipts, explicit clear and revoked confirmation invalidate old guards',async()=>{
  for(const change of [async f=>{await f.panel.open('assignment-two');},async f=>{f.data.expectedReceipt='receipt-two';},async f=>f.panel.clear(),async f=>{f.data.canConfirm=false;}]){
    let captured;const f=fixture(value=>{captured=value;return true;});await f.launch();await f.click();assert.equal(captured.canUse(),true);await change(f);assert.equal(captured.canUse(),false);
  }
});
test('unavailable printing restores the current dialog, while a late failure never restores an old assignment',async()=>{
  const f=fixture(()=>false);await f.launch();await f.click();assert.equal(f.dialog.open,true);assert.equal(f.dialog.shows,2);
  let release;const late=fixture(()=>new Promise(resolve=>{release=resolve;}));await late.launch();const pending=late.click();await late.panel.open('assignment-two');const shows=late.dialog.shows;release(false);await pending;assert.equal(late.dialog.shows,shows);assert.equal(late.dialog.open,true);
});
test('hidden/disconnected proof openers request the host visible fallback and programmatic opens retain a null target',async()=>{
  for(const mode of ['hidden','disconnected','programmatic']){
    let captured;const f=fixture(value=>{captured=value;return true;}),target=f.proof('assignment-one',mode!=='hidden');if(mode==='disconnected')target.isConnected=false;
    if(mode==='programmatic')await f.panel.open('assignment-one');else await f.launch(target);await f.click();assert.equal(captured.target,null);
  }
});
test('errors restore the current modal with a useful status, and clear prevents a late error from reopening it',async()=>{
  const f=fixture(()=>{throw Error('BEISPIEL Vorschau fehlgeschlagen');});await f.launch();await f.click();assert.equal(f.dialog.open,true);assert.match(f.status.textContent,/Vorschau fehlgeschlagen/);
  let reject;const late=fixture(()=>new Promise((_resolve,rejection)=>{reject=rejection;}));await late.launch();const pending=late.click();late.panel.clear();reject(Error('old'));await pending;assert.equal(late.dialog.open,false);assert.equal(late.dialog.html,'');
});
test('optional callback preserves native download behavior and modified clicks',async()=>{
  const f=fixture();await f.launch();assert.equal((await f.click()).prevented,false);assert.equal(f.dialog.open,true);
  let calls=0;const enabled=fixture(()=>{calls++;return true;});await enabled.launch();assert.equal((await enabled.click({ctrlKey:true})).prevented,false);assert.equal(calls,0);assert.equal(enabled.dialog.open,true);
});

test('shared-window close restores the same assessment, while navigation discard clears only its captured assignment',async()=>{
  let captured;const f=fixture(value=>{captured=value;return true;});await f.launch();await f.click();
  captured.onClose();assert.equal(f.dialog.open,true);assert.equal(captured.canUse(),true);
  f.dialog.close();captured.onDiscard();assert.equal(f.dialog.open,false);assert.equal(captured.canUse(),false);assert.equal(f.dialog.html,'');
  const next=fixture(value=>{captured=value;return true;});await next.launch();await next.click();await next.panel.open('assignment-two');const html=next.dialog.html;
  captured.onDiscard();captured.onClose();assert.equal(next.dialog.html,html);assert.equal(next.dialog.open,true);
});

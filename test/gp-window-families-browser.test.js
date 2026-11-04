'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),index=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
function dialog(id){const re=new RegExp('<dialog\\b[^>]*\\bid="'+id+'"[^>]*>'),match=index.match(re);assert.ok(match,id);const start=match.index,end=index.indexOf('</dialog>',start)+9;return index.slice(start,end);}
test('actual personnel and organization windows preserve drafts while security decisions remain native modal',
 {skip:process.env.GP_WINDOW_BROWSER_TEST!=='1',timeout:60000},async()=>{
 const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');
 const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{})});
 const ids=['collectiveAgreementModal','customWorkRuleModal','costCenterModal','costCenterTypeModal','locationEditorModal','personnelLearningModal','customProcessModal','personnelLifecycleEditorDialog'];
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort());
  await page.setContent('<button id="background">BEISPIEL Hintergrund</button>'+[...ids,'workRuleFinalizeModal','positionDeleteModal'].map(dialog).join('')+'<div id="library"></div><div id="team"></div>');
  for(const file of ['styles.css','mobile-refinements.css','gp-window.css','personnel-learning.css','learning-library.css','learning-team.css'])if(fs.existsSync(path.join(root,'public',file)))await page.addStyleTag({path:path.join(root,'public',file)});
  for(const file of ['gp-window-preferences.js','gp-window.js','learning-library.js','learning-team.js'])await page.addScriptTag({path:path.join(root,'public',file)});
  const app=fs.readFileSync(path.join(root,'public/app.js'),'utf8').replace(/\r\n/g,'\n'),start=app.indexOf('function requestClosePersonnelLifecycleEditor('),end=app.indexOf('\n}\n',start)+3;assert.ok(start>0&&end>start);
  await page.evaluate(source=>{
   window.actor='BEISPIEL';window.clicked=0;window.discards=0;window.allowDiscard=false;window.state={personnelLifecycleEditorDirty:true};
   window.elements={personnelLifecycleEditorDialog:document.getElementById('personnelLifecycleEditorDialog')};
   window.confirm=()=>allowDiscard;
   window.clearPersonnelLifecycleEditorState=(message,options)=>{discards++;state.personnelLifecycleEditorDirty=false;if(options.closeDialog)elements.personnelLifecycleEditorDialog.close();};
   window.requestClosePersonnelLifecycleEditor=Function('return ('+source+')')();
   elements.personnelLifecycleEditorDialog.addEventListener('cancel',event=>{event.preventDefault();requestClosePersonnelLifecycleEditor();});
   document.getElementById('closePersonnelLifecycleEditorButton').onclick=()=>requestClosePersonnelLifecycleEditor();
   document.addEventListener('click',event=>{const button=event.target.closest('[data-close]');if(button)document.getElementById(button.dataset.close)?.close();});
   document.getElementById('background').onclick=()=>clicked++;
   window.manager=GpWindow.installDocument(document,{actorKey:()=>actor,canUse:()=>Boolean(actor),readPreferences:async()=>({version:1,windows:{}}),writePreferences:async()=>{}});
  },app.slice(start,end));
  for(const id of ids){
   await page.evaluate(id=>document.getElementById(id).showModal(),id);assert.equal(await page.locator('#'+id).evaluate(node=>node.matches(':modal')),false,id);
   const input=page.locator('#'+id+' input:not([type="hidden"]):not([type="checkbox"]):not([type="number"]):not([type="date"]):not([type="file"]):not([disabled]),#'+id+' textarea:not([disabled])').first();
   let value=null;if(await input.count()){await input.fill('BEISPIEL-Arbeitsentwurf');value=await input.inputValue();}
   await page.locator('#'+id+' [data-gp-window-toggle]').click();await page.locator('#background').click();
   assert.equal(await page.locator('#'+id).evaluate(node=>node.open),true,id);await page.locator('#'+id+' [data-gp-window-toggle]').click();if(value)assert.equal(await input.inputValue(),value,id);
   if(id==='personnelLifecycleEditorDialog'){
    await page.locator('#'+id+' [data-gp-window-close]').click();assert.equal(await page.locator('#'+id).evaluate(node=>node.open),true);assert.equal(await page.evaluate(()=>discards),0);
    await page.locator('#personnelLifecycleEditorDraftTitle').focus();await page.keyboard.press('Escape');assert.equal(await page.locator('#'+id).evaluate(node=>node.open),true);
    await page.evaluate(()=>allowDiscard=true);await page.locator('#'+id+' [data-gp-window-close]').click();await page.waitForFunction(()=>!elements.personnelLifecycleEditorDialog.open);assert.equal(await page.evaluate(()=>discards),1);
   }else await page.evaluate(id=>document.getElementById(id).close(),id);
  }
  assert.equal(await page.evaluate(()=>clicked),ids.length);
  for(const id of ['workRuleFinalizeModal','positionDeleteModal']){
   await page.evaluate(id=>document.getElementById(id).showModal(),id);await page.waitForFunction(id=>document.getElementById(id).querySelector('.gp-dialog-window-title'),id);
   assert.equal(await page.locator('#'+id).evaluate(node=>node.matches(':modal')),true);assert.equal(await page.locator('#'+id+' [data-gp-window-toggle]').count(),0);await page.evaluate(id=>document.getElementById(id).close(),id);
  }
  await page.evaluate(async()=>{
   window.library=GrabenplanerLearningLibrary.mount(document.getElementById('library'),{api:async()=>({modules:[],capabilities:{canCreate:true},scopes:[{type:'organization',label:'BEISPIEL'}]})});await library.load();
   window.team=GrabenplanerLearningTeam.mount(document.getElementById('team'),{api:async url=>url.endsWith('/team/options')?{locations:[],positions:[],roles:[],rules:[],canManage:true,scopes:[{type:'organization',label:'BEISPIEL'}],modules:[{id:'BEISPIEL',title:'BEISPIEL',version:1,type:'skill',scope:{type:'organization'}}]}:{summary:{percent:null,fulfilled:0,required:0,open:0,dueSoon:0},people:[],rules:[],offset:0,pageSize:25,total:0}});await team.load();
  });
  await page.locator('[data-knowledge-action="new"]').click();assert.equal(await page.locator('[data-knowledge-editor]').evaluate(node=>node.matches(':modal')),false);
  await page.locator('[data-knowledge-editor] [name="body"]').fill('BEISPIEL-Wissen bleibt im Entwurf.');await page.locator('[data-knowledge-editor] [data-gp-window-toggle]').click();await page.locator('#background').click();await page.locator('[data-knowledge-editor] [data-gp-window-toggle]').click();assert.equal(await page.locator('[data-knowledge-editor] [name="body"]').inputValue(),'BEISPIEL-Wissen bleibt im Entwurf.');await page.evaluate(()=>library.clear());
  await page.locator('#team summary').click();await page.locator('#team [data-new]').click();assert.equal(await page.locator('.learning-team-dialog').evaluate(node=>node.matches(':modal')),false);await page.locator('.learning-team-dialog [name="title"]').fill('BEISPIEL-Anforderung');await page.locator('.learning-team-dialog [data-gp-window-toggle]').click();await page.locator('#background').click();await page.locator('.learning-team-dialog [data-gp-window-toggle]').click();assert.equal(await page.locator('.learning-team-dialog [name="title"]').inputValue(),'BEISPIEL-Anforderung');await page.evaluate(()=>team.clear());
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.getElementById('collectiveAgreementModal').showModal());
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('#collectiveAgreementModal').evaluate(node=>node.querySelector('.gp-dialog-body').scrollWidth>node.clientWidth+1),false);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
 });

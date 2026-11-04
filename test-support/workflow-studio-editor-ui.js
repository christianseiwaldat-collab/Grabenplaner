"use strict";
const UI=require('./workflow-studio-ui');const Contract=require('../lib/personnel-lifecycle-editor-contract');
const app=UI.read('app.js');
const access=app.slice(app.indexOf('const PERSONNEL_LIFECYCLE_EDITOR_PERMISSION_IDS'),app.indexOf('function canOpenPersonnelAdministrationView()'));
const normalization=app.slice(app.indexOf('const PERSONNEL_LIFECYCLE_EDITOR_CONTRACT_VERSION'),app.indexOf('function personnelWorkflowStepCount'));
const editor=app.slice(app.indexOf('function clonePersonnelLifecycleEditorDraft'),app.indexOf('function renderPersonnelWorkflowTasksImpl'));
const events=app.slice(app.indexOf('elements.openPersonnelLifecycleEditorButton?.addEventListener'),app.indexOf('elements.refreshServerDiagnosticsButton?.addEventListener'));
async function prepare(page,{dark=false}={}){
 const result=await UI.prepare(page,{dark,editors:true});
 await page.exposeFunction('syntheticO8Response',(url,body)=>url.endsWith('/catalog')?Contract.personnelLifecycleEditorCatalog(['onboarding']):Contract.validatePersonnelLifecycleEditorDraft(JSON.parse(body)));
 await page.evaluate(({dialog,source,events})=>{
  document.body.insertAdjacentHTML('beforeend',dialog);Object.assign(elements,Object.fromEntries([...document.querySelectorAll('[id]')].map(n=>[n.id,n])));
  state.portalSession.user.permissions.push('personnel:lifecycle:editor:draft:write','personnel:lifecycle:editor:validate','personnel:lifecycle:onboarding:read');
  state.personnelLifecycleEditorActorAccessKey='';state.personnelLifecycleEditorSession=null;state.personnelLifecycleEditorWindowContext=null;state.personnelLifecycleEditorDirty=false;state.personnelLifecycleEditorDraft=null;state.personnelLifecycleEditorValidating=false;
  window.holdO8Catalog=false;window.holdO8Validate=false;window.heldO8=[];window.failO8Validation=false;window.failO8Auth=false;
  const baseApi=api;window.api=async(url,options={})=>{if(!url.includes('/personnel-lifecycle/editor/'))return baseApi(url,options);apiCalls.push({url,method:options.method||'GET',body:options.body});const result=await syntheticO8Response(url,options.body);if(url.endsWith('/catalog')&&holdO8Catalog||url.endsWith('/validate')&&holdO8Validate)await new Promise(resolve=>heldO8.push({resolve,result,url}));if(url.endsWith('/validate')&&failO8Validation)throw Error('synthetic unavailable');if(url.endsWith('/validate')&&failO8Auth){const e=Error('denied');e.status=403;throw e;}return result;};
  (0,eval)(source);(0,eval)(events);syncWorkflowStudio();renderPersonnelLifecycleEditor();
 },{dialog:UI.dialog('personnelLifecycleEditorDialog'),source:access+normalization+editor+['captureGpEditor','gpEditorCurrent'].map(n=>UI.functionSource(n)).join('\n'),events});
 return result;
}
module.exports={...UI,prepare};

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),portal=fs.readFileSync(path.join(__dirname,'../public/portal.js'),'utf8');
function fn(source,name){const marker=new RegExp('(?:async )?function '+name+'\\('),match=marker.exec(source);assert.ok(match,name);const start=match.index,end=source.slice(start+match[0].length).search(/\n(?:async )?function /);return source.slice(start,end<0?source.length:start+match[0].length+end);}
function mainFixture(){
  const calls=[],opener={isConnected:true},modal={open:true,shows:0,close(){this.open=false;},showModal(){this.open=true;this.shows++;},contains:()=>true};
  let owner='A',allowed=true;
  const s={URL,URLSearchParams,document:{},location:{origin:'http://127.0.0.1:3412'},window:{GpDocumentPrint:{visibleTarget:(_doc,target)=>target}},documentPrintModels:new WeakMap(),documentPrintModelRevision:0,
    state:{currentView:'timeTracking',monthlyTimeRecords:{month:'2026-10'},selectedPersonnelCandidateId:'BEISPIEL',selectedPersonnelCandidate:{id:'BEISPIEL'},personnelCandidateCapabilities:{canReadCandidates:true},rightsDashboardSelectedProcessId:'time_off',rightsProcessScenarioIds:{time_off:'hr_bound'},rightsProcessLocationId:'BEISPIEL & Nord'},
    elements:{monthlyTimeRecordsModal:modal,monthlyTimeRecordsButton:opener,monthlyTimeRecordsMonth:{value:'2026-10'},timeTrackingLocation:{value:'01'},timeTrackingDepartment:{value:'01-01'},rightsProcessExportPdf:{id:'export'}},
    personnelCandidateApplications:()=>[{id:'BEISPIEL'}],startDashboardWorkspaceActorKey:()=>owner,canReadMonthlyTimeRecords:()=>allowed,canReadGovernanceDashboards:()=>allowed,canReadCandidatePreboarding:()=>allowed,
    syncGpWindows(){calls.push('sync');},gpDocumentPrint:{open(...args){calls.push(args);return true;}}};
  vm.createContext(s);for(const name of ['documentPrintRevision','documentPrintContext','monthlyDocumentPrintBridge','downloadCandidateEvaluationPdf','exportRightsProcessPdf'])vm.runInContext(fn(app,name),s);
  return {s,calls,modal,opener,owner:value=>owner=value,allow:value=>allowed=value};
}
test('candidate and rights exports retain exact server routes and selections without saving preferences',()=>{
  const {s,calls}=mainFixture();s.exportRightsProcessPdf();assert.equal(calls[1][0],'/api/portal/v1/rights-dashboard/process-export.pdf?process=time_off&scenario=hr_bound&location=BEISPIEL+%26+Nord');assert.equal(calls[1][1],s.elements.rightsProcessExportPdf);
  const href='http://127.0.0.1:3412/api/portal/v1/personnel-lifecycle/candidates/BEISPIEL/applications/BEISPIEL/evaluation.pdf';s.downloadCandidateEvaluationPdf({href});assert.equal(calls[3][0],new URL(href).pathname);
  for(const bad of [href.replace('127.0.0.1:3412','example.org'),href+'?secret=1',href.replace('applications/BEISPIEL','applications/OTHER')])s.downloadCandidateEvaluationPdf({href:bad});assert.equal(calls.length,4);
  s.state.personnelCandidateCapabilities.canReadCandidates=false;s.downloadCandidateEvaluationPdf({href});assert.equal(calls.length,4);
});
test('monthly modal preserves its month and model and only restores a still-current source',()=>{
  for(const change of [f=>f.owner('B'),f=>f.allow(false),f=>f.s.elements.monthlyTimeRecordsMonth.value='2026-11',f=>f.s.state.monthlyTimeRecords={month:'2026-10'},f=>f.s.elements.timeTrackingDepartment.value='02',f=>f.s.state.currentView='other']){
    const f=mainFixture(),bridge=f.s.monthlyDocumentPrintBridge({url:'/api/time-record-statements/BEISPIEL/download',target:{}});assert.equal(f.modal.open,false);assert.equal(bridge.target,f.opener);change(f);bridge.onClose();assert.equal(f.modal.open,false);
  }
  const f=mainFixture(),model=f.s.state.monthlyTimeRecords,bridge=f.s.monthlyDocumentPrintBridge({url:'/api/time-record-statements/BEISPIEL/download',target:{}});bridge.onClose();assert.equal(f.modal.open,true);assert.equal(f.s.state.monthlyTimeRecords,model);assert.equal(f.s.elements.monthlyTimeRecordsMonth.value,'2026-10');
});
function loanFixture(){
  let owner='A',allowed=true,now=Date.now(),result=[],syncs=0;
  const dialog={open:true,shows:0,close(){this.open=false;},showModal(){this.open=true;this.shows++;},contains:()=>true},opener={isConnected:true};
  const confirmation={id:'C1',loanId:'L1',status:'pending',expectedRevision:2,expiresAt:new Date(now+60000).toISOString(),loan:{revision:2},photoAttachments:[{id:'B1',revision:1,downloadUrl:'/api/portal/v1/loans/photo-attachments/B1/download'}]};
  const s={Date:class extends Date{static now(){return now;}},document:{},window:{GpDocumentPrint:{visibleTarget:(_doc,target)=>target}},portalState:{activeLoanConfirmation:confirmation,pendingLoanConfirmations:[confirmation],activeTab:'loan',loanConfirmationLoading:false},
    el:{loanConfirmationDialog:dialog,loanConfirmationNote:{value:'BEISPIEL angefangene Notiz'},loanTab:opener},loanConfirmationPrintBridge:null,loanConfirmationRequestGeneration:0,
    portalDocumentActorKey:()=>owner,loanCapabilityEnabled:()=>allowed,loanPhotoAttachmentList:()=>'',loanPhotoGallery:()=>'',esc:v=>v,timestampText:v=>v,loanConditionText:v=>v,message(){},
    api:async()=>({confirmations:result}),syncPortalDocumentPrint(){syncs++;},};
  vm.createContext(s);for(const name of ['clearLoanConfirmationPrintState','loanConfirmationPrintSignature','portalLoanDocumentPrintBridge','showLoanConfirmation','presentNextLoanConfirmation','loadPendingLoanConfirmations'])vm.runInContext(fn(portal,name),s);
  const open=()=>s.portalLoanDocumentPrintBridge({url:confirmation.photoAttachments[0].downloadUrl,target:{}});
  return {s,dialog,confirmation,open,opener,owner:v=>owner=v,allow:v=>allowed=v,now:v=>now=v,result:v=>result=v,syncs:()=>syncs};
}
test('loan print pauses presentation while polling still updates pending state; close preserves the note',async()=>{
  const f=loanFixture(),bridge=f.open();assert.equal(f.dialog.open,false);assert.equal(bridge.target,f.opener);assert.equal(bridge.canUse(),true);
  f.s.presentNextLoanConfirmation();assert.equal(f.dialog.shows,0);f.s.showLoanConfirmation(f.confirmation);assert.equal(f.dialog.shows,0);
  f.result([structuredClone(f.confirmation)]);await f.s.loadPendingLoanConfirmations();assert.equal(f.syncs(),1);assert.equal(f.dialog.open,false);assert.equal(bridge.canUse(),true);
  bridge.onClose();assert.equal(f.dialog.open,true);assert.equal(f.s.el.loanConfirmationNote.value,'BEISPIEL angefangene Notiz');assert.equal(f.s.loanConfirmationPrintBridge,null);
});
test('loan completion, revised source, expired request, account, rights and navigation never restore stale forms',()=>{
  for(const change of [f=>f.s.portalState.pendingLoanConfirmations=[],f=>f.s.portalState.pendingLoanConfirmations=[{...f.confirmation,expectedRevision:3}],f=>f.now(Date.parse(f.confirmation.expiresAt)+1),f=>f.owner('B'),f=>f.allow(false),f=>f.s.portalState.activeTab='other']){
    const f=loanFixture(),bridge=f.open();change(f);bridge.onClose();assert.equal(f.dialog.open,false);assert.equal(f.s.el.loanConfirmationNote.value,'');assert.equal(f.s.portalState.activeLoanConfirmation,null);assert.equal(f.s.loanConfirmationPrintBridge,null);
  }
});
test('late pending-confirmation requests cannot overwrite another actor or release a newer request',async()=>{
  const f=loanFixture();let resolve;f.s.api=()=>new Promise(done=>resolve=done);const request=f.s.loadPendingLoanConfirmations();f.owner('B');f.s.loanConfirmationRequestGeneration++;f.s.portalState.loanConfirmationLoading=false;const current=f.s.portalState.pendingLoanConfirmations;resolve({confirmations:[]});await request;assert.equal(f.s.portalState.pendingLoanConfirmations,current);assert.equal(f.syncs(),0);
});

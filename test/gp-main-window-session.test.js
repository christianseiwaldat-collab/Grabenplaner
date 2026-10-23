"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),{functionSource}=require("../test-support/learning-workspace-ui");
test("actual main window hook invalidates identical-actor replacement sessions once",()=>{
  let resets=0;const infoEpochs=[];const session={authenticated:true,user:{employeeNumber:"BEISPIEL"}};
  const noop=()=>{},context=vm.createContext({state:{portalSession:session,branchOrdersManagementRequestId:0,salesArticleCatalog:{}},elements:{},document:{getElementById:()=>null},window:{GpWindow:{}},gpWindowManager:{preferences:{},synchronize(){resets++;}},gpWindowActor:"BEISPIEL",gpWindowSession:session,personalActionsWindow:null,recentArticlesWindow:null,branchOrderViewStates:new Map(),branchOrderViewActor:"BEISPIEL",settingsDraftGuard:null,employeeProfileBookmark:null,receiptSearchWorkspace:null,salesPriceLabelsWorkspace:null,vpsStorageWorkspace:null,startDashboardWorkspaceActorKey:()=>"BEISPIEL"});
  for(const name of ["syncXoffiImport","syncWorkflowStudio","syncSettingsSaveScopes","syncPlanningPrintWindows","syncUsbGuidePrint","syncPersonnelDashboardInformation","syncPersonnelDashboardWorkspace","syncSalesAnalyticsPrintWindows","syncDocumentPrint","syncBranchOrdersManagementPrintWindow","syncRightsWorkspace"])context[name]=noop;
  context.syncPersonnelDashboardInformation=()=>infoEpochs.push(resets);
  vm.runInContext(functionSource("syncGpWindows"),context);
  context.syncGpWindows();assert.equal(resets,0);
  context.state.portalSession={authenticated:true,user:{employeeNumber:"BEISPIEL"}};context.syncGpWindows();assert.equal(resets,1,"new session identity must revoke old tickets even for the same fingerprint");context.syncGpWindows();assert.equal(resets,1);
  context.state.portalSession=null;context.syncGpWindows();assert.equal(resets,2);
  assert.deepEqual(infoEpochs,[0,1,1,2],"personnel captures the new context epoch after every actual session synchronization");
});
test("actual main hook synchronizes own personnel sources before missing-window dependency return",()=>{
  let syncs=0;
  const context=vm.createContext({window:{},syncXoffiImport(){},syncWorkflowStudio(){},syncSettingsSaveScopes(){},syncPlanningPrintWindows(){},syncUsbGuidePrint(){},syncPersonnelDashboardWorkspace(){},syncPersonnelDashboardInformation(){syncs++;}});
  vm.runInContext(functionSource("syncGpWindows"),context);context.syncGpWindows();assert.equal(syncs,1);
});

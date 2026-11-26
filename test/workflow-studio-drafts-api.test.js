"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),vm=require('node:vm');
const {registerWorkflowStudioRoutes}=require('../lib/workflow-studio-routes');const {functionSource}=require('../test-support/learning-workspace-ui');
test('Actual legacy update/status/trigger functions reject reserved Studio process and step identities before any native operation',async()=>{
 const context=vm.createContext({httpError:(status,message,code)=>Object.assign(Error(message),{status,code}),customProcessById:()=>{throw Error('legacy read must not happen');},customProcessRepository:{conflictingStep:()=>{throw Error('legacy step read must not happen');}}});for(const name of ['assertLegacyCustomProcess','updateCustomProcess','setCustomProcessStatus','triggerCustomProcess','assertCustomProcessStepIdsAvailable'])vm.runInContext(functionSource(name,'../server.js'),context);
 for(const method of ['updateCustomProcess','setCustomProcessStatus','triggerCustomProcess'])await assert.rejects(context[method]({},'studio-11111111-1111-4111-8111-111111111111',{}),e=>e.code==='CUSTOM_PROCESS_STUDIO_REQUIRED');await assert.rejects(context.assertCustomProcessStepIdsAvailable([{id:'studio-reserved-step'}]),e=>e.code==='CUSTOM_PROCESS_STUDIO_REQUIRED');
});

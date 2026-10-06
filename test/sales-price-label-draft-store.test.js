'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture}=require('../test-support/trade-insights-sqlite'),{createSalesPriceLabelDraftStore}=require('../lib/sales-price-label-draft-store');
const Templates=require('../lib/sales-price-label-template-store'),Labels=require('../public/sales-price-labels');
const draft=extra=>({schemaVersion:1,draftId:crypto.randomUUID(),articleNumbers:'107506',priceType:'sales',options:Labels.normalizeOptions({}),filenameOptions:{stamp:'none',position:'before',separator:'-',suffix:''},name:'Private draft',library:{mode:'new',templateId:'',templateVersion:null,title:'Private label',visibility:'private',recipients:[]},selectedArticleNumber:'107506',paperPage:0,rawSettings:{},...extra});
async function context(number){return Templates.resolveTemplateSessionContext({employeeNumber:number,sessionKind:'employee',isEmployee:true,permissions:[],scopes:[]},{listBranchAccounts:async()=>[],getEmployeeHomeLocation:async()=>null});}
test('encrypted actor-owned working draft survives reconstruction; stale CAS conflicts and retry IDs are idempotent',async t=>{
 const p=await fixture(t),store=createSalesPriceLabelDraftStore({access:p.app.provider,vault:p.vault}),a=await context('42'),b=await context('43');
 const input={revision:0,mutationId:crypto.randomUUID(),draft:draft()};assert.deepEqual(await store.get(a),{revision:0,draft:null,lastMutationId:null});const saved=await store.save(a,input);assert.equal(saved.revision,1);
 assert.deepEqual(await store.save(a,input),saved);await assert.rejects(store.save(a,{...input,mutationId:crypto.randomUUID(),draft:{...input.draft,name:'Must conflict'}}),{code:'PRICE_LABEL_DRAFT_CONFLICT',status:409});
 assert.deepEqual(await store.get(b),{revision:0,draft:null,lastMutationId:null});assert.deepEqual(await createSalesPriceLabelDraftStore({access:p.app.provider,vault:p.vault}).get(a),{...saved,lastMutationId:input.mutationId});
 assert.ok(p.app.database.prepare("SELECT payload FROM trade_annotations WHERE kind='price-label-working-draft'").all().every(row=>!row.payload.includes('Private label')&&!row.payload.includes('employee:42')));
});
test('untrusted context, unapproved images, expired authorization and invalid input never persist a draft',async t=>{
 const p=await fixture(t),store=createSalesPriceLabelDraftStore({access:p.app.provider,vault:p.vault}),a=await context('42');
 await assert.rejects(store.get({owner:{id:'employee:42'}}),{status:403});
 const input={revision:0,mutationId:crypto.randomUUID(),draft:draft({options:Labels.normalizeOptions({imageBoxes:[{assetId:crypto.randomUUID(),xMm:1,yMm:1,widthMm:5,heightMm:5}]})})};
 await assert.rejects(store.save(a,input),{code:'PRICE_LABEL_IMAGE_STORAGE'});
 await assert.rejects(store.save(a,{...input,draft:draft()},{assertFresh:async()=>{throw Object.assign(new Error('revoked'),{status:403});}}),{status:403});
 assert.deepEqual(await store.get(a),{revision:0,draft:null,lastMutationId:null});
});

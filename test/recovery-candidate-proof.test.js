'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {candidateRecoveryReceipt}=require('../test-support/recovery-candidate-proof');
const binding={runId:'11111111-1111-4111-8111-111111111111',commit:'a'.repeat(40),manifestSha256:'b'.repeat(64),sourceFilesSha256:'c'.repeat(64)};
function proof(){return {providerId:'postgresql-pair',verified:true,manifestSha256:binding.manifestSha256,
 recoveryAccounts:8,managedImportKey:true,databases:{core:{},sales:{}},application:{passed:true,
 compatibility:true,fullApplicationSmoke:true,http:true,authenticatedLogin:true,historicalArticleSearch:true,
 importConfirmed:true,importConflictRejected:true,importUndo:true,revokedSessionRejected:true,
 schedulePdfBytes:100,salesPdfBytes:100,salesPositions:1}};}
test('successful rehearsal is explicitly not an installed or nightly assurance proof',()=>{
 const result=candidateRecoveryReceipt(proof(),binding);
 assert.equal(result.renewsNightlyAssurance,false);assert.equal(result.qualifiesInstalledApplication,false);
 assert.equal(result.scope,'isolated-candidate-only');assert.equal(result.commit,binding.commit);
});
for(const [name,change] of [
 ['different backup',p=>{p.manifestSha256='d'.repeat(64);} ],
 ['missing sales database',p=>{delete p.databases.sales;} ],
 ['unverified restore',p=>{p.verified=false;} ],
 ['missing protected key',p=>{p.managedImportKey=false;} ],
 ['missing full app smoke',p=>{p.application.fullApplicationSmoke=false;} ],
 ['missing login',p=>{p.application.authenticatedLogin=false;} ],
 ['failed report',p=>{p.application.salesPdfBytes=0;} ],
 ['missing import undo',p=>{p.application.importUndo=false;} ],
])test('rejects '+name,()=>{const p=proof();change(p);assert.throws(()=>candidateRecoveryReceipt(p,binding),/CANDIDATE_RECOVERY_/);});
test('rejects unbound source files',()=>assert.throws(()=>candidateRecoveryReceipt(proof(),{...binding,sourceFilesSha256:''}),/CANDIDATE_RECOVERY_BINDING/));

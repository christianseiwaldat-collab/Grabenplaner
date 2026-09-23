'use strict';
const fs=require('node:fs'),path=require('node:path');
const STEPS=new Set(['initialization','health-live','health-ready','fixture-create','login','historical-articles','schedule','schedule-pdf','receipt-context','report-context','concurrent-reads','import-catalog','import-fixture','import-preview','import-conflict','import-apply','import-search','import-undo','import-undo-replay','work-rule-integrity','receipt-search','report-create','report-run','report-pdf','report-delete','revoked-session','extra-scenario','resume-report']);
const CLASSES=new Set(['assertion','http-status','operation']);
function sanitizeSmokeFailure(value){
 if(!value||!STEPS.has(value.step)||!CLASSES.has(value.errorClass))return null;
 const out={step:value.step,errorClass:value.errorClass};
 if(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.at||''))out.at=value.at;
 if(value.errorClass==='http-status'&&Number.isInteger(value.status)&&value.status>=100&&value.status<=599
  &&Number.isInteger(value.expected)&&value.expected>=100&&value.expected<=599){out.status=value.status;out.expected=value.expected;}
 return out;
}
function smokeDiagnostics(root){
 let step='initialization',response=null;
 return {
  step(value){if(!STEPS.has(value))throw new Error('PG_RECOVERY_SMOKE_STEP');step=value;response=null;},
  response(status,expected){response={status,expected};},
  failed(error){
   const errorClass=error?.code==='ERR_ASSERTION'?(response&&response.status!==response.expected?'http-status':'assertion'):'operation';
   const value=sanitizeSmokeFailure({step,errorClass,at:new Date().toISOString(),...response});
   try{fs.writeFileSync(path.join(root,'smoke-failure.json'),JSON.stringify(value)+'\n',{mode:0o600});}catch{/* Never replace the original failure. */}
  },
 };
}
module.exports={smokeDiagnostics,sanitizeSmokeFailure};

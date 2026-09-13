'use strict';
const fs=require('node:fs');
const {connect}=require('../../lib/persistence/postgresql/transfer/history');
const {verifyReferences}=require('../../lib/persistence/postgresql/transfer/verify-pair');
const base='/home/gpadmin/grabenplaner-pg-migration-20260912';
async function main(){
  if(process.platform!=='linux'||fs.realpathSync(process.cwd())!==base+'/qualification'||process.env.GP_PG_SERVER_QUALIFICATION!=='1')throw new Error('Dedicated qualification required');
  const first=JSON.parse(fs.readFileSync(base+'/historical-9/transfer-first.json')),second=JSON.parse(fs.readFileSync(base+'/historical-9/transfer-second.json'));
  if(!first.verified||!second.verified||first.contentSha256!==second.contentSha256||first.sourceSha256!==second.sourceSha256)throw new Error('MIGRATION_REPEAT_MISMATCH');
  let core,sales;
  try {
    core=await connect('core',process.env.GP_CORE_MIGRATOR_URL);sales=await connect('sales',process.env.GP_SALES_MIGRATOR_URL);
    const references=await verifyReferences(core,sales,second);
    const abort=JSON.parse(fs.readFileSync(base+'/historical-9/transfer-abort-test.json'));
    if(!abort.injectedAbort||!abort.transactionsRolledBack||abort.successfulPairMarkerWritten)throw new Error('MIGRATION_ABORT_TEST_MISSING');
    const result={checkedAt:new Date().toISOString(),verified:true,tables:second.tables.length,rows:second.tables.reduce((n,t)=>n+t.rows,0),sourceSha256:second.sourceSha256,contentSha256:second.contentSha256,references,repeatedImports:2,abortRolledBackAndReverified:true,sourceModified:false,productActivation:false,durationSeconds:[first,second].map(r=>(Date.parse(r.completedAt)-Date.parse(r.startedAt))/1000)};
    fs.writeFileSync(base+'/historical-9/verification.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
  }finally{await Promise.allSettled([core?.end(),sales?.end()]);}
}
main().catch(error=>{console.error(JSON.stringify({failed:true,error:error.message.startsWith('MIGRATION_')?error.message:'Historical pair validation failed',code:error.code||null}));process.exitCode=1;});

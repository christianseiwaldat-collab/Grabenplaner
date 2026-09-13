'use strict';
const fs=require('node:fs'),path=require('node:path');
const {transferHistory}=require('../../lib/persistence/postgresql/transfer/history');
const base='/home/gpadmin/grabenplaner-pg-migration-20260912';
async function main(){
  if(process.platform!=='linux'||fs.realpathSync(process.cwd())!==base+'/qualification'||process.env.GP_PG_SERVER_QUALIFICATION!=='1')throw new Error('Dedicated server qualification required');
  const mode=process.argv.slice(2).join(' '),abortTest=mode==='--abort-owned-transfer-test';
  const replay=mode==='--repeat-owned-transfer'||abortTest;
  if(mode&&!replay)throw new Error('Unknown transfer mode');
  const outputPath=path.join(base,'historical-9',abortTest?'transfer-aborted.json':replay?'transfer-second.json':'transfer-first.json');
  if(fs.existsSync(outputPath))throw new Error('Existing transfer evidence must be verified, not overwritten');
  const replayEvidence=replay?JSON.parse(fs.readFileSync(path.join(base,'historical-9/transfer-first.json'),'utf8')):null;
  let result,tables=0;
  try {
    result=await transferHistory({sourceRoot:path.join(base,'historical-9/source'),coreUrl:process.env.GP_CORE_MIGRATOR_URL,salesUrl:process.env.GP_SALES_MIGRATOR_URL,outputPath,replayEvidence,onProgress:value=>{
      console.log(JSON.stringify(value));if(value.table&&++tables===2&&abortTest)throw new Error('MIGRATION_INJECTED_ABORT');
    }});
  }catch(error){
    if(!abortTest||error.message!=='MIGRATION_INJECTED_ABORT')throw error;
    const proof={checkedAt:new Date().toISOString(),injectedAbort:true,transactionsRolledBack:true,successfulPairMarkerWritten:fs.existsSync(outputPath),fullPostAbortContentCheckRequired:true,productActivation:false};
    if(proof.successfulPairMarkerWritten)throw new Error('MIGRATION_ABORT_PUBLISHED');
    fs.writeFileSync(path.join(base,'historical-9','transfer-abort-test.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(proof));return;
  }
  if(replayEvidence&&result.contentSha256!==replayEvidence.contentSha256)throw new Error('MIGRATION_REPLAY_CONTENT_CHANGED');
  console.log(JSON.stringify({verified:result.verified,tables:result.tables.length,rows:result.tables.reduce((n,t)=>n+t.rows,0),contentSha256:result.contentSha256}));
}
main().catch(error=>{
  fs.writeFileSync(path.join(base,'historical-9','transfer-diagnostic.json'),JSON.stringify({name:error.name,message:error.message,code:error.code,table:error.table,column:error.column,constraint:error.constraint,stack:error.stack},null,2)+'\n',{mode:0o600});
  console.error(JSON.stringify({failed:true,code:error.code||null,error:error.message.startsWith('MIGRATION_')?error.message:'Historical transfer failed; protected diagnostic required',table:error.table||null,column:error.column||null,constraint:error.constraint||null}));process.exitCode=1;
});

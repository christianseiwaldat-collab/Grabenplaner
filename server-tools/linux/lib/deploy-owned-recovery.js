'use strict';

const fs=require('node:fs'),path=require('node:path');
const {verifyPairBundle}=require('../../../lib/persistence/postgresql/operations/paired-bundle');
const {verifyPostgresqlRecovery}=require('../recovery/lib/postgresql-recovery');
function document(file){
 const before=fs.lstatSync(file);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.uid!==0||(before.mode&0o022)||before.size<2||before.size>4*1024*1024)throw new Error('PG_DEPLOY_DOCUMENT');
 for(let p=path.dirname(file);;p=path.dirname(p)){
  const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))throw new Error('PG_DEPLOY_DOCUMENT');if(p===path.dirname(p))break;
 }
 return JSON.parse(fs.readFileSync(file,'utf8'));
}
function parseArguments(args){
 if(!Array.isArray(args))throw new Error('PG_DEPLOY_RECOVERY_ARGUMENTS');
 const [bundle,commitMarker,sourceRoot,targetRoot,option,freshSourceDirectory,...extra]=args;
 if(extra.length||![undefined,'--rehydrate','--fresh-access'].includes(option)||(option==='--fresh-access'?!freshSourceDirectory:freshSourceDirectory!==undefined))throw new Error('PG_DEPLOY_RECOVERY_ARGUMENTS');
 if([bundle,commitMarker,sourceRoot,targetRoot,...(freshSourceDirectory?[freshSourceDirectory]:[])].some(p=>!path.isAbsolute(p||'')||fs.realpathSync(p)!==p))throw new Error('PG_DEPLOY_RECOVERY_ARGUMENTS');
 return {bundle,commitMarker,sourceRoot,targetRoot,option,freshSourceDirectory};
}
async function main(args=process.argv.slice(2)){
 if(process.platform!=='linux'||process.getuid()!==0)throw new Error('PG_DEPLOY_ROOT_REQUIRED');
 const {bundle,commitMarker,sourceRoot,targetRoot,option,freshSourceDirectory}=parseArguments(args);
 // The worker and all application checks belong to this exact target tree.
 if(targetRoot!==path.resolve(__dirname,'../../..'))throw new Error('PG_DEPLOY_TARGET_TREE');
 const source=await verifyPairBundle(bundle,commitMarker,{scope:'deploy-owned'});
 const sourcePackage=document(path.join(sourceRoot,'package.json')),targetPackage=document(path.join(targetRoot,'package.json'));
 const sourceRuntime=document(path.join(sourceRoot,'server-tools/linux/runtime-schema.json')),targetRuntime=document(path.join(targetRoot,'server-tools/linux/runtime-schema.json'));
 return verifyPostgresqlRecovery({stageOutput:{bundle,commitMarker,manifestSha256:source.manifestSha256},stage:path.dirname(bundle),sourcePackage,targetPackage,sourceRuntime,targetRuntime,frozenFiles:[],scope:'deploy-owned',rehydrate:option!==undefined,...(freshSourceDirectory?{freshSourceDirectory}:{})});
}
if(require.main===module)main().then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(error=>{
 process.stderr.write(JSON.stringify({failed:true,error:/^PG_/.test(error.message)?error.message:'Deploy recovery failed'})+'\n');process.exitCode=1;
});
module.exports={main,parseArguments};

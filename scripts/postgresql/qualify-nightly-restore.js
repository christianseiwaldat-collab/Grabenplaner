'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const R=require('../../lib/persistence/postgresql/operations/paired-development');
const {loadConfiguration,createBackup}=require('../../lib/persistence/postgresql/operations/runtime');
const {restorePair}=require('../../lib/persistence/postgresql/operations/paired-restore');
async function main(){
 R.guard();const proof=R.ROOT+'/nightly-restore-verification.json';if(fs.existsSync(proof))throw new Error('PG_PAIR_NIGHTLY_ALREADY_VERIFIED');
 const config=loadConfiguration(R.ROOT+'/operations-config.json');
 const previous=R.ROOT+'/nightly-restore-attempt.json';
 const backup=process.argv.includes('--retry-restore')?JSON.parse(fs.readFileSync(previous,'utf8')).backup:await createBackup(config);console.log(JSON.stringify({phase:'backup',milliseconds:backup.milliseconds,manifestSha256:backup.sha256}));
 const workRoot=R.ROOT+'/nightly-'+crypto.randomUUID();fs.mkdirSync(workRoot,{mode:0o700});
 fs.writeFileSync(R.ROOT+'/nightly-restore-attempt.json',JSON.stringify({backup,workRoot})+'\n',{mode:0o600});
 const result=await restorePair({bundle:backup.bundle,commitMarker:backup.commitMarker,workRoot});
 fs.writeFileSync(proof,JSON.stringify({...result,productActivation:false},null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
}
main().catch(e=>{console.error(JSON.stringify({failed:true,error:e.message,code:e.code||null,tool:e.tool,commandNumber:e.commandNumber,frames:e.stack?.split('\n').slice(1,5)}));process.exitCode=1;});

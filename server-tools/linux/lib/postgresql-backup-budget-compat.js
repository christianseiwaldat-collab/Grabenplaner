'use strict';
// Explicit first-deploy bridge. The updater has already verified the complete
// candidate package. This additional contract pins both backup dependency trees
// and their shell/lease/runtime contracts; no installed/candidate modules mix.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const contract=require('./postgresql-backup-budget-contract.json');
const fail=code=>{throw new Error('PG_BACKUP_BUDGET_BRIDGE_'+code);};
function bytes(root,relative){
 const file=path.join(root,...relative.split('/')),stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||fs.realpathSync(file)!==file)fail('FILE');
 return fs.readFileSync(file);
}
const hash=value=>crypto.createHash('sha256').update(value.toString('utf8').replace(/\r\n/g,'\n')).digest('hex');
function verifyBackupBudgetCompatibility(installedRoot,candidateRoot){
 for(const root of [installedRoot,candidateRoot])if(!path.isAbsolute(root)||fs.realpathSync(root)!==root||!fs.lstatSync(root).isDirectory())fail('ROOT');
 if(installedRoot===candidateRoot)fail('ROOT');
 const previous=JSON.parse(bytes(installedRoot,'package.json')),next=JSON.parse(bytes(candidateRoot,'package.json'));
 if(previous.version!==contract.predecessorVersion)fail('PREDECESSOR');
 for(const key of ['dependencies','engines','packageManager'])if(JSON.stringify(previous[key])!==JSON.stringify(next[key]))fail('DEPENDENCIES');
 for(const [relative,pins] of Object.entries(contract.files)){
  for(const [root,wanted] of [[installedRoot,pins.before],[candidateRoot,pins.after]]){
   if(wanted===null){if(fs.existsSync(path.join(root,...relative.split('/'))))fail('UNREVIEWED');continue;}
   if(hash(bytes(root,relative))!==wanted)fail('UNREVIEWED');
  }
 }
 return {verified:true,predecessorVersion:contract.predecessorVersion,predecessorCommit:contract.predecessorCommit,
  candidateBackupTree:true,configurationUnchanged:true,pairedFormatUnchanged:true,freshBackupRequired:true,files:Object.keys(contract.files).length};
}
if(require.main===module){try{
 if(process.argv.length!==4)fail('ARGUMENTS');
 process.stdout.write(JSON.stringify(verifyBackupBudgetCompatibility(...process.argv.slice(2)))+'\n');
}catch(error){process.stderr.write((/^PG_BACKUP_BUDGET_BRIDGE_/.test(error.message)?error.message:'PG_BACKUP_BUDGET_BRIDGE_FAILED')+'\n');process.exitCode=1;}}
module.exports={verifyBackupBudgetCompatibility};

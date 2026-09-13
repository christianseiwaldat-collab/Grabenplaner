'use strict';
const fs=require('node:fs');
const R=require('../../lib/persistence/postgresql/operations/paired-development');
async function main(){
  if(process.platform!=='linux'||fs.realpathSync(process.cwd())!==R.BASE+'/qualification')throw new Error('Dedicated qualification required');
  const action=process.argv[2];
  if(action==='backup'){R.initialize();console.log(JSON.stringify(await R.createBundle()));}
  else if(action==='restore')console.log(JSON.stringify(await R.restoreBundle({attempt:Number(process.argv[3]||1)})));
  else if(action==='offsite-restore')console.log(JSON.stringify(await R.restoreBundle({attempt:Number(process.argv[3]||1),source:'offsite'})));
  else if(action==='verify')console.log(JSON.stringify({bundleVerified:true,files:(await R.verifyBundle()).files.length}));
  else if(action==='pitr')console.log(JSON.stringify(await require('../../lib/persistence/postgresql/operations/paired-pitr').qualifyPitr()));
  else if(action==='resume-pitr')console.log(JSON.stringify(await require('../../lib/persistence/postgresql/operations/paired-pitr').resumePitr()));
  else if(action==='retry-pitr-from-base')console.log(JSON.stringify(await require('../../lib/persistence/postgresql/operations/paired-pitr').resumePitr({rebuildTarget:true})));
  else throw new Error('Expected backup, restore, pitr or verify');
}
main().catch(error=>{
 try{R.guard({reserve:false});fs.writeFileSync(R.ROOT+'/failure-diagnostic.json',JSON.stringify({code:error.code||null,message:error.message,stack:error.stack},null,2)+'\n',{mode:0o600});}catch{}
 console.error(JSON.stringify({failed:true,code:error.code||null,error:error.message.startsWith('PG_PAIR_')||error.message.startsWith('MIGRATION_')?error.message:'Paired recovery qualification failed',tool:error.tool||null,exitCode:error.exitCode||null}));process.exitCode=1;
});

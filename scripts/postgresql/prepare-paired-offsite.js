'use strict';
const fs=require('node:fs'),R=require('../../lib/persistence/postgresql/operations/paired-development');
const {sealPairBundle}=require('../../lib/persistence/postgresql/operations/paired-bundle');
async function main(){
 R.guard();const source=await R.verifyBundle();
 const proof=JSON.parse(fs.readFileSync(R.ROOT+'/logical-verification.json','utf8'));
 if(!proof.verified||proof.bundleManifestSha256!==JSON.parse(fs.readFileSync(R.ROOT+'/bundle.complete.json','utf8')).manifestSha256)throw new Error('PG_PAIR_LOGICAL_PROOF');
 const directory=R.ROOT+'/postgresql-block10.pair';if(fs.existsSync(directory))throw new Error('PG_PAIR_OFFSITE_TARGET_EXISTS');fs.mkdirSync(directory,{mode:0o700});
 for(const item of source.files){
  const from=R.ROOT+'/bundle/'+item.file,to=directory+'/'+item.file;fs.mkdirSync(require('node:path').dirname(to),{recursive:true,mode:0o700});fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);fs.chmodSync(to,0o600);
 }
 const result=await sealPairBundle(directory,{databases:[{domain:'core',database:'gp_migration_core',file:'core.dump'},{domain:'sales',database:'gp_migration_sales',file:'sales.dump'}],checkpoint:{kind:'isolated-rehearsal',quiescence:source.quiescence,contentSha256:source.contentSha256,logicalProofSha256:await require('../../lib/persistence/postgresql/transfer/history').fileHash(R.ROOT+'/logical-verification.json')}});
 fs.writeFileSync(R.ROOT+'/offsite-result.json',JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({prepared:true,sha256:result.sha256}));
}
main().catch(e=>{console.error(JSON.stringify({failed:true,code:e.code||null,error:e.message}));process.exitCode=1;});

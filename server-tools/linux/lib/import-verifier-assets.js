'use strict';
// Invoked only from a byte-verified, root-sealed application. Never starts Java.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const A=require('../../../lib/import-verifier-runtime-assets');
function fail(){throw Object.assign(new Error('IMPORT_VERIFIER_ASSET_MODE'),{code:'IMPORT_VERIFIER_ASSET_MODE'});}
function need(value){if(!value)fail();}
function protectedPath(filename,regular=false){
 const before=fs.lstatSync(filename);need(!before.isSymbolicLink()&&before.uid===0&&!(before.mode&0o7022));
 need(regular?before.isFile()&&before.nlink===1:before.isDirectory());return before;
}
function protectedApplication(root){
 need(process.platform==='linux'&&process.getuid()===0);root=path.resolve(root);need(fs.realpathSync.native(root)===root);
 for(let current=root;;current=path.dirname(current)){protectedPath(current);if(path.dirname(current)===current)break;}
}
function verifyRuntimeAssets(root){
 const observed=A.inspectRuntimeAssets(root);if(!observed)return {required:false,readOnly:true,javaExecuted:false};
 protectedApplication(root);protectedPath(path.join(root,'lib/import-verifier-runtime-assets.json'),true);protectedPath(path.join(root,observed.descriptorPath),true);
 A.inspectRuntimeAssets(root,{installed:true});return {required:true,readOnly:true,javaExecuted:false,descriptorSha256:observed.descriptorSha256,completeTreeSha256:observed.completeTreeSha256,executablesVerified:observed.executableModes.length};
}
function normalizeRuntimeAssets(root){
 const observed=A.inspectRuntimeAssets(root);if(!observed)return {required:false,readOnly:false,javaExecuted:false};
 protectedApplication(root);protectedPath(path.join(root,'lib/import-verifier-runtime-assets.json'),true);protectedPath(path.join(root,observed.descriptorPath),true);
 for(const entry of observed.executableModes){
  const filename=path.join(root,...entry.path.split('/'));let current=path.dirname(filename);
  for(;;){protectedPath(current);if(current===path.resolve(root))break;current=path.dirname(current);}
  const before=protectedPath(filename,true),fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const opened=fs.fstatSync(fd);need(opened.ino===before.ino&&opened.dev===before.dev&&opened.size===before.size&&opened.uid===0&&!(opened.mode&0o7022));
   const bytes=fs.readFileSync(fd);need(crypto.createHash('sha256').update(bytes).digest('hex')===entry.sha256&&bytes.subarray(0,6).equals(Buffer.from([127,69,76,70,2,1]))&&bytes.readUInt16LE(18)===62);fs.fchmodSync(fd,0o750);
  }finally{fs.closeSync(fd);}
 }
 const verified=verifyRuntimeAssets(root);return {...verified,readOnly:false,executablesNormalized:observed.executableModes.length};
}
module.exports={verifyRuntimeAssets,normalizeRuntimeAssets};
if(require.main===module){try{const [action,root]=process.argv.slice(2);need(['verify','normalize'].includes(action)&&root&&process.argv.length===4);process.stdout.write(JSON.stringify(action==='normalize'?normalizeRuntimeAssets(root):verifyRuntimeAssets(root))+'\n');}catch{process.stderr.write('IMPORT_VERIFIER_ASSET_MODE\n');process.exitCode=1;}}

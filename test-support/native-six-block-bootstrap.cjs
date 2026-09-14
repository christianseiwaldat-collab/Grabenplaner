'use strict';
// Dedicated synthetic native qualification only. No productive configuration is read.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ROOT='/home/gpadmin/gp-v09246-qualification-20260914',PORT=55487;
const guard=()=>{assert.equal(process.platform,'linux');assert.notEqual(process.getuid(),0);assert.equal(fs.realpathSync(ROOT),ROOT);assert.equal(fs.readFileSync(ROOT+'/ownership-marker','utf8').trim(),'gp-v09246-synthetic-only');assert.equal(fs.statSync(ROOT).mode&0o077,0);};
async function bootstrap(){guard();
 const filename=path.resolve(__dirname,'../lib/persistence/postgresql/transfer/staging.js'),moduleApi={exports:{}};
 // The existing bootstrap has a fixed productive staging port. This private
 // qualification copy is bound to another loopback port and a fresh cluster.
 const source=fs.readFileSync(filename,'utf8').replaceAll('55486',String(PORT));
 new Function('require','module','exports',source)(require('node:module').createRequire(filename),moduleApi,moduleApi.exports);
 const config=JSON.parse(fs.readFileSync(ROOT+'/credentials.json','utf8'));
 const result=await moduleApi.exports.bootstrapPair(config);
 console.log(JSON.stringify({prepared:result.prepared,databases:result.databaseCount,syntheticOnly:true,port:PORT}));
}
if(require.main===module)bootstrap().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={ROOT,PORT,guard};

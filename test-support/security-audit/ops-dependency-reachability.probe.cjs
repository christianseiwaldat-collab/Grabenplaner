'use strict';
// Explicit opt-in bounded checks of advisory preconditions, not an application exploit.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const test = require('node:test');
const root=path.resolve(__dirname,'../..');
if(process.argv[2]==='brace-worker'){
  const store=path.join(root,'node_modules','.pnpm');
  const directory=fs.readdirSync(store).find(name=>name.startsWith('brace-expansion@5.0.9'));
  if(!directory)throw new Error('locked brace-expansion package missing');
  const expand=require(path.join(store,directory,'node_modules','brace-expansion'));
  try {expand('{'.repeat(4000)+'a,b'+'}'.repeat(4000)); process.stdout.write('completed');}
  catch(error){process.stdout.write(error instanceof RangeError?'range-error':error.name);}
}else{
  test('ops: proxy-addr advisory precondition is rejected by strict loopback production policy',()=>{
    const proxyaddr=createRequire(require.resolve('express'))('proxy-addr');
    const req={socket:{remoteAddress:'198.51.100.23'},headers:{'x-forwarded-for':'203.0.113.9'}};
    assert.equal(proxyaddr(req,proxyaddr.compile('loopback')),'198.51.100.23');
    assert.equal(proxyaddr(req,proxyaddr.compile('::ffff:10.0.0.0/8')),'203.0.113.9');
    const {runtimeValidationErrors}=require('../../lib/server-runtime');
    const errors=runtimeValidationErrors({operationMode:'server',host:'127.0.0.1',port:3000,
      trustProxy:'::ffff:10.0.0.0/8',deploymentKind:'production',nodeEnvironment:'production',backupKeep:30,
      databasePath:path.join(root,'synthetic-never-created','data.db'),dataRoot:path.join(root,'synthetic-never-created')});
    assert.ok(errors.some(value=>value.includes('TRUST_PROXY')));
  });
  test('ops: local brace-expansion compatibility patch does not remove nested-recursion RangeError',()=>{
    const result=spawnSync(process.execPath,['--max-old-space-size=128',__filename,'brace-worker'],{encoding:'utf8',timeout:3000,maxBuffer:1024});
    assert.ifError(result.error); assert.equal(result.status,0); assert.equal(result.stdout,'range-error');
  });
  test('ops: harmless generated AVIF reaches the loan-photo HEIF decoder', {timeout:10000}, async()=>{
    const sharp=require('sharp');
    const {prepareLoanPhoto}=require('../../lib/loan-photo');
    const source=await sharp({create:{width:8,height:8,channels:3,background:'#337755'}}).avif().toBuffer();
    const metadata=await sharp(source).metadata(); assert.equal(metadata.format,'heif');
    const prepared=await prepareLoanPhoto({buffer:source,originalName:'synthetic-audit.avif'});
    assert.equal(prepared.mime,'image/jpeg'); assert.ok(prepared.buffer.length>0);
  });
}

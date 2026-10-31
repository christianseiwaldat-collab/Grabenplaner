"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("PostgreSQL configuration/recovery-file preflight loads only local source and Node builtins", () => {
  const source = `
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const original=Module._load,external=[];
Module._load=function(name,parent,isMain){
 if(!Module.isBuiltin(name)&&!name.startsWith('.')&&!path.isAbsolute(name)){
  external.push(name);throw new Error('EXTERNAL_DEPENDENCY_FORBIDDEN:'+name);
 }
 return original.apply(this,arguments);
};
const runtime=require('./lib/persistence/postgresql/operations/runtime');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-pure-pg-preflight-'));
try{
 assert.deepEqual(runtime.recoveryFilesPreflight(root),{verified:true,files:0,bytes:0,excluded:['private/amu/tmp']});
 assert.throws(()=>runtime.loadConfiguration('relative-configuration-path'));
 assert.deepEqual(external,[]);
 runtime.monitor({domains:[]}).then(()=>{throw Error('Database operations must retain their actual driver dependency');},error=>{
  assert.equal(error.message,'EXTERNAL_DEPENDENCY_FORBIDDEN:pg');assert.deepEqual(external,['pg']);
  process.stdout.write('PURE_PREFLIGHT_AND_REAL_DRIVER_BOUNDARY_VERIFIED');
 });
}finally{fs.rmSync(root,{recursive:true,force:true});}
`;
  const result = spawnSync(process.execPath, ["--no-global-search-paths", "-e", source], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "PURE_PREFLIGHT_AND_REAL_DRIVER_BOUNDARY_VERIFIED");
});

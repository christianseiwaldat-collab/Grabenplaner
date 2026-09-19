'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {safeDiagnostics}=require('../server-tools/linux/recovery/lib/postgresql-recovery-diagnostics');
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gp-safe-recovery-diagnostic-'))),app=path.join(root,'work','application');
 fs.mkdirSync(app,{recursive:true});t.after(()=>{assert.ok(root.startsWith(fs.realpathSync(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true});});return {root,app};
}
test('only phase/time/memory and health status survive private diagnostic projection',t=>{
 const {root,app}=fixture(t),at='2026-09-19T03:45:00.000Z';
 fs.writeFileSync(path.join(app,'http-progress.jsonl'),JSON.stringify({phase:'initialization-wait',at,heap:123,rss:456,password:'SECRET'})+'\n'+JSON.stringify({phase:'/api/schedule?employee=PRIVATE',at})+'\n');
 fs.writeFileSync(path.join(app,'http-last-response-private.json'),JSON.stringify({route:'/api/health/ready',status:503,body:{ok:false,code:'APP_START_FAILED',error:'PRIVATE_DATABASE_SQL',token:'SECRET'}}));
 const result=safeDiagnostics(root);
 assert.deepEqual(result,{httpProgress:[{phase:'initialization-wait',at,heap:123,rss:456}],health:{route:'/api/health/ready',status:503,ok:false,code:'APP_START_FAILED'}});
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|SECRET|password|token|employee/);
});
test('large progress logs are bounded and private non-health response bodies are discarded',t=>{
 const {root,app}=fixture(t);fs.writeFileSync(path.join(app,'http-progress.jsonl'),Array.from({length:5000},()=>JSON.stringify({phase:'initialization-wait',heap:1,rss:2})).join('\n'));
 fs.writeFileSync(path.join(app,'http-last-response-private.json'),JSON.stringify({route:'/api/portal/v1/auth/login',status:400,body:{code:'PRIVATE',password:'SECRET'}}));
 const result=safeDiagnostics(root);assert.equal(result.httpProgress.length,64);assert.equal(result.health,undefined);assert.ok(JSON.stringify(result).length<10000);
});
test('oversized or malformed responses do not escape projection or prevent scratch cleanup',t=>{
 const {root,app}=fixture(t);fs.writeFileSync(path.join(app,'http-last-response-private.json'),'X'.repeat(100000));
 fs.writeFileSync(path.join(app,'http-progress.jsonl'),'invalid\n');assert.deepEqual(safeDiagnostics(root),{});
});

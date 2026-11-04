'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Worker } = require('node:worker_threads');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { SQLITE_PORTAL_ACCESS_CATALOG } = require('../lib/persistence/sqlite/portal-access-catalog');
const { ensureSqliteApplicationSchema } = require('../lib/persistence/sqlite/operations/application-schema');
const { createPortalAccessRepository } = require('../lib/persistence/repositories/portal-access');
const WORKERS = 8, NOW = '2026-10-18T12:00:00.000Z';
function bounded(promise, milliseconds, description) {
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(description)),milliseconds);})]).finally(()=>clearTimeout(timer));
}
function messageFrom(worker,type,round) {
  const promise = new Promise((resolve,reject)=>{
    const cleanup=()=>{worker.off('message',message);worker.off('error',error);worker.off('exit',exit);};
    const error=value=>{cleanup();reject(value);};
    const exit=code=>error(new Error(`Worker exited before ${type}: ${code}`));
    const message=value=>{
      if(value.type==='failure'){error(new Error(`Worker failure: ${value.code||''} ${value.message}`));return;}
      if(value.type===type&&(round===undefined||value.round===round)){cleanup();resolve(value);}
    };
    worker.on('message',message);worker.on('error',error);worker.on('exit',exit);
  });
  promise.catch(()=>{});
  return promise;
}

test('SQLite login counters serialize across eight independent native database connections', {timeout:90000}, async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gp-login-multiconnection-'));
  const databasePath=path.join(directory,'synthetic.db'), workers=[];
  const abortWorkers=()=>{for(const worker of workers)worker.terminate().catch(()=>{});};
  t.signal.addEventListener('abort',abortWorkers,{once:true});
  let round=0;
  async function control(work) {
    const app=openSqliteApplicationPersistence({databasePath,catalog:SQLITE_PORTAL_ACCESS_CATALOG});
    try{return await work(app,createPortalAccessRepository(app.provider));}
    finally{await app.provider.close();app.database.close();}
  }
  try {
    await control(async app=>{
      ensureSqliteApplicationSchema(app.database);
      app.database.exec(`INSERT INTO locations(id,name,active) VALUES('18','Synthetic',1);
        INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,active) VALUES('00001','Synthetic','Synthetic','18',1);
        INSERT INTO portal_users(employee_number,password_hash,role,active) VALUES('00001','synthetic-hash','employee',1);
        INSERT INTO portal_organization_accounts(id,login_name,display_name,account_type,password_hash,active)
          VALUES('synthetic-org','SYNTHETIC-ORG','Synthetic','branch','synthetic-hash',1);`);
    });
    const ready=[];
    for(let index=0;index<WORKERS;index++) {
      const worker=new Worker(path.resolve(__dirname,'../test-support/security-audit/login-multiconnection-worker.cjs'),{workerData:{databasePath}});
      workers.push(worker);ready.push(messageFrom(worker,'ready'));
    }
    const started=await bounded(Promise.all(ready),20000,'Independent SQLite workers did not open in time');
    assert.equal(new Set(started.map(value=>value.threadId)).size,WORKERS);
    async function concurrentFailures(channel,maximum,attempts,baseTime=NOW) {
      const id=++round,barrier=new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),armed=[],completed=[];
      for(let index=0;index<workers.length;index++) {
        const worker=workers[index];armed.push(messageFrom(worker,'armed',id));completed.push(messageFrom(worker,'done',id));
        worker.postMessage({type:'failures',round:id,barrier,channel,maximum,attempts,
          now:new Date(Date.parse(baseTime)+index*1000).toISOString()});
      }
      try {
        await bounded(Promise.all(armed),20000,'Workers did not reach the shared snapshot barrier');
        Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0,WORKERS);
        return await bounded(Promise.all(completed),20000,'Concurrent SQLite writes exceeded the bounded run');
      } finally {Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0,WORKERS);}
    }
    const read=channel=>control(async(_app,repository)=>channel==='organization'
      ?repository.getOrganizationLogin({loginName:'SYNTHETIC-ORG'}):repository.getEmployeeLogin({loginName:'00001'}));
    const reset=()=>control(async app=>app.database.exec(`UPDATE portal_users SET failed_login_attempts=0,locked_until=NULL;
      UPDATE portal_organization_accounts SET failed_login_attempts=0,locked_until=NULL;`));
    for(const channel of ['employee','organization']) {
      await t.test(`${channel}: all 64 simultaneous failures are counted without a process mutex`,async()=>{
        await reset();
        const results=await concurrentFailures(channel,1000,8),account=await read(channel);
        assert.equal(results.reduce((sum,value)=>sum+value.affected,0),64);
        assert.equal(account.failed_login_attempts,64);assert.equal(account.locked_until,null);
        t.diagnostic(`${channel}: ${WORKERS} distinct SQLite connections, 64/64 committed increments`);
      });
      await t.test(`${channel}: threshold five stops other connections and later requests preserve the exact lock`,async()=>{
        await reset();
        const results=await concurrentFailures(channel,5,4),locked=await read(channel);
        assert.equal(results.reduce((sum,value)=>sum+value.affected,0),5);
        assert.equal(locked.failed_login_attempts,5);
        const candidates=Array.from({length:WORKERS},(_,index)=>new Date(Date.parse(NOW)+15*60000+index*1000).toISOString());
        assert.ok(candidates.includes(locked.locked_until));
        const later=await concurrentFailures(channel,5,2,'2026-10-18T12:01:00.000Z');
        const unchanged=await read(channel);
        assert.equal(later.reduce((sum,value)=>sum+value.affected,0),0);
        assert.equal(unchanged.failed_login_attempts,5);assert.equal(unchanged.locked_until,locked.locked_until);
        t.diagnostic(`${channel}: 5/32 threshold increments; 16 later updates leave the lock unchanged`);
      });
    }
    const closed=workers.map(worker=>{const result=messageFrom(worker,'closed');worker.postMessage({type:'close'});return result;});
    await bounded(Promise.all(closed),15000,'SQLite worker connections did not close in time');
  } finally {
    t.signal.removeEventListener('abort',abortWorkers);
    await Promise.allSettled(workers.map(worker=>worker.terminate()));
    const resolved=path.resolve(directory),temporaryRoot=path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved),temporaryRoot);
    assert.match(path.basename(resolved),/^gp-login-multiconnection-/);
    fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
});

'use strict';
// Each worker owns a real, separate SQLite connection. No shared JS write queue.
const assert = require('node:assert/strict'), path = require('node:path');
const { parentPort, workerData, threadId } = require('node:worker_threads');
const { createSqlitePersistenceProvider } = require('../../lib/persistence/sqlite/provider');
const { SQLITE_PORTAL_ACCESS_CATALOG } = require('../../lib/persistence/sqlite/portal-access-catalog');
const { createPortalAccessRepository } = require('../../lib/persistence/repositories/portal-access');
const { loginFailureParameters } = require('../../lib/portal-login-security');
assert.equal(workerData.databasePath, path.resolve(workerData.databasePath));
assert.equal(path.basename(workerData.databasePath), 'synthetic.db');
assert.match(path.basename(path.dirname(workerData.databasePath)), /^gp-login-multiconnection-/);
const provider = createSqlitePersistenceProvider({databasePath:workerData.databasePath,catalog:SQLITE_PORTAL_ACCESS_CATALOG});
const repository = createPortalAccessRepository(provider);
let busy = false;
parentPort.on('message', async message => {
  try {
    assert.equal(busy, false, 'Worker commands must not overlap');
    busy = true;
    if(message.type === 'close') {
      await provider.close(); parentPort.postMessage({type:'closed',threadId}); parentPort.close(); return;
    }
    assert.equal(message.type, 'failures');
    const organization = message.channel === 'organization';
    const user = organization ? await repository.getOrganizationLogin({loginName:'SYNTHETIC-ORG'})
      : await repository.getEmployeeLogin({loginName:'00001'});
    assert.ok(user);
    const barrier = new Int32Array(message.barrier);
    parentPort.postMessage({type:'armed',round:message.round,threadId});
    assert.notEqual(Atomics.wait(barrier,0,0,15000), 'timed-out', 'Worker start barrier timed out');
    let affected = 0;
    for(let index=0;index<message.attempts;index++) {
      const params = loginFailureParameters(user,{max_failed_login_attempts:message.maximum,account_lock_minutes:15},new Date(message.now));
      const result = organization ? await repository.updateOrganizationLoginFailure(params) : await repository.updateEmployeeLoginFailure(params);
      affected += result.rowsAffected;
    }
    busy = false;
    parentPort.postMessage({type:'done',round:message.round,threadId,affected,attempts:message.attempts});
  } catch(error) {
    busy = false;
    parentPort.postMessage({type:'failure',round:message.round,threadId,message:String(error.message),code:error.code||null});
  }
});
parentPort.postMessage({type:'ready',threadId});

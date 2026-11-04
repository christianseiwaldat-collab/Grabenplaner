'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { loginFailureParameters, runLoginTransaction, acceptVerifiedLogin } = require('../lib/portal-login-security');
const user = { employee_number:'synthetic-account', account_id:'synthetic-organization', password_hash:'synthetic-hash' };
const now = new Date('2026-10-18T10:00:00.000Z');

test('login failure policy uses positive safe integer thresholds and bounded lock duration', () => {
  for (const value of [undefined, null, '', 0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 'invalid']) {
    assert.equal(loginFailureParameters(user, {max_failed_login_attempts:value}, now).maximum, 5);
  }
  for (const value of [undefined, null, '', 0, -1, Infinity, NaN, 525601, 'invalid']) {
    assert.equal(loginFailureParameters(user, {account_lock_minutes:value}, now).lockedUntil, '2026-10-18T10:15:00.000Z');
  }
  const actual = loginFailureParameters(user, {max_failed_login_attempts:'3', account_lock_minutes:'20'}, now);
  assert.deepEqual(actual, {employeeNumber:user.employee_number, accountId:user.account_id,
    expectedPasswordHash:user.password_hash, maximum:3, now:now.toISOString(), lockedUntil:'2026-10-18T10:20:00.000Z'});
  assert.equal(Object.hasOwn(actual, 'attempts'), false);
});

test('verified login serializes each complete retry with a fresh executor and returns only the committed result', async () => {
  let attempts=0; const executions=[], factories=[];
  const provider = { async transaction(work, options) {
    assert.deepEqual(options, {isolation:'serializable'});
    const executor={attempt:++attempts}; const value=await work(executor);
    if(attempts<3)throw Object.assign(new Error('synthetic rollback'), {code:'PERSISTENCE_RETRYABLE_TRANSACTION'});
    return value;
  } };
  const result = await runLoginTransaction(provider, executor => { factories.push(executor.attempt);return {executor}; }, async ({executor}) => {
    executions.push(executor.attempt); return {committedAttempt:executor.attempt};
  });
  assert.deepEqual(result,{committedAttempt:3});
  assert.deepEqual(factories,[1,2,3]); assert.deepEqual(executions,[1,2,3]);
});

test('verified login retries are bounded at six attempts and propagate the final rollback', async () => {
  let attempts=0; const failure=Object.assign(new Error('synthetic rollback'),{code:'PERSISTENCE_RETRYABLE_TRANSACTION'});
  await assert.rejects(runLoginTransaction({async transaction(){attempts++;throw failure;}}, value=>value, async()=>{}), error=>error===failure);
  assert.equal(attempts,6);
});

test('verified login never retries failures without an explicit safe rollback classification', async () => {
  for(const code of ['PERSISTENCE_BUSY','PERSISTENCE_TIMEOUT','PERSISTENCE_CONNECTION_UNAVAILABLE','PORTAL_LOGIN_FAILED','40001',undefined]) {
    let attempts=0; const failure=Object.assign(new Error('synthetic uncertain outcome'),{code});
    await assert.rejects(runLoginTransaction({async transaction(){attempts++;throw failure;}}, value=>value, async()=>{}),error=>error===failure);
    assert.equal(attempts,1,String(code));
  }
});

test('login acceptance uses conditional success once and classifies a failed match without modifying state again', async () => {
  for(const organization of [false,true]) for(const outcome of ['accepted','locked','changed']) {
    const calls=[];
    const repository={
      async markEmployeeLoginSuccess(input){calls.push(['employee-success',input]);return {rowsAffected:outcome==='accepted'?1:0};},
      async markOrganizationLoginSuccess(input){calls.push(['organization-success',input]);return {rowsAffected:outcome==='accepted'?1:0};},
      async getEmployeeLogin(input){calls.push(['employee-read',input]);return outcome==='locked'?{locked_until:'2026-10-18T11:00:00.000Z'}:null;},
      async getOrganizationLogin(input){calls.push(['organization-read',input]);return outcome==='locked'?{locked_until:'2026-10-18T11:00:00.000Z'}:null;},
    };
    assert.equal(await acceptVerifiedLogin(repository,{user,organization,now}),outcome);
    assert.deepEqual(calls[0],[`${organization?'organization':'employee'}-success`,{employeeNumber:user.employee_number,accountId:user.account_id,expectedPasswordHash:user.password_hash,now:now.toISOString()}]);
    assert.equal(calls.length,outcome==='accepted'?1:2);
    if(calls.length===2)assert.deepEqual(calls[1],[`${organization?'organization':'employee'}-read`,{loginName:user.employee_number}]);
  }
});

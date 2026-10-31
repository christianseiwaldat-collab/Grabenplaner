"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

function diagnosticEnvironment() {
  const environment = { ...process.env, GP_PG_API_FIXTURE_BRIDGE: "1", GP_CI_POSTGRESQL_FIXTURE: "github-actions-service-v1",
    GP_PG_API_DIAGNOSTIC: "bounded-errors-v1", CI: "true", GITHUB_ACTIONS: "true",
    TEST_POSTGRESQL_URL: "postgresql://postgres:synthetic-private-password@127.0.0.1:5432/grabenplaner_test" };
  for (const domain of ["core", "sales"]) for (const purpose of ["migrator", "app", "reader"]) {
    environment[`GP_${domain.toUpperCase()}_${purpose.toUpperCase()}_URL`] = `postgresql://gp_${domain}_${purpose}:synthetic-private-password@127.0.0.1:5432/gp_migration_${domain}`;
  }
  delete environment.NODE_OPTIONS;
  return environment;
}

test("bounded PostgreSQL diagnostic preserves callback/promise failures and omits SQL, credentials and substituted messages", () => {
  const sql = "SELECT 'synthetic-private-query-value'";
  const code = `
    const Module=require('node:module'),load=Module._load,assert=require('node:assert/strict');
    const pending=Promise.reject(Object.assign(new Error('synthetic-private-error-value'),{code:'23514',constraint:'fixture_check'}));
    const context={};
    class Client{query(...args){const cb=args.at(-1);if(typeof cb==='function')return cb.call(context,Object.assign(new Error('SYNTHETIC_GUARD_REJECTED'),{code:'23514'}));return pending;}}
    Module._load=function(name,...args){return name==='pg'?{Client}:load.call(this,name,...args);};
    require('./test-support/postgresql-api/diagnostic-errors');
    const client=new Client();
    client.query(${JSON.stringify(sql)},['synthetic-private-bind-value'],function(error){assert.equal(this,context);assert.equal(error.message,'SYNTHETIC_GUARD_REJECTED');});
    const actual=client.query(${JSON.stringify(sql)});
    assert.equal(actual,pending);
    actual.catch(error=>{assert.equal(error.message,'synthetic-private-error-value');process.stdout.write('ORIGINAL_FAILURES_PRESERVED');});
  `;
  const environment = diagnosticEnvironment();
  const result = spawnSync(process.execPath, ["-e", code], { cwd: path.resolve(__dirname, ".."), env: environment, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ORIGINAL_FAILURES_PRESERVED");
  const rows = result.stderr.trim().split("\n").map(line => JSON.parse(line.replace(/^PG_DIAGNOSTIC /, "")));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.code), ["23514", "23514"]);
  assert.equal(rows[0].messageKey, "SYNTHETIC_GUARD_REJECTED");
  assert.equal(rows[1].messageKey, null);
  assert.equal(rows[1].constraint, "fixture_check");
  assert.ok(rows.every(row => row.sqlSha256 === crypto.createHash("sha256").update(sql).digest("hex")));
  assert.doesNotMatch(result.stderr, /synthetic-private|postgresql:\/\/|SELECT/);
});

test("adapter diagnostics retain normalization while exposing only hashes and reviewed relative code locations", () => {
  const message = "synthetic-private-adapter-error-password";
  const code = `
    const Module=require('node:module'),load=Module._load,assert=require('node:assert/strict'),path=require('node:path');
    Module._load=function(name,...args){return name==='pg'?{Client:class Client{query(){}}}:load.call(this,name,...args);};
    require('./test-support/postgresql-api/diagnostic-errors');
    const errors=require('./lib/persistence/errors');
    const input=new Error(${JSON.stringify(message)});
    input.stack=input.message+'\\n  at privateData (/untrusted/synthetic-private-record.js:9:2)'
      +'\\n  at privateData ('+path.join(process.cwd(),'lib/synthetic-private-record.js')+':9:2)'
      +'\\n  at hiddenName ('+path.join(process.cwd(),'server.js')+':120:4)'
      +'\\n  at hiddenName ('+path.join(process.cwd(),'lib/persistence/postgresql/provider.js')+':598:13)';
    const normalized=errors.normalizePersistenceError(input,{operation:'queryAll'});
    assert.equal(normalized.code,'PERSISTENCE_UNKNOWN');assert.equal(normalized.operation,'queryAll');
    assert.equal(errors.normalizePersistenceError(normalized),normalized);
    const known=errors.normalizePersistenceError(new Error('Core development schema contract mismatch'));
    assert.equal(known.code,'PERSISTENCE_UNKNOWN');
    process.stdout.write('ORIGINAL_NORMALIZATION_PRESERVED');
  `;
  const result = spawnSync(process.execPath, ["-e", code], {
    cwd: path.resolve(__dirname, ".."), env: diagnosticEnvironment(), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ORIGINAL_NORMALIZATION_PRESERVED");
  const rows = result.stderr.trim().split("\n").map(line => JSON.parse(line.replace(/^PG_ADAPTER_DIAGNOSTIC /, "")));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].messageKey, null);
  assert.equal(rows[0].messageSha256, crypto.createHash("sha256").update(message).digest("hex"));
  assert.deepEqual(rows[0].frames, [
    { file: "server.js", line: 120, column: 4 },
    { file: "lib/persistence/postgresql/provider.js", line: 598, column: 13 },
  ]);
  assert.equal(rows[1].messageKey, "CORE_SCHEMA_CONTRACT_MISMATCH");
  assert.doesNotMatch(result.stderr, /synthetic-private|password|postgresql:\/\/|SELECT|[A-Z]:\\|\/untrusted\/|\/home\//);
});

test("diagnostic constructor proxy preserves original instance class, subclass, cause and failure semantics", () => {
  const code = `
    const Module=require('node:module'),load=Module._load,assert=require('node:assert/strict');
    Module._load=function(name,...args){return name==='pg'?{Client:class Client{query(){}}}:load.call(this,name,...args);};
    const errors=require('./lib/persistence/errors'),Original=errors.PersistenceError;
    const input=Object.assign(new Error('synthetic-private-driver-cause'),{code:'42501'});
    const baseline=new Original('PERSISTENCE_UNKNOWN',{operation:'queryAll',cause:input});
    require('./test-support/postgresql-api/diagnostic-errors');
    const Observed=errors.PersistenceError;
    assert.notEqual(Observed,Original,'the explicitly diagnostic constructor reference is a proxy');
    const actual=new Observed('PERSISTENCE_UNKNOWN',{operation:'queryAll',cause:input});
    assert.equal(actual.constructor,Original);assert.equal(Object.getPrototypeOf(actual),Original.prototype);
    assert.ok(actual instanceof Original);assert.ok(actual instanceof Observed);assert.ok(actual instanceof Error);
    assert.equal(errors.isPersistenceError(actual),true);assert.equal(Object.isFrozen(actual),true);
    assert.deepEqual(actual.toJSON(),baseline.toJSON());assert.deepEqual(actual.cause,baseline.cause);
    class Derived extends Observed{};const derived=new Derived('PERSISTENCE_UNKNOWN');
    assert.equal(derived.constructor,Derived);assert.ok(derived instanceof Derived);assert.ok(derived instanceof Original);
    const hostile=new Error('not-read');Object.defineProperty(hostile,'message',{get(){throw new Error('synthetic-private-getter');}});
    const expected=new Original('PERSISTENCE_UNKNOWN',{cause:hostile});
    const unchanged=new Observed('PERSISTENCE_UNKNOWN',{cause:hostile});
    assert.deepEqual(unchanged.toJSON(),expected.toJSON());assert.deepEqual(unchanged.cause,expected.cause);
    process.stdout.write('ORIGINAL_INSTANCE_CLASS_AND_CAUSE_PRESERVED');
  `;
  const result = spawnSync(process.execPath, ["-e", code], {
    cwd: path.resolve(__dirname, ".."), env: diagnosticEnvironment(), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ORIGINAL_INSTANCE_CLASS_AND_CAUSE_PRESERVED");
  const rows = result.stderr.trim().split("\n").map(line => JSON.parse(line.replace(/^PG_ADAPTER_DIAGNOSTIC /, "")));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageSha256, crypto.createHash("sha256").update("synthetic-private-driver-cause").digest("hex"));
  assert.doesNotMatch(result.stderr, /synthetic-private|postgresql:\/\/|42501|SELECT/);
});

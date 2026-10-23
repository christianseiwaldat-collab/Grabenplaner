"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

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
  const environment = { ...process.env, GP_PG_API_FIXTURE_BRIDGE: "1", GP_CI_POSTGRESQL_FIXTURE: "github-actions-service-v1",
    GP_PG_API_DIAGNOSTIC: "bounded-errors-v1", CI: "true", GITHUB_ACTIONS: "true",
    TEST_POSTGRESQL_URL: "postgresql://postgres:synthetic-private-password@127.0.0.1:5432/grabenplaner_test" };
  for (const domain of ["core", "sales"]) for (const purpose of ["migrator", "app", "reader"]) {
    environment[`GP_${domain.toUpperCase()}_${purpose.toUpperCase()}_URL`] = `postgresql://gp_${domain}_${purpose}:synthetic-private-password@127.0.0.1:5432/gp_migration_${domain}`;
  }
  delete environment.NODE_OPTIONS;
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

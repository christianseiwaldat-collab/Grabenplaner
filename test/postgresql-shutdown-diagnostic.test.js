"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { observeShutdown } = require("../test-support/postgresql-api/diagnostic-shutdown");
function fixture({ handles = [], resources = [] } = {}) {
  const output = [], scheduled = [], processObject = new EventEmitter();
  processObject.stderr = { write: value => output.push(value) };
  processObject._getActiveHandles = () => handles; processObject.getActiveResourcesInfo = () => resources;
  return { processObject, output, scheduled, schedule(callback, delay) { scheduled.push({ callback, delay }); return { unref() {} }; } };
}
test("shutdown observer preserves original server return, callback receiver/arguments and pool promise identity", async () => {
  const f = fixture(), token = {}, callbackToken = {}, result = Promise.resolve("closed");
  let originalReceiver, originalCallback, callbackReceiver, callbackArguments;
  class Server { close(callback) { originalReceiver = this; originalCallback = callback; return token; } }
  class Pool { end() { return result; } }
  observeShutdown({ http: { Server }, Pool, ...f });
  assert.equal(f.processObject.listenerCount("SIGTERM"), 0, "The observer must preserve default signal ownership");
  const server = new Server(), receiver = {}, error = new Error("test callback");
  assert.equal(server.close(function(...args) { callbackReceiver = this; callbackArguments = args; return callbackToken; }), token);
  assert.equal(originalReceiver, server); assert.equal(originalCallback.call(receiver, error, 7), callbackToken);
  assert.equal(callbackReceiver, receiver); assert.deepEqual(callbackArguments, [error, 7]);
  const pool = new Pool(); assert.equal(pool.end(), result); assert.equal(await result, "closed");
  assert.deepEqual(f.scheduled.map(item => item.delay), [500, 2000, 5000]);
  assert.ok(f.output.some(line => JSON.parse(line).phase === "pool-end-complete"));
});
test("shutdown observer emits bounded resource categories without query, credential, message or unknown name values", async () => {
  const secret = "postgresql://private-person:private-password@private-host/private-db";
  const f = fixture({ handles: [{ constructor: { name: secret }, hasRef: () => secret }], resources: [secret, "MessagePort"] });
  const hostileCode = "EPRIVATE_PASSWORD_TOKEN";
  const failure = Object.assign(new Error(secret), { code: hostileCode }), result = Promise.reject(failure);
  class Server { close(callback) { callback(); return this; } }
  class Pool { end() { return result; } get totalCount() { return secret; } get idleCount() { return 0; } get waitingCount() { return 1; } }
  observeShutdown({ http: { Server }, Pool, ...f });
  assert.equal(new Pool().end(), result); await assert.rejects(result, error => error === failure);
  for (let index = 0; index < 40; index++) new Server().close();
  for (const item of f.scheduled) item.callback();
  f.processObject.emit("SIGTERM"); f.processObject.emit("beforeExit", secret);
  assert.ok(f.output.length > 0 && f.output.length <= 24);
  const text = f.output.join(""); assert.equal(text.includes(secret), false); assert.equal(text.includes(hostileCode), false);
  const first = JSON.parse(f.output[0]); assert.deepEqual(first.resources, ["Other", "MessagePort"]);
  assert.deepEqual(first.handles, [{ kind: "Other", referenced: false }]); assert.equal(first.total, null);
  assert.ok(f.output.some(line => JSON.parse(line).phase === "pool-end-error" && JSON.parse(line).code === null));
});
test("shutdown preload records actual child activation and close phases only with explicit synthetic ownership", () => {
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
    GP_CI_POSTGRESQL_FIXTURE: "github-actions-service-v1", GP_PG_API_FIXTURE_BRIDGE: "1", CI: "true", GITHUB_ACTIONS: "true",
    GP_PG_API_FIXTURE_CHILD_OWNER: "synthetic-only", GP_PG_API_FIXTURE_TEST_FILE: "test/portal-foundation-loopback.test.js",
    GP_PG_API_DIAGNOSTIC: "bounded-errors-v1", TEST_POSTGRESQL_URL: "postgresql://postgres:fixture@127.0.0.1:5432/grabenplaner_test" };
  for (const domain of ["core", "sales"]) for (const purpose of ["migrator", "app", "reader"]) {
    env[`GP_${domain.toUpperCase()}_${purpose.toUpperCase()}_URL`] = `postgresql://gp_${domain}_${purpose}:fixture@127.0.0.1:5432/gp_migration_${domain}`;
  }
  const args = ["--require", path.resolve(__dirname, "../test-support/postgresql-api/diagnostic-shutdown.js"), "-e",
    "const server=require('node:http').createServer().listen(0,'127.0.0.1',()=>server.close());"];
  const active = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 4000 });
  assert.equal(active.status, 0, active.stderr);
  const phases = active.stderr.trim().split("\n").map(line => JSON.parse(line).phase);
  assert.deepEqual(phases, ["observer-installed", "http-close-begin", "http-close-callback", "before-exit", "exit"]);
  delete env.GP_PG_API_FIXTURE_CHILD_OWNER;
  const inactive = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 4000 });
  assert.equal(inactive.status, 0, inactive.stderr); assert.equal(inactive.stderr, "");
});

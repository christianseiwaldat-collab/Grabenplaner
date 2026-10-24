"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
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

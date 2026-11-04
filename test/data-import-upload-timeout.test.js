"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { setTimeout: delay } = require("node:timers/promises");
const Policy = require("../lib/data-import-upload-timeout");
const { registerDataImportRoutes } = require("../lib/data-import-routes");
const { DATA_IMPORT_PERMISSIONS } = require("../lib/data-import-access");
const { createDataImportLifecycle } = require("../lib/data-import-lifecycle");

async function listen(t, handler, options) {
  const server = http.createServer(handler);
  const preserved = { headersTimeout: server.headersTimeout, keepAliveTimeout: server.keepAliveTimeout, timeout: server.timeout };
  Policy.installImportUploadTimeouts(server, options);
  assert.equal(server.requestTimeout, 120 * 60 * 1000);
  for (const [key, value] of Object.entries(preserved)) assert.equal(server[key], value);
  server.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server;
}

function upload(server, { path = "/upload", bytes = 4096, finishAfter = null, headers = {} } = {}) {
  let responseStarted = false, finishTimer;
  const request = http.request({ host: "127.0.0.1", port: server.address().port, path, method: "POST",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": bytes, ...headers } });
  const response = new Promise((resolve, reject) => {
    request.on("error", error => { if (!responseStarted) reject(error); });
    request.once("response", incoming => {
      responseStarted = true;
      clearTimeout(finishTimer);
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", chunk => { body += chunk; });
      incoming.once("end", () => resolve({ status: incoming.statusCode, headers: incoming.headers, body }));
      incoming.once("error", reject);
    });
  });
  request.write(Buffer.alloc(1, 7));
  if (finishAfter !== null) finishTimer = setTimeout(() => request.end(Buffer.alloc(bytes - 1, 7)), finishAfter);
  return { request, response };
}

test("upload minutes accept only bounded integers", () => {
  assert.equal(Policy.DEFAULT_UPLOAD_TIMEOUT_MINUTES, 30);
  assert.equal(Policy.DEFAULT_REQUEST_TIMEOUT_MS, 300000);
  for (const value of [1, 30, 120]) assert.equal(Policy.validateUploadTimeoutMinutes(value), value);
  for (const value of [undefined, null, true, false, "30", "", 0, -1, 121, 2.5, NaN, Infinity, {}, []]) {
    assert.throws(() => Policy.validateUploadTimeoutMinutes(value), { code: "IMPORT_UPLOAD_TIMEOUT_INVALID", status: 400 });
  }
});

test("ordinary incomplete bodies retain their finite receive deadline", { timeout: 5000 }, async t => {
  const server = await listen(t, request => request.resume(), { defaultRequestTimeoutMs: 80, minuteMilliseconds: 80 });
  const result = await upload(server).response;
  assert.equal(result.status, 408);
  assert.equal(JSON.parse(result.body).code, "REQUEST_TIMEOUT");
  assert.equal(result.headers.connection, "close");
});

test("authorized slow upload outlives the ordinary body deadline", { timeout: 5000 }, async t => {
  const server = await listen(t, (request, response) => {
    Policy.armUploadRequest(request, response, 4);
    request.resume();
    request.on("end", () => response.end("accepted"));
  }, { defaultRequestTimeoutMs: 80, minuteMilliseconds: 80 });
  const result = await upload(server, { finishAfter: 180 }).response;
  assert.equal(result.status, 200);
  assert.equal(result.body, "accepted");
});

test("concurrent upload budgets remain independent on the same server", { timeout: 5000 }, async t => {
  const server = await listen(t, (request, response) => {
    Policy.armUploadRequest(request, response, request.url === "/short" ? 1 : 4);
    request.resume();
    request.on("end", () => response.end("accepted"));
  }, { defaultRequestTimeoutMs: 500, minuteMilliseconds: 80 });
  const [short, long] = await Promise.all([
    upload(server, { path: "/short", finishAfter: 180 }).response,
    upload(server, { path: "/long", finishAfter: 180 }).response,
  ]);
  assert.equal(short.status, 408);
  assert.equal(JSON.parse(short.body).code, "IMPORT_UPLOAD_TIMEOUT");
  assert.equal(long.status, 200);
  assert.equal(server.requestTimeout, 120 * 60 * 1000);
});

test("upload deadline includes authorization time instead of restarting after it", { timeout: 5000 }, async t => {
  const server = await listen(t, async (request, response) => {
    await delay(140);
    Policy.armUploadRequest(request, response, 1);
    request.resume();
    request.on("end", () => response.end("accepted"));
  }, { defaultRequestTimeoutMs: 1000, minuteMilliseconds: 200 });
  const result = await upload(server, { finishAfter: 275 }).response;
  assert.equal(result.status, 408);
  assert.equal(JSON.parse(result.body).code, "IMPORT_UPLOAD_TIMEOUT");
});

test("an already elapsed personal deadline stops admission immediately", { timeout: 5000 }, async t => {
  let continued = false;
  const server = await listen(t, async (request, response) => {
    await delay(140);
    assert.throws(() => Policy.armUploadRequest(request, response, 1), { code: "IMPORT_UPLOAD_TIMEOUT", status: 408 });
    continued = true;
  }, { defaultRequestTimeoutMs: 500, minuteMilliseconds: 80 });
  const result = await upload(server).response;
  assert.equal(result.status, 408);
  assert.equal(JSON.parse(result.body).code, "IMPORT_UPLOAD_TIMEOUT");
  assert.equal(continued, true);
});

test("completed request body does not time out during later processing", { timeout: 5000 }, async t => {
  const server = await listen(t, (request, response) => {
    Policy.armUploadRequest(request, response, 1);
    request.resume();
    request.on("end", async () => {
      await delay(180);
      Policy.armUploadRequest(request, response, 1);
      response.end("processed");
    });
  }, { defaultRequestTimeoutMs: 80, minuteMilliseconds: 80 });
  const result = await upload(server, { finishAfter: 0 }).response;
  assert.equal(result.status, 200);
  assert.equal(result.body, "processed");
});

async function importFixture(t, { processingDelay = 0 } = {}) {
  const app = express(), lifecycle = createDataImportLifecycle();
  const session = { employeeNumber: "synthetic", accountId: "synthetic-account",
    permissions: [...Object.values(DATA_IMPORT_PERMISSIONS), "sales:analytics:access", "sales:analytics:company:read"] };
  const state = { held: false, admitted: 0, released: 0, enqueued: 0 };
  let released, admitted;
  const firstRelease = new Promise(resolve => { released = resolve; });
  const firstAdmission = new Promise(resolve => { admitted = resolve; });
  const jobs = {
    beginUpload() {
      assert.equal(state.held, false);
      state.held = true; state.admitted++; admitted();
      return () => { state.held = false; state.released++; released(); };
    },
    async enqueue(_get, input) {
      assert.equal(input.buffer.length, 4096);
      assert.equal(state.held, true);
      await delay(processingDelay);
      state.enqueued++;
      return { id: "a".repeat(64), status: "queued", background: { status: "queued" } };
    },
  };
  const routes = registerDataImportRoutes(app, {
    runtime: { context: async () => ({ available: true }) }, jobs, lifecycle,
    preferences: { get: async () => ({ value: JSON.stringify({ uploadTimeoutMinutes: 1 }) }) },
    requireSession: () => session, refreshSession: async () => session, assertCsrf() {}, onBackgroundError() {},
  });
  const server = await listen(t, app, { defaultRequestTimeoutMs: 500, minuteMilliseconds: 80 });
  t.after(() => routes.stop());
  return { server, state, lifecycle, firstRelease, firstAdmission };
}

test("real import timeout aborts parsing and frees admission for the next upload", { timeout: 5000 }, async t => {
  const f = await importFixture(t);
  const timedOut = await upload(f.server, { path: "/api/data-import/upload/cash" }).response;
  assert.equal(timedOut.status, 408);
  assert.equal(JSON.parse(timedOut.body).code, "IMPORT_UPLOAD_TIMEOUT");
  await f.firstRelease;
  assert.equal(f.state.held, false);
  assert.equal(f.state.enqueued, 0);
  assert.equal(f.lifecycle.active, 0);
  const next = await upload(f.server, { path: "/api/data-import/upload/cash", finishAfter: 0 }).response;
  assert.equal(next.status, 202);
  assert.equal(f.state.enqueued, 1);
  assert.equal(f.state.admitted, 2);
  assert.equal(f.state.released, 2);
});

test("real import may stage a fully received file beyond its upload deadline", { timeout: 5000 }, async t => {
  const f = await importFixture(t, { processingDelay: 180 });
  const result = await upload(f.server, { path: "/api/data-import/upload/cash", finishAfter: 0 }).response;
  assert.equal(result.status, 202);
  assert.equal(f.state.enqueued, 1);
  assert.equal(f.state.released, 1);
});

test("client cancellation frees the real import gate without waiting for its deadline", { timeout: 5000 }, async t => {
  const f = await importFixture(t);
  const cancelled = upload(f.server, { path: "/api/data-import/upload/cash" });
  const rejected = cancelled.response.catch(error => error);
  await f.firstAdmission;
  cancelled.request.destroy(new Error("Synthetic client cancellation"));
  assert.match((await rejected).message, /Synthetic client cancellation/);
  await f.firstRelease;
  assert.equal(f.state.held, false);
  assert.equal(f.state.enqueued, 0);
  assert.equal(f.lifecycle.active, 0);
  const next = await upload(f.server, { path: "/api/data-import/upload/cash", finishAfter: 0 }).response;
  assert.equal(next.status, 202);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const handler = source.slice(source.indexOf("app.use(async (error, request, response, _next) => {"));
const statement = handler.match(/^  if \(status >= 500\) console\.error\([^\n]+\);$/m)?.[0];
assert.ok(statement, "the actual final error handler must contain its server-error log statement");
const log = vm.compileFunction(statement, ["status", "requestId", "request", "error", "console"]);

test("server error logs preserve percent-containing request paths as data and retain the original error", () => {
  const request = { method: "GET", path: "/synthetic/%c/%j/%s/%o/%O/%d/%i/%f/%%" };
  const error = new Error("synthetic diagnostic sentinel");
  const calls = [];
  log(500, "synthetic-request-id", request, error, { error: (...args) => calls.push(args) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "[%s] %s %s");
  assert.strictEqual(calls[0].at(-1), error);
  const rendered = util.format(...calls[0]);
  assert.ok(rendered.startsWith("[synthetic-request-id] GET " + request.path + " "));
  assert.ok(rendered.includes(error.stack), "the original error and stack must remain available");
  assert.equal(util.format("[synthetic-request-id] GET /%c", error), "[synthetic-request-id] GET /",
    "the negative control demonstrates that the former dynamic format consumed the error");
});

test("client errors keep the existing no-server-error-log behavior", () => {
  for (const status of [400, 401, 403, 404, 409, 499]) {
    log(status, "synthetic-request-id", { method: "GET", path: "/%c" }, new Error("unused"), {
      error() { assert.fail("client errors must not enter the server-error logger"); },
    });
  }
});

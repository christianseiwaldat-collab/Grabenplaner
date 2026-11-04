"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");

// The explicit graph override is used only by the private before/after package
// qualification; the normal CI run tests its installed application graph.
const graphRoot = path.resolve(process.env.GP_BODY_PARSER_TEST_ROOT || path.join(__dirname, ".."));
const fixture = path.join(__dirname, "../test-support/body-parser-security-child.cjs");

async function childServer(t) {
  const child = spawn(process.execPath, ["--no-global-search-paths", fixture, graphRoot], {
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  let output = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("parser fixture did not listen")); }, 10000);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`parser fixture exited ${code}: ${stderr}`)); });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes("\n")) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(output.slice(0, output.indexOf("\n"))).port); } catch (error) { reject(error); }
    });
  });
  return { child, port, stderr: () => stderr };
}

function request(port, route, bytes, headers = {}, method = "POST") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: route, headers: {
      "Content-Length": bytes.length, ...headers,
    } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.once("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      res.once("error", reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error("parser fixture request timed out")));
    req.once("error", reject);
    req.end(bytes);
  });
}

async function healthy(subject) {
  await delay(250); // The decoder error in CVE-2026-111181 arrives after parsing.
  assert.equal(subject.child.exitCode, null, subject.stderr());
  assert.deepEqual(await request(subject.port, "/health", Buffer.alloc(0), {}, "GET"), { status: 200, body: { ok: true } });
}

test("body-parser: trailing gzip bytes cannot terminate the unauthenticated parser process", async (t) => {
  const subject = await childServer(t);
  // Same compressed frame / zero byte / trailing 100 KiB structure as the
  // upstream v2.4.0 regression test, confined to this synthetic child process.
  const payload = Buffer.concat([zlib.gzipSync(Buffer.from('{"a":1}')), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
  assert.deepEqual(await request(subject.port, "/json", payload, {
    "Content-Type": "application/json", "Content-Encoding": "gzip",
  }), { status: 200, body: { a: 1 } });
  await healthy(subject);
});

test("body-parser: rejected charset plus trailing compressed bytes stays a bounded error", async (t) => {
  const subject = await childServer(t);
  const payload = Buffer.concat([zlib.gzipSync(Buffer.from('{"a":1}')), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
  assert.deepEqual(await request(subject.port, "/json", payload, {
    "Content-Type": "application/json; charset=utf-999", "Content-Encoding": "gzip",
  }), { status: 415, body: { code: "charset.unsupported" } });
  await healthy(subject);
});

test("body-parser: Express parser APIs preserve successful JSON, raw, text and form requests", async (t) => {
  const subject = await childServer(t);
  for (const [route, bytes, type, expected] of [
    ["json", Buffer.from('{"a":1}'), "application/json", { a: 1 }],
    ["raw", Buffer.from([0, 128, 255]), "application/octet-stream", { hex: "0080ff" }],
    ["text", Buffer.from("parser compatibility"), "text/plain", "parser compatibility"],
    ["urlencoded", Buffer.from("name=Ada&role=reader"), "application/x-www-form-urlencoded", { name: "Ada", role: "reader" }],
  ]) {
    assert.deepEqual(await request(subject.port, `/${route}`, bytes, { "Content-Type": type }), { status: 200, body: expected });
  }
  assert.deepEqual(await request(subject.port, "/json", zlib.deflateSync(Buffer.from('{"compressed":true}')), {
    "Content-Type": "application/json", "Content-Encoding": "deflate",
  }), { status: 200, body: { compressed: true } });
  await healthy(subject);
});

test("body-parser: invalid compression and body limit reject requests while health remains available", async (t) => {
  const subject = await childServer(t);
  const invalid = await request(subject.port, "/json", Buffer.from("not a gzip frame"), {
    "Content-Type": "application/json", "Content-Encoding": "gzip",
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await request(subject.port, "/json", Buffer.from(JSON.stringify({ value: "x".repeat(2048) })), {
    "Content-Type": "application/json",
  }), { status: 413, body: { code: "entity.too.large" } });
  await healthy(subject);
});

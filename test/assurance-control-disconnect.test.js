"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { Writable } = require("node:stream");
const test = require("node:test");
const modulePath = path.resolve(__dirname, "../server-tools/linux/offsite/lib/assurance-control-broker.js");
const { writeResponse } = require(modulePath);

test("broker delivers one unchanged newline-delimited response", async () => {
  const chunks = [];
  const output = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback(); } });
  const result = { code: "ASSURANCE_CONTROL_READY", accepted: false };
  assert.equal(await writeResponse(output, result), true);
  assert.equal(Buffer.concat(chunks).toString(), `${JSON.stringify(result)}\n`);
  assert.equal(output.listenerCount("error"), 0);
});

test("broker handles an asynchronous EPIPE without retrying the response", async () => {
  let writes = 0;
  const output = new Writable({ write(chunk, encoding, callback) {
    writes += 1;
    setImmediate(() => callback(Object.assign(new Error("closed peer"), { code: "EPIPE" })));
  } });
  assert.equal(await writeResponse(output, { accepted: true }), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1);
});

test("broker preserves unexpected output failures", async () => {
  const output = new Writable({ write(chunk, encoding, callback) {
    setImmediate(() => callback(Object.assign(new Error("I/O failure"), { code: "EIO" })));
  } });
  await assert.rejects(writeResponse(output, {}), { code: "EIO" });
  await new Promise(resolve => setImmediate(resolve));
});

test("Linux broker survives a real closed response pipe", { skip: process.platform !== "linux" }, async () => {
  const child = spawn(process.execPath, ["-e", `
    const { writeResponse } = require(process.argv[1]);
    process.send('ready');
    process.on('message', async () => {
      try {
        const delivered = await writeResponse(process.stdout, { accepted: true });
        process.send({ delivered });
        process.disconnect();
      } catch { process.exitCode = 1; process.disconnect(); }
    });
  `, modulePath], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "", result;
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal })); });
  child.on("message", message => {
    if (message === "ready") { child.stdout.destroy(); child.send("write"); }
    else result = message;
  });
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.deepEqual(result, { delivered: false });
  assert.equal(stderr, "");
});

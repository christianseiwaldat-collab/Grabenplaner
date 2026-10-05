"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {EventEmitter} = require("node:events");
const {spawn, execFile} = require("node:child_process");
const {createUpdateRequestLifecycle} = require("../lib/update-request-lifecycle");
const {executeUpdateCommand} = require("../lib/update-command");
const {completeProcessShutdown} = require("../lib/complete-process-shutdown");
const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
function serverFunction(name, next, dependencies) {
  const index = source.indexOf(`function ${name}(`);
  const start = source.slice(index - 6, index) === "async " ? index - 6 : index;
  return vm.runInNewContext(`${source.slice(start, source.indexOf(next, index))}; ${name}`, dependencies);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
const nextTurn = () => new Promise(setImmediate);

test("update shutdown aborts immediately, rejects admission and drains until the owned callback settles", async () => {
  const lifecycle = createUpdateRequestLifecycle();
  const work = deferred();
  let signal, drained = false;
  const job = lifecycle.run(value => {signal = value; return work.promise;});
  await nextTurn();
  const closing = lifecycle.close();
  closing.then(() => {drained = true;});
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.code, "UPDATE_REQUESTS_CLOSED");
  assert.equal(lifecycle.close(), closing);
  await assert.rejects(lifecycle.run(() => assert.fail("new request started")), {code: "UPDATE_REQUESTS_CLOSED"});
  await nextTurn();
  assert.equal(drained, false);
  work.resolve("finished");
  assert.equal(await job, "finished");
  await closing;
  assert.equal(drained, true);
});

test("shutdown prevents a queued update from starting, and timeout covers the complete body read", async t => {
  const stopped = createUpdateRequestLifecycle();
  const queued = stopped.run(() => assert.fail("queued update entered after close"));
  const closing = stopped.close();
  await assert.rejects(queued, {code: "UPDATE_REQUESTS_CLOSED"});
  await closing;
  t.mock.timers.enable({apis: ["setTimeout"]});
  const lifecycle = createUpdateRequestLifecycle({timeoutMs: 100});
  let signal;
  const job = lifecycle.run(value => {
    signal = value;
    return new Promise((resolve, reject) => value.addEventListener("abort", () => reject(value.reason), {once: true}));
  });
  await Promise.resolve();
  t.mock.timers.tick(99);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(job, {code: "UPDATE_REQUEST_TIMEOUT"});
  const completed = lifecycle.run(value => {signal = value; return "success";});
  assert.equal(await completed, "success");
  t.mock.timers.tick(1000);
  assert.equal(signal.aborted, false, "the completed request's deadline must be cleared");
  await lifecycle.close();
});

test("the release fetch owns response consumption and cancels a failed HTTP response body", async () => {
  const lifecycle = createUpdateRequestLifecycle();
  let signal, cancelled = false;
  const body = deferred();
  const dependencies = {
    updateRequestLifecycle: lifecycle, configureSystemCertificateAuthorities() {}, APP_NAME: "fixture",
    packageMetadata: {version: "1"}, GITHUB_REPO: "synthetic/repository", process: {env: {}},
    selectLatestRelease: releases => releases[0],
    fetch: async (url, options) => {signal = options.signal; return {ok: true, json: () => body.promise};},
  };
  const fetchRelease = serverFunction("latestReleaseViaFetch", "async function latestReleaseViaGh", dependencies);
  const result = fetchRelease();
  await nextTurn();
  let drained = false;
  const closing = lifecycle.close().then(() => {drained = true;});
  await nextTurn();
  assert.equal(signal.aborted, true);
  assert.equal(drained, false);
  body.reject(signal.reason);
  await assert.rejects(result, {code: "UPDATE_REQUESTS_CLOSED"});
  await closing;
  dependencies.updateRequestLifecycle = createUpdateRequestLifecycle();
  dependencies.fetch = async () => ({ok: false, status: 404, body: {cancel: async () => {cancelled = true;}}});
  await assert.rejects(fetchRelease(), /release not found/);
  assert.equal(cancelled, true);
  await dependencies.updateRequestLifecycle.close();
});

test("shutdown prevents GitHub CLI fallback and all later release checks; ordinary failures retain fallback", async () => {
  const lifecycle = createUpdateRequestLifecycle(), pending = deferred();
  let fetches = 0, fallbacks = 0;
  const dependencies = {
    updateRequestLifecycle: lifecycle,
    latestReleaseViaFetch: () => {fetches++; return lifecycle.run(signal => {
      pending.resolve();
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
    });},
    latestReleaseViaGh: async () => {fallbacks++; return {source: "gh"};},
  };
  const get = serverFunction("getLatestReleaseInfo", "async function resolveUpdateStatus", dependencies);
  const request = get();
  await pending.promise;
  await lifecycle.close();
  await assert.rejects(request, {code: "UPDATE_REQUESTS_CLOSED"});
  await assert.rejects(get(), /Dienststopps/);
  assert.equal(fetches, 1);
  assert.equal(fallbacks, 0);
  dependencies.updateRequestLifecycle = createUpdateRequestLifecycle();
  dependencies.latestReleaseViaFetch = async () => {throw new Error("network unavailable");};
  assert.equal((await get()).source, "gh");
  assert.equal(fallbacks, 1);
  await dependencies.updateRequestLifecycle.close();
});

test("CLI abort waits for child close even if execFile's callback rejects first", async () => {
  const lifecycle = createUpdateRequestLifecycle(), child = new EventEmitter();
  let options, callback, settled = false;
  const job = lifecycle.run(signal => executeUpdateCommand("synthetic-gh", ["release", "list"], {
    signal, execute: (command, args, configuration, done) => {options = configuration; callback = done; return child;},
  }));
  const checked = assert.rejects(job, {code: "UPDATE_REQUESTS_CLOSED"});
  await nextTurn();
  const closing = lifecycle.close().then(() => {settled = true;});
  assert.equal(options.signal.aborted, true);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 15000);
  callback(Object.assign(new Error("aborted"), {code: "ABORT_ERR"}));
  await nextTurn();
  assert.equal(settled, false, "an AbortError is not proof of subprocess termination");
  child.emit("close", null, "SIGTERM");
  await checked;
  await closing;
});

test("CLI release list cancellation never starts a release view or another executable probe", async () => {
  const lifecycle = createUpdateRequestLifecycle();
  let commands = 0;
  const entered = deferred();
  const dependencies = {
    updateRequestLifecycle: lifecycle, GITHUB_REPO: "synthetic/repository",
    findGhExecutable: async () => "synthetic-gh",
    executeUpdateCommand: (command, args, {signal}) => {
      commands++;
      entered.resolve();
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
    },
  };
  const get = serverFunction("latestReleaseViaGh", "async function getLatestReleaseInfo", dependencies);
  const result = get();
  await entered.promise;
  await lifecycle.close();
  await assert.rejects(result, {code: "UPDATE_REQUESTS_CLOSED"});
  assert.equal(commands, 1);
  await assert.rejects(get(), {code: "UPDATE_REQUESTS_CLOSED"});
  assert.equal(commands, 1);
});

test("shutdown prohibits new health synchronization and new update status requests", async () => {
  const dependencies = {serverModeActive: true, shutdownStarted: true,
    systemCenterTechnicalCache: {read: () => assert.fail("new health work")}};
  const synchronize = serverFunction("synchronizeSystemCenterHealth", "async function systemCenterPayload", dependencies);
  assert.equal(await synchronize(), null);
  const status = serverFunction("systemCenterUpdateStatus", "const databaseSizeHistory", {
    updateRequestLifecycle: {closed: true}, redactedSystemCenterUpdateFailure: () => ({ok: false}),
  });
  assert.equal((await status()).ok, false);
});

test("clean shutdown sets exitCode and retains only an unref 45-second last-resort deadline", () => {
  const calls = [];
  const processObject = {exit: code => calls.push(code)};
  let deadline;
  completeProcessShutdown(7, {processObject, schedule: (callback, milliseconds) => {
    assert.equal(milliseconds, 45000);
    deadline = callback;
    return {unref: () => calls.push("unref")};
  }});
  assert.equal(processObject.exitCode, 7);
  assert.deepEqual(calls, ["unref"], "normal shutdown must allow native close callbacks instead of calling process.exit");
  deadline();
  assert.deepEqual(calls, ["unref", 7]);
});

test("native update CLI commands settle only after termination, including bounded timeout", async () => {
  assert.equal(await executeUpdateCommand(process.execPath, ["-e", "process.stdout.write('synthetic')"]), "synthetic");
  await assert.rejects(executeUpdateCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {timeout: 100}),
    error => error.killed === true || error.signal === "SIGTERM");
  await assert.rejects(executeUpdateCommand(path.join(__dirname, "nonexistent-update-program"), []), {code: "ENOENT"});
});

test("native shutdown aborts an already spawned update subprocess and drains its close", async () => {
  const lifecycle = createUpdateRequestLifecycle(), entered = deferred();
  let child, closed = false;
  const job = lifecycle.run(signal => executeUpdateCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    signal, execute: (...args) => {
      child = execFile(...args);
      child.once("spawn", entered.resolve);
      child.once("close", () => {closed = true;});
      return child;
    },
  }));
  const checked = assert.rejects(job, {code: "UPDATE_REQUESTS_CLOSED"});
  await entered.promise;
  await lifecycle.close();
  await checked;
  assert.equal(closed, true);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
});

test("native fetch shutdown aborts a partial local response, drains and exits naturally", {timeout: 10000}, async () => {
  const lifecyclePath = require.resolve("../lib/update-request-lifecycle");
  const shutdownPath = require.resolve("../lib/complete-process-shutdown");
  const script = `
    const http=require('node:http');
    const {createUpdateRequestLifecycle}=require(${JSON.stringify(lifecyclePath)});
    const {completeProcessShutdown}=require(${JSON.stringify(shutdownPath)});
    const lifecycle=createUpdateRequestLifecycle();
    const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/plain'});res.write('partial');});
    server.listen(0,'127.0.0.1',async()=>{
      try {
        let entered; const headers=new Promise(resolve=>{entered=resolve;});
        const work=lifecycle.run(async signal=>{
          const response=await fetch('http://127.0.0.1:'+server.address().port,{signal});
          entered(); return response.text();
        }).then(()=>{throw new Error('partial body unexpectedly finished');},error=>{
          if(error.code!=='UPDATE_REQUESTS_CLOSED' && error.name!=='AbortError') throw error;
        });
        await headers; await lifecycle.close(); await work;
        const closing=new Promise(resolve=>server.close(resolve));
        server.closeAllConnections(); await closing;
        const nativeExit=process.exit.bind(process);
        process.exit=()=>{process.stderr.write('FORCED_EXIT');nativeExit(2);};
        completeProcessShutdown(0,{maximumWaitMs:1500});
        process.stdout.write('DRAINED');
      } catch(error) {console.error(error);process.exitCode=1;server.closeAllConnections();server.close();}
    });`;
  const child = spawn(process.execPath, ["-e", script], {windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
  let stdout = "", stderr = "";
  child.stdout.on("data", value => {stdout += value;});
  child.stderr.on("data", value => {stderr += value;});
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {child.kill(); reject(new Error(`Native fetch shutdown deadline exceeded: ${stderr}`));}, 8000);
    child.once("error", error => {clearTimeout(timeout); reject(error);});
    child.once("close", (code, signal) => {clearTimeout(timeout); resolve({code, signal});});
  });
  assert.equal(result.code, 0, stderr);
  assert.equal(result.signal, null);
  assert.equal(stdout, "DRAINED");
  assert.doesNotMatch(stderr, /FORCED_EXIT|Assertion failed/);
});

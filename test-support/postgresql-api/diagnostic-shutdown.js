"use strict";

// Explicit diagnostic workflow only. Observe the original child shutdown;
// never alter close return values, process deadlines, workers or pool ownership.
function observeShutdown({ http, Pool, processObject = process, schedule = setTimeout }) {
  let emitted = 0, nextPool = 0;
  const pools = new WeakMap();
  const handleKinds = new Set(["Server", "Socket", "MessagePort", "Worker", "Pipe", "TCP", "Timeout", "TLSSocket", "WriteStream", "ReadStream"]);
  const resourceKinds = new Set(["PipeWrap", "TCPServerWrap", "TCPSocketWrap", "Timeout", "Immediate", "MessagePort", "FSReqCallback", "FSEventWrap", "TTYWrap", "ShutdownWrap"]);
  const errorCodes = new Set(["08000", "08001", "08003", "08004", "08006", "08007", "08P01", "25P02", "40001", "40P01", "53300", "55000", "55006", "57014", "57P01", "57P02", "57P03", "XX000", "EPIPE", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ERR_STREAM_DESTROYED"]);
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  function report(phase, detail = {}) {
    if (emitted++ >= 24) return;
    try {
      const handles = processObject._getActiveHandles().map(handle => ({
        kind: handleKinds.has(handle?.constructor?.name) ? handle.constructor.name : "Other",
        referenced: typeof handle.hasRef === "function" ? handle.hasRef() === true : null,
      }));
      processObject.stderr.write(JSON.stringify({ diagnosticOnly: true, diagnostic: "postgresql-child-drain-v1", phase,
        resources: processObject.getActiveResourcesInfo().map(value => resourceKinds.has(value) ? value : "Other"), handles, ...detail }) + "\n");
    } catch { /* Diagnostic output must never interrupt an original drain. */ }
  }
  const close = http.Server.prototype.close;
  http.Server.prototype.close = function(...args) {
    report("http-close-begin");
    for (const delay of [500, 2000, 5000]) schedule(() => report("http-close-pending", { delayMilliseconds: delay }), delay).unref();
    const callback = typeof args.at(-1) === "function" ? args.pop() : null;
    args.push(function(...values) {
      report("http-close-callback");
      return callback?.apply(this, values);
    });
    return close.apply(this, args);
  };
  const end = Pool.prototype.end;
  Pool.prototype.end = function(...args) {
    if (!pools.has(this)) pools.set(this, ++nextPool);
    const detail = { pool: pools.get(this), total: count(this.totalCount), idle: count(this.idleCount), waiting: count(this.waitingCount) };
    report("pool-end-begin", detail);
    const result = end.apply(this, args);
    result?.then(() => report("pool-end-complete", detail), error => report("pool-end-error", { ...detail,
      code: errorCodes.has(error?.code) ? error.code : null }));
    return result;
  };
  processObject.on("beforeExit", code => report("before-exit", { code: count(code) }));
  processObject.on("exit", code => report("exit", { code: count(code) }));
  return () => report("observer-installed");
}
function install() {
  if (!process.env.GP_PG_API_FIXTURE_CHILD_OWNER
      || process.env.GP_PG_API_FIXTURE_TEST_FILE !== "test/portal-foundation-loopback.test.js") return;
  require("./guard").assertSyntheticEnvironment();
  if (process.env.GP_PG_API_DIAGNOSTIC !== "bounded-errors-v1") throw new Error("PG_DRAIN_DIAGNOSTIC_NOT_ENABLED");
  observeShutdown({ http: require("node:http"), Pool: require("pg").Pool })();
}
install();
module.exports = { observeShutdown };

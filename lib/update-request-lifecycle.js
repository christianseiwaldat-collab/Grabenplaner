"use strict";

function stoppedError(code = "UPDATE_REQUESTS_CLOSED") {
  return Object.assign(new Error("Die Update-Abfrage wurde beendet."), {code});
}

// Own the complete request, including consumption/cancellation of its body.
// A timed-out status response must not leave an untracked network operation.
function createUpdateRequestLifecycle({timeoutMs = 15000} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError("Invalid update timeout");
  const pending = new Set();
  let closed = false, closing = null;
  function run(work) {
    if (closed) return Promise.reject(stoppedError());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(stoppedError("UPDATE_REQUEST_TIMEOUT")), timeoutMs);
    timer.unref?.();
    const job = {controller, promise: null};
    pending.add(job);
    job.promise = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    }).finally(() => {clearTimeout(timer); pending.delete(job);});
    return job.promise;
  }
  function close() {
    if (closing) return closing;
    closed = true;
    for (const job of pending) job.controller.abort(stoppedError());
    closing = Promise.allSettled([...pending].map(job => job.promise)).then(() => {});
    return closing;
  }
  return Object.freeze({run, close, get closed() {return closed;}});
}

module.exports = {createUpdateRequestLifecycle};

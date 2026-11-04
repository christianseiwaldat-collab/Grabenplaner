"use strict";

// The plan and process definitions are the durable input. This worker only
// coalesces refresh signals; startup and the periodic sweep derive them again.
function createPlanningDerivedRefresh({ work, onError = () => {},
  schedule = setImmediate, cancel = clearImmediate }) {
  let pending = false;
  let scheduled = null;
  let active = null;
  let closed = false;

  function start() {
    if (scheduled !== null) { cancel(scheduled); scheduled = null; }
    if (active) return active;
    active = Promise.resolve().then(async () => {
      while (pending) {
        pending = false;
        try { await work(); } catch (error) {
          // A later signal/periodic sweep retries the persisted state.
          try { onError(error); } catch { /* Logging cannot abandon the drain. */ }
        }
      }
    }).finally(() => {
      active = null;
      if (pending && !closed) scheduleDrain();
    });
    return active;
  }

  function scheduleDrain() {
    if (scheduled === null && !active) scheduled = schedule(() => {
      scheduled = null;
      void start();
    });
  }

  function request() {
    if (closed) return false;
    pending = true;
    scheduleDrain();
    return true;
  }

  function run() {
    if (closed) return active || Promise.resolve();
    pending = true;
    return start();
  }

  async function close() {
    closed = true;
    if (scheduled !== null) { cancel(scheduled); scheduled = null; }
    while (active || pending) await start();
  }

  return Object.freeze({ request, run, close });
}

module.exports = { createPlanningDerivedRefresh };

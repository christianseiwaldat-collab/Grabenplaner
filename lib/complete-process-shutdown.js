"use strict";

function completeProcessShutdown(exitCode, {
  processObject = process,
  schedule = setTimeout,
  maximumWaitMs = 45000,
} = {}) {
  // Let pending native close callbacks finish. An immediate process.exit()
  // can race Windows/libuv's teardown after an aborted/completed fetch.
  processObject.exitCode = exitCode;
  // This timer never keeps a drained process alive, but preserves a bounded
  // stop if an unexpected referenced resource remains after the owned drains.
  const deadline = schedule(() => processObject.exit(exitCode), maximumWaitMs);
  deadline.unref();
}

module.exports = {completeProcessShutdown};

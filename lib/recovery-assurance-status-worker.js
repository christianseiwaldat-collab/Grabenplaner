"use strict";

const { parentPort, isMainThread } = require("node:worker_threads");
if (isMainThread || !parentPort) throw new Error("Recovery assurance worker requires a worker thread");

// The Linux helper changes this thread's scheduling priority and checks that
// the web server's main thread keeps its original priority.
require("./persistence/postgresql/reporting/worker-priority").lowerCurrentWorkerPriority();
const { readRecoveryAssuranceStatus } = require("./recovery-assurance-status");

parentPort.on("message", ({ id, options }) => {
  const result = readRecoveryAssuranceStatus(options);
  parentPort.postMessage({ id, result });
});

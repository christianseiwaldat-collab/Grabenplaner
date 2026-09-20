'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { reportWorkerPhase, classifyReportWorkerError, sanitizeReportWorkerDiagnostic } = require('./report-worker-diagnostics');

// One worker/connection for the queue. Expensive synchronous SQLite, validation,
// encryption and PDF work cannot occupy the web server's event loop.
function createSalesReportBatchWorker({ databasePath, keyConfiguration, scopeId = 'grabenplaner-main', today,
  workerFile = path.join(__dirname, 'sales-report-worker.js'), timeoutMs = 120000, workerConfiguration = null }) {
  let worker = null, pending = null, stopped = false, sequence = 0;
  const failure = (code, diagnostic) => {
    const error = Object.assign(new Error(code), { code, status: 503 });
    const safe = sanitizeReportWorkerDiagnostic(diagnostic);
    if (safe) Object.defineProperty(error, 'reportWorkerDiagnostic', { value: safe });
    return error;
  };
  function finish(error, result) {
    if (!pending) return;
    const { resolve, reject, timeout } = pending; pending = null; clearTimeout(timeout);
    if (error) reject(error); else resolve(result);
  }
  function getWorker() {
    if (worker) return worker;
    const next = new Worker(workerFile, { workerData: { databasePath, keyConfiguration, scopeId, today, workerConfiguration },
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 }, stdout: true, stderr: true });
    worker = next;
    next.stdout.resume(); next.stderr.resume();
    let startupPhase = 'worker-load';
    const fail = error => {
      if (worker !== next) return;
      worker = null; finish(failure('IMPORT_REPORT_WORKER_FAILED',
        classifyReportWorkerError(typeof error === 'object' ? error : { code: 'IMPORT_REPORT_WORKER_FAILED' }, startupPhase))); void next.terminate();
    };
    next.on('error', fail); next.on('exit', fail);
    next.on('message', message => {
      if (worker !== next || !message || typeof message !== 'object') return;
      if (message.event === 'worker-startup-phase') {
        const phase = reportWorkerPhase(message.phase); if (phase) startupPhase = phase;
        return;
      }
      if (!pending || message.id !== pending.id) return;
      const code = /^(IMPORT_|BRANCH_RECEIPT_)[A-Z_]+$/.test(message.error || '') ? message.error : 'IMPORT_REPORT_FAILED';
      const error = message.error ? failure(code, message.diagnostic) : null;
      if (error && [400, 403, 404, 409, 413, 422, 503].includes(message.status)) error.status = message.status;
      finish(error, message.result);
    });
    next.reportDiagnostic = code => classifyReportWorkerError({ code }, startupPhase);
    next.unref(); return next;
  }
  return Object.freeze({
    run(input) {
      if (stopped) return Promise.reject(failure('IMPORT_REPORT_WORKER_FAILED'));
      if (pending) return Promise.reject(failure('IMPORT_HISTORY_ANALYSIS_BUSY'));
      const active = getWorker(), id = ++sequence;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (worker === active) worker = null;
          finish(failure('IMPORT_REPORT_WORKER_TIMEOUT', active.reportDiagnostic('IMPORT_REPORT_WORKER_TIMEOUT'))); void active.terminate();
        }, timeoutMs);
        pending = { id, resolve, reject, timeout };
        try { active.postMessage({ id, input }); } catch { finish(failure('IMPORT_REPORT_WORKER_FAILED')); }
      });
    },
    async stop() {
      stopped = true; const active = worker; worker = null;
      finish(failure('IMPORT_REPORT_WORKER_FAILED'));
      if (active) await active.terminate();
    },
  });
}
module.exports = { createSalesReportBatchWorker };

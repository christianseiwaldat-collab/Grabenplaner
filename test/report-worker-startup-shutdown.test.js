'use strict';
const { isMainThread, parentPort, workerData, Worker } = require('node:worker_threads');

if (!isMainThread) {
  // Real threads hold an initialization request until the production client
  // stops them. No database, application listener or system service is used.
  const state = new Int32Array(workerData.workerConfiguration.readySignal);
  parentPort.on('message', () => {
    Atomics.add(state, 0, 1);
    if (workerData.workerConfiguration.scenario === 'worker-failure') {
      throw Object.assign(new Error('Synthetic worker initialization failure'), { code: 'MODULE_NOT_FOUND' });
    }
  });
} else if (process.argv[2] === '--startup-child') {
  childFixture(process.argv[3]);
} else {
  const test = require('node:test'), assert = require('node:assert/strict');
  const { fork } = require('node:child_process');

  async function run(t, scenario, signalDelivery = null) {
    const child = fork(__filename, ['--startup-child', scenario], {
      execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const events = []; let stderr = '', stdout = '', exited = false;
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => { exited = true; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    t.after(async () => {
      if (!exited) child.kill('SIGKILL');
      await done;
    });
    let delivered = false;
    child.on('message', message => {
      events.push(message);
      if (message.event === 'startup-pending' && signalDelivery && !delivered) {
        delivered = true;
        if (signalDelivery === 'native') child.kill('SIGTERM');
        else child.send({ event: 'dispatch-sigterm-listener' });
      }
    });
    const result = await done;
    return { ...result, events, stderr, stdout, delivered };
  }

  function assertOrder(result) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.delivered, true);
    assert.doesNotMatch(result.stderr, /IMPORT_REPORT_WORKER_(?:FAILED|STOPPED)|Error:/);
    const phases = result.events.map(row => row.event);
    assert.ok(phases.includes('startup-pending'));
    assert.ok(phases.includes('sigterm-observed'));
    assert.ok(phases.indexOf('workers-terminated') < phases.indexOf('persistence-closed'));
    assert.ok(phases.indexOf('persistence-closed') < phases.indexOf('instance-released'));
    assert.equal(phases.includes('listener-started'), false);
    const complete = result.events.find(row => row.event === 'shutdown-complete');
    assert.equal(complete.liveWorkers, 0);
    assert.equal(complete.workerCount, 3);
  }

  test('pending startup workers: SIGTERM listener cancels startup and drains real threads', { timeout: 30000 }, async t => {
    // Windows does not deliver POSIX SIGTERM to a Node listener. This portable
    // case dispatches that listener explicitly; the next case uses the OS.
    assertOrder(await run(t, 'hold', 'listener'));
  });
  test('pending startup workers: actual POSIX SIGTERM exits cleanly without starting an HTTP listener', {
    timeout: 30000, skip: process.platform === 'win32' ? 'Windows has no POSIX SIGTERM delivery; native Linux CI exercises this case' : false,
  }, async t => {
    assertOrder(await run(t, 'hold', 'native'));
  });
  test('a real startup worker failure remains fatal', { timeout: 30000 }, async t => {
    const result = await run(t, 'worker-failure');
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /IMPORT_REPORT_WORKER_FAILED/);
    assert.equal(result.events.some(row => row.event === 'shutdown-complete'), false);
  });
  test('the stopped code without an active shutdown remains fatal', { timeout: 30000 }, async t => {
    const result = await run(t, 'stopped-without-shutdown');
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /IMPORT_REPORT_WORKER_STOPPED/);
  });
  test('an unrelated startup error during shutdown remains fatal', { timeout: 30000 }, async t => {
    const result = await run(t, 'unrelated-during-shutdown', 'listener');
    assert.equal(result.delivered, true);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /SYNTHETIC_DATABASE_STARTUP_FAILURE/);
    assert.equal(result.events.some(row => row.event === 'shutdown-complete'), false);
  });
}

function childFixture(scenario) {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const { createRequire } = require('node:module');
  const assert = require('node:assert/strict');
  assert.ok(['hold', 'worker-failure', 'stopped-without-shutdown', 'unrelated-during-shutdown'].includes(scenario));
  const workers = [], readySignal = new SharedArrayBuffer(4);
  const send = event => process.send?.(event);
  class ObservedWorker extends Worker {
    constructor(...args) { super(...args); workers.push(this); }
  }
  function load(file, overrides) {
    const module = { exports: {} }, localRequire = createRequire(file);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      module, __dirname: path.dirname(file), setTimeout, clearTimeout,
      require: id => Object.hasOwn(overrides, id) ? overrides[id] : localRequire(id),
    }, { filename: file });
    return module.exports;
  }
  const client = load(path.resolve(__dirname, '../lib/sales-report-batch-worker.js'), {
    'node:worker_threads': { Worker: ObservedWorker },
  });
  const scheduler = load(path.resolve(__dirname, '../lib/persistence/postgresql/reporting/receipt-runtime.js'), {
    '../../../sales-report-batch-worker': {
      createSalesReportBatchWorker: options => client.createSalesReportBatchWorker({ ...options, workerFile: __filename }),
    },
    '../../repositories/sales-history-runtime': { createManagedSalesHistoryRuntime() { throw Error('Unexpected database runtime'); } },
  });
  const pool = scheduler.createPostgresqlReceiptWorkers({ workerConfiguration: { scenario, readySignal } });
  let rejectStartup;
  const module = { exports: {} }, testRequire = id => { throw Error('Unexpected startup dependency: ' + id); };
  testRequire.main = module;
  const dependencies = {
    module, require: testRequire, process, console, setImmediate, setTimeout, clearTimeout, setInterval, clearInterval,
    shutdownStarted: false, server: null, databaseClosed: false,
    initializeApplicationPersistence() {
      if (scenario === 'stopped-without-shutdown') return Promise.reject(Object.assign(new Error('IMPORT_REPORT_WORKER_STOPPED'), { code: 'IMPORT_REPORT_WORKER_STOPPED' }));
      if (scenario === 'unrelated-during-shutdown') return new Promise((resolve, reject) => { rejectStartup = reject; });
      return pool.warm();
    },
    getPortalStatus: () => ({}), validateServerStartup() {}, acquireInstanceLock() {}, activateSaturdaySalesRollout: async () => {},
    PORT: 0, HOST: '127.0.0.1', app: { listen() { send({ event: 'listener-started' }); throw Error('Unexpected application listener'); } },
    amuScannerProbe: Promise.resolve(), systemCenterHealthSyncInFlight: null,
    dataImportJobs: { stop: async () => {} }, dataImportRoutes: { stop: async () => {} },
    recoveryAssuranceStatusReader: { close: async () => {} }, updateRequestLifecycle: { close: async () => {} },
    planningDerivedRefresh: { close: async () => {} }, systemUtilization: { stop() {} },
    tradeInsightJobs: { stop: async () => {} }, salesReportJobs: { stop: async () => {} },
    postgresqlReceiptWorkers: { async close() {
      await pool.close();
      assert.ok(workers.every(worker => worker.threadId === -1), 'all actual threads must terminate before persistence closes');
      send({ event: 'workers-terminated' });
    } },
    backupInterval: null, retentionInterval: null, scannerProbeInterval: null, sicknessSweepInterval: null,
    notificationDispatchInterval: null, rateLimitCleanupInterval: null, systemCenterHealthInterval: null,
    localBackupArchiveEnabled: () => false,
    persistenceProvider: { async close() {
      if (scenario === 'unrelated-during-shutdown') await new Promise(() => {});
      send({ event: 'persistence-closed' });
    } },
    db: { close() {} }, releaseInstanceLock: () => send({ event: 'instance-released' }),
    completeProcessShutdown(code) {
      assert.ok(workers.every(worker => worker.threadId === -1));
      process.send({ event: 'shutdown-complete', workerCount: workers.length, liveWorkers: workers.filter(worker => worker.threadId !== -1).length }, () => process.exit(code));
    },
  };
  const file = path.resolve(__dirname, '../server.js'), source = fs.readFileSync(file, 'utf8');
  function between(from, to) {
    const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
    assert.ok(start >= 0 && end > start); return source.slice(start, end);
  }
  // Execute the shipped startServer, shutdown and main signal/catch blocks,
  // unchanged. The PostgreSQL/HTTP dependencies are synthetic; the child,
  // signal handler, production worker client/scheduler and threads are real.
  const startup = between('async function startServer() {', 'function maintenanceOwnsLifecycleBackup()');
  const shutdown = between('function shutdown(', 'if (require.main === module)');
  const main = between('if (require.main === module)', 'module.exports = {');
  vm.runInNewContext(startup + shutdown + main, dependencies, { filename: file });
  process.on('message', message => {
    if (message.event === 'dispatch-sigterm-listener') process.emit('SIGTERM');
  });
  process.once('SIGTERM', () => {
    send({ event: 'sigterm-observed' });
    rejectStartup?.(Object.assign(new Error('SYNTHETIC_DATABASE_STARTUP_FAILURE'), { code: 'SYNTHETIC_DATABASE_STARTUP_FAILURE' }));
  });
  const ready = setInterval(() => {
    if (scenario === 'unrelated-during-shutdown' || Atomics.load(new Int32Array(readySignal), 0) === 3) {
      clearInterval(ready); send({ event: 'startup-pending' });
    }
  }, 5);
  ready.unref();
}

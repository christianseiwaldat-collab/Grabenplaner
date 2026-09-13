'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { SQLITE_APPLICATION_CATALOG } = require('../lib/persistence/sqlite/application-catalog');
const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
const { createBranchReceiptRuntime } = require('../lib/persistence/repositories/branch-receipt-runtime');
const { executeBranchReceiptWork } = require('../lib/branch-sales-worker');
const application = openSqliteApplicationPersistence({ databasePath: workerData.databasePath, catalog: SQLITE_APPLICATION_CATALOG });
const runtime = createBranchReceiptRuntime({ access: application.provider,
  vault: createIntegrationSecretVault(workerData.keyConfiguration), scopeId: workerData.scopeId, today: () => workerData.today });
parentPort.on('message', async ({ id, input }) => {
  try { parentPort.postMessage({ id, result: await executeBranchReceiptWork(runtime, input) }); }
  catch (error) { parentPort.postMessage({ id, error: error.code }); }
});

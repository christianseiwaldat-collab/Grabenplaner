'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const C = require('./data-import-contract');
const { createIntegrationSecretVault } = require('./integration-secret-vault');
const { createSqlitePersistenceProvider, openSqliteLegacyDatabase } = require('./persistence/sqlite/provider');
const { SQLITE_APPLICATION_CATALOG } = require('./persistence/sqlite/application-catalog');
const { createManagedSalesHistoryRuntime } = require('./persistence/repositories/sales-history-runtime');
const { createSalesAnalysisPdf } = require('./sales-analysis-pdf');
const database = openSqliteLegacyDatabase(workerData.databasePath, { readOnly: true, initializeConnection: false });
const access = createSqlitePersistenceProvider({ database, catalog: SQLITE_APPLICATION_CATALOG, closeDatabase: true, initializeConnection: false });
const vault = workerData.keyConfiguration ? createIntegrationSecretVault(workerData.keyConfiguration) : null;
const runtime = createManagedSalesHistoryRuntime({ access, vault, scopeId: workerData.scopeId, cashEnabled: true, retainCompletedAnalyses: false,
  ...(workerData.today ? { today: () => workerData.today } : {}) });
let busy = false;
parentPort.on('message', async ({ id, input }) => {
  if (busy) { parentPort.postMessage({ id, error: 'IMPORT_HISTORY_ANALYSIS_BUSY' }); return; }
  busy = true;
  try {
    const { session, query, metadata, cursor, sourceRevision, title, completedAt } = input;
    const result = await runtime.run(async () => session, workspace => {
      if (!workspace || workspace.reportSourceRevision !== sourceRevision) C.fail('IMPORT_HISTORY_ANALYSIS_CHANGED', 409);
      return workspace.reports.step(query, metadata, cursor);
    });
    if (result.analysis.complete) {
      result.artifact = (await createSalesAnalysisPdf({ title, query, metadata, report: result.report, completedAt })).toString('base64');
      // The web process only receives the ready encrypted-job artifact and progress.
      delete result.report;
    }
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: /^IMPORT_[A-Z_]+$/.test(error?.code || '') ? error.code : 'IMPORT_REPORT_FAILED' });
  } finally { busy = false; }
});

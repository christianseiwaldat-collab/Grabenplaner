"use strict";
const C = require('../../data-import-contract');
const { buildSalesHistoryProjection } = require('../../sales-history-access');
const { loadManagedDataImportProtection } = require('../../data-import-managed-protection');
const { createSalesHistoryWorkspace, createSalesHistoryAnalysisStore } = require('./sales-history-workspace');
const { createCashPublications } = require('./cash-publications');
const { createCashHistoryBackend } = require('./cash-history-backend');
const { createReceiptWorkspace } = require('./receipt-workspace');
const { createReceiptResultStore } = require('../../receipt-result-store');
const { createReceiptSummaryStore } = require('../../receipt-summary-store');
const { createSalesReportWorkspace } = require('./sales-report-workspace');
const { reportAuthority } = require('../../sales-report-model');
const { reportMarginPolicyFor } = require('../../sales-report-margin');
// Source/rule/coverage approval is a composition boundary, never an HTTP flag.
// The normal app remains disabled until the separately approved release block.
function createManagedSalesHistoryRuntime({ access, vault, enabled = false, cashEnabled = false, scopeId = 'grabenplaner-main', sources = [],
  getPolicy, getCoverage, today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Vienna' }).format(new Date()), now, retainCompletedAnalyses = true }) {
  C.id(scopeId);
  const analysisStore = createSalesHistoryAnalysisStore();
  const resultStore = createReceiptResultStore();
  const summaryStore = createReceiptSummaryStore();
  return Object.freeze({ async run(getSession, work) {
    let session = await getSession();
    const identity = value => C.canonical([String(value?.employeeNumber || ''), value?.accountId || null, reportAuthority(value)]);
    const signature = identity(session);
    if (!buildSalesHistoryProjection(session).read || session?.mustChangePassword) C.fail('IMPORT_FORBIDDEN', 403);
    if (!(enabled === true && sources.length) && cashEnabled !== true) return work(null);
    const protection = await loadManagedDataImportProtection({ access, vault, create: false });
    if (!protection) { if (cashEnabled) return work(null); C.fail('IMPORT_HISTORY_NOT_ACTIVATED', 503); }
    try {
      session = await getSession();
      if (identity(session) !== signature) C.fail('IMPORT_FORBIDDEN', 403);
      let backend = null;
      if (cashEnabled) {
        const publications = createCashPublications({ access, protection, scopeId });
        const publication = await access.transaction(tx => publications.active(tx), { isolation: 'serializable', readOnly: true });
        if (publication) backend = createCashHistoryBackend({ publication, publications, scopeId });
      }
      if (!backend && !(enabled === true && sources.length)) return work(null);
      const workspace = createSalesHistoryWorkspace({ access, protection, sources: backend ? [backend.source] : sources,
        getPolicy: backend ? () => backend.policy : getPolicy, getCoverage, today, now, analysisStore, backend, retainCompletedAnalyses,
        getSession: () => session, getActor: () => ({ scopeId, ownerId: C.id(String(session.employeeNumber)) }) });
      const receipts = backend ? createReceiptWorkspace({ access, protection, backend, getSession: () => session,
        getActor: () => ({ scopeId, ownerId: C.id(String(session.employeeNumber)) }), today, now, resultStore, summaryStore }) : null;
      const marginPolicy = backend ? reportMarginPolicyFor(backend.policy) : null;
      const reports = backend ? createSalesReportWorkspace({ access, protection, backend, getSession: () => session, scopeId, today, marginPolicy }) : null;
      const result = await work(Object.freeze({ ...workspace, receipts, reports,
        legacyReportSourceRevision: protection.digest([backend ? backend.source : sources, backend ? backend.policy : null]),
        reportSourceRevision: protection.digest([backend ? backend.source : sources, backend ? backend.policy : null, marginPolicy]) }));
      session = await getSession();
      if (identity(session) !== signature) C.fail('IMPORT_FORBIDDEN', 403);
      return result;
    } finally { protection.destroy(); }
  } });
}
module.exports = { createManagedSalesHistoryRuntime };

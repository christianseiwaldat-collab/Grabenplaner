'use strict';
const { createReceiptWorkspace } = require('../lib/persistence/repositories/receipt-workspace');
const { createCashPublications } = require('../lib/persistence/repositories/cash-publications');
const { createReceiptSummaryStore } = require('../lib/receipt-summary-store');
const { measuredPersistence } = require('./measured-persistence');

// Control reproduces the previous scheduler: one initial head/child batch and
// scalar reads afterwards; document selections previously had no prefetch.
// The actual decoder, reconciliation, SQL, authorization and caches are shared.
async function receiptMeasurement({ access, protection, scopeId, session, backendFactory, mode = 'current', query, publication: suppliedPublication }) {
  const publications = createCashPublications({ access, protection, scopeId });
  const publication = suppliedPublication || await access.transaction(tx => publications.active(tx), { isolation: 'serializable', readOnly: true });
  const source = backendFactory({ publication, publications, scopeId });
  const measured = measuredPersistence(access);
  const backend = { ...source, service(tx, authorize) {
    const service = source.service(tx, authorize);
    if (mode !== 'legacy-prefix' || !service.prefetch) return service;
    let prefetched = false;
    const { prefetchDocuments, ...legacy } = service;
    return { ...legacy, async prefetch(ids, children) {
      if (!prefetched) { prefetched = true; return service.prefetch(ids, children); }
    } };
  } };
  const summaryStore = createReceiptSummaryStore();
  const workspace = createReceiptWorkspace({ access: measured.access, protection, backend, getSession: () => session,
    getActor: () => ({ scopeId, ownerId: session.employeeNumber }), today: () => query.dateTo, summaryStore });
  async function measure(operation, input) {
    measured.counts.clear();
    const started = performance.now();
    const result = await workspace[operation](input);
    const milliseconds = performance.now() - started;
    const calls = [...measured.counts].flatMap(([id, count]) => Array(count).fill(id));
    return { result, milliseconds, queries: calls.length,
      batchReads: calls.filter(id => id.startsWith('reporting-boundary.prefetch-')).length,
      scalarRows: calls.filter(id => /^cash-snapshots\.\d+\.(row|children)$/.test(id)).length,
      statements: [...calls] };
  }
  return { measure, workspace, summaryStore, close: () => measured.access.close() };
}
module.exports = { receiptMeasurement };

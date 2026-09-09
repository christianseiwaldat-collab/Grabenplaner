'use strict';
const crypto = require('node:crypto');
const C = require('../../data-import-contract');
const { assertPersistenceAccess } = require('../contract');
const { SALES_REPORT_JOB_STATEMENTS: S } = require('../statements/sales-report-jobs');
const { loadManagedDataImportProtection } = require('../../data-import-managed-protection');
const { buildSalesHistoryProjection } = require('../../sales-history-access');
const { normalizeSalesHistoryQuery } = require('../../sales-history-query');
const { renderSalesReportDocument } = require('../../sales-report-document');

// One bounded analysis batch per tick. Only encrypted derived data is persisted;
// cookies and session tokens never enter the queue. Expired leases restart at zero.
function createSalesReportJobs({ access, vault, runtime, resolvePrincipal, scope = 'grabenplaner-main', now = Date.now, onError = () => {} }) {
  assertPersistenceAccess(access);
  const worker = crypto.randomUUID(), cursors = new Map();
  let timer = null, pending = null, stopped = false, lastError = null;
  const stamp = () => new Date(now()).toISOString();
  const authority = session => {
    const projection = buildSalesHistoryProjection(session);
    if (!projection.read || session?.mustChangePassword) C.fail('IMPORT_FORBIDDEN', 403);
    return { employeeNumber: C.id(String(session.employeeNumber)), projection };
  };
  const context = row => ['sales-report-job-v1', row.scope, row.owner, row.id];
  async function protectedWork(work) {
    const protection = await loadManagedDataImportProtection({ access, vault, create: false });
    if (!protection) C.fail('IMPORT_HISTORY_NOT_ACTIVATED', 503);
    try { return await work(protection); } finally { protection.destroy(); }
  }
  const ownerKey = (p, session) => p.digest(['sales-report-owner', scope, authority(session).employeeNumber]);
  const view = (row, data) => ({ id: row.id, status: row.status, created: row.created, updated: row.updated,
    title: data.title, query: data.query, processed: data.processed, restarts: data.restarts, error: data.error || null });
  async function owned(p, session, id) {
    C.id(id); const row = await access.queryOne(S.get, { id, scope });
    if (!row || row.owner !== ownerKey(p, session)) C.fail('IMPORT_HISTORY_NOT_FOUND', 404);
    return [row, p.open(row.payload, context(row))];
  }
  async function save(tx, p, row, data, status = row.status, lease = 0) {
    const updated = { ...row, status, updated: stamp(), lease, worker, payload: p.seal(data, context(row)) };
    const result = await tx.execute(S.update, updated);
    return result.rowsAffected === 1 ? { ...updated, revision: row.revision + 1 } : null;
  }
  async function create(session, input) {
    C.exact(input, ['title', 'query']);
    const title = C.text(input.title || 'Umsatzauswertung', 120);
    const a = authority(session);
    return protectedWork(async p => {
      const query = await runtime.run(async () => session, async workspace => {
        if (!workspace) C.fail('IMPORT_HISTORY_NOT_ACTIVATED', 503);
        const normalized = normalizeSalesHistoryQuery(input.query, { today: workspace.context().today, projection: a.projection });
        // First report type deliberately excludes personal and finance drilldowns.
        if (normalized.kind !== 'sales' || normalized.sellerId || normalized.snapshot || normalized.cursor) C.fail('IMPORT_HISTORY_KIND');
        const source = workspace.context().sources.find(s => s.id === normalized.sourceId);
        if (!source || normalized.locationId && normalized.locationId !== 'unassigned' && !source.locations.some(l => l.id === normalized.locationId)) C.fail('IMPORT_FORBIDDEN', 403);
        return { query: { sourceId: normalized.sourceId, kind: 'sales', dateFrom: normalized.dateFrom, dateTo: normalized.dateTo, locationId: normalized.locationId }, sourceRevision: workspace.reportSourceRevision };
      });
      const row = { id: crypto.randomUUID(), owner: ownerKey(p, session), scope, status: 'queued', revision: 1, created: stamp(), updated: stamp(), lease: 0, worker: '', payload: '' };
      const data = { title, ...query, employeeNumber: a.employeeNumber, authority: p.digest(a), processed: 0, restarts: 0 };
      row.payload = p.seal(data, context(row));
      await access.transaction(async tx => {
        const existing = await tx.queryAll(S.list, { owner: row.owner, scope });
        if (existing.length >= 50 || existing.filter(r => ['queued', 'running'].includes(r.status)).length >= 3) C.fail('IMPORT_HISTORY_ANALYSIS_BUSY', 409);
        await tx.execute(S.insert, row);
      });
      return view(row, data);
    });
  }
  async function list(session) {
    return protectedWork(async p => (await access.queryAll(S.list, { scope, owner: ownerKey(p, session) })).map(row => view(row, p.open(row.payload, context(row)))));
  }
  async function cancel(session, id) {
    return protectedWork(async p => {
      const [row, data] = await owned(p, session, id);
      if (['queued', 'running'].includes(row.status)) {
        const saved = await access.transaction(tx => save(tx, p, row, { ...data, artifact: null }, 'cancelled'));
        if (!saved) C.fail('IMPORT_REVISION_CONFLICT', 409);
        cursors.delete(id); return view(saved, data);
      }
      return view(row, data);
    });
  }
  async function remove(session, id) {
    return protectedWork(async p => {
      const [row] = await owned(p, session, id);
      if (!['completed', 'failed', 'cancelled'].includes(row.status)) C.fail('IMPORT_REVISION_CONFLICT', 409);
      if ((await access.execute(S.remove, { id, scope, owner: row.owner, revision: row.revision })).rowsAffected !== 1) C.fail('IMPORT_REVISION_CONFLICT', 409);
    });
  }
  async function download(session, id) {
    return protectedWork(async p => {
      const [row, data] = await owned(p, session, id);
      if (row.status !== 'completed' || !data.artifact) C.fail('IMPORT_HISTORY_NOT_FOUND', 404);
      if (p.digest(authority(session)) !== data.authority) C.fail('IMPORT_FORBIDDEN', 403);
      return data.artifact;
    });
  }
  async function step() {
    // Check an empty queue before loading managed keys on every idle tick.
    const candidate = await access.queryOne(S.next, { scope, now: now(), worker });
    if (!candidate) return;
    await protectedWork(async p => {
      let row = candidate, data;
      try { data = p.open(row.payload, context(row)); }
      catch {
        await access.transaction(tx => save(tx, p, row, { title: 'Nicht lesbarer Auftrag', query: { dateFrom: '', dateTo: '', locationId: '' }, processed: 0, restarts: 0, error: 'IMPORT_REPORT_FAILED' }, 'failed'));
        return;
      }
      const restart = row.status === 'running' && (!cursors.has(row.id) || row.worker !== worker);
      if (restart) { data = { ...data, restarts: data.restarts + 1, processed: 0 }; cursors.delete(row.id); }
      row = await access.transaction(tx => save(tx, p, row, data, 'running', now() + 30000));
      if (!row) return;
      try {
        if (data.restarts > 3) C.fail('IMPORT_HISTORY_ANALYSIS_EXPIRED', 409);
        const getSession = async () => {
          const session = await resolvePrincipal(data.employeeNumber);
          if (p.digest(authority(session)) !== data.authority) C.fail('IMPORT_FORBIDDEN', 403);
          return session;
        };
        const result = await runtime.run(getSession, async workspace => {
          if (!workspace || workspace.reportSourceRevision !== data.sourceRevision) C.fail('IMPORT_HISTORY_ANALYSIS_CHANGED', 409);
          const cursor = cursors.get(row.id);
          return cursor ? workspace.analyze({ query: data.query, cursor }) : workspace.search(data.query);
        });
        const complete = result.analysis.complete;
        data = { ...data, processed: result.analysis.processed };
        if (complete) data.artifact = renderSalesReportDocument({ ...data, result, completedAt: stamp() });
        const saved = await access.transaction(tx => save(tx, p, row, data, complete ? 'completed' : 'running', complete ? 0 : now() + 30000));
        if (saved && !complete) cursors.set(row.id, result.analysis.cursor); else cursors.delete(row.id);
      } catch (error) {
        cursors.delete(row.id);
        await access.transaction(tx => save(tx, p, row, { ...data, artifact: null, error: ['IMPORT_FORBIDDEN', 'IMPORT_HISTORY_ANALYSIS_CHANGED'].includes(error?.code) ? error.code : 'IMPORT_REPORT_FAILED' }, 'failed'));
      }
    });
  }
  function tick() {
    if (pending || stopped) return pending;
    pending = step().then(() => { lastError = null; }).catch(error => {
      const code = /^IMPORT_[A-Z_]+$/.test(error?.code || '') ? error.code : 'IMPORT_REPORT_FAILED';
      if (lastError !== code) onError(code); lastError = code; throw error;
    }).finally(() => { pending = null; }); return pending;
  }
  return Object.freeze({ create, list, cancel, remove, download, tick,
    start() { if (timer) return; stopped = false; timer = setInterval(() => { void tick()?.catch(() => {}); }, 1000); timer.unref(); },
    async stop() { stopped = true; clearInterval(timer); timer = null; await pending; cursors.clear(); },
  });
}
module.exports = { createSalesReportJobs };

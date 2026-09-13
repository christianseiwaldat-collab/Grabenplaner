'use strict';
const crypto = require('node:crypto');
const C = require('../../data-import-contract');
const { reportAuthority } = require('../../sales-report-model');
const { loadManagedDataImportProtection } = require('../../data-import-managed-protection');
const { createUiPreferencesRepository } = require('./ui-preferences');
const PREFIX = 'sales_report_template_v1:';
function createSalesReportTemplates({ access, vault, normalizeQuery, scope = 'grabenplaner-main', now = Date.now }) {
  const owner = session => {
    if (!reportAuthority(session).read || session.mustChangePassword) C.fail('IMPORT_FORBIDDEN', 403);
    return C.id(String(session.employeeNumber));
  };
  const context = (employee, id) => ['sales-report-template-v1', scope, employee, id];
  async function protectedWork(session, work) {
    const employee = owner(session), protection = await loadManagedDataImportProtection({ access, vault, create: false });
    if (!protection) C.fail('IMPORT_HISTORY_NOT_ACTIVATED', 503);
    try { return await work(protection, employee); } finally { protection.destroy(); }
  }
  function presentation(input = {}) {
    C.exact(input, ['periodMode', 'comparisonMode', 'comparisonCustom']);
    const valid = ['custom', 'month', 'quarter', 'year'];
    if (!valid.includes(input.periodMode || 'custom') || !valid.includes(input.comparisonMode || 'custom')
      || input.comparisonCustom !== undefined && typeof input.comparisonCustom !== 'boolean') C.fail('IMPORT_REPORT_SELECTION');
    return { periodMode: input.periodMode || 'custom', comparisonMode: input.comparisonMode || 'custom', comparisonCustom: !!input.comparisonCustom };
  }
  async function read(repo, p, employee, id) {
    C.id(id); const row = await repo.get(employee, PREFIX + id);
    if (!row) C.fail('IMPORT_HISTORY_NOT_FOUND', 404);
    return p.open(row.value, context(employee, id));
  }
  return Object.freeze({
    list(session) { return protectedWork(session, async (p, employee) => {
      const rows = await createUiPreferencesRepository(access).list(employee);
      return rows.filter(r => r.preferenceKey.startsWith(PREFIX)).map(row => {
        const id = row.preferenceKey.slice(PREFIX.length), item = p.open(row.value, context(employee, id));
        return { id, title: item.title, revision: item.revision, updated: item.updated, kind: item.query.chartType === 'timeline' ? 'graphic' : 'report' };
      }).sort((a, b) => a.title.localeCompare(b.title, 'de-AT', { numeric: true }));
    }); },
    get(session, id) { return protectedWork(session, async (p, employee) => {
      const item = await read(createUiPreferencesRepository(access), p, employee, id);
      const query = await normalizeQuery(session, item.query);
      return { ...item, query };
    }); },
    async save(session, input, id = null) {
      C.exact(input, ['title', 'query', 'presentation', 'revision']); owner(session);
      const title = C.text(String(input.title || '').trim(), 120), ui = presentation(input.presentation);
      if (id) { C.id(id); C.integer(input.revision, 1, Number.MAX_SAFE_INTEGER); }
      else if (input.revision !== undefined) C.fail('IMPORT_REVISION_CONFLICT', 409);
      const query = await normalizeQuery(session, input.query);
      if (JSON.stringify(query).length > 32768) C.fail('IMPORT_REPORT_SELECTION');
      return protectedWork(session, (p, employee) => access.transaction(async tx => {
        const repo = createUiPreferencesRepository(tx), previous = id ? await read(repo, p, employee, id) : null;
        if (previous && previous.revision !== input.revision) C.fail('IMPORT_REVISION_CONFLICT', 409);
        if (!previous && (await repo.list(employee)).filter(r => r.preferenceKey.startsWith(PREFIX)).length >= 50) C.fail('IMPORT_REPORT_TEMPLATE_LIMIT', 409);
        const key = id || crypto.randomUUID(), item = { id: key, title, query, presentation: ui, revision: (previous?.revision || 0) + 1, updated: new Date(now()).toISOString() };
        await repo.upsert(employee, PREFIX + key, p.seal(item, context(employee, key))); return item;
      }, { isolation: 'serializable' }));
    },
    remove(session, id, input) {
      C.exact(input, ['revision']); C.integer(input.revision, 1, Number.MAX_SAFE_INTEGER);
      return protectedWork(session, (p, employee) => access.transaction(async tx => {
        const repo = createUiPreferencesRepository(tx), item = await read(repo, p, employee, id);
        if (item.revision !== input.revision) C.fail('IMPORT_REVISION_CONFLICT', 409);
        await repo.saveChanges(employee, { deleteKeys: [PREFIX + id] }); return { ok: true };
      }, { isolation: 'serializable' }));
    }
  });
}
module.exports = { createSalesReportTemplates };

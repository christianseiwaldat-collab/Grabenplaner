'use strict';
const crypto = require('node:crypto');
const C = require('../../data-import-contract');
const { reportAuthority } = require('../../sales-report-model');
const { loadManagedDataImportProtection } = require('../../data-import-managed-protection');
const { createUiPreferencesRepository } = require('./ui-preferences');
const KEY = 'sales_report_library_v1';
const Options = require('../../../public/sales-report-library-options');
const emptyLibrary = () => ({ revision: 0, folders: [], items: [] });
function editLibrary(previous, input, existing, metadata = {}) {
  C.exact(input, ['revision', 'action', 'id', 'parentId', 'title', 'kind', 'preferences']);
  C.integer(input.revision, 0, Number.MAX_SAFE_INTEGER);
  if (input.revision !== previous.revision) C.fail('IMPORT_REVISION_CONFLICT', 409);
  const state = structuredClone(previous);
  const stamp = { updated: metadata.created || null };
  // Removed reports/templates must never strand an otherwise empty folder.
  state.items = state.items.filter(item => existing.has(item.kind + ':' + item.id));
  const parentId = input.parentId || '';
  if (parentId && !state.folders.some(folder => folder.id === parentId)) C.fail('IMPORT_HISTORY_NOT_FOUND', 404);
  const title = () => C.text(String(input.title || '').normalize('NFC').trim(), 120);
  const uniqueFolder = (name, parent, except) => {
    if (state.folders.some(f => f.id !== except && f.parentId === parent && f.title.toLocaleLowerCase('de-AT') === name.toLocaleLowerCase('de-AT'))) C.fail('IMPORT_REPORT_FOLDER_DUPLICATE', 409);
  };
  if (input.action === 'preferences') {
    try { state.preferences = Options.normalize(input.preferences); } catch { C.fail('IMPORT_REPORT_SELECTION'); }
  } else if (input.action === 'createFolder') {
    if (state.folders.length >= 100) C.fail('IMPORT_REPORT_FOLDER_LIMIT', 409);
    const name = title(); uniqueFolder(name, parentId);
    state.folders.push({ id: crypto.randomUUID(), parentId, title: name, created: metadata.created || null, createdBy: metadata.createdBy || null, ...stamp });
  } else if (['renameFolder', 'moveFolder', 'deleteFolder'].includes(input.action)) {
    const folder = state.folders.find(f => f.id === input.id);
    if (!folder) C.fail('IMPORT_HISTORY_NOT_FOUND', 404);
    if (input.action === 'deleteFolder') {
      if (state.folders.some(f => f.parentId === folder.id) || state.items.some(i => i.folderId === folder.id)) C.fail('IMPORT_REPORT_FOLDER_NOT_EMPTY', 409);
      state.folders = state.folders.filter(f => f.id !== folder.id);
    } else if (input.action === 'renameFolder') {
      const name = title(); uniqueFolder(name, folder.parentId, folder.id); Object.assign(folder, { title: name }, stamp);
    } else {
      let ancestor = parentId;
      while (ancestor) {
        if (ancestor === folder.id) C.fail('IMPORT_REPORT_SELECTION');
        ancestor = state.folders.find(f => f.id === ancestor)?.parentId || '';
      }
      uniqueFolder(folder.title, parentId, folder.id); Object.assign(folder, { parentId }, stamp);
    }
  } else if (['moveItem', 'renameItem'].includes(input.action)) {
    if (!['report', 'template'].includes(input.kind) || !existing.has(input.kind + ':' + input.id)) C.fail('IMPORT_HISTORY_NOT_FOUND', 404);
    let item = state.items.find(i => i.kind === input.kind && i.id === input.id);
    if (!item) { item = { kind: input.kind, id: input.id, folderId: '' }; state.items.push(item); }
    if (input.action === 'moveItem') item.folderId = parentId; else item.title = title();
    Object.assign(item, stamp);
  } else C.fail('IMPORT_REPORT_SELECTION');
  state.revision++;
  return state;
}
function createSalesReportLibrary({ access, vault, jobs, templates, scope = 'grabenplaner-main' }) {
  async function work(session, action) {
    if (!reportAuthority(session).read || session.mustChangePassword) C.fail('IMPORT_FORBIDDEN', 403);
    const employee = C.id(String(session.employeeNumber));
    const p = await loadManagedDataImportProtection({ access, vault, create: false });
    if (!p) C.fail('IMPORT_HISTORY_NOT_ACTIVATED', 503);
    try { return await action(p, employee, ['sales-report-library-v1', scope, employee]); } finally { p.destroy(); }
  }
  const read = async (repo, p, employee, context) => {
    const row = await repo.get(employee, KEY); return row ? p.open(row.value, context) : emptyLibrary();
  };
  return Object.freeze({
    get(session) { return work(session, (p, employee, context) => read(createUiPreferencesRepository(access), p, employee, context)); },
    update(session, input) { return work(session, async (p, employee, context) => {
      const reports = await jobs.list(session), saved = await templates.list(session);
      const existing = new Set([...reports.map(r => 'report:' + r.id), ...saved.map(t => 'template:' + t.id)]);
      return access.transaction(async tx => {
        const repo = createUiPreferencesRepository(tx), previous = await read(repo, p, employee, context);
        const next = editLibrary(previous, input, existing, { created: new Date().toISOString(), createdBy: employee });
        await repo.upsert(employee, KEY, p.seal(next, context)); return next;
      }, { isolation: 'serializable' });
    }); }
  });
}
module.exports = { createSalesReportLibrary, editLibrary, emptyLibrary };

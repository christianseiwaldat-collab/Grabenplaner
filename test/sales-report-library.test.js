'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { editLibrary, emptyLibrary, createSalesReportLibrary } = require('../lib/persistence/repositories/sales-report-library');
const Options = require('../public/sales-report-library-options');

test('library view, column visibility, order, widths and sorting are validated without accepting empty data tables', () => {
  const preferences = { ...Options.defaults(), view: 'details', columns: ['type', 'name'], widths: { name: 345 }, sort: 'created', direction: 'desc' };
  const state = editLibrary(emptyLibrary(), { revision: 0, action: 'preferences', preferences }, new Set());
  assert.deepEqual(state.preferences, preferences);
  for (const bad of [{ columns: [] }, { columns: ['unknown'] }, { columns: ['name', 'name'] }, { widths: { name: 20 } }, { widths: { private: 100 } }, { view: 'invented' }, { sort: 'private' }])
    assert.throws(() => editLibrary(state, { revision: 1, action: 'preferences', preferences: { ...preferences, ...bad } }, new Set()), { code: 'IMPORT_REPORT_SELECTION' });
  const stamped = editLibrary(state, { revision: 1, action: 'createFolder', title: 'Monate' }, new Set(), { created: '2026-11-02T10:00:00.000Z', createdBy: '101' });
  assert.equal(stamped.folders[0].createdBy, '101'); assert.equal(stamped.folders[0].created, '2026-11-02T10:00:00.000Z');
  assert.deepEqual(stamped.preferences, preferences);
});
test('folder hierarchy preserves items, rejects cycles, duplicate folders, stale writes and nonempty deletion', () => {
  let state = emptyLibrary(); const existing = new Set(['report:pdf', 'template:settings']);
  const edit = input => (state = editLibrary(state, { revision: state.revision, ...input }, existing));
  edit({ action: 'createFolder', title: 'Jahr 2026' }); const parent = state.folders[0].id;
  edit({ action: 'createFolder', title: 'Monate', parentId: parent }); const child = state.folders[1].id;
  for (const [kind, id] of [['report', 'pdf'], ['template', 'settings']]) edit({ action: 'moveItem', kind, id, parentId: child });
  assert.throws(() => edit({ action: 'deleteFolder', id: child }), { code: 'IMPORT_REPORT_FOLDER_NOT_EMPTY' });
  assert.throws(() => edit({ action: 'moveFolder', id: parent, parentId: child }), { code: 'IMPORT_REPORT_SELECTION' });
  assert.throws(() => edit({ action: 'createFolder', title: 'MONATE', parentId: parent }), { code: 'IMPORT_REPORT_FOLDER_DUPLICATE' });
  assert.throws(() => edit({ action: 'moveItem', kind: 'report', id: 'someone-else' }), { code: 'IMPORT_HISTORY_NOT_FOUND' });
  assert.throws(() => editLibrary(state, { revision: 0, action: 'deleteFolder', id: child }, existing), { code: 'IMPORT_REVISION_CONFLICT' });
  edit({ action: 'renameItem', kind: 'report', id: 'pdf', title: 'Umsatz und Rohertrag' });
  edit({ action: 'renameFolder', id: child, title: 'Auswertungen' });
  edit({ action: 'moveFolder', id: child, parentId: '' });
  assert.equal(state.items[0].folderId, child); assert.equal(state.items[0].title, 'Umsatz und Rohertrag');
  existing.clear(); edit({ action: 'deleteFolder', id: child }); edit({ action: 'deleteFolder', id: parent });
  assert.deepEqual(state.folders, []); assert.deepEqual(state.items, []);
});
test('personal report library persists encrypted metadata, isolates owners and checks current rights', async t => {
  const f = await require('../test-support/trade-insights-sqlite').fixture(t);
  f.app.database.exec('CREATE TABLE portal_user_preferences(employee_number TEXT,preference_key TEXT,value TEXT,updated_at TEXT,PRIMARY KEY(employee_number,preference_key))');
  const session = f.state.session;
  const make = () => createSalesReportLibrary({ access: f.app.provider, vault: f.vault, scope: 'synthetic', jobs: { list: async () => [{ id: 'pdf' }] }, templates: { list: async () => [{ id: 'settings' }] } });
  let saved = await make().update(session, { revision: 0, action: 'createFolder', title: 'Private Auswertungen' });
  saved = await make().update(session, { revision: saved.revision, action: 'moveItem', kind: 'template', id: 'settings', parentId: saved.folders[0].id });
  assert.deepEqual(await make().get(session), saved);
  saved = await make().update(session, { revision: saved.revision, action: 'preferences', preferences: { ...Options.defaults(), view: 'details', widths: { name: 310 } } });
  assert.deepEqual((await make().get(session)).preferences, saved.preferences);
  assert.doesNotMatch(f.app.database.prepare('SELECT value FROM portal_user_preferences').get().value, /Private Auswertungen|settings/);
  assert.deepEqual(await make().get({ ...session, employeeNumber: 'another-owner' }), emptyLibrary());
  await assert.rejects(make().update(session, { revision: 0, action: 'createFolder', title: 'stale' }), { code: 'IMPORT_REVISION_CONFLICT' });
  await assert.rejects(make().get({ ...session, permissions: [] }), { code: 'IMPORT_FORBIDDEN' });
  await assert.rejects(make().update({ ...session, mustChangePassword: true }, { revision: 2, action: 'createFolder', title: 'no' }), { code: 'IMPORT_FORBIDDEN' });
  const templateStore = require('../lib/persistence/repositories/sales-report-templates').createSalesReportTemplates({ access: f.app.provider, vault: f.vault, scope: 'synthetic', normalizeQuery: async (actor, query) => query });
  const old = { id: 'legacy', title: 'Alte Vorlage', query: { chartType: 'bars' }, revision: 1, updated: '2026-10-01T10:00:00.000Z' };
  const repo = require('../lib/persistence/repositories/ui-preferences').createUiPreferencesRepository(f.app.provider);
  await repo.upsert(session.employeeNumber, 'sales_report_template_v1:legacy', f.protection.seal(old, ['sales-report-template-v1', 'synthetic', session.employeeNumber, 'legacy']));
  const legacy = (await templateStore.list(session))[0]; assert.equal(legacy.created, null); assert.equal(legacy.createdBy, null);
  const edited = await templateStore.save(session, { title: old.title, query: old.query, revision: 1 }, 'legacy');
  assert.equal(edited.created, null); assert.equal(edited.createdBy, null);
});

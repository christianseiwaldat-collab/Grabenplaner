'use strict';
const C = require('./data-import-contract');
const H = require('./tradefoto-history-profiles');
const D = require('./tradefoto-bestell/decimal');
const { supplyState } = require('./tradefoto-bestell/purchasing');
const { projectionFor } = require('./tradefoto-bestell/access');
const { IMPORT_HISTORY_STATEMENTS: I } = require('./persistence/statements/import-history');
const { IMPORT_MASTER_STATEMENTS: M } = require('./persistence/statements/import-master-data');
const { ARTICLE_BRANCH_ORDER_STATEMENTS: S } = require('./persistence/statements/sales-article-branch-orders');
const { prefetch } = require('./sales-article-reader-batch');
const LIMIT = 400, ITEM_LIMIT = 20, INSTANCE = 'tradefoto-bestell';
const TABLES = ['BestellVerteilung', 'BESTELLDETAILS', 'BESTELLUNGEN'];
const narrowProfiles = new Map(TABLES.map(table => {
  const profile = H.profileFor('trade', table), metadata = H.tableFor('trade', table);
  const { fingerprint, ...definition } = profile;
  return [table, C.defineDataImportProfile({ ...definition,
    fields: profile.fields.filter(field => metadata.columns.find(column => column.name === field.source)?.dataClass === 'internal_business'),
    dataClasses: ['internal_business'] })];
}));
// This reader authenticates one data class and its identity, not the complete
// source row. Never use history.detail here: it decrypts customer segments too.
const versionContext = (r, v) => ['history-version', r.scopeId, r.sourceInstance, r.source, r.sourceTable,
  r.id, r.identityHash, r.profileHash, v.revision, v.fileSha256, v.snapshotAt, v.importedBy,
  v.importedAt, v.runId, v.masterSourceInstance, v.businessDate, v.parentId, v.parentRevision];
const key = value => value === null || value === undefined ? '' : String(value);
const branchKey = value => key(value).replace(/^0+(?=\d)/u, '');
const initial = state => ({ state, items: [], sourceAt: null, truncated: false, matched: null });

async function loadSalesArticleBranchOrders({ access, tx, protection, article, scopeId, masterRecordId, rows, session }) {
  const projection = projectionFor(session);
  const result = rows.map(row => ({ ...row, ordered: null, orders: initial('restricted') }));
  if (!projection.purchasing) return result;
  const readMaster = require('./persistence/repositories/import-master-data').createImportMasterReferenceReader({ protection, authorize: () => true });
  const publications = require('./persistence/repositories/cash-publications').createCashPublications({ access, protection, scopeId });
  let publication;
  const resolve = require('./persistence/repositories/trade-location-reader').createTradeLocationResolver({
    readMaster: id => readMaster(tx, { scopeId, ownerId: String(session.employeeNumber), sourceInstance: 'tradefoto-trade' }, 'FILIALEN', [id]),
    readCash: async id => { publication ||= publications.active(tx); const active = await publication;
      return active ? publications.reference(tx, active.row.id, 'FILIALEN', id) : null; },
    readTarget: id => tx.queryOne(M.location, { id }),
  });
  const visible = new Map();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], location = await resolve(row.id);
    if (!(location ? projection.company || projection.locationIds.includes(location) : projection.company && projection.unassigned)) continue;
    result[index].ordered = row.ambiguous ? null : row.ordered;
    result[index].orders = initial('unavailable');
    visible.set(branchKey(row.id), result[index]);
  }
  if (!visible.size || !masterRecordId) return result;

  // The fixed article-reference index bounds all work. Historical unchanged
  // rows retain earlier provenance; filtering them by the newest file loses
  // real assignments. These are explicitly last recorded assignments instead.
  const candidates = await tx.queryAll(S.candidates, { scopeId, articleMaster: masterRecordId, limit: LIMIT + 1 });
  const truncated = candidates.length > LIMIT;
  const runs = new Map(), available = new Set();
  for (const table of TABLES) {
    const profile = H.profileFor('trade', table);
    const sources = await tx.queryAll(require('./persistence/statements/trade-insights').SOURCES, { scopeId, profileHash: profile.fingerprint, limit: 100 });
    for (const run of sources.filter(run => ['applied', 'purged'].includes(run.status) && run.manifest.sourceInstance === INSTANCE)) {
      const expected = protection.digest(['run', C.VERSION, { scopeId: run.scopeId, ownerId: run.ownerId }, profile.fingerprint, run.manifest, run.attemptId]);
      if (run.scopeId !== scopeId || run.id !== expected || !C.equal(run.profile, profile) || run.receivedCount !== run.manifest.expectedRows) C.fail('IMPORT_HISTORY_INTEGRITY');
      runs.set(run.id, run); available.add(table);
    }
  }
  if (!available.has('BESTELLDETAILS') || !available.has('BESTELLUNGEN')) return result;
  const documents = new Map();
  let incomplete = false;
  async function readRecords(records) {
    records = [...new Map(records.filter(Boolean).filter(record => !documents.has(record.id)).map(record => [record.id, record])).values()];
    const requests = records.map(record => ({ recordId: record.id, revision: record.revision }));
    const versions = await prefetch(tx, I.version, requests), segments = new Map();
    for (let offset = 0; offset < requests.length; offset += C.LIMITS.batch) {
      const part = requests.slice(offset, offset + C.LIMITS.batch);
      for (const segment of await tx.queryAll(S.internalSegments, { requests: part })) {
        C.integer(segment.batchOrdinal, 1, part.length);
        const expected = part[segment.batchOrdinal - 1];
        if (segment.recordId !== expected.recordId || segment.revision !== expected.revision || segment.dataClass !== 'internal_business'
          || segments.has(segment.recordId)) C.fail('IMPORT_HISTORY_INTEGRITY');
        segments.set(segment.recordId, segment);
      }
    }
    for (let index = 0; index < records.length; index++) {
      const record = records[index], version = versions[index], segment = segments.get(record.id);
      const profile = narrowProfiles.get(record.sourceTable), original = profile && H.profileFor('trade', record.sourceTable);
      if (!profile || record.scopeId !== scopeId || record.source !== 'trade' || record.sourceInstance !== INSTANCE || record.profileHash !== original.fingerprint
        || !version || !segment || version.revision !== record.revision || version.masterSourceInstance !== 'tradefoto-trade') C.fail('IMPORT_HISTORY_INTEGRITY');
      const context = versionContext(record, version), meta = protection.open(version.payload, context);
      C.exact(meta, ['references', 'dependencyToken', 'dataHash', 'restoredFromRevision']);
      C.sha(meta.dependencyToken); C.sha(meta.dataHash);
      const values = protection.open(segment.payload, [...context, 'segment', 'internal_business']);
      C.exact(values, profile.fields.map(field => field.target));
      const fields = Object.fromEntries(profile.fields.map(field => [field.source, values[field.target]]));
      const normalized = C.normalizeDataImportRow(profile, fields);
      if (!C.equal(normalized.data, values) || H.historyIdentity(protection, record, 'trade', record.sourceTable, normalized.key) !== record.identityHash) C.fail('IMPORT_HISTORY_INTEGRITY');
      const run = runs.get(version.runId);
      // Very old, reverted or unfinished runs are not inferred from history.
      if (!run || run.profileHash !== record.profileHash || run.ownerId !== version.importedBy || run.manifest.fileSha256 !== version.fileSha256
        || run.manifest.snapshotAt !== version.snapshotAt) { incomplete = true; documents.set(record.id, null); continue; }
      documents.set(record.id, { record, fields: normalized.source, sourceAt: version.snapshotAt });
    }
  }
  const records = await prefetch(tx, I.get, candidates.slice(0, LIMIT).map(row => ({ scopeId, id: row.id })));
  if (records.some((record, index) => !record || record.revision !== candidates[index].revision)) C.fail('IMPORT_HISTORY_INTEGRITY');
  await readRecords(records);
  const selected = records.map(record => documents.get(record.id)).filter(Boolean);
  if (selected.some(value => value.fields.EAN !== article.sourceArticleKey)) C.fail('IMPORT_HISTORY_INTEGRITY');
  const identity = (table, value) => H.historyIdentity(protection, { scopeId, sourceInstance: INSTANCE }, 'trade', table, [key(value)]);
  async function parents(table, values) {
    const keys = [...new Set(values.map(key).filter(Boolean))];
    const parents = await prefetch(tx, I.find, keys.map(value => ({ scopeId, identityHash: identity(table, value) })));
    if (parents.some((record, index) => record && (record.sourceTable !== table || record.identityHash !== identity(table, keys[index])))) C.fail('IMPORT_HISTORY_INTEGRITY');
    if (parents.some(record => !record)) incomplete = true;
    await readRecords(parents);
    return new Map(keys.map((value, index) => [value, parents[index] ? documents.get(parents[index].id) : null]));
  }
  const distributions = selected.filter(value => value.record.sourceTable === 'BestellVerteilung');
  const details = await parents('BESTELLDETAILS', distributions.map(value => value.fields.BestellId));
  for (const value of selected.filter(value => value.record.sourceTable === 'BESTELLDETAILS')) details.set(key(value.fields.BestellId), value);
  const heads = await parents('BESTELLUNGEN', [...details.values()].filter(Boolean).map(value => value.fields.BestellNr));
  const allocated = new Set(distributions.map(value => key(value.fields.BestellId))), contributions = new Map();
  const problem = row => { if (row) row.orders.state = 'review'; };
  for (const row of visible.values()) row.orders = { ...initial('recorded'), truncated, state: truncated || incomplete ? 'review' : 'recorded' };
  function add(row, value, detail, head, ordered, delivered) {
    if (!row) return;
    if (!detail || !head || detail.fields.EAN !== article.sourceArticleKey || key(detail.fields.BestellNr) !== key(head.fields.BestellNr)
      || value.fields.EAN !== article.sourceArticleKey || key(value.fields.BestellNr) !== key(head.fields.BestellNr)) { problem(row); return; }
    if (head.fields.erledigt === true) return;
    const supply = supplyState(ordered, delivered);
    if (['quantity_fulfilled', 'zero_order'].includes(supply.state)) return;
    const valid = head.fields.erledigt === false && ['partial_quantity', 'undelivered_quantity'].includes(supply.state);
    if (!valid) problem(row);
    const sourceAt = [value.sourceAt, detail.sourceAt, head.sourceAt].sort()[0];
    const itemKey = row.id + ':' + key(head.fields.BestellNr), previous = contributions.get(itemKey);
    contributions.set(itemKey, { row, number: key(head.fields.BestellNr), sourceAt: previous && previous.sourceAt < sourceAt ? previous.sourceAt : sourceAt,
      state: valid && (!previous || previous.state === 'recorded') ? 'recorded' : 'review',
      remaining: valid && (!previous || previous.remaining !== null) ? D.add(previous?.remaining || '0', supply.remaining) : null });
  }
  for (const value of distributions) {
    const detail = details.get(key(value.fields.BestellId)), head = detail && heads.get(key(detail.fields.BestellNr));
    add(visible.get(branchKey(value.fields.FilialID)), value, detail, head, value.fields.Menge, value.fields.GelMenge);
  }
  for (const detail of details.values()) {
    if (!detail || allocated.has(key(detail.fields.BestellId))) continue;
    const head = heads.get(key(detail.fields.BestellNr)), row = head && visible.get(branchKey(head.fields.LFilialID));
    // A bounded cut or absent allocation import cannot establish absence of a
    // distribution. Never substitute the delivery branch for missing demand.
    if (truncated || incomplete || !available.has('BestellVerteilung') || detail.fields.Verteiler !== false) { problem(row); continue; }
    add(row, detail, detail, head, detail.fields.BMenge, detail.fields.gMenge);
  }
  for (const { row, ...item } of contributions.values()) row.orders.items.push(item);
  for (const row of visible.values()) {
    const orders = row.orders;
    orders.items.sort((a, b) => b.sourceAt.localeCompare(a.sourceAt) || a.number.localeCompare(b.number, 'de', { numeric: true }));
    orders.sourceAt = orders.items.length ? orders.items.map(item => item.sourceAt).sort()[0] : null;
    if (orders.items.length > ITEM_LIMIT) { orders.items = orders.items.slice(0, ITEM_LIMIT); orders.truncated = true; orders.state = 'review'; }
    if (row.ordered !== null && orders.state === 'recorded') {
      orders.matched = D.compare(row.ordered, orders.items.reduce((sum, item) => D.add(sum, item.remaining), '0')) === 0;
      if (!orders.matched) orders.state = 'review';
    }
  }
  return result;
}
module.exports = { loadSalesArticleBranchOrders, LIMIT, ITEM_LIMIT };

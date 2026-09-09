'use strict';
// Immutable, whole-source cash candidates. This repository does not activate
// sales, infer GP mappings, expose private source fields or edit history rows.
const crypto = require('node:crypto');
const C = require('../../data-import-contract');
const H = require('../../tradefoto-history-profiles');
const { historyBusinessDate } = require('../../sales-history-query');
const { assertPersistenceAccess } = require('../contract');
const { CASH_SNAPSHOT_STATEMENTS: S, CASH_SNAPSHOT_TABLES: TABLES } = require('../statements/cash-snapshots');
const { sourceToleranceRegistry, acceptSourceTolerances, effectiveSourceGates } = require('../../data-import-source-tolerance');
const FORMAT = 'cash-compact-v1', EMPTY = '0'.repeat(64), REVIEW_ROWS = 2000;
const INDEX_FIELDS = Object.freeze({ locationKey: ['Filialid', 'Filiale', 'FilialId'], sellerKey: ['VerkäuferID', 'Verkäuferid'],
  customerKey: ['KUND_NR'], articleKey: ['EAN'] });
const hex = value => value === null ? null : Buffer.from(value).toString('hex');
const rowMeta = row => [row.sourceRow, hex(row.sourceKey), row.businessDate, row.parentRow,
  ...Object.keys(INDEX_FIELDS).map(field => hex(row[field]))];
const metadataContext = row => [FORMAT, 'dataset', row.slot, row.id, row.scopeId, row.ownerId, row.revision, row.createdAt];
const rowContext = (dataset, table, row) => [FORMAT, 'row', dataset.id, dataset.scopeId, table.profile.fingerprint, rowMeta(row)];
const chain = (previous, ordinal, values) => crypto.createHash('sha256').update(previous).update(C.canonical([ordinal, values])).digest('hex');
const tableFor = name => { const table = TABLES.find(t => t.name === name); if (!table) C.fail('IMPORT_PROFILE_UNAVAILABLE'); return table; };
const same = (a, b) => { if (!C.equal(a, b)) C.fail('IMPORT_SOURCE_INTEGRITY'); };
const one = async (tx, statement, params) => { if ((await tx.execute(statement, params)).rowsAffected !== 1) C.fail('IMPORT_CONCURRENT_CHANGE', 409); };
function createCashSnapshotStore({ access, protection, actor, check = async () => {}, sourceTolerances = [], clock = () => new Date().toISOString() }) {
  assertPersistenceAccess(access); C.id(actor.scopeId); C.id(actor.ownerId);
  const registry = sourceToleranceRegistry(sourceTolerances);
  const identity = (table, key) => Buffer.from(protection.digest([FORMAT, 'source-key', actor.scopeId, table.name, key]), 'hex');
  function normalize(table, row, dataset, ordinal) {
    const result = C.normalizeDataImportRow(table.profile, row);
    if (!table.keys) {
      same(result.source._source_snapshot_sha256, dataset.fileSha256);
      same(result.source._source_row, ordinal);
    }
    return result;
  }
  function decode(dataset, table, row) {
    const values = protection.open(row.payload, rowContext(dataset.row, table, row));
    if (!Array.isArray(values) || values.length !== table.columns.length) C.fail('IMPORT_SOURCE_INTEGRITY');
    const source = Object.fromEntries(table.columns.map((c, i) => [c.name, values[i]]));
    const prepared = H.prepareTradeFotoHistoryRow('cash', table.name, source, { fileSha256: dataset.data.fileSha256, rowNumber: row.sourceRow });
    const normalized = normalize(table, prepared, dataset.data, row.sourceRow);
    same(hex(row.sourceKey), hex(identity(table, normalized.key)));
    same(values, table.columns.map(c => normalized.source[c.name]));
    return { values, normalized };
  }
  async function load(tx, id) {
    C.sha(id);
    const row = await tx.queryOne(S.get, { id, ...actor });
    if (!row) C.fail('IMPORT_SOURCE_NOT_FOUND', 404);
    const data = protection.open(row.payload, metadataContext(row));
    if (data.format !== FORMAT || data.scope !== 'full' || data.tables.length !== TABLES.length) C.fail('IMPORT_SOURCE_INTEGRITY');
    same(data.tables.map(t => [t.name, t.profileHash]), TABLES.map(t => [t.name, t.profile.fingerprint]));
    return { row, data };
  }
  async function save(tx, dataset) {
    const { row, data } = dataset;
    await one(tx, S.update, { slot: row.slot, revision: row.revision, payload: protection.seal(data, metadataContext({ ...row, revision: row.revision + 1 })) });
    dataset.row = { ...row, revision: row.revision + 1 };
  }
  async function transaction(action, work) {
    // Refresh may query the same provider. Only the bound executor may be used
    // inside a transaction, so refresh immediately before and after each batch.
    // A revoked session receives no response and cannot advance the next batch;
    // the bounded encrypted staging batch never activates business data.
    await check(action);
    const result = await access.transaction(work, { isolation: 'serializable', readOnly: action === 'read' });
    await check(action); return result;
  }
  function summarize(dataset) {
    const { row, data } = dataset;
    return { id: row.id, revision: row.revision, storage: FORMAT, scope: 'full', complete: data.complete, status: data.status,
      sourceValueCopies: 1, businessActivationEnabled: false, verifiedRows: data.tables.reduce((n, t) => n + t.verifiedRows, 0),
      tables: data.tables.map(t => ({ name: t.name, profileHash: t.profileHash, declaredRows: t.declaredRows,
        run: { id: protection.digest([FORMAT, 'table-run', row.id, t.name]), revision: row.revision,
          status: t.verified ? (effectiveSourceGates(t.manifest, tableFor(t.name).profile, registry).length ? 'needs_review' : 'ready') : t.complete ? 'reviewing' : 'staging',
          expectedRows: t.expectedRows, receivedRows: t.receivedRows, verifiedRows: t.verifiedRows,
          counts: { invalid: 0, conflict: 0 }, gates: t.manifest ? effectiveSourceGates(t.manifest, tableFor(t.name).profile, registry) : [],
          acceptedDeviations: t.manifest?.acceptedDeviations || [] } })),
    };
  }
  return Object.freeze({
    // Internal adapter uses the same decoder as full import/restore verification.
    reader: Object.freeze({ load, decode, identity }),
    async begin(id, manifest) {
      C.sha(id); C.sha(manifest.fileSha256); C.integer(manifest.bytes, 4096, 512 * 1024 * 1024);
      same(manifest.kind, 'cash');
      same(manifest.tables.map(t => [t.name, t.profileHash]), TABLES.map(t => [t.name, t.profile.fingerprint]));
      for (const table of manifest.tables) C.integer(table.declaredRows, 0, C.LIMITS.rows);
      if (manifest.tables.reduce((n, t) => n + t.declaredRows, 0) > C.LIMITS.rows) C.fail('IMPORT_SOURCE_ROWS_LIMIT');
      return transaction('prepare', async tx => {
        if (await tx.queryOne(S.get, { id, ...actor })) {
          const existing = await load(tx, id);
          same([existing.data.fileSha256, existing.data.bytes, existing.data.tables.map(t => [t.name, t.declaredRows])],
            [manifest.fileSha256, manifest.bytes, manifest.tables.map(t => [t.name, t.declaredRows])]);
          return summarize(existing);
        }
        const row = { id, ...actor, slot: (await tx.queryOne(S.nextSlot, {})).slot, revision: 1, createdAt: C.utc(clock()) };
        const data = { format: FORMAT, scope: 'full', fileSha256: manifest.fileSha256, bytes: manifest.bytes,
          status: 'reading', complete: false, tables: manifest.tables.map(t => ({ ...t, expectedRows: null, receivedRows: 0,
            verifiedRows: 0, sourceHash: EMPTY, verifiedHash: EMPTY, complete: false, verified: false, manifest: null })) };
        await one(tx, S.insert, { ...row, payload: protection.seal(data, metadataContext(row)) });
        return summarize({ row, data });
      });
    },
    async startTable(id, name, expectedRows) {
      const table = tableFor(name); C.integer(expectedRows, 0, C.LIMITS.rows);
      return transaction('prepare', async tx => {
        const dataset = await load(tx, id), state = dataset.data.tables.find(t => t.name === name);
        if (state.expectedRows !== null) { same(state.expectedRows, expectedRows); return summarize(dataset); }
        if (dataset.data.complete || dataset.data.tables.slice(0, TABLES.indexOf(table)).some(t => !t.complete)) C.fail('IMPORT_SOURCE_PROTOCOL_INVALID');
        state.expectedRows = expectedRows;
        state.manifest = acceptSourceTolerances({ sourceInstance: 'tradefoto-cash', fileSha256: dataset.data.fileSha256,
          schemaSha256: table.profile.schemaSha256, expectedRows, declaredRows: state.declaredRows,
          gates: state.declaredRows === expectedRows ? [] : ['SOURCE_ROW_COUNT_MISMATCH'] }, table.profile, registry);
        if (dataset.data.tables.reduce((n, t) => n + (t.expectedRows || 0), 0) > C.LIMITS.rows) C.fail('IMPORT_SOURCE_ROWS_LIMIT');
        await save(tx, dataset); return summarize(dataset);
      });
    },
    async append(id, name, startRow, rows) {
      const table = tableFor(name); C.integer(startRow, 1, C.LIMITS.rows);
      if (!Array.isArray(rows) || !rows.length || rows.length > C.LIMITS.batch) C.fail('IMPORT_BATCH_INVALID');
      return transaction('prepare', async tx => {
        const dataset = await load(tx, id), state = dataset.data.tables.find(t => t.name === name), datasetSlot = dataset.row.slot;
        if (state.expectedRows === null || startRow > state.receivedRows + 1 || startRow + rows.length - 1 > state.expectedRows) C.fail('IMPORT_SOURCE_PROTOCOL_INVALID');
        let changed = false;
        for (let i = 0; i < rows.length; i++) {
          const sourceRow = startRow + i, normalized = normalize(table, rows[i], dataset.data, sourceRow);
          const values = table.columns.map(c => normalized.source[c.name]);
          if (sourceRow <= state.receivedRows) {
            const existing = await tx.queryOne(table.statements.row, { datasetSlot, sourceRow });
            if (!existing) C.fail('IMPORT_SOURCE_INTEGRITY');
            same(decode(dataset, table, existing).values, values); continue;
          }
          if (state.complete || dataset.data.complete) C.fail('IMPORT_STATE_CONFLICT', 409);
          const row = { datasetSlot, sourceRow, sourceKey: identity(table, normalized.key),
            businessDate: historyBusinessDate('cash', name, normalized.data, H), parentRow: null };
          const request = H.historyParentRequest('cash', name, normalized.data);
          if (request) {
            const parent = tableFor(request.name), record = await tx.queryOne(parent.statements.key, { datasetSlot, sourceKey: identity(parent, request.key) });
            if (!record) C.fail('IMPORT_HISTORY_PARENT_MISSING', 409);
            decode(dataset, parent, record); row.parentRow = record.sourceRow;
          }
          for (const [field, candidates] of Object.entries(INDEX_FIELDS)) {
            const sourceName = candidates.find(n => Object.hasOwn(normalized.source, n)), value = normalized.source[sourceName];
            row[field] = value === null || value === undefined || value === '' || value === '0' ? null
              : Buffer.from(protection.digest([FORMAT, 'source-reference', actor.scopeId, field, String(value)]), 'hex');
          }
          await one(tx, table.statements.insert, { ...row, payload: protection.seal(values, rowContext(dataset.row, table, row)) });
          state.sourceHash = chain(state.sourceHash, sourceRow, values); state.receivedRows++; changed = true;
        }
        if (changed) await save(tx, dataset);
        return summarize(dataset);
      });
    },
    async finishTable(id, name) {
      tableFor(name);
      return transaction('prepare', async tx => {
        const dataset = await load(tx, id), state = dataset.data.tables.find(t => t.name === name);
        if (state.expectedRows === null || state.receivedRows !== state.expectedRows) C.fail('IMPORT_SOURCE_INCOMPLETE');
        if (!state.complete) { state.complete = true; await save(tx, dataset); }
        return summarize(dataset);
      });
    },
    async seal(id, { rows, tables }) {
      return transaction('prepare', async tx => {
        const dataset = await load(tx, id);
        if (tables !== TABLES.length || dataset.data.tables.some(t => !t.complete) || rows !== dataset.data.tables.reduce((n, t) => n + t.receivedRows, 0)) C.fail('IMPORT_SOURCE_INCOMPLETE');
        if (!dataset.data.complete) { dataset.data.complete = true; dataset.data.status = 'reviewing'; await save(tx, dataset); }
        return summarize(dataset);
      });
    },
    async review(id) {
      return transaction('prepare', async tx => {
        const dataset = await load(tx, id);
        if (!dataset.data.complete) C.fail('IMPORT_SOURCE_INCOMPLETE');
        const inventory = await tx.queryAll(S.inventory, { datasetSlot: dataset.row.slot });
        same(inventory.length, TABLES.length);
        dataset.data.tables.forEach((t, i) => {
          same(inventory[i].tableIndex, i);
          same(inventory[i].rowCount, t.expectedRows);
          if (t.verified) same(inventory[i].generation, t.verifiedGeneration ?? 0);
        });
        const state = dataset.data.tables.find(t => !t.verified);
        if (!state) return summarize(dataset);
        const table = tableFor(state.name), datasetSlot = dataset.row.slot;
        const generation = inventory[TABLES.indexOf(table)].generation;
        if (state.verifiedGeneration === undefined) state.verifiedGeneration = generation;
        same(state.verifiedGeneration, generation);
        const rows = await tx.queryAll(table.statements.page, { datasetSlot, after: state.verifiedRows, limit: REVIEW_ROWS });
        for (const row of rows) {
          if (row.sourceRow !== state.verifiedRows + 1) C.fail('IMPORT_SOURCE_INTEGRITY');
          const { values } = decode(dataset, table, row);
          state.verifiedHash = chain(state.verifiedHash, row.sourceRow, values); state.verifiedRows++;
        }
        if (state.verifiedRows === state.expectedRows) {
          same(state.verifiedHash, state.sourceHash);
          same((await tx.queryOne(table.statements.count, { datasetSlot })).count, state.expectedRows);
          state.verified = true;
        } else if (!rows.length || state.verifiedRows > state.expectedRows) C.fail('IMPORT_SOURCE_INTEGRITY');
        if (dataset.data.tables.every(t => t.verified)) dataset.data.status = dataset.data.tables.some(t => effectiveSourceGates(t.manifest, tableFor(t.name).profile, registry).length) ? 'needs_review' : 'ready';
        await save(tx, dataset); return summarize(dataset);
      });
    },
    async summary(id) { return transaction('read', async tx => summarize(await load(tx, id))); },
    async preview(id, name, { after = 0, limit = 50 } = {}) {
      const table = tableFor(name); C.integer(after, 0, C.LIMITS.rows); C.integer(limit, 1, 100);
      return transaction('read', async tx => {
        const dataset = await load(tx, id), state = dataset.data.tables.find(t => t.name === name);
        const rows = await tx.queryAll(table.statements.page, { datasetSlot: dataset.row.slot, after, limit });
        return { rows: rows.map(row => ({ rowNumber: row.sourceRow, state: row.sourceRow <= state.verifiedRows ? 'verified' : 'staged' })) };
      });
    },
    // Restore qualification rechecks every immutable value. It does not merely
    // trust the persisted success flag from the original database.
    async reverify(id) {
      return transaction('prepare', async tx => {
        const dataset = await load(tx, id); if (!dataset.data.complete) C.fail('IMPORT_SOURCE_INCOMPLETE');
        for (const state of dataset.data.tables) { state.verified = false; state.verifiedRows = 0; state.verifiedHash = EMPTY; delete state.verifiedGeneration; }
        dataset.data.status = 'reviewing'; await save(tx, dataset); return summarize(dataset);
      });
    },
  });
}
module.exports = { createCashSnapshotStore, CASH_SNAPSHOT_FORMAT: FORMAT, CASH_SNAPSHOT_REVIEW_ROWS: REVIEW_ROWS };

'use strict';
const C = require('../../data-import-contract');
const H = require('../../tradefoto-history-profiles');
const { CASH_PUBLICATION_STATEMENTS: S } = require('../statements/cash-publications');
const { CASH_SNAPSHOT_TABLES: TABLES } = require('../statements/cash-snapshots');
const { defineTradeFotoReceiptCoverage, reconcileTradeFotoReceipt } = require('../../tradefoto-sales-rules');
// This adapter reads immutable compact rows directly. It writes no generic
// history, undo copies, or duplicated customer/receipt payloads.
function createCashHistoryBackend({ publication, publications, scopeId }) {
  const { row: pub, data, dataset, reader, policy } = publication;
  const verifiedFilters = new Set();
  const rowId = (table, ordinal) => 'c' + TABLES.indexOf(table) + '-' + pub.id + '-' + String(ordinal).padStart(10, '0');
  function parseId(id, table) {
    const prefix = 'c' + TABLES.indexOf(table) + '-' + pub.id + '-';
    if (!id.startsWith(prefix) || !/^\d{10}$/.test(id.slice(prefix.length))) C.fail('IMPORT_HISTORY_CURSOR');
    return C.integer(Number(id.slice(prefix.length)), 1, C.LIMITS.rows);
  }
  async function decoded(tx, table, sourceRow) {
    const row = await tx.queryOne(table.statements.row, { datasetSlot: dataset.row.slot, sourceRow });
    if (!row) C.fail('IMPORT_HISTORY_INTEGRITY');
    return { row, ...reader.decode(dataset, table, row) };
  }
  return Object.freeze({
    source: { id: 'compact-cash', scopeId, sourceInstance: 'tradefoto-cash', label: data.label,
      locations: data.locations, snapshots: [{ id: data.fileSha256, label: data.label }],
      coverageLabel: 'Historischer Kassenstand · bereitgestellt am ' + dataset.row.createdAt.slice(0, 10), coverageRevision: pub.id },
    policy,
    async epoch(tx) {
      const current = await publications.state(tx);
      if (current.data.active !== pub.id) C.fail('IMPORT_HISTORY_RESULTS_CHANGED', 409);
      return [pub.id, current.row.revision, dataset.row.revision];
    },
    async search(tx, p) {
      for (const kind of ['FILIALEN', ...(p.sellerId ? ['MITARBEITER'] : []), ...(p.customerId ? ['KUNDEN'] : [])]) {
        if (!verifiedFilters.has(kind)) { await publications.verifyFilterBindings(tx, publication, kind); verifiedFilters.add(kind); }
      }
      const table = TABLES.find(t => t.name === p.sourceTable);
      if (!table || !S.search[table.name]) C.fail('IMPORT_HISTORY_KIND');
      if (p.snapshot && p.snapshot !== data.fileSha256) C.fail('IMPORT_HISTORY_SNAPSHOT_UNKNOWN');
      const rows = await tx.queryAll(S.search[table.name], { publicationId: pub.id, datasetSlot: dataset.row.slot,
        dateFrom: p.dateFrom, dateTo: p.dateTo, afterDate: p.afterDate, afterRow: p.afterId === '~' ? C.LIMITS.rows + 1 : parseId(p.afterId, table),
        locationId: p.locationId === 'unassigned' ? null : p.locationId, unassigned: p.unassigned,
        sellerId: p.sellerId || null, sellerMode: p.sellerMode, sellerRole: p.sellerRole, customerId: p.customerId || null, limit: p.limit });
      return rows.map(r => ({ id: rowId(table, r.sourceRow), businessDate: r.businessDate }));
    },
    service(tx, authorize) {
      const cache = new Map();
      async function loadId(id) {
        if (cache.has(id)) return cache.get(id);
        const table = TABLES[Number(id?.[1])];
        if (!table || !/^c\d-/.test(id)) C.fail('IMPORT_HISTORY_NOT_FOUND', 404);
        const entry = { table, ...await decoded(tx, table, parseId(id, table)) };
        cache.set(id, entry); return entry;
      }
      const allowed = async (table, action, dataClasses = [], extra = {}) => await authorize({ scopeId, source: 'cash', sourceInstance: 'tradefoto-cash', sourceTable: table.name, action, dataClasses, ...extra });
      async function references(entry) {
        const requests = H.historyReferenceRequests('cash', entry.table.name, entry.normalized.data);
        if (entry.table.name === 'Umsatz_Kasse_Details') {
          const table = TABLES.find(t => t.name === 'Umsatz_KASSE'), parent = await decoded(tx, table, entry.row.parentRow);
          requests.push(...H.historyReferenceRequests('cash', table.name, parent.normalized.data).filter(r => ['header_seller', 'customer'].includes(r.role)));
        }
        const kinds = { FILIALEN: 'location', MITARBEITER: 'employee', ARTIKEL_STAMM: 'sales_article', KUNDEN: 'crm_customer' };
        const refs = [];
        for (const r of requests) refs.push({ role: r.role, dataClass: r.dataClass, targetKind: kinds[r.table],
          ...await publications.reference(tx, pub.id, r.table, r.key?.[0] ?? null) });
        return refs;
      }
      async function scope(entry, refs) {
        if (!await allowed(entry.table, 'history.scope', [], { locations: refs.filter(r => r.targetKind === 'location') })) C.fail('IMPORT_FORBIDDEN', 403);
      }
      return Object.freeze({
        async children(id) {
          const head = await loadId(id);
          if (head.table.name !== 'Umsatz_KASSE' || !await allowed(head.table, 'history.reconcile')) C.fail('IMPORT_FORBIDDEN', 403);
          await scope(head, await references(head));
          const table = TABLES.find(t => t.name === 'Umsatz_Kasse_Details');
          const rows = await tx.queryAll(table.statements.children, { datasetSlot: dataset.row.slot, parentRow: head.row.sourceRow, limit: 1001 });
          if (rows.length > 1000) C.fail('IMPORT_SALES_LINES_LIMIT');
          for (const row of rows) cache.set(rowId(table, row.sourceRow), { table, row, ...reader.decode(dataset, table, row) });
          return rows.map(row => rowId(table, row.sourceRow));
        },
        async detail(id) {
          const entry = await loadId(id), refs = await references(entry); await scope(entry, refs);
          const fields = {}, safeRefs = [], grants = new Map();
          async function grant(kind) { if (!grants.has(kind)) grants.set(kind, await allowed(entry.table, 'history.read', [kind])); return grants.get(kind); }
          for (const column of entry.table.columns) if (await grant(column.dataClass)) fields[column.name] = entry.normalized.source[column.name];
          for (const ref of refs) if (await grant(ref.dataClass) && await allowed(entry.table, 'history.reference', [ref.dataClass], { targetKind: ref.targetKind, targetId: ref.targetId })) safeRefs.push(ref);
          const parent = entry.table.name === 'Umsatz_Kasse_Details' ? TABLES.find(t => t.name === 'Umsatz_KASSE') : null;
          return { id, revision: 1, table: entry.table.name, fields, references: safeRefs,
            provenance: { businessDate: entry.row.businessDate, fileSha256: data.fileSha256, importedAt: dataset.row.createdAt,
              snapshotAt: dataset.row.createdAt, parentId: parent ? rowId(parent, entry.row.parentRow) : null } };
        },
        async receipt(id) {
          const head = await loadId(id);
          if (head.table.name !== 'Umsatz_KASSE' || !await allowed(head.table, 'history.reconcile')) C.fail('IMPORT_FORBIDDEN', 403);
          await scope(head, await references(head));
          const table = TABLES.find(t => t.name === 'Umsatz_Kasse_Details');
          const rows = await tx.queryAll(table.statements.children, { datasetSlot: dataset.row.slot, parentRow: head.row.sourceRow, limit: 1001 });
          if (rows.length > 1000) C.fail('IMPORT_SALES_LINES_LIMIT');
          const lines = rows.map(row => ({ source: reader.decode(dataset, table, row).normalized.source, parentRevision: 1 }));
          const state = dataset.data.tables.find(t => t.name === table.name);
          const coverage = defineTradeFotoReceiptCoverage({ scopeId, sourceInstance: 'tradefoto-cash', fileSha256: data.fileSha256,
            schemaSha256: table.profile.schemaSha256, evidenceSha256: data.sourceEvidence,
            expectedSourceRows: state.expectedRows, verifiedSourceRows: state.verifiedRows, head: head.normalized.source, lines: lines.map(l => l.source) });
          return reconcileTradeFotoReceipt({ head: head.normalized.source, lines, headRevision: 1, snapshotDate: dataset.row.createdAt.slice(0, 10),
            policy, coverage, scopeId, sourceInstance: 'tradefoto-cash' });
        },
      });
    },
  });
}
module.exports = { createCashHistoryBackend };

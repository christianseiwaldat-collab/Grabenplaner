"use strict";
// Bounded synthetic comparison through the real TradeFoto master/history writers.
// No source ACCDB, production DB, production key or extrapolated capacity claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('../lib/data-import-contract');
const M = require('../lib/tradefoto-master-profiles');
const H = require('../lib/tradefoto-history-profiles');
const { createDataImportEngine } = require('../lib/data-import-engine');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createDataImportRepository } = require('../lib/persistence/repositories/data-import');
const { createImportMasterWriters } = require('../lib/persistence/repositories/import-master-data');
const { createImportHistoryWriters } = require('../lib/persistence/repositories/import-history');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { SQLITE_APPLICATION_CATALOG } = require('../lib/persistence/sqlite/application-catalog');
const { ensureSqliteDataImportRuntimeSchema } = require('../lib/persistence/sqlite/operations/data-import-runtime-schema');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const raw = (source, table, values) => ({ ...Object.fromEntries((source === 'master' ? M.tableFor(table) : H.tableFor(source, table)).columns.map(c => [c.name, null])), ...values });

async function compareMode(directory, sharedPayloads, noteBytes, compression = false) {
  const started = Date.now();
  const file = path.join(directory, `${compression ? 'compressed-' : ''}${sharedPayloads ? 'shared' : 'legacy'}-${noteBytes}.db`);
  const app = openSqliteApplicationPersistence({ databasePath: file, catalog: SQLITE_APPLICATION_CATALOG });
  ensureSqliteDataImportRuntimeSchema(app.database);
  app.database.exec('CREATE TABLE audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity_type TEXT, entity_id TEXT, detail TEXT, created_at TEXT);');
  const protection = createDataImportProtection({ encryptionKey: crypto.randomBytes(32), indexKey: crypto.randomBytes(32), keyId: 'synthetic-comparison', compression });
  let day = 0;
  const composition = { protection, getActor: () => ({ scopeId: 'synthetic-comparison', ownerId: 'test' }),
    authorize: () => true, clock: () => `2026-09-0${5 + day}T10:00:00.000Z` };
  const engine = createDataImportEngine({ ...composition, repository: createDataImportRepository(app.provider), sharedPayloads,
    profiles: [...M.TRADEFOTO_MASTER_PROFILES, ...H.TRADEFOTO_HISTORY_PROFILES],
    writers: { ...createImportMasterWriters({ protection }), ...createImportHistoryWriters({ ...composition, resolveMasterSourceInstance: () => 'trade-source' }) } });
  const runs = [];
  async function ingest(source, table, rows) {
    const master = source === 'master', profile = master ? M.profileFor(table) : H.profileFor(source, table);
    const fileSha256 = hash('synthetic-source-' + day);
    let run = await engine.start({ profileHash: profile.fingerprint, manifest: {
      sourceInstance: source === 'cash' ? 'cash-source' : 'trade-source', fileSha256,
      schemaSha256: profile.schemaSha256, expectedRows: rows.length, declaredRows: rows.length,
      snapshotAt: composition.clock(), gates: [],
    } });
    const prepared = rows.map((row, i) => master
      ? M.prepareTradeFotoMasterRow(table, row, { fileSha256, rowNumber: i + 1 })
      : H.prepareTradeFotoHistoryRow(source, table, row, { fileSha256, rowNumber: i + 1 }));
    for (let i = 0; i < prepared.length; i += C.LIMITS.batch) {
      run = await engine.stage(run.id, { expectedRevision: run.revision, startRow: i + 1, rows: prepared.slice(i, i + C.LIMITS.batch) });
    }
    run = await engine.seal(run.id, run.revision);
    do { run = await engine.review(run.id, run.revision); } while (run.status === 'reviewing');
    assert.equal(run.status, 'ready', `${table}: ${JSON.stringify(run.counts)}`);
    const previewCounts = run.counts;
    do { run = await engine.apply(run.id, run.revision); } while (run.status === 'applying');
    assert.equal(run.status, 'applied'); runs.push(run);
    return previewCounts;
  }
  const count = table => app.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  function measure() {
    app.database.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
    return { databaseBytes: fs.statSync(file).size,
      counts: Object.fromEntries(['data_import_runs', 'data_import_rows', 'data_import_changes',
        'import_master_records', 'import_history_records', 'import_history_versions'].map(table => [table, count(table)])),
      payloadBlocks: count('data_import_payload_blocks') };
  }
  try {
    let first, next;
    for (day = 0; day < 2; day++) {
      await ingest('master', 'FILIALEN', [raw('master', 'FILIALEN', { FilialID: '1', FName: 'Synthetic' })]);
      const customers = await ingest('master', 'KUNDEN', Array.from({ length: 32 }, (_, i) => raw('master', 'KUNDEN', {
        KUND_NR: String(i + 1), VORNAME: 'Synthetic', NACHNAME: `Customer ${i + 1}`,
        INFO: 'x'.repeat(noteBytes - 1) + (day && i === 31 ? 'y' : 'x'),
      })));
      const keyless = await ingest('trade', 'Artikel_Ibestand', Array.from({ length: 8 }, (_, i) => raw('trade', 'Artikel_Ibestand', { Bestandstext: `Synthetic stock ${i + 1}` })));
      const receipts = await ingest('cash', 'Umsatz_KASSE', Array.from({ length: 8 }, (_, i) => raw('cash', 'Umsatz_KASSE', {
        Bonnr: String(i + 1), Filialid: '1', Kassenid: '1', Bondatum: '2026-09-04T00:00:00.000', RechnungsBetrag: '12',
      })));
      if (day === 0) first = measure();
      else {
        assert.equal(customers.unchanged, 31); assert.equal(customers.update, 1);
        assert.equal(receipts.unchanged, 8); assert.equal(keyless.create, 8);
        next = measure();
      }
    }
    assert.equal(next.counts.import_master_records, first.counts.import_master_records);
    assert.equal(next.counts.import_history_records, first.counts.import_history_records + 8);
    assert.equal(next.counts.data_import_runs, 2 * first.counts.data_import_runs);
    assert.equal(app.database.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.ok(app.database.prepare('PRAGMA integrity_check').all().every(r => Object.values(r)[0] === 'ok'));
    // Both source versions remain readable, including snapshot-bound keyless rows.
    for (const run of runs) assert.ok(await engine.detail(run.id, 1));
    return { first, followup: next, followupGrowthBytes: next.databaseBytes - first.databaseBytes, durationMs: Date.now() - started,
      retainedSourceVersions: true, actualBusinessChangeWindow: false, productionQualified: false };
  } finally { protection.destroy(); await app.provider.close(); app.database.close(); }
}

test('bounded first and follow-up imports measure actual TradeFoto writers with small, boundary and large payloads', async t => {
  const tmp = path.resolve(__dirname, '../tmp'); fs.mkdirSync(tmp, { recursive: true });
  const directory = fs.mkdtempSync(path.join(tmp, 'tradefoto-storage-comparison-'));
  try {
    for (const noteBytes of [100, 1000, 4096]) {
      const legacy = await compareMode(directory, false, noteBytes);
      const shared = await compareMode(directory, true, noteBytes);
      const compressed = await compareMode(directory, true, noteBytes, true);
      assert.deepEqual(shared.first.counts, legacy.first.counts);
      assert.deepEqual(shared.followup.counts, legacy.followup.counts);
      assert.deepEqual(compressed.followup.counts, legacy.followup.counts);
      assert.ok(compressed.followup.databaseBytes < legacy.followup.databaseBytes);
      // Report increases too: no assertion or filter manufactures a saving.
      t.diagnostic(JSON.stringify({ noteBytes, legacy, shared, compressed }));
    }
  } finally {
    assert.equal(path.dirname(fs.realpathSync(directory)), tmp);
    assert.match(path.basename(directory), /^tradefoto-storage-comparison-/);
    fs.rmSync(directory, { recursive: true });
  }
});

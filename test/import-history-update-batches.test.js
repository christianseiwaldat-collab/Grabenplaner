'use strict';
// Synthetic development fixtures only. The native group is deliberately opt-in;
// a skipped group is not a PostgreSQL or Linux execution claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const C = require('../lib/data-import-contract');
const H = require('../lib/tradefoto-history-profiles');
const M = require('../lib/tradefoto-master-profiles');
const Q = require('../lib/persistence/repositories/import-reader-cache');
const { supportsCoreImportReferences } = require('../lib/persistence/repositories/import-batch-support');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createImportHistoryWriters } = require('../lib/persistence/repositories/import-history');
const { createImportMasterWriters } = require('../lib/persistence/repositories/import-master-data');
const { IMPORT_HISTORY_STATEMENTS: S } = require('../lib/persistence/statements/import-history');
const { IMPORT_BATCHES: B } = require('../lib/persistence/statements/import-batches');
const { IMPORT_READER_BATCHES } = require('../lib/persistence/statements/import-reader-batches');
const { IMPORT_BATCH_CATALOG } = require('../lib/persistence/postgresql/sales/import-batches');

const TIME = '2026-10-15T12:00:00.000Z';
const DAY = '2026-10-15T00:00:00.000';
const actor = { scopeId: 'synthetic-history-update-batches', ownerId: '00001' };
const profile = H.profileFor('trade', 'BestellVerteilung');
const enabled = process.env.GP_PG_MIGRATION_LIVE === '1';
const nativeSkip = enabled ? false : 'Requires explicitly owned synthetic PostgreSQL Core/Sales fixtures (GP_PG_MIGRATION_LIVE=1)';
const code = expected => error => error?.code === expected;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const uuid = value => { const hex = sha(value); return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16)
  + '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32); };
const raw = (source, name, extra) => Object.fromEntries(H.tableFor(source, name).columns.map(column => [column.name, extra[column.name] ?? null]));
const normalize = (source, name, extra) => C.normalizeDataImportRow(H.profileFor(source, name), H.prepareTradeFotoHistoryRow(source, name, raw(source, name, extra)));
const distribution = (key, version = 'original') => normalize('trade', 'BestellVerteilung', {
  BestellNr: String(key), BestellId: String(key), FilialID: '18', EAN: '0000123',
  Artikelbezeichnung: 'Synthetic ' + version + ' article ' + key, Menge: version === 'original' ? 1 : 2,
});
const contextFor = (source, table, suffix = table) => {
  const selected = H.profileFor(source, table);
  return { ...actor, sourceInstance: 'synthetic-history-' + suffix, sourceSystem: selected.sourceSystem,
    sourceTable: table, profileHash: selected.fingerprint, fileSha256: sha('synthetic-file-' + suffix),
    snapshotAt: TIME, at: TIME, runId: sha('synthetic-run-' + suffix) };
};
const context = contextFor('trade', 'BestellVerteilung');
const packet = (count, version = 'updated', prefix = 'synthetic-history') => Array.from({ length: count }, (_, index) => ({
  id: uuid(prefix + '-' + (index + 1)), expectedRevision: 1, data: distribution(index + 1, version).data,
}));
const delegate = tx => Object.fromEntries(['queryOne', 'queryAll', 'execute'].map(method => [method, (statement, parameters) => tx[method](statement, parameters)]));
const readerBatch = statement => IMPORT_READER_BATCHES.find(entry => entry.source === statement).batch;
function composition(protection, overrides = {}) {
  return { protection, authorize: () => true, resolveMasterSourceInstance: () => 'synthetic-masters', ...overrides };
}
function protectedWriter(t, overrides = {}) {
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 71), indexKey: Buffer.alloc(32, 72), keyId: 'synthetic-test' });
  t.after(() => protection.destroy());
  return createImportHistoryWriters(composition(protection, overrides))[profile.entity];
}
const noIO = () => new Proxy({}, { get() { assert.fail('Invalid input must be rejected before persistence access'); } });

test('History update packets reject empty, oversized and duplicate target sets before I/O', async t => {
  const writer = protectedWriter(t);
  for (const inputs of [null, undefined, {}, [], packet(51)])
    await assert.rejects(writer.updateBatch(noIO(), inputs, context), code('IMPORT_BATCH_INVALID'));
  await assert.rejects(writer.updateBatch(noIO(), [packet(1)[0], packet(1)[0]], context), code('IMPORT_BATCH_INVALID'));
});

test('History update packets reject unsafe revisions and malformed exact DTOs before I/O', async t => {
  const writer = protectedWriter(t), first = packet(1)[0];
  for (const expectedRevision of [undefined, null, 0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER])
    await assert.rejects(writer.updateBatch(noIO(), [{ ...first, expectedRevision }], context), code('IMPORT_INTEGER_INVALID'));
  for (const input of [null, [], new Date(), { ...first, unexpected: true }, { id: first.id, expectedRevision: 1 }])
    await assert.rejects(writer.updateBatch(noIO(), [input], context), code('IMPORT_SHAPE_INVALID'));
  await assert.rejects(writer.updateBatch(noIO(), [{ ...first, id: '../not-an-import-id' }], context), code('IMPORT_ID_INVALID'));
});

test('History update packets normalize every candidate before the first read, including the final member', async t => {
  const writer = protectedWriter(t), inputs = packet(50);
  inputs[49] = { ...inputs[49], data: { ...inputs[49].data, unregisteredField: 'synthetic' } };
  await assert.rejects(writer.updateBatch(noIO(), inputs, context), code('IMPORT_SHAPE_INVALID'));
  const badData = structuredClone(packet(1)[0]);
  const quantity = profile.fields.find(field => field.source === 'Menge').target;
  badData.data[quantity] = '2.00'; // Valid source text would normalize, but target DTOs must already be canonical.
  await assert.rejects(writer.updateBatch(noIO(), [badData], context), code('IMPORT_HISTORY_INTEGRITY'));
});

test('History update packet contexts reject another table/profile and invalid provenance before I/O', async t => {
  const writer = protectedWriter(t);
  for (const patch of [{ sourceSystem: 'different' }, { sourceTable: 'Reparatur' }, { profileHash: 'f'.repeat(64) }])
    await assert.rejects(writer.updateBatch(noIO(), packet(1), { ...context, ...patch }), code('IMPORT_HISTORY_CONTEXT_INVALID'));
  for (const field of ['runId', 'fileSha256'])
    await assert.rejects(writer.updateBatch(noIO(), packet(1), { ...context, [field]: 'not-a-sha' }), code('IMPORT_HASH_INVALID'));
  await assert.rejects(writer.updateBatch(noIO(), packet(1), { ...context, snapshotAt: '2026-10-15' }), code('IMPORT_TIMESTAMP_INVALID'));
});

test('History bulk CAS binds the immutable scope, source, profile, identity and revision without replacing old versions', () => {
  const entry = IMPORT_BATCH_CATALOG.find(row => row.statement === B.updateHistoryRecords);
  assert.ok(entry, 'The runtime statement must have an actual PostgreSQL catalog entry');
  assert.equal(entry.statement.id, 'import-batches.history-records.update');
  assert.deepEqual(entry.parameterOrder, ['rows']);
  for (const [column, parameter] of [['id', 'id'], ['scope_id', '"scopeId"'], ['source_instance', '"sourceInstance"'],
    ['source', 'source'], ['source_table', '"sourceTable"'], ['profile_hash', '"profileHash"'],
    ['identity_hash', '"identityHash"'], ['revision', '"expectedRevision"']])
    assert.ok(entry.sql.includes('r.' + column + '=v.' + parameter), 'Missing exact CAS binding: ' + column);
  assert.match(entry.sql, /SET revision=r\.revision\+1/);
  assert.doesNotMatch(entry.sql, /\bDELETE\b|\bINSERT\b|\bpayload\b/i);
});

// Use the same qualified two-database facade as native import-engine coverage.
// Fixture ownership, empty-data checks, development role/URL qualification and
// teardown remain in the existing fixture implementation, without weaker flags.
async function nativeFixture(work) {
  const { withCoreFixture } = require('../test-support/postgresql-migration/core-fixture');
  const { withSalesFixture } = require('../test-support/postgresql-migration/sales-fixture');
  const { openTwoDatabaseDevelopmentApplication } = require('../lib/persistence/postgresql/boundary/application');
  return withCoreFixture(core => withSalesFixture(8, async sales => {
    await core.application.close(); await sales.application.close();
    const app = await openTwoDatabaseDevelopmentApplication({ coreUrl: process.env.GP_CORE_APP_URL,
      salesUrl: process.env.GP_SALES_APP_URL, stage: 8, authorize: async () => true });
    try { return await work({ ...sales, core, access: app.provider }); }
    finally { await app.provider.close(); }
  }));
}
async function stored(f) {
  const result = {};
  for (const [name, order] of [['integration.import_history_records', 'id'], ['integration.import_history_versions', 'record_id,revision'],
    ['integration.import_history_segments', 'record_id,revision,data_class'], ['integration.import_history_references', 'record_id,revision,role'],
    ['integration.import_history_epochs', 'scope_id'], ['integration.import_history_holds', 'record_id,consumer_id'],
    ['trade.import_master_records', 'id'], ['trade.import_master_segments', 'record_id,kind,data_class'], ['trade.import_master_relations', 'record_id,slot'],
    ['integration.data_import_runs', 'id'], ['integration.data_import_rows', 'run_id,row_number'], ['integration.data_import_links', 'id'],
    ['integration.data_import_changes', 'run_id,row_number'], ['integration.data_import_events', 'id'],
    ['integration.data_import_payload_blocks', 'id'], ['integration.data_import_row_payload_refs', 'run_id,row_number,slot'],
    ['integration.data_import_change_payload_refs', 'run_id,row_number,slot'], ['integration.data_import_run_state_counts', 'run_id,state']])
    result[name] = (await f.client.query('SELECT * FROM ' + name + ' ORDER BY ' + order)).rows;
  result.coreHolds = (await f.core.migrator.query('SELECT * FROM gp.import_master_holds ORDER BY record_id,consumer_id')).rows;
  return result;
}
async function seedMasters(f) {
  const writers = createImportMasterWriters({ protection: f.protection }), result = {};
  for (const [name, extra] of [['FILIALEN', { FilialID: '18' }], ['ARTIKEL_STAMM', { EAN: '0000123', Artikelbezeichnung: 'Synthetic retained article' }]]) {
    const selected = M.profileFor(name), id = 'synthetic-master-' + name.toLowerCase();
    const data = C.normalizeDataImportRow(selected, M.prepareTradeFotoMasterRow(name,
      Object.fromEntries(M.tableFor(name).columns.map(column => [column.name, extra[column.name] ?? null])))).data;
    const value = { ...actor, sourceInstance: 'synthetic-masters', sourceSystem: selected.sourceSystem,
      sourceTable: name, profileHash: selected.fingerprint, at: TIME };
    await f.access.transaction(tx => writers[selected.entity].create(tx, { id, data }, value));
    result[name] = { id, writer: writers[selected.entity], context: value };
  }
  return result;
}
async function historyEvidence(f, ids) {
  const result = {};
  for (const [name, order] of [['import_history_versions', 'record_id,revision'], ['import_history_segments', 'record_id,revision,data_class'],
    ['import_history_references', 'record_id,revision,role']])
    result[name] = (await f.client.query('SELECT * FROM integration.' + name + ' WHERE record_id=ANY($1::text[]) ORDER BY ' + order, [ids])).rows;
  return result;
}

test('Native history update packets: authenticated revisions, scoped CAS, retained references, rollback and undo',
  { skip: nativeSkip }, async t => nativeFixture(async f => {
    const masters = await seedMasters(f), writers = createImportHistoryWriters(composition(f.protection));
    const writer = writers[profile.entity], original = packet(50, 'original');
    await f.access.transaction(tx => writer.createBatch(tx, original.map(({ id, data }) => ({ id, data })), context));
    const before = await stored(f), ids = original.map(row => row.id), oldEvidence = await historyEvidence(f, ids);
    assert.ok(oldEvidence.import_history_references.some(row => row.master_record_id === masters.ARTIKEL_STAMM.id));

    await t.test('every CAS dimension rejects a mismatching value against actual PostgreSQL rows', async () => {
      const record = await f.access.queryOne(S.get, { id: ids[0], scopeId: actor.scopeId });
      const valid = { ...record, expectedRevision: record.revision }; delete valid.revision;
      for (const patch of [{ id: 'nonexistent-synthetic-id' }, { scopeId: 'another-scope' }, { sourceInstance: 'another-source' },
        { source: 'cash' }, { sourceTable: 'another-table' }, { profileHash: 'f'.repeat(64) },
        { identityHash: 'f'.repeat(64) }, { expectedRevision: 2 }])
        assert.equal((await f.access.execute(B.updateHistoryRecords, { rows: [{ ...valid, ...patch }] })).rowsAffected, 0);
      assert.deepEqual(await stored(f), before);
    });

    await t.test('wrong scope, source context, identity and stale member fail before any packet write', async () => {
      for (const [inputs, value, expected] of [
        [packet(2), { ...context, scopeId: 'another-scope' }, 'IMPORT_CONCURRENT_CHANGE'],
        [packet(2), { ...context, sourceInstance: 'another-source' }, 'IMPORT_HISTORY_CONTEXT_INVALID'],
        [[packet(1)[0], { ...packet(2)[1], data: distribution('changed-identity', 'updated').data }], context, 'IMPORT_HISTORY_IDENTITY_IMMUTABLE'],
        [[packet(1)[0], { ...packet(2)[1], expectedRevision: 2 }], context, 'IMPORT_CONCURRENT_CHANGE'],
      ]) {
        let writes = 0;
        await assert.rejects(f.access.transaction(tx => {
          const wrapped = delegate(tx); wrapped.execute = (...args) => { writes++; return tx.execute(...args); };
          return writer.updateBatch(wrapped, inputs, value);
        }), code(expected));
        assert.equal(writes, 0, 'All candidates must be checked before the first packet mutation');
        assert.deepEqual(await stored(f), before);
      }
    });

    await t.test('scope and current reference authorizations are reevaluated for every packet candidate', async () => {
      for (const denied of ['history.scope', 'history.reference']) {
        const calls = [], restricted = createImportHistoryWriters(composition(f.protection, {
          authorize(request) { calls.push(request); return request.action !== denied; },
        }))[profile.entity];
        await assert.rejects(f.access.transaction(tx => restricted.updateBatch(tx, packet(2), context)), code('IMPORT_FORBIDDEN'));
        assert.ok(calls.some(request => request.action === denied));
        assert.deepEqual(await stored(f), before);
      }
      let checked = 0, writes = 0;
      const revokedOnSecond = createImportHistoryWriters(composition(f.protection, {
        authorize(request) { return request.action !== 'history.scope' || ++checked !== 2; },
      }))[profile.entity];
      await assert.rejects(f.access.transaction(tx => {
        const wrapped = delegate(tx); wrapped.execute = (...args) => { writes++; return tx.execute(...args); };
        return revokedOnSecond.updateBatch(wrapped, packet(2), context);
      }), code('IMPORT_FORBIDDEN'));
      assert.equal(checked, 2); assert.equal(writes, 0, 'A later scope refusal must prevent writes for earlier authorized members too');
      assert.deepEqual(await stored(f), before);
    });

    await t.test('partial CAS, ciphertext substitution, reference tamper and failed hold checks roll back every table and epoch', async () => {
      for (const mode of ['partial-cas', 'old-version', 'new-version', 'new-segment', 'new-reference', 'hold-check']) {
        let writes = 0, intercepted = false;
        await assert.rejects(f.access.transaction(tx => {
          const wrapped = delegate(tx);
          wrapped.queryAll = async (statement, parameters) => {
            const result = await tx.queryAll(statement, parameters);
            if (mode === 'old-version' && !intercepted && statement === readerBatch(S.version) && result.length) {
              intercepted = true; return result.map((row, i) => i ? row : { ...row, payload: 'synthetic-tampered-old-ciphertext' });
            }
            return result;
          };
          wrapped.queryOne = async (statement, parameters) => {
            const result = await tx.queryOne(statement, parameters);
            if (mode === 'hold-check' && statement === B.historyHolds) { intercepted = true; return { count: result.count - 1 }; }
            return result;
          };
          wrapped.execute = async (statement, parameters) => {
            writes++;
            if (mode === 'partial-cas' && statement === B.updateHistoryRecords) {
              intercepted = true;
              assert.equal((await tx.execute(S.advance, { id: ids[1], scopeId: actor.scopeId, expectedRevision: 1 })).rowsAffected, 1);
            }
            let changed = parameters;
            if (mode === 'new-version' && statement === B.historyVersions) {
              intercepted = true;
              changed = { rows: parameters.rows.map((row, index) => ({ ...row, payload: parameters.rows[(index + 1) % parameters.rows.length].payload })) };
            }
            if (mode === 'new-segment' && statement === B.historySegments) {
              intercepted = true; changed = { rows: parameters.rows.map((row, index) => index ? row : { ...row, payload: 'synthetic-tampered-new-ciphertext' }) };
            }
            if (mode === 'new-reference' && statement === B.historyReferences) {
              intercepted = true; changed = { rows: parameters.rows.map((row, index) => index ? row : { ...row, lookupHash: 'f'.repeat(64) }) };
            }
            return tx.execute(statement, changed);
          };
          return writer.updateBatch(wrapped, packet(3), context);
        }, { isolation: 'serializable' }), code({ 'partial-cas': 'IMPORT_CONCURRENT_CHANGE', 'old-version': 'IMPORT_PROTECTED_PAYLOAD_INVALID',
          'new-version': 'IMPORT_PROTECTED_PAYLOAD_INVALID', 'new-segment': 'IMPORT_PROTECTED_PAYLOAD_INVALID',
          'new-reference': 'IMPORT_HISTORY_INTEGRITY', 'hold-check': 'IMPORT_HISTORY_INTEGRITY' }[mode]));
        assert.equal(intercepted, true, mode + ' must exercise its actual interception');
        if (mode === 'old-version') assert.equal(writes, 0, 'Unauthenticated prior versions must not advance the packet');
        assert.deepEqual(await stored(f), before, mode + ' must roll back every header, append, hold and epoch');
      }
    });

    await t.test('25 and 50 updates use packet-bounded real SQL instead of the per-record update path', async () => {
      const { Client } = require('pg');
      async function measure(count, batch, prefetched) {
        const queries = [], prepareQueries = [], rollback = new Error('synthetic-measurement-rollback');
        const originalQuery = Client.prototype.query;
        let phase = null, result, writerElapsedMs;
        Client.prototype.query = function (...args) {
          if (phase) (phase === 'prepare' ? prepareQueries : queries).push(typeof args[0] === 'string' ? args[0] : args[0]?.text || '');
          return originalQuery.apply(this, args);
        };
        const started = performance.now();
        try {
          await assert.rejects(f.access.transaction(async tx => {
            // The production engine marks the same bound executor for reference
            // prefetch; this flag caches reads, never authorization decisions.
            Q.start(tx, supportsCoreImportReferences(f.access));
            if (prefetched) {
              phase = 'prepare';
              await writer.prepareRead(tx, Array.from({ length: count }, (_, index) => distribution(index + 1, 'updated')), context);
            }
            phase = 'writer';
            const writerStarted = performance.now();
            try {
              if (batch) result = await writer.updateBatch(tx, packet(count), context);
              else {
                result = [];
                for (const row of packet(count)) result.push(await writer.update(tx, row, context));
              }
            } finally { writerElapsedMs = Math.round(performance.now() - writerStarted); phase = null; }
            throw rollback;
          }, { isolation: 'serializable' }), error => error === rollback);
        } finally { Client.prototype.query = originalQuery; }
        assert.deepEqual(result, packet(count).map(({ id, data }) => ({ id, revision: 2, data })));
        assert.deepEqual(await stored(f), before);
        return { count, mode: batch ? 'packet' : 'single', prefetched, prepareSql: prepareQueries.length, sql: queries.length,
          historyCas: queries.filter(sql => /UPDATE\s+integration\."?import_history_records"?/i.test(sql)).length,
          epoch: queries.filter(sql => /import_history_epochs/i.test(sql)).length,
          writerElapsedMs, transactionAndEvidenceElapsedMs: Math.round(performance.now() - started) };
      }
      const measurements = [];
      for (const prefetched of [false, true]) for (const count of [25, 50]) {
        const single = await measure(count, false, prefetched), batch = await measure(count, true, prefetched);
        assert.equal(single.historyCas, count); assert.equal(batch.historyCas, 1);
        assert.equal(single.epoch, count); assert.equal(batch.epoch, 1);
        assert.ok(batch.sql < single.sql / 3, 'Actual SQL round trips must improve by more than 3x: ' + JSON.stringify({ single, batch }));
        measurements.push(single, batch);
      }
      for (const offset of [0, 4]) assert.equal(measurements[offset + 1].sql, measurements[offset + 3].sql,
        '25 and 50 homogeneous updates must have the same bounded query count, including equally prefetched callers');
      t.diagnostic('SYNTHETIC_HISTORY_UPDATE_SQL ' + JSON.stringify(measurements));
    });

    await t.test('authenticated input order, one epoch and old ciphertext/reference holds survive update and exact restore', async () => {
      const inputs = packet(50).reverse(), statements = [], epochBefore = await f.access.queryOne(S.epoch, { scopeId: actor.scopeId });
      const result = await f.access.transaction(tx => {
        const wrapped = delegate(tx);
        wrapped.execute = (statement, parameters) => { statements.push(statement.id); return tx.execute(statement, parameters); };
        return writer.updateBatch(wrapped, inputs, context);
      }, { isolation: 'serializable' });
      assert.deepEqual(result, inputs.map(({ id, data }) => ({ id, revision: 2, data })));
      assert.equal(statements.filter(id => id === B.updateHistoryRecords.id).length, 1);
      assert.equal(statements.filter(id => id === S.advanceEpoch.id).length, 1);
      assert.ok(!statements.includes(S.advance.id) && !statements.includes(S.insertVersion.id));
      assert.notDeepEqual(await f.access.queryOne(S.epoch, { scopeId: actor.scopeId }), epochBefore);
      const updatedEvidence = await historyEvidence(f, ids);
      for (const [name, rows] of Object.entries(oldEvidence))
        assert.deepEqual(updatedEvidence[name].filter(row => Number(row.revision) === 1), rows, 'Historical ciphertext and references must remain byte-exact');
      assert.equal(await f.access.transaction(tx => masters.ARTIKEL_STAMM.writer.canRemove(tx, masters.ARTIKEL_STAMM.id, masters.ARTIKEL_STAMM.context)), false);
      const restored = await f.access.transaction(async tx => {
        const result = [];
        for (const row of original) result.push(await writer.restore(tx, { ...row, expectedRevision: 2 }, { ...context, restoreRevision: 1 }));
        return result;
      });
      assert.deepEqual(restored, original.map(({ id, data }) => ({ id, revision: 3, data })));
      const restoredEvidence = await historyEvidence(f, ids);
      for (const [name, rows] of Object.entries(updatedEvidence))
        assert.deepEqual(restoredEvidence[name].filter(row => Number(row.revision) <= 2), rows, 'Undo must append rather than remove either prior version');
      assert.equal(await f.access.transaction(tx => masters.FILIALEN.writer.canRemove(tx, masters.FILIALEN.id, masters.FILIALEN.context)), false);
    });

    await t.test('30 and 50 dependent cash lines reject a missing parent atomically and bind a freshly changed parent revision', async () => {
      const headProfile = H.profileFor('cash', 'Umsatz_KASSE'), lineProfile = H.profileFor('cash', 'Umsatz_Kasse_Details');
      const heads = writers[headProfile.entity], lines = writers[lineProfile.entity];
      const headContext = contextFor('cash', 'Umsatz_KASSE', 'cash-parent'), lineContext = { ...contextFor('cash', 'Umsatz_Kasse_Details', 'cash-parent'), sourceInstance: headContext.sourceInstance };
      const makeHead = changed => normalize('cash', 'Umsatz_KASSE', { Bonnr: '001', Filialid: '18', Kassenid: '1', Bondatum: DAY, RechnungsBetrag: changed ? 24 : 12 });
      const makeLine = (key, changed = false, missing = false) => normalize('cash', 'Umsatz_Kasse_Details', {
        RepID: '00000000-0000-0000-0000-' + String(key).padStart(12, '0'), Bonnr: missing ? 'missing-parent' : '001',
        Filialid: '18', Kassenid: '1', Bondatum: DAY, EAN: '0000123', VKMenge: 1, VK_Preis: changed ? 24 : 12,
      });
      const parentId = uuid('synthetic-cash-parent'), children = Array.from({ length: 50 }, (_, index) => ({ id: uuid('synthetic-cash-line-' + (index + 1)), data: makeLine(index + 1).data }));
      await f.access.transaction(async tx => { await heads.create(tx, { id: parentId, data: makeHead(false).data }, headContext); await lines.createBatch(tx, children, lineContext); });
      const originalChildren = await historyEvidence(f, children.map(row => row.id));
      for (const count of [30, 50]) {
        const inputs = children.slice(0, count).map((row, index) => ({ ...row, expectedRevision: 1, data: makeLine(index + 1, true, index === count - 1).data }));
        const beforeReject = await stored(f);
        await assert.rejects(f.access.transaction(tx => lines.updateBatch(tx, inputs, lineContext)), code('IMPORT_HISTORY_PARENT_REQUIRED'));
        assert.deepEqual(await stored(f), beforeReject);
      }
      const result = await f.access.transaction(async tx => {
        await heads.update(tx, { id: parentId, expectedRevision: 1, data: makeHead(true).data }, headContext);
        return lines.updateBatch(tx, children.map((row, index) => ({ ...row, expectedRevision: 1, data: makeLine(index + 1, true).data })), lineContext);
      });
      assert.equal(result.length, 50); assert.ok(result.every(row => row.revision === 2));
      const evidence = await historyEvidence(f, children.map(row => row.id));
      const updatedVersions = evidence.import_history_versions.filter(row => Number(row.revision) === 2);
      assert.equal(updatedVersions.length, 50, 'Every child must have an authenticated new parent binding');
      assert.ok(updatedVersions.every(row => row.parent_id === parentId && Number(row.parent_revision) === 2));
      for (const [name, rows] of Object.entries(originalChildren)) assert.deepEqual(evidence[name].filter(row => Number(row.revision) === 1), rows);
      assert.equal(await f.access.transaction(tx => heads.canRemove(tx, parentId, headContext)), false, 'Historical child versions must retain the parent dependency');
    });

    await t.test('parallel requests through the actual two-database coordinator commit one complete revision and reject the stale packet', async () => {
      const raceContext = { ...context, sourceInstance: context.sourceInstance + '-race' };
      const raceOriginal = packet(2, 'original', 'synthetic-race'), ids = raceOriginal.map(row => row.id);
      await f.access.transaction(tx => writer.createBatch(tx, raceOriginal.map(({ id, data }) => ({ id, data })), raceContext));
      const left = packet(2, 'left', 'synthetic-race'), right = packet(2, 'right', 'synthetic-race');
      const attempts = await Promise.allSettled([left, right].map(inputs =>
        f.access.transaction(tx => writer.updateBatch(tx, inputs, raceContext), { isolation: 'serializable' })));
      const successful = attempts.flatMap((result, index) => result.status === 'fulfilled' ? [{ result: result.value, index }] : []);
      const rejected = attempts.filter(result => result.status === 'rejected');
      assert.equal(successful.length, 1); assert.equal(rejected.length, 1);
      assert.equal(rejected[0].reason.code, 'IMPORT_CONCURRENT_CHANGE');
      const winner = successful[0], inputs = [left, right][winner.index];
      assert.deepEqual(winner.result, inputs.map(({ id, data }) => ({ id, revision: 2, data })));
      const current = await f.access.transaction(async tx => {
        const result = []; for (const id of ids) result.push(await writer.read(tx, id, raceContext)); return result;
      }, { readOnly: true });
      assert.deepEqual(current, winner.result, 'Both targets must contain the same successful packet, without a mixed loser revision');
      const evidence = await historyEvidence(f, ids);
      assert.equal(evidence.import_history_versions.length, 4);
      assert.ok(evidence.import_history_versions.every(row => [1, 2].includes(Number(row.revision))));
    });
  }));

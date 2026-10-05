'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspect, install, capture, compareSnapshots } = require('../lib/persistence/postgresql/operations/sql-runtime-statistics');

const start = '2026-10-05T09:00:00.000000Z';
const at = second => `2026-10-05T10:00:${String(second).padStart(2, '0')}.000000Z`;
const pair = ['grabenplaner_core', 'grabenplaner_sales'];
const inspection = overrides => ({ database: 'postgres', role: 'gp_migration_admin', isSuperuser: true, serverVersion: 180006,
  postmasterStartedAt: start, preload: 'pg_stat_statements', computeQueryId: 'auto', trackIoTiming: 'off', track: 'top',
  schemaOwner: 'gp_migration_admin', extensionOwner: 'gp_migration_admin', extensionSchema: 'gp_observability', extensionVersion: '1.12', monitorReady: true, monitorCanReset: false, ...overrides });
function row(overrides = {}) {
  return { database: pair[1], dbid: '16385', userid: '16400', queryid: '-9223372036854775807', toplevel: true,
    statsSince: start, calls: '9007199254740993', sharedHits: '9007199254741993', sharedReads: '5', sharedDirtied: '0', sharedWritten: '0',
    localHits: '0', localReads: '0', localDirtied: '0', localWritten: '0', tempReads: '0', tempWritten: '0', walRecords: '3',
    walFullPageImages: '0', walBytes: '18446744073709551619', walBuffersFull: '0', execMs: 1000, sharedReadMs: 0,
    sharedWriteMs: 0, localReadMs: 0, localWriteMs: 0, tempReadMs: 0, tempWriteMs: 0, ...overrides };
}
function fake({ state = inspection(), entries = [row()], meta = [], reject = null } = {}) {
  const queries = [];
  let metadataIndex = 0;
  const client = { queries, async query(sql, values) {
    queries.push({ sql, values });
    if (reject?.(sql)) throw new Error('connection password and sensitive SQL must not escape');
    if (sql.includes('gp-sql-statistics:inspect')) return { rows: [{ ...state }] };
    if (sql.includes('gp-sql-statistics:metadata')) {
      const defaults = { capturedAt: at(1 + metadataIndex), postmasterStartedAt: start, statsResetAt: start, dealloc: '0', databaseCount: values[0].length };
      return { rows: [{ ...defaults, ...meta[metadataIndex++] }] };
    }
    if (sql.includes('gp-sql-statistics:capture')) return { rows: entries };
    if (sql.startsWith('CREATE SCHEMA')) state.schemaOwner = 'gp_migration_admin';
    if (sql.startsWith('CREATE EXTENSION')) Object.assign(state, { extensionOwner: 'gp_migration_admin', extensionSchema: 'gp_observability', extensionVersion: '1.12' });
    return { rows: [] };
  } };
  return client;
}
const code = expected => error => error.code === expected && error.message === expected;
const snapshot = (entries = [row()], overrides = {}) => ({ format: 'gp-sql-runtime-statistics-v1', databases: pair,
  serverVersion: 180006, extensionVersion: '1.12', track: 'top', trackIoTiming: false, captureStartedAt: at(1), capturedAt: at(2),
  postmasterStartedAt: start, statsResetAt: start, dealloc: '0', entries, ...overrides });
const later = (entries, overrides) => snapshot(entries, { captureStartedAt: at(12), capturedAt: at(13), ...overrides });

test('inspection reports pending preload without mutation or SQL text', async () => {
  const client = fake({ state: inspection({ preload: '', track: null, extensionOwner: null, extensionSchema: null, extensionVersion: null, schemaOwner: null }) });
  const result = await inspect(client);
  assert.equal(result.ready, false); assert.equal(result.preloaded, false);
  assert.equal(client.queries.length, 1);
  assert.doesNotMatch(client.queries[0].sql, /pg_stat_statements\s*\(|\bquery\b|ALTER SYSTEM/i);
  await assert.rejects(install(client), code('PG_SQL_STATS_PRELOAD_REQUIRED'));
  assert.ok(client.queries.every(q => q.sql.includes('gp-sql-statistics:inspect')));
});

test('installation is transactional, owner bounded, idempotent and grants no reset execution', async () => {
  const client = fake({ state: inspection({ schemaOwner: null, extensionOwner: null, extensionSchema: null, extensionVersion: null }) });
  assert.equal((await install(client)).ready, true);
  await install(client);
  const sql = client.queries.map(q => q.sql);
  assert.equal(sql.filter(q => q.startsWith('CREATE SCHEMA')).length, 1);
  assert.equal(sql.filter(q => q.startsWith('CREATE EXTENSION')).length, 1);
  assert.equal(sql.filter(q => q === 'COMMIT').length, 2);
  for (const target of ['SCHEMA gp_observability', 'ALL TABLES IN SCHEMA gp_observability', 'ALL FUNCTIONS IN SCHEMA gp_observability']) {
    assert.ok(sql.includes(`REVOKE ALL ON ${target} FROM PUBLIC, gp_operations_monitor`));
  }
  assert.ok(sql.includes('GRANT CONNECT ON DATABASE postgres TO gp_operations_monitor'));
  const execute = sql.filter(q => q.startsWith('GRANT EXECUTE'));
  assert.equal(execute.length, 4);
  assert.ok(execute.every(q => /pg_stat_statements\(boolean\)|pg_stat_statements_info\(\)/.test(q)));
  assert.doesNotMatch(sql.join('\n'), /GRANT[^\n]*pg_stat_statements_reset|pg_stat_statements_reset\s*\(|ALTER SYSTEM|CREATE ROLE|grabenplaner_(core|sales)/);
});

test('installation refuses other databases, owners, roles and unavailable monitoring before writes', async () => {
  for (const [override, expected] of [
    [{ database: pair[0] }, 'PG_SQL_STATS_MAINTENANCE_DATABASE'],
    [{ schemaOwner: 'postgres' }, 'PG_SQL_STATS_OWNER_DRIFT'],
    [{ extensionOwner: 'postgres' }, 'PG_SQL_STATS_OWNER_DRIFT'],
    [{ extensionSchema: 'public' }, 'PG_SQL_STATS_OWNER_DRIFT'],
    [{ extensionVersion: '1.11' }, 'PG_SQL_STATS_EXTENSION_VERSION'],
    [{ role: 'postgres' }, 'PG_SQL_STATS_ROLE'],
    [{ role: 'gp_operations_monitor', isSuperuser: false }, 'PG_SQL_STATS_ROLE'],
    [{ monitorReady: false }, 'PG_SQL_STATS_MONITOR_ROLE'],
    [{ serverVersion: 170005 }, 'PG_SQL_STATS_POSTGRESQL_VERSION'],
  ]) {
    const client = fake({ state: inspection(override) });
    await assert.rejects(install(client), code(expected));
    assert.equal(client.queries.length, 1);
  }
  const broken = fake({ reject: sql => sql.startsWith('GRANT USAGE') });
  await assert.rejects(install(broken), code('PG_SQL_STATS_QUERY_FAILED'));
  assert.equal(broken.queries.at(-1).sql, 'ROLLBACK');
  assert.ok(!broken.queries.some(q => q.sql === 'COMMIT'));
  const inheritedReset = fake({ state: inspection({ monitorCanReset: true }) });
  assert.equal((await inspect(inheritedReset)).ready, false);
  await assert.rejects(install(inheritedReset), code('PG_SQL_STATS_RESET_PRIVILEGE'));
  assert.equal(inheritedReset.queries.at(-1).sql, 'ROLLBACK');
  assert.ok(!inheritedReset.queries.some(q => q.sql === 'COMMIT'));
});

test('capture uses false showtext, fixed pairs, explicit numeric projections and exact bigint values', async () => {
  const client = fake({ state: inspection({ role: 'gp_operations_monitor', isSuperuser: false }), entries: [row({ query: 'secret customer literal', password: 'secret' })] });
  const result = await capture(client, { databases: [...pair].reverse() });
  assert.equal(result.entries[0].calls, '9007199254740993');
  assert.equal(result.entries[0].walBytes, '18446744073709551619');
  assert.doesNotMatch(JSON.stringify(result), /secret|password|customer literal/);
  const statement = client.queries.find(q => q.sql.includes('gp-sql-statistics:capture'));
  assert.match(statement.sql, /pg_stat_statements\(false\)/);
  assert.match(statement.sql, /LIMIT 5001/);
  assert.doesNotMatch(statement.sql, /s\.query\b|SELECT\s+\*/i);
  assert.deepEqual(statement.values, [pair]);
  for (const invalid of [[], ['postgres'], [pair[0], 'gp_migration_sales'], [pair[0], pair[0]], ["grabenplaner_sales'); DROP SCHEMA gp; --"]]) {
    const invalidClient = fake();
    await assert.rejects(capture(invalidClient, { databases: invalid }), code('PG_SQL_STATS_DATABASES'));
    assert.equal(invalidClient.queries.length, 0);
  }
  assert.equal((await capture(fake({ entries: [] }), { databases: ['gp_migration_core', 'gp_migration_sales'] })).entries.length, 0);
});

test('capture fails closed for invalid counters, permissions, oversize or reset during collection', async () => {
  for (const override of [{ calls: 9007199254740992 }, { calls: '-1' }, { calls: '1e5' }, { execMs: Infinity }, { queryid: null }, { tempReadMs: -1 }]) {
    await assert.rejects(capture(fake({ entries: [row(override)] }), { databases: pair }), code('PG_SQL_STATS_NUMERIC'));
  }
  await assert.rejects(capture(fake({ entries: Array.from({ length: 5001 }, () => row()) }), { databases: pair }), code('PG_SQL_STATS_LIMIT'));
  await assert.rejects(capture(fake({ state: inspection({ role: 'gp_sales_reader', isSuperuser: false }) }), { databases: pair }), code('PG_SQL_STATS_ROLE'));
  await assert.rejects(capture(fake({ meta: [{}, { statsResetAt: at(1) }] }), { databases: pair }), code('PG_SQL_STATS_RESET'));
  await assert.rejects(capture(fake({ meta: [{}, { dealloc: '1' }] }), { databases: pair }), code('PG_SQL_STATS_EVICTED'));
  await assert.rejects(capture(fake({ meta: [{ databaseCount: 1 }] }), { databases: pair }), code('PG_SQL_STATS_DATABASES_MISSING'));
});

test('window deltas preserve bigint precision and use window calls for mean execution time', () => {
  const before = snapshot();
  const after = later([row({ calls: '9007199254740996', execMs: 1060, sharedHits: '9007199254742000', walBytes: '18446744073709551621' }),
    row({ queryid: '42', statsSince: at(3), calls: '2', execMs: 10, sharedHits: '1', walBytes: '3' })]);
  const result = compareSnapshots(before, after);
  assert.equal(result.entries[0].calls, '3'); assert.equal(result.entries[0].meanExecMs, 20);
  assert.equal(result.entries[0].sharedHits, '7'); assert.equal(result.entries[0].walBytes, '2');
  assert.equal(result.totals.calls, '5'); assert.equal(result.totals.execMs, 70); assert.equal(result.totals.meanExecMs, 14);
  assert.equal(result.minimumWindowMs, 10000);
  const idle = compareSnapshots(before, later([row()]));
  assert.equal(idle.totals.meanExecMs, null); assert.equal(idle.totals.calls, '0');
  assert.doesNotMatch(JSON.stringify(result), /callsPerSecond|cpu|hitRatio|queryText/);
});

test('comparison rejects restarts, resets, evictions, entry replacement and inconsistent baselines without rankings', () => {
  for (const [after, expected] of [
    [later([row()], { postmasterStartedAt: at(3) }), 'PG_SQL_STATS_SERVER_RESTART'],
    [later([row()], { statsResetAt: at(3) }), 'PG_SQL_STATS_RESET'],
    [later([row()], { dealloc: '1' }), 'PG_SQL_STATS_EVICTED'],
    [later([row({ statsSince: at(3) })]), 'PG_SQL_STATS_ENTRY_RESET'],
    [later([]), 'PG_SQL_STATS_ENTRY_MISSING'],
    [later([row(), row({ queryid: '1' })]), 'PG_SQL_STATS_ENTRY_BASELINE_MISSING'],
    [later([row({ calls: '1' })]), 'PG_SQL_STATS_COUNTER_DECREASE'],
    [later([row({ execMs: 999 })]), 'PG_SQL_STATS_COUNTER_DECREASE'],
    [later([row(), row()]), 'PG_SQL_STATS_DUPLICATE_ENTRY'],
    [later([row()], { trackIoTiming: true }), 'PG_SQL_STATS_INCOMPATIBLE'],
    [later([row()], { track: 'all' }), 'PG_SQL_STATS_INCOMPATIBLE'],
    [later([row()], { captureStartedAt: at(1) }), 'PG_SQL_STATS_WINDOW'],
  ]) assert.throws(() => compareSnapshots(snapshot(), after), code(expected));
});

test('native protected PostgreSQL statistics installation, monitor capture, ACL denial and numeric delta',
  { skip: process.env.GP_SQL_STATS_LIVE !== '1' }, async () => {
    const fs = require('node:fs'), path = require('node:path'), { Client } = require('pg');
    const rawUrl = process.env.GP_SQL_STATS_URL || process.env.GP_MIGRATION_ADMIN_URL;
    assert.ok(rawUrl, 'A synthetic local admin connection is required');
    const url = new URL(rawUrl);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '25475');
    url.pathname = '/postgres';
    const admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    let workload;
    try {
      const actual = (await admin.query("SELECT current_setting('data_directory') AS directory, current_setting('port') AS port, current_database() AS database")).rows[0];
      const expected = path.resolve(__dirname, '../../output/article-search-optimization-20261005/postgres-test/data');
      assert.equal(fs.realpathSync(actual.directory).toLowerCase(), fs.realpathSync(expected).toLowerCase());
      assert.equal(actual.port, '25475'); assert.equal(actual.database, 'postgres');
      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='gp_migration_admin') THEN CREATE ROLE gp_migration_admin NOLOGIN SUPERUSER; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='gp_operations_monitor') THEN CREATE ROLE gp_operations_monitor NOLOGIN; END IF;
        END $$`);
      await admin.query('GRANT pg_monitor TO gp_operations_monitor');
      await admin.query('REVOKE CONNECT ON DATABASE postgres FROM PUBLIC');
      await admin.query('SET ROLE gp_migration_admin');
      assert.equal((await install(admin)).ready, true);
      assert.equal((await install(admin)).ready, true);
      // A pre-existing inherited grant must not evade the no-reset contract.
      // Never execute reset, even in this isolated synthetic cluster.
      await admin.query('GRANT EXECUTE ON FUNCTION gp_observability.pg_stat_statements_reset(oid,oid,bigint,boolean) TO pg_monitor');
      try {
        assert.equal((await inspect(admin)).ready, false);
        await assert.rejects(install(admin), code('PG_SQL_STATS_RESET_PRIVILEGE'));
      } finally {
        await admin.query('REVOKE EXECUTE ON FUNCTION gp_observability.pg_stat_statements_reset(oid,oid,bigint,boolean) FROM pg_monitor');
      }
      assert.equal((await inspect(admin)).ready, true);
      await admin.query('SET ROLE gp_operations_monitor');
      const permissions = (await admin.query(`SELECT has_database_privilege(current_user,'postgres','CONNECT') AS connect,
        has_schema_privilege(current_user,'gp_observability','USAGE') AS usage,
        has_function_privilege(current_user,'gp_observability.pg_stat_statements(boolean)','EXECUTE') AS read,
        has_function_privilege(current_user,'gp_observability.pg_stat_statements_info()','EXECUTE') AS info,
        bool_or(has_function_privilege(current_user,p.oid,'EXECUTE')) AS reset
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='gp_observability' AND p.proname='pg_stat_statements_reset'`)).rows[0];
      assert.deepEqual(permissions, { connect: true, usage: true, read: true, info: true, reset: false });
      const selected = ['gp_migration_core', 'gp_migration_sales'];
      const before = await capture(admin, { databases: selected });
      url.pathname = '/gp_migration_sales';
      workload = new Client({ connectionString: url.toString() });
      await workload.connect();
      await workload.query('SELECT sum(n) FROM generate_series(1, 10000) n');
      await workload.query('SELECT sum(n) FROM generate_series(1, 10000) n');
      const after = await capture(admin, { databases: selected });
      const delta = compareSnapshots(before, after);
      assert.ok(BigInt(delta.totals.calls) >= 2n);
      assert.ok(delta.totals.execMs >= 0);
      assert.ok(after.entries.every(item => !Object.hasOwn(item, 'query')));
      for (const role of ['gp_core_app', 'gp_core_reader', 'gp_sales_app', 'gp_sales_reader']) {
        await admin.query('RESET ROLE');
        await admin.query(`SET ROLE ${role}`); // Fixed local fixture roles only.
        const access = (await admin.query("SELECT has_database_privilege(current_user,'postgres','CONNECT') AS connect, has_schema_privilege(current_user,'gp_observability','USAGE') AS usage")).rows[0];
        assert.deepEqual(access, { connect: false, usage: false });
        await assert.rejects(admin.query('SELECT calls FROM gp_observability.pg_stat_statements(false)'), error => error.code === '42501');
      }
    } finally { if (workload) await workload.end(); await admin.end(); }
  });

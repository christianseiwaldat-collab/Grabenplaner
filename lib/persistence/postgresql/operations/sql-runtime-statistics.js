'use strict';

// Maintenance-only PostgreSQL 18 statistics. Never select query text or reset
// counters here; snapshots are numeric, bounded and useful only as a pair.
const SCHEMA = 'gp_observability';
const ADMIN = 'gp_migration_admin';
const MONITOR = 'gp_operations_monitor';
const FORMAT = 'gp-sql-runtime-statistics-v1';
const EXTENSION_VERSION = '1.12'; // PG 18 API including wal_buffers_full.
const PAIRS = [['grabenplaner_core', 'grabenplaner_sales'], ['gp_migration_core', 'gp_migration_sales']];
const MAX_ENTRIES = 5000;
const INTEGERS = ['calls', 'sharedHits', 'sharedReads', 'sharedDirtied', 'sharedWritten',
  'localHits', 'localReads', 'localDirtied', 'localWritten', 'tempReads', 'tempWritten',
  'walRecords', 'walFullPageImages', 'walBytes', 'walBuffersFull'];
const TIMES = ['execMs', 'sharedReadMs', 'sharedWriteMs', 'localReadMs', 'localWriteMs', 'tempReadMs', 'tempWriteMs'];
const COLUMNS = ['calls', 'shared_blks_hit', 'shared_blks_read', 'shared_blks_dirtied', 'shared_blks_written',
  'local_blks_hit', 'local_blks_read', 'local_blks_dirtied', 'local_blks_written', 'temp_blks_read', 'temp_blks_written',
  'wal_records', 'wal_fpi', 'wal_bytes', 'wal_buffers_full'];
const TIME_COLUMNS = ['total_exec_time', 'shared_blk_read_time', 'shared_blk_write_time',
  'local_blk_read_time', 'local_blk_write_time', 'temp_blk_read_time', 'temp_blk_write_time'];
const utc = expression => `pg_catalog.to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const fail = code => { throw Object.assign(new Error(code), { code }); };
async function query(client, sql, values) {
  try { return await client.query(sql, values); }
  catch { fail('PG_SQL_STATS_QUERY_FAILED'); } // Driver messages can contain SQL and connection details.
}
function integer(value, signed = false) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('PG_SQL_STATS_NUMERIC');
  const text = String(value);
  if (!(signed ? /^-?(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)$/).test(text) || text.length > 40) fail('PG_SQL_STATS_NUMERIC');
  return BigInt(text).toString();
}
function finite(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('PG_SQL_STATS_NUMERIC');
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail('PG_SQL_STATS_TIMESTAMP');
  return value;
}
function micros(value) { return BigInt(Date.parse(timestamp(value))) * 1000n + BigInt(value.slice(-4, -1)); }
function databases(input) {
  if (!Array.isArray(input) || !input.length || input.length > 2 || new Set(input).size !== input.length
      || !PAIRS.some(pair => input.every(name => pair.includes(name)))) fail('PG_SQL_STATS_DATABASES');
  return [...input].sort();
}
async function inspect(client) {
  const { rows } = await query(client, `/* gp-sql-statistics:inspect */
    SELECT current_database() AS database, current_user AS role,
      (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS "isSuperuser",
      current_setting('server_version_num')::integer AS "serverVersion",
      ${utc('pg_catalog.pg_postmaster_start_time()')} AS "postmasterStartedAt",
      current_setting('shared_preload_libraries') AS preload,
      current_setting('compute_query_id') AS "computeQueryId",
      current_setting('track_io_timing') AS "trackIoTiming",
      current_setting('pg_stat_statements.track', true) AS track,
      (SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace WHERE nspname='gp_observability') AS "schemaOwner",
      (SELECT pg_catalog.pg_get_userbyid(extowner) FROM pg_catalog.pg_extension WHERE extname='pg_stat_statements') AS "extensionOwner",
      (SELECT n.nspname FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_stat_statements') AS "extensionSchema",
      (SELECT extversion FROM pg_catalog.pg_extension WHERE extname='pg_stat_statements') AS "extensionVersion",
      EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        JOIN pg_catalog.pg_roles r ON r.rolname='gp_operations_monitor'
        WHERE n.nspname='gp_observability' AND p.proname='pg_stat_statements_reset'
          AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')) AS "monitorCanReset",
      EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='gp_operations_monitor'
        AND pg_catalog.pg_has_role(r.oid, 'pg_monitor', 'USAGE') AND NOT r.rolsuper) AS "monitorReady"`);
  const row = rows[0];
  if (!row || rows.length !== 1) fail('PG_SQL_STATS_INSPECTION');
  const state = { database: row.database, role: row.role, isSuperuser: row.isSuperuser === true,
    serverVersion: row.serverVersion, postmasterStartedAt: timestamp(row.postmasterStartedAt),
    preloaded: String(row.preload || '').split(',').some(item => item.trim().replace(/^"|"$/g, '').replace(/^\$libdir\//, '') === 'pg_stat_statements'),
    computeQueryId: row.computeQueryId, trackIoTiming: row.trackIoTiming === 'on', track: row.track || null,
    schemaOwner: row.schemaOwner || null, extensionOwner: row.extensionOwner || null,
    extensionSchema: row.extensionSchema || null, extensionVersion: row.extensionVersion || null,
    monitorReady: row.monitorReady === true, monitorCanReset: row.monitorCanReset === true };
  state.ready = state.database === 'postgres' && state.serverVersion >= 180000 && state.preloaded
    && ['auto', 'on'].includes(state.computeQueryId) && ['top', 'all'].includes(state.track)
    && state.schemaOwner === ADMIN && state.extensionOwner === ADMIN && state.extensionSchema === SCHEMA
    && state.extensionVersion === EXTENSION_VERSION && state.monitorReady && !state.monitorCanReset;
  return state;
}
function boundary(state, installing = false) {
  if (state.database !== 'postgres') fail('PG_SQL_STATS_MAINTENANCE_DATABASE');
  if (state.serverVersion < 180000) fail('PG_SQL_STATS_POSTGRESQL_VERSION');
  if (state.schemaOwner && state.schemaOwner !== ADMIN || state.extensionOwner && state.extensionOwner !== ADMIN
      || state.extensionSchema && state.extensionSchema !== SCHEMA) fail('PG_SQL_STATS_OWNER_DRIFT');
  if (state.extensionVersion && state.extensionVersion !== EXTENSION_VERSION) fail('PG_SQL_STATS_EXTENSION_VERSION');
  if (!state.monitorReady) fail('PG_SQL_STATS_MONITOR_ROLE');
  if (installing ? state.role !== ADMIN || !state.isSuperuser
      : !((state.role === ADMIN && state.isSuperuser) || (state.role === MONITOR && !state.isSuperuser))) fail('PG_SQL_STATS_ROLE');
  if (!state.preloaded || !['auto', 'on'].includes(state.computeQueryId) || !['top', 'all'].includes(state.track)) fail('PG_SQL_STATS_PRELOAD_REQUIRED');
  if (!installing && state.monitorCanReset) fail('PG_SQL_STATS_RESET_PRIVILEGE');
  if (!installing && !state.ready) fail('PG_SQL_STATS_NOT_INSTALLED');
}
async function install(client) {
  boundary(await inspect(client), true);
  await query(client, 'BEGIN');
  try {
    await query(client, "SET LOCAL search_path = pg_catalog");
    await query(client, "SET LOCAL lock_timeout = '5s'");
    await query(client, "SELECT pg_catalog.pg_advisory_xact_lock(749180501)");
    const state = await inspect(client);
    boundary(state, true);
    if (!state.schemaOwner) await query(client, 'CREATE SCHEMA gp_observability AUTHORIZATION gp_migration_admin');
    if (!state.extensionOwner) await query(client, "CREATE EXTENSION pg_stat_statements WITH SCHEMA gp_observability VERSION '1.12'");
    // Repeated installation also removes accidental grants to the monitor.
    await query(client, 'REVOKE ALL ON SCHEMA gp_observability FROM PUBLIC, gp_operations_monitor');
    await query(client, 'REVOKE ALL ON ALL TABLES IN SCHEMA gp_observability FROM PUBLIC, gp_operations_monitor');
    await query(client, 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gp_observability FROM PUBLIC, gp_operations_monitor');
    await query(client, 'GRANT CONNECT ON DATABASE postgres TO gp_operations_monitor');
    await query(client, 'GRANT USAGE ON SCHEMA gp_observability TO gp_operations_monitor');
    await query(client, 'GRANT SELECT ON gp_observability.pg_stat_statements, gp_observability.pg_stat_statements_info TO gp_operations_monitor');
    await query(client, 'GRANT EXECUTE ON FUNCTION gp_observability.pg_stat_statements(boolean) TO gp_operations_monitor');
    // The info view invokes this read-only function with the caller's rights.
    await query(client, 'GRANT EXECUTE ON FUNCTION gp_observability.pg_stat_statements_info() TO gp_operations_monitor');
    // Direct REVOKEs cannot remove privileges inherited from another role.
    // Refuse such drift without changing privileges on that unrelated role.
    if ((await inspect(client)).monitorCanReset) fail('PG_SQL_STATS_RESET_PRIVILEGE');
    await query(client, 'COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  }
  return inspect(client);
}
async function metadata(client, names) {
  const { rows } = await query(client, `/* gp-sql-statistics:metadata */
    SELECT ${utc('pg_catalog.clock_timestamp()')} AS "capturedAt",
      ${utc('pg_catalog.pg_postmaster_start_time()')} AS "postmasterStartedAt",
      ${utc('i.stats_reset')} AS "statsResetAt", i.dealloc::text AS dealloc,
      (SELECT count(*)::integer FROM pg_catalog.pg_database WHERE datname=ANY($1::text[])) AS "databaseCount"
    FROM gp_observability.pg_stat_statements_info i`, [names]);
  if (rows.length !== 1 || rows[0].databaseCount !== names.length) fail('PG_SQL_STATS_DATABASES_MISSING');
  return { capturedAt: timestamp(rows[0].capturedAt), postmasterStartedAt: timestamp(rows[0].postmasterStartedAt),
    statsResetAt: timestamp(rows[0].statsResetAt), dealloc: integer(rows[0].dealloc) };
}
function entry(row, names) {
  if (!names.includes(row.database) || typeof row.toplevel !== 'boolean') fail('PG_SQL_STATS_ENTRY');
  const result = { database: row.database, dbid: integer(row.dbid), userid: integer(row.userid),
    queryid: integer(row.queryid, true), toplevel: row.toplevel, statsSince: timestamp(row.statsSince) };
  for (const key of INTEGERS) result[key] = integer(row[key]);
  for (const key of TIMES) result[key] = finite(row[key]);
  return result;
}
function stableMetadata(before, after) {
  if (before.postmasterStartedAt !== after.postmasterStartedAt) fail('PG_SQL_STATS_SERVER_RESTART');
  if (before.statsResetAt !== after.statsResetAt) fail('PG_SQL_STATS_RESET');
  if (before.dealloc !== after.dealloc) fail('PG_SQL_STATS_EVICTED');
}
async function capture(client, { databases: requested } = {}) {
  const names = databases(requested);
  const state = await inspect(client);
  boundary(state);
  const before = await metadata(client, names);
  const { rows } = await query(client, `/* gp-sql-statistics:capture */
    SELECT d.datname AS database, s.dbid::text AS dbid, s.userid::text AS userid,
      s.queryid::text AS queryid, s.toplevel, ${utc('s.stats_since')} AS "statsSince",
      ${COLUMNS.map((name, index) => `s.${name}::text AS "${INTEGERS[index]}"`).join(', ')},
      ${TIME_COLUMNS.map((name, index) => `s.${name} AS "${TIMES[index]}"`).join(', ')}
    FROM gp_observability.pg_stat_statements(false) s
    JOIN pg_catalog.pg_database d ON d.oid=s.dbid
    WHERE d.datname=ANY($1::text[]) ORDER BY s.dbid, s.userid, s.queryid, s.toplevel LIMIT 5001`, [names]);
  if (rows.length > MAX_ENTRIES) fail('PG_SQL_STATS_LIMIT');
  const entries = rows.map(row => entry(row, names));
  const after = await metadata(client, names);
  stableMetadata(before, after);
  return { format: FORMAT, databases: names, serverVersion: state.serverVersion, extensionVersion: state.extensionVersion,
    track: state.track, trackIoTiming: state.trackIoTiming, captureStartedAt: before.capturedAt, capturedAt: after.capturedAt,
    postmasterStartedAt: after.postmasterStartedAt, statsResetAt: after.statsResetAt, dealloc: after.dealloc, entries };
}
const keyOf = row => [row.dbid, row.userid, row.queryid, row.toplevel].join(':');
function snapshot(input) {
  if (!input || input.format !== FORMAT || !Array.isArray(input.entries) || input.entries.length > MAX_ENTRIES
      || !Number.isInteger(input.serverVersion) || typeof input.extensionVersion !== 'string' || !['top', 'all'].includes(input.track)
      || typeof input.trackIoTiming !== 'boolean') fail('PG_SQL_STATS_SNAPSHOT');
  const names = databases(input.databases);
  const map = new Map();
  for (const raw of input.entries) {
    const row = entry(raw, names), key = keyOf(row);
    if (map.has(key)) fail('PG_SQL_STATS_DUPLICATE_ENTRY');
    map.set(key, row);
  }
  return { databases: names, serverVersion: input.serverVersion, extensionVersion: input.extensionVersion, track: input.track, trackIoTiming: input.trackIoTiming,
    capturedAt: timestamp(input.capturedAt), captureStartedAt: timestamp(input.captureStartedAt),
    postmasterStartedAt: timestamp(input.postmasterStartedAt), statsResetAt: timestamp(input.statsResetAt), dealloc: integer(input.dealloc), entries: map };
}
function compareSnapshots(beforeInput, afterInput) {
  const before = snapshot(beforeInput), after = snapshot(afterInput);
  if (before.databases.join(',') !== after.databases.join(',') || before.serverVersion !== after.serverVersion
      || before.extensionVersion !== after.extensionVersion || before.track !== after.track || before.trackIoTiming !== after.trackIoTiming) fail('PG_SQL_STATS_INCOMPATIBLE');
  stableMetadata(before, after);
  const elapsed = micros(after.captureStartedAt) - micros(before.capturedAt);
  if (micros(before.capturedAt) < micros(before.captureStartedAt) || micros(after.capturedAt) < micros(after.captureStartedAt)
      || elapsed <= 0n) fail('PG_SQL_STATS_WINDOW');
  for (const key of before.entries.keys()) if (!after.entries.has(key)) fail('PG_SQL_STATS_ENTRY_MISSING');
  const entries = [];
  const totals = Object.fromEntries([...INTEGERS.map(name => [name, 0n]), ...TIMES.map(name => [name, 0])]);
  for (const [key, row] of after.entries) {
    const prior = before.entries.get(key);
    if (prior && (prior.statsSince !== row.statsSince || prior.database !== row.database)) fail('PG_SQL_STATS_ENTRY_RESET');
    // A newly observed entry is safe only when its counters started after the
    // entire baseline capture; otherwise its pre-window history is unknown.
    if (!prior && micros(row.statsSince) < micros(before.capturedAt)) fail('PG_SQL_STATS_ENTRY_BASELINE_MISSING');
    const delta = { database: row.database, dbid: row.dbid, userid: row.userid, queryid: row.queryid, toplevel: row.toplevel, statsSince: row.statsSince };
    for (const name of INTEGERS) {
      const value = BigInt(row[name]) - BigInt(prior?.[name] || '0');
      if (value < 0n) fail('PG_SQL_STATS_COUNTER_DECREASE');
      delta[name] = value.toString(); totals[name] += value;
    }
    for (const name of TIMES) {
      const value = row[name] - (prior?.[name] || 0);
      if (value < 0) fail('PG_SQL_STATS_COUNTER_DECREASE');
      delta[name] = finite(value); totals[name] = finite(totals[name] + value);
    }
    delta.meanExecMs = delta.calls === '0' ? null : finite(delta.execMs / Number(delta.calls));
    entries.push(delta);
  }
  for (const name of INTEGERS) totals[name] = totals[name].toString();
  totals.meanExecMs = totals.calls === '0' ? null : finite(totals.execMs / Number(totals.calls));
  // These are counter differences, not rates or CPU utilization. Concurrent
  // SQL can legitimately sum to more execution time than wall-clock time.
  return { format: 'gp-sql-runtime-statistics-delta-v1', databases: before.databases,
    from: before.capturedAt, to: after.capturedAt, minimumWindowMs: Number(elapsed) / 1000,
    track: after.track, trackIoTiming: after.trackIoTiming, totals, entries };
}
module.exports = { inspect, install, capture, compareSnapshots };

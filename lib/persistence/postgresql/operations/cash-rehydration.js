'use strict';
// This is an isolated restore operation, never an application upload/replay.
// Dataset identities, authenticated headers, publications and GP mappings stay
// unchanged. Only the seven omitted encrypted cash row relations are rebuilt.
const crypto = require('node:crypto');
const C = require('../../../data-import-contract');
const H = require('../../../tradefoto-history-profiles');
const { historyBusinessDate } = require('../../../sales-history-query');
const { readTradeFotoFullSource } = require('../../../tradefoto-full-import-source');
const { CASH_SNAPSHOT_TABLES: TABLES } = require('../../statements/cash-snapshots');
const { createCashSnapshotCodec, cashSnapshotMetadataContext, cashSnapshotRowContext, cashSnapshotChain,
  CASH_SNAPSHOT_FORMAT: FORMAT, CASH_SNAPSHOT_INDEX_FIELDS: INDEX_FIELDS } = require('../../repositories/cash-snapshots');
const PLAN_FORMAT = 'grabenplaner-cash-rehydration-v1', EMPTY = '0'.repeat(64);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const equal = (a, b) => { if (!C.equal(a, b)) fail('PG_CASH_RECOVERY_INTEGRITY'); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const safe = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) fail('PG_CASH_RECOVERY_INTEGER'); return n; };
const tableFor = name => { const t = TABLES.find(t => t.name === name); if (!t) fail('PG_CASH_RECOVERY_PROFILE'); return t; };
const ROW_SELECT = 'dataset_slot AS "datasetSlot",source_row AS "sourceRow",source_key AS "sourceKey",business_date AS "businessDate",parent_row AS "parentRow",location_key AS "locationKey",seller_key AS "sellerKey",customer_key AS "customerKey",article_key AS "articleKey",payload';
function proofSources(proof) {
  if (!proof || proof.version !== 1 || proof.available !== true || !/^[a-f0-9]{64}$/.test(proof.generationSha256 || '') || !Array.isArray(proof.kinds)) fail('PG_CASH_RECOVERY_ARCHIVE_REQUIRED');
  const cash = proof.kinds.filter(k => k.kind === 'cash');
  if (cash.length > 1) fail('PG_CASH_RECOVERY_ARCHIVE_REQUIRED');
  const heads=['current', 'previous'].flatMap(generation => {
    const source = cash[0]?.[generation];
    if (!source) return [];
    if (source.kind !== 'cash') fail('PG_CASH_RECOVERY_ARCHIVE_REQUIRED');
    C.sha(source.sourceId); C.sha(source.fileSha256); C.integer(source.bytes, 4096, 512 * 1024 * 1024);
    return [{ ...source, generation }];
  });
  const retained=(proof.retained||[]).filter(source=>source.kind==='cash').map(source=>({...source,generation:'retained'}));
  return [...heads,...retained];
}
function validateCashPlan(plan, { archiveProof } = {}) {
  const exact = (value, keys) => { C.exact(value, keys); if (Object.keys(value).length !== keys.length) fail('PG_CASH_RECOVERY_PLAN'); };
  exact(plan, ['format', 'archiveGenerationSha256', 'datasets', 'planSha256']);
  if (plan.format !== PLAN_FORMAT || !Array.isArray(plan.datasets) || plan.datasets.length > 10000) fail('PG_CASH_RECOVERY_PLAN');
  C.sha(plan.planSha256); C.sha(plan.archiveGenerationSha256);
  const sources = proofSources(archiveProof); equal(plan.archiveGenerationSha256, archiveProof.generationSha256);
  const ids = new Set(); let lastSlot = 0;
  for (const dataset of plan.datasets) {
    exact(dataset, ['id', 'slot', 'scopeId', 'ownerId', 'revision', 'metadataSha256', 'fileSha256', 'bytes', 'generation', 'tables', 'inventory']);
    C.sha(dataset.id); C.sha(dataset.metadataSha256); C.sha(dataset.fileSha256); C.id(dataset.scopeId); C.id(dataset.ownerId);
    C.integer(dataset.slot, 1, Number.MAX_SAFE_INTEGER); C.integer(dataset.revision, 1, Number.MAX_SAFE_INTEGER); C.integer(dataset.bytes, 4096, 512 * 1024 * 1024);
    if (dataset.slot <= lastSlot || ids.has(dataset.id) || !['current', 'previous','retained'].includes(dataset.generation)) fail('PG_CASH_RECOVERY_PLAN');
    lastSlot = dataset.slot; ids.add(dataset.id);
    if (!sources.some(s => s.generation === dataset.generation && s.sourceId === dataset.id && s.fileSha256 === dataset.fileSha256 && s.bytes === dataset.bytes)) fail('PG_CASH_RECOVERY_SOURCE_COVERAGE');
    if (!Array.isArray(dataset.tables) || dataset.tables.length !== TABLES.length || !Array.isArray(dataset.inventory) || dataset.inventory.length !== TABLES.length) fail('PG_CASH_RECOVERY_PLAN');
    let total = 0;
    dataset.tables.forEach((table, i) => {
      exact(table, ['name', 'profileHash', 'expectedRows', 'declaredRows', 'sourceHash']);
      equal([table.name, table.profileHash], [TABLES[i].name, TABLES[i].profile.fingerprint]); C.sha(table.sourceHash);
      C.integer(table.expectedRows, 0, C.LIMITS.rows); C.integer(table.declaredRows, 0, C.LIMITS.rows); total += table.expectedRows;
      const inventory = dataset.inventory[i]; exact(inventory, ['tableIndex', 'rowCount', 'generation']);
      C.integer(inventory.generation, 0, Number.MAX_SAFE_INTEGER); equal([inventory.tableIndex, inventory.rowCount], [i, table.expectedRows]);
    });
    if (total > C.LIMITS.rows) fail('PG_CASH_RECOVERY_PLAN');
  }
  const { planSha256, ...content } = plan; equal(planSha256, hash(C.canonical(content)));
  return plan;
}
async function retainedDatasets(client, protection) {
  if (!client || typeof client.query !== 'function' || !protection || ['open', 'seal', 'digest'].some(k => typeof protection[k] !== 'function')) fail('PG_CASH_RECOVERY_CONFIGURATION');
  const records = (await client.query('SELECT slot::text AS slot,id,scope_id AS "scopeId",owner_id AS "ownerId",revision::text AS revision,created_at AS "createdAt",payload FROM kassa.cash_snapshot_datasets ORDER BY slot')).rows;
  const datasets = [];
  for (const record of records) {
    const row = { ...record, slot: safe(record.slot), revision: safe(record.revision) };
    if (!row.slot || !row.revision) fail('PG_CASH_RECOVERY_INTEGRITY');
    const data = protection.open(row.payload, cashSnapshotMetadataContext(row));
    const actor = { scopeId: row.scopeId, ownerId: row.ownerId };
    if (data.format !== FORMAT || data.scope !== 'full' || data.complete !== true || !['ready', 'needs_review'].includes(data.status)
      || !Array.isArray(data.tables) || data.tables.length !== TABLES.length) fail('PG_CASH_RECOVERY_DATASET_UNVERIFIED');
    C.sha(data.fileSha256); C.integer(data.bytes, 4096, 512 * 1024 * 1024);
    equal(row.id, protection.digest(['source', actor, 'cash', data.fileSha256]));
    equal(data.tables.map(t => [t.name, t.profileHash]), TABLES.map(t => [t.name, t.profile.fingerprint]));
    const inventory = (await client.query('SELECT table_index::text AS "tableIndex",row_count::text AS "rowCount",generation::text AS generation FROM kassa.cash_snapshot_inventory WHERE dataset_slot=$1 ORDER BY table_index', [row.slot])).rows
      .map(i => ({ tableIndex: safe(i.tableIndex), rowCount: safe(i.rowCount), generation: safe(i.generation) }));
    equal(inventory.length, TABLES.length);
    data.tables.forEach((state, i) => {
      C.integer(state.expectedRows, 0, C.LIMITS.rows); C.integer(state.declaredRows, 0, C.LIMITS.rows); C.sha(state.sourceHash); C.sha(state.verifiedHash);
      if (state.complete !== true || state.verified !== true || state.receivedRows !== state.expectedRows || state.verifiedRows !== state.expectedRows) fail('PG_CASH_RECOVERY_DATASET_UNVERIFIED');
      equal(state.sourceHash, state.verifiedHash);
      equal(inventory[i], { tableIndex: i, rowCount: state.expectedRows, generation: state.verifiedGeneration ?? 0 });
    });
    datasets.push({ row, data, inventory });
  }
  return datasets;
}
async function planCashRecovery(client, { protection, archiveProof } = {}) {
  const datasets = await retainedDatasets(client, protection);
  const sources = proofSources(archiveProof);
  const entries = datasets.map(({ row, data, inventory }) => {
    const matching = sources.find(s => s.sourceId === row.id && s.fileSha256 === data.fileSha256 && s.bytes === data.bytes);
    if (!matching) fail('PG_CASH_RECOVERY_SOURCE_COVERAGE');
    return { id: row.id, slot: row.slot, scopeId: row.scopeId, ownerId: row.ownerId, revision: row.revision,
      metadataSha256: hash(row.payload), fileSha256: data.fileSha256, bytes: data.bytes, generation: matching.generation,
      tables: data.tables.map(t => ({ name: t.name, profileHash: t.profileHash, expectedRows: t.expectedRows, declaredRows: t.declaredRows, sourceHash: t.sourceHash })), inventory };
  });
  const plan = { format: PLAN_FORMAT, archiveGenerationSha256: archiveProof.generationSha256, datasets: entries };
  return validateCashPlan({ ...plan, planSha256: hash(C.canonical(plan)) }, { archiveProof });
}
async function assertIsolation(client, isolatedRecovery) {
  const parameters = client?.connectionParameters;
  if (isolatedRecovery !== true || !/^\/tmp\/gp-pg-recovery-[A-Za-z0-9]+$/.test(parameters?.host || '') || Number(parameters.port) !== 55484) fail('PG_CASH_RECOVERY_ISOLATION_REQUIRED');
  const identity = (await client.query("SELECT current_setting('unix_socket_directories') AS socket,current_setting('port') AS port,current_setting('listen_addresses') AS listen")).rows[0];
  if (identity?.socket !== parameters.host || identity.port !== '55484' || !['', '127.0.0.1'].includes(identity.listen)) fail('PG_CASH_RECOVERY_ISOLATION_REQUIRED');
}
function insertSql(table) {
  return `INSERT INTO kassa.${table.sqlName} (dataset_slot,source_row,source_key,business_date,parent_row,location_key,seller_key,customer_key,article_key,payload)
    SELECT r."datasetSlot",r."sourceRow",decode(r."sourceKey",'hex'),r."businessDate",r."parentRow",decode(r."locationKey",'hex'),decode(r."sellerKey",'hex'),decode(r."customerKey",'hex'),decode(r."articleKey",'hex'),r.payload
    FROM jsonb_to_recordset($1::jsonb) AS r("datasetSlot" bigint,"sourceRow" bigint,"sourceKey" text,"businessDate" text,"parentRow" bigint,"locationKey" text,"sellerKey" text,"customerKey" text,"articleKey" text,payload text)`;
}
async function rehydrateCash(client, { protection, archive, plan, isolatedRecovery = false, readSource = readTradeFotoFullSource } = {}) {
  await assertIsolation(client, isolatedRecovery);
  if (!archive || typeof archive.verify !== 'function' || typeof archive.useSource !== 'function' || plan?.format !== PLAN_FORMAT || typeof readSource !== 'function') fail('PG_CASH_RECOVERY_CONFIGURATION');
  let transaction = false, rowsRestored = 0;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); transaction = true;
    const proof = await archive.verify({ allowMissing: false, referenceOnly: true });
    equal(await planCashRecovery(client, { protection, archiveProof: proof }), plan);
    for (const table of TABLES) if ((await client.query(`SELECT EXISTS(SELECT 1 FROM kassa.${table.sqlName}) AS populated`)).rows[0]?.populated !== false) fail('PG_CASH_RECOVERY_NOT_EMPTY');
    const datasets = await retainedDatasets(client, protection);
    for (let index = 0; index < datasets.length; index++) {
      const dataset = datasets[index], entry = plan.datasets[index], actor = { scopeId: dataset.row.scopeId, ownerId: dataset.row.ownerId };
      const codec = createCashSnapshotCodec({ protection, actor });
      await archive.useSource('cash', { generation: entry.generation==='retained'?'current':entry.generation, sourceId:entry.id }, async ({ buffer, password = '' }) => {
      try {
        if (!Buffer.isBuffer(buffer) || buffer.length !== entry.bytes || hash(buffer) !== entry.fileSha256) fail('PG_CASH_RECOVERY_SOURCE_INTEGRITY');
        let manifest = false, current = null, nextTable = 0, completed = false;
        await readSource({ buffer, password, kind: 'cash', profileSelection: entry.tables.map(({ name, profileHash }) => ({ name, profileHash })), send: async message => {
          if (completed) fail('PG_CASH_RECOVERY_PROTOCOL');
          if (message.type === 'manifest') {
            if (manifest || message.kind !== 'cash' || message.fileSha256 !== entry.fileSha256 || message.bytes !== entry.bytes) fail('PG_CASH_RECOVERY_PROTOCOL');
            equal(message.tables, entry.tables.map(({ name, profileHash, declaredRows }) => ({ name, profileHash, declaredRows }))); manifest = true;
          } else if (message.type === 'table') {
            if (!manifest || current || entry.tables[nextTable]?.name !== message.name) fail('PG_CASH_RECOVERY_PROTOCOL');
            const state = entry.tables[nextTable]; equal(message.expectedRows, state.expectedRows);
            current = { table: tableFor(message.name), state, after: 0, chain: EMPTY };
          } else if (message.type === 'rows') {
            if (!current || message.name !== current.table.name || message.startRow !== current.after + 1 || !Array.isArray(message.rows) || !message.rows.length || message.rows.length > C.LIMITS.batch) fail('PG_CASH_RECOVERY_PROTOCOL');
            const pending = [];
            for (const source of message.rows) {
              const sourceRow = ++current.after;
              if (sourceRow > current.state.expectedRows) fail('PG_CASH_RECOVERY_PROTOCOL');
              const normalized = codec.normalize(current.table, source, dataset.data, sourceRow), values = current.table.columns.map(c => normalized.source[c.name]);
              const row = { datasetSlot: dataset.row.slot, sourceRow, sourceKey: codec.identity(current.table, normalized.key), businessDate: historyBusinessDate('cash', current.table.name, normalized.data, H), parentRow: null };
              const parentRequest = H.historyParentRequest('cash', current.table.name, normalized.data);
              if (parentRequest) {
                const parent = tableFor(parentRequest.name), sourceKey = codec.identity(parent, parentRequest.key);
                const record = (await client.query(`SELECT ${ROW_SELECT} FROM kassa.${parent.sqlName} WHERE dataset_slot=$1 AND source_key=$2`, [dataset.row.slot, sourceKey])).rows[0];
                if (!record) fail('PG_CASH_RECOVERY_PARENT_MISSING');
                record.datasetSlot = safe(record.datasetSlot); record.sourceRow = safe(record.sourceRow); if (record.parentRow !== null) record.parentRow = safe(record.parentRow);
                codec.decode(dataset, parent, record); row.parentRow = record.sourceRow;
              }
              for (const [field, candidates] of Object.entries(INDEX_FIELDS)) {
                const sourceName = candidates.find(n => Object.hasOwn(normalized.source, n)), value = normalized.source[sourceName];
                row[field] = value === null || value === undefined || value === '' || value === '0' ? null : Buffer.from(protection.digest([FORMAT, 'source-reference', actor.scopeId, field, String(value)]), 'hex');
              }
              const stored = { ...row, payload: protection.seal(values, cashSnapshotRowContext(dataset.row, current.table, row)) };
              codec.decode(dataset, current.table, stored);
              pending.push(Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, Buffer.isBuffer(value) ? value.toString('hex') : value])));
              current.chain = cashSnapshotChain(current.chain, sourceRow, values);
            }
            const inserted = await client.query(insertSql(current.table), [JSON.stringify(pending)]);
            equal(inserted.rowCount, pending.length); rowsRestored += pending.length;
          } else if (message.type === 'table-complete') {
            if (!current || current.table.name !== message.name) fail('PG_CASH_RECOVERY_PROTOCOL');
            equal(current.after, current.state.expectedRows); equal(current.chain, current.state.sourceHash); current = null; nextTable++;
          } else if (message.type === 'complete') {
            if (!manifest || current || nextTable !== TABLES.length || message.tables !== TABLES.length || message.rows !== entry.tables.reduce((n, t) => n + t.expectedRows, 0)) fail('PG_CASH_RECOVERY_PROTOCOL');
            completed = true;
          } else fail('PG_CASH_RECOVERY_PROTOCOL');
        } });
        if (!completed) fail('PG_CASH_RECOVERY_PROTOCOL');
      } finally { if (Buffer.isBuffer(buffer)) buffer.fill(0); }
      });
      // INSERT triggers ran normally, including all FK/uniqueness guards. The
      // retained authenticated proof describes the original inventory version;
      // restore it only after every source value and chain matched that proof.
      for (const inventory of dataset.inventory) {
        const table = TABLES[inventory.tableIndex];
        equal(safe((await client.query(`SELECT count(*)::text AS count FROM kassa.${table.sqlName} WHERE dataset_slot=$1`, [dataset.row.slot])).rows[0]?.count), inventory.rowCount);
        const changed = await client.query('UPDATE kassa.cash_snapshot_inventory SET row_count=$1,generation=$2 WHERE dataset_slot=$3 AND table_index=$4', [inventory.rowCount, inventory.generation, dataset.row.slot, inventory.tableIndex]);
        equal(changed.rowCount, 1);
      }
    }
    equal(await planCashRecovery(client, { protection, archiveProof: proof }), plan);
    await client.query('COMMIT'); transaction = false;
    return { verified: true, format: PLAN_FORMAT, datasets: datasets.length, rowsRestored, metadataUnchanged: true, publicationsUnchanged: true };
  } catch (error) { if (transaction) await client.query('ROLLBACK'); throw error; }
}
module.exports = { PLAN_FORMAT, validateCashPlan, planCashRecovery, rehydrateCash };

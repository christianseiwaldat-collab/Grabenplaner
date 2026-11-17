'use strict';
// Recovery-only composition of the ordinary importer. A compact source manifest
// replaces copied source staging/history values; GP-owned anchors stay intact.
const crypto = require('node:crypto'), os = require('node:os');
const C = require('../../../data-import-contract');
const S = require('../../../tradefoto-full-import-source');
const M = require('../../../tradefoto-master-profiles');
const H = require('../../../tradefoto-history-profiles');
const A = require('../../../data-import-source-archive');
const { orderReplaySources } = require('./access-replay-order');
const RUNTIME = require('../../statements/data-import-runtime').DATA_IMPORT_RUNTIME_STATEMENTS;
const IMPORT = require('../../statements/data-import').DATA_IMPORT_STATEMENTS;
const FORMAT = 'grabenplaner-access-source-replay-v1', MAX_SOURCES = 10000, MAX_RANGES = 100000, MAX_BYTES = 8 * 1024 * 1024;
const POLICIES = new WeakSet(), HEX = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = value => sha(C.canonical(value));
const exact = (value, keys) => { if (!C.plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('PG_SOURCE_REPLAY_PLAN'); };
const safe = value => { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) fail('PG_SOURCE_REPLAY_INTEGER'); return result; };
const sourceContext = row => ['source', row.scopeId, row.ownerId, row.id, row.revision];
const sourceRow = row => ({ ...row, revision: safe(row.revision) });
const metadataHash = row => hash(sourceRow(row));
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
function sources(proof) { return A.appliedImportSourceArchiveEntries(proof); }
function profileDefinitions(kind, tables) { return S.definitions(kind, tables.map(({ name, profileHash }) => ({ name, profileHash }))); }
function cashDefinitions(tables) { return S.definitions('cash', S.definitions('cash').map(def => ({ name: def.name, profileHash: tables.find(table => table.name === def.name)?.profileHash || def.profile.fingerprint }))); }
function validateTable(table, def) {
  exact(table, ['name', 'profileHash', 'declaredRows', 'expectedRows', 'runId', 'deferred', 'countApproved', 'exceptionRanges']);
  if (!def || table.name !== def.name || table.profileHash !== def.profile.fingerprint || ![null, 'INCOMPLETE_STOCK_SNAPSHOT'].includes(table.deferred) || typeof table.countApproved !== 'boolean' || !Array.isArray(table.exceptionRanges)) fail('PG_SOURCE_REPLAY_PLAN');
  C.integer(table.declaredRows); C.integer(table.expectedRows); C.sha(table.runId); let after = 0;
  for (const range of table.exceptionRanges) { exact(range, ['first', 'last']); C.integer(range.first, 1, table.expectedRows); C.integer(range.last, range.first, table.expectedRows); if (range.first <= after) fail('PG_SOURCE_REPLAY_PLAN'); after = range.last; }
}
function validateReplayPlan(plan, { archiveProof } = {}) {
  exact(plan, ['format', 'archiveGenerationSha256', 'sources', 'stockPublications', 'planSha256']);
  if (plan.format !== FORMAT || !Array.isArray(plan.sources) || plan.sources.length > MAX_SOURCES || !HEX.test(plan.planSha256) || !HEX.test(plan.archiveGenerationSha256)) fail('PG_SOURCE_REPLAY_PLAN');
  const applied = new Map(sources(archiveProof).map(entry => [entry.sourceId, entry])), seen = new Set(), genericRuns = new Set(); let ranges = 0;
  if (plan.archiveGenerationSha256 !== archiveProof.generationSha256) fail('PG_SOURCE_REPLAY_ARCHIVE_CHANGED');
  for (const source of plan.sources) {
    exact(source, ['sourceId', 'kind', 'fileSha256', 'bytes', 'strategy', 'scopeId', 'ownerId', 'createdAt', 'appliedAt', 'orderBasis', 'retirement', 'sourceRevision', 'sourceMetadataSha256', 'tables', 'genericCash', 'genericCashBatches']);
    const entry = applied.get(source.sourceId);
    if (!entry || seen.has(source.sourceId) || source.kind !== entry.kind || source.fileSha256 !== entry.fileSha256 || source.bytes !== entry.bytes
      || !['normal-import', 'cash-snapshot-plan', 'cash-history-import', 'skip-reverted', 'skip-retired-obsolete'].includes(source.strategy) || (source.kind === 'cash') !== ['cash-snapshot-plan', 'cash-history-import'].includes(source.strategy)) fail('PG_SOURCE_REPLAY_SOURCE_COVERAGE');
    seen.add(source.sourceId); C.id(source.scopeId); C.id(source.ownerId); C.utc(source.createdAt); C.sha(source.sourceMetadataSha256); C.integer(source.sourceRevision, 1, Number.MAX_SAFE_INTEGER);
    if (source.strategy === 'skip-retired-obsolete') {
      if (source.appliedAt !== null || source.orderBasis !== 'retirement-successor') fail('PG_SOURCE_REPLAY_PLAN');
      exact(source.retirement, ['successorId', 'startedAt', 'complete', 'completedAt']); C.sha(source.retirement.successorId); C.utc(source.retirement.startedAt); C.utc(source.retirement.completedAt);
      if (source.retirement.complete !== true || source.retirement.completedAt < source.retirement.startedAt) fail('PG_SOURCE_REPLAY_PLAN');
    } else {
      C.utc(source.appliedAt);
      if (!['apply-progress', 'core-update', 'prior-recovery'].includes(source.orderBasis) || source.retirement !== null) fail('PG_SOURCE_REPLAY_PLAN');
    }
    if (!Array.isArray(source.tables)) fail('PG_SOURCE_REPLAY_PLAN'); const defs = profileDefinitions(source.kind, source.tables);
    let total = 0;
    source.tables.forEach((table, i) => {
      validateTable(table, defs[i]); total += table.expectedRows;
      ranges += table.exceptionRanges.length;
    });
    if (typeof source.genericCash !== 'boolean' || !Array.isArray(source.genericCashBatches) || source.genericCashBatches.length > 10000 || source.genericCash !== !!source.genericCashBatches.length || source.genericCash && source.kind !== 'cash') fail('PG_SOURCE_REPLAY_PLAN');
    const runIds = new Set();
    for (const batch of source.genericCashBatches) {
      exact(batch, ['scopeId', 'ownerId', 'snapshotAt', 'appliedAt', 'tables']); C.id(batch.scopeId); C.id(batch.ownerId); C.utc(batch.snapshotAt); C.utc(batch.appliedAt);
      if (!Array.isArray(batch.tables) || !batch.tables.length || batch.tables.length > defs.length) fail('PG_SOURCE_REPLAY_PLAN'); let index = -1;
      const batchDefs = cashDefinitions(batch.tables);
      for (const table of batch.tables) { const next = batchDefs.findIndex(def => def.name === table.name); if (next <= index || runIds.has(table.runId) || genericRuns.has(table.runId)) fail('PG_SOURCE_REPLAY_PLAN'); index = next; runIds.add(table.runId); genericRuns.add(table.runId); validateTable(table, batchDefs[next]); ranges += table.exceptionRanges.length; }
    }
    if (total > C.LIMITS.rows || ranges > MAX_RANGES) fail('PG_SOURCE_REPLAY_LIMIT');
  }
  // Revalidate the compact dependency graph without trusting array order. The
  // actual header status/catalog eligibility is authenticated during creation;
  // its original encrypted metadata is bound again before isolated replay.
  const ordered = orderReplaySources(plan.sources, { headers: plan.sources.map(source => ({ sourceId: source.sourceId, scopeId: source.scopeId, ownerId: source.ownerId,
    data: { complete: true, kind: source.kind, status: source.strategy === 'skip-retired-obsolete' ? 'purged' : source.strategy === 'skip-reverted' ? 'reverted' : 'applied',
      tables: source.tables, retirement: source.retirement, catalog: { complete: true } } })) });
  if (!C.equal(ordered, plan.sources)) fail('PG_SOURCE_REPLAY_PLAN');
  if (!Array.isArray(plan.stockPublications) || plan.stockPublications.length > MAX_SOURCES) fail('PG_SOURCE_REPLAY_PLAN');
  const stockScopes = new Set();
  for (const stock of plan.stockPublications) {
    exact(stock, ['scopeId', 'sourceInstance', 'profileHash', 'fileSha256', 'snapshotAt', 'ownerId', 'expectedRows', 'originalRunId']);
    C.id(stock.scopeId); C.id(stock.sourceInstance); C.id(stock.ownerId); C.sha(stock.profileHash); C.sha(stock.fileSha256); C.sha(stock.originalRunId); C.utc(stock.snapshotAt); C.integer(stock.expectedRows);
    const key = C.canonical([stock.scopeId, stock.sourceInstance]);
    if (stock.sourceInstance !== 'tradefoto-trade' || stockScopes.has(key) || !plan.sources.some(source => source.strategy === 'normal-import' && source.kind === 'trade' && source.scopeId === stock.scopeId && source.ownerId === stock.ownerId
      && source.fileSha256 === stock.fileSha256 && source.createdAt === stock.snapshotAt && source.tables.some(table => table.name === 'ARTIKEL_FILIALEN' && !table.deferred
        && table.runId === stock.originalRunId && table.profileHash === stock.profileHash && table.expectedRows === stock.expectedRows && H.usesSnapshotMembership(H.profileFor('trade', table.name, table.profileHash))))) fail('PG_SOURCE_REPLAY_STOCK_COVERAGE');
    stockScopes.add(key);
  }
  if (seen.size !== applied.size || Buffer.byteLength(C.canonical(plan)) > MAX_BYTES || plan.planSha256 !== hash({ format: plan.format, archiveGenerationSha256: plan.archiveGenerationSha256, sources: plan.sources, stockPublications: plan.stockPublications })) fail('PG_SOURCE_REPLAY_PLAN');
  return plan;
}
function exceptionRanges(rows) {
  const result = []; let previous = 0;
  for (const row of rows) {
    const ordinal = safe(row.ordinal); if (ordinal < 1 || ordinal <= previous) fail('PG_SOURCE_REPLAY_EXCEPTIONS'); previous = ordinal;
    const last = result.at(-1); if (last && last.last + 1 === ordinal) last.last = ordinal; else result.push({ first: ordinal, last: ordinal });
    if (result.length > MAX_RANGES) fail('PG_SOURCE_REPLAY_LIMIT');
  }
  return result;
}
function sourceTolerances(data, source, { row, protection } = {}) {
  const defaults = require('../../../tradefoto-source-tolerances').TRADEFOTO_SOURCE_TOLERANCES;
  const receiptValue = data.independentCountProof || data.recoveryReplay?.originalIndependentCountProof;
  if (!receiptValue) return defaults;
  if (data.independentCountProof && row && protection) {
    const registry = require('../../../data-import-known-af-proof').loadSourceProofRegistry({ protection, sourceRow: row, sourceTolerances: defaults,
      acceptedVerifierAssets: require('../../../data-import-af-verifier-policy').acceptedVerifierAssets });
    if (!registry.available) fail('PG_SOURCE_REPLAY_COUNT_PROOF'); return registry.registry;
  }
  const known = require('../../../data-import-known-af-proof'), receipt = known.validateReceipt(receiptValue), request = receipt.request;
  const table = source.tables.find(table => table.name === request.sourceTable);
  const allowed = require('../../../data-import-af-verifier-policy').acceptedVerifierAssets;
  if (!table || !allowed.some(policy => C.equal(policy, receipt.verifier)) || request.sourceId !== source.sourceId || request.scopeId !== source.scopeId || request.ownerId !== source.ownerId
    || request.kind !== source.kind || request.fileSha256 !== source.fileSha256 || request.bytes !== source.bytes || request.profileHash !== table.profileHash
    || request.expectedRows !== table.expectedRows || request.declaredRows !== table.declaredRows) fail('PG_SOURCE_REPLAY_COUNT_PROOF');
  // The independent proof authenticates these unchanged file/profile/count
  // bytes. Its old run ID stays in the original receipt; the new recovery run
  // receives a separate explicit-approval tolerance, never a forged receipt.
  const proof = require('../../../data-import-source-tolerance').defineDataImportSourceTolerance({ id: 'recovery-af-' + receipt.evidenceSha256.slice(0, 48), recordedAt: receipt.verifiedAt,
    approvalReference: 'recovered-original-owner-receipt', reason: 'Original independently verified source counts during isolated recovery', evidenceReference: 'source-count-proof:' + receipt.evidenceSha256,
    sourceSystem: request.sourceSystem, sourceInstance: request.sourceInstance, sourceTable: request.sourceTable, profileHash: request.profileHash,
    schemaSha256: request.applicationSchemaSha256, fileSha256: request.fileSha256, declaredRows: request.declaredRows, expectedRows: request.expectedRows, requiresExplicitApproval: true });
  return [...defaults, proof];
}
async function createReplayPlan({ core, sales, protection, archiveProof, checkBudget = () => {} }) {
  if (!core?.query || !protection || typeof checkBudget !== 'function') fail('PG_SOURCE_REPLAY_CONFIGURATION'); checkBudget();
  const applied = new Map(sources(archiveProof).map(entry => [entry.sourceId, entry]));
  const rows = (await core.query('SELECT id,scope_id AS "scopeId",owner_id AS "ownerId",revision::text AS revision,created_at AS "createdAt",updated_at AS "updatedAt",payload FROM gp.data_import_sources ORDER BY id')).rows;
  const planned = [], plannedHeaders = [], plannedGenericRuns = new Set();
  for (const original of rows) {
    checkBudget(); const row = sourceRow(original), data = protection.open(row.payload, sourceContext(row)), entry = applied.get(row.id);
    // Pending choices and obsolete upload headers remain opaque Core/audit
    // evidence. The owned-state coverage check separately requires an archived
    // planned source for EVERY omitted current business fact; an obsolete
    // technical header alone does not force copying all historical staging.
    if (!entry) continue;
    if (data.kind !== entry.kind || data.fileSha256 !== entry.fileSha256 || data.bytes !== entry.bytes || row.id !== protection.digest(['source', { scopeId: row.scopeId, ownerId: row.ownerId }, data.kind, data.fileSha256])
      || !data.complete || !['applied', 'ready', 'reverted', 'purged'].includes(data.status)) fail('PG_SOURCE_REPLAY_SOURCE_UNCONFIRMED');
    const strategy = data.status === 'purged' ? 'skip-retired-obsolete' : data.kind === 'cash' ? data.storage === require('../../repositories/cash-snapshots').CASH_SNAPSHOT_FORMAT ? 'cash-snapshot-plan' : 'cash-history-import' : data.status === 'reverted' ? 'skip-reverted' : 'normal-import';
    const defs = profileDefinitions(data.kind, data.tables), tables = [];
    for (let i = 0; i < defs.length; i++) {
      checkBudget(); const table = data.tables[i], run = table.run;
      if (!run || table.name !== defs[i].name || !HEX.test(run.id)) fail('PG_SOURCE_REPLAY_RUN_REQUIRED');
      const expectedRows = safe(run.expectedRows ?? run.receivedRows), countApproved = !!(run.acceptedDeviations?.length || run.sourceToleranceReceipts?.length);
      let exceptions = [];
      if (strategy === 'normal-import') {
        if (!sales?.query) fail('PG_SOURCE_REPLAY_CONFIGURATION');
        const actual = (await sales.query('SELECT id,scope_id AS "scopeId",owner_id AS "ownerId",profile_hash AS "profileHash",manifest,attempt_id AS "attemptId",status,received_count::text AS "receivedCount" FROM integration.data_import_runs WHERE id=$1', [run.id])).rows[0];
        if (!actual || actual.scopeId !== row.scopeId || actual.ownerId !== row.ownerId || actual.profileHash !== table.profileHash || safe(actual.receivedCount) !== expectedRows
          || !['applied', 'purged', ...(table.deferred === 'INCOMPLETE_STOCK_SNAPSHOT' ? ['needs_review'] : [])].includes(actual.status)) fail('PG_SOURCE_REPLAY_RUN_UNCONFIRMED');
        const manifest = json(actual.manifest);
        if (manifest.fileSha256 !== data.fileSha256 || manifest.snapshotAt !== row.createdAt || manifest.sourceInstance !== 'tradefoto-' + data.kind
          || manifest.expectedRows !== expectedRows || manifest.declaredRows !== table.declaredRows
          || protection.digest(['run', C.VERSION, { scopeId: row.scopeId, ownerId: row.ownerId }, table.profileHash, manifest, actual.attemptId]) !== run.id) fail('PG_SOURCE_REPLAY_RUN_INTEGRITY');
        exceptions = exceptionRanges((await sales.query("SELECT row_number::text AS ordinal FROM integration.data_import_rows WHERE run_id=$1 AND state NOT IN ('applied','unchanged','duplicate') ORDER BY row_number", [run.id])).rows);
        if (actual.status === 'purged' && expectedRows && !data.retirement) fail('PG_SOURCE_REPLAY_EXCEPTIONS_REQUIRED');
      }
      tables.push({ name: table.name, profileHash: table.profileHash, declaredRows: safe(table.declaredRows), expectedRows, runId: run.id,
        deferred: table.deferred || null, countApproved, exceptionRanges: exceptions });
    }
    const priorApplied = data.recoveryReplay?.namespace === FORMAT ? data.recoveryReplay.originalAppliedAt : null;
    // Archive adoption/capture can occur years after the original Apply. Its
    // timestamp cannot determine business chronology; use authenticated Core
    // progress, then the original Core header's last known update instead.
    const applyProgress = data.progress?.operation === 'apply' && data.progress.finishedAt;
    const appliedAt = strategy === 'skip-retired-obsolete' ? null : priorApplied || applyProgress || row.updatedAt;
    const orderBasis = strategy === 'skip-retired-obsolete' ? 'retirement-successor' : priorApplied ? 'prior-recovery' : applyProgress ? 'apply-progress' : 'core-update';
    if (appliedAt !== null) C.utc(appliedAt);
    const genericCashBatches = [];
    if (data.kind === 'cash') {
      if (!sales?.query) fail('PG_SOURCE_REPLAY_CONFIGURATION');
      const runs = (await sales.query(`SELECT DISTINCT r.id,r.scope_id AS "scopeId",r.owner_id AS "ownerId",r.profile_hash AS "profileHash",r.manifest,r.attempt_id AS "attemptId",r.status,r.received_count::text AS "receivedCount",r.updated_at AS "updatedAt"
        FROM integration.data_import_runs r JOIN integration.import_history_versions v ON v.run_id=r.id
        JOIN integration.import_history_records h ON h.id=v.record_id AND h.revision=v.revision
        WHERE r.manifest::jsonb->>'fileSha256'=$1 AND r.manifest::jsonb->>'sourceInstance'='tradefoto-cash'
        AND r.status IN ('applied','purged') ORDER BY r.id`, [data.fileSha256])).rows;
      const groups = new Map();
      for (const actual of runs) {
        if (plannedGenericRuns.has(actual.id)) continue;
        const manifest = json(actual.manifest), def = defs.find(d => H.profilesFor(d.source, d.name).some(profile => profile.fingerprint === actual.profileHash));
        if (!def || manifest.fileSha256 !== data.fileSha256 || manifest.sourceInstance !== 'tradefoto-cash' || safe(actual.receivedCount) !== manifest.expectedRows
          || protection.digest(['run', C.VERSION, { scopeId: actual.scopeId, ownerId: actual.ownerId }, actual.profileHash, manifest, actual.attemptId]) !== actual.id) fail('PG_SOURCE_REPLAY_RUN_INTEGRITY');
        // Purging can erase the original row decisions. An empty exception
        // query must never turn that missing evidence into approval of every
        // original cash row; retain the full backup path for this old case.
        if (actual.status === 'purged' && manifest.expectedRows > 0) fail('PG_SOURCE_REPLAY_EXCEPTIONS_REQUIRED');
        plannedGenericRuns.add(actual.id);
        const groupKey = C.canonical([actual.scopeId, actual.ownerId, manifest.snapshotAt, actual.attemptId]);
        if (!groups.has(groupKey)) groups.set(groupKey, { scopeId: actual.scopeId, ownerId: actual.ownerId, snapshotAt: manifest.snapshotAt, appliedAt: actual.updatedAt || manifest.snapshotAt, tables: [] });
        const exceptions = exceptionRanges((await sales.query("SELECT row_number::text AS ordinal FROM integration.data_import_rows WHERE run_id=$1 AND state NOT IN ('applied','unchanged','duplicate') ORDER BY row_number", [actual.id])).rows);
        groups.get(groupKey).tables.push({ name: def.name, profileHash: actual.profileHash, declaredRows: manifest.declaredRows, expectedRows: manifest.expectedRows, runId: actual.id,
          deferred: null, countApproved: !!manifest.acceptedDeviations?.length, exceptionRanges: exceptions });
      }
      for (const batch of [...groups.values()].sort((a, b) => a.appliedAt.localeCompare(b.appliedAt) || a.snapshotAt.localeCompare(b.snapshotAt) || a.ownerId.localeCompare(b.ownerId))) {
        batch.tables.sort((a, b) => defs.findIndex(d => d.name === a.name) - defs.findIndex(d => d.name === b.name)); genericCashBatches.push(batch);
      }
    }
    planned.push({ sourceId: row.id, kind: data.kind, fileSha256: data.fileSha256, bytes: data.bytes, strategy, scopeId: row.scopeId, ownerId: row.ownerId,
      createdAt: row.createdAt, appliedAt, orderBasis, retirement: data.retirement ?? null, sourceRevision: row.revision, sourceMetadataSha256: metadataHash(row), tables, genericCash: !!genericCashBatches.length, genericCashBatches });
    plannedHeaders.push({ sourceId: row.id, scopeId: row.scopeId, ownerId: row.ownerId, data });
  }
  const ordered = orderReplaySources(planned, { headers: plannedHeaders });
  const stockPublications = [], stockScopes = new Set();
  if (sales?.query) for (const row of (await sales.query(`SELECT run_id AS "runId",scope_id AS "scopeId",source_instance AS "sourceInstance",profile_hash AS "profileHash",file_sha256 AS "fileSha256",snapshot_at AS "snapshotAt",owner_id AS "ownerId",expected_rows::text AS "expectedRows",status,payload
    FROM integration.import_history_snapshots WHERE status='published' ORDER BY snapshot_at DESC,run_id DESC`)).rows) {
    checkBudget(); const profile = H.TRADEFOTO_HISTORY_READABLE_PROFILES.find(profile => profile.fingerprint === row.profileHash); if (!H.usesSnapshotMembership(profile)) continue;
    const key = C.canonical([row.scopeId, row.sourceInstance]); if (stockScopes.has(key)) continue;
    const expectedRows = safe(row.expectedRows);
    const value = protection.open(row.payload, ['history-snapshot', row.runId, row.scopeId, row.sourceInstance, row.profileHash, row.fileSha256, row.snapshotAt, row.ownerId, expectedRows, 'published']);
    if (!C.equal(value, { version: 1 })) fail('PG_SOURCE_REPLAY_STOCK_INTEGRITY');
    stockPublications.push({ scopeId: row.scopeId, sourceInstance: row.sourceInstance, profileHash: row.profileHash, fileSha256: row.fileSha256, snapshotAt: row.snapshotAt,
      ownerId: row.ownerId, expectedRows, originalRunId: row.runId }); stockScopes.add(key);
  }
  const body = { format: FORMAT, archiveGenerationSha256: archiveProof.generationSha256, sources: ordered, stockPublications };
  return validateReplayPlan({ ...body, planSha256: hash(body) }, { archiveProof });
}
async function assertIsolation(core, sales, isolatedRecovery) {
  if (isolatedRecovery !== true || Object.values(os.networkInterfaces()).flat().some(address => !address.internal)) fail('PG_SOURCE_REPLAY_ISOLATION_REQUIRED');
  let socket;
  for (const [domain, client] of [['core', core], ['sales', sales]]) {
    const parameters = client?.connectionParameters;
    if (!/^\/tmp\/gp-pg-recovery-[A-Za-z0-9]+$/.test(parameters?.host || '') || Number(parameters.port) !== 55484 || socket && socket !== parameters.host) fail('PG_SOURCE_REPLAY_ISOLATION_REQUIRED'); socket = parameters.host;
    const identity = (await client.query("SELECT current_setting('unix_socket_directories') AS socket,current_setting('port') AS port,current_setting('listen_addresses') AS listen,(SELECT domain FROM gp.environment_contract) AS domain")).rows[0];
    if (identity?.socket !== socket || identity.port !== '55484' || !['', '127.0.0.1'].includes(identity.listen) || identity.domain !== domain) fail('PG_SOURCE_REPLAY_ISOLATION_REQUIRED');
  }
}
function assertReplayRuntimePolicy(policy) {
  if (!POLICIES.has(policy)) return require('./access-fresh-rebuild').assertFreshRuntimePolicy(policy);
  if (policy.namespace !== FORMAT || policy.isolatedRecovery !== true) C.fail('IMPORT_COMPOSITION_INVALID'); return policy;
}
function session(ownerId) { return { employeeNumber: ownerId, isEmployee: true, role: 'developer', permissions: [
  ...Object.values(require('../../../data-import-access').DATA_IMPORT_PERMISSIONS), ...Object.values(require('../../../sales-article-catalog-access').SALES_ARTICLE_CATALOG_PERMISSIONS),
  'sales:analytics:access', 'sales:analytics:company:read',
] }; }
async function replayCashHistory({ source, archive, access, protection, plan, onProgress, checkBudget, tolerances }) {
  const repository = require('../../repositories/data-import').createDataImportRepository(access), completed = [];
  const ordinary = require('../../repositories/import-history').createImportHistoryWriters({ protection, authorize: () => true, resolveMasterSourceInstance: () => 'tradefoto-trade' });
  for (let index = 0; index < source.genericCashBatches.length; index++) {
    const batch = source.genericCashBatches[index], defs = cashDefinitions(batch.tables), excluded = new Set(), runs = new Map();
    const writers = Object.fromEntries(Object.entries(ordinary).map(([entity, writer]) => [entity, { ...writer, async review(tx, record, context) {
      const result = await writer.review(tx, record, context), def = defs.find(def => def.profile.fingerprint === context.profileHash);
      const identity = protection.digest(['identity', batch.scopeId, def.profile.sourceSystem, 'tradefoto-cash', def.name, def.profile.entity, def.profile.keyFields, record.key]);
      return !excluded.has(identity) || result.issue ? result : { issue: 'RECOVERY_ORIGINAL_SOURCE_EXCEPTION', rewrite: false,
        token: protection.digest(['recovery-cash-exclusion', plan.planSha256, context.runId, identity, result.token]) };
    } }]));
    const engine = require('../../../data-import-engine').createDataImportEngine({ repository, protection, profiles: defs.map(def => def.profile), writers, sourceTolerances: tolerances,
      sharedPayloads: true, allowPartialApply: true, getActor: () => ({ scopeId: batch.scopeId, ownerId: batch.ownerId }), authorize: () => true });
    let current = null, manifest = false, finished = false;
    await archive.useFile(source.sourceId, async ({ buffer, password, source: entry }) => {
      if (buffer.length !== source.bytes || sha(buffer) !== source.fileSha256 || entry?.sourceId !== source.sourceId) fail('PG_SOURCE_REPLAY_SOURCE_CHANGED');
      await S.readTradeFotoFullSource({ buffer, password, kind: 'cash', profileSelection: defs.map(def => ({ name: def.name, profileHash: def.profile.fingerprint })), send: async event => {
        checkBudget();
        if (event.type === 'manifest') { if (manifest || event.kind !== 'cash' || event.fileSha256 !== source.fileSha256 || event.bytes !== source.bytes) fail('PG_SOURCE_REPLAY_PROTOCOL'); manifest = true; return; }
        if (!manifest || finished) fail('PG_SOURCE_REPLAY_PROTOCOL');
        const table = batch.tables.find(table => table.name === event.name), def = defs.find(def => def.name === event.name);
        if (event.type === 'table') {
          if (current) fail('PG_SOURCE_REPLAY_PROTOCOL'); current = { name: event.name, selected: !!table };
          if (table) {
            if (!def || event.expectedRows !== table.expectedRows || event.declaredRows !== table.declaredRows) fail('PG_SOURCE_REPLAY_SOURCE_CHANGED');
            runs.set(event.name, await engine.start({ profileHash: table.profileHash, attemptId: 'recovery-' + plan.planSha256.slice(0, 24) + '-cash-' + index,
              manifest: { sourceInstance: 'tradefoto-cash', fileSha256: source.fileSha256, schemaSha256: def.profile.schemaSha256,
                expectedRows: table.expectedRows, declaredRows: table.declaredRows, snapshotAt: batch.snapshotAt, gates: [] } }));
          }
          return { resumeAfter: 0 };
        }
        if (event.type === 'rows') {
          if (!current || current.name !== event.name) fail('PG_SOURCE_REPLAY_PROTOCOL');
          if (table) {
            for (let i = 0; i < event.rows.length; i++) {
              const ordinal = event.startRow + i; if (!table.exceptionRanges.some(range => ordinal >= range.first && ordinal <= range.last)) continue;
              let record; try { record = C.normalizeDataImportRow(def.profile, event.rows[i]); } catch (error) { if (error instanceof C.DataImportError) continue; throw error; }
              excluded.add(protection.digest(['identity', batch.scopeId, def.profile.sourceSystem, 'tradefoto-cash', def.name, def.profile.entity, def.profile.keyFields, record.key]));
            }
            const run = runs.get(event.name); runs.set(event.name, await engine.stage(run.id, { expectedRevision: run.revision, startRow: event.startRow, rows: event.rows }));
          }
          return;
        }
        if (event.type === 'table-complete') {
          if (!current || current.name !== event.name) fail('PG_SOURCE_REPLAY_PROTOCOL');
          if (table) { const run = runs.get(event.name); runs.set(event.name, await engine.seal(run.id, run.revision)); }
          current = null; return;
        }
        if (event.type !== 'complete' || current || runs.size !== batch.tables.length) fail('PG_SOURCE_REPLAY_PROTOCOL'); finished = true;
      } });
    });
    if (!finished) fail('PG_SOURCE_REPLAY_PROTOCOL');
    for (const table of batch.tables) {
      let run = runs.get(table.name), steps = 0;
      while (run.status === 'reviewing') { checkBudget(); if (++steps > 10_000_000) fail('PG_SOURCE_REPLAY_STEP_LIMIT'); run = await engine.review(run.id, run.revision); }
      if (run.gates.length) { if (!table.countApproved) fail('PG_SOURCE_REPLAY_ORIGINAL_GATE'); run = await engine.acceptSourceTolerance(run.id, run.revision); }
      while (run.status !== 'applied') {
        checkBudget(); if (++steps > 10_000_000 || !['ready', 'needs_review', 'applying', 'reviewing'].includes(run.status)) fail('PG_SOURCE_REPLAY_STATE');
        onProgress({ phase: 'generic-cash-history', sourceId: source.sourceId, table: table.name, step: steps });
        run = run.status === 'reviewing' ? await engine.review(run.id, run.revision) : await engine.apply(run.id, run.revision);
      }
      completed.push({ originalRunId: table.runId, runId: run.id, table: table.name, status: run.status, receivedRows: run.receivedRows, counts: run.counts });
    }
  }
  return completed;
}
async function replaySources({ core, sales, access, vault, archive, plan, ownedPlan, isolatedRecovery = false, onProgress = () => {}, checkBudget = () => {} }) {
  if (!access?.transaction || !vault || !archive?.useFile || typeof onProgress !== 'function' || typeof checkBudget !== 'function') fail('PG_SOURCE_REPLAY_CONFIGURATION');
  await assertIsolation(core, sales, isolatedRecovery); checkBudget();
  const archiveProof = await archive.verify({ referenceOnly: true }); validateReplayPlan(plan, { archiveProof });
  if (ownedPlan && !/^grabenplaner-access-owned-state-v3$/.test(ownedPlan.format || '')) fail('PG_SOURCE_REPLAY_OWNED_PLAN');
  const protection = await require('../../../data-import-managed-protection').loadManagedDataImportProtection({ access, vault });
  if (!protection) fail('PG_SOURCE_REPLAY_KEYS_REQUIRED');
  const preserved = new Map((await sales.query('SELECT id,scope_id AS "scopeId",source_instance AS "sourceInstance",source_table AS "sourceTable",identity_hash AS "identityHash",revision::text AS revision FROM trade.import_master_records ORDER BY id')).rows.map(row => [row.scopeId + ':' + row.identityHash, sourceRow(row)]));
  const preservedHistory = new Map((await sales.query('SELECT id,scope_id AS "scopeId",source_instance AS "sourceInstance",source_table AS "sourceTable",identity_hash AS "identityHash",revision::text AS revision FROM integration.import_history_records ORDER BY id')).rows.map(row => [row.scopeId + ':' + row.identityHash, sourceRow(row)]));
  const masterWriters = require('../../repositories/import-master-data').createImportMasterWriters({ protection }), historyWriters = require('../../repositories/import-history').createImportHistoryWriters({ protection, authorize: () => true, resolveMasterSourceInstance: () => 'tradefoto-trade' }), results = [], completedSources = new Map(); let preservedAnchors = 0;
  try {
    for (const source of plan.sources) {
      checkBudget();
      if (source.strategy === 'skip-retired-obsolete') {
        const original = (await core.query('SELECT id,scope_id AS "scopeId",owner_id AS "ownerId",revision::text AS revision,created_at AS "createdAt",updated_at AS "updatedAt",payload FROM gp.data_import_sources WHERE id=$1', [source.sourceId])).rows[0];
        if (!original || metadataHash(original) !== source.sourceMetadataSha256) fail('PG_SOURCE_REPLAY_SOURCE_CHANGED');
        const row = sourceRow(original), data = protection.open(row.payload, sourceContext(row));
        if (data.status !== 'purged' || !C.equal(data.retirement, source.retirement)) fail('PG_SOURCE_REPLAY_SOURCE_CHANGED');
        results.push({ sourceId: source.sourceId, kind: source.kind, strategy: source.strategy, replayed: false, retirementPreserved: true }); continue;
      }
      if (source.kind === 'cash') {
        const original = (await core.query('SELECT id,scope_id AS "scopeId",owner_id AS "ownerId",revision::text AS revision,created_at AS "createdAt",updated_at AS "updatedAt",payload FROM gp.data_import_sources WHERE id=$1', [source.sourceId])).rows[0];
        if (!original || metadataHash(original) !== source.sourceMetadataSha256) fail('PG_SOURCE_REPLAY_SOURCE_CHANGED');
        const row = sourceRow(original), data = protection.open(row.payload, sourceContext(row));
        const tolerances = sourceTolerances(data, source, { row, protection });
        const genericCashRuns = source.genericCash ? await replayCashHistory({ source, archive, access, protection, plan, onProgress, checkBudget, tolerances }) : [];
        results.push({ sourceId: source.sourceId, kind: source.kind, strategy: source.strategy, replayed: !!genericCashRuns.length, genericCashRuns }); continue;
      }
      if (source.strategy !== 'normal-import') { results.push({ sourceId: source.sourceId, kind: source.kind, strategy: source.strategy, replayed: false }); continue; }
      const excluded = new Map(), policy = Object.freeze({ namespace: FORMAT, isolatedRecovery: true, catalogTag: plan.planSha256.slice(0, 24),
        reason(runId, identityHash) { return excluded.get(runId + ':' + identityHash) || null; } }); POLICIES.add(policy);
      const original = (await core.query('SELECT id,scope_id AS "scopeId",owner_id AS "ownerId",revision::text AS revision,created_at AS "createdAt",updated_at AS "updatedAt",payload FROM gp.data_import_sources WHERE id=$1', [source.sourceId])).rows[0];
      if (!original) fail('PG_SOURCE_REPLAY_SOURCE_REQUIRED'); const row = sourceRow(original), data = protection.open(row.payload, sourceContext(row));
      if (row.scopeId !== source.scopeId || row.ownerId !== source.ownerId || row.createdAt !== source.createdAt || data.kind !== source.kind || data.fileSha256 !== source.fileSha256 || data.bytes !== source.bytes) fail('PG_SOURCE_REPLAY_SOURCE_CHANGED');
      // A failed isolated replay restarts from the authenticated bundle, never
      // from a partly rebuilt database whose new rows could resemble GP anchors.
      if (metadataHash(row) !== source.sourceMetadataSha256) fail('PG_SOURCE_REPLAY_RESTART_FROM_BUNDLE');
      const tolerances = sourceTolerances(data, source, { row, protection }), originalCountProof = data.independentCountProof || data.recoveryReplay?.originalIndependentCountProof;
      {
        data.complete = false; data.status = 'interrupted'; data.error = ''; delete data.catalog; delete data.retirement; delete data.readyPlanValidation; delete data.recheckedRun; delete data.progress; delete data.independentCountProof;
        data.contentDate = require('../../../data-import-content-date').empty();
        data.tables = source.tables.map(table => ({ name: table.name, profileHash: table.profileHash, declaredRows: table.declaredRows, run: null, ...(table.deferred ? { deferred: table.deferred } : {}) }));
        data.recoveryReplay = { namespace: FORMAT, planSha256: plan.planSha256, originalMetadataSha256: source.sourceMetadataSha256, originalAppliedAt: source.appliedAt, recreatedDerivedAudit: true };
        if (originalCountProof) data.recoveryReplay.originalIndependentCountProof = originalCountProof;
        const next = { ...row, revision: row.revision + 1, updatedAt: new Date().toISOString() };
        const changed = await core.query('UPDATE gp.data_import_sources SET revision=$2,updated_at=$3,payload=$4 WHERE id=$1 AND revision=$5', [row.id, next.revision, next.updatedAt, protection.seal(data, sourceContext(next)), row.revision]);
        if (changed.rowCount !== 1) fail('PG_SOURCE_REPLAY_CONCURRENT_CHANGE');
      }
      const getSession = async () => session(source.ownerId), defs = profileDefinitions(source.kind, source.tables); let current = null, runtime;
      async function prepareRows(event) {
        const table = source.tables.find(t => t.name === event.name), def = defs.find(d => d.name === event.name); if (!table || !current || current.name !== event.name) fail('PG_SOURCE_REPLAY_PROTOCOL');
        const header = (await core.query('SELECT id,scope_id AS "scopeId",owner_id AS "ownerId",revision::text AS revision,created_at AS "createdAt",updated_at AS "updatedAt",payload FROM gp.data_import_sources WHERE id=$1', [source.sourceId])).rows[0];
        const running = sourceRow(header), state = protection.open(running.payload, sourceContext(running)), runId = state.tables.find(t => t.name === event.name)?.run?.id;
        if (!runId) fail('PG_SOURCE_REPLAY_RUN_REQUIRED');
        for (let i = 0; i < event.rows.length; i++) {
          const ordinal = event.startRow + i; let record; try { record = C.normalizeDataImportRow(def.profile, event.rows[i]); } catch (error) { if (error instanceof C.DataImportError) continue; throw error; }
          const identityHash = protection.digest(['identity', source.scopeId, def.profile.sourceSystem, 'tradefoto-' + source.kind, def.name, def.profile.entity, def.profile.keyFields, record.key]);
          if (table.exceptionRanges.some(range => ordinal >= range.first && ordinal <= range.last)) { excluded.set(runId + ':' + identityHash, 'RECOVERY_ORIGINAL_SOURCE_EXCEPTION'); continue; }
          const naturalIdentity = def.master ? M.masterIdentity(protection, { scopeId: source.scopeId, sourceInstance: 'tradefoto-' + source.kind }, def.name, record.key)
            : H.historyIdentity(protection, { scopeId: source.scopeId, sourceInstance: 'tradefoto-' + source.kind }, def.source, def.name, record.key);
          const anchor = (def.master ? preserved : preservedHistory).get(source.scopeId + ':' + naturalIdentity);
          if (!anchor) continue; preservedAnchors++;
          await access.transaction(async tx => {
            const writer = (def.master ? masterWriters : historyWriters)[def.profile.entity], context = { scopeId: source.scopeId, ownerId: source.ownerId, sourceInstance: 'tradefoto-' + source.kind,
              sourceSystem: def.profile.sourceSystem, sourceTable: def.name, profileHash: def.profile.fingerprint, at: new Date().toISOString(), fileSha256: source.fileSha256,
              snapshotAt: source.createdAt, runId, expectedRows: table.expectedRows };
            const target = await writer.read(tx, anchor.id, context);
            if (!target || target.revision !== anchor.revision) fail('PG_SOURCE_REPLAY_ANCHOR_CHANGED');
            if (!C.equal(target.data, record.data)) { excluded.set(runId + ':' + identityHash, 'RECOVERY_PRESERVED_GP_ANCHOR'); return; }
            if (!def.master) { const review = await writer.review(tx, record, context); if (review.issue || review.rewrite) { excluded.set(runId + ':' + identityHash, 'RECOVERY_PRESERVED_GP_ANCHOR'); return; } }
            const existing = await tx.queryOne(IMPORT.getLink, { id: identityHash });
            if (existing) { if (existing.targetId !== anchor.id) fail('PG_SOURCE_REPLAY_ANCHOR_CHANGED'); return; }
            await tx.execute(IMPORT.insertLink, { id: identityHash, scopeId: source.scopeId, entity: def.profile.entity, targetId: anchor.id, revision: 1, lastRunId: runId,
              payload: protection.seal({ record, contentHash: protection.digest({ record }), targetRevision: target.revision }, ['link', identityHash]) });
          }, { isolation: 'serializable' });
        }
      }
      try {
        runtime = require('../../repositories/data-import-runtime').createDataImportRuntime({ access, vault, scopeId: source.scopeId, allowApply: true, sharedPayloads: true, compactCash: true, syncArticleCatalog: true, recoveryReplay: policy, sourceTolerances: tolerances,
          readSource: options => S.readTradeFotoFullSource({ ...options, send: async event => {
            checkBudget(); if (event.type === 'rows') await prepareRows(event);
            const ack = await options.onMessage(event); if (event.type === 'table') current = { name: event.name }; if (event.type === 'table-complete') current = null; return ack;
          } }) });
        let summary = await runtime.sourceOperation(getSession, source.sourceId, 'read');
        if (!summary.complete) await archive.useFile(source.sourceId, async ({ buffer, password, source: originalSource }) => {
          if (buffer.length !== source.bytes || sha(buffer) !== source.fileSha256 || originalSource?.sourceId !== source.sourceId) fail('PG_SOURCE_REPLAY_SOURCE_CHANGED');
          summary = await runtime.upload(getSession, { buffer, password, kind: source.kind, fileName: originalSource.fileName });
        });
        let steps = 0;
        while (summary.status === 'reviewing') { checkBudget(); if (++steps > 10_000_000) fail('PG_SOURCE_REPLAY_STEP_LIMIT'); onProgress({ phase: 'review', kind: source.kind, sourceId: source.sourceId }); summary = await runtime.sourceOperation(getSession, source.sourceId, 'review', { expectedRevision: summary.revision }); }
        if (summary.tables.some(t => t.run?.gates?.length)) {
          if (summary.tables.some(t => t.run?.gates?.length && !source.tables.find(original => original.name === t.name)?.countApproved)) fail('PG_SOURCE_REPLAY_ORIGINAL_GATE');
          summary = await runtime.sourceOperation(getSession, source.sourceId, 'approve-counts', { expectedRevision: summary.revision });
        }
        while (summary.status !== 'applied' || summary.catalogUpdatePending) {
          checkBudget(); if (++steps > 10_000_000 || !['ready', 'needs_review', 'applying', 'applied'].includes(summary.status)) fail('PG_SOURCE_REPLAY_STATE');
          onProgress({ phase: 'apply', kind: source.kind, sourceId: source.sourceId, step: steps, table: summary.currentStep?.table || null });
          summary = await runtime.sourceOperation(getSession, source.sourceId, 'apply', { expectedRevision: summary.revision });
        }
        summary = await runtime.sourceOperation(getSession, source.sourceId, 'read');
        if (summary.status !== 'applied' || summary.catalogUpdatePending) fail('PG_SOURCE_REPLAY_INCOMPLETE');
        completedSources.set(source.sourceId, summary);
        results.push({ sourceId: source.sourceId, kind: source.kind, strategy: source.strategy, replayed: true, status: summary.status, revision: summary.revision,
          exceptionIdentities: [...excluded.values()].filter(reason => reason === 'RECOVERY_ORIGINAL_SOURCE_EXCEPTION').length,
          preservedAnchorIdentities: [...excluded.values()].filter(reason => reason === 'RECOVERY_PRESERVED_GP_ANCHOR').length,
          catalog: summary.catalog ? { complete: summary.catalog.complete, changed: summary.catalog.changed, blocked: summary.catalog.blocked } : null });
      } finally { await runtime?.stop(); }
    }
    const stockPublications = [];
    for (const expected of plan.stockPublications) {
      const source = plan.sources.find(source => source.scopeId === expected.scopeId && source.ownerId === expected.ownerId && source.fileSha256 === expected.fileSha256
        && source.tables.some(table => table.runId === expected.originalRunId));
      const table = completedSources.get(source?.sourceId)?.tables.find(table => table.name === 'ARTIKEL_FILIALEN');
      if (!table || table.deferred || table.run?.status !== 'applied') fail('PG_SOURCE_REPLAY_STOCK_PUBLICATION_REQUIRED');
      const actual = await access.transaction(tx => require('../../repositories/import-history-snapshots').createHistorySnapshots({ protection }).publication(tx, table.run.id), { isolation: 'serializable', readOnly: true });
      for (const field of ['scopeId', 'sourceInstance', 'profileHash', 'fileSha256', 'snapshotAt', 'ownerId', 'expectedRows']) if (actual[field] !== expected[field]) fail('PG_SOURCE_REPLAY_STOCK_PUBLICATION_CHANGED');
      stockPublications.push({ scopeId: actual.scopeId, sourceInstance: actual.sourceInstance, profileHash: actual.profileHash, fileSha256: actual.fileSha256,
        snapshotAt: actual.snapshotAt, ownerId: actual.ownerId, expectedRows: actual.expectedRows, runId: actual.runId, verified: true });
    }
    return { verified: true, rehydrated: true, format: FORMAT, sourceCount: results.length, sources: results, stockPublications, cashPending: results.some(s => s.strategy === 'cash-snapshot-plan'),
      preservedAnchors, recreatedDerivedAudit: true, originalSourceRegistryPreserved: false, planSha256: plan.planSha256 };
  } finally { protection.destroy(); }
}
module.exports = { FORMAT, createReplayPlan, validateReplayPlan, replaySources, assertReplayRuntimePolicy, assertReplayIsolation: assertIsolation };

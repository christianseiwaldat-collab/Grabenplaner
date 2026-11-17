'use strict';
// Explicit recovery from a NEW six-file Access generation. This deliberately
// does not attest byte-identical old Sales history or old cash publications.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const C = require('../../../data-import-contract'), S = require('../../../tradefoto-full-import-source');
const M = require('../../../tradefoto-master-profiles'), H = require('../../../tradefoto-history-profiles');
const { SOURCE_CATALOG, SOURCE_KINDS } = require('../../../data-import-source-catalog');
const IMPORT = require('../../statements/data-import').DATA_IMPORT_STATEMENTS;
const FORMAT = 'grabenplaner-access-fresh-rebuild-v1', BASIS = 'fresh-source-rebuild', EMPTY = '0'.repeat(64), POLICIES = new WeakSet();
const ANCHOR_BATCH = 100;
const CASH_TABLES = Object.freeze([
  ['cash_snapshot_datasets', 'slot'], ['cash_snapshot_inventory', 'dataset_slot,table_index'],
  ['cash_publications', 'id'], ['cash_publication_bindings', 'publication_id,kind,source_key'],
  ['cash_publication_state', 'scope_id'], ['cash_binding_inventory', 'publication_id'],
]);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex'), hash = value => sha(C.canonical(value));
const exact = (value, fields) => { if (!C.plain(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail('PG_FRESH_SOURCE_PLAN'); };
const integer = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) fail('PG_FRESH_SOURCE_INTEGER'); return n; };
const sourceContext = row => ['source', row.scopeId, row.ownerId, row.id, integer(row.revision)];
const datasetContext = row => ['cash-compact-v1', 'dataset', integer(row.slot), row.id, row.scopeId, row.ownerId, integer(row.revision), row.createdAt];
const stateContext = row => ['cash-publication-state-v1', row.scopeId, integer(row.revision)];
const definitions = () => SOURCE_KINDS.map(kind => ({ kind, fileName: SOURCE_CATALOG.find(s => s.kind === kind).fileName,
  tables: S.definitions(kind).map(def => ({ name: def.name, profileHash: def.profile.fingerprint })) }));
function sourceHeaderFacts(rows) {
  if (rows.length > 10000) fail('PG_FRESH_SOURCE_METADATA_LIMIT');
  const digest = crypto.createHash('sha256');
  for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) digest.update(C.canonical({ ...row, revision: integer(row.revision) })).update('\n');
  return { rows: rows.length, sha256: digest.digest('hex') };
}
async function metadata(client, checkBudget) {
  const result = [];
  for (const [table, order] of CASH_TABLES) {
    checkBudget(); const digest = crypto.createHash('sha256');
    const rows = (await client.query(`SELECT row_to_json(x)::text AS value FROM kassa.${table} x ORDER BY ${order}`)).rows;
    if (rows.length > 500000) fail('PG_FRESH_SOURCE_METADATA_LIMIT');
    for (const row of rows) { checkBudget(); if (typeof row.value !== 'string') fail('PG_FRESH_SOURCE_METADATA'); digest.update(row.value).update('\n'); }
    result.push({ table, rows: rows.length, sha256: digest.digest('hex') });
  }
  return result;
}
function validateFreshPlan(plan) {
  exact(plan, ['format', 'basis', 'kinds', 'actors', ...(Object.hasOwn(plan || {}, 'sourceHeaders') ? ['sourceHeaders'] : []), 'cashMetadata', 'cashScopes', 'planSha256']);
  if (plan.format !== FORMAT || plan.basis !== BASIS || !C.equal(plan.kinds, definitions()) || !Array.isArray(plan.actors) || plan.actors.length > 100
    || !Array.isArray(plan.cashScopes) || plan.cashScopes.length > 100 || !Array.isArray(plan.cashMetadata) || plan.cashMetadata.length !== CASH_TABLES.length) fail('PG_FRESH_SOURCE_PLAN');
  const actors = new Set(), scopes = new Set();
  if (Object.hasOwn(plan, 'sourceHeaders')) { exact(plan.sourceHeaders, ['rows', 'sha256']); C.integer(plan.sourceHeaders.rows, 0, 10000); C.sha(plan.sourceHeaders.sha256); }
  for (const actor of plan.actors) { exact(actor, ['scopeId', 'ownerId']); C.id(actor.scopeId); C.id(actor.ownerId); if (actors.has(actor.scopeId)) fail('PG_FRESH_SOURCE_PLAN'); actors.add(actor.scopeId); }
  for (const scope of plan.cashScopes) {
    exact(scope, ['scopeId', 'active', 'previous']); C.id(scope.scopeId); if (scope.active !== null) C.sha(scope.active); if (scope.previous !== null) C.sha(scope.previous);
    if (scopes.has(scope.scopeId) || !actors.has(scope.scopeId)) fail('PG_FRESH_SOURCE_PLAN'); scopes.add(scope.scopeId);
  }
  plan.cashMetadata.forEach((table, i) => { exact(table, ['table', 'rows', 'sha256']); if (table.table !== CASH_TABLES[i][0]) fail('PG_FRESH_SOURCE_PLAN'); C.integer(table.rows, 0, 500000); C.sha(table.sha256); });
  C.sha(plan.planSha256); const { planSha256, ...body } = plan;
  if (hash(body) !== planSha256 || Buffer.byteLength(C.canonical(plan)) > 1024 * 1024) fail('PG_FRESH_SOURCE_PLAN'); return plan;
}
async function createFreshPlan({ core, sales, protection, checkBudget = () => {} }) {
  if (!core?.query || !sales?.query || !protection || typeof checkBudget !== 'function') fail('PG_FRESH_SOURCE_CONFIGURATION');
  const actors = new Map(), sourceRows = (await core.query('SELECT id,scope_id AS "scopeId",owner_id AS "ownerId",revision::text AS revision,created_at AS "createdAt",updated_at AS "updatedAt",payload FROM gp.data_import_sources ORDER BY created_at DESC,id DESC')).rows;
  for (const row of sourceRows) {
    checkBudget(); const data = protection.open(row.payload, sourceContext(row));
    if (!SOURCE_KINDS.includes(data.kind)) continue;
    if (row.id !== protection.digest(['source', { scopeId: row.scopeId, ownerId: row.ownerId }, data.kind, data.fileSha256])) fail('PG_FRESH_SOURCE_METADATA');
    if (!actors.has(row.scopeId)) actors.set(row.scopeId, { scopeId: row.scopeId, ownerId: row.ownerId });
  }
  const cashScopes = [];
  for (const row of (await sales.query('SELECT scope_id AS "scopeId",revision::text AS revision,payload FROM kassa.cash_publication_state ORDER BY scope_id')).rows) {
    const data = protection.open(row.payload, stateContext(row)); C.exact(data, ['active', 'previous', 'events']);
    cashScopes.push({ scopeId: row.scopeId, active: data.active, previous: data.previous });
  }
  const body = { format: FORMAT, basis: BASIS, kinds: definitions(), actors: [...actors.values()].sort((a, b) => a.scopeId.localeCompare(b.scopeId)),
    sourceHeaders: sourceHeaderFacts(sourceRows), cashMetadata: await metadata(sales, checkBudget), cashScopes };
  return validateFreshPlan({ ...body, planSha256: hash(body) });
}
async function isolation(core, sales, isolatedRecovery) {
  return require('./access-source-replay').assertReplayIsolation(core, sales, isolatedRecovery);
}
function assertFreshRuntimePolicy(policy) { if (!POLICIES.has(policy) || policy.namespace !== FORMAT || policy.isolatedRecovery !== true) C.fail('IMPORT_COMPOSITION_INVALID'); return policy; }
async function datasets(sales) {
  return (await sales.query('SELECT slot::text AS slot,id,scope_id AS "scopeId",owner_id AS "ownerId",revision::text AS revision,created_at AS "createdAt",payload FROM kassa.cash_snapshot_datasets ORDER BY slot')).rows;
}
async function prepareFreshRestore({ core, sales, protection, plan, isolatedRecovery = false, checkBudget = () => {} }) {
  validateFreshPlan(plan); await isolation(core, sales, isolatedRecovery);
  const rows = await datasets(sales), states = (await sales.query('SELECT scope_id AS "scopeId",revision::text AS revision,payload FROM kassa.cash_publication_state ORDER BY scope_id')).rows;
  const sourceRows = (await core.query('SELECT id,scope_id AS "scopeId",owner_id AS "ownerId",revision::text AS revision,created_at AS "createdAt",updated_at AS "updatedAt",payload FROM gp.data_import_sources ORDER BY id')).rows;
  const recognized = sourceRows.map(row => ({ row, data: protection.open(row.payload, sourceContext(row)) })).filter(value => SOURCE_KINDS.includes(value.data.kind));
  const prepared = rows.every(row => protection.open(row.payload, datasetContext(row)).freshSourceRecovery?.planSha256 === plan.planSha256)
    && states.every(row => { const d = protection.open(row.payload, stateContext(row)); return d.active === null && d.previous === null && d.events.at(-1)?.freshSourcePlanSha256 === plan.planSha256; })
    && recognized.every(({ data }) => !data.complete && data.status === 'interrupted' && !Object.hasOwn(data, 'independentCountProof') && data.freshSourceRecovery?.planSha256 === plan.planSha256);
  if (prepared && (rows.length || states.length || recognized.length)) return { verified: true, prepared: true, requiresFreshAccess: true, datasets: rows.length, sourceHeaders: recognized.length };
  // Early local v1 points had no separate header digest. Their complete Core
  // checkpoint still precedes this transition; do not invent a historical hash.
  if (plan.sourceHeaders && !C.equal(sourceHeaderFacts(sourceRows), plan.sourceHeaders)) fail('PG_FRESH_SOURCE_RESTART_FROM_BUNDLE');
  if (!C.equal(await metadata(sales, checkBudget), plan.cashMetadata)) fail('PG_FRESH_SOURCE_RESTART_FROM_BUNDLE');
  for (let i = 0; i < S.definitions('cash').length; i++) {
    if ((await sales.query(`SELECT EXISTS(SELECT 1 FROM kassa.cash_snapshot_${i} LIMIT 1) AS present`)).rows[0]?.present !== false) fail('PG_FRESH_SOURCE_RAW_NOT_EMPTY');
  }
  for (const row of rows) {
    checkBudget(); const data = protection.open(row.payload, datasetContext(row));
    data.complete = false; data.status = 'reading'; data.freshSourceRecovery = { format: FORMAT, planSha256: plan.planSha256, requiresFreshAccess: true };
    data.tables = data.tables.map(table => ({ name: table.name, profileHash: table.profileHash, declaredRows: table.declaredRows, expectedRows: null,
      receivedRows: 0, verifiedRows: 0, sourceHash: EMPTY, verifiedHash: EMPTY, complete: false, verified: false, manifest: null }));
    const next = { ...row, revision: integer(row.revision) + 1 };
    if ((await sales.query('UPDATE kassa.cash_snapshot_datasets SET revision=$2,payload=$3 WHERE slot=$1 AND revision=$4', [row.slot, next.revision, protection.seal(data, datasetContext(next)), row.revision])).rowCount !== 1) fail('PG_FRESH_SOURCE_CONCURRENT');
  }
  await sales.query('UPDATE kassa.cash_snapshot_inventory SET row_count=0,generation=0');
  for (const row of states) {
    checkBudget(); const data = protection.open(row.payload, stateContext(row));
    data.events.push({ action: 'fresh-source-recovery-required', from: data.active, to: null, at: new Date().toISOString(), freshSourcePlanSha256: plan.planSha256 }); data.active = null; data.previous = null;
    const next = { ...row, revision: integer(row.revision) + 1 };
    if ((await sales.query('UPDATE kassa.cash_publication_state SET revision=$2,payload=$3 WHERE scope_id=$1 AND revision=$4', [row.scopeId, next.revision, protection.seal(data, stateContext(next)), row.revision])).rowCount !== 1) fail('PG_FRESH_SOURCE_CONCURRENT');
  }
  for (const { row, data } of recognized) {
    checkBudget();
    if (row.id !== protection.digest(['source', { scopeId: row.scopeId, ownerId: row.ownerId }, data.kind, data.fileSha256])) fail('PG_FRESH_SOURCE_METADATA');
    const previous = { status: data.status, complete: data.complete, revision: integer(row.revision) };
    const proof = data.independentCountProof || data.freshSourceRecovery?.previousIndependentCountProof;
    data.complete = false; data.status = 'interrupted'; data.error = 'IMPORT_SOURCE_REUPLOAD_REQUIRED';
    data.freshSourceRecovery = { ...data.freshSourceRecovery, format: FORMAT, planSha256: plan.planSha256, requiresFreshAccess: true, previous };
    if (proof) data.freshSourceRecovery.previousIndependentCountProof = proof;
    delete data.independentCountProof;
    const next = { ...row, revision: integer(row.revision) + 1 };
    if ((await core.query('UPDATE gp.data_import_sources SET revision=$2,payload=$3 WHERE id=$1 AND revision=$4', [row.id, next.revision, protection.seal(data, sourceContext(next)), row.revision])).rowCount !== 1) fail('PG_FRESH_SOURCE_CONCURRENT');
  }
  return { verified: true, prepared: true, requiresFreshAccess: true, datasets: rows.length, sourceHeaders: recognized.length, oldPublicationsActive: false };
}
function directory(name) {
  if (typeof name !== 'string' || !path.isAbsolute(name) || path.resolve(name) !== name || fs.realpathSync(name) !== name) fail('PG_FRESH_SOURCE_DIRECTORY');
  const stat = fs.lstatSync(name); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail('PG_FRESH_SOURCE_DIRECTORY');
}
function readSource(directoryName, kind) {
  const fileName = SOURCE_CATALOG.find(source => source.kind === kind).fileName, file = path.join(directoryName, fileName), before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid() || before.mode & 0o077 || before.size < 4096 || before.size > 512 * 1024 * 1024 || fs.realpathSync(file) !== file) fail('PG_FRESH_SOURCE_FILE');
  const buffer = fs.readFileSync(file), after = fs.lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || buffer.length !== before.size) { buffer.fill(0); fail('PG_FRESH_SOURCE_CHANGED'); }
  try { S.assertSourceBytes(buffer); return { buffer, fileName, fileSha256: sha(buffer), bytes: buffer.length }; }
  catch (error) { buffer.fill(0); throw error; }
}
function recoverySession(ownerId) { return { employeeNumber: ownerId, isEmployee: true, role: 'developer', permissions: [
  ...Object.values(require('../../../data-import-access').DATA_IMPORT_PERMISSIONS), ...Object.values(require('../../../sales-article-catalog-access').SALES_ARTICLE_CATALOG_PERMISSIONS),
  'sales:analytics:access', 'sales:analytics:company:read',
] }; }
async function priorCashChoices({ sales, protection, scope }) {
  if (!scope?.active) return null;
  const row = (await sales.query('SELECT id,scope_id AS "scopeId",dataset_id AS "datasetId",owner_id AS "ownerId",created_at AS "createdAt",payload FROM kassa.cash_publications WHERE id=$1 AND scope_id=$2', [scope.active, scope.scopeId])).rows[0];
  if (!row) fail('PG_FRESH_SOURCE_CASH_CHOICES');
  const data = protection.open(row.payload, ['cash-publication-v1', row.id, row.scopeId, row.datasetId, row.ownerId, row.createdAt]);
  const counts = Object.fromEntries((await sales.query('SELECT kind,count(*)::text AS count FROM kassa.cash_publication_bindings WHERE publication_id=$1 GROUP BY kind ORDER BY kind', [row.id])).rows.map(row => [row.kind, integer(row.count)]));
  if (Object.keys(counts).some(kind => !['FILIALEN', 'MITARBEITER', 'KUNDEN', 'ARTIKEL_STAMM'].includes(kind))
    || Object.values(counts).reduce((a, b) => a + b, 0) !== data.bindingCount || ['FILIALEN', 'MITARBEITER', 'KUNDEN', 'ARTIKEL_STAMM'].some(kind => (counts[kind] || 0) !== data.bindingCounts[kind])) fail('PG_FRESH_SOURCE_CASH_CHOICES');
  // Article targets are determined by the retained catalog source links even
  // for an explicit request (ordinary plan rejects any other target). Rebuild
  // these derived bindings through resolveArticles instead of copying them.
  const choices = [], bindings = (await sales.query('SELECT publication_id AS "publicationId",kind,encode(source_key,\'hex\') AS "sourceKey",target_id AS "targetId",(historical=1) AS historical,payload FROM kassa.cash_publication_bindings WHERE publication_id=$1 AND (kind<>\'ARTIKEL_STAMM\' OR historical=1) ORDER BY kind,source_key', [row.id])).rows;
  if (bindings.length > 500000 || bindings.filter(binding => binding.kind !== 'ARTIKEL_STAMM').length !== data.bindingCount - (counts.ARTIKEL_STAMM || 0)) fail('PG_FRESH_SOURCE_CASH_CHOICES');
  for (const binding of bindings) {
    const value = protection.open(binding.payload, ['cash-publication-binding-v1', binding.publicationId, binding.kind, binding.sourceKey, binding.targetId, binding.historical]);
    if (!C.equal([value.kind, value.sourceKey, value.targetId, value.historical], [binding.kind, binding.sourceKey, binding.targetId, binding.historical])) fail('PG_FRESH_SOURCE_CASH_CHOICES');
    const field = require('../../repositories/cash-publications').CASH_REFERENCE_FIELDS[binding.kind];
    if (!field || binding.sourceKey !== protection.digest(['cash-compact-v1', 'source-reference', scope.scopeId, field, String(value.sourceId)])) fail('PG_FRESH_SOURCE_CASH_CHOICES');
    // An explicitly historical choice for an active article is GP-owned.
    // Ordinary automatic resolution uses historical=!target.active. Keep any
    // nonautomatic or legacy-unknown choice, regenerate only the exact default.
    if (value.kind === 'ARTIKEL_STAMM' && typeof value.targetActive === 'boolean' && value.historical === !value.targetActive) continue;
    choices.push({ kind: value.kind, sourceId: value.sourceId, targetId: value.targetId, historical: value.historical, ...(value.sourceOnly ? { sourceOnly: true } : {}) });
  }
  if (choices.length > 10000) fail('PG_FRESH_SOURCE_CASH_CHOICES');
  return { policyFingerprint: data.policyFingerprint, policy: data.policy, choices, resolveArticles: (counts.ARTIKEL_STAMM || 0) > 0 };
}
async function rebuildCash({ access, sales, protection, actor, source, plan, clock }) {
  const previous = await priorCashChoices({ sales, protection, scope: plan.cashScopes.find(scope => scope.scopeId === actor.scopeId) });
  // A previously unactivated candidate remains unactivated. Recovery does not
  // invent a business activation that its GP owner never made.
  if (!previous) return { verified: true, ready: true, activated: false, ownMappingChoicesRetained: true };
  const policies = require('../../../cash-source-policies').CASH_SOURCE_POLICIES;
  const policy = policies.find(p => p.policy && require('../../../tradefoto-sales-rules').defineTradeFotoSalesPolicy({ ...p.policy, scopeId: actor.scopeId, sourceInstance: 'tradefoto-cash' }).fingerprint === previous.policyFingerprint
    && (p.appliesTo === 'matching_cash_schema' || p.fileSha256 === source.fileSha256));
  if (!policy) fail('PG_FRESH_SOURCE_CASH_POLICY_REVIEW');
  const publications = require('../../repositories/cash-publications').createCashPublications({ access, protection, scopeId: actor.scopeId, policies, clock });
  const projection = { tables: ['FILIALEN', 'MITARBEITER', 'ARTIKEL_STAMM', 'KUNDEN'].map(table => ({ table, write: true })) };
  const retained = [], unresolved = [];
  const state = await access.transaction(async tx => {
    const state = await publications.state(tx), { dataset, reader } = await publications.candidate(tx, source.id, actor.ownerId), references = new Map();
    for (const kind of new Set(previous.choices.map(choice => choice.kind))) {
      const ids = new Set(); let after = '';
      do { const page = await publications.references(tx, dataset, reader, kind, after, 1000); for (const value of page.items) ids.add(value.sourceId); after = page.next || ''; } while (after);
      references.set(kind, ids);
    }
    for (const choice of previous.choices) {
      if (references.get(choice.kind)?.has(choice.sourceId)) retained.push(choice);
      else unresolved.push({ kind: choice.kind, reason: 'source-absent-from-new-generation' });
    }
    return state;
  }, { isolation: 'serializable', readOnly: true });
  if (unresolved.length) fail('PG_FRESH_SOURCE_CASH_MAPPING_REVIEW');
  const request = { sourceId: source.id, expectedRevision: state.row.revision, mappings: retained, resolveArticles: previous.resolveArticles,
    label: 'Kasse · neue Wiederherstellungsquelle ' + clock().slice(0, 10), policyId: policy.id };
  const publication = await access.transaction(async tx => {
    const preview = await publications.plan(tx, actor, request, projection, FORMAT);
    return publications.activate(tx, actor, request, projection, FORMAT, preview.planHash);
  }, { isolation: 'serializable' });
  return { verified: true, ready: true, activated: true, publicationId: publication.active, ownMappingChoicesRetained: true, mappings: retained.length, newGeneration: true };
}
async function verifyFreshOutcome({ sales, source, excluded, checkBudget = () => {} }) {
  const result = { applied: 0, unchanged: 0, duplicate: 0, preservedGpQuarantined: 0 };
  for (const table of source.tables) {
    checkBudget(); const counts = table.run.counts || {};
    result.applied += integer(counts.applied || 0); result.unchanged += integer(counts.unchanged || 0); result.duplicate += integer(counts.duplicate || 0);
    const conflicts = (await sales.query("SELECT identity_hash AS \"identityHash\",state,issue FROM integration.data_import_rows WHERE run_id=$1 AND state NOT IN ('applied','unchanged','duplicate') ORDER BY row_number", [table.run.id])).rows;
    if (integer(counts.invalid || 0) || conflicts.some(row => row.state !== 'conflict' || row.issue !== 'RECOVERY_PRESERVED_GP_ANCHOR' || !excluded.has(table.run.id + ':' + row.identityHash))
      || conflicts.length !== integer(counts.conflict || 0)) fail('PG_FRESH_SOURCE_QUALITY_REVIEW');
    result.preservedGpQuarantined += conflicts.length;
    if (integer(table.run.receivedRows) !== integer(counts.applied || 0) + integer(counts.unchanged || 0) + integer(counts.duplicate || 0) + conflicts.length) fail('PG_FRESH_SOURCE_APPLY_INCOMPLETE');
  }
  return result;
}
async function captureOriginalWork({ sales, ownedPlan, checkBudget = () => {} }) {
  require('./access-owned-state').validateOwnedPlan(ownedPlan);
  const counts = ['data_import_rows', 'data_import_changes'].map(table => {
    const entry = ownedPlan.tables.find(value => value.schema === 'integration' && value.table === table);
    if (!entry) fail('PG_FRESH_SOURCE_ORIGINAL_WORK'); return integer(entry.rows);
  });
  checkBudget();
  if (counts.every(count => count === 0)) {
    const present = (await sales.query(`SELECT EXISTS(SELECT 1 FROM integration.data_import_rows)
      OR EXISTS(SELECT 1 FROM integration.data_import_changes) AS present`)).rows[0]?.present;
    if (present !== false) fail('PG_FRESH_SOURCE_ORIGINAL_WORK');
    return new Set();
  }
  // Freeze only identities from the restored GP work, before the first new
  // runtime can create staging. Incoming source rows never enter this set.
  const rows = (await sales.query(`SELECT identity_hash AS "identityHash" FROM integration.data_import_rows WHERE identity_hash IS NOT NULL
    UNION SELECT identity_hash AS "identityHash" FROM integration.data_import_changes WHERE identity_hash IS NOT NULL`)).rows;
  if (rows.length > counts[0] + counts[1]) fail('PG_FRESH_SOURCE_ORIGINAL_WORK');
  const identities = new Set();
  for (const row of rows) {
    checkBudget();
    // Keyless invalid/staged GP rows and legacy non-SHA source identities stay
    // in the restored tables, but cannot match a new normalized SHA identity.
    if (typeof row.identityHash === 'string' && /^[a-f0-9]{64}$/.test(row.identityHash)) identities.add(row.identityHash);
  }
  return identities;
}
async function applyFreshAnchors({ access, protection, actor, kind, def, rows, masterAnchors, historyAnchors,
  masterWriters, historyWriters, originalWork, excluded, resolveContext, checkBudget = () => {} }) {
  let context; const batch = [];
  async function flush() {
    if (!batch.length) return;
    if (!context) context = await resolveContext();
    const preserved = await access.transaction(async tx => {
      const preserved = [];
      const writer = (def.master ? masterWriters : historyWriters)[def.profile.entity];
      for (const { record, identity, anchor } of batch) {
        checkBudget();
        const target = await writer.read(tx, anchor.id, context);
        if (!target || target.revision !== integer(anchor.revision)) fail('PG_FRESH_SOURCE_ANCHOR_CHANGED');
        const quarantine = () => preserved.push(context.runId + ':' + identity);
        const existing = await tx.queryOne(IMPORT.getLink, { id: identity });
        if (existing) {
          if (existing.scopeId !== actor.scopeId || existing.entity !== def.profile.entity || existing.targetId !== anchor.id) fail('PG_FRESH_SOURCE_ANCHOR_CHANGED');
          const baseline = protection.open(existing.payload, ['link', identity]);
          if (originalWork.has(identity) || baseline.targetRevision !== target.revision || baseline.contentHash !== protection.digest({ record: baseline.record })
            || !C.equal(baseline.record?.key, record.key) || !C.equal(baseline.record?.data, target.data)) { quarantine(); continue; }
          // Keep the authenticated OLD record and actual OLD target revision;
          // the ordinary engine, not this hook, performs any genuine update.
          continue;
        }
        if (originalWork.has(identity) || !C.equal(target.data, record.data)) { quarantine(); continue; }
        if (!def.master) { const review = await writer.review(tx, record, context); if (review.issue || review.rewrite) { quarantine(); continue; } }
        await tx.execute(IMPORT.insertLink, { id: identity, scopeId: actor.scopeId, entity: def.profile.entity, targetId: anchor.id, revision: 1, lastRunId: context.runId,
          payload: protection.seal({ record, contentHash: protection.digest({ record }), targetRevision: target.revision }, ['link', identity]) });
      }
      return preserved;
    }, { isolation: 'serializable' });
    for (const identity of preserved) excluded.set(identity, 'RECOVERY_PRESERVED_GP_ANCHOR');
    batch.length = 0;
  }
  for (const raw of rows) {
    checkBudget();
    let record; try { record = C.normalizeDataImportRow(def.profile, raw); } catch (error) { if (error instanceof C.DataImportError) continue; throw error; }
    const naturalContext = { scopeId: actor.scopeId, sourceInstance: 'tradefoto-' + kind };
    const natural = def.master ? M.masterIdentity(protection, naturalContext, def.name, record.key)
      : H.historyIdentity(protection, naturalContext, def.source, def.name, record.key);
    const anchor = (def.master ? masterAnchors : historyAnchors).get(actor.scopeId + ':' + natural); if (!anchor) continue;
    const identity = protection.digest(['identity', actor.scopeId, def.profile.sourceSystem, naturalContext.sourceInstance, def.name, def.profile.entity, def.profile.keyFields, record.key]);
    batch.push({ record, identity, anchor }); if (batch.length === ANCHOR_BATCH) await flush();
  }
  await flush();
}
async function prepareFinalHistoryStatistics({ core, sales, source, defs, prepared, protection, actor, kind, input, isolatedRecovery = false, checkBudget = () => {} }) {
  const table = source.tables.find(table => table.run.status !== 'applied' && table.deferred !== 'INCOMPLETE_STOCK_SNAPSHOT');
  const run = table?.run, def = defs.find(def => def.name === table?.name);
  if (!run || !def || table.profileHash !== def.profile.fingerprint || !H.usesSnapshotMembership(def.profile) || prepared.has(run.id)
    || !['ready', 'applying'].includes(run.status)) return false;
  const pending = ['create', 'update', 'refresh'].reduce((sum, state) => sum + C.integer(run.counts[state] || 0, 0, C.LIMITS.rows), 0);
  if (pending > C.LIMITS.batch || run.gates?.length
    || ['staged', 'invalid', 'conflict', 'reverted'].some(state => run.counts[state])) return false;
  C.sha(run.id);
  // Autovacuum is deliberately disabled in disposable restore clusters. Give
  // the final, complete AF coverage join current cardinalities after bulk load;
  // its normal trigger and application deadlines remain unchanged.
  await isolation(core, sales, isolatedRecovery);
  if (run.status === 'ready' && source.recheckedRun !== run.id) {
    // The normal ready cursor applies inside advanceReadyValidation before it
    // sets recheckedRun. Its completion marker is intentionally never public.
    if (!protection || !actor || !input || source.kind !== kind || source.fileSha256 !== input.fileSha256 || source.bytes !== input.bytes
      || source.id !== protection.digest(['source', actor, kind, input.fileSha256])) fail('PG_FRESH_SOURCE_STATISTICS_SOURCE');
    const rows = (await core.query('SELECT id,scope_id AS "scopeId",owner_id AS "ownerId",revision::text AS revision,payload FROM gp.data_import_sources WHERE id=$1 AND scope_id=$2 AND owner_id=$3', [source.id, actor.scopeId, actor.ownerId])).rows;
    const row = rows[0];
    if (rows.length !== 1 || row.id !== source.id || row.scopeId !== actor.scopeId || row.ownerId !== actor.ownerId || integer(row.revision) !== source.revision) fail('PG_FRESH_SOURCE_STATISTICS_SOURCE');
    const data = protection.open(row.payload, sourceContext(row));
    if (data.kind !== kind || data.fileSha256 !== input.fileSha256 || data.bytes !== input.bytes || data.complete !== true
      || !C.equal(data.tables.find(value => value.name === table.name), table)) fail('PG_FRESH_SOURCE_STATISTICS_SOURCE');
    const progress = data.readyPlanValidation;
    if (progress?.runId !== run.id || progress.complete !== true || progress.fusion || progress.fallback) return false;
  }
  const parameters = sales.connectionParameters, coreParameters = core.connectionParameters;
  if (parameters?.user !== 'gp_migration_admin' || coreParameters?.user !== 'gp_migration_admin'
    || !['grabenplaner_sales', 'gp_migration_sales'].includes(parameters.database)
    || coreParameters.database !== parameters.database.replace(/_sales$/, '_core')) fail('PG_FRESH_SOURCE_STATISTICS_CLIENT');
  let begun = false;
  try {
    checkBudget(); await sales.query('BEGIN'); begun = true;
    await sales.query("SET LOCAL statement_timeout='10s';SET LOCAL lock_timeout='2s'");
    const role = (await sales.query('SELECT current_user AS username,session_user AS "sessionUser",(SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser')).rows;
    if (role.length !== 1 || role[0].username !== 'gp_migration_admin' || role[0].sessionUser !== 'gp_migration_admin' || role[0].superuser !== true) fail('PG_FRESH_SOURCE_STATISTICS_CLIENT');
    for (const sql of ['ANALYZE integration.import_history_snapshot_members', 'ANALYZE integration.import_history_records', 'ANALYZE integration.import_history_versions']) {
      checkBudget(); await sales.query(sql);
    }
    checkBudget(); await sales.query('COMMIT'); begun = false;
    prepared.add(run.id); return true;
  } catch (error) {
    if (begun) await sales.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
async function rebuildFreshSources({ core, sales, access, vault, plan, ownedPlan, sourceDirectory, isolatedRecovery = false,
  onProgress = () => {}, checkBudget = () => {}, passwordProvider = async () => '' }) {
  validateFreshPlan(plan); await isolation(core, sales, isolatedRecovery); directory(sourceDirectory);
  if (!access?.transaction || !vault || typeof onProgress !== 'function' || typeof checkBudget !== 'function' || typeof passwordProvider !== 'function'
    || ownedPlan?.format !== 'grabenplaner-access-owned-state-v4' || ownedPlan.basis !== BASIS) fail('PG_FRESH_SOURCE_CONFIGURATION');
  if (!plan.actors.length) fail('PG_FRESH_SOURCE_ACTOR_REQUIRED');
  const files = fs.readdirSync(sourceDirectory).sort(), expectedFiles = plan.kinds.map(kind => kind.fileName).sort();
  if (!C.equal(files, expectedFiles)) fail('PG_FRESH_SOURCE_FILES_REQUIRED');
  const protection = await require('../../../data-import-managed-protection').loadManagedDataImportProtection({ access, vault }); if (!protection) fail('PG_FRESH_SOURCE_KEYS');
  const at = new Date().toISOString(), clock = () => at, completed = [], cash = [], historyStatistics = new Set();
  try {
    await prepareFreshRestore({ core, sales, protection, plan, isolatedRecovery, checkBudget });
    const originalWork = await captureOriginalWork({ sales, ownedPlan, checkBudget });
    const masterAnchors = new Map((await sales.query('SELECT id,scope_id AS "scopeId",identity_hash AS "identityHash",revision::text AS revision FROM trade.import_master_records ORDER BY id')).rows.map(row => [row.scopeId + ':' + row.identityHash, row]));
    const historyAnchors = new Map((await sales.query('SELECT id,scope_id AS "scopeId",identity_hash AS "identityHash",revision::text AS revision FROM integration.import_history_records ORDER BY id')).rows.map(row => [row.scopeId + ':' + row.identityHash, row]));
    const masterWriters = require('../../repositories/import-master-data').createImportMasterWriters({ protection }), historyWriters = require('../../repositories/import-history').createImportHistoryWriters({ protection, authorize: () => true, resolveMasterSourceInstance: () => 'tradefoto-trade' });
    for (const actor of plan.actors) for (const kind of [...SOURCE_KINDS.filter(kind => kind !== 'cash'), 'cash']) {
      checkBudget(); const input = readSource(sourceDirectory, kind), sourceId = protection.digest(['source', actor, kind, input.fileSha256]), excluded = new Map();
      const tag = hash([plan.planSha256, actor, kind, input.fileSha256, at]).slice(0, 24), policy = Object.freeze({ namespace: FORMAT, isolatedRecovery: true, catalogTag: tag, reason: (run, identity) => excluded.get(run + ':' + identity) || null }); POLICIES.add(policy);
      let runtime, current;
      try {
        const original = (await core.query('SELECT id,scope_id AS "scopeId",owner_id AS "ownerId",revision::text AS revision,created_at AS "createdAt",updated_at AS "updatedAt",payload FROM gp.data_import_sources WHERE id=$1', [sourceId])).rows[0];
        if (original) {
          const data = protection.open(original.payload, sourceContext(original));
          if (data.kind !== kind || data.fileSha256 !== input.fileSha256 || data.bytes !== input.bytes) fail('PG_FRESH_SOURCE_METADATA');
          const previousRecovery = data.freshSourceRecovery, oldRetirement = data.retirement || previousRecovery?.previousRetirement;
          const oldProof = data.independentCountProof || previousRecovery?.previousIndependentCountProof; data.complete = false; data.status = 'interrupted'; data.tables = []; delete data.catalog; delete data.retirement; delete data.progress; delete data.independentCountProof; delete data.readyPlanValidation; delete data.recheckedRun;
          if (kind === 'cash') { data.storage = 'cash-compact-v1'; data.scope = 'full'; }
          data.contentDate = require('../../../data-import-content-date').empty(); data.freshSourceRecovery = { ...previousRecovery, format: FORMAT, planSha256: plan.planSha256, generationAt: at, originalCreatedAt: original.createdAt, requiresFreshAccess: false };
          if (oldRetirement) data.freshSourceRecovery.previousRetirement = oldRetirement;
          if (oldProof) data.freshSourceRecovery.previousIndependentCountProof = oldProof;
          const next = { ...original, revision: integer(original.revision) + 1 };
          if ((await core.query('UPDATE gp.data_import_sources SET revision=$2,payload=$3,created_at=$4,updated_at=$4 WHERE id=$1 AND revision=$5', [sourceId, next.revision, protection.seal(data, sourceContext(next)), at, original.revision])).rowCount !== 1) fail('PG_FRESH_SOURCE_CONCURRENT');
        }
        const defs = S.definitions(kind), getSession = async () => recoverySession(actor.ownerId);
        async function anchors(event) {
          if (kind === 'cash') return;
          const def = defs.find(def => def.name === event.name); if (!def || current !== event.name) fail('PG_FRESH_SOURCE_PROTOCOL');
          await applyFreshAnchors({ access, protection, actor, kind, def, rows: event.rows, masterAnchors, historyAnchors, masterWriters, historyWriters,
            originalWork, excluded, checkBudget, resolveContext: async () => {
              const row = (await core.query('SELECT id,scope_id AS "scopeId",owner_id AS "ownerId",revision::text AS revision,payload FROM gp.data_import_sources WHERE id=$1', [sourceId])).rows[0];
              const data = protection.open(row.payload, sourceContext(row)), table = data.tables.find(table => table.name === event.name), runId = table?.run?.id;
              if (!runId) fail('PG_FRESH_SOURCE_PROTOCOL');
              return { ...actor, sourceInstance: 'tradefoto-' + kind, sourceSystem: def.profile.sourceSystem, sourceTable: def.name,
                profileHash: def.profile.fingerprint, at, fileSha256: input.fileSha256, snapshotAt: at, runId, expectedRows: table.run.expectedRows };
            } });
        }
        runtime = require('../../repositories/data-import-runtime').createDataImportRuntime({ access, vault, scopeId: actor.scopeId, allowApply: true, sharedPayloads: true, compactCash: true,
          syncArticleCatalog: true, recoveryReplay: policy, clock, readSource: options => S.readTradeFotoFullSource({ ...options, send: async event => {
            checkBudget(); if (event.type === 'rows') await anchors(event);
            const ack = await options.onMessage(event); if (event.type === 'table') current = event.name; if (event.type === 'table-complete') current = null; return ack;
          } }) });
        let source = await runtime.upload(getSession, { buffer: input.buffer, kind, fileName: input.fileName, password: await passwordProvider(kind) }), steps = 0;
        while (source.status === 'reviewing') { checkBudget(); if (++steps > 10000000) fail('PG_FRESH_SOURCE_STEP_LIMIT'); onProgress({ phase: 'review', kind }); source = await runtime.sourceOperation(getSession, source.id, 'review', { expectedRevision: source.revision }); }
        if (!source.complete || source.tables.some(table => table.run?.gates?.length)) fail('PG_FRESH_SOURCE_COUNT_REVIEW');
        if (source.tables.some(table => integer(table.run?.counts?.invalid || 0))) fail('PG_FRESH_SOURCE_QUALITY_REVIEW');
        let outcome;
        if (kind === 'cash') {
          if (source.status !== 'ready') fail('PG_FRESH_SOURCE_CASH_INCOMPLETE');
          onProgress({ phase: 'cash', kind }); const publication = await rebuildCash({ access, sales, protection, actor, source: { ...source, fileSha256: input.fileSha256 }, plan, clock }); cash.push(publication);
        } else {
          while (source.status !== 'applied' || source.catalogUpdatePending) {
            checkBudget(); if (++steps > 10000000 || !['ready', 'needs_review', 'applying', 'applied'].includes(source.status)) fail('PG_FRESH_SOURCE_APPLY_INCOMPLETE');
            await prepareFinalHistoryStatistics({ core, sales, source, defs, prepared: historyStatistics, protection, actor, kind, input, isolatedRecovery, checkBudget });
            onProgress({ phase: 'apply', kind }); source = await runtime.sourceOperation(getSession, source.id, 'apply', { expectedRevision: source.revision });
          }
          if (source.tables.some(table => table.deferred)) fail('PG_FRESH_SOURCE_PUBLICATION_REVIEW');
          for (const table of source.tables) {
            const def = defs.find(def => def.name === table.name); if (!H.usesSnapshotMembership(def.profile)) continue;
            await access.transaction(tx => require('../../repositories/import-history-snapshots').createHistorySnapshots({ protection }).publication(tx, table.run.id), { isolation: 'serializable', readOnly: true });
          }
          outcome = await verifyFreshOutcome({ sales, source, excluded, checkBudget });
        }
        completed.push({ kind, scopeId: actor.scopeId, sourceId: source.id, fileSha256: input.fileSha256, bytes: input.bytes, status: source.status,
          rows: source.tables.reduce((sum, table) => sum + table.run.receivedRows, 0), outcome: outcome || { verifiedCashRows: source.verifiedRows },
          preservedGpConflicts: excluded.size, catalog: source.catalog ? { complete: source.catalog.complete, changed: source.catalog.changed, blocked: source.catalog.blocked } : null });
      } finally { input.buffer.fill(0); await runtime?.stop(); }
    }
    return { format: FORMAT, basis: BASIS, verified: true, rehydrated: true, requiresFreshAccess: false, newSourceGeneration: true, oldSourceValuesReconstructed: false,
      sourceCount: completed.length, sources: completed, cash: { verified: cash.length === plan.actors.length && cash.every(result => result.verified), generations: cash }, planSha256: plan.planSha256 };
  } finally { protection.destroy(); }
}
module.exports = { FORMAT, createFreshPlan, validateFreshPlan, prepareFreshRestore, rebuildFreshSources, assertFreshRuntimePolicy };

'use strict';
// Sparse GP state for a source-level Access rebuild. Completed import histories
// are reconstructed from the selected generation; keep own/unknown/pending rows
// and the finite original identities required by those rows and Core.
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), crypto = require('node:crypto'), readline = require('node:readline');
const C = require('../../../data-import-contract');
const H = require('../../../tradefoto-history-profiles');
const M = require('../../../tradefoto-master-profiles');
const { definitions } = require('../../../tradefoto-full-import-source');
const { SOURCE_KINDS } = require('../../../data-import-source-catalog');
const { appliedImportSourceArchiveEntries } = require('../../../data-import-source-archive');
const FORMAT = 'grabenplaner-access-owned-state-v3', FRESH_FORMAT = 'grabenplaner-access-owned-state-v4', FRESH_BASIS = 'fresh-source-rebuild', FILE = 'access-owned-state.rows';
const PRE_APPLY_STATUSES = new Set(['staging','reviewing','needs_review','ready','cancelled']);
const BATCH = 100, MAX_ROW = 32 * 1024 * 1024, SOURCE_SYSTEM = 'tradefoto.artikel_stamm';
const SPECS = Object.freeze([
  ...[
    ['data_import_rows', ['run_id', 'row_number'], 'run'], ['data_import_changes', ['run_id', 'row_number'], 'run'],
    ['data_import_links', ['id'], 'links'], ['data_import_payload_blocks', ['id'], 'blocks'],
    ['data_import_row_payload_refs', ['run_id', 'row_number', 'slot'], 'run'],
    ['data_import_change_payload_refs', ['run_id', 'row_number', 'slot'], 'run'], ['data_import_run_state_counts', ['run_id', 'state'], 'run'],
    ['import_history_records', ['id'], 'history-record'], ['import_history_versions', ['record_id', 'revision'], 'history'],
    ['import_history_segments', ['record_id', 'revision', 'data_class'], 'history'], ['import_history_references', ['record_id', 'revision', 'role'], 'history'],
    ['import_history_holds', ['record_id', 'consumer_id'], 'history'], ['import_history_snapshots', ['run_id'], 'snapshot'],
    ['import_history_snapshot_members', ['run_id', 'row_number'], 'snapshot'], ['import_history_snapshot_attestations', ['run_id'], 'snapshot'],
  ].map(([table, key, select]) => ({ schema: 'integration', table, key, select })),
  ...[
    ['import_master_records', ['id'], 'master-record'], ['import_master_segments', ['record_id', 'kind', 'data_class'], 'master'],
    ['import_master_relations', ['record_id', 'slot'], 'master'], ['sales_article_revisions', ['product_id', 'revision'], 'revision'],
    ['sales_article_price_snapshots', ['id'], 'native-snapshot'], ['sales_article_identifiers', ['id'], 'identifier'],
    ['sales_article_import_impacts', ['snapshot_id', 'ordinal'], 'native-impact'], ['sales_article_import_findings', ['snapshot_id', 'ordinal'], 'native-impact'],
  ].map(([table, key, select]) => ({ schema: 'trade', table, key, select })),
]);
const PROJECTED_TABLES = Object.freeze(SPECS.map(({ schema, table }) => Object.freeze({ schema, table })));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => C.canonical(value);
const q = value => '"' + value.replace(/"/g, '""') + '"';
const rel = value => q(value.schema) + '.' + q(value.table);
const exact = (value, fields) => { if (!C.plain(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail('PG_ACCESS_OWNED_SHAPE'); };
const safe = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) fail('PG_ACCESS_OWNED_INTEGER'); return n; };
const key = value => value.schema + '.' + value.table;
function profileRegistry() {
  const result = new Map();
  for (const kind of SOURCE_KINDS) for (const definition of definitions(kind)) {
    for (const profile of definition.master ? [definition.profile] : H.profilesFor(definition.source, definition.name)) {
      result.set('tradefoto-' + kind + ':' + profile.fingerprint, { kind, source: definition.source, master: definition.master, table: definition.name,
        sourceSystem: profile.sourceSystem, entity: profile.entity, profileHash: profile.fingerprint, sourceInstance: 'tradefoto-' + kind, profile });
    }
  }
  return result;
}
const REGISTRY = profileRegistry();
function classifyRun(row, { archiveProof, protection, basis } = {}) {
  let manifest;
  try { manifest = typeof row.manifest === 'string' ? JSON.parse(row.manifest) : row.manifest; } catch { return { omit: false }; }
  const profile = REGISTRY.get(manifest?.sourceInstance + ':' + row.profile_hash);
  const preApply = basis === FRESH_BASIS && PRE_APPLY_STATUSES.has(row.status);
  if (!profile || !preApply && !['applied', 'reverted', 'purged'].includes(row.status)) return { omit: false };
  if (basis === FRESH_BASIS) {
    try {
      C.id(row.scope_id); C.id(row.owner_id); C.id(row.attempt_id);
      const original = require('../../../data-import-source-tolerance').originalManifest(manifest);
      if (manifest.schemaSha256 !== profile.profile.schemaSha256 || !C.equal(original, C.normalizeDataImportManifest(original, profile.profile))
        || protection?.digest(['run', C.VERSION, { scopeId: row.scope_id, ownerId: row.owner_id }, row.profile_hash, manifest, row.attempt_id]) !== row.id) return { omit: false };
    } catch { return { omit: false }; }
  }
  C.sha(manifest.fileSha256);
  // Obsolete technical staging can disappear even if its old original is no
  // longer needed. V3 current business records receive a separate file/run
  // proof; V4 explicitly permits a newly supplied Access generation instead.
  // A ready/reviewed source is still reconstructible staging. It may be
  // omitted only after the snapshot proves it has no changes or applied/undo
  // rows. Review/count decisions remain in the normal run/event/Core dump.
  return { omit: !preApply, ...(preApply ? { unappliedCandidate: true } : {}), kind: profile.kind, fileSha256: manifest.fileSha256 };
}
async function columns(client, spec) {
  return (await client.query(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS "notNull",a.attidentity AS identity,a.attgenerated AS generated
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [spec.schema, spec.table])).rows;
}
function validateOwnedPlan(plan) {
  const fresh = plan?.format === FRESH_FORMAT;
  exact(plan, ['format', fresh ? 'basis' : 'archiveGenerationSha256', 'file', 'bytes', 'sha256', 'rows', 'tables', 'stats', 'planSha256']);
  if ((fresh ? plan.basis !== FRESH_BASIS : plan.format !== FORMAT) || plan.file !== FILE || !Array.isArray(plan.tables) || plan.tables.length > SPECS.length) fail('PG_ACCESS_OWNED_PLAN');
  for (const field of [...(fresh ? [] : ['archiveGenerationSha256']), 'sha256', 'planSha256']) C.sha(plan[field]);
  C.integer(plan.rows, 0, Number.MAX_SAFE_INTEGER); C.integer(plan.bytes, 0, Number.MAX_SAFE_INTEGER);
  exact(plan.stats, ['completedAccessRuns', 'retainedPendingOrUnknownRuns', 'masterAnchors', 'historyAnchors', 'catalogRevisions',...(fresh&&Object.hasOwn(plan.stats,'omittedUnappliedAccessRuns')?['omittedUnappliedAccessRuns']:[])]);
  Object.values(plan.stats).forEach(n => C.integer(n, 0, Number.MAX_SAFE_INTEGER));
  let count = 0, previous = -1;
  for (const table of plan.tables) {
    exact(table, ['schema', 'table', 'columns', 'schemaSha256', 'rows', 'contentSha256']);
    const index = SPECS.findIndex(spec => key(spec) === key(table));
    if (index <= previous || index < 0 || !Array.isArray(table.columns) || !table.columns.length || table.columns.length > 200) fail('PG_ACCESS_OWNED_TABLE');
    previous = index; const names = new Set();
    for (const column of table.columns) {
      exact(column, ['name', 'type', 'notNull', 'identity', 'generated']);
      if (!/^[a-z][a-z0-9_]*$/.test(column.name) || names.has(column.name) || typeof column.type !== 'string' || !column.type.length || column.type.length > 200
        || typeof column.notNull !== 'boolean' || !['', 'a', 'd'].includes(column.identity) || column.generated !== '') fail('PG_ACCESS_OWNED_COLUMN');
      names.add(column.name);
    }
    if (SPECS[index].key.some(name => !names.has(name))) fail('PG_ACCESS_OWNED_KEY');
    C.sha(table.schemaSha256); C.sha(table.contentSha256); C.integer(table.rows, 0, Number.MAX_SAFE_INTEGER); count += table.rows;
    if (table.schemaSha256 !== hash(canonical({ schema: table.schema, table: table.table, columns: table.columns }))) fail('PG_ACCESS_OWNED_SCHEMA');
  }
  if (count !== plan.rows) fail('PG_ACCESS_OWNED_COUNT');
  const { planSha256, ...content } = plan;
  if (hash(canonical(content)) !== planSha256) fail('PG_ACCESS_OWNED_HASH');
  return plan;
}
async function privateFile(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory) fail('PG_ACCESS_OWNED_DIRECTORY');
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fsp.realpath(directory) !== directory || process.platform !== 'win32' && (stat.uid !== process.getuid() || stat.mode & 0o077)) fail('PG_ACCESS_OWNED_DIRECTORY');
  return path.join(directory, FILE);
}
const context = (plan, ordinal, part, total) => [plan.format, plan.format === FRESH_FORMAT ? plan.basis : plan.archiveGenerationSha256, ordinal, part, total];
function encode(row, protection, plan, ordinal) {
  const bytes = Buffer.from(canonical(row)), size = C.LIMITS.rowBytes, parts = [];
  try {
    if (bytes.length > MAX_ROW) fail('PG_ACCESS_OWNED_ROW_SIZE');
    const total = Math.max(1, Math.ceil(bytes.length / size));
    for (let i = 0; i < total; i++) parts.push(protection.seal({ part: bytes.subarray(i * size, (i + 1) * size).toString('base64') }, context(plan, ordinal, i, total)));
    return JSON.stringify({ format: plan.format, parts }) + '\n';
  } finally { bytes.fill(0); }
}
function decode(line, protection, plan, ordinal) {
  const outer = JSON.parse(line); exact(outer, ['format', 'parts']);
  if (outer.format !== plan.format || !Array.isArray(outer.parts) || !outer.parts.length || outer.parts.length > Math.ceil(MAX_ROW / C.LIMITS.rowBytes)) fail('PG_ACCESS_OWNED_LINE');
  const chunks = []; let bytes;
  try {
    for (let i = 0; i < outer.parts.length; i++) {
      const part = protection.open(outer.parts[i], context(plan, ordinal, i, outer.parts.length)); exact(part, ['part']);
      if (typeof part.part !== 'string') fail('PG_ACCESS_OWNED_LINE');
      const chunk = Buffer.from(part.part, 'base64'); chunks.push(chunk);
      if (chunk.toString('base64') !== part.part || chunk.length > C.LIMITS.rowBytes || i + 1 < outer.parts.length && chunk.length !== C.LIMITS.rowBytes) fail('PG_ACCESS_OWNED_LINE');
    }
    bytes = Buffer.concat(chunks); return JSON.parse(bytes.toString('utf8'));
  } finally { bytes?.fill(0); chunks.forEach(bytes => bytes.fill(0)); }
}
async function eachRow(file, protection, plan, work) {
  const input = fs.createReadStream(file, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) }), lines = readline.createInterface({ input, crlfDelay: Infinity }); let ordinal = 0;
  try { for await (const line of lines) { if (!line || Buffer.byteLength(line) > MAX_ROW * 2) fail('PG_ACCESS_OWNED_LINE'); await work(decode(line, protection, plan, ordinal), ordinal++); } }
  finally { lines.close(); input.destroy(); }
  if (ordinal !== plan.rows) fail('PG_ACCESS_OWNED_COUNT');
}
function predicate(spec, alias, tables) {
  const inSet = (field, name) => `EXISTS(SELECT 1 FROM ${tables[name]} k WHERE k.id=${alias}.${q(field)})`;
  const native = snapshot => `EXISTS(SELECT 1 FROM trade.sales_article_import_snapshots s WHERE s.id=${alias}.${q(snapshot)} AND s.source_system<>'${SOURCE_SYSTEM}')`;
  switch (spec.select) {
    case 'run': return `NOT ${inSet('run_id', 'drop')}`;
    case 'links': return inSet('id', 'links');
    case 'blocks': return inSet('id', 'blocks');
    case 'master-record': return inSet('id', 'master');
    case 'master': return inSet('record_id', 'master');
    case 'history-record': return inSet('id', 'history');
    case 'history': return inSet('record_id', 'history');
    case 'snapshot': return inSet('run_id', 'snapshot');
    case 'revision': return `EXISTS(SELECT 1 FROM ${tables.revisions} k WHERE k.product_id=${alias}.product_id AND k.revision=${alias}.revision)`;
    case 'native-snapshot': return `${native('source_snapshot_id')} OR EXISTS(SELECT 1 FROM trade.sales_article_revisions r JOIN ${tables.ownRevisions} k ON k.product_id=r.product_id AND k.revision=r.revision WHERE r.product_id=${alias}.product_id AND r.source_snapshot_id=${alias}.source_snapshot_id)`;
    case 'native-impact': return native('snapshot_id');
    case 'identifier': return `${native('source_snapshot_id')} OR EXISTS(SELECT 1 FROM trade.sales_article_revisions r JOIN ${tables.revisions} k ON k.product_id=r.product_id AND k.revision=r.revision WHERE r.product_id=${alias}.product_id AND r.source_snapshot_id=${alias}.source_snapshot_id)`;
    default: fail('PG_ACCESS_OWNED_SELECTOR');
  }
}
async function retainFreshAnchorLinks({ sales, tables, existing, protection, checkBudget }) {
  if (!existing.has('integration.data_import_links')) return;
  const targets = [];
  if (existing.has('trade.import_master_records')) targets.push(`SELECT r.id,r.scope_id FROM trade.import_master_records r JOIN ${tables.master} k ON k.id=r.id`);
  if (existing.has('integration.import_history_records')) targets.push(`SELECT r.id,r.scope_id FROM integration.import_history_records r JOIN ${tables.history} k ON k.id=r.id`);
  if (!targets.length) return;
  // A bounded union of actual own target/scope pairs avoids repeating an OR
  // subquery for every source link. UNION also preserves the original Boolean
  // membership if master/history IDs happen to overlap.
  const selected = `JOIN (${targets.join(' UNION ')}) own_target ON own_target.id=l.target_id AND own_target.scope_id=l.scope_id`;
  const undone = existing.has('integration.data_import_changes') ? new Set((await sales.query(`SELECT DISTINCT c.identity_hash FROM integration.data_import_changes c JOIN integration.data_import_links l ON l.id=c.identity_hash ${selected} WHERE c.reverted_at IS NOT NULL`)).rows.map(row => row.identity_hash)) : new Set();
  const candidates = (await sales.query(`SELECT l.* FROM integration.data_import_links l JOIN ${tables.drop} d ON d.id=l.last_run_id ${selected} WHERE NOT EXISTS(SELECT 1 FROM ${tables.links} k WHERE k.id=l.id) ORDER BY l.id`)).rows;
  const runs = new Map();
  for (const link of candidates) {
    checkBudget(); if (undone.has(link.id)) continue;
    if (!runs.has(link.last_run_id)) {
      const run = (await sales.query('SELECT id,scope_id,owner_id,profile_hash,manifest,status,attempt_id FROM integration.data_import_runs WHERE id=$1', [link.last_run_id])).rows[0];
      // All candidates use this same immutable transaction snapshot. Verify a
      // run's complete HMAC/manifest once; every individual link, identity,
      // current target, segment and content comparison below remains checked.
      let verified = null;
      if (run && classifyRun(run, { protection, basis: FRESH_BASIS }).omit) {
        const manifest = typeof run.manifest === 'string' ? JSON.parse(run.manifest) : run.manifest;
        verified = { run, manifest, profile: REGISTRY.get(manifest.sourceInstance + ':' + run.profile_hash) };
      }
      runs.set(link.last_run_id, verified);
    }
    const verified = runs.get(link.last_run_id); if (!verified) continue;
    const { run, manifest, profile } = verified;
    let value;
    try {
      value = protection.open(link.payload, ['link', link.id]); exact(value, ['record', 'contentHash', 'targetRevision']);
      if (!C.equal(value.record, C.normalizeDataImportRow(profile.profile, value.record.source)) || value.contentHash !== protection.digest({ record: value.record })
        || link.scope_id !== run.scope_id || link.entity !== profile.entity
        || link.id !== protection.digest(['identity', link.scope_id, profile.sourceSystem, manifest.sourceInstance, profile.table, profile.entity, profile.profile.keyFields, value.record.key])) continue;
    } catch { continue; }
    const relation = profile.master ? 'trade.import_master_records' : 'integration.import_history_records';
    const header = (await sales.query('SELECT * FROM ' + relation + ' WHERE id=$1 AND scope_id=$2', [link.target_id, link.scope_id])).rows[0];
    if (!header || header.profile_hash !== profile.profileHash || header.source_instance !== manifest.sourceInstance || header.source_table !== profile.table || !profile.master && header.source !== profile.source
      || value.targetRevision !== safe(header.revision)) continue;
    const natural = profile.master ? M.masterIdentity(protection, { scopeId: link.scope_id, sourceInstance: manifest.sourceInstance }, profile.table, value.record.key)
      : H.historyIdentity(protection, { scopeId: link.scope_id, sourceInstance: manifest.sourceInstance }, profile.source, profile.table, value.record.key, profile.profileHash);
    if (header.identity_hash !== natural) continue;
    let data = {};
    if (profile.master) {
      for (const segment of (await sales.query('SELECT kind,data_class,payload FROM trade.import_master_segments WHERE record_id=$1 ORDER BY kind,data_class', [header.id])).rows) {
        const part = protection.open(segment.payload, ['master-segment', header.scope_id, header.source_instance, header.source_table, header.identity_hash, header.id, header.profile_hash, safe(header.revision), segment.kind, segment.data_class]);
        if (!C.plain(part) || Object.keys(part).some(field => Object.hasOwn(data, field))) fail('PG_ACCESS_OWNED_ANCHOR_INTEGRITY'); Object.assign(data, part);
      }
    } else {
      const version = (await sales.query('SELECT * FROM integration.import_history_versions WHERE record_id=$1 AND revision=$2', [header.id, header.revision])).rows[0];
      if (!version) fail('PG_ACCESS_OWNED_ANCHOR_INTEGRITY');
      const ctx = ['history-version', header.scope_id, header.source_instance, header.source, header.source_table, header.id, header.identity_hash, header.profile_hash,
        safe(header.revision), version.file_sha256, version.snapshot_at, version.imported_by, version.imported_at, version.run_id, version.master_source_instance, version.business_date, version.parent_id, version.parent_revision];
      const meta = protection.open(version.payload, ctx);
      if (meta.restoredFromRevision !== null) continue;
      for (const segment of (await sales.query('SELECT data_class,payload FROM integration.import_history_segments WHERE record_id=$1 AND revision=$2 ORDER BY data_class', [header.id, header.revision])).rows) {
        const part = protection.open(segment.payload, [...ctx, 'segment', segment.data_class]);
        if (!C.plain(part) || Object.keys(part).some(field => Object.hasOwn(data, field))) fail('PG_ACCESS_OWNED_ANCHOR_INTEGRITY'); Object.assign(data, part);
      }
      if (meta.dataHash !== protection.digest(data)) fail('PG_ACCESS_OWNED_ANCHOR_INTEGRITY');
    }
    if (!C.equal(data, value.record.data)) continue;
    await sales.query(`INSERT INTO ${tables.links}(id) VALUES($1) ON CONFLICT DO NOTHING`, [link.id]);
  }
}
async function selectGraph({ core, sales, protection, archiveProof, existing, basis, checkBudget }) {
  const suffix = crypto.randomBytes(8).toString('hex'), savepoint = 'gp_owned_' + suffix, tables = {};
  await sales.query('SAVEPOINT ' + q(savepoint));
  const stats = { completedAccessRuns: 0, retainedPendingOrUnknownRuns: 0, masterAnchors: 0, historyAnchors: 0, catalogRevisions: 0,...(basis===FRESH_BASIS?{omittedUnappliedAccessRuns:0}: {}) };
  const exists = name => existing.has(name), runKeep = alias => `NOT EXISTS(SELECT 1 FROM ${tables.drop} d WHERE d.id=${alias}.run_id)`;
  const insertIds = async (table, values) => { for (let i = 0; i < values.length; i += 1000) { checkBudget(); await sales.query(`INSERT INTO ${table}(id) SELECT value FROM jsonb_array_elements_text($1::jsonb) WHERE true ON CONFLICT DO NOTHING`, [JSON.stringify(values.slice(i, i + 1000))]); } };
  const insertRevisions = async (values, target = tables.revisions) => { for (let i = 0; i < values.length; i += 1000) { checkBudget(); await sales.query(`INSERT INTO ${target} SELECT product_id,revision FROM jsonb_to_recordset($1::jsonb) AS r(product_id text,revision bigint) WHERE true ON CONFLICT DO NOTHING`, [JSON.stringify(values.slice(i, i + 1000))]); } };
  try {
    for (const name of ['drop', 'links', 'master', 'history', 'snapshot', 'blocks']) {
      tables[name] = 'pg_temp.' + q('gp_owned_' + suffix + '_' + name);
      await sales.query(`CREATE TEMP TABLE ${tables[name]}(id text COLLATE "C" PRIMARY KEY) ON COMMIT DROP`);
    }
    tables.revisions = 'pg_temp.' + q('gp_owned_' + suffix + '_revisions');
    await sales.query(`CREATE TEMP TABLE ${tables.revisions}(product_id text COLLATE "C",revision bigint,PRIMARY KEY(product_id,revision)) ON COMMIT DROP`);
    tables.ownRevisions = 'pg_temp.' + q('gp_owned_' + suffix + '_own_revisions');
    await sales.query(`CREATE TEMP TABLE ${tables.ownRevisions}(product_id text COLLATE "C",revision bigint,PRIMARY KEY(product_id,revision)) ON COMMIT DROP`);
    tables.registry = 'pg_temp.' + q('gp_owned_' + suffix + '_registry');
    await sales.query(`CREATE TEMP TABLE ${tables.registry}(profile_hash text COLLATE "C",source_instance text COLLATE "C",source_system text COLLATE "C",source_table text COLLATE "C",entity text COLLATE "C",master boolean,PRIMARY KEY(profile_hash,source_instance)) ON COMMIT DROP`);
    const registry = [...REGISTRY.values()].map(p => ({ profile_hash: p.profileHash, source_instance: p.sourceInstance, source_system: p.sourceSystem, source_table: p.table, entity: p.entity, master: Boolean(p.master) }));
    await sales.query(`INSERT INTO ${tables.registry} SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(profile_hash text,source_instance text,source_system text,source_table text,entity text,master boolean)`, [JSON.stringify(registry)]);
    if (exists('integration.data_import_runs')) {
      const rows = (await sales.query('SELECT id,scope_id,owner_id,profile_hash,manifest,status,attempt_id FROM integration.data_import_runs ORDER BY id')).rows, omitted = [], unapplied=[];
      for (const row of rows) { checkBudget(); const result=classifyRun(row, { archiveProof, protection, basis });
        if (result.omit) { omitted.push(row.id); stats.completedAccessRuns++; }
        else if(result.unappliedCandidate)unapplied.push(row.id);
        else stats.retainedPendingOrUnknownRuns++;
      }
      for(let i=0;i<unapplied.length;i+=1000){
        checkBudget();const ids=unapplied.slice(i,i+1000),changed=new Set();
        // Indexed run_id probes avoid scanning the complete source staging.
        if(exists('integration.data_import_changes'))for(const row of (await sales.query('SELECT DISTINCT run_id FROM integration.data_import_changes WHERE run_id=ANY($1::text[])',[ids])).rows)changed.add(row.run_id);
        if(exists('integration.data_import_rows'))for(const row of (await sales.query("SELECT DISTINCT run_id FROM integration.data_import_rows WHERE run_id=ANY($1::text[]) AND state IN ('applied','reverted')",[ids])).rows)changed.add(row.run_id);
        for(const id of ids)if(changed.has(id))stats.retainedPendingOrUnknownRuns++;else{omitted.push(id);stats.omittedUnappliedAccessRuns++;}
      }
      await insertIds(tables.drop, omitted);
    }
    if (exists('integration.data_import_links')) {
      // Keep the three equivalent branches separate. Combining these with OR
      // makes PostgreSQL execute a correlated staging scan for each source
      // link; on the real Sales copy that exhausted the five-minute SQL budget.
      // Flat joins filter retained runs once, and the primary key deduplicates
      // links used by more than one retained row/change.
      await sales.query(`INSERT INTO ${tables.links} SELECT l.id FROM integration.data_import_links l WHERE NOT EXISTS(SELECT 1 FROM ${tables.drop} d WHERE d.id=l.last_run_id) ON CONFLICT DO NOTHING`);
      for (const table of ['data_import_rows', 'data_import_changes']) if (exists('integration.' + table)) {
        checkBudget();
        await sales.query(`INSERT INTO ${tables.links} SELECT l.id FROM integration.${table} r JOIN integration.data_import_links l ON l.id=r.identity_hash WHERE ${runKeep('r')} ON CONFLICT DO NOTHING`);
      }
    }
    // Core remains byte-for-byte in the normal dump. Transfer only its finite
    // external identities to this Sales snapshot, without decrypting Core data.
    for (const [table, field] of [['trade_source_references', 'id'], ['import_master_bindings', 'record_id'], ['import_master_events', 'record_id'], ['import_master_holds', 'record_id']]) {
      if (!(await core.query('SELECT to_regclass($1) AS name', ['gp.' + table])).rows[0]?.name) continue;
      const ids = (await core.query(`SELECT DISTINCT ${q(field)} AS id FROM gp.${q(table)} ORDER BY ${q(field)}`)).rows.map(row => row.id);
      await insertIds(tables.master, ids);
    }
    if ((await core.query("SELECT to_regclass('gp.article_reference_snapshots') AS name")).rows[0]?.name) await insertRevisions((await core.query('SELECT product_id,revision FROM gp.article_reference_snapshots ORDER BY product_id,revision')).rows, tables.ownRevisions);
    if (exists('trade.import_master_records')) {
      await sales.query(`INSERT INTO ${tables.master} SELECT r.id FROM trade.import_master_records r WHERE NOT EXISTS(SELECT 1 FROM ${tables.registry} p WHERE p.master AND p.profile_hash=r.profile_hash AND p.source_instance=r.source_instance AND p.source_table=r.source_table) ON CONFLICT DO NOTHING`);
      for (const table of ['import_master_bindings', 'import_master_events', 'import_master_holds']) if (exists('trade.' + table)) await sales.query(`INSERT INTO ${tables.master} SELECT DISTINCT record_id FROM trade.${table} WHERE true ON CONFLICT DO NOTHING`);
      if (exists('integration.data_import_links')) await sales.query(`INSERT INTO ${tables.master} SELECT r.id FROM trade.import_master_records r JOIN integration.data_import_links l ON l.target_id=r.id JOIN ${tables.links} k ON k.id=l.id ON CONFLICT DO NOTHING`);
      if (exists('integration.data_import_links') && exists('integration.data_import_changes') && exists('integration.data_import_runs')) await sales.query(`INSERT INTO ${tables.master} SELECT r.id FROM trade.import_master_records r JOIN integration.data_import_links l ON l.target_id=r.id JOIN integration.data_import_changes c ON c.identity_hash=l.id JOIN integration.data_import_runs u ON u.id=c.run_id WHERE u.status='reverted' AND c.reverted_at IS NOT NULL ON CONFLICT DO NOTHING`);
    }
    if (exists('integration.import_history_snapshots')) await sales.query(`INSERT INTO ${tables.snapshot} SELECT h.run_id FROM integration.import_history_snapshots h WHERE NOT EXISTS(SELECT 1 FROM ${tables.drop} d WHERE d.id=h.run_id) ON CONFLICT DO NOTHING`);
    if (exists('integration.import_history_records')) {
      await sales.query(`INSERT INTO ${tables.history} SELECT r.id FROM integration.import_history_records r WHERE NOT EXISTS(SELECT 1 FROM ${tables.registry} p WHERE NOT p.master AND p.profile_hash=r.profile_hash AND p.source_instance=r.source_instance AND p.source_table=r.source_table) ON CONFLICT DO NOTHING`);
      if (exists('integration.import_history_holds')) await sales.query(`INSERT INTO ${tables.history} SELECT record_id FROM integration.import_history_holds WHERE true ON CONFLICT DO NOTHING`);
      if (exists('integration.import_history_versions') && exists('integration.data_import_runs')) await sales.query(`INSERT INTO ${tables.history} SELECT r.id FROM integration.import_history_records r JOIN integration.import_history_versions v ON v.record_id=r.id AND v.revision=r.revision JOIN integration.data_import_runs u ON u.id=v.run_id WHERE u.status='reverted' ON CONFLICT DO NOTHING`);
      if (exists('integration.data_import_links')) await sales.query(`INSERT INTO ${tables.history} SELECT r.id FROM integration.import_history_records r JOIN integration.data_import_links l ON l.target_id=r.id JOIN ${tables.links} k ON k.id=l.id ON CONFLICT DO NOTHING`);
      if (exists('integration.import_history_snapshot_members')) await sales.query(`INSERT INTO ${tables.history} SELECT m.record_id FROM integration.import_history_snapshot_members m JOIN ${tables.snapshot} k ON k.id=m.run_id ON CONFLICT DO NOTHING`);
      if (exists('integration.import_history_versions')) await sales.query(`WITH RECURSIVE closure(id) AS(SELECT id FROM ${tables.history} UNION SELECT v.parent_id FROM integration.import_history_versions v JOIN closure k ON k.id=v.record_id WHERE v.parent_id IS NOT NULL) INSERT INTO ${tables.history} SELECT id FROM closure WHERE true ON CONFLICT DO NOTHING`);
      if (exists('integration.import_history_references')) await sales.query(`INSERT INTO ${tables.master} SELECT r.master_record_id FROM integration.import_history_references r JOIN ${tables.history} k ON k.id=r.record_id WHERE r.master_record_id IS NOT NULL ON CONFLICT DO NOTHING`);
    }
    if (exists('trade.import_master_records') && exists('trade.import_master_relations')) await sales.query(`WITH RECURSIVE closure(id) AS(SELECT id FROM ${tables.master} UNION SELECT p.id FROM trade.import_master_relations r JOIN closure k ON k.id=r.record_id JOIN trade.import_master_records p ON p.identity_hash=r.identity_hash) INSERT INTO ${tables.master} SELECT id FROM closure WHERE true ON CONFLICT DO NOTHING`);
    if (basis === FRESH_BASIS) await retainFreshAnchorLinks({ sales, tables, existing, protection, checkBudget });
    if (exists('trade.sales_article_revisions')) {
      if (exists('trade.sales_articles')) await sales.query(`INSERT INTO ${tables.revisions} SELECT product_id,current_revision FROM trade.sales_articles WHERE true ON CONFLICT DO NOTHING`);
      await sales.query(`INSERT INTO ${tables.revisions} SELECT r.product_id,r.revision FROM trade.sales_article_revisions r JOIN trade.sales_article_import_snapshots s ON s.id=r.source_snapshot_id WHERE s.source_system<>'${SOURCE_SYSTEM}' ON CONFLICT DO NOTHING`);
      if (exists('trade.sales_article_import_impacts')) {
        await sales.query(`INSERT INTO ${tables.ownRevisions} SELECT i.product_id,i.imported_revision FROM trade.sales_article_import_impacts i JOIN trade.sales_article_import_snapshots s ON s.id=i.snapshot_id WHERE s.source_system<>'${SOURCE_SYSTEM}' ON CONFLICT DO NOTHING`);
        await sales.query(`INSERT INTO ${tables.ownRevisions} SELECT i.product_id,i.previous_current_revision FROM trade.sales_article_import_impacts i JOIN trade.sales_article_import_snapshots s ON s.id=i.snapshot_id WHERE s.source_system<>'${SOURCE_SYSTEM}' AND i.previous_current_revision IS NOT NULL ON CONFLICT DO NOTHING`);
      }
      await sales.query(`INSERT INTO ${tables.revisions} SELECT product_id,revision FROM ${tables.ownRevisions} WHERE true ON CONFLICT DO NOTHING`);
    }
    if (exists('integration.data_import_payload_blocks')) {
      await sales.query(`INSERT INTO ${tables.blocks} SELECT b.id FROM integration.data_import_payload_blocks b WHERE NOT EXISTS(SELECT 1 FROM ${tables.registry} p WHERE p.profile_hash=b.profile_hash AND p.source_instance=b.source_instance AND p.source_system=b.source_system AND p.source_table=b.source_table AND p.entity=b.entity) ON CONFLICT DO NOTHING`);
      for (const table of ['data_import_row_payload_refs', 'data_import_change_payload_refs']) if (exists('integration.' + table)) await sales.query(`INSERT INTO ${tables.blocks} SELECT r.block_id FROM integration.${table} r WHERE ${runKeep('r')} ON CONFLICT DO NOTHING`);
    }
    const count = async (table, predicateName) => exists(table) ? safe((await sales.query(`SELECT count(*)::text AS n FROM ${table} t WHERE ${predicate(SPECS.find(s => key(s) === table), 't', tables)}`)).rows[0].n) : 0;
    stats.masterAnchors = await count('trade.import_master_records'); stats.historyAnchors = await count('integration.import_history_records'); stats.catalogRevisions = await count('trade.sales_article_revisions');
    return { tables, stats, savepoint };
  } catch (error) { await sales.query('ROLLBACK TO SAVEPOINT ' + q(savepoint)).catch(() => {}); await sales.query('RELEASE SAVEPOINT ' + q(savepoint)).catch(() => {}); throw error; }
}
// A positive membership predicate is identically false when its frozen temp
// set is empty. Check the tiny sets, rather than scanning millions of source
// rows to rediscover that fact. Negative/OR selectors deliberately do not use
// this shortcut, nor do incoming references from unknown retained tables.
async function emptySelections(sales, selected, tables, fields, constraints, existing) {
  const sets = { links:'links', blocks:'blocks', 'master-record':'master', master:'master', 'history-record':'history', history:'history', snapshot:'snapshot', revision:'revisions' };
  const empty = new Set(), checked = new Map();
  for (const spec of selected) {
    const name = sets[spec.select]; if (!name) continue;
    if (!checked.has(name)) {
      const present = (await sales.query(`SELECT EXISTS(SELECT 1 FROM ${tables[name]}) AS present`)).rows[0]?.present;
      if (typeof present !== 'boolean') fail('PG_ACCESS_OWNED_SELECTION');
      checked.set(name, !present);
    }
    if (checked.get(name)) empty.add(key(spec));
  }
  // The negative run selector normally requires looking at source rows. Only
  // an enforced, validated, non-deferrable NOT NULL FK chain proves that every
  // child run_id belongs to an actual run header. If all headers are dropped,
  // those specific child selections are empty too. Unknown, nullable or
  // unvalidated shapes keep the original conservative row/FK queries.
  const byName = new Map(selected.map(spec => [key(spec), spec]));
  const reachesRuns = (name, path = new Set()) => {
    if (name === 'integration.data_import_runs') return true;
    if (path.has(name) || byName.get(name)?.select !== 'run') return false;
    const next = new Set([...path, name]);
    return constraints.some(edge => {
      if (edge.schema + '.' + edge.table !== name || edge.validated !== true || edge.deferrable !== false || edge.enforced !== true || edge.noInheritance !== true
        || !Array.isArray(edge.columns) || !Array.isArray(edge.parentColumns) || edge.columns.length !== edge.parentColumns.length || !edge.columns.length
        || edge.columns.some(column => !fields.get(name)?.some(field => field.name === column && field.notNull === true))) return false;
      const parent = edge.parentSchema + '.' + edge.parentTable, runIndex = edge.columns.indexOf('run_id');
      return runIndex >= 0 && edge.parentColumns[runIndex] === (parent === 'integration.data_import_runs' ? 'id' : 'run_id') && reachesRuns(parent, next);
    });
  };
  const runChildren = selected.filter(spec => spec.select === 'run' && reachesRuns(key(spec)));
  if (runChildren.length && existing.has('integration.data_import_runs')) {
    const present = (await sales.query(`SELECT EXISTS(SELECT 1 FROM integration.data_import_runs r WHERE NOT EXISTS(SELECT 1 FROM ${tables.drop} d WHERE d.id=r.id)) AS present`)).rows[0]?.present;
    if (typeof present !== 'boolean') fail('PG_ACCESS_OWNED_SELECTION');
    if (!present) for (const spec of runChildren) empty.add(key(spec));
  }
  return empty;
}
async function foreignKeys(sales) {
  return (await sales.query(`SELECT cn.nspname AS schema,c.relname AS table,pn.nspname AS "parentSchema",p.relname AS "parentTable",
    f.convalidated AS validated,f.condeferrable AS deferrable,
    NOT EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhparent=c.oid OR i.inhrelid=c.oid) AS "noInheritance",
    (EXISTS(SELECT 1 FROM pg_trigger ft WHERE ft.tgconstraint=f.oid AND ft.tgrelid=f.conrelid)
      AND NOT EXISTS(SELECT 1 FROM pg_trigger ft WHERE ft.tgconstraint=f.oid AND ft.tgenabled NOT IN ('O','A'))) AS enforced,
    array_agg(ca.attname::text ORDER BY k.ord) AS columns,array_agg(pa.attname::text ORDER BY k.ord) AS "parentColumns"
    FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_namespace cn ON cn.oid=c.relnamespace
    JOIN pg_class p ON p.oid=f.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace
    JOIN LATERAL unnest(f.conkey,f.confkey) WITH ORDINALITY k(child,parent,ord) ON true
    JOIN pg_attribute ca ON ca.attrelid=c.oid AND ca.attnum=k.child JOIN pg_attribute pa ON pa.attrelid=p.oid AND pa.attnum=k.parent
    WHERE f.contype='f' GROUP BY f.oid,f.convalidated,f.condeferrable,f.conrelid,cn.nspname,c.oid,c.relname,pn.nspname,p.relname ORDER BY 1,2,3,4`)).rows;
}
async function assertForeignKeys(sales, selected, tables, empty, constraints) {
  const byName = new Map(selected.map(spec => [key(spec), spec]));
  for (const edge of constraints) {
    const parent = byName.get(edge.parentSchema + '.' + edge.parentTable); if (!parent) continue;
    const child = byName.get(edge.schema + '.' + edge.table);
    if (!Array.isArray(edge.columns) || !Array.isArray(edge.parentColumns) || edge.columns.length !== edge.parentColumns.length || !edge.columns.length) fail('PG_ACCESS_OWNED_FK');
    if (child && empty.has(key(child))) continue;
    const sql = `SELECT EXISTS(SELECT 1 FROM ${rel(edge)} c WHERE (${child ? predicate(child, 'c', tables) : 'true'}) AND ${edge.columns.map(col => 'c.' + q(col) + ' IS NOT NULL').join(' AND ')}
      AND NOT EXISTS(SELECT 1 FROM ${rel(parent)} p WHERE (${predicate(parent, 'p', tables)}) AND ${edge.columns.map((col, i) => 'c.' + q(col) + '=p.' + q(edge.parentColumns[i])).join(' AND ')})) AS missing`;
    if ((await sales.query(sql)).rows[0]?.missing !== false) fail('PG_DEPLOY_OWNED_FK_CLOSURE');
  }
}
async function assertCurrentCoverage(sales, existing, graph, sourceReplayPlan, archiveProof, protection, checkBudget) {
  require('./access-source-replay').validateReplayPlan(sourceReplayPlan, { archiveProof });
  const covered = new Map();
  for (const source of sourceReplayPlan.sources) {
    if (source.strategy === 'normal-import') for (const table of source.tables) if (table.runId) covered.set(table.runId + ':' + table.profileHash, { source, table, scopeId: source.scopeId, ownerId: source.ownerId });
    if (source.genericCash) for (const batch of source.genericCashBatches) for (const table of batch.tables) if (table.runId) covered.set(table.runId + ':' + table.profileHash, { source, table, scopeId: batch.scopeId, ownerId: batch.ownerId });
  }
  const verify = fact => {
    const planned = covered.get(fact.run_id + ':' + fact.profile_hash);
    if (!planned || planned.scopeId !== fact.scope_id || planned.ownerId !== fact.owner_id
      || 'tradefoto-' + planned.source.kind !== fact.source_instance || planned.source.fileSha256 !== fact.file_sha256
      || planned.table.name !== fact.source_table) fail('PG_DEPLOY_ACCESS_SOURCE_COVERAGE');
  };
  // A protected stock head can survive while its source link/publication is
  // rebuilt. Only a head actually present in the required published snapshot
  // can be honestly reused; an undone/differing head must not silently cause
  // the ordinary importer to defer the whole required stock publication.
  if (existing.has('integration.import_history_records') && existing.has('integration.import_history_versions')) {
    const profileHash = H.profileFor('trade', 'ARTIKEL_FILIALEN').fingerprint;
    const anchors = (await sales.query(`SELECT r.*,v.file_sha256,v.snapshot_at,v.imported_by,v.imported_at,v.run_id,v.master_source_instance,v.business_date,v.parent_id,v.parent_revision,v.payload
      FROM integration.import_history_records r JOIN ${graph.tables.history} k ON k.id=r.id
      JOIN integration.import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
      WHERE r.source_instance='tradefoto-trade' AND r.source_table='ARTIKEL_FILIALEN' AND r.profile_hash=$1 ORDER BY r.id`, [profileHash])).rows;
    const checked = new Set();
    for (const record of anchors) {
      checkBudget();
      const stock = sourceReplayPlan.stockPublications.find(s => s.scopeId === record.scope_id && s.sourceInstance === record.source_instance && s.profileHash === record.profile_hash);
      if (!stock || !existing.has('integration.import_history_snapshots') || !existing.has('integration.import_history_snapshot_members')) fail('PG_DEPLOY_ACCESS_STOCK_ANCHOR');
      const planned = covered.get(stock.originalRunId + ':' + stock.profileHash);
      if (!planned || planned.table.deferred) fail('PG_DEPLOY_ACCESS_STOCK_ANCHOR');
      const header = ['history-snapshot', stock.originalRunId, stock.scopeId, stock.sourceInstance, stock.profileHash, stock.fileSha256, stock.snapshotAt, stock.ownerId, stock.expectedRows];
      if (!checked.has(stock.originalRunId)) {
        const actual = (await sales.query("SELECT run_id,scope_id,source_instance,profile_hash,file_sha256,snapshot_at,owner_id,expected_rows,status,payload FROM integration.import_history_snapshots WHERE scope_id=$1 AND source_instance=$2 AND profile_hash=$3 AND status='published' ORDER BY snapshot_at DESC,run_id DESC LIMIT 1", [stock.scopeId, stock.sourceInstance, stock.profileHash])).rows[0];
        if (!actual || actual.run_id !== stock.originalRunId || actual.status !== 'published' || actual.scope_id !== stock.scopeId || actual.source_instance !== stock.sourceInstance
          || actual.profile_hash !== stock.profileHash || actual.file_sha256 !== stock.fileSha256 || actual.snapshot_at !== stock.snapshotAt
          || actual.owner_id !== stock.ownerId || safe(actual.expected_rows) !== stock.expectedRows
          || !C.equal(protection.open(actual.payload, [...header, 'published']), { version: 1 })) fail('PG_DEPLOY_ACCESS_STOCK_ANCHOR');
        checked.add(stock.originalRunId);
      }
      const members = (await sales.query('SELECT row_number,revision,payload FROM integration.import_history_snapshot_members WHERE run_id=$1 AND record_id=$2', [stock.originalRunId, record.id])).rows;
      const member = members[0], revision = safe(record.revision);
      if (members.length !== 1 || safe(member.revision) !== revision || safe(member.row_number) < 1 || safe(member.row_number) > stock.expectedRows
        || planned.table.exceptionRanges.some(range => member.row_number >= range.first && member.row_number <= range.last)) fail('PG_DEPLOY_ACCESS_STOCK_ANCHOR');
      const version = protection.open(record.payload, ['history-version', record.scope_id, record.source_instance, record.source, record.source_table, record.id, record.identity_hash, record.profile_hash,
        revision, record.file_sha256, record.snapshot_at, record.imported_by, record.imported_at, record.run_id, record.master_source_instance, record.business_date, record.parent_id, record.parent_revision]);
      C.sha(version.dataHash);
      if (!C.equal(protection.open(member.payload, [...header, 'building', 'member', safe(member.row_number), record.id, revision]), { dataHash: version.dataHash })) fail('PG_DEPLOY_ACCESS_STOCK_ANCHOR');
    }
  }
  if (existing.has('integration.import_history_records') && existing.has('integration.import_history_versions')) {
    const facts = (await sales.query(`SELECT DISTINCT r.scope_id,r.source_instance,r.source_table,r.profile_hash,v.run_id,v.file_sha256,v.imported_by AS owner_id
      FROM integration.import_history_records r JOIN integration.import_history_versions v ON v.record_id=r.id AND v.revision=r.revision
      JOIN ${graph.tables.registry} p ON NOT p.master AND p.profile_hash=r.profile_hash AND p.source_instance=r.source_instance AND p.source_table=r.source_table
      WHERE NOT EXISTS(SELECT 1 FROM ${graph.tables.history} k WHERE k.id=r.id)`)).rows;
    for (const fact of facts) { checkBudget(); verify(fact); }
  }
  if (existing.has('trade.import_master_records')) {
    if (!existing.has('integration.data_import_links') || !existing.has('integration.data_import_runs')) {
      if ((await sales.query(`SELECT EXISTS(SELECT 1 FROM trade.import_master_records r WHERE NOT EXISTS(SELECT 1 FROM ${graph.tables.master} k WHERE k.id=r.id)) AS missing`)).rows[0]?.missing !== false) fail('PG_DEPLOY_ACCESS_SOURCE_COVERAGE');
    } else {
      const facts = (await sales.query(`SELECT DISTINCT r.scope_id,r.source_instance,r.source_table,r.profile_hash,l.last_run_id AS run_id,u.owner_id,u.manifest
      FROM trade.import_master_records r JOIN ${graph.tables.registry} p ON p.master AND p.profile_hash=r.profile_hash AND p.source_instance=r.source_instance AND p.source_table=r.source_table
      LEFT JOIN integration.data_import_links l ON l.target_id=r.id AND l.entity=p.entity LEFT JOIN integration.data_import_runs u ON u.id=l.last_run_id
      WHERE NOT EXISTS(SELECT 1 FROM ${graph.tables.master} k WHERE k.id=r.id)`)).rows;
      for (const fact of facts) {
        checkBudget(); let manifest;
        try { manifest = typeof fact.manifest === 'string' ? JSON.parse(fact.manifest) : fact.manifest; } catch { fail('PG_DEPLOY_ACCESS_SOURCE_COVERAGE'); }
        verify({ ...fact, file_sha256: manifest?.fileSha256 });
      }
    }
  }
  if (existing.has('trade.sales_article_revisions') && existing.has('trade.sales_article_price_snapshots') && existing.has('trade.sales_articles')) {
    const plannedTrade = new Set(sourceReplayPlan.sources.filter(s => s.kind === 'trade' && s.strategy === 'normal-import' && s.tables.some(t => t.name === 'ARTIKEL_STAMM')).map(s => s.fileSha256));
    const facts = (await sales.query(`SELECT DISTINCT s.source_file_sha256 FROM trade.sales_articles a JOIN trade.sales_article_revisions r ON r.product_id=a.product_id AND r.revision=a.current_revision
      JOIN trade.sales_article_import_snapshots s ON s.id=r.source_snapshot_id WHERE s.source_system='${SOURCE_SYSTEM}'
      AND EXISTS(SELECT 1 FROM trade.sales_article_price_snapshots p WHERE p.product_id=r.product_id AND p.source_snapshot_id=r.source_snapshot_id)`)).rows;
    for (const fact of facts) { checkBudget(); if (!plannedTrade.has(fact.source_file_sha256)) fail('PG_DEPLOY_ACCESS_SOURCE_COVERAGE'); }
  }
}
async function exportOwnedState({ core, sales, protection, directory, archiveProof, sourceReplayPlan, basis, checkBudget = () => {} } = {}) {
  if (!core || typeof core.query !== 'function' || !sales || typeof sales.query !== 'function' || !protection || ['seal', 'open', 'digest'].some(m => typeof protection[m] !== 'function')) fail('PG_ACCESS_OWNED_CONFIGURATION');
  if (basis !== undefined && basis !== FRESH_BASIS) fail('PG_ACCESS_OWNED_BASIS');
  const fresh = basis === FRESH_BASIS;
  if (!fresh) appliedImportSourceArchiveEntries(archiveProof);
  const target = await privateFile(directory), fields = new Map(), existing = new Set();
  for (const spec of SPECS) { checkBudget(); const cols = await columns(sales, spec); if (cols.length) { fields.set(key(spec), cols); existing.add(key(spec)); } }
  // Other small normal-dump tables participate in root selection too.
  for (const name of ['integration.data_import_runs', 'trade.import_master_bindings', 'trade.import_master_events', 'trade.import_master_holds', 'trade.sales_articles']) if ((await sales.query('SELECT to_regclass($1) AS name', [name])).rows[0]?.name) existing.add(name);
  const graph = await selectGraph({ core, sales, protection, archiveProof, existing, basis, checkBudget });
  let file;
  const plan = { format: fresh ? FRESH_FORMAT : FORMAT, ...(fresh ? { basis: FRESH_BASIS } : { archiveGenerationSha256: archiveProof.generationSha256 }), file: FILE, bytes: 0, sha256: '', rows: 0, tables: [], stats: graph.stats };
  try {
    const selected = SPECS.filter(spec => fields.has(key(spec)));
    if (!fresh) await assertCurrentCoverage(sales, existing, graph, sourceReplayPlan, archiveProof, protection, checkBudget);
    const constraints = await foreignKeys(sales);
    const empty = await emptySelections(sales, selected, graph.tables, fields, constraints, existing);
    // Autovacuum cannot analyze this session's temporary anchor table. Give
    // the planner its real cardinality before checking and copying history.
    const historySegments = 'integration.import_history_segments';
    if (existing.has(historySegments) && !empty.has(historySegments)) await sales.query(`ANALYZE ${graph.tables.history}`);
    await assertForeignKeys(sales, selected, graph.tables, empty, constraints);
    file = await fsp.open(target, 'wx', 0o600); const digest = crypto.createHash('sha256');
    for (const spec of selected) {
      const cols = fields.get(key(spec)), content = crypto.createHash('sha256'), table = { schema: spec.schema, table: spec.table, columns: cols,
        schemaSha256: hash(canonical({ schema: spec.schema, table: spec.table, columns: cols })), rows: 0, contentSha256: '' };
      let after = null;
      for (; !empty.has(key(spec));) {
        checkBudget(); const args = after ? [...after, BATCH] : [BATCH];
        const cursor = after ? `AND (${spec.key.map(k => 't.' + q(k)).join(',')})>(${spec.key.map((_, i) => '$' + (i + 1)).join(',')})` : '';
        const rows = (await sales.query(`SELECT t.* FROM ${rel(spec)} t WHERE (${predicate(spec, 't', graph.tables)}) ${cursor} ORDER BY ${spec.key.map(k => 't.' + q(k)).join(',')} LIMIT $${args.length}`, args)).rows;
        if (!rows.length) break; if (rows.length > BATCH) fail('PG_ACCESS_OWNED_BATCH');
        for (const row of rows) {
          const record = { table: spec.table, row }, encoded = canonical(record), line = encode(record, protection, plan, plan.rows);
          await file.writeFile(line); digest.update(line); content.update(encoded + '\n'); table.rows++; plan.rows++; plan.bytes += Buffer.byteLength(line);
        }
        after = spec.key.map(k => rows.at(-1)[k]); if (after.some(v => v === null || v === undefined)) fail('PG_ACCESS_OWNED_KEY'); if (rows.length < BATCH) break;
      }
      table.contentSha256 = content.digest('hex'); plan.tables.push(table);
    }
    await file.sync(); plan.sha256 = digest.digest('hex');
    return validateOwnedPlan({ ...plan, planSha256: hash(canonical(plan)) });
  } catch (error) { if (file) { await file.close().catch(() => {}); await fsp.unlink(target).catch(() => {}); } throw error; }
  finally {
    await file?.close().catch(() => {});
    await sales.query('ROLLBACK TO SAVEPOINT ' + q(graph.savepoint)).catch(() => {});
    await sales.query('RELEASE SAVEPOINT ' + q(graph.savepoint)).catch(() => {});
  }
}
async function assertIsolation(sales, isolatedRecovery) {
  const p = sales?.connectionParameters;
  if (isolatedRecovery !== true || !/^\/tmp\/gp-pg-recovery-[A-Za-z0-9]+$/.test(p?.host || '') || Number(p.port) !== 55484) fail('PG_ACCESS_OWNED_ISOLATION_REQUIRED');
  const row = (await sales.query("SELECT current_setting('unix_socket_directories') AS socket,current_setting('port') AS port,current_setting('listen_addresses') AS listen")).rows[0];
  if (row?.socket !== p.host || row.port !== '55484' || !['', '127.0.0.1'].includes(row.listen)) fail('PG_ACCESS_OWNED_ISOLATION_REQUIRED');
}
async function restoreOwnedState({ sales, protection, plan, directory, isolatedRecovery = false, checkBudget = () => {} } = {}) {
  validateOwnedPlan(plan); await assertIsolation(sales, isolatedRecovery);
  const target = await privateFile(directory), stat = await fsp.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await fsp.realpath(target) !== target || stat.size !== plan.bytes || process.platform !== 'win32' && (stat.uid !== process.getuid() || stat.mode & 0o077)) fail('PG_ACCESS_OWNED_FILE');
  const digest = crypto.createHash('sha256'); for await (const bytes of fs.createReadStream(target, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) })) digest.update(bytes); if (digest.digest('hex') !== plan.sha256) fail('PG_ACCESS_OWNED_FILE_HASH');
  const counters = plan.tables.map(() => 0), hashes = plan.tables.map(() => crypto.createHash('sha256')); let index = 0;
  const validate = (record, count = true) => {
    exact(record, ['table', 'row']); while (index < plan.tables.length && plan.tables[index].table !== record.table) index++;
    if (index === plan.tables.length || !C.plain(record.row) || !C.equal(Object.keys(record.row).sort(), plan.tables[index].columns.map(c => c.name).sort())) fail('PG_ACCESS_OWNED_ROW');
    const spec = SPECS.find(s => s.table === record.table); if (spec.key.some(k => record.row[k] === null || record.row[k] === undefined)) fail('PG_ACCESS_OWNED_KEY');
    if (count) { counters[index]++; hashes[index].update(canonical(record) + '\n'); } return index;
  };
  await eachRow(target, protection, plan, record => { checkBudget(); validate(record); });
  for (let i = 0; i < plan.tables.length; i++) {
    const table = plan.tables[i];
    if (counters[i] !== table.rows || hashes[i].digest('hex') !== table.contentSha256) fail('PG_ACCESS_OWNED_CONTENT');
    if (!C.equal(await columns(sales, table), table.columns)) fail('PG_ACCESS_OWNED_SCHEMA');
    if (safe((await sales.query('SELECT count(*)::text AS n FROM ' + rel(table))).rows[0]?.n) !== 0) fail('PG_ACCESS_OWNED_TARGET_NOT_EMPTY');
  }
  if (plan.tables.length) {
    const triggers = (await sales.query(`SELECT count(*)::text AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND t.tgenabled<>'D' AND (n.nspname,c.relname) IN (${plan.tables.map(t => "('" + t.schema + "','" + t.table + "')").join(',')})`)).rows[0];
    if (safe(triggers?.n) !== 0) fail('PG_ACCESS_OWNED_REQUIRES_PRE_DATA');
  }
  await sales.query('BEGIN');
  try {
    index = 0; const totals = plan.tables.map(() => 0), checks = plan.tables.map(() => crypto.createHash('sha256')); let batch = [], batchBytes = 0, current = 0;
    const flush = async () => {
      if (!batch.length) return; const table = plan.tables[current], names = table.columns.map(c => q(c.name)).join(',');
      const result = await sales.query(`INSERT INTO ${rel(table)} (${names}) OVERRIDING SYSTEM VALUE SELECT ${names} FROM jsonb_populate_recordset(NULL::${rel(table)},$1::jsonb)`, [JSON.stringify(batch)]);
      if (result.rowCount !== batch.length) fail('PG_ACCESS_OWNED_INSERT'); batch = []; batchBytes = 0;
    };
    await eachRow(target, protection, plan, async record => {
      checkBudget(); const i = validate(record, false); if (i !== current) { await flush(); current = i; }
      totals[i]++; checks[i].update(canonical(record) + '\n');
      const size = Buffer.byteLength(JSON.stringify(record.row)); if (batch.length && (batch.length >= BATCH || batchBytes + size > 4 * 1024 * 1024)) await flush();
      batch.push(record.row); batchBytes += size;
    });
    await flush();
    for (let i = 0; i < plan.tables.length; i++) if (totals[i] !== plan.tables[i].rows || checks[i].digest('hex') !== plan.tables[i].contentSha256) fail('PG_ACCESS_OWNED_CONTENT');
    await sales.query('COMMIT');
    return { format: plan.format, ...(plan.format === FRESH_FORMAT ? { basis: FRESH_BASIS, requiresFreshAccess: true } : {}), verified: true, rehydrated: false, rows: plan.rows, tables: plan.tables.map(({ schema, table, rows }) => ({ schema, table, rows })), requiresAccessRehydration: true, requiresImportRehydration: true };
  } catch (error) { await sales.query('ROLLBACK'); throw error; }
}
module.exports = { FORMAT, FRESH_FORMAT, FRESH_BASIS, FILE, PROJECTED_TABLES, validateOwnedPlan, classifyRun, exportOwnedState, restoreOwnedState };

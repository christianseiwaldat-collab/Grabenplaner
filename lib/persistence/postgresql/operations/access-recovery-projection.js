'use strict';
// An encrypted, row-preserving companion to pg_dump. Only complete values
// authenticated against an archived Access source become recipes. SQL keys,
// GP decisions, unknown values and opaque previous-link evidence stay literal.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const C = require('../../../data-import-contract');
const { SOURCE_KINDS } = require('../../../data-import-source-catalog');
const { definitions } = require('../../../tradefoto-full-import-source');
const H = require('../../../tradefoto-history-profiles');
const FORMAT = 'grabenplaner-access-recovery-projection-v1';
const FILE = 'access-projection.rows';
const BATCH = 100, MAX_LINE = 32 * 1024 * 1024;
const PREFIX = 'gp-import-evidence-parts-v1:';
const SOURCE_SYSTEM = 'tradefoto.artikel_stamm';
const SPECS = Object.freeze([
  { schema: 'trade', table: 'import_master_segments', key: ['record_id', 'kind', 'data_class'], join: 'LEFT JOIN trade.import_master_records r ON r.id=t.record_id', extra: ',row_to_json(r) AS __record', kind: 'master' },
  { schema: 'integration', table: 'import_history_segments', key: ['record_id', 'revision', 'data_class'], join: 'LEFT JOIN integration.import_history_records r ON r.id=t.record_id LEFT JOIN integration.import_history_versions v ON v.record_id=t.record_id AND v.revision=t.revision', extra: ',row_to_json(r) AS __record,row_to_json(v) AS __version', kind: 'history' },
  { schema: 'integration', table: 'data_import_payload_blocks', key: ['id'], kind: 'block', extra: `,EXISTS(SELECT 1 FROM integration.data_import_row_payload_refs rr WHERE rr.block_id=t.id AND rr.slot IN ('record.source','record.data')) AS __source_required` },
  { schema: 'integration', table: 'data_import_rows', key: ['run_id', 'row_number'], join: 'LEFT JOIN integration.data_import_runs r ON r.id=t.run_id', extra: ',row_to_json(r) AS __run', kind: 'row' },
  { schema: 'integration', table: 'data_import_changes', key: ['run_id', 'row_number'], join: 'LEFT JOIN integration.data_import_runs r ON r.id=t.run_id', extra: ',row_to_json(r) AS __run', kind: 'change' },
  { schema: 'integration', table: 'data_import_links', key: ['id'], kind: 'link', join: 'LEFT JOIN integration.data_import_runs r ON r.id=t.last_run_id', extra: ',row_to_json(r) AS __run' },
  { schema: 'trade', table: 'sales_article_revisions', key: ['product_id', 'revision'], join: 'LEFT JOIN trade.sales_article_import_snapshots s ON s.id=t.source_snapshot_id', extra: ',row_to_json(s) AS __snapshot', kind: 'article' },
  { schema: 'trade', table: 'sales_article_price_snapshots', key: ['id'], join: 'LEFT JOIN trade.sales_article_import_snapshots s ON s.id=t.source_snapshot_id', extra: ',row_to_json(s) AS __snapshot', kind: 'price' },
]);
const PROJECTED_TABLES = Object.freeze(SPECS.map(({ schema, table }) => Object.freeze({ schema, table })));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => C.canonical(value);
const exact = (value, keys) => { if (!C.plain(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail('PG_ACCESS_PROJECTION_SHAPE'); };
const q = value => '"' + value.replace(/"/g, '""') + '"';
const relation = spec => q(spec.schema) + '.' + q(spec.table);
const clone = value => JSON.parse(canonical(value));
const safe = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) fail('PG_ACCESS_PROJECTION_INTEGER'); return n; };
const componentContext = (plan, ordinal) => [FORMAT, plan.archiveGenerationSha256, plan.dictionarySha256, ordinal];
const zeroStats = () => ({ omittedValues: 0, omittedByKind: Object.fromEntries(SOURCE_KINDS.map(kind => [kind, 0])) });
let accessProfiles;
function knownAccess(profileHash, sourceInstance) {
  if (!accessProfiles) {
    accessProfiles = new Map();
    for (const kind of SOURCE_KINDS) for (const definition of definitions(kind)) {
      const profiles = definition.master ? [definition.profile] : H.profilesFor(definition.source, definition.name);
      for (const profile of profiles) accessProfiles.set('tradefoto-' + kind + ':' + profile.fingerprint, true);
    }
  }
  return accessProfiles.has(sourceInstance + ':' + profileHash);
}
function knownRun(run) {
  let manifest = run?.manifest;
  if (typeof manifest === 'string') { try { manifest = JSON.parse(manifest); } catch { return false; } }
  return manifest && knownAccess(run.profile_hash, manifest.sourceInstance);
}
function referenceCheck(reference) {
  exact(reference, ['kind', 'sourceId', 'fileSha256', 'bytes', 'table', 'ordinal', 'profileHash', 'transform', 'expectedSha256']);
  if (!SOURCE_KINDS.includes(reference.kind) || typeof reference.table !== 'string' || !reference.table.length || reference.table.length > 120
    || typeof reference.transform !== 'string' || !reference.transform.length || reference.transform.length > 160) fail('PG_ACCESS_PROJECTION_REFERENCE');
  for (const field of ['sourceId', 'fileSha256', 'profileHash', 'expectedSha256']) C.sha(reference[field]);
  C.integer(reference.bytes, 4096, 512 * 1024 * 1024); C.integer(reference.ordinal, 1, C.LIMITS.rows);
  return reference;
}
function validateProjectionPlan(plan) {
  exact(plan, ['format', 'archiveGenerationSha256', 'dictionarySha256', 'file', 'bytes', 'sha256', 'rows', 'tables', 'stats', 'planSha256']);
  if (plan.format !== FORMAT || plan.file !== FILE || !Array.isArray(plan.tables) || plan.tables.length > SPECS.length) fail('PG_ACCESS_PROJECTION_PLAN');
  for (const field of ['archiveGenerationSha256', 'dictionarySha256', 'sha256', 'planSha256']) C.sha(plan[field]);
  C.integer(plan.bytes, 0, Number.MAX_SAFE_INTEGER); C.integer(plan.rows, 0, Number.MAX_SAFE_INTEGER);
  exact(plan.stats, ['omittedValues', 'omittedByKind']); exact(plan.stats.omittedByKind, SOURCE_KINDS);
  C.integer(plan.stats.omittedValues, 0, Number.MAX_SAFE_INTEGER);
  for (const n of Object.values(plan.stats.omittedByKind)) C.integer(n, 0, Number.MAX_SAFE_INTEGER);
  if (Object.values(plan.stats.omittedByKind).reduce((a, b) => a + b, 0) !== plan.stats.omittedValues) fail('PG_ACCESS_PROJECTION_STATS');
  let rows = 0, previous = -1;
  plan.tables.forEach(table => {
    exact(table, ['schema', 'table', 'columns', 'schemaSha256', 'rows', 'contentSha256']);
    const index = SPECS.findIndex(spec => spec.schema === table.schema && spec.table === table.table), spec = SPECS[index];
    if (index <= previous || !spec || !Array.isArray(table.columns) || !table.columns.length || table.columns.length > 200) fail('PG_ACCESS_PROJECTION_TABLE');
    previous = index;
    const names = new Set();
    for (const column of table.columns) {
      exact(column, ['name', 'type', 'notNull', 'identity', 'generated']);
      if (!/^[a-z][a-z0-9_]*$/.test(column.name) || names.has(column.name) || typeof column.type !== 'string' || !column.type.length || column.type.length > 200
        || typeof column.notNull !== 'boolean' || !['', 'a', 'd'].includes(column.identity) || column.generated !== '') fail('PG_ACCESS_PROJECTION_COLUMN');
      names.add(column.name);
    }
    if (spec.key.some(key => !names.has(key))) fail('PG_ACCESS_PROJECTION_KEY');
    C.sha(table.schemaSha256); C.sha(table.contentSha256); C.integer(table.rows, 0, Number.MAX_SAFE_INTEGER); rows += table.rows;
    if (table.schemaSha256 !== hash(canonical({ schema: table.schema, table: table.table, columns: table.columns }))) fail('PG_ACCESS_PROJECTION_SCHEMA');
  });
  if (rows !== plan.rows) fail('PG_ACCESS_PROJECTION_COUNT');
  const { planSha256, ...content } = plan;
  if (planSha256 !== hash(canonical(content))) fail('PG_ACCESS_PROJECTION_HASH');
  return plan;
}
async function columns(sales, spec) {
  return (await sales.query(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS "notNull",a.attidentity AS identity,a.attgenerated AS generated
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [spec.schema, spec.table])).rows;
}
function masterContext(record, row) {
  if (!record) fail('PG_ACCESS_PROJECTION_PARENT');
  return ['master-segment', record.scope_id, record.source_instance, record.source_table, record.identity_hash, record.id, record.profile_hash, safe(record.revision), row.kind, row.data_class];
}
function historyContext(record, version, row) {
  if (!record || !version) fail('PG_ACCESS_PROJECTION_PARENT');
  return ['history-version', record.scope_id, record.source_instance, record.source, record.source_table, record.id, record.identity_hash, record.profile_hash,
    safe(version.revision), version.file_sha256, version.snapshot_at, version.imported_by, version.imported_at, version.run_id, version.master_source_instance,
    version.business_date, version.parent_id, version.parent_revision === null ? null : safe(version.parent_revision), 'segment', row.data_class];
}
function blockNamespace(row) {
  return { scopeId: row.scope_id, ownerId: row.owner_id, profileHash: row.profile_hash, sourceSystem: row.source_system,
    sourceInstance: row.source_instance, sourceTable: row.source_table, entity: row.entity };
}
const blockContext = row => ['gp-import-evidence-block-v1', blockNamespace(row), row.block_type, row.id];
function put(value, fields, replacement) {
  if (!fields.length) return replacement;
  let parent = value;
  for (const field of fields.slice(0, -1)) { if (!C.plain(parent) || !Object.hasOwn(parent, field)) fail('PG_ACCESS_PROJECTION_PATH'); parent = parent[field]; }
  if (!C.plain(parent)) fail('PG_ACCESS_PROJECTION_PATH');
  parent[fields.at(-1)] = replacement; return value;
}
function at(value, fields) {
  for (const field of fields) { if (!C.plain(value) || !Object.hasOwn(value, field)) return undefined; value = value[field]; }
  return value;
}
function envelope(row, value, context, prefix, dictionary, stats, slots, kind = 'seal', required = []) {
  const substitutions = [];
  let skeleton = clone(value);
  for (const fields of slots) {
    const candidate = at(skeleton, fields);
    const mustReplace = required.some(path => C.equal(path, fields));
    if (candidate === undefined) continue;
    if (!C.plain(candidate)) { if (mustReplace) fail('PG_DEPLOY_ACCESS_SOURCE_COVERAGE'); continue; }
    const reference = dictionary.reference(candidate);
    if (!reference) { if (mustReplace) fail('PG_DEPLOY_ACCESS_SOURCE_COVERAGE'); continue; }
    referenceCheck(reference);
    substitutions.push({ path: fields, reference }); skeleton = put(skeleton, fields, null);
    stats.omittedValues++; stats.omittedByKind[reference.kind]++;
  }
  if (!substitutions.length) return null;
  delete row.payload;
  return { kind, context, prefix, skeleton, substitutions, valueSha256: hash(canonical(value)) };
}
function projectRow(spec, source, protection, dictionary, stats) {
  const { __record, __version, __run, __snapshot, __source_required, ...row } = source;
  let application = null, values = null;
  if (['master', 'history', 'block', 'row', 'change', 'link'].includes(spec.kind)) {
    let context, prefix = '', method = 'open', slots = [[]], required = [];
    if (spec.kind === 'master') { context = masterContext(__record, row); required = [[]]; }
    else if (spec.kind === 'history') { context = historyContext(__record, __version, row); required = [[]]; }
    else if (spec.kind === 'block') {
      context = blockContext(row); method = 'openBlock'; if (row.block_type !== 'object') return { row, application, values };
      if (__source_required === true && knownAccess(row.profile_hash, row.source_instance)) required = [[]];
    }
    else if (spec.kind === 'link') { context = ['link', row.id]; slots = [['record', 'source'], ['record', 'data']]; if (knownRun(__run)) required = slots; }
    else {
      if (!__run) fail('PG_ACCESS_PROJECTION_PARENT');
      context = [spec.kind, __run.scope_id, row.run_id, safe(row.row_number)];
      if (row.payload.startsWith(PREFIX)) prefix = PREFIX;
      slots = ['record.source', 'record.data', 'invalidSource', 'beforeTarget.data', 'afterTarget.data', 'patch'].map(slot => [...(prefix ? ['value'] : []), ...slot.split('.')]);
      if (spec.kind === 'row' && knownRun(__run)) required = slots.slice(0, 3);
    }
    if (typeof protection[method] !== 'function' || typeof row.payload !== 'string') fail('PG_ACCESS_PROJECTION_CRYPTO');
    const value = protection[method](row.payload.slice(prefix.length), context);
    // Authenticate shared block identity and its separately indexed nonce.
    if (spec.kind === 'block') {
      if (protection.digest(['gp-import-evidence-block-v1', blockNamespace(row), row.block_type, value]) !== row.id) fail('PG_ACCESS_PROJECTION_BLOCK');
      const fields = row.payload.split(':');
      if (fields.length !== 5 || fields[1] !== row.key_id || fields[2] !== row.nonce) fail('PG_ACCESS_PROJECTION_BLOCK');
    }
    application = envelope(row, value, context, prefix, dictionary, stats, slots, method === 'openBlock' ? 'sealBlock' : 'seal', required);
  } else if (__snapshot?.source_system === SOURCE_SYSTEM) {
    const value = spec.kind === 'article'
      ? { description: row.description, active: Boolean(Number(row.active)), sourceUpdatedAt: row.source_updated_at }
      : { amount: row.amount, currency: row.currency, priceBasis: row.price_basis, qualityStatus: row.quality_status, sourceField: row.source_field };
    const reference = dictionary.reference(value);
    if (!reference) fail('PG_DEPLOY_ACCESS_SOURCE_COVERAGE');
    if (reference) {
      referenceCheck(reference);
      // Basis/source_field participate in a UNIQUE constraint. Keep those
      // identity fields literal, and bind the removed cell to the full tuple.
      const fields = spec.kind === 'article' ? { description: 'description' } : { amount: 'amount' };
      for (const column of Object.values(fields)) delete row[column];
      values = { fields, reference, valueSha256: hash(canonical(value)) };
      stats.omittedValues++; stats.omittedByKind[reference.kind]++;
    }
  }
  return { row, application, values };
}
function encodeRecord(record, protection, plan, ordinal) {
  const bytes = Buffer.from(canonical(record)), size = C.LIMITS.rowBytes;
  if (bytes.length > MAX_LINE) { bytes.fill(0); fail('PG_ACCESS_PROJECTION_ROW_SIZE'); }
  try {
    const total = Math.max(1, Math.ceil(bytes.length / size)), parts = [];
    for (let i = 0; i < total; i++) parts.push(protection.seal({ part: bytes.subarray(i * size, (i + 1) * size).toString('base64') }, [...componentContext(plan, ordinal), i, total]));
    return JSON.stringify({ format: FORMAT, parts }) + '\n';
  } finally { bytes.fill(0); }
}
function decodeRecord(line, protection, plan, ordinal) {
  let outer;
  try { outer = JSON.parse(line); } catch { fail('PG_ACCESS_PROJECTION_LINE'); }
  exact(outer, ['format', 'parts']);
  if (outer.format !== FORMAT || !Array.isArray(outer.parts) || !outer.parts.length || outer.parts.length > Math.ceil(MAX_LINE / C.LIMITS.rowBytes)) fail('PG_ACCESS_PROJECTION_LINE');
  const chunks = []; let bytes;
  try {
    for (let i = 0; i < outer.parts.length; i++) {
      const part = protection.open(outer.parts[i], [...componentContext(plan, ordinal), i, outer.parts.length]); exact(part, ['part']);
      if (typeof part.part !== 'string') fail('PG_ACCESS_PROJECTION_LINE');
      const chunk = Buffer.from(part.part, 'base64'); chunks.push(chunk);
      if (chunk.toString('base64') !== part.part || chunk.length > C.LIMITS.rowBytes || i + 1 < outer.parts.length && chunk.length !== C.LIMITS.rowBytes) fail('PG_ACCESS_PROJECTION_LINE');
    }
    bytes = Buffer.concat(chunks);
    try { return JSON.parse(bytes.toString('utf8')); } catch { fail('PG_ACCESS_PROJECTION_LINE'); }
  } finally { bytes?.fill(0); for (const chunk of chunks) chunk.fill(0); }
}
async function privateDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('PG_ACCESS_PROJECTION_DIRECTORY');
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077))) fail('PG_ACCESS_PROJECTION_DIRECTORY');
  return path.join(directory, FILE);
}
async function exportProjection({ sales, protection, dictionary, directory, checkBudget = () => {} } = {}) {
  if (!sales || typeof sales.query !== 'function' || !protection || ['seal', 'open', 'digest'].some(m => typeof protection[m] !== 'function') || !dictionary || typeof dictionary.reference !== 'function') fail('PG_ACCESS_PROJECTION_CONFIGURATION');
  C.sha(dictionary.archiveGenerationSha256); C.sha(dictionary.dictionarySha256);
  const target = await privateDirectory(directory), file = await fsp.open(target, 'wx', 0o600), digest = crypto.createHash('sha256');
  const plan = { format: FORMAT, archiveGenerationSha256: dictionary.archiveGenerationSha256, dictionarySha256: dictionary.dictionarySha256, file: FILE, bytes: 0, sha256: '', rows: 0, tables: [], stats: zeroStats() };
  try {
    for (const spec of SPECS) {
      checkBudget();
      const fields = await columns(sales, spec), content = crypto.createHash('sha256');
      // Qualification can intentionally use an earlier, smaller Sales stage.
      // The bundle contract separately requires the exact inspected table set.
      if (!fields.length) continue;
      const table = { schema: spec.schema, table: spec.table, columns: fields, schemaSha256: hash(canonical({ schema: spec.schema, table: spec.table, columns: fields })), rows: 0, contentSha256: '' };
      let after = null;
      for (;;) {
        checkBudget();
        const args = after ? [...after, BATCH] : [BATCH];
        const predicate = after ? `WHERE (${spec.key.map(k => 't.' + q(k)).join(',')}) > (${spec.key.map((_, i) => '$' + (i + 1)).join(',')})` : '';
        const rows = (await sales.query(`SELECT t.*${spec.extra || ''} FROM ${relation(spec)} t ${spec.join || ''} ${predicate} ORDER BY ${spec.key.map(k => 't.' + q(k)).join(',')} LIMIT $${args.length}`, args)).rows;
        if (!rows.length) break;
        if (rows.length > BATCH) fail('PG_ACCESS_PROJECTION_BATCH');
        for (const source of rows) {
          const record = { table: spec.table, ...projectRow(spec, source, protection, dictionary, plan.stats) };
          const encoded = canonical(record);
          if (Buffer.byteLength(encoded) > MAX_LINE) fail('PG_ACCESS_PROJECTION_ROW_SIZE');
          const line = encodeRecord(record, protection, plan, plan.rows);
          await file.writeFile(line); digest.update(line); content.update(encoded + '\n'); plan.bytes += Buffer.byteLength(line); table.rows++; plan.rows++;
        }
        after = spec.key.map(key => rows.at(-1)[key]);
        if (after.some(value => value === null || value === undefined)) fail('PG_ACCESS_PROJECTION_KEY');
        if (rows.length < BATCH) break;
      }
      table.contentSha256 = content.digest('hex'); plan.tables.push(table);
    }
    await file.sync(); plan.sha256 = digest.digest('hex');
    return validateProjectionPlan({ ...plan, planSha256: hash(canonical(plan)) });
  } catch (error) { await file.close(); await fsp.unlink(target).catch(() => {}); throw error; }
  finally { await file.close().catch(() => {}); }
}
async function eachRecord(target, protection, plan, work) {
  const input = fs.createReadStream(target), lines = readline.createInterface({ input, crlfDelay: Infinity });
  let ordinal = 0;
  try {
    for await (const line of lines) {
      if (!line || Buffer.byteLength(line) > MAX_LINE * 2) fail('PG_ACCESS_PROJECTION_LINE');
      const record = decodeRecord(line, protection, plan, ordinal);
      await work(record, ordinal++);
    }
  } finally { lines.close(); input.destroy(); }
  if (ordinal !== plan.rows) fail('PG_ACCESS_PROJECTION_COUNT');
}
function references(record) {
  return [...(record.application?.substitutions || []).map(item => item.reference), ...(record.values ? [record.values.reference] : [])];
}
function validateRecord(record, spec, table) {
  exact(record, ['table', 'row', 'application', 'values']);
  if (record.table !== spec.table || !C.plain(record.row)) fail('PG_ACCESS_PROJECTION_RECORD');
  let removed = [];
  if (record.application !== null) {
    const application = record.application;
    exact(application, ['kind', 'context', 'prefix', 'skeleton', 'substitutions', 'valueSha256']);
    if (!['seal', 'sealBlock'].includes(application.kind) || !Array.isArray(application.context) || !application.context.length || !['', PREFIX].includes(application.prefix)
      || !Array.isArray(application.substitutions) || !application.substitutions.length || application.substitutions.length > 6) fail('PG_ACCESS_PROJECTION_APPLICATION');
    C.sha(application.valueSha256); removed = ['payload'];
    const paths = new Set();
    for (const item of application.substitutions) {
      exact(item, ['path', 'reference']); referenceCheck(item.reference);
      if (!Array.isArray(item.path) || item.path.length > 4 || item.path.some(p => !['value', 'record', 'source', 'data', 'invalidSource', 'beforeTarget', 'afterTarget', 'patch'].includes(p))
        || paths.has(canonical(item.path)) || at(application.skeleton, item.path) !== null) fail('PG_ACCESS_PROJECTION_PATH');
      paths.add(canonical(item.path));
    }
  }
  if (record.values !== null) {
    exact(record.values, ['fields', 'reference', 'valueSha256']); referenceCheck(record.values.reference); C.sha(record.values.valueSha256);
    const expected = spec.kind === 'article' ? { description: 'description' } : spec.kind === 'price' ? { amount: 'amount' } : null;
    if (!expected || !C.equal(record.values.fields, expected) || record.application !== null) fail('PG_ACCESS_PROJECTION_VALUES');
    removed = Object.values(expected);
  }
  const expected = table.columns.map(c => c.name).filter(c => !removed.includes(c)).sort();
  if (!C.equal(Object.keys(record.row).sort(), expected) || spec.key.some(key => record.row[key] === null)) fail('PG_ACCESS_PROJECTION_COLUMNS');
}
async function assertSocket(sales, isolatedRecovery) {
  const parameters = sales?.connectionParameters;
  if (isolatedRecovery !== true || !/^\/tmp\/gp-pg-recovery-[A-Za-z0-9]+$/.test(parameters?.host || '') || Number(parameters.port) !== 55484) fail('PG_ACCESS_PROJECTION_ISOLATION_REQUIRED');
  const identity = (await sales.query("SELECT current_setting('unix_socket_directories') AS socket,current_setting('port') AS port,current_setting('listen_addresses') AS listen")).rows[0];
  if (identity?.socket !== parameters.host || identity.port !== '55484' || !['', '127.0.0.1'].includes(identity.listen)) fail('PG_ACCESS_PROJECTION_ISOLATION_REQUIRED');
}
async function assertRestore(sales, isolatedRecovery) {
  await assertSocket(sales, isolatedRecovery);
  const triggers = (await sales.query(`SELECT count(*)::text AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal AND t.tgenabled<>'D' AND (n.nspname,c.relname) IN (${SPECS.map(s => "('" + s.schema + "','" + s.table + "')").join(',')})`)).rows[0];
  if (safe(triggers?.n) !== 0) fail('PG_ACCESS_PROJECTION_REQUIRES_PRE_DATA');
}
function placeholder(reference) { return { format: FORMAT, state: 'source-unavailable', expectedSha256: reference.expectedSha256 }; }
async function restoreProjection({ sales, protection, archive, plan, directory, materializationDirectory = directory, rehydrate = false, sourceDictionary, isolatedRecovery = false, checkBudget = () => {} } = {}) {
  validateProjectionPlan(plan);
  const specs = plan.tables.map(table => SPECS.find(spec => spec.schema === table.schema && spec.table === table.table));
  if (!protection || ['seal', 'open', 'digest'].some(m => typeof protection[m] !== 'function') || typeof rehydrate !== 'boolean') fail('PG_ACCESS_PROJECTION_CONFIGURATION');
  await assertRestore(sales, isolatedRecovery);
  const target = await privateDirectory(directory), stat = await fsp.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== plan.bytes || process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077))) fail('PG_ACCESS_PROJECTION_FILE');
  const digest = crypto.createHash('sha256'); for await (const bytes of fs.createReadStream(target)) digest.update(bytes);
  if (digest.digest('hex') !== plan.sha256) fail('PG_ACCESS_PROJECTION_FILE_HASH');
  if (!archive || typeof archive.verify !== 'function') fail('PG_ACCESS_PROJECTION_ARCHIVE');
  // Fast deploy checks need only the authenticated frozen index. The actual
  // replay reader authenticates source objects when each source is consumed.
  const recipes = require('./access-value-recipes'), proof = await archive.verify({ allowMissing: false, referenceOnly: true });
  if (proof.generationSha256 !== plan.archiveGenerationSha256) fail('PG_ACCESS_PROJECTION_ARCHIVE');
  const validateReference = recipes.createReferenceValidator({ proof });
  const requested = new Map(), counts = specs.map(() => 0), hashes = specs.map(() => crypto.createHash('sha256')), stats = zeroStats();
  let current = 0;
  // Authenticate the entire component before the first INSERT or source read.
  await eachRecord(target, protection, plan, async record => {
    checkBudget(); while (current < specs.length && specs[current].table !== record.table) current++;
    if (current === specs.length) fail('PG_ACCESS_PROJECTION_ORDER');
    validateRecord(record, specs[current], plan.tables[current]); counts[current]++; hashes[current].update(canonical(record) + '\n');
    for (const reference of references(record)) { validateReference(reference); requested.set(recipes.referenceHash(reference), reference); stats.omittedValues++; stats.omittedByKind[reference.kind]++; }
  });
  for (let i = 0; i < specs.length; i++) {
    if (counts[i] !== plan.tables[i].rows || hashes[i].digest('hex') !== plan.tables[i].contentSha256) fail('PG_ACCESS_PROJECTION_CONTENT');
    if (!C.equal(await columns(sales, specs[i]), plan.tables[i].columns)) fail('PG_ACCESS_PROJECTION_SCHEMA');
    if (safe((await sales.query('SELECT count(*)::text AS n FROM ' + relation(specs[i]))).rows[0]?.n) !== 0) fail('PG_ACCESS_PROJECTION_TARGET_NOT_EMPTY');
  }
  if (!C.equal(stats, plan.stats)) fail('PG_ACCESS_PROJECTION_STATS');
  const materialized = new Map(); let spool, spoolPath, spoolBytes = 0;
  try {
    if (rehydrate && requested.size) {
      await privateDirectory(materializationDirectory);
      spoolPath = path.join(materializationDirectory, '.access-projection-' + crypto.randomBytes(16).toString('hex') + '.pending');
      spool = await fsp.open(spoolPath, 'wx+', 0o600);
      const onValue = async (reference, value) => {
        checkBudget();
        const id = recipes.referenceHash(reference);
        if (!requested.has(id) || materialized.has(id) || hash(canonical(value)) !== reference.expectedSha256) fail('PG_ACCESS_PROJECTION_MATERIALIZED');
        const line = JSON.stringify(protection.seal(value, [FORMAT, 'materialized', plan.planSha256, id]));
        if (Buffer.byteLength(line) > MAX_LINE) fail('PG_ACCESS_PROJECTION_ROW_SIZE');
        await spool.writeFile(line); materialized.set(id, { offset: spoolBytes, bytes: Buffer.byteLength(line) }); spoolBytes += Buffer.byteLength(line);
      };
      if (sourceDictionary) {
        if (sourceDictionary.dictionarySha256 !== plan.dictionarySha256 || sourceDictionary.archiveGenerationSha256 !== plan.archiveGenerationSha256 || typeof sourceDictionary.materialize !== 'function') fail('PG_ACCESS_PROJECTION_DICTIONARY');
        for (const reference of requested.values()) await onValue(reference, await sourceDictionary.materialize(reference));
      } else await recipes.materializeReferences({ archive, proof, references: [...requested.values()], onValue, checkBudget });
      if (materialized.size !== requested.size) fail('PG_ACCESS_PROJECTION_SOURCE_MISSING');
    }
    const resolve = async reference => {
      if (!rehydrate) return placeholder(reference);
      const id = recipes.referenceHash(reference), where = materialized.get(id); if (!where) fail('PG_ACCESS_PROJECTION_SOURCE_MISSING');
      const bytes = Buffer.alloc(where.bytes); const read = await spool.read(bytes, 0, bytes.length, where.offset);
      if (read.bytesRead !== bytes.length) fail('PG_ACCESS_PROJECTION_MATERIALIZED');
      const value = protection.open(JSON.parse(bytes.toString('utf8')), [FORMAT, 'materialized', plan.planSha256, id]); bytes.fill(0);
      if (hash(canonical(value)) !== reference.expectedSha256) fail('PG_ACCESS_PROJECTION_MATERIALIZED'); return value;
    };
    await sales.query('BEGIN');
    try {
      let tableIndex = 0, batch = [], batchBytes = 0;
      const insertedCounts = specs.map(() => 0), insertedHashes = specs.map(() => crypto.createHash('sha256'));
      const flush = async () => {
        if (!batch.length) return;
        const spec = specs[tableIndex], names = plan.tables[tableIndex].columns.map(c => q(c.name)).join(',');
        const result = await sales.query(`INSERT INTO ${relation(spec)} (${names}) OVERRIDING SYSTEM VALUE SELECT ${names} FROM jsonb_populate_recordset(NULL::${relation(spec)},$1::jsonb)`, [JSON.stringify(batch)]);
        if (result.rowCount !== batch.length) fail('PG_ACCESS_PROJECTION_INSERT'); batch = []; batchBytes = 0;
      };
      await eachRecord(target, protection, plan, async record => {
        checkBudget();
        while (specs[tableIndex].table !== record.table) { await flush(); tableIndex++; }
        validateRecord(record, specs[tableIndex], plan.tables[tableIndex]);
        insertedCounts[tableIndex]++; insertedHashes[tableIndex].update(canonical(record) + '\n');
        const row = clone(record.row);
        if (record.application) {
          const app = record.application; let value = clone(app.skeleton);
          for (const item of app.substitutions) value = put(value, item.path, await resolve(item.reference));
          if (rehydrate && hash(canonical(value)) !== app.valueSha256) fail('PG_ACCESS_PROJECTION_VALUE_HASH');
          if (typeof protection[app.kind] !== 'function') fail('PG_ACCESS_PROJECTION_CRYPTO');
          row.payload = app.prefix + protection[app.kind](value, app.context);
          if (app.kind === 'sealBlock') {
            const fields = row.payload.split(':'); if (fields.length !== 5) fail('PG_ACCESS_PROJECTION_BLOCK'); row.key_id = fields[1]; row.nonce = fields[2];
          }
        }
        if (record.values) {
          const value = await resolve(record.values.reference);
          if (rehydrate) {
            if (hash(canonical(value)) !== record.values.valueSha256 || Object.keys(record.values.fields).some(field => !Object.hasOwn(value, field))) fail('PG_ACCESS_PROJECTION_VALUE_HASH');
            for (const [field, column] of Object.entries(record.values.fields)) row[column] = field === 'active' ? (value[field] ? 1 : 0) : value[field];
          } else if (specs[tableIndex].kind === 'article') row.description = '[source pending]';
          else row.amount = null;
        }
        const bytes = Buffer.byteLength(JSON.stringify(row)); if (batch.length && (batch.length >= BATCH || batchBytes + bytes > 4 * 1024 * 1024)) await flush();
        batch.push(row); batchBytes += bytes;
      });
      await flush();
      for (let i = 0; i < specs.length; i++) if (insertedCounts[i] !== plan.tables[i].rows || insertedHashes[i].digest('hex') !== plan.tables[i].contentSha256) fail('PG_ACCESS_PROJECTION_CONTENT');
      await sales.query('COMMIT');
    } catch (error) { await sales.query('ROLLBACK'); throw error; }
    return { format: FORMAT, verified: true, rows: plan.rows, tables: plan.tables.map(({ schema, table, rows }) => ({ schema, table, rows })), rehydrated: rehydrate,
      requiresImportRehydration: !rehydrate && plan.stats.omittedValues > 0, omittedValues: plan.stats.omittedValues, omittedByKind: plan.stats.omittedByKind };
  } finally { await spool?.close().catch(() => {}); if (spoolPath) await fsp.unlink(spoolPath).catch(() => {}); }
}
async function rebuildSearchProjection({ sales, access, isolatedRecovery = false, checkBudget = () => {} } = {}) {
  await assertSocket(sales, isolatedRecovery);
  const S = require('../../statements/sales-article-catalog').SALES_ARTICLE_CATALOG_STATEMENTS;
  const { articleSearchProjection } = require('../../../sales-article-search-projection');
  let ownedPool, ownedProvider;
  try {
    if (!access) {
      const parameters = sales.connectionParameters;
      if (![parameters.database, parameters.user].every(name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(name))
        || typeof parameters.password !== 'string' || parameters.password.length < 24) fail('PG_ACCESS_PROJECTION_CONNECTION');
      const { Pool } = require('pg');
      ownedPool = new Pool({ host: parameters.host, port: 55484, database: parameters.database, user: parameters.user, password: parameters.password,
        ssl: false, max: 1, min: 0, connectionTimeoutMillis: 5000, application_name: 'gp-isolated-search-recovery' });
      const catalog = require('../sales/catalog').createSalesCatalog(8).entries.filter(entry => [S.searchProjectionSource, S.upsertSearchProjection, S.clearSearchProjectionDirty].includes(entry.statement));
      if (catalog.length !== 3) fail('PG_ACCESS_PROJECTION_SEARCH_CATALOG');
      ownedProvider = require('../provider').createPostgresqlPersistenceProvider({ pool: ownedPool, poolOwnership: 'external', catalog,
        prepareClient: async client => { await assertSocket(client, true); await client.query('SET search_path=pg_catalog,gp,kassa,integration,trade,reporting'); } });
      access = ownedProvider;
    }
    if (typeof access.transaction !== 'function') fail('PG_ACCESS_PROJECTION_SEARCH_ACCESS');
    if (safe((await sales.query('SELECT count(*)::text AS n FROM trade.sales_article_search_projection')).rows[0]?.n) !== 0) fail('PG_ACCESS_PROJECTION_SEARCH_NOT_EMPTY');
    let rows = 0, dirtyCleared = 0;
    await access.transaction(async operations => {
      if (typeof operations.queryOne !== 'function' || typeof operations.execute !== 'function') fail('PG_ACCESS_PROJECTION_SEARCH_ACCESS');
      let after = '';
      for (;;) {
        checkBudget();
        const ids = (await sales.query('SELECT product_id FROM trade.sales_articles WHERE product_id>$1 ORDER BY product_id LIMIT $2', [after, BATCH])).rows;
        if (ids.length > BATCH) fail('PG_ACCESS_PROJECTION_BATCH');
        for (const item of ids) {
          if (typeof item.product_id !== 'string' || item.product_id <= after) fail('PG_ACCESS_PROJECTION_KEY');
          const source = await operations.queryOne(S.searchProjectionSource, { productId: item.product_id });
          if (!source || source.productId !== item.product_id) fail('PG_ACCESS_PROJECTION_SEARCH_SOURCE');
          const result = await operations.execute(S.upsertSearchProjection, articleSearchProjection(source));
          if (result.rowsAffected !== 1) fail('PG_ACCESS_PROJECTION_SEARCH_WRITE');
          after = item.product_id; rows++;
        }
        if (ids.length < BATCH) break;
      }
      // The dirty relation is disposable cache state, including any stale IDs.
      // Do not invent an article/source revision merely to clear such an ID.
      after = '';
      for (;;) {
        checkBudget();
        const ids = (await sales.query('SELECT product_id FROM trade.sales_article_search_dirty WHERE product_id>$1 ORDER BY product_id LIMIT $2', [after, BATCH])).rows;
        if (ids.length > BATCH) fail('PG_ACCESS_PROJECTION_BATCH');
        for (const item of ids) {
          if (typeof item.product_id !== 'string' || item.product_id <= after) fail('PG_ACCESS_PROJECTION_KEY');
          const result = await operations.execute(S.clearSearchProjectionDirty, { productId: item.product_id });
          if (![0, 1].includes(result.rowsAffected)) fail('PG_ACCESS_PROJECTION_SEARCH_WRITE');
          dirtyCleared += result.rowsAffected; after = item.product_id;
        }
        if (ids.length < BATCH) break;
      }
    }, { isolation: 'serializable' });
    const counts = (await sales.query(`SELECT (SELECT count(*) FROM trade.sales_articles)::text AS articles,
      (SELECT count(*) FROM trade.sales_article_search_projection)::text AS projected,
      (SELECT count(*) FROM trade.sales_article_search_dirty)::text AS dirty,
      (SELECT count(*) FROM trade.sales_articles a LEFT JOIN trade.sales_article_search_projection p
       ON p.product_id=a.product_id AND p.current_revision=a.current_revision WHERE p.product_id IS NULL)::text AS missing`)).rows[0];
    if (!counts || safe(counts.articles) !== rows || safe(counts.projected) !== rows || safe(counts.dirty) !== 0 || safe(counts.missing) !== 0) fail('PG_ACCESS_PROJECTION_SEARCH_INTEGRITY');
    return { verified: true, rows, dirtyCleared, source: 'authoritative-current-article-revisions', transform: 'articleSearchProjection' };
  } finally {
    try { await ownedProvider?.close(); } finally { await ownedPool?.end(); }
  }
}
module.exports = { FORMAT, FILE, PROJECTED_TABLES, validateProjectionPlan, exportProjection, restoreProjection, rebuildSearchProjection };

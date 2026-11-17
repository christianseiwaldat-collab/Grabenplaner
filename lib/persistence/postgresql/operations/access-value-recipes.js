'use strict';

// Recipes contain locators and hashes only. Neither the index nor its public
// digest contains an Access value, password, encryption key or database identity.
const crypto = require('node:crypto');
const C = require('../../../data-import-contract');
const M = require('../../../tradefoto-master-profiles');
const H = require('../../../tradefoto-history-profiles');
const S = require('../../../tradefoto-full-import-source');
const A = require('../../../data-import-source-archive');
const P = require('../../../tradefoto-article-source-profile');
const { normalizeSalesArticleImportRow } = require('../../../sales-article-catalog');
const { catalogPrice } = require('../../../data-import-catalog-price');
const HEX = /^[a-f0-9]{64}$/;
const FIELDS = ['kind', 'sourceId', 'fileSha256', 'bytes', 'table', 'ordinal', 'profileHash', 'transform', 'expectedSha256'];
const DEFAULT_LIMITS = Object.freeze({ maxEntries: 4_000_000, maxIndexBytes: 512 * 1024 * 1024, maxReferences: 4_000_000, maxValueBytes: C.LIMITS.rowBytes });
const fail = (code = 'ACCESS_VALUE_RECIPE_INVALID') => C.fail(code, 503);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const definitions = new Map(), byName = new Map(), transforms = new WeakMap();
function defs(kind) {
  if (!definitions.has(kind)) { const list = S.definitions(kind); definitions.set(kind, list); byName.set(kind, new Map(list.map(d => [d.name, d]))); }
  return definitions.get(kind);
}
function profiles(def) { return def.master ? [def.profile] : H.profilesFor(def.source, def.name); }
function applied(proof) {
  A.validateImportSourceArchiveProof(proof);
  const entries = A.appliedImportSourceArchiveEntries ? A.appliedImportSourceArchiveEntries(proof)
    : [...proof.kinds.flatMap(slot => ['current', 'previous'].flatMap(generation => slot[generation] ? [{ generation, ...slot[generation] }] : [])), ...(proof.retained || []).map(e => ({ generation: 'retained', ...e }))];
  return entries.sort((a, b) => a.kind.localeCompare(b.kind, 'en') || a.sourceId.localeCompare(b.sourceId));
}
function limits(options) {
  const result = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(result)) if (options[key] !== undefined) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > DEFAULT_LIMITS[key]) fail();
    result[key] = options[key];
  }
  return result;
}
function valueHash(value, limit) { const encoded = C.canonical(value); if (Buffer.byteLength(encoded) > limit) fail('ACCESS_VALUE_RECIPE_LIMIT'); return hash(encoded); }
function transformAllowed(transform, def) {
  let allowed = transforms.get(def);
  if (!allowed) {
    allowed = new Set(['source', 'source-stripped', 'normalized-source', 'normalized-source-stripped', 'data', 'data-stripped']);
    for (const profile of profiles(def)) {
      const empty = Object.fromEntries(profile.fields.map(f => [f.target, null]));
      const segments = def.master ? M.masterSegments(def.name, empty) : H.historySegments(def.source, def.name, empty, profile.fingerprint);
      for (const segment of segments) allowed.add(def.master ? 'master-segment:' + segment.kind + ':' + segment.dataClass : 'history-segment:' + segment.dataClass);
    }
    if (def.name === 'ARTIKEL_STAMM') { allowed.add('article-revision'); P.TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.forEach((_p, i) => allowed.add('article-price:' + i)); }
    if (['ARTIKEL_STAMM', 'ARTIKEL_ZWEITEAN'].includes(def.name)) for (let i = 0; i < 32; i++) allowed.add((def.name === 'ARTIKEL_STAMM' ? 'article-identifier:' : 'alias-identifier:') + i);
    transforms.set(def, allowed);
  }
  return allowed.has(transform);
}
function validateAgainst(reference, sourceMap) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference) || ![Object.prototype, null].includes(Object.getPrototypeOf(reference))
    || Object.keys(reference).length !== FIELDS.length || FIELDS.some(k => !Object.hasOwn(reference, k)) || Object.keys(reference).some(k => !FIELDS.includes(k))
    || !HEX.test(reference.sourceId) || !HEX.test(reference.fileSha256) || !HEX.test(reference.profileHash) || !HEX.test(reference.expectedSha256)
    || !Number.isSafeInteger(reference.ordinal) || reference.ordinal < 1 || reference.ordinal > C.LIMITS.rows) fail();
  const entry = sourceMap.get(reference.sourceId);
  if (!entry || reference.kind !== entry.kind || reference.fileSha256 !== entry.fileSha256 || reference.bytes !== entry.bytes) fail();
  defs(entry.kind); const def = byName.get(entry.kind).get(reference.table);
  if (!def || !profiles(def).some(p => p.fingerprint === reference.profileHash) || !transformAllowed(reference.transform, def)) fail();
  return reference;
}
function createReferenceValidator({ proof } = {}) {
  const sourceMap = new Map(applied(proof).map(e => [e.sourceId, Object.freeze({ ...e })]));
  return reference => validateAgainst(reference, sourceMap);
}
function validateReference(reference, options) { return createReferenceValidator(options)(reference); }
function referenceHash(reference) {
  // Shape/proof validation is separate so callers can hash already validated
  // references without rescanning a potentially large archive manifest.
  if (!reference || Object.keys(reference).length !== FIELDS.length || FIELDS.some(k => !Object.hasOwn(reference, k))) fail();
  return hash(C.canonical(reference));
}
const stripped = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
function sourceFor(profile, raw, source, ordinal) {
  return Object.fromEntries(profile.fields.map(f => [f.source, f.source === '_source_snapshot_sha256' ? source.fileSha256 : f.source === '_source_row' ? ordinal : raw[f.source]]));
}
function identifierValue(identifier) {
  return { identifierType: identifier.identifierType, identifierValue: identifier.identifierValue,
    canonicalGtin14: identifier.canonicalGtin14, isPrimary: identifier.isPrimary, sourceField: identifier.sourceField,
    sourceRank: identifier.sourceRank, equivalentIdentifiers: identifier.equivalentIdentifiers || [], sourceProvider: identifier.sourceProvider || 'import' };
}
const monetary = new Set(P.TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.map(f => f.sourceField));
function article(raw, aliases = []) {
  const articleRow = Object.fromEntries(P.TRADEFOTO_ARTICLE_ROW_FIELDS.map(field => [field,
    field === 'Artikelbezeichnung' && typeof raw[field] === 'string' ? raw[field].replace(/[\t\r\n]+/g, ' ')
      : monetary.has(field) ? catalogPrice(raw[field] ?? null) : raw[field] ?? null]));
  return normalizeSalesArticleImportRow({ ...P.adaptTradeFotoArticleSourceRow({ articleRow, aliasRows: aliases, currency: 'EUR' }).importRow, active: true });
}
async function candidates(def, raw, source, ordinal, consume) {
  C.exact(raw, def.profile.fields.map(f => f.source));
  if (def.profile.fields.some(f => !Object.hasOwn(raw, f.source))) fail();
  for (const profile of profiles(def)) {
    const row = sourceFor(profile, raw, source, ordinal), emit = (transform, value) => consume(profile.fingerprint, transform, value);
    await emit('source', row);
    await emit('source-stripped', stripped(row, ['_source_snapshot_sha256', '_source_row']));
    let normalized;
    try { normalized = C.normalizeDataImportRow(profile, row); }
    catch (error) { if (error instanceof C.DataImportError) continue; throw error; }
    await emit('normalized-source', normalized.source);
    await emit('normalized-source-stripped', stripped(normalized.source, ['_source_snapshot_sha256', '_source_row']));
    await emit('data', normalized.data);
    await emit('data-stripped', stripped(normalized.data, ['snapshot', 'ordinal']));
    const segments = def.master ? M.masterSegments(def.name, normalized.data) : H.historySegments(def.source, def.name, normalized.data, profile.fingerprint);
    for (const segment of segments) await emit(def.master ? 'master-segment:' + segment.kind + ':' + segment.dataClass : 'history-segment:' + segment.dataClass, segment.data);
  }
  if (source.kind !== 'trade') return;
  let value;
  try {
    if (def.name === 'ARTIKEL_STAMM') value = article(raw);
    else if (def.name === 'ARTIKEL_ZWEITEAN') value = article({ EAN: raw.EAN, Artikelbezeichnung: 'Recovery' }, [Object.fromEntries(P.TRADEFOTO_ARTICLE_ALIAS_ROW_FIELDS.map(k => [k, raw[k]]))]);
  } catch (error) {
    // Invalid catalog source rows are retained by their ordinary import source
    // recipe. They must not become invented operational article values.
    if (!error.code) throw error;
    return;
  }
  if (!value) return;
  const emit = (transform, item) => consume(def.profile.fingerprint, transform, item);
  if (def.name === 'ARTIKEL_STAMM') {
    await emit('article-revision', { description: value.description, active: value.active, sourceUpdatedAt: value.sourceUpdatedAt });
    for (let i = 0; i < value.prices.length; i++) {
      const p = value.prices[i]; await emit('article-price:' + i, { amount: p.amount, currency: p.currency, priceBasis: p.priceBasis, qualityStatus: p.qualityStatus, sourceField: p.sourceField });
    }
  }
  for (let i = 0; i < value.identifiers.length; i++) await emit((def.name === 'ARTIKEL_STAMM' ? 'article-identifier:' : 'alias-identifier:') + i, identifierValue(value.identifiers[i]));
}

async function scanSource({ archive, entry, readSource, consume, checkBudget }) {
  checkBudget();
  const use = archive.useFile ? consumer => archive.useFile(entry.sourceId, consumer)
    : entry.generation !== 'retained' && archive.useSource ? consumer => archive.useSource(entry.kind, { generation: entry.generation }, consumer) : null;
  if (!use) fail();
  return use(async ({ buffer, password, source }) => {
    checkBudget();
    if (!Buffer.isBuffer(buffer) || buffer.length !== entry.bytes || hash(buffer) !== entry.fileSha256
      || source && (source.sourceId !== entry.sourceId || source.kind !== entry.kind || source.fileSha256 !== entry.fileSha256 || source.bytes !== entry.bytes)) fail('ACCESS_VALUE_RECIPE_SOURCE_MISMATCH');
    S.assertSourceBytes(buffer);
    const tables = defs(entry.kind); let manifest = null, current = null, next = 0, total = 0, completed = false;
    await readSource({ buffer, password, kind: entry.kind, send: async event => {
      checkBudget();
      if (!event || completed) fail('ACCESS_VALUE_RECIPE_PROTOCOL');
      if (event.type === 'manifest') {
        if (manifest || event.kind !== entry.kind || event.fileSha256 !== entry.fileSha256 || event.bytes !== entry.bytes || !Array.isArray(event.tables) || event.tables.length !== tables.length) fail('ACCESS_VALUE_RECIPE_PROTOCOL');
        let declared = 0;
        event.tables.forEach((t, i) => { if (t.name !== tables[i].name || t.profileHash !== tables[i].profile.fingerprint || !Number.isSafeInteger(t.declaredRows) || t.declaredRows < 0 || t.declaredRows > C.LIMITS.rows) fail('ACCESS_VALUE_RECIPE_PROTOCOL'); declared += t.declaredRows; });
        if (declared > C.LIMITS.rows) fail('ACCESS_VALUE_RECIPE_LIMIT'); manifest = event.tables; return;
      }
      if (!manifest) fail('ACCESS_VALUE_RECIPE_PROTOCOL');
      if (event.type === 'table') {
        if (current || next >= tables.length || event.name !== tables[next].name || event.declaredRows !== manifest[next].declaredRows || !Number.isSafeInteger(event.expectedRows) || event.expectedRows < 0 || event.expectedRows > C.LIMITS.rows) fail('ACCESS_VALUE_RECIPE_PROTOCOL');
        current = { def: tables[next], expected: event.expectedRows, rows: 0 }; return { resumeAfter: 0 };
      }
      if (event.type === 'rows') {
        if (!current || event.name !== current.def.name || event.startRow !== current.rows + 1 || !Array.isArray(event.rows) || !event.rows.length || event.rows.length > C.LIMITS.batch || current.rows + event.rows.length > current.expected) fail('ACCESS_VALUE_RECIPE_PROTOCOL');
        for (const raw of event.rows) { const ordinal = ++current.rows; await candidates(current.def, raw, entry, ordinal, (profileHash, transform, value) => consume({ kind: entry.kind, sourceId: entry.sourceId, fileSha256: entry.fileSha256, bytes: entry.bytes, table: current.def.name, ordinal, profileHash, transform }, value)); }
        return;
      }
      if (event.type === 'table-complete') {
        if (!current || event.name !== current.def.name || current.rows !== current.expected) fail('ACCESS_VALUE_RECIPE_PROTOCOL');
        total += current.rows; if (total > C.LIMITS.rows) fail('ACCESS_VALUE_RECIPE_LIMIT'); current = null; next++; return;
      }
      if (event.type !== 'complete' || current || next !== tables.length || event.tables !== next || event.rows !== total) fail('ACCESS_VALUE_RECIPE_PROTOCOL');
      completed = true;
    } });
    checkBudget(); if (!completed) fail('ACCESS_VALUE_RECIPE_PROTOCOL');
    return total;
  });
}

async function buildSourceDictionary(options) {
  const { archive, proof, readSource = S.readTradeFotoFullSource, checkBudget = () => {} } = options, bound = limits(options);
  if (!archive || typeof readSource !== 'function' || typeof checkBudget !== 'function') fail(); checkBudget();
  const sources = applied(proof), disk = options.indexDirectory
    ? require('./access-recipe-disk-index').createDiskRecipeIndex({ directory: options.indexDirectory, checkBudget }) : null;
  const index = disk || new Map(), locators = [], locatorIds = new Map(); let indexBytes = 0;
  const stats = { sources: sources.length, rows: 0, values: 0, indexBytes: 0, byKind: {} };
  try {
  for (const entry of sources) {
    const count = await scanSource({ archive, entry, readSource, checkBudget, consume: async (base, value) => {
      const expectedSha256 = valueHash(value, bound.maxValueBytes); if (!disk && index.has(expectedSha256)) return;
      // Intern repeated source/table/profile/transform metadata, retaining only a
      // small string locator and ordinal for every distinct value digest.
      const { ordinal, ...descriptor } = base, descriptorKey = C.canonical(descriptor);
      let id = locatorIds.get(descriptorKey);
      const additional = (disk ? 0 : 160) + (id === undefined ? Buffer.byteLength(descriptorKey) + 96 : 0);
      if (!disk && index.size >= bound.maxEntries || indexBytes + additional > bound.maxIndexBytes) fail('ACCESS_VALUE_RECIPE_LIMIT');
      if (id === undefined) { id = locators.length; locators.push(Object.freeze(descriptor)); locatorIds.set(descriptorKey, id); }
      if(disk)disk.append(expectedSha256,id,ordinal);else index.set(expectedSha256, [id, ordinal]); indexBytes += additional;
    } });
    stats.rows += count; stats.byKind[entry.kind] = (stats.byKind[entry.kind] || 0) + count;
  }
  if(disk)await disk.finalize();
  const expand = (digest, [id, ordinal]) => Object.freeze({ ...locators[id], ordinal, expectedSha256: digest });
  checkBudget();
  const digest = crypto.createHash('sha256').update(C.canonical({ version: 1, archiveGenerationSha256: proof.generationSha256 }));
  let hashed = 0;
  const sorted = disk ? disk.entries() : [...index.keys()].sort().map(key=>[key,index.get(key)]);
  for (const [key, locator] of sorted) { if (++hashed % 1024 === 0) checkBudget(); digest.update('\n').update(key).update(':').update(referenceHash(expand(key, locator))); }
  checkBudget();
  stats.values = index.size; stats.indexBytes = indexBytes; Object.freeze(stats.byKind); Object.freeze(stats);
  return Object.freeze({ size: index.size, stats, storage:disk?'disk':'memory',dictionarySha256: digest.digest('hex'), archiveGenerationSha256: proof.generationSha256,dispose:()=>disk?.dispose(),
    reference(value) { let key; try { key = valueHash(value, bound.maxValueBytes); } catch (error) { if (error instanceof C.DataImportError) return null; throw error; } const locator = disk?disk.lookup(key):index.get(key); return locator ? expand(key, locator) : null; } });
  } catch(error) { try{disk?.dispose();}catch{/* Keep unknown scratch files and the original failure. */} throw error; }
}

async function materializeReferences(options) {
  const { archive, proof, references, readSource = S.readTradeFotoFullSource, onValue, checkBudget = () => {} } = options, bound = limits(options);
  if (!archive || !references || typeof references[Symbol.iterator] !== 'function' || typeof readSource !== 'function' || typeof checkBudget !== 'function' || onValue !== undefined && typeof onValue !== 'function') fail(); checkBudget();
  const sourceMap = new Map(applied(proof).map(e => [e.sourceId, e])), wanted = new Map();
  let size = 0;
  for (const reference of references) {
    if (size % 512 === 0) checkBudget();
    validateAgainst(reference, sourceMap); const key = referenceHash(reference);
    if (++size > bound.maxReferences) fail('ACCESS_VALUE_RECIPE_LIMIT');
    if (!wanted.has(reference.sourceId)) wanted.set(reference.sourceId, new Map());
    wanted.get(reference.sourceId).set(key, Object.freeze({ ...reference }));
  }
  const result = new Map(); let resolved = 0, rows = 0, materializedBytes = 0;
  for (const [sourceId, pending] of wanted) {
    const locations = new Map();
    for (const [key, reference] of pending) {
      const location = C.canonical([reference.table, reference.ordinal, reference.profileHash, reference.transform]);
      if (locations.has(location)) fail(); locations.set(location, [key, reference]);
    }
    rows += await scanSource({ archive, entry: sourceMap.get(sourceId), readSource, checkBudget, consume: async (base, value) => {
      const location = C.canonical([base.table, base.ordinal, base.profileHash, base.transform]), requested = locations.get(location); if (!requested) return;
      const [key, reference] = requested;
      if (valueHash(value, bound.maxValueBytes) !== reference.expectedSha256) fail('ACCESS_VALUE_RECIPE_VALUE_MISMATCH');
      if (onValue) await onValue(reference, value);
      else { materializedBytes += Buffer.byteLength(C.canonical(value)); if (materializedBytes > bound.maxIndexBytes) fail('ACCESS_VALUE_RECIPE_LIMIT'); result.set(key, value); }
      pending.delete(key); locations.delete(location); resolved++;
    } });
    if (pending.size) fail('ACCESS_VALUE_RECIPE_UNRESOLVED');
  }
  checkBudget();
  return onValue ? { resolved, rows, sources: wanted.size } : result;
}
module.exports = { buildSourceDictionary, materializeReferences, createReferenceValidator, validateReference, referenceHash, DEFAULT_LIMITS };

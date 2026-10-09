'use strict';
const crypto = require('node:crypto');
const C = require('./data-import-contract');
const M = require('./sales-bwl-simulation-model');
const S = require('./sales-bwl-simulation-statements');
const {assertPersistenceAccess} = require('./persistence/contract');
const {loadManagedDataImportProtection} = require('./data-import-managed-protection');
const {A} = require('./persistence/statements/trade-annotations');
const {CRM_CUSTOMER_STATEMENTS: Audit} = require('./persistence/statements/crm-customers');
const K = Object.freeze({index: 'sales-bwl-simulation-index', item: 'sales-bwl-simulation-variant', chunk: 'sales-bwl-simulation-chunk'});
const CHUNK_BYTES = 512 * 1024, RETIRED_LIMIT = 1000;
const concurrent = new Set(['IMPORT_CONCURRENT_CHANGE', 'PERSISTENCE_RETRYABLE_TRANSACTION', 'PERSISTENCE_BUSY', 'PERSISTENCE_UNIQUE_VIOLATION']);
const protectedErrors = new Set(['IMPORT_PROTECTED_PAYLOAD_INVALID', 'IMPORT_PROTECTION_KEY_INVALID', 'IMPORT_VAULT_UNAVAILABLE', 'IMPORT_PROTECTION_UNAVAILABLE']);
const fail = (suffix, status) => C.fail('BWL_SIMULATION_VARIANT_' + suffix, status);
const integrity = () => fail('INTEGRITY', 503);
const changed = () => fail('CHANGED', 409);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function uuid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) fail('INVALID', 422);
  return value.toLowerCase();
}
function name(value) { C.text(value, 120); if (!value.trim()) fail('INVALID', 422); return value.trim(); }
function snapshotCopy(value) {
  let encoded;
  try { encoded = C.canonical(value); } catch { integrity(); }
  if (Buffer.byteLength(encoded) > M.LIMITS.snapshotBytes) fail('LIMIT', 413);
  const copy = JSON.parse(encoded);
  try {
    C.exact(copy, ['schemaVersion', 'filters', 'assumptions', 'sourceAt', 'sourceFingerprint', 'generatedAt', 'scanned', 'candidateScanned', 'capabilities', 'rows', 'summary', 'note']);
    if (copy.schemaVersion !== 1 || !Array.isArray(copy.rows) || copy.rows.length > M.LIMITS.rows
      || !C.plain(copy.capabilities) || !C.plain(copy.summary) || !C.plain(copy.summary.totals)) integrity();
    C.utc(copy.sourceAt); C.sha(copy.sourceFingerprint); M.assumptions(copy.assumptions);
    C.integer(copy.summary.rows, 0, M.LIMITS.rows);
    if (copy.summary.rows !== copy.rows.length || copy.rows.some(r => !C.plain(r) || typeof r.locationId !== 'string')) integrity();
    for (const total of Object.values(copy.summary.totals)) {
      C.exact(total, ['value', 'knownSubtotal', 'missingRows', 'complete']);
      if (typeof total.complete !== 'boolean' || typeof total.knownSubtotal !== 'string'
        || !(total.value === null || typeof total.value === 'string')) integrity();
      C.integer(total.missingRows, 0, copy.rows.length);
    }
  } catch { integrity(); }
  return copy;
}
function createSalesBwlSimulationVariantsStore({access, vault, scopeId = 'grabenplaner-main'}) {
  assertPersistenceAccess(access);
  const baseScope = C.id(scopeId), scope = baseScope + ':personal-bwl-simulation';
  async function current(getSession, tx, expected) {
    if (typeof getSession !== 'function') C.fail('BWL_SIMULATION_FORBIDDEN', 403);
    const authority = M.authority(await getSession(tx));
    const context = {...authority, identity: String(authority.identity)};
    if (expected && context.identity !== expected.identity) C.fail('BWL_SIMULATION_FORBIDDEN', 403);
    return context;
  }
  const key = (context, ...rest) => C.canonical([context.ownerId, context.accountId, ...rest]);
  const envelope = (context, extra) => ({schemaVersion: 1, ownerId: context.ownerId, accountId: context.accountId, ...extra});
  function checkEnvelope(value, context, fields) {
    try {
      C.exact(value, ['schemaVersion', 'ownerId', 'accountId', ...fields]);
      if (Object.keys(value).length !== 3 + fields.length || value.schemaVersion !== 1
        || value.ownerId !== context.ownerId || value.accountId !== context.accountId) integrity();
    } catch { integrity(); }
  }
  async function read(tx, protection, kind, rowKey) {
    const id = protection.digest(['trade-annotation-id', scope, kind, rowKey]);
    const row = await tx.queryOne(A.get, {id, scopeId: scope, kind});
    if (!row) return {id, revision: 0, value: null};
    try {
      C.integer(row.revision, 1, Number.MAX_SAFE_INTEGER - 1);
      if (row.id !== id || row.scopeId !== scope || row.kind !== kind) integrity();
      return {id, revision: row.revision, value: protection.open(row.payload, ['trade-annotation-v1', scope, kind, id, row.revision])};
    } catch { integrity(); }
  }
  async function write(tx, protection, kind, prior, value) {
    const row = {id: prior.id, scopeId: scope, kind, revision: prior.revision + 1};
    const payload = protection.seal(value, ['trade-annotation-v1', scope, kind, row.id, row.revision]);
    const result = await tx.execute(prior.revision ? A.update : A.insert, {...row, payload,
      ...(prior.revision ? {expectedRevision: prior.revision} : {})});
    if (result.rowsAffected !== 1) changed();
    return row.revision;
  }
  async function erase(tx, kind, prior) {
    const result = await tx.execute(S.remove, {id: prior.id, scopeId: scope, kind, expectedRevision: prior.revision});
    if (result.rowsAffected !== 1) changed();
  }
  async function index(tx, protection, context) {
    const prior = await read(tx, protection, K.index, key(context));
    if (!prior.revision) return {...prior, value: envelope(context, {ids: [], retiredIds: []})};
    checkEnvelope(prior.value, context, ['ids', 'retiredIds']);
    try {
      for (const [ids, limit] of [[prior.value.ids, M.LIMITS.variants], [prior.value.retiredIds, RETIRED_LIMIT]]) {
        if (!Array.isArray(ids) || ids.length > limit || new Set(ids).size !== ids.length || ids.some(id => uuid(id) !== id)) integrity();
      }
      if (prior.value.ids.some(id => prior.value.retiredIds.includes(id))) integrity();
    } catch { integrity(); }
    return prior;
  }
  async function item(tx, protection, context, id, withSnapshot = true) {
    const prior = await read(tx, protection, K.item, key(context, id));
    if (!prior.revision) integrity();
    const m = prior.value;
    checkEnvelope(m, context, ['id', 'name', 'createdAt', 'updatedAt', 'creationHash', 'chunkCount', 'bytes', 'sha', 'sourceAt', 'sourceFingerprint']);
    try {
      if (m.id !== id || name(m.name) !== m.name) integrity();
      for (const timestamp of [m.createdAt, m.updatedAt, m.sourceAt]) C.utc(timestamp);
      for (const digest of [m.creationHash, m.sha, m.sourceFingerprint]) C.sha(digest);
      C.integer(m.bytes, 1, M.LIMITS.snapshotBytes);
      C.integer(m.chunkCount, 1, Math.ceil(M.LIMITS.snapshotBytes / CHUNK_BYTES));
      if (m.chunkCount !== Math.ceil(m.bytes / CHUNK_BYTES)) integrity();
    } catch { integrity(); }
    if (!withSnapshot) return prior;
    const chunks = [], buffers = [];
    try {
      for (let i = 0; i < m.chunkCount; i++) {
        const chunk = await read(tx, protection, K.chunk, key(context, id, i));
        checkEnvelope(chunk.value, context, ['id', 'index', 'data']);
        const v = chunk.value;
        if (!chunk.revision || v.id !== id || v.index !== i || typeof v.data !== 'string') integrity();
        const bytes = Buffer.from(v.data, 'base64'); buffers.push(bytes);
        if (bytes.toString('base64') !== v.data || bytes.length !== Math.min(CHUNK_BYTES, m.bytes - i * CHUNK_BYTES)) integrity();
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(buffers);
      try {
        if (bytes.length !== m.bytes || hash(bytes) !== m.sha) integrity();
        const decoded = JSON.parse(bytes.toString('utf8'));
        if (C.canonical(decoded) !== bytes.toString('utf8')) integrity();
        const snapshot = snapshotCopy(decoded);
        if (snapshot.sourceAt !== m.sourceAt || snapshot.sourceFingerprint !== m.sourceFingerprint) integrity();
        return {...prior, snapshot, chunks};
      } finally {bytes.fill(0);}
    } catch { integrity(); } finally {for (const bytes of buffers) bytes.fill(0);}
  }
  const metadata = prior => ({id: prior.value.id, name: prior.value.name, version: prior.revision,
    createdAt: prior.value.createdAt, updatedAt: prior.value.updatedAt, sourceAt: prior.value.sourceAt, sourceFingerprint: prior.value.sourceFingerprint});
  const response = (prior, context) => ({...metadata(prior), snapshot: M.filterHistorical(prior.snapshot, context), historical: true});
  async function work(getSession, operation, rawId, rawInput, rawSnapshot) {
    // Snapshot all caller-owned data before the first asynchronous authority read.
    const writing = ['create', 'update', 'remove'].includes(operation);
    let id, input, snapshot;
    try {
      if (rawId !== undefined) id = uuid(rawId);
      if (operation === 'create') {C.exact(rawInput, ['id', 'name']); if (Object.keys(rawInput).length !== 2) fail('INVALID', 422); input = {id: uuid(rawInput.id), name: name(rawInput.name)}; id = input.id;}
      if (operation === 'update') {C.exact(rawInput, ['version', 'name']); if (Object.keys(rawInput).length !== 2) fail('INVALID', 422); input = {version: C.integer(rawInput.version, 1, Number.MAX_SAFE_INTEGER - 1), name: name(rawInput.name)};}
      if (operation === 'remove') {C.exact(rawInput, ['version']); if (Object.keys(rawInput).length !== 1) fail('INVALID', 422); input = {version: C.integer(rawInput.version, 1, Number.MAX_SAFE_INTEGER - 1)};}
    } catch {fail('INVALID', 422);}
    if (operation === 'create' || rawSnapshot != null) snapshot = snapshotCopy(rawSnapshot);
    const context = await current(getSession);
    if (snapshot) snapshot = M.filterHistorical(snapshot, context);
    let protection;
    try {
      protection = await loadManagedDataImportProtection({access, vault, create: writing});
      await current(getSession, undefined, context);
      return await access.transaction(async tx => {
        await current(getSession, tx, context);
        if (!protection) {if (operation === 'list') {await current(getSession, tx, context); return {variants: []};} fail('NOT_FOUND', 404);}
        const idx = await index(tx, protection, context);
        if (operation === 'list') {
          const variants = [];
          for (const variantId of idx.value.ids) {const prior = await item(tx, protection, context, variantId); response(prior, context); variants.push(metadata(prior));}
          await current(getSession, tx, context); return {variants};
        }
        const exists = idx.value.ids.includes(id);
        if (operation !== 'create' && !exists) fail('NOT_FOUND', 404);
        let prior = exists ? await item(tx, protection, context, id) : {id: protection.digest(['trade-annotation-id', scope, K.item, key(context, id)]), revision: 0};
        if (exists) M.filterHistorical(prior.snapshot, context);
        if (operation === 'get') {await current(getSession, tx, context); return response(prior, context);}
        const creationHash = operation === 'create' ? C.fingerprint([input.name, snapshot]) : prior.value.creationHash;
        if (operation === 'create' && exists) {
          if (creationHash !== prior.value.creationHash) changed();
          await current(getSession, tx, context); return response(prior, context);
        }
        if (operation === 'create' && (idx.value.retiredIds.includes(id) || idx.value.ids.length >= M.LIMITS.variants)) {
          if (idx.value.retiredIds.includes(id)) changed(); fail('LIMIT', 413);
        }
        if (operation !== 'create' && prior.revision !== input.version) changed();
        if (snapshot && await S.fingerprint(tx, baseScope, protection) !== snapshot.sourceFingerprint) C.fail('BWL_SIMULATION_SOURCE_CHANGED', 409);
        await current(getSession, tx, context);
        const timestamp = new Date().toISOString(); let version;
        if (operation === 'remove') {
          if (idx.value.retiredIds.length >= RETIRED_LIMIT) fail('LIMIT', 413);
          for (const chunk of prior.chunks) await erase(tx, K.chunk, chunk);
          await erase(tx, K.item, prior);
          idx.value.ids = idx.value.ids.filter(value => value !== id); idx.value.retiredIds.push(id);
          await write(tx, protection, K.index, idx, idx.value); version = prior.revision;
        } else {
          let manifest;
          if (snapshot) {
            const bytes = Buffer.from(C.canonical(snapshot));
            try {
              const chunkCount = Math.ceil(bytes.length / CHUNK_BYTES);
              for (let i = 0; i < chunkCount; i++) {
                const old = prior.chunks?.[i] || await read(tx, protection, K.chunk, key(context, id, i));
                if (!exists && old.revision) integrity();
                await write(tx, protection, K.chunk, old, envelope(context, {id, index: i, data: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).toString('base64')}));
              }
              for (const extra of (prior.chunks || []).slice(chunkCount)) await erase(tx, K.chunk, extra);
              manifest = envelope(context, {id, name: input.name, createdAt: prior.value?.createdAt || timestamp, updatedAt: timestamp, creationHash,
                chunkCount, bytes: bytes.length, sha: hash(bytes), sourceAt: snapshot.sourceAt, sourceFingerprint: snapshot.sourceFingerprint});
            } finally {bytes.fill(0);}
          } else {manifest = {...prior.value, name: input.name, updatedAt: timestamp}; snapshot = prior.snapshot;}
          version = await write(tx, protection, K.item, prior, manifest);
          prior = {value: manifest, revision: version, snapshot};
          if (operation === 'create') {idx.value.ids.push(id); await write(tx, protection, K.index, idx, idx.value);}
        }
        const audit = await tx.execute(Audit.insertAudit, {actor: context.ownerId, action: 'trade.' + K.item + '.' + operation, entityType: 'trade_annotation',
          entityId: protection.digest(['trade-annotation-id', scope, K.item, key(context, id)]), detail: JSON.stringify({revision: version}), timestamp});
        if (audit.rowsAffected !== 1) integrity();
        await current(getSession, tx, context);
        return operation === 'remove' ? {removed: true} : response(prior, context);
      }, {isolation: 'serializable', readOnly: !writing});
    } catch (error) {
      if (concurrent.has(error.code)) changed(); if (protectedErrors.has(error.code)) integrity(); throw error;
    } finally {protection?.destroy();}
  }
  return Object.freeze({list: getSession => work(getSession, 'list'), get: (getSession, id) => work(getSession, 'get', id),
    create: (getSession, input, snapshot) => work(getSession, 'create', undefined, input, snapshot),
    update: (getSession, id, input, snapshot = null) => work(getSession, 'update', id, input, snapshot), remove: (getSession, id, input) => work(getSession, 'remove', id, input)});
}
module.exports = {createSalesBwlSimulationVariantsStore};

'use strict';

const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), crypto = require('node:crypto');
const C = require('./data-import-contract');
const { MAX_BYTES, assertSourceBytes } = require('./tradefoto-full-import-source');
const { SOURCE_KINDS } = require('./data-import-source-catalog');
const { importFileName } = require('./data-import-file-name');
const INDEX = 'index.source-archive', FORMAT = 'gp-applied-access-sources-v1';
const INDEX_FORMAT = 'gp-applied-access-source-index-v2';
const CONTEXT = { namespace: 'data-import-source-archive', connectorId: 'applied-access-sources-v1', field: 'index-and-file-keys', purpose: 'source-archive-and-recovery' };
const HEX = /^[a-f0-9]{64}$/, BLOB = /^[a-f0-9]{64}\.source$/, TEMP = /^[a-f0-9]{32}\.pending$/;
const MAX_CANDIDATES = 6, MAX_CONFIRMED = 10000, MAX_FILES = MAX_CONFIRMED + MAX_CANDIDATES;
const MAX_ARCHIVE_BYTES = MAX_FILES * MAX_BYTES, INDEX_PLAIN_LIMIT = 16 * 1024 * 1024, INDEX_LIMIT = 24 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = () => C.fail('IMPORT_SOURCE_ARCHIVE_INVALID', 503);
const aad = entry => Buffer.from([FORMAT, entry.kind, entry.sourceId, entry.fileSha256, entry.file].join('\0'));
const PUBLIC_FIELDS = ['kind', 'sourceId', 'fileSha256', 'bytes', 'fileName', 'capturedAt', 'appliedAt', 'revision', 'requiresPassword', 'file'];
const publicEntry = entry => entry ? Object.fromEntries(PUBLIC_FIELDS.map(k => [k, entry[k]])) : null;
const proofDigest = proof => hash(JSON.stringify({ generation: proof.generation, kinds: proof.kinds.map(s => ({ kind: s.kind, current: publicEntry(s.current), previous: publicEntry(s.previous) })), ...(proof.retained ? { retained: proof.retained.map(publicEntry) } : {}), candidates: proof.candidates.map(publicEntry), files: proof.files.map(f => ({ file: f.file, bytes: f.bytes, sha256: f.sha256 })) }));

function appliedImportSourceArchiveEntries(proof) {
  validateImportSourceArchiveProof(proof);
  return [...proof.kinds.flatMap(slot => ['current', 'previous'].flatMap(generation => slot[generation] ? [{ generation, ...slot[generation] }] : [])),
    ...(proof.retained || []).map(entry => ({ generation: 'retained', ...entry }))];
}

function validateImportSourceArchiveProof(proof) {
  if (!proof || proof.version !== 1 || typeof proof.available !== 'boolean' || !Number.isSafeInteger(proof.generation) || proof.generation < 0
    || !Array.isArray(proof.kinds) || ![0, SOURCE_KINDS.length].includes(proof.kinds.length) || proof.retained !== undefined && (!Array.isArray(proof.retained) || proof.retained.length > MAX_CONFIRMED)
    || !Array.isArray(proof.candidates) || proof.candidates.length > MAX_CANDIDATES || !Array.isArray(proof.files) || proof.files.length > MAX_FILES + 1) fail();
  const ids = new Set(), names = new Set(), required = new Set(); let current = 0;
  function entry(e, applied, kind) {
    if (!e || Object.keys(e).some(k => !PUBLIC_FIELDS.includes(k)) || PUBLIC_FIELDS.some(k => !Object.hasOwn(e, k))
      || !SOURCE_KINDS.includes(e.kind) || kind && e.kind !== kind || !HEX.test(e.sourceId) || ids.has(e.sourceId) || !HEX.test(e.fileSha256) || !BLOB.test(e.file) || required.has(e.file)
      || !Number.isSafeInteger(e.bytes) || e.bytes < 4096 || e.bytes > MAX_BYTES || !Number.isSafeInteger(e.revision) || e.revision < 1 || !Number.isSafeInteger(e.capturedAt) || e.capturedAt < 0
      || (applied ? !Number.isSafeInteger(e.appliedAt) || e.appliedAt < 0 : e.appliedAt !== null) || typeof e.requiresPassword !== 'boolean' || importFileName(e.fileName) !== e.fileName) fail();
    ids.add(e.sourceId); required.add(e.file);
  }
  proof.kinds.forEach((slot, i) => { if (slot.kind !== SOURCE_KINDS[i] || !Object.hasOwn(slot, 'current') || !Object.hasOwn(slot, 'previous') || slot.previous && !slot.current) fail(); if (slot.current) { entry(slot.current, true, slot.kind); current++; } if (slot.previous) entry(slot.previous, true, slot.kind); });
  for (const retained of proof.retained || []) entry(retained, true);
  if (ids.size > MAX_CONFIRMED) fail();
  proof.candidates.forEach(e => entry(e, false));
  if (proof.available !== (current > 0)) fail();
  for (const file of proof.files) { if (!file || ![INDEX].includes(file.file) && !BLOB.test(file.file) || names.has(file.file) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > (file.file === INDEX ? INDEX_LIMIT : MAX_BYTES) || !HEX.test(file.sha256)) fail(); names.add(file.file); }
  if (proof.files.length) required.add(INDEX);
  if (required.size !== names.size || [...required].some(name => !names.has(name)) || proof.generationSha256 !== proofDigest(proof)) fail();
  return proof;
}

// The ordinary vault envelope is bounded to 64 KiB. A retained-generation index
// can exceed that bound, so v2 uses a separate bounded AES-GCM metadata payload;
// only its fresh key, nonce, tag and digest are sealed in the existing vault.
function encodeIndex(index, vault) {
  const bytes = Buffer.from(JSON.stringify(index));
  if (bytes.length > INDEX_PLAIN_LIMIT) { bytes.fill(0); C.fail('IMPORT_SOURCE_ARCHIVE_RETENTION_LIMIT', 409); }
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12); let cipherBytes;
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(INDEX_FORMAT));
    cipherBytes = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const metadata = Buffer.from(JSON.stringify({ version: 2, key: key.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), bytes: bytes.length, sha256: hash(bytes) }));
    let envelope; try { envelope = vault.seal(metadata, CONTEXT); } finally { metadata.fill(0); }
    return JSON.stringify({ format: INDEX_FORMAT, version: 2, envelope, payload: cipherBytes.toString('base64') });
  } finally { bytes.fill(0); key.fill(0); iv.fill(0); cipherBytes?.fill(0); }
}
async function decodeIndex(text, vault) {
  if (!text.startsWith('{')) { let value; await vault.useSecret(text, CONTEXT, bytes => { value = JSON.parse(bytes.toString('utf8')); }); return value; }
  const outer = JSON.parse(text);
  if (outer?.format !== INDEX_FORMAT || outer.version !== 2 || typeof outer.envelope !== 'string' || typeof outer.payload !== 'string'
    || Object.keys(outer).sort().join(',') !== 'envelope,format,payload,version' || outer.payload.length > Math.ceil(INDEX_PLAIN_LIMIT / 3) * 4) fail();
  let result;
  await vault.useSecret(outer.envelope, CONTEXT, metadata => {
    const value = JSON.parse(metadata.toString('utf8'));
    if (value?.version !== 2 || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > INDEX_PLAIN_LIMIT || !HEX.test(value.sha256)) fail();
    const decoded = [];
    try {
      for (const [name, size] of [['key', 32], ['iv', 12], ['tag', 16]]) {
        if (typeof value[name] !== 'string') fail();
        const part = Buffer.from(value[name], 'base64'); decoded.push(part); if (part.length !== size || part.toString('base64') !== value[name]) fail();
      }
      const payload = Buffer.from(outer.payload, 'base64'); decoded.push(payload);
      if (payload.length !== value.bytes || payload.toString('base64') !== outer.payload) fail();
      const decipher = crypto.createDecipheriv('aes-256-gcm', decoded[0], decoded[1]); decipher.setAAD(Buffer.from(INDEX_FORMAT)); decipher.setAuthTag(decoded[2]);
      const first = decipher.update(payload); decoded.push(first); const final = decipher.final(); decoded.push(final);
      const plain = Buffer.concat([first, final]); decoded.push(plain);
      if (plain.length !== value.bytes || hash(plain) !== value.sha256) fail(); result = JSON.parse(plain.toString('utf8'));
    } finally { decoded.forEach(bytes => bytes.fill(0)); }
  });
  return result;
}

// The app's instance lock admits one writer; the local queue also serializes its
// uploads and worker. Immutable encrypted files precede the atomic index commit.
// Only the Access file's unlock password is retained inside the sealed index;
// no login/session is retained. Recoverable per-file keys live with that index
// in private/import-sources, part of the private business backup.
function createImportSourceArchive({ directory, objectDirectory = directory, vault, now = Date.now, expectedUid = process.getuid?.(), objectExpectedUid = expectedUid, readOnly = false }) {
  if (!directory || !vault || typeof vault.seal !== 'function' || typeof vault.useSecret !== 'function') C.fail('IMPORT_COMPOSITION_INVALID');
  if ([expectedUid, objectExpectedUid].some(uid => uid !== undefined && (!Number.isSafeInteger(uid) || uid < 0))) C.fail('IMPORT_COMPOSITION_INVALID');
  const root = path.resolve(directory), objects = path.resolve(objectDirectory), uid = expectedUid; let queue = Promise.resolve();
  if (objects !== root && !readOnly) C.fail('IMPORT_COMPOSITION_INVALID');
  const writable = () => { if (readOnly) C.fail('IMPORT_SOURCE_ARCHIVE_READ_ONLY', 503); };
  const serial = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  const target = name => { if (name !== INDEX && !BLOB.test(name) && !TEMP.test(name)) fail(); return path.join(BLOB.test(name) ? objects : root, name); };
  const privateStat = (s, owner = uid) => !s.isSymbolicLink() && s.nlink === 1 && (owner === undefined || s.uid === owner && !(s.mode & 0o077));
  async function directoryState(create) {
    let stat;
    try { stat = await fsp.lstat(root); } catch (error) { if (error.code !== 'ENOENT') throw error; if (!create) return false; }
    if (!stat) {
      if (path.resolve(await fsp.realpath(path.dirname(root))) !== path.dirname(root)) fail();
      try { await fsp.mkdir(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = await fsp.lstat(root);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fsp.realpath(root)) !== root || uid !== undefined && (stat.uid !== uid || stat.mode & 0o077)) fail();
    return true;
  }
  async function open(name, limit) {
    const owner = BLOB.test(name) ? objectExpectedUid : uid;
    const base = BLOB.test(name) ? objects : root, directory = await fsp.lstat(base);
    if (!directory.isDirectory() || directory.isSymbolicLink() || path.resolve(await fsp.realpath(base)) !== base
      || owner !== undefined && (directory.uid !== owner || directory.mode & 0o077)) fail();
    const file = target(name), handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat(), named = await fsp.lstat(file);
      if (!stat.isFile() || !privateStat(stat, owner) || !privateStat(named, owner) || stat.ino !== named.ino || stat.dev !== named.dev || stat.size > limit) fail();
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async function syncDirectory() { if (process.platform === 'win32') return; const handle = await fsp.open(root, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  function validateEntry(entry, applied) {
    if (!entry || !SOURCE_KINDS.includes(entry.kind) || !HEX.test(entry.sourceId) || !HEX.test(entry.fileSha256) || !BLOB.test(entry.file)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 4096 || entry.bytes > MAX_BYTES || !Number.isSafeInteger(entry.revision) || entry.revision < 1
      || !Number.isSafeInteger(entry.capturedAt) || entry.capturedAt < 0 || (applied ? !Number.isSafeInteger(entry.appliedAt) || entry.appliedAt < 0 : entry.appliedAt !== null)
      || typeof entry.password !== 'string' || Buffer.byteLength(entry.password) > 256 || entry.requiresPassword !== (entry.password !== '')
      || entry.encryptedSha256 !== undefined && !HEX.test(entry.encryptedSha256)
      || importFileName(entry.fileName) !== entry.fileName) fail();
    for (const [field, length] of [['key', 32], ['iv', 12], ['tag', 16]]) {
      if (typeof entry[field] !== 'string') fail();
      const bytes = Buffer.from(entry[field], 'base64'); const valid = bytes.length === length && bytes.toString('base64') === entry[field]; bytes.fill(0); if (!valid) fail();
    }
  }
  function validate(index) {
    if (!index || ![1, 2].includes(index.version) || index.format !== FORMAT || !Number.isSafeInteger(index.generation) || index.generation < 0
      || index.version === 2 && (!Array.isArray(index.retained) || index.retained.length > MAX_CONFIRMED)
      || !Array.isArray(index.kinds) || index.kinds.length !== SOURCE_KINDS.length || !Array.isArray(index.candidates) || index.candidates.length > MAX_CANDIDATES) fail();
    const files = new Set(), ids = new Set();
    function entry(value, applied, kind) {
      validateEntry(value, applied); if (index.version === 2 && !HEX.test(value.encryptedSha256 || '') || kind && value.kind !== kind || files.has(value.file) || ids.has(value.sourceId)) fail(); files.add(value.file); ids.add(value.sourceId);
    }
    index.kinds.forEach((slot, i) => { if (!slot || slot.kind !== SOURCE_KINDS[i] || !Object.hasOwn(slot, 'current') || !Object.hasOwn(slot, 'previous') || slot.previous && !slot.current) fail();
      if (slot.current) entry(slot.current, true, slot.kind); if (slot.previous) entry(slot.previous, true, slot.kind); });
    for (const value of index.retained || []) entry(value, true);
    if (ids.size > MAX_CONFIRMED) C.fail('IMPORT_SOURCE_ARCHIVE_RETENTION_LIMIT', 409);
    for (const value of index.candidates) entry(value, false);
    return index;
  }
  async function load(create = false) {
    if (!await directoryState(create)) return null;
    let handle;
    try { handle = await open(INDEX, INDEX_LIMIT); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const names = await fsp.readdir(root);
      // Interrupted first writes can leave immutable blobs, but no generation
      // was committed and none may be presented as successfully applied.
      if ((!create && names.length) || names.some(name => !BLOB.test(name) && !TEMP.test(name))) fail();
      return { version: 2, format: FORMAT, generation: 0, kinds: SOURCE_KINDS.map(kind => ({ kind, current: null, previous: null })), retained: [], candidates: [] };
    }
    let index;
    try { index = await decodeIndex(await handle.readFile('utf8'), vault); } catch { fail(); } finally { await handle.close(); }
    return validate(index);
  }
  const confirmedEntries = index => [...index.kinds.flatMap(slot => [slot.current, slot.previous].filter(Boolean)), ...(index.retained || [])];
  const entries = index => [...confirmedEntries(index), ...index.candidates];
  async function cleanup(index) {
    const retained = new Set(entries(index).map(e => e.file)); let changed = false;
    for (const name of await fsp.readdir(root)) {
      if (name === INDEX || retained.has(name)) continue;
      if (!BLOB.test(name) && !TEMP.test(name)) fail();
      const handle = await open(name, Math.max(MAX_BYTES, INDEX_LIMIT)); await handle.close(); await fsp.unlink(target(name)); changed = true;
    }
    if (changed) await syncDirectory();
  }
  async function save(index) {
    writable();
    if (index.version === 1) {
      for (const entry of entries(index)) { await decrypt(entry); entry.encryptedSha256 = (await encryptedFile(entry.file)).sha256; }
      index.version = 2; index.retained ||= [];
    }
    index.generation++; validate(index);
    const encrypted = encodeIndex(index, vault);
    const name = crypto.randomBytes(16).toString('hex') + '.pending', handle = await fsp.open(target(name), 'wx', 0o600);
    try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
    await fsp.rename(target(name), target(INDEX)); await syncDirectory();
    await cleanup(index);
  }
  function snapshot(index, files = []) {
    const result = { version: 1, available: Boolean(index?.kinds.some(s => s.current)), generation: index?.generation || 0, kinds: index ? index.kinds.map(s => ({ kind: s.kind, current: publicEntry(s.current), previous: publicEntry(s.previous) })) : [],
      ...(index?.retained?.length ? { retained: index.retained.map(publicEntry) } : {}), candidates: index ? index.candidates.map(publicEntry) : [], files };
    return validateImportSourceArchiveProof({ ...result, generationSha256: proofDigest(result) });
  }
  async function encryptedFile(name) {
    const handle = await open(name, name === INDEX ? INDEX_LIMIT : MAX_BYTES);
    try {
      const before = await handle.stat(), digest = crypto.createHash('sha256'), chunk = Buffer.alloc(1024 * 1024); let position = 0;
      try { for (;;) { const { bytesRead } = await handle.read(chunk, 0, chunk.length, position); if (!bytesRead) break; digest.update(chunk.subarray(0, bytesRead)); position += bytesRead; } } finally { chunk.fill(0); }
      const after = await handle.stat(), named = await fsp.lstat(target(name));
      if (!privateStat(named, BLOB.test(name) ? objectExpectedUid : uid) || before.ino !== named.ino || before.dev !== named.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || position !== before.size) fail();
      return { file: name, bytes: position, sha256: digest.digest('hex') };
    } finally { await handle.close(); }
  }
  async function decrypt(entry, returnBuffer = false) {
    validateEntry(entry, entry.appliedAt !== null);
    const handle = await open(entry.file, MAX_BYTES), key = Buffer.from(entry.key, 'base64'); let output;
    try {
      if ((await handle.stat()).size !== entry.bytes) fail();
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'), { authTagLength: 16 }); cipher.setAAD(aad(entry)); cipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      const digest = crypto.createHash('sha256'), chunk = Buffer.alloc(1024 * 1024); let position = 0;
      if (returnBuffer) output = Buffer.allocUnsafeSlow(entry.bytes);
      try { for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position); if (!bytesRead) break;
        const plain = cipher.update(chunk.subarray(0, bytesRead)); digest.update(plain); if (output) plain.copy(output, position); position += bytesRead; plain.fill(0);
      } } finally { chunk.fill(0); }
      const final = cipher.final(); digest.update(final); if (output) final.copy(output, position); position += final.length; final.fill(0);
      if (position !== entry.bytes || digest.digest('hex') !== entry.fileSha256) fail();
      return output;
    } catch (error) { output?.fill(0); if (error.code === 'IMPORT_SOURCE_ARCHIVE_INVALID') throw error; fail(); }
    finally { key.fill(0); await handle.close(); }
  }
  async function stage({ source, buffer, password = '' }) { return serial(async () => {
    writable();
    assertSourceBytes(buffer);
    if (!source || !HEX.test(source.id) || !SOURCE_KINDS.includes(source.kind) || source.fileSha256 !== hash(buffer) || source.bytes !== buffer.length || typeof password !== 'string' || Buffer.byteLength(password) > 256) fail();
    const index = await load(true), existing = entries(index).find(e => e.sourceId === source.id);
    if (existing) {
      if (existing.fileSha256 !== source.fileSha256 || existing.kind !== source.kind) fail(); await decrypt(existing);
      // A corrected retry may replace the pending unlock password, but an
      // upload can never replace proven recovery material of an applied source.
      if (existing.appliedAt === null && existing.password !== password) { existing.password = password; existing.requiresPassword = password !== ''; await save(index); }
      return publicEntry(existing);
    }
    if (confirmedEntries(index).length >= MAX_CONFIRMED) C.fail('IMPORT_SOURCE_ARCHIVE_RETENTION_LIMIT', 409);
    await cleanup(index);
    if (index.candidates.length >= MAX_CANDIDATES) C.fail('IMPORT_SOURCE_ARCHIVE_FULL', 409);
    if (entries(index).reduce((sum, e) => sum + e.bytes, 0) + buffer.length > MAX_ARCHIVE_BYTES) C.fail('IMPORT_SOURCE_ARCHIVE_FULL', 409);
    const free = await fsp.statfs(root); if (free.bavail * free.bsize < buffer.length + 1024 ** 3) C.fail('IMPORT_JOB_SPACE_REQUIRED', 507);
    const entry = { kind: source.kind, sourceId: source.id, fileSha256: source.fileSha256, bytes: buffer.length, fileName: importFileName(source.fileName), capturedAt: now(), appliedAt: null, revision: source.revision, password, requiresPassword: password !== '',
      file: crypto.randomBytes(32).toString('hex') + '.source' };
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv), encryptedHash = crypto.createHash('sha256'); cipher.setAAD(aad(entry));
    const handle = await fsp.open(target(entry.file), 'wx', 0o600);
    try {
      for (let offset = 0; offset < buffer.length; offset += 1024 * 1024) { const encrypted = cipher.update(buffer.subarray(offset, offset + 1024 * 1024)); try { encryptedHash.update(encrypted); await handle.writeFile(encrypted); } finally { encrypted.fill(0); } }
      const final = cipher.final(); try { encryptedHash.update(final); await handle.writeFile(final); } finally { final.fill(0); } await handle.sync();
      Object.assign(entry, { key: key.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), encryptedSha256: encryptedHash.digest('hex') });
    } finally { key.fill(0); iv.fill(0); await handle.close(); }
    await syncDirectory(); index.candidates.push(entry); await save(index); return publicEntry(entry);
  }); }
  async function promote({ source, publication = null, seedOnly = false }) { return serial(async () => {
    writable();
    const index = await load(false); if (!index) C.fail('IMPORT_SOURCE_ARCHIVE_REUPLOAD_REQUIRED', 409);
    const slot = index.kinds.find(s => s.kind === source.kind); if (!slot || !source.complete || !Number.isSafeInteger(source.revision) || source.revision < 1) fail();
    const applied = source.status === 'applied' && !source.catalogUpdatePending;
    const published = source.kind === 'cash' && source.storage === 'cash-compact-v1' && publication?.sourceId === source.id;
    if (!applied && !published) C.fail('IMPORT_SOURCE_ARCHIVE_NOT_APPLIED', 409);
    if (slot.current?.sourceId === source.id) {
      if (slot.current.fileSha256 !== source.fileSha256 || slot.current.bytes !== source.bytes) fail();
      await decrypt(slot.current); return publicEntry(slot.current);
    }
    const entry = entries(index).find(e => e.sourceId === source.id);
    if (!entry) C.fail('IMPORT_SOURCE_ARCHIVE_REUPLOAD_REQUIRED', 409);
    if (entry.fileSha256 !== source.fileSha256 || entry.bytes !== source.bytes || entry.kind !== source.kind) fail();
    await decrypt(entry);
    if (entry.appliedAt === null && confirmedEntries(index).length >= MAX_CONFIRMED) C.fail('IMPORT_SOURCE_ARCHIVE_RETENTION_LIMIT', 409);
    // Exact reuploads may seed a legacy installation, but an older historically
    // applied file must never displace the current successful generation merely
    // because somebody uploads it again. Cash has authoritative publication
    // readback and does not need this legacy-only admission.
    if (seedOnly && slot.current) {
      if (entry.appliedAt === null) {
        index.candidates = index.candidates.filter(e => e.sourceId !== source.id);
        (index.retained ||= []).push({ ...entry, appliedAt: now(), revision: source.revision }); await save(index);
      }
      return publicEntry(slot.current);
    }
    index.candidates = index.candidates.filter(e => e.sourceId !== source.id);
    index.retained = (index.retained || []).filter(e => e.sourceId !== source.id);
    const prior = slot.current, previous = slot.previous;
    if (previous && previous.sourceId !== entry.sourceId && previous.sourceId !== prior?.sourceId) index.retained.push(previous);
    slot.current = { ...entry, appliedAt: now(), revision: source.revision }; slot.previous = prior;
    await save(index); return publicEntry(slot.current);
  }); }
  async function requireSource(source) { return serial(async () => {
    const index = await load(false), entry = index && entries(index).find(e => e.sourceId === source.id);
    if (!entry) C.fail('IMPORT_SOURCE_ARCHIVE_REUPLOAD_REQUIRED', 409);
    if (entry.kind !== source.kind || entry.fileSha256 !== source.fileSha256 || entry.bytes !== source.bytes) fail();
    await decrypt(entry); return publicEntry(entry);
  }); }
  const availability = source => serial(async () => {
    const index = await load(false), entry = index && entries(index).find(e => e.sourceId === source.id);
    if (!entry) return false;
    if (entry.kind !== source.kind || entry.fileSha256 !== source.fileSha256 || entry.bytes !== source.bytes) fail();
    const handle = await open(entry.file, MAX_BYTES); try { if ((await handle.stat()).size !== entry.bytes) fail(); } finally { await handle.close(); }
    return true;
  });
  async function discard(sourceId) { return serial(async () => {
    writable();
    if (!HEX.test(sourceId)) fail(); const index = await load(false); if (!index) return;
    const pending = index.candidates.filter(e => e.sourceId !== sourceId); if (pending.length === index.candidates.length) return;
    index.candidates = pending; await save(index);
  }); }
  async function verifiedSnapshot({ allowMissing = true, referenceOnly = false } = {}) {
    if (typeof referenceOnly !== 'boolean') fail();
    const initial = await directoryState(false) && (await fsp.readdir(root)).includes(INDEX) ? await encryptedFile(INDEX) : null;
    const index = await load(false); if (!index && !allowMissing) fail();
    if (!initial && !allowMissing) fail();
    if (referenceOnly && initial && (index?.version !== 2 || entries(index).some(entry => !HEX.test(entry.encryptedSha256 || '')))) C.fail('IMPORT_SOURCE_ARCHIVE_REFERENCE_UNSUPPORTED', 409);
    const files = initial ? [initial] : [];
    if (index) { for (const entry of entries(index).sort((a, b) => a.file.localeCompare(b.file))) {
      if (referenceOnly) files.push({ file: entry.file, bytes: entry.bytes, sha256: entry.encryptedSha256 });
      else {
        await decrypt(entry); const file = await encryptedFile(entry.file);
        if (entry.encryptedSha256 !== undefined && file.sha256 !== entry.encryptedSha256) fail(); files.push(file);
      }
    } }
    if (initial && JSON.stringify(initial) !== JSON.stringify(await encryptedFile(INDEX))) fail();
    return snapshot(index, files);
  }
  const verify = options => serial(() => verifiedSnapshot(options));
  async function referenceSnapshot({ directory: destination, verifyObjects = false } = {}) { return serial(async () => {
    if (typeof destination !== 'string' || !path.isAbsolute(destination) || typeof verifyObjects !== 'boolean') fail();
    const targetRoot = path.resolve(destination);
    if ([root, objects].some(source => targetRoot === source || targetRoot.startsWith(source + path.sep) || source.startsWith(targetRoot + path.sep))) fail();
    const proof = await verifiedSnapshot({ allowMissing: false, referenceOnly: !verifyObjects });
    // A legacy full verification cannot make missing stored receipts eligible.
    await verifiedSnapshot({ allowMissing: false, referenceOnly: true });
    let state; try { state = await fsp.lstat(targetRoot); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!state) {
      if (path.resolve(await fsp.realpath(path.dirname(targetRoot))) !== path.dirname(targetRoot)) fail();
      await fsp.mkdir(targetRoot, { mode: 0o700 }); state = await fsp.lstat(targetRoot);
    }
    const targetUid = process.getuid?.();
    if (!state.isDirectory() || state.isSymbolicLink() || path.resolve(await fsp.realpath(targetRoot)) !== targetRoot
      || targetUid !== undefined && (state.uid !== targetUid || state.mode & 0o077) || (await fsp.readdir(targetRoot)).length) fail();
    const source = await open(INDEX, INDEX_LIMIT); let bytes;
    try { bytes = await source.readFile(); } finally { await source.close(); }
    if (hash(bytes) !== proof.files[0].sha256 || bytes.length !== proof.files[0].bytes) { bytes.fill(0); fail(); }
    const file = await fsp.open(path.join(targetRoot, INDEX), 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { bytes.fill(0); await file.close(); }
    if (process.platform !== 'win32') { const parent = await fsp.open(targetRoot, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
    const frozen = await createImportSourceArchive({ directory: targetRoot, vault, expectedUid: targetUid, readOnly: true }).verify({ allowMissing: false, referenceOnly: true });
    if (frozen.generationSha256 !== proof.generationSha256) fail();
    return frozen;
  }); }
  async function useFile(sourceId, consumer) { return serial(async () => {
    if (!HEX.test(sourceId) || typeof consumer !== 'function') fail();
    const index = await load(false), entry = index && confirmedEntries(index).find(entry => entry.sourceId === sourceId);
    if (!entry) C.fail('IMPORT_SOURCE_ARCHIVE_NOT_FOUND', 404);
    const buffer = await decrypt(entry, true);
    try { return await consumer({ buffer, password: entry.password, source: publicEntry(entry) }); } finally { buffer.fill(0); }
  }); }
  const maintenance = () => serial(async () => { writable(); const index = await load(true); await cleanup(index); });
  return Object.freeze({ stage, promote, requireSource, availability, discard, verify, referenceSnapshot, useFile, maintenance, status: () => verify(),
    useSource: (kind, { generation = 'current', sourceId } = {}, consumer) => serial(async () => {
      if (!SOURCE_KINDS.includes(kind) || !['current', 'previous'].includes(generation) || typeof consumer !== 'function') fail();
      const index = await load(false);
      if (sourceId !== undefined && !HEX.test(sourceId)) fail();
      const entry = sourceId === undefined ? index?.kinds.find(s => s.kind === kind)?.[generation] : index && confirmedEntries(index).find(e => e.sourceId === sourceId && e.kind === kind);
      if (!entry) C.fail('IMPORT_SOURCE_ARCHIVE_NOT_FOUND', 404);
      const buffer = await decrypt(entry, true); try { return await consumer({ buffer, password: entry.password, source: publicEntry(entry) }); } finally { buffer.fill(0); }
    }),
    read: (kind, { generation = 'current' } = {}) => serial(async () => { if (!SOURCE_KINDS.includes(kind) || !['current', 'previous'].includes(generation)) fail(); const entry = (await load(false))?.kinds.find(s => s.kind === kind)?.[generation]; if (!entry) C.fail('IMPORT_SOURCE_ARCHIVE_NOT_FOUND', 404); return decrypt(entry, true); }) });
}
async function verifyImportSourceArchive({ directory, objectDirectory, vault, allowMissing = true, referenceOnly = false, expectedUid, objectExpectedUid }) {
  return createImportSourceArchive({ directory, objectDirectory, vault, expectedUid, objectExpectedUid, readOnly: true }).verify({ allowMissing, referenceOnly });
}
async function writeImportSourceArchiveReference({ sourceDirectory, targetDirectory, vault, objectDirectory, expectedUid, objectExpectedUid, verifyObjects = false }) {
  return createImportSourceArchive({ directory: sourceDirectory, objectDirectory, vault, expectedUid, objectExpectedUid, readOnly: true }).referenceSnapshot({ directory: targetDirectory, verifyObjects });
}
module.exports = { createImportSourceArchive, verifyImportSourceArchive, writeImportSourceArchiveReference, validateImportSourceArchiveProof, appliedImportSourceArchiveEntries, MAX_CONFIRMED, MAX_CANDIDATES, MAX_ARCHIVE_BYTES };

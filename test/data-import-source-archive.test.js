'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), fsp = fs.promises, os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createImportSourceArchive, verifyImportSourceArchive, writeImportSourceArchiveReference, validateImportSourceArchiveProof, appliedImportSourceArchiveEntries, MAX_CONFIRMED, MAX_CANDIDATES } = require('../lib/data-import-source-archive');
const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
const { createDataImportJobs } = require('../lib/data-import-jobs');
const { createDataImportLifecycle } = require('../lib/data-import-lifecycle');
const { DATA_IMPORT_PERMISSIONS: P } = require('../lib/data-import-access');

function input(label, kind = 'trade') {
  const buffer = Buffer.alloc(4096); buffer.write('Standard ACE DB', 4); buffer[0x14] = 3; buffer.write(label, 256);
  return { buffer, source: { id: crypto.createHash('sha256').update(kind + label).digest('hex'), kind, bytes: buffer.length, fileSha256: crypto.createHash('sha256').update(buffer).digest('hex'), fileName: 'Trade_Daten.accdb', complete: false, status: 'reviewing', revision: 1 } };
}
const applied = value => ({ ...value, complete: true, status: 'applied', revision: value.revision + 1 });
async function fixture(t) {
  const parent = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'gp-source-archive-')), directory = path.join(parent, 'import-sources');
  const vault = createIntegrationSecretVault({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 7) } });
  const make = (options = {}) => createImportSourceArchive({ directory, vault, ...options }), archive = make();
  t.after(async () => { assert.equal(path.dirname(await fsp.realpath(parent)), await fsp.realpath(os.tmpdir())); await fsp.rm(parent, { recursive: true, force: true }); });
  return { parent, directory, vault, make, archive };
}

test('only acknowledged applied sources rotate current/previous; newer candidates never evict success', async t => {
  const f = await fixture(t), first = input('first-private-source'), second = input('second-private-source'), third = input('third-private-source');
  assert.equal((await f.archive.verify()).available, false);
  await f.archive.stage(first);
  assert.equal((await f.archive.verify()).available, false);
  await assert.rejects(f.archive.promote({ source: { ...first.source, complete: true } }), { code: 'IMPORT_SOURCE_ARCHIVE_NOT_APPLIED' });
  await f.archive.promote({ source: applied(first.source) });
  const generation = (await f.archive.status()).generationSha256;
  await f.archive.promote({ source: applied(first.source) });
  assert.equal((await f.archive.status()).generationSha256, generation, 'retrying acknowledgement is idempotent');
  await f.archive.stage(second);
  assert.deepEqual(await f.archive.read('trade'), first.buffer);
  await f.archive.promote({ source: applied(second.source) });
  await f.archive.stage(third);
  await f.archive.promote({ source: applied(third.source) });
  const restored = f.make(), status = await restored.verify();
  assert.equal(status.kinds.find(s => s.kind === 'trade').current.sourceId, third.source.id);
  assert.equal(status.kinds.find(s => s.kind === 'trade').previous.sourceId, second.source.id);
  assert.equal(status.candidates.length, 0);
  assert.deepEqual(await restored.read('trade', { generation: 'previous' }), second.buffer);
  assert.equal((await fsp.readdir(f.directory)).filter(name => name.endsWith('.source')).length, 3);
  assert.equal(status.retained[0].sourceId, first.source.id);
  let historical;
  await restored.useFile(first.source.id, ({ buffer }) => { historical = buffer; assert.deepEqual(buffer, first.buffer); });
  assert.ok(historical.every(byte => byte === 0));
  await restored.discard(third.source.id);
  assert.deepEqual(await restored.read('trade'), third.buffer, 'explicit candidate deletion cannot remove recovery success');
  await restored.promote({ source: applied(second.source), seedOnly: true });
  assert.deepEqual(await restored.read('trade'), third.buffer, 'reuploading an older historically applied file never replaces current success');
});

test('all six source kinds retain confirmed older generations without allowing candidates to replace recovery heads', async t => {
  const f = await fixture(t), kinds = require('../lib/data-import-source-catalog').SOURCE_KINDS;
  for (const kind of kinds) {
    const values = [input(kind + '-one', kind), input(kind + '-two', kind), input(kind + '-three', kind)];
    for (const value of values) { await f.archive.stage(value); await f.archive.promote({ source: applied(value.source) }); }
    await f.archive.discard(values[0].source.id);
    await f.archive.useFile(values[0].source.id, ({ buffer, source }) => { assert.deepEqual(buffer, values[0].buffer); assert.equal(source.kind, kind); });
    const candidate = input(kind + '-candidate', kind); await f.archive.stage(candidate);
    await assert.rejects(f.archive.useFile(candidate.source.id, () => {}), { code: 'IMPORT_SOURCE_ARCHIVE_NOT_FOUND' });
    await f.archive.discard(candidate.source.id);
  }
  const proof = await f.archive.verify(), entries = appliedImportSourceArchiveEntries(proof);
  assert.equal(proof.retained.length, 6); assert.equal(entries.length, 18);
  for (const kind of kinds) assert.equal(entries.filter(entry => entry.kind === kind).length, 3);
  await f.archive.maintenance(); assert.equal((await fsp.readdir(f.directory)).filter(name => name.endsWith('.source')).length, 18);
});

test('historical exact reupload can fill retained recovery material without changing the current successful head', async t => {
  const f = await fixture(t), current = input('current head'), historical = input('old proven head');
  await f.archive.stage(current); await f.archive.promote({ source: applied(current.source) });
  await f.archive.stage(historical); await f.archive.promote({ source: applied(historical.source), seedOnly: true });
  assert.equal((await f.archive.verify()).kinds[0].current.sourceId, current.source.id);
  assert.equal((await f.archive.verify()).retained[0].sourceId, historical.source.id);
  await f.archive.useFile(historical.source.id, ({ buffer }) => assert.deepEqual(buffer, historical.buffer));
});

test('a frozen reference contains only the authenticated index and resolves old originals by exact source id', async t => {
  const f = await fixture(t), first = input('reference-one'), second = input('reference-two'), third = input('reference-three');
  for (const value of [first, second, third]) { await f.archive.stage(value); await f.archive.promote({ source: applied(value.source) }); }
  const proof = await f.archive.verify(), targetDirectory = path.join(f.parent, 'reference');
  const frozen = await writeImportSourceArchiveReference({ sourceDirectory: f.directory, targetDirectory, vault: f.vault });
  assert.deepEqual(frozen, proof); assert.deepEqual(await fsp.readdir(targetDirectory), ['index.source-archive']);
  assert.deepEqual(await fsp.readFile(path.join(targetDirectory, 'index.source-archive')), await fsp.readFile(path.join(f.directory, 'index.source-archive')));
  assert.deepEqual(await verifyImportSourceArchive({ directory: targetDirectory, vault: f.vault, referenceOnly: true, allowMissing: false }), proof);
  await assert.rejects(verifyImportSourceArchive({ directory: targetDirectory, vault: f.vault, allowMissing: false }));
  const reader = createImportSourceArchive({ directory: targetDirectory, objectDirectory: f.directory, vault: f.vault, readOnly: true });
  await reader.useFile(first.source.id, ({ buffer }) => assert.deepEqual(buffer, first.buffer));
  assert.deepEqual(await reader.verify(), proof);
  const fourth = input('reference-four'); await f.archive.stage(fourth); await f.archive.promote({ source: applied(fourth.source) });
  assert.notEqual((await f.archive.verify()).generationSha256, proof.generationSha256);
  assert.deepEqual(await reader.verify(), proof, 'the frozen index does not follow later live head rotation');
  await reader.useFile(first.source.id, ({ buffer }) => assert.deepEqual(buffer, first.buffer));
  await assert.rejects(reader.useFile(fourth.source.id, () => {}), { code: 'IMPORT_SOURCE_ARCHIVE_NOT_FOUND' });
});

test('references authenticate receipts without opening large object files, while full verification rejects missing/corrupt objects', async t => {
  const f = await fixture(t), value = input('reference object'); await f.archive.stage(value); await f.archive.promote({ source: applied(value.source) });
  const targetDirectory = path.join(f.parent, 'reference'); const proof = await f.archive.referenceSnapshot({ directory: targetDirectory });
  const object = proof.files.find(file => file.file.endsWith('.source')), file = path.join(f.directory, object.file), bytes = await fsp.readFile(file);
  await fsp.unlink(file);
  assert.deepEqual(await verifyImportSourceArchive({ directory: targetDirectory, vault: f.vault, referenceOnly: true }), proof);
  await assert.rejects(verifyImportSourceArchive({ directory: targetDirectory, objectDirectory: f.directory, vault: f.vault }));
  const corrupt = Buffer.from(bytes); corrupt[0] ^= 1; await fsp.writeFile(file, corrupt, { mode: 0o600 });
  await assert.rejects(createImportSourceArchive({ directory: targetDirectory, objectDirectory: f.directory, vault: f.vault, readOnly: true }).useFile(value.source.id, () => {}));
  await fsp.writeFile(file, bytes);
  const index = path.join(targetDirectory, 'index.source-archive'), saved = await fsp.readFile(index), changed = Buffer.from(saved); changed[changed.length - 12] ^= 1; await fsp.writeFile(index, changed);
  await assert.rejects(verifyImportSourceArchive({ directory: targetDirectory, vault: f.vault, referenceOnly: true }));
  await fsp.writeFile(index, saved); await fsp.unlink(index);
  await assert.rejects(verifyImportSourceArchive({ directory: targetDirectory, vault: f.vault, referenceOnly: true, allowMissing: false }));
});

test('reference copies reject overlapping or nonempty destinations and external object aliases fail closed', async t => {
  const f = await fixture(t), value = input('private reference boundaries'); await f.archive.stage(value); await f.archive.promote({ source: applied(value.source) });
  await assert.rejects(f.archive.referenceSnapshot({ directory: path.join(f.directory, 'nested-reference') }), { code: 'IMPORT_SOURCE_ARCHIVE_INVALID' });
  assert.equal(await fsp.stat(path.join(f.directory, 'nested-reference')).then(() => true, () => false), false);
  await assert.rejects(f.archive.referenceSnapshot({ directory: f.directory }), { code: 'IMPORT_SOURCE_ARCHIVE_INVALID' });
  const nonempty = path.join(f.parent, 'nonempty'); await fsp.mkdir(nonempty, { mode: 0o700 }); await fsp.writeFile(path.join(nonempty, 'keep.txt'), 'keep');
  await assert.rejects(f.archive.referenceSnapshot({ directory: nonempty }), { code: 'IMPORT_SOURCE_ARCHIVE_INVALID' }); assert.equal(await fsp.readFile(path.join(nonempty, 'keep.txt'), 'utf8'), 'keep');
  const reference = path.join(f.parent, 'safe-reference'); await f.archive.referenceSnapshot({ directory: reference });
  const alias = path.join(f.parent, 'object-alias'); await fsp.symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createImportSourceArchive({ directory: reference, objectDirectory: alias, vault: f.vault, readOnly: true }).useFile(value.source.id, () => {}));
  await fsp.unlink(alias);
  const index = path.join(reference, 'index.source-archive'), extra = path.join(f.parent, 'index-hardlink'); await fsp.link(index, extra);
  await assert.rejects(verifyImportSourceArchive({ directory: reference, vault: f.vault, referenceOnly: true }), { code: 'IMPORT_SOURCE_ARCHIVE_INVALID' }); await fsp.unlink(extra);
  if (process.getuid) await assert.rejects(createImportSourceArchive({ directory: reference, objectDirectory: f.directory, objectExpectedUid: process.getuid() + 1, vault: f.vault, readOnly: true }).useFile(value.source.id, () => {}));
});

async function privateIndex(f) {
  const outer = JSON.parse(await fsp.readFile(path.join(f.directory, 'index.source-archive'), 'utf8')); let result;
  await f.vault.useSecret(outer.envelope, { namespace: 'data-import-source-archive', connectorId: 'applied-access-sources-v1', field: 'index-and-file-keys', purpose: 'source-archive-and-recovery' }, bytes => {
    const metadata = JSON.parse(bytes), key = Buffer.from(metadata.key, 'base64');
    try { const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(metadata.iv, 'base64')); decipher.setAAD(Buffer.from('gp-applied-access-source-index-v2')); decipher.setAuthTag(Buffer.from(metadata.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(outer.payload, 'base64')), decipher.final()]); try { result = JSON.parse(plaintext); } finally { plaintext.fill(0); }
    } finally { key.fill(0); }
  }); return result;
}

test('legacy sealed indexes remain fully readable and safely upgrade without inventing missing cipher receipts', async t => {
  const f = await fixture(t), value = input('legacy successful'); await f.archive.stage(value); await f.archive.promote({ source: applied(value.source) });
  const legacy = await privateIndex(f); legacy.version = 1; delete legacy.retained;
  for (const slot of legacy.kinds) for (const generation of ['current', 'previous']) if (slot[generation]) delete slot[generation].encryptedSha256;
  const context = { namespace: 'data-import-source-archive', connectorId: 'applied-access-sources-v1', field: 'index-and-file-keys', purpose: 'source-archive-and-recovery' };
  await fsp.writeFile(path.join(f.directory, 'index.source-archive'), f.vault.seal(Buffer.from(JSON.stringify(legacy)), context));
  await f.make().useFile(value.source.id, ({ buffer }) => assert.deepEqual(buffer, value.buffer));
  assert.equal((await f.archive.verify()).available, true);
  await assert.rejects(f.archive.verify({ referenceOnly: true }), { code: 'IMPORT_SOURCE_ARCHIVE_REFERENCE_UNSUPPORTED' });
  const next = input('new after legacy'); await f.archive.stage(next); await f.archive.promote({ source: applied(next.source) });
  const proof = await f.archive.verify(); assert.deepEqual(await f.archive.verify({ referenceOnly: true }), proof);
  await f.archive.useFile(value.source.id, ({ buffer }) => assert.deepEqual(buffer, value.buffer));
});

test('retained metadata grows beyond the old vault envelope limit without dropping originals', async t => {
  const f = await fixture(t), values = [];
  for (let i = 0; i < 150; i++) { const value = input('metadata-source-' + i); values.push(value); await f.archive.stage(value); await f.archive.promote({ source: applied(value.source) }); }
  const index = await privateIndex(f); assert.ok(Buffer.byteLength(JSON.stringify(index)) > 65536);
  const proof = await f.archive.verify({ referenceOnly: true }); assert.equal(appliedImportSourceArchiveEntries(proof).length, 150);
  await f.archive.useFile(values[0].source.id, ({ buffer }) => assert.deepEqual(buffer, values[0].buffer));
  const altered = structuredClone(proof); altered.retained[0].fileSha256 = 'f'.repeat(64); assert.throws(() => validateImportSourceArchiveProof(altered));
  assert.equal(MAX_CONFIRMED, 10000);
});

test('the retained-generation cap rejects a new upload or promotion without deleting confirmed originals or changing the index', async t => {
  const f = await fixture(t), first = input('retention-cap-head'), pending = input('retention-cap-pending');
  await f.archive.stage(first); await f.archive.promote({ source: applied(first.source) }); await f.archive.stage(pending);
  const index = await privateIndex(f), head = index.kinds[0].current;
  // A sealed synthetic metadata fixture exercises the cap without allocating
  // 10,000 source databases. No reconstruction claim is made for those stubs.
  index.retained = Array.from({ length: MAX_CONFIRMED - 1 }, (_, i) => {
    const id = crypto.createHash('sha256').update('retention-cap-stub-' + i).digest('hex'); return { ...head, sourceId: id, file: id + '.source' };
  });
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from('gp-applied-access-source-index-v2'));
  const plain = Buffer.from(JSON.stringify(index)), payload = Buffer.concat([cipher.update(plain), cipher.final()]);
  const metadata = Buffer.from(JSON.stringify({ version: 2, key: key.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), bytes: plain.length, sha256: crypto.createHash('sha256').update(plain).digest('hex') }));
  const envelope = f.vault.seal(metadata, { namespace: 'data-import-source-archive', connectorId: 'applied-access-sources-v1', field: 'index-and-file-keys', purpose: 'source-archive-and-recovery' });
  const encoded = JSON.stringify({ format: 'gp-applied-access-source-index-v2', version: 2, envelope, payload: payload.toString('base64') });
  plain.fill(0); metadata.fill(0); key.fill(0); iv.fill(0); payload.fill(0);
  const file = path.join(f.directory, 'index.source-archive'); await fsp.writeFile(file, encoded);
  const before = await fsp.readdir(f.directory);
  await assert.rejects(f.make().stage(input('cannot-upload-at-cap')), { code: 'IMPORT_SOURCE_ARCHIVE_RETENTION_LIMIT' });
  await assert.rejects(f.make().promote({ source: applied(pending.source) }), { code: 'IMPORT_SOURCE_ARCHIVE_RETENTION_LIMIT' });
  assert.equal(await fsp.readFile(file, 'utf8'), encoded); assert.deepEqual(await fsp.readdir(f.directory), before);
});

test('the encrypted private archive recovers with existing vault keys and never exports password or file keys', async t => {
  const f = await fixture(t), value = input('sensitive source bytes'), password = 'Access-unlock-private-4711';
  await f.archive.stage({ ...value, password }); await f.archive.promote({ source: applied(value.source) });
  const copyDirectory = path.join(f.parent, 'recovered'); await fsp.cp(f.directory, copyDirectory, { recursive: true });
  const restored = createImportSourceArchive({ directory: copyDirectory, vault: f.vault });
  const proof = await verifyImportSourceArchive({ directory: copyDirectory, vault: f.vault });
  assert.equal(proof.kinds.find(s => s.kind === 'trade').current.requiresPassword, true);
  for (const forbidden of [password, '"password"', '"key"', '"iv"', '"tag"']) assert.equal(JSON.stringify(proof).includes(forbidden), false);
  for (const name of await fsp.readdir(copyDirectory)) {
    const disk = await fsp.readFile(path.join(copyDirectory, name)); assert.equal(disk.includes(Buffer.from(password)), false); assert.equal(disk.includes(Buffer.from('sensitive source bytes')), false);
  }
  let borrowed;
  await restored.useSource('trade', {}, async ({ buffer, password: recovered, source }) => { borrowed = buffer; assert.deepEqual(buffer, value.buffer); assert.equal(recovered, password); assert.equal(source.sourceId, value.source.id); });
  assert.ok(borrowed.every(byte => byte === 0));
  await assert.rejects(restored.useSource('trade', {}, async ({ buffer }) => { borrowed = buffer; throw new Error('consumer failed'); }), /consumer failed/);
  assert.ok(borrowed.every(byte => byte === 0));
  const wrong = createIntegrationSecretVault({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 8) } });
  await assert.rejects(verifyImportSourceArchive({ directory: copyDirectory, vault: wrong }));
});

test('cash promotion requires the exact active publication and a committed source snapshot', async t => {
  const f = await fixture(t), cash = input('private cash source', 'cash'); await f.archive.stage(cash);
  const source = { ...cash.source, complete: true, status: 'ready', storage: 'cash-compact-v1' };
  await assert.rejects(f.archive.promote({ source, publication: { sourceId: 'f'.repeat(64) } }), { code: 'IMPORT_SOURCE_ARCHIVE_NOT_APPLIED' });
  await f.archive.promote({ source, publication: { sourceId: source.id } });
  assert.equal((await f.archive.verify()).kinds.find(s => s.kind === 'cash').current.sourceId, source.id);
});

test('failed index commits preserve the prior success and retryable candidate after reconstruction', async t => {
  const f = await fixture(t), old = input('old'), next = input('new');
  await f.archive.stage(old); await f.archive.promote({ source: applied(old.source) }); await f.archive.stage(next);
  const broken = f.make({ vault: { ...f.vault, seal() { throw new Error('synthetic unavailable index write'); } } });
  await assert.rejects(broken.promote({ source: applied(next.source) }), /unavailable index write/);
  const restarted = f.make(); assert.deepEqual(await restarted.read('trade'), old.buffer);
  await restarted.requireSource(next.source); await restarted.promote({ source: applied(next.source) });
  assert.deepEqual(await restarted.read('trade'), next.buffer); assert.deepEqual(await restarted.read('trade', { generation: 'previous' }), old.buffer);
});

test('ciphertext corruption, missing generation files, hardlinks and missing index fail closed', async t => {
  const f = await fixture(t), value = input('must authenticate'); await f.archive.stage(value); await f.archive.promote({ source: applied(value.source) });
  const name = (await fsp.readdir(f.directory)).find(n => n.endsWith('.source')), file = path.join(f.directory, name), original = await fsp.readFile(file);
  const changed = Buffer.from(original); changed[changed.length - 1] ^= 1; await fsp.writeFile(file, changed);
  await assert.rejects(f.archive.verify(), { code: 'IMPORT_SOURCE_ARCHIVE_INVALID' });
  await assert.rejects(f.archive.read('trade'), { code: 'IMPORT_SOURCE_ARCHIVE_INVALID' });
  await fsp.writeFile(file, original); const other = path.join(f.parent, 'hardlink'); await fsp.link(file, other);
  await assert.rejects(f.archive.verify(), { code: 'IMPORT_SOURCE_ARCHIVE_INVALID' }); await fsp.unlink(other);
  await fsp.unlink(file); await assert.rejects(f.archive.verify());
  await fsp.writeFile(file, original, { mode: 0o600 }); await fsp.unlink(path.join(f.directory, 'index.source-archive'));
  await assert.rejects(f.archive.verify(), { code: 'IMPORT_SOURCE_ARCHIVE_INVALID' });
});

test('candidate capacity is bounded and removal frees only candidates; corrected retries update sealed unlock material', async t => {
  const f = await fixture(t), items = [];
  for (let i = 0; i < MAX_CANDIDATES; i++) { const value = input('candidate-' + i); items.push(value); await f.archive.stage({ ...value, password: 'wrong' }); }
  await assert.rejects(f.archive.stage(input('too-many')), { code: 'IMPORT_SOURCE_ARCHIVE_FULL' });
  await f.archive.stage({ ...items[0], password: 'corrected' }); await f.archive.promote({ source: applied(items[0].source) });
  await f.archive.useSource('trade', {}, ({ password }) => assert.equal(password, 'corrected'));
  await f.archive.stage({ ...items[0], password: 'unproven replacement' });
  await f.archive.useSource('trade', {}, ({ password }) => assert.equal(password, 'corrected'));
  await f.archive.discard(items[1].source.id); await f.archive.stage(input('room-for-another'));
  await assert.rejects(f.archive.requireSource(items[1].source), { code: 'IMPORT_SOURCE_ARCHIVE_REUPLOAD_REQUIRED' });
});

test('the public recovery proof binds the exact encrypted index and generation files without exposing secrets', async t => {
  const f = await fixture(t), value = input('bound generation'); await f.archive.stage(value); await f.archive.promote({ source: applied(value.source) });
  const proof = await f.archive.verify(); assert.equal(validateImportSourceArchiveProof(proof), proof);
  assert.equal(proof.files.length, 2); assert.equal(proof.files[0].file, 'index.source-archive');
  for (const entry of proof.files) { const bytes = await fsp.readFile(path.join(f.directory, entry.file)); assert.equal(entry.bytes, bytes.length); assert.equal(entry.sha256, crypto.createHash('sha256').update(bytes).digest('hex')); }
  const missing = structuredClone(proof); missing.files.pop(); assert.throws(() => validateImportSourceArchiveProof(missing), { code: 'IMPORT_SOURCE_ARCHIVE_INVALID' });
  const altered = structuredClone(proof); altered.files[1].sha256 = 'f'.repeat(64); assert.throws(() => validateImportSourceArchiveProof(altered), { code: 'IMPORT_SOURCE_ARCHIVE_INVALID' });
  const leaked = structuredClone(proof); leaked.kinds[0].current.password = 'must reject unknown secret-bearing metadata'; assert.throws(() => validateImportSourceArchiveProof(leaked), { code: 'IMPORT_SOURCE_ARCHIVE_INVALID' });
  const reader = f.make({ readOnly: true }); await assert.rejects(reader.stage(input('write denied')), { code: 'IMPORT_SOURCE_ARCHIVE_READ_ONLY' }); await assert.rejects(reader.maintenance(), { code: 'IMPORT_SOURCE_ARCHIVE_READ_ONLY' });
  assert.deepEqual(await reader.verify(), proof);
});

test('writer maintenance removes only validated crash leftovers and retains committed generation files', async t => {
  const f = await fixture(t), value = input('committed source'); await f.archive.stage(value); await f.archive.promote({ source: applied(value.source) });
  const pending = path.join(f.directory, 'a'.repeat(32) + '.pending'), orphan = path.join(f.directory, 'a'.repeat(64) + '.source');
  await fsp.writeFile(pending, 'sealed but uncommitted index', { mode: 0o600 }); await fsp.writeFile(orphan, 'uncommitted ciphertext', { mode: 0o600 });
  await f.make().maintenance(); assert.equal((await fsp.readdir(f.directory)).length, 2); assert.deepEqual(await f.archive.read('trade'), value.buffer);
  const foreign = path.join(f.directory, 'unexpected'); await fsp.mkdir(foreign); await assert.rejects(f.archive.maintenance(), { code: 'IMPORT_SOURCE_ARCHIVE_INVALID' });
  await fsp.rmdir(foreign);
});

test('background apply preserves archive candidates through review, restart and a lost commit acknowledgement', async t => {
  const f = await fixture(t), value = input('queue source'); let source = { ...value.source, activationEnabled: true }, loseReply = true, applyCalls = 0;
  const principal = { employeeNumber: 'synthetic', accountId: null, isEmployee: true, permissions: [...Object.values(P),'sales:analytics:access','sales:analytics:company:read'] }, get = async () => principal;
  const runtime = { reserve: async () => ({ ...source }), verificationRequest: async () => null, attachIndependentCountProof: async () => {},
    upload: async () => { source = { ...source, complete: true, status: 'reviewing' }; return { ...source }; },
    sourceOperation: async (_get, id, action) => { assert.equal(id, source.id); if (action === 'review') source.status = 'ready'; if (action === 'apply') { applyCalls++; source = { ...applied(source), activationEnabled: true }; if (loseReply) { loseReply = false; throw Object.assign(new Error('lost reply'), { code: 'PERSISTENCE_CONNECTION_UNAVAILABLE' }); } } return { ...source }; } };
  let now = Date.now(), queue;
  const make = () => queue = createDataImportJobs({ directory: path.join(f.parent, 'jobs'), vault: f.vault, runtime, sourceArchive: f.make(), resolvePrincipal: get, lifecycle: createDataImportLifecycle(), now: () => now });
  make(); t.after(async () => { await queue.stop(); });
  await queue.enqueue(get, { ...value, kind: 'trade', fileName: source.fileName, password: 'queue-only-access-password' }); await queue.tick();
  assert.equal(source.status, 'ready'); assert.equal((await f.archive.status()).available, false); assert.equal((await f.archive.status()).candidates.length, 1);
  await queue.enqueueApply(get, source.id, { expectedRevision: source.revision }); await queue.tick();
  assert.equal(source.status, 'applied'); assert.equal((await f.archive.status()).available, false);
  await queue.stop(); now += 30001; make(); await queue.tick();
  assert.equal(applyCalls, 1); assert.equal((await f.archive.verify()).kinds.find(s => s.kind === 'trade').current.sourceId, source.id);
  await f.archive.useSource('trade', {}, ({ buffer, password }) => { assert.deepEqual(buffer, value.buffer); assert.equal(password, 'queue-only-access-password'); });
  assert.deepEqual(await fsp.readdir(path.join(f.parent, 'jobs')), []);
});

test('legacy staged imports still apply without an original and never manufacture a recovery generation',async t=>{
 const f=await fixture(t),value=input('legacy staged source');let source={...value.source,complete:true,status:'ready',activationEnabled:true},writes=0;
 const principal={employeeNumber:'synthetic',isEmployee:true,permissions:[...Object.values(P),'sales:analytics:access','sales:analytics:company:read']},get=async()=>principal;
 const runtime={verificationRequest:async()=>null,attachIndependentCountProof:async()=>{},sourceOperation:async(_get,_id,action)=>{if(action==='apply'){writes++;source=applied(source);}return {...source};}};
 const queue=createDataImportJobs({directory:path.join(f.parent,'jobs'),vault:f.vault,runtime,sourceArchive:f.archive,resolvePrincipal:get,lifecycle:createDataImportLifecycle()});t.after(()=>queue.stop());
 const admitted=await queue.enqueueApply(get,source.id,{expectedRevision:1});assert.equal(admitted.sourceRecoveryAvailable,false);
 await queue.tick();assert.equal(writes,1);assert.equal(source.status,'applied');assert.equal((await f.archive.verify()).available,false);assert.equal((await queue.overlay(source)).sourceRecoveryAvailable,false);
});

test('manual cash activation preserves the checked plan, blocks corrupt retained originals, and promotes only exact readback',async t=>{
 const f=await fixture(t),value=input('manual cash','cash'),source={...value.source,complete:true,status:'ready',storage:'cash-compact-v1'};
 const principal={employeeNumber:'synthetic',isEmployee:true,permissions:[...Object.values(P),'sales:analytics:access','sales:analytics:company:read']},get=async()=>principal;
 let active=null,writes=0;const inputPlan={request:{sourceId:source.id,expectedRevision:0,mappings:[],label:'checked manual plan'},planHash:'b'.repeat(64)};
 const runtime={verificationRequest:async()=>null,attachIndependentCountProof:async()=>{},sourceOperation:async()=>({...source})};
 const cashPublications={operation:async(_get,action,input)=>{if(action==='status')return {sourceId:active,revision:writes};assert.equal(action,'activate');assert.deepEqual(input,inputPlan);writes++;active=source.id;return {label:'checked manual plan'};}};
 const queue=createDataImportJobs({directory:path.join(f.parent,'jobs'),vault:f.vault,runtime,cashPublications,sourceArchive:f.archive,resolvePrincipal:get,lifecycle:createDataImportLifecycle()});t.after(()=>queue.stop());
 await f.archive.stage(value);const file=path.join(f.directory,(await fsp.readdir(f.directory)).find(n=>n.endsWith('.source'))),bytes=await fsp.readFile(file),bad=Buffer.from(bytes);bad[0]^=1;await fsp.writeFile(file,bad);
 await assert.rejects(queue.activateCashPublication(get,inputPlan),{code:'IMPORT_SOURCE_ARCHIVE_INVALID'});assert.equal(writes,0);
 await fsp.writeFile(file,bytes);const result=await queue.activateCashPublication(get,inputPlan);assert.equal(result.sourceRecoveryAvailable,true);assert.equal(writes,1);assert.equal((await f.archive.verify()).kinds.find(s=>s.kind==='cash').current.sourceId,source.id);
});

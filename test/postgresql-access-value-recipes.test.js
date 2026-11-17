'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const C = require('../lib/data-import-contract');
const M = require('../lib/tradefoto-master-profiles');
const H = require('../lib/tradefoto-history-profiles');
const S = require('../lib/tradefoto-full-import-source');
const P = require('../lib/tradefoto-article-source-profile');
const { SOURCE_KINDS } = require('../lib/data-import-source-catalog');
const { validateImportSourceArchiveProof } = require('../lib/data-import-source-archive');
const { buildSourceDictionary, materializeReferences, validateReference, referenceHash } = require('../lib/persistence/postgresql/operations/access-value-recipes');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

// These are protocol fixtures, not Access parser qualification. The production
// reader remains the default; native tests exercise the pinned actual parser.
function prepared(def, entry, ordinal = 1, label = entry.kind) {
  return Object.fromEntries(def.profile.fields.map(field => {
    let value = field.nullable && !def.profile.keyFields.includes(field.source) ? null : {
      identifier: label + '-' + ordinal, guid: '00000000-0000-4000-8000-000000000001', text: label, source_text: label,
      integer: ordinal, boolean: true, decimal: '1', source_decimal: '1', date: '2026-11-16', time: '12:00:00', civil_datetime: '2026-11-16T12:00:00',
    }[field.type];
    if (field.source === '_source_snapshot_sha256') value = entry.fileSha256;
    if (field.source === '_source_row') value = ordinal;
    return [field.source, value];
  }));
}
function fixture(specifications = SOURCE_KINDS.map(kind => ({ kind }))) {
  const sources = specifications.map(({ kind, label = kind, generation = 'current', table, rows, password = '' }) => {
    const buffer = Buffer.alloc(4096); buffer.write('Standard ACE DB', 4); buffer[0x14] = 3; buffer.write(label, 256);
    const entry = { kind, sourceId: sha(kind + ':' + label), fileSha256: sha(buffer), bytes: buffer.length,
      fileName: 'Recovery.accdb', capturedAt: 1, appliedAt: generation === 'candidate' ? null : 2, revision: 2, requiresPassword: !!password, file: sha('cipher:' + label) + '.source' };
    const def = S.definitions(kind).find(d => d.name === table) || S.definitions(kind)[0];
    return { entry, generation, buffer, password, rows: new Map([[def.name, rows ? rows(def, entry) : [prepared(def, entry)]]]) };
  });
  const proof = { version: 1, available: sources.some(s => s.generation === 'current'), generation: 1,
    kinds: SOURCE_KINDS.map(kind => ({ kind, current: sources.find(s => s.entry.kind === kind && s.generation === 'current')?.entry || null,
      previous: sources.find(s => s.entry.kind === kind && s.generation === 'previous')?.entry || null })),
    ...(sources.some(s => s.generation === 'retained') ? { retained: sources.filter(s => s.generation === 'retained').map(s => s.entry) } : {}),
    candidates: sources.filter(s => s.generation === 'candidate').map(s => s.entry),
    files: [{ file: 'index.source-archive', bytes: 100, sha256: sha('sealed-index') }, ...sources.map(s => ({ file: s.entry.file, bytes: 4096, sha256: sha('sealed-' + s.entry.sourceId) }))] };
  proof.generationSha256 = sha(JSON.stringify({ generation: proof.generation, kinds: proof.kinds, ...(proof.retained ? { retained: proof.retained } : {}), candidates: proof.candidates, files: proof.files }));
  validateImportSourceArchiveProof(proof);
  const calls = [], buffers = [];
  const archive = { async useFile(sourceId, consumer) {
    const source = sources.find(s => s.entry.sourceId === sourceId && s.generation !== 'candidate'); assert.ok(source, 'only applied archive files can be opened');
    const buffer = Buffer.from(source.buffer); buffers.push(buffer);
    try { return await consumer({ buffer, password: source.password, source: source.entry }); } finally { buffer.fill(0); }
  } };
  async function readSource({ buffer, kind, password, send }) {
    const source = sources.find(s => s.entry.fileSha256 === sha(buffer)); assert.equal(source.entry.kind, kind); assert.equal(password, source.password); calls.push(source.entry.sourceId);
    const defs = S.definitions(kind), tables = defs.map(d => ({ name: d.name, profileHash: d.profile.fingerprint, declaredRows: source.rows.get(d.name)?.length || 0 }));
    await send({ type: 'manifest', kind, fileSha256: source.entry.fileSha256, bytes: buffer.length, tables });
    let total = 0;
    for (const def of defs) {
      const rows = source.rows.get(def.name) || []; total += rows.length;
      assert.deepEqual(await send({ type: 'table', name: def.name, expectedRows: rows.length, declaredRows: rows.length }), { resumeAfter: 0 });
      if (rows.length) await send({ type: 'rows', name: def.name, startRow: 1, rows });
      await send({ type: 'table-complete', name: def.name });
    }
    await send({ type: 'complete', tables: defs.length, rows: total });
  }
  return { archive, proof, readSource, sources, calls, buffers };
}

test('all six source families round trip source, normalized data and classified segments without values in recipes', async () => {
  const f = fixture(), dictionary = await buildSourceDictionary(f), references = [], expected = new Map();
  assert.equal(dictionary.stats.sources, 6); assert.equal(dictionary.stats.rows, 6); assert.equal(dictionary.stats.values, dictionary.size);
  for (const { entry, rows } of f.sources) {
    const [name, [raw]] = [...rows][0], def = S.definitions(entry.kind).find(d => d.name === name), normalized = C.normalizeDataImportRow(def.profile, raw);
    const segments = def.master ? M.masterSegments(name, normalized.data) : H.historySegments(def.source, name, normalized.data);
    for (const value of [raw, normalized.source, normalized.data, ...segments.map(s => s.data)]) {
      const reference = dictionary.reference(value); assert.ok(reference, entry.kind + ':' + name); validateReference(reference, { proof: f.proof });
      assert.equal(reference.kind, entry.kind, 'supplemental trade history is classified by its file definition');
      assert.equal(JSON.stringify(reference).includes(raw[def.profile.keyFields[0]]), false, 'recipe does not contain the source business key');
      references.push(reference); expected.set(referenceHash(reference), value);
    }
  }
  assert.equal(dictionary.reference({ privateGpNote: 'preserve this literal' }), null);
  const recovered = await materializeReferences({ ...f, references }); assert.deepEqual(recovered, expected);
  assert.equal(f.calls.length, 12, 'each of six files is parsed once during indexing and once during restore');
  assert.ok(f.buffers.every(buffer => buffer.every(byte => byte === 0)));
  const again = await buildSourceDictionary(f); assert.equal(again.dictionarySha256, dictionary.dictionarySha256);
});

test('confirmed previous and retained generations are usable; a newer unconfirmed upload is excluded', async () => {
  const f = fixture([{ kind: 'trade', label: 'new' }, { kind: 'trade', label: 'previous', generation: 'previous' },
    { kind: 'trade', label: 'historical', generation: 'retained' }, { kind: 'trade', label: 'candidate', generation: 'candidate' }]);
  for (const source of f.sources) source.rows = new Map([['ADANREDE', [{ ...prepared(S.definitions('trade')[0], source.entry), ANREDE: source.generation }]]]);
  const dictionary = await buildSourceDictionary(f);
  const row = generation => [...f.sources.find(s => s.generation === generation).rows.values()][0][0];
  assert.equal(dictionary.stats.sources, 3); assert.ok(dictionary.reference(row('retained'))); assert.ok(dictionary.reference(row('previous')));
  assert.equal(dictionary.reference(row('candidate')), null);
  const reference = dictionary.reference(row('retained'));
  assert.deepEqual((await materializeReferences({ ...f, references: [reference] })).get(referenceHash(reference)), row('retained'));
});

test('streamed materialization awaits the consumer, deduplicates references and parses a file once', async () => {
  const f = fixture([{ kind: 'cash', password: 'test-access-unlock' }]), dictionary = await buildSourceDictionary(f), source = f.sources[0], raw = [...source.rows.values()][0][0];
  const def = S.definitions('cash')[0], data = C.normalizeDataImportRow(def.profile, raw).data;
  const references = [dictionary.reference(raw), dictionary.reference(data)], values = new Map(); let active = false;
  const summary = await materializeReferences({ ...f, references: [...references, ...references], onValue: async (reference, value) => {
    assert.equal(active, false); active = true; await new Promise(resolve => setImmediate(resolve)); values.set(referenceHash(reference), value); active = false;
  } });
  assert.deepEqual(summary, { resolved: new Set(references.map(referenceHash)).size, rows: 1, sources: 1 });
  assert.equal(values.size, summary.resolved); assert.equal(f.calls.length, 2); assert.equal(JSON.stringify(references).includes('test-access-unlock'), false);
});

test('old branch-stock profiles and technical-free variants reconstruct their exact historical values', async () => {
  const f = fixture([{ kind: 'trade', table: 'ARTIKEL_FILIALEN' }]), source = f.sources[0], raw = [...source.rows.values()][0][0], dictionary = await buildSourceDictionary(f);
  const profiles = H.profilesFor('trade', 'ARTIKEL_FILIALEN'); assert.equal(profiles.length, 2);
  const old = profiles[1], preparedOld = { ...raw, _source_snapshot_sha256: source.entry.fileSha256, _source_row: 1 }, normalized = C.normalizeDataImportRow(old, preparedOld);
  const reference = dictionary.reference(normalized.data); assert.ok(reference); assert.equal(reference.profileHash, old.fingerprint);
  assert.deepEqual((await materializeReferences({ ...f, references: [reference] })).get(referenceHash(reference)), normalized.data);
  const stripped = Object.fromEntries(Object.entries(normalized.data).filter(([key]) => !['snapshot', 'ordinal'].includes(key))); assert.ok(dictionary.reference(stripped));
});

test('production article projection uses active lifecycle, cleaned labels and fixed12 catalog amounts', async () => {
  const f = fixture([{ kind: 'trade', table: 'ARTIKEL_STAMM', rows(def, entry) {
    const raw = prepared(def, entry); raw.EAN = '0000000000123'; raw.Artikelbezeichnung = 'A\tB\nC'; raw.Verkaufspreis = '12.345'; return [raw];
  } }]), dictionary = await buildSourceDictionary(f);
  const revision = { description: 'A B C', active: true, sourceUpdatedAt: null }, price = { amount: '12.345000000000', currency: 'EUR', priceBasis: 'gross', qualityStatus: 'inferred', sourceField: 'Verkaufspreis' };
  const references = [dictionary.reference(revision), dictionary.reference(price)]; assert.ok(references.every(Boolean));
  assert.equal(references[0].transform, 'article-revision'); assert.match(references[1].transform, /^article-price:/);
  const recovered = await materializeReferences({ ...f, references }); assert.deepEqual(recovered.get(referenceHash(references[0])), revision); assert.deepEqual(recovered.get(referenceHash(references[1])), price);
});

test('an independently reconstructible catalog alias retains its validated identifier projection', async () => {
  const f = fixture([{ kind: 'trade', table: 'ARTIKEL_ZWEITEAN', rows: () => [{ EAN: '0000000000123', ZweitEAN: '4006381333931', Rang: 1 }] }]);
  const dictionary = await buildSourceDictionary(f), identifier = { identifierType: 'ean13', identifierValue: '4006381333931', canonicalGtin14: '04006381333931', isPrimary: true,
    sourceField: 'ARTIKEL_ZWEITEAN.ZweitEAN', sourceRank: 1, equivalentIdentifiers: [], sourceProvider: 'import' };
  const reference = dictionary.reference(identifier); assert.ok(reference); assert.equal(reference.transform, 'alias-identifier:0');
  assert.deepEqual((await materializeReferences({ ...f, references: [reference] })).get(referenceHash(reference)), identifier);
});

test('invalid normalization still retains exact source evidence without manufacturing normalized values', async () => {
  const f = fixture([{ kind: 'trade', table: 'ADANREDE', rows: (def, entry) => [{ ...prepared(def, entry), ANREDE: '' }] }]), dictionary = await buildSourceDictionary(f);
  assert.ok(dictionary.reference([...f.sources[0].rows.values()][0][0])); assert.equal(dictionary.reference({ f0: '', f1: null, f2: null, f3: null }), null);
});

test('source, proof, profile, transform and value tampering fail closed', async () => {
  const f = fixture([{ kind: 'cash' }]), dictionary = await buildSourceDictionary(f), raw = [...f.sources[0].rows.values()][0][0], reference = dictionary.reference(raw);
  for (const patch of [{ kind: 'trade' }, { sourceId: 'f'.repeat(64) }, { fileSha256: 'f'.repeat(64) }, { bytes: 8192 },
    { table: 'users' }, { ordinal: 0 }, { profileHash: 'f'.repeat(64) }, { transform: 'execute:anything' }, { password: 'forbidden' }]) {
    assert.throws(() => validateReference({ ...reference, ...patch }, { proof: f.proof }), { code: 'ACCESS_VALUE_RECIPE_INVALID' });
  }
  await assert.rejects(materializeReferences({ ...f, references: [{ ...reference, expectedSha256: 'f'.repeat(64) }] }), { code: 'ACCESS_VALUE_RECIPE_VALUE_MISMATCH' });
  await assert.rejects(materializeReferences({ ...f, references: [{ ...reference, ordinal: 2 }] }), { code: 'ACCESS_VALUE_RECIPE_UNRESOLVED' });
  f.sources[0].buffer[300] ^= 1;
  await assert.rejects(buildSourceDictionary(f), { code: 'ACCESS_VALUE_RECIPE_SOURCE_MISMATCH' });
});

test('bounded indexes, reference lists and default in-memory restore fail rather than growing without limit', async () => {
  const f = fixture([{ kind: 'cash' }]);
  await assert.rejects(buildSourceDictionary({ ...f, maxEntries: 1 }), { code: 'ACCESS_VALUE_RECIPE_LIMIT' });
  await assert.rejects(buildSourceDictionary({ ...f, maxIndexBytes: 1 }), { code: 'ACCESS_VALUE_RECIPE_LIMIT' });
  const dictionary = await buildSourceDictionary(f), reference = dictionary.reference([...f.sources[0].rows.values()][0][0]);
  await assert.rejects(materializeReferences({ ...f, references: [reference, reference], maxReferences: 1 }), { code: 'ACCESS_VALUE_RECIPE_LIMIT' });
  await assert.rejects(materializeReferences({ ...f, references: [reference], maxIndexBytes: 1 }), { code: 'ACCESS_VALUE_RECIPE_LIMIT' });
});

test('incomplete, reordered and dishonest source-reader protocol never produces a dictionary', async () => {
  const f = fixture([{ kind: 'cash' }]);
  for (const mutate of [event => event.type === 'complete' ? null : event,
    event => event.type === 'rows' ? { ...event, startRow: 2 } : event,
    event => event.type === 'manifest' ? { ...event, tables: [...event.tables].reverse() } : event,
    event => event.type === 'manifest' ? { ...event, fileSha256: 'f'.repeat(64) } : event,
    event => event.type === 'complete' ? { ...event, rows: 99 } : event]) {
    const reader = options => f.readSource({ ...options, send: event => { const value = mutate(event); return value ? options.send(value) : undefined; } });
    await assert.rejects(buildSourceDictionary({ ...f, readSource: reader }), { code: 'ACCESS_VALUE_RECIPE_PROTOCOL' });
  }
});

test('backup and replay deadlines interrupt reader events and release borrowed source buffers', async () => {
  const f = fixture(), deadline = Object.assign(new Error('synthetic deadline expired'), { code: 'SYNTHETIC_DEADLINE' }); let checks = 0;
  await assert.rejects(buildSourceDictionary({ ...f, checkBudget() { if (++checks === 5) throw deadline; } }), error => error === deadline);
  assert.equal(f.calls.length, 1); assert.ok(f.buffers.every(buffer => buffer.every(byte => byte === 0)));
  const dictionary = await buildSourceDictionary(f), reference = dictionary.reference([...f.sources[0].rows.values()][0][0]); checks = 0;
  await assert.rejects(materializeReferences({ ...f, references: [reference], checkBudget() { if (++checks === 5) throw deadline; } }), error => error === deadline);
  assert.ok(f.buffers.every(buffer => buffer.every(byte => byte === 0)));
});

test('bounded native disk dictionary produces exactly the same recipes and digest as the memory model', {skip:process.platform!=='linux'},async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'gp-access-dictionary-'));fs.chmodSync(directory,0o700);
  let disk;
  t.after(()=>{disk?.dispose();assert.equal(fs.realpathSync(directory),directory);assert.deepEqual(fs.readdirSync(directory),[]);fs.rmdirSync(directory);});
  const f=fixture(),memory=await buildSourceDictionary(f);
  disk=await buildSourceDictionary({...f,indexDirectory:directory});
  assert.equal(disk.storage,'disk');assert.equal(disk.size,memory.size);assert.equal(disk.dictionarySha256,memory.dictionarySha256);
  for(const source of f.sources)for(const rows of source.rows.values())for(const row of rows)assert.deepEqual(disk.reference(row),memory.reference(row));
});

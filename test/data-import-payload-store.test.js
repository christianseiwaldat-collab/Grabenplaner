"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const C = require("../lib/data-import-contract");
const { createDataImportProtection } = require("../lib/data-import-protection");
const { createDataImportPayloadStore } = require("../lib/data-import-payload-store");
const PREFIX = "gp-import-evidence-parts-v1:";
const TIME = "2026-09-06T12:00:00.000Z";
const sha = input => crypto.createHash("sha256").update(String(input)).digest("hex");
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const errorCode = code => error => error?.code === code;

function profile(keyless = false) {
  return C.defineDataImportProfile({ id: keyless ? "synthetic-snapshot" : "synthetic-keyed", version: 1,
    entity: "synthetic-entity", sourceSystem: "synthetic-system", sourceTable: "Synthetic", schemaSha256: sha("schema"),
    keyFields: keyless ? ["_source_snapshot_sha256", "_source_row"] : ["Number"],
    fields: [{ source: "Number", target: "number", type: "identifier", nullable: false },
      { source: "Note", target: "note", type: "source_text", nullable: false },
      ...(keyless ? [{ source: "_source_snapshot_sha256", target: "snapshot", type: "identifier", nullable: false },
        { source: "_source_row", target: "ordinal", type: "integer", nullable: false }] : [])], dataClasses: ["internal_business"] });
}
function fixture(t, keyless = false) {
  const encryptionKey = Buffer.alloc(32, 7), indexKey = Buffer.alloc(32, 9);
  const original = createDataImportProtection({ encryptionKey, indexKey, keyId: "synthetic" });
  let seals = 0;
  const protection = { ...original, sealBlock(value, context) { seals++; return original.sealBlock(value, context); } };
  t.after(() => { original.destroy(); encryptionKey.fill(0); indexKey.fill(0); });
  const p = profile(keyless), blocks = new Map(), rowRefs = new Map(), changeRefs = new Map();
  const key = x => x.runId + ":" + x.rowNumber;
  const tx = {
    async getPayloadBlock({ id }) { return copy(blocks.get(id) || null); },
    async insertPayloadBlock(value) {
      if (blocks.has(value.id)) return { rowsAffected: 0 };
      if ([...blocks.values()].some(block => block.keyId === value.keyId && block.nonce === value.nonce)) {
        const error = new Error("synthetic nonce uniqueness violation"); error.code = "PERSISTENCE_UNIQUE_VIOLATION"; throw error;
      }
      blocks.set(value.id, copy(value)); return { rowsAffected: 1 };
    },
  };
  for (const [kind, refs] of [["Row", rowRefs], ["Change", changeRefs]]) {
    tx[`get${kind}PayloadRefs`] = async value => copy(refs.get(key(value)) || []);
    tx[`delete${kind}PayloadRefs`] = async value => { const count = (refs.get(key(value)) || []).length; refs.delete(key(value)); return { rowsAffected: count }; };
    tx[`insert${kind}PayloadRef`] = async value => {
      assert.ok(blocks.has(value.blockId), "synthetic FK enforcement");
      const entries = refs.get(key(value)) || [];
      assert.equal(entries.some(ref => ref.slot === value.slot), false);
      entries.push({ slot: value.slot, blockId: value.blockId }); entries.sort((a, b) => a.slot.localeCompare(b.slot));
      refs.set(key(value), entries); return { rowsAffected: 1 };
    };
  }
  const store = createDataImportPayloadStore({ protection });
  function run(index = 1, extra = {}) { return { id: sha("run" + index), scopeId: "synthetic-scope", ownerId: "synthetic-owner", profileHash: p.fingerprint,
    manifest: { sourceInstance: "synthetic-source", fileSha256: sha("file" + index), snapshotAt: TIME }, ...extra }; }
  function record(r, ordinal = 1, note = "Synthetic evidence with explicit provenance. ".repeat(96)) {
    return C.normalizeDataImportRow(p, { Number: "synthetic-1", Note: note,
      ...(keyless ? { _source_snapshot_sha256: r.manifest.fileSha256, _source_row: ordinal } : {}) });
  }
  function row(value, ordinal = 1) { return { rowNumber: ordinal, identityHash: protection.digest(["synthetic-identity", value.key]), contentHash: protection.digest({ record: value }) }; }
  async function put(r, value, { kind = "row", originalRecord = value.record || record(r), ordinal = 1 } = {}) {
    const input = { run: r, profile: p, row: row(originalRecord, ordinal), kind, value, at: TIME };
    const encoded = await store.encode(tx, input); input.row.payload = encoded.payload;
    await store.publishRefs(tx, { ...input, refs: encoded.refs });
    assert.deepEqual(await store.decode(tx, input), value);
    return { ...input, ...encoded };
  }
  function descriptor(saved, change) {
    const context = [saved.kind, saved.run.scopeId, saved.run.id, saved.row.rowNumber];
    const value = protection.open(saved.row.payload.slice(PREFIX.length), context);
    change(value); return PREFIX + protection.seal(value, context);
  }
  return { protection, original, encryptionKey, p, tx, blocks, rowRefs, changeRefs, store, run, record, row, put, descriptor, seals: () => seals };
}

test("evidence block encryption uses a distinct HKDF key and preserves the legacy envelope", t => {
  const f = fixture(t), context = ["synthetic-purpose"], value = { note: "Synthetic" };
  const normal = f.protection.seal(value, context), block = f.protection.sealBlock(value, context);
  assert.match(normal, /^gp-import-v1:/); assert.match(block, /^gp-import-block-v1:/);
  assert.deepEqual(f.protection.open(normal, context), value); assert.deepEqual(f.protection.openBlock(block, context), value);
  assert.throws(() => f.protection.open(block, context), errorCode("IMPORT_PROTECTED_PAYLOAD_INVALID"));
  assert.throws(() => f.protection.openBlock(normal, context), errorCode("IMPORT_PROTECTED_BLOCK_INVALID"));
  assert.throws(() => f.protection.openBlock(block, ["other"]), errorCode("IMPORT_PROTECTED_BLOCK_INVALID"));
  const [, keyId, nonce, tag, ciphertext] = block.split(":"), aad = Buffer.from(C.canonical(["gp-import-evidence-block", 1, keyId, context]));
  const decrypt = key => {
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64")); d.setAAD(aad); d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ciphertext, "base64")), d.final()]);
  };
  assert.throws(() => decrypt(f.encryptionKey), "the legacy AES key cannot decrypt a block even with its exact AAD");
  const derived = Buffer.from(crypto.hkdfSync("sha256", f.encryptionKey, Buffer.alloc(0), Buffer.from("grabenplaner:data-import:evidence-block:aes-256-gcm:v1"), 32));
  try { assert.deepEqual(JSON.parse(decrypt(derived)), value); } finally { derived.fill(0); }
  f.original.destroy(); assert.throws(() => f.protection.openBlock(block, context), errorCode("IMPORT_PROTECTION_UNAVAILABLE"));
});

test("two distinct source SHAs share immutable evidence parts across stage, review and change without changing their values", async t => {
  const f = fixture(t), first = f.run(1), second = f.run(2), record = f.record(first);
  const a = await f.put(first, { record }); assert.equal(a.refs.length, 2); assert.equal(f.blocks.size, 2);
  const target = { id: "synthetic-target", revision: 1, data: record.data };
  const link = { id: f.row(record).identityHash, scopeId: first.scopeId, entity: f.p.entity, targetId: target.id, revision: 1, lastRunId: first.id,
    payload: f.protection.seal({ record, contentHash: f.row(record).contentHash, targetRevision: 1 }, ["link", f.row(record).identityHash]) };
  await f.put(first, { record, action: "create", issue: "", validation: null, beforeLink: null, beforeTarget: null, patch: record.data });
  await f.put(first, { action: "create", beforeTarget: null, afterTarget: target, beforeLink: null }, { kind: "change" });
  assert.equal(f.blocks.size, 2, "patch and afterTarget.data reuse record.data");
  const nextRecord = f.record(second), plan = { record: nextRecord, action: "unchanged", issue: "", validation: null, beforeLink: link, beforeTarget: target, patch: {} };
  const b = await f.put(second, plan); assert.equal(f.blocks.size, 3, "only the opaque prior link body is new");
  assert.equal(a.refs.find(r => r.slot === "record.source").blockId, b.refs.find(r => r.slot === "record.source").blockId);
  const originals = copy([...f.blocks]), seals = f.seals();
  const reopened = createDataImportPayloadStore({ protection: f.protection });
  assert.deepEqual(await reopened.decode(f.tx, b), plan);
  assert.equal((await reopened.decode(f.tx, b)).beforeLink.payload, link.payload, "opaque ciphertext is byte-exact");
  await f.put(second, plan); assert.equal(f.seals(), seals, "ordinary reuse generates no new block IV");
  await f.store.publishRefs(f.tx, { ...b, refs: [] });
  assert.deepEqual([...f.blocks], originals, "reference replacement never deletes or modifies an evidence block");
  await assert.rejects(reopened.decode(f.tx, b), errorCode("IMPORT_EVIDENCE_REFS_MISMATCH"));
});

test("keyless snapshots share business bodies but keep distinct keys, source SHA and ordinal overlays", async t => {
  const f = fixture(t, true), first = f.run(1), second = f.run(2), recordA = f.record(first), recordB = f.record(second);
  const a = await f.put(first, { record: recordA }), b = await f.put(second, { record: recordB });
  assert.notEqual(a.row.identityHash, b.row.identityHash); assert.notEqual(a.row.contentHash, b.row.contentHash);
  assert.deepEqual(a.refs, b.refs); assert.equal(f.blocks.size, 2);
  assert.deepEqual((await f.store.decode(f.tx, b)).record.key, [second.manifest.fileSha256, 1]);
  const change = { action: "update", beforeLink: null,
    beforeTarget: { id: "synthetic-old", revision: 1, data: recordA.data },
    afterTarget: { id: "synthetic-old", revision: 2, data: recordB.data } };
  await f.put(second, change, { kind: "change", originalRecord: recordB });
  assert.equal(f.blocks.size, 2, "historical beforeTarget overlay does not force a new shared body");
  const duplicate = await f.put(second, { record: f.record(second, 2) }, { ordinal: 2 });
  assert.deepEqual(duplicate.refs, b.refs); assert.notEqual(duplicate.row.identityHash, b.row.identityHash);
  const bad = copy(recordB); bad.source._source_row = 3;
  await assert.rejects(f.store.encode(f.tx, { ...b, value: { record: bad }, at: TIME }), errorCode("IMPORT_EVIDENCE_SNAPSHOT_MISMATCH"));
  const wrongAfter = copy(change); wrongAfter.afterTarget.data.snapshot = first.manifest.fileSha256;
  await assert.rejects(f.store.encode(f.tx, { ...b, kind: "change", value: wrongAfter, at: TIME }), errorCode("IMPORT_EVIDENCE_SNAPSHOT_MISMATCH"));
  const originalPayload = b.row.payload;
  b.row.payload = f.descriptor(b, d => { d.parts.find(p => p.slot === "record.data").overlay.snapshot = first.manifest.fileSha256; });
  await assert.rejects(f.store.decode(f.tx, b), errorCode("IMPORT_EVIDENCE_SNAPSHOT_MISMATCH")); b.row.payload = originalPayload;
});

test("legacy payloads need no block API and retain their original snapshot semantics, but cannot carry hidden SQL refs", async t => {
  const f = fixture(t, true), r = f.run(), record = f.record(r), row = f.row(record);
  record.data.snapshot = sha("legacy-older-semantic-shape");
  row.payload = f.protection.seal({ record }, ["row", r.scopeId, r.id, 1]);
  const legacy = createDataImportPayloadStore({ protection: { seal: f.protection.seal, open: f.protection.open, digest: f.protection.digest } });
  const input = { run: r, profile: f.p, row, kind: "row" };
  assert.deepEqual(await legacy.decode(f.tx, input), { record });
  await assert.rejects(legacy.encode(f.tx, { ...input, value: { record }, at: TIME }), errorCode("IMPORT_EVIDENCE_BLOCK_PROTECTION_REQUIRED"));
  f.rowRefs.set(r.id + ":1", [{ slot: "record.data", blockId: sha("hidden") }]);
  await assert.rejects(legacy.decode(f.tx, input), errorCode("IMPORT_EVIDENCE_LEGACY_REFS_PRESENT"));
});

test("small values with no reusable parts retain the exact legacy size and never downgrade a failed shared read", async t => {
  const f = fixture(t), run = f.run(), record = f.record(run, 1, "Small synthetic note.");
  const values = [{ record }, { record, action: "create", issue: "", validation: null, beforeLink: null, beforeTarget: null, patch: record.data }];
  for (const value of values) {
    const saved = await f.put(run, value);
    assert.match(saved.payload, /^gp-import-v1:/); assert.deepEqual(saved.refs, []);
    const legacy = f.protection.seal(value, ["row", run.scopeId, run.id, 1]);
    assert.equal(Buffer.byteLength(saved.payload), Buffer.byteLength(legacy));
    await assert.rejects(f.store.decode(f.tx, { ...saved, row: { ...saved.row, payload: PREFIX + legacy } }));
  }
  const change = { action: "create", beforeLink: null, beforeTarget: null, afterTarget: { id: "synthetic-target", revision: 1, data: record.data } };
  const saved = await f.put(run, change, { kind: "change", originalRecord: record });
  assert.match(saved.payload, /^gp-import-v1:/); assert.deepEqual(saved.refs, []);
  assert.equal(Buffer.byteLength(saved.payload), Buffer.byteLength(f.protection.seal(change, ["change", run.scopeId, run.id, 1])));
  assert.equal(f.blocks.size, 0); assert.equal(f.seals(), 0);
});

test("small 100, 300 and 600 byte bodies and their opaque prior links remain inline across two source files", async t => {
  for (const bodyBytes of [100, 300, 600]) {
    const f = fixture(t), first = f.run(1), second = f.run(2);
    const empty = f.record(first, 1, "");
    const record = f.record(first, 1, "x".repeat(bodyBytes - Buffer.byteLength(C.canonical(empty.source))));
    assert.equal(Buffer.byteLength(C.canonical(record.source)), bodyBytes);
    const target = { id: "synthetic-target", revision: 1, data: record.data };
    const identity = f.row(record).identityHash;
    const link = { id: identity, scopeId: first.scopeId, entity: f.p.entity, targetId: target.id, revision: 1, lastRunId: first.id,
      payload: f.protection.seal({ record, contentHash: f.row(record).contentHash, targetRevision: 1 }, ["link", identity]) };
    const stage = { record };
    const create = { record, action: "create", issue: "", validation: null, beforeLink: null, beforeTarget: null, patch: record.data };
    const unchanged = { record, action: "unchanged", issue: "", validation: null, beforeLink: link, beforeTarget: target, patch: {} };
    for (const [run, value] of [[first, stage], [first, create], [second, stage], [second, unchanged]]) {
      const saved = await f.put(run, value);
      assert.match(saved.payload, /^gp-import-v1:/); assert.deepEqual(saved.refs, []);
      assert.equal(Buffer.byteLength(saved.payload), Buffer.byteLength(f.protection.seal(value, ["row", run.scopeId, run.id, 1])));
    }
    const change = { action: "create", beforeLink: null, beforeTarget: null, afterTarget: target };
    const savedChange = await f.put(first, change, { kind: "change", originalRecord: record });
    assert.match(savedChange.payload, /^gp-import-v1:/); assert.deepEqual(savedChange.refs, []);
    assert.equal(f.blocks.size, 0); assert.equal(f.seals(), 0);
  }
});

test("compact root digest binds every original metadata field under a separate HMAC purpose", async t => {
  const f = fixture(t), run = f.run(), saved = await f.put(run, { record: f.record(run) });
  const descriptor = f.protection.open(saved.payload.slice(PREFIX.length), ["row", run.scopeId, run.id, 1]);
  const bound = { format: "gp-import-evidence-parts-v1", scopeId: run.scopeId, ownerId: run.ownerId,
    profileHash: f.p.fingerprint, sourceSystem: f.p.sourceSystem, sourceInstance: run.manifest.sourceInstance,
    sourceTable: f.p.sourceTable, entity: f.p.entity, kind: "row", runId: run.id,
    fileSha256: run.manifest.fileSha256, snapshotAt: run.manifest.snapshotAt,
    rowNumber: saved.row.rowNumber, identityHash: saved.row.identityHash, contentHash: saved.row.contentHash };
  assert.deepEqual(Object.keys(descriptor).sort(), ["bindingDigest", "format", "parts", "value"]);
  const digest = f.protection.digest(["gp-import-evidence-root-binding-v1", bound]);
  assert.equal(descriptor.bindingDigest, digest); assert.match(digest, /^[a-f0-9]{64}$/);
  for (const key of Object.keys(bound)) {
    const changed = { ...bound, [key]: typeof bound[key] === "number" ? bound[key] + 1 : String(bound[key]) + "-changed" };
    assert.notEqual(f.protection.digest(["gp-import-evidence-root-binding-v1", changed]), digest, key);
  }
  assert.notEqual(f.protection.digest(["gp-import-evidence-block-v1", bound]), digest);
  const payload = f.descriptor(saved, d => { d.bindingDigest = f.protection.digest(["gp-import-evidence-root-binding-v1", { ...bound, ownerId: "another-owner" }]); });
  await assert.rejects(f.store.decode(f.tx, { ...saved, row: { ...saved.row, payload } }), errorCode("IMPORT_EVIDENCE_BINDING_MISMATCH"));
});

test("row bindings, SQL references and authenticated manifest shape fail closed", async t => {
  const f = fixture(t), r = f.run(), saved = await f.put(r, { record: f.record(r) });
  for (const change of [s => { s.run.ownerId = "other-owner"; }, s => { s.run.manifest.fileSha256 = sha("other-file"); },
    s => { s.row.contentHash = sha("other-content"); }, s => { s.row.identityHash = sha("other-identity"); }]) {
    const input = { ...saved, run: copy(saved.run), row: copy(saved.row) }; change(input);
    await assert.rejects(f.store.decode(f.tx, input), errorCode("IMPORT_EVIDENCE_BINDING_MISMATCH"));
  }
  const key = r.id + ":1", originalRefs = copy(f.rowRefs.get(key));
  f.rowRefs.set(key, originalRefs.slice(1)); await assert.rejects(f.store.decode(f.tx, saved), errorCode("IMPORT_EVIDENCE_REFS_MISMATCH"));
  f.rowRefs.set(key, [originalRefs[0], originalRefs[0]]); await assert.rejects(f.store.decode(f.tx, saved), errorCode("IMPORT_EVIDENCE_REFS_INVALID"));
  f.rowRefs.set(key, originalRefs);
  for (const mutation of [d => { d.extra = "forbidden"; }, d => { d.parts[0].slot = "__proto__.polluted"; },
    d => { d.parts[0].overlay = { snapshot: sha("not-a-technical-profile") }; },
    d => { d.value.record.data = {}; }]) {
    const row = { ...saved.row, payload: f.descriptor(saved, mutation) };
    await assert.rejects(f.store.decode(f.tx, { ...saved, row }));
  }
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(await f.store.decode(f.tx, saved), saved.value);
});

test("block reuse authenticates metadata, ciphertext, HMAC identity and immutable contents", async t => {
  const f = fixture(t), r = f.run(), saved = await f.put(r, { record: f.record(r) }), id = saved.refs[0].blockId;
  const original = copy(f.blocks.get(id));
  for (const mutate of [b => { b.ownerId = "other-owner"; }, b => { b.nonce = Buffer.alloc(12).toString("base64"); },
    b => { const parts = b.payload.split(":"); parts[3] = Buffer.alloc(16).toString("base64"); b.payload = parts.join(":"); }]) {
    const block = copy(original); mutate(block); f.blocks.set(id, block);
    await assert.rejects(f.store.decode(f.tx, saved));
    const seals = f.seals(); await assert.rejects(f.store.encode(f.tx, saved)); assert.equal(f.seals(), seals);
    assert.deepEqual(f.blocks.get(id), block, "a corrupt block must never be silently repaired");
  }
  f.blocks.set(id, original);
  const ns = Object.fromEntries(["scopeId", "ownerId", "profileHash", "sourceSystem", "sourceInstance", "sourceTable", "entity"].map(k => [k, original[k]]));
  const payload = f.protection.sealBlock({ different: "synthetic" }, ["gp-import-evidence-block-v1", ns, original.blockType, id]);
  const parts = payload.split(":"); f.blocks.set(id, { ...original, payload, keyId: parts[1], nonce: parts[2] });
  await assert.rejects(f.store.decode(f.tx, saved), errorCode("IMPORT_EVIDENCE_BLOCK_HASH_MISMATCH"));
  f.blocks.delete(id); await assert.rejects(f.store.decode(f.tx, saved), errorCode("IMPORT_EVIDENCE_BLOCK_MISSING"));
});

test("purpose nonce collisions and byte/count bounds fail closed without block deletion", async t => {
  const f = fixture(t), r = f.run(), record = f.record(r), random = crypto.randomBytes;
  crypto.randomBytes = length => length === 12 ? Buffer.alloc(12, 3) : random(length);
  try {
    await assert.rejects(f.store.encode(f.tx, { run: r, profile: f.p, row: f.row(record), kind: "row", value: { record }, at: TIME }),
      errorCode("PERSISTENCE_UNIQUE_VIOLATION"));
  } finally { crypto.randomBytes = random; }
  assert.equal(f.blocks.size, 1, "caller transaction will roll back inserts; codec never deletes them");
  const large = { record: { ...record, source: { Note: "X".repeat(C.LIMITS.rowBytes * 6 + 1) } } };
  await assert.rejects(f.store.encode(f.tx, { run: r, profile: f.p, row: f.row(record), kind: "row", value: large, at: TIME }),
    error => error.code === "IMPORT_EVIDENCE_VALUE_TOO_LARGE" && error.status === 413);
  const tooMany = Array.from({ length: 7 }, () => ({ slot: "record.data", blockId: sha("ref") }));
  await assert.rejects(f.store.publishRefs(f.tx, { run: r, row: f.row(record), kind: "row", refs: tooMany }), errorCode("IMPORT_EVIDENCE_REFS_INVALID"));
});

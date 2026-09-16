"use strict";

// Immutable, tenant/owner/source-bound evidence blocks. This codec changes only
// storage representation: it never changes source identity, purges evidence,
// provisions keys, or decides authorization. The caller owns the transaction.
const C = require("./data-import-contract");
const FORMAT = "gp-import-evidence-parts-v1";
const PREFIX = FORMAT + ":";
const BLOCK_DOMAIN = "gp-import-evidence-block-v1";
const ROOT_BINDING_DOMAIN = "gp-import-evidence-root-binding-v1";
// Small evidence stays inline. An opaque link is already encrypted, so its
// additional encryption/metadata needs a larger amortization threshold. New
// blocks still cost space on first use; these bounds are not a space guarantee.
const MIN_OBJECT_BLOCK_BYTES = 1024;
const MIN_OPAQUE_LINK_BLOCK_BYTES = 4096;
const MAX_VALUE_BYTES = C.LIMITS.rowBytes * 6;
const MAX_ENVELOPE_BYTES = C.LIMITS.rowBytes * 9;
const SLOTS = Object.freeze(["afterTarget.data", "beforeLink.payload", "beforeTarget.data", "patch", "record.data", "record.source"]);
const BLOCK_FIELDS = ["id", "scopeId", "ownerId", "profileHash", "sourceSystem", "sourceInstance", "sourceTable", "entity", "blockType", "payload", "keyId", "nonce", "createdAt"];
const ROW_FIELDS = ["record", "invalidSource", "validation", "beforeLink", "beforeTarget", "patch", "action", "issue"];
const CHANGE_FIELDS = ["action", "beforeTarget", "afterTarget", "beforeLink"];
function fail(code, status = 409) { C.fail("IMPORT_EVIDENCE_" + code, status); }
function exact(value, keys) { C.exact(value, keys); if (Object.keys(value).length !== keys.length) fail("SHAPE_INVALID"); }
function bounded(value) { const encoded = C.canonical(value); if (Buffer.byteLength(encoded) > MAX_VALUE_BYTES) fail("VALUE_TOO_LARGE", 413); return encoded; }
function clone(value) { return JSON.parse(bounded(value)); }
function kindCheck(kind) { if (!["row", "change"].includes(kind)) fail("KIND_INVALID"); }
function rowContext(run, row, kind) { return [kind, run.scopeId, run.id, row.rowNumber]; }
function namespace(run, profile) {
  C.assertProfile(profile); C.sha(run.id); C.id(run.scopeId); C.id(run.ownerId);
  if (run.profileHash !== profile.fingerprint) fail("PROFILE_MISMATCH");
  C.sha(run.manifest?.fileSha256); C.utc(run.manifest?.snapshotAt); C.id(run.manifest?.sourceInstance);
  return { scopeId: run.scopeId, ownerId: run.ownerId, profileHash: profile.fingerprint,
    sourceSystem: profile.sourceSystem, sourceInstance: run.manifest.sourceInstance, sourceTable: profile.sourceTable, entity: profile.entity };
}
function binding(run, profile, row, kind) {
  kindCheck(kind); C.integer(row.rowNumber, 1, C.LIMITS.rows); C.sha(row.contentHash);
  if (row.identityHash !== null) C.sha(row.identityHash);
  return { format: FORMAT, ...namespace(run, profile), kind, runId: run.id,
    fileSha256: run.manifest.fileSha256, snapshotAt: run.manifest.snapshotAt,
    rowNumber: row.rowNumber, identityHash: row.identityHash, contentHash: row.contentHash };
}
function location(value, slot) {
  const parts = slot.split("."), key = parts.pop(); let parent = value;
  for (const field of parts) {
    if (!C.plain(parent) || !Object.hasOwn(parent, field) || parent[field] === null) return null;
    parent = parent[field];
  }
  return C.plain(parent) ? { parent, key } : null;
}
function valueShape(value, kind) {
  C.exact(value, kind === "row" ? ROW_FIELDS : CHANGE_FIELDS);
  if (kind === "row") {
    if (Object.hasOwn(value, "record") === Object.hasOwn(value, "invalidSource")) fail("ROW_SHAPE_INVALID");
    if (value.record !== undefined) exact(value.record, ["key", "source", "data"]);
  } else exact(value, CHANGE_FIELDS);
}
function overlayFields(profile, slot) {
  const sourceNames = ["_source_snapshot_sha256", "_source_row"];
  if (profile.keyFields.length !== 2 || !C.equal(profile.keyFields, sourceNames)) return [];
  const fields = sourceNames.map(source => profile.fields.find(field => field.source === source));
  if (fields[0]?.target !== "snapshot" || fields[0]?.type !== "identifier" || fields[0]?.nullable !== false
    || fields[1]?.target !== "ordinal" || fields[1]?.type !== "integer" || fields[1]?.nullable !== false) return [];
  if (slot === "record.source") return sourceNames;
  return ["record.data", "beforeTarget.data", "afterTarget.data", "patch"].includes(slot) ? ["snapshot", "ordinal"] : [];
}
function verifyOverlay(overlay, allowed) {
  C.exact(overlay, allowed);
  if (!Object.keys(overlay).length) fail("EMPTY_OVERLAY");
  for (const [key, value] of Object.entries(overlay)) {
    if (["snapshot", "_source_snapshot_sha256"].includes(key)) C.sha(value);
    else C.integer(value, 1, C.LIMITS.rows);
  }
}
function verifyCurrentSnapshot(value, run, profile, row, kind) {
  if (!overlayFields(profile, "record.source").length) return;
  const sha = run.manifest.fileSha256, ordinal = row.rowNumber;
  if (value.record && (!C.equal(value.record.key, [sha, ordinal])
    || value.record.source?._source_snapshot_sha256 !== sha || value.record.source?._source_row !== ordinal
    || value.record.data?.snapshot !== sha || value.record.data?.ordinal !== ordinal)) fail("SNAPSHOT_MISMATCH");
  // Historical beforeTarget/patch evidence must retain its own original
  // snapshot. Only the actual result of this change is bound to this run.
  if (kind === "change" && C.plain(value.afterTarget?.data)) {
    const data = value.afterTarget.data;
    if ((Object.hasOwn(data, "snapshot") && data.snapshot !== sha)
      || (Object.hasOwn(data, "ordinal") && data.ordinal !== ordinal)) fail("SNAPSHOT_MISMATCH");
  }
}
function refsCheck(refs) {
  if (!Array.isArray(refs) || refs.length > SLOTS.length) fail("REFS_INVALID");
  let previous = "";
  for (const ref of refs) {
    exact(ref, ["slot", "blockId"]); C.sha(ref.blockId);
    if (!SLOTS.includes(ref.slot) || ref.slot <= previous) fail("REFS_INVALID");
    previous = ref.slot;
  }
  return refs;
}
function envelopeMetadata(payload) {
  if (typeof payload !== "string") fail("BLOCK_ENVELOPE_INVALID");
  if (Buffer.byteLength(payload) > MAX_ENVELOPE_BYTES) fail("BLOCK_ENVELOPE_TOO_LARGE", 413);
  const parts = payload.split(":");
  if (parts.length !== 5 || !["gp-import-block-v1", "gp-import-block-v2"].includes(parts[0]) || !/^[A-Za-z0-9._-]{1,64}$/.test(parts[1])) fail("BLOCK_ENVELOPE_INVALID");
  const nonce = Buffer.from(parts[2], "base64");
  if (nonce.length !== 12 || nonce.toString("base64") !== parts[2]) fail("BLOCK_ENVELOPE_INVALID");
  return { keyId: parts[1], nonce: parts[2] };
}

function createDataImportPayloadStore({ protection } = {}) {
  if (!protection || ["seal", "open", "digest"].some(method => typeof protection[method] !== "function")) fail("PROTECTION_REQUIRED");
  const blockId = (ns, blockType, value) => protection.digest([BLOCK_DOMAIN, ns, blockType, value]);
  const blockContext = (ns, blockType, id) => [BLOCK_DOMAIN, ns, blockType, id];
  const bindingDigest = bound => protection.digest([ROOT_BINDING_DOMAIN, bound]);
  async function readBlock(tx, ns, id, blockType) {
    if (typeof protection.openBlock !== "function") fail("BLOCK_PROTECTION_REQUIRED");
    const stored = await tx.getPayloadBlock({ id });
    if (!stored) fail("BLOCK_MISSING");
    exact(stored, BLOCK_FIELDS); C.utc(stored.createdAt);
    if (stored.id !== id || stored.blockType !== blockType || Object.keys(ns).some(key => stored[key] !== ns[key])) fail("BLOCK_NAMESPACE_MISMATCH");
    const metadata = envelopeMetadata(stored.payload);
    if (metadata.keyId !== stored.keyId || metadata.nonce !== stored.nonce) fail("BLOCK_ENVELOPE_MISMATCH");
    const value = protection.openBlock(stored.payload, blockContext(ns, blockType, id));
    bounded(value);
    if (blockType === "object" ? !C.plain(value) : blockType !== "string" || typeof value !== "string") fail("BLOCK_TYPE_INVALID");
    if (blockId(ns, blockType, value) !== id) fail("BLOCK_HASH_MISMATCH");
    return value;
  }
  async function saveBlock(tx, ns, blockType, value, at) {
    const id = blockId(ns, blockType, value), existing = await tx.getPayloadBlock({ id });
    if (!existing) {
      const payload = protection.sealBlock(value, blockContext(ns, blockType, id));
      const result = await tx.insertPayloadBlock({ id, ...ns, blockType, payload, ...envelopeMetadata(payload), createdAt: at });
      if (![0, 1].includes(result?.rowsAffected)) fail("BLOCK_INSERT_INVALID");
    }
    // Both ordinary reuse and an ON CONFLICT race must authenticate the stored
    // object. Never repair/overwrite an existing block with a new ciphertext.
    if (!C.equal(await readBlock(tx, ns, id, blockType), value)) fail("BLOCK_CONTENT_MISMATCH");
    return id;
  }
  const methods = kind => {
    kindCheck(kind);
    return kind === "row" ? ["getRowPayloadRefs", "deleteRowPayloadRefs", "insertRowPayloadRef"]
      : ["getChangePayloadRefs", "deleteChangePayloadRefs", "insertChangePayloadRef"];
  };
  async function encode(tx, { run, profile, row, kind, value, at }, save = saveBlock) {
      if (["sealBlock", "openBlock"].some(method => typeof protection[method] !== "function")) fail("BLOCK_PROTECTION_REQUIRED");
      const bound = binding(run, profile, row, kind), ns = namespace(run, profile);
      C.utc(at); valueShape(value, kind); verifyCurrentSnapshot(value, run, profile, row, kind);
      const skeleton = clone(value), parts = [];
      for (const slot of SLOTS) {
        const where = location(skeleton, slot);
        if (!where || !Object.hasOwn(where.parent, where.key) || where.parent[where.key] === null) continue;
        const original = where.parent[where.key], blockType = slot === "beforeLink.payload" ? "string" : "object";
        if (blockType === "object" ? !C.plain(original) : typeof original !== "string") fail("SLOT_TYPE_INVALID");
        let body = original, overlay;
        const technical = overlayFields(profile, slot);
        if (technical.length) {
          body = { ...original }; overlay = {};
          for (const field of technical) if (Object.hasOwn(body, field)) { overlay[field] = body[field]; delete body[field]; }
          if (Object.keys(overlay).length) verifyOverlay(overlay, technical); else overlay = undefined;
        }
        const minimumBytes = blockType === "string" ? MIN_OPAQUE_LINK_BLOCK_BYTES : MIN_OBJECT_BLOCK_BYTES;
        if (Buffer.byteLength(C.canonical(body)) < minimumBytes) continue;
        const id = await save(tx, ns, blockType, body, at);
        delete where.parent[where.key];
        parts.push({ slot, blockId: id, ...(overlay ? { overlay } : {}) });
      }
      // An inline value needs no new descriptor. This is an encode decision,
      // never a fallback from a failed shared-payload authentication.
      if (!parts.length) return { payload: protection.seal(value, rowContext(run, row, kind)), refs: [] };
      // The complete expected binding is reconstructed from the original run,
      // profile and row; its purpose-separated HMAC avoids copying it per root.
      const descriptor = { format: FORMAT, bindingDigest: bindingDigest(bound), value: skeleton, parts };
      bounded(descriptor);
      return { payload: PREFIX + protection.seal(descriptor, rowContext(run, row, kind)),
        refs: parts.map(({ slot, blockId: id }) => ({ slot, blockId: id })) };
  }
  return Object.freeze({
    encode: (tx, input) => encode(tx, input),
    async encodeBatch(tx, inputs) {
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > C.LIMITS.batch) fail('BATCH_INVALID');
      if (!tx.getPayloadBlocks || !tx.insertPayloadBlocks) {
        const result = []; for (const input of inputs) result.push(await encode(tx, input)); return result;
      }
      const requests = new Map(), encoded = [];
      const collect = async (_tx, ns, blockType, value, at) => {
        const id = blockId(ns, blockType, value);
        if (!requests.has(id)) requests.set(id, {id, ns, blockType, value, at});
        else if (!C.equal(requests.get(id).value, value)) fail('BLOCK_CONTENT_MISMATCH');
        return id;
      };
      for (const input of inputs) encoded.push(await encode(tx, input, collect));
      if (requests.size) {
        const existing = new Set((await tx.getPayloadBlocks([...requests.keys()])).map(row => row.id)), missing = [];
        for (const {id, ns, blockType, value, at} of requests.values()) if (!existing.has(id)) {
          const payload = protection.sealBlock(value, blockContext(ns, blockType, id));
          missing.push({id, ...ns, blockType, payload, ...envelopeMetadata(payload), createdAt:at});
        }
        if (missing.length) {
          const result = await tx.insertPayloadBlocks(missing);
          if (!Number.isSafeInteger(result?.rowsAffected) || result.rowsAffected < 0 || result.rowsAffected > missing.length) fail('BLOCK_INSERT_INVALID');
          // Read back the stored ciphertext, including ON CONFLICT winners.
          await tx.getPayloadBlocks(missing.map(row => row.id));
        }
        for (const {id, ns, blockType, value} of requests.values()) {
          if (!C.equal(await readBlock(tx, ns, id, blockType), value)) fail('BLOCK_CONTENT_MISMATCH');
        }
      }
      return encoded;
    },
    async decode(tx, { run, profile, row, kind }) {
      const bound = binding(run, profile, row, kind), ns = namespace(run, profile);
      const [getRefs] = methods(kind), refs = refsCheck(await tx[getRefs]({ runId: run.id, rowNumber: row.rowNumber }));
      if (typeof row.payload !== "string") fail("ENVELOPE_INVALID");
      if (Buffer.byteLength(row.payload) > MAX_ENVELOPE_BYTES + PREFIX.length) fail("ENVELOPE_TOO_LARGE", 413);
      if (!row.payload.startsWith(PREFIX)) {
        if (refs.length) fail("LEGACY_REFS_PRESENT");
        const value = protection.open(row.payload, rowContext(run, row, kind)); bounded(value); valueShape(value, kind); return value;
      }
      const descriptor = protection.open(row.payload.slice(PREFIX.length), rowContext(run, row, kind));
      exact(descriptor, ["format", "bindingDigest", "value", "parts"]);
      C.sha(descriptor.bindingDigest);
      if (descriptor.format !== FORMAT || descriptor.bindingDigest !== bindingDigest(bound)) fail("BINDING_MISMATCH");
      if (!Array.isArray(descriptor.parts) || descriptor.parts.length > SLOTS.length) fail("PARTS_INVALID");
      const advertised = descriptor.parts.map(part => {
        exact(part, Object.hasOwn(part, "overlay") ? ["slot", "blockId", "overlay"] : ["slot", "blockId"]);
        return { slot: part.slot, blockId: part.blockId };
      });
      refsCheck(advertised);
      if (!C.equal(advertised, refs)) fail("REFS_MISMATCH");
      const value = clone(descriptor.value);
      for (const part of descriptor.parts) {
        const where = location(value, part.slot);
        if (!where || Object.hasOwn(where.parent, where.key)) fail("SLOT_COLLISION");
        const blockType = part.slot === "beforeLink.payload" ? "string" : "object";
        let body = await readBlock(tx, ns, part.blockId, blockType);
        if (Object.hasOwn(part, "overlay")) {
          verifyOverlay(part.overlay, overlayFields(profile, part.slot));
          if (blockType !== "object" || Object.keys(part.overlay).some(key => Object.hasOwn(body, key))) fail("OVERLAY_COLLISION");
          body = { ...body, ...part.overlay };
        }
        where.parent[where.key] = body;
        bounded(value);
      }
      valueShape(value, kind); verifyCurrentSnapshot(value, run, profile, row, kind); return value;
    },
    async publishRefs(tx, { run, row, kind, refs }) {
      C.sha(run.id); C.integer(row.rowNumber, 1, C.LIMITS.rows); refsCheck(refs);
      const [, remove, insert] = methods(kind), key = { runId: run.id, rowNumber: row.rowNumber };
      const result = await tx[remove](key);
      if (!Number.isSafeInteger(result?.rowsAffected) || result.rowsAffected < 0) fail("REFS_WRITE_INVALID");
      for (const ref of refs) if ((await tx[insert]({ ...key, ...ref }))?.rowsAffected !== 1) fail("REFS_WRITE_INVALID");
    },
  });
}
module.exports = { createDataImportPayloadStore };

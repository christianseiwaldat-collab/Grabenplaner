'use strict';
const crypto = require('node:crypto');
const C = require('./data-import-contract');
const TTL = 15 * 60 * 1000, CHUNK = 64 * 1024;
const ENTRY_LIMIT = 64 * 1024 * 1024, STORE_LIMIT = 128 * 1024 * 1024, ENTRIES = 16;
// Encrypted in-process checkpoints/results, bounded by both count and bytes.
// Cancellation retains the signed analysis identity after a cursor is consumed,
// so a late cancel cannot publish the next checkpoint/result from that batch.
function createSalesBwlAbcStore({ now = Date.now } = {}) {
  const entries = new Map(), analyses = new Map(); let bytes = 0;
  function remove(id) { const entry = entries.get(id); if (entry) bytes -= entry.bytes; entries.delete(id); }
  function forget(id) { analyses.delete(id); for (const [key, e] of entries) if (e.analysisId === id) remove(key); }
  function prune() { for (const [id, a] of analyses) if (a.expires <= now()) forget(id); }
  function analysis(id, context) {
    prune(); const value = analyses.get(id);
    if (!value || value.context !== C.fingerprint(context)) C.fail('BWL_ABC_ANALYSIS_EXPIRED', 409);
    if (value.cancelled) C.fail('BWL_ABC_ANALYSIS_CANCELLED', 409);
    return value;
  }
  function decode(protection, context, token) {
    if (typeof token !== 'string' || !token.length || token.length > 16384) C.fail('BWL_ABC_TOKEN_INVALID');
    const value = protection.open(token, context);
    if (!value || typeof value.id !== 'string' || typeof value.analysisId !== 'string' || !Number.isSafeInteger(value.expires)
      || !Number.isSafeInteger(value.chunks) || !['cursor', 'snapshot'].includes(value.purpose)) C.fail('BWL_ABC_TOKEN_INVALID');
    return value;
  }
  function load(protection, context, token, purpose, consume) {
    const value = decode(protection, context, token), a = analysis(value.analysisId, context), entry = entries.get(value.id);
    if (value.purpose !== purpose || !entry || entry.analysisId !== value.analysisId || entry.expires !== value.expires
      || entry.expires !== a.expires || entry.chunks.length !== value.chunks || entry.purpose !== purpose) C.fail('BWL_ABC_ANALYSIS_EXPIRED', 409);
    if (consume) remove(value.id);
    const json = entry.chunks.map((chunk, index) => protection.open(chunk, [...context, value.id, index])).join('');
    return { analysisId: value.analysisId, value: JSON.parse(json) };
  }
  return Object.freeze({
    begin(context) {
      prune(); while (analyses.size >= ENTRIES) forget(analyses.keys().next().value);
      const id = crypto.randomUUID(); analyses.set(id, { context: C.fingerprint(context), expires: now() + TTL, cancelled: false }); return id;
    },
    put(protection, context, analysisId, purpose, value) {
      const a = analysis(analysisId, context);
      if (!['cursor', 'snapshot'].includes(purpose)) C.fail('BWL_ABC_TOKEN_INVALID');
      const json = C.canonical(value); if (Buffer.byteLength(json) > ENTRY_LIMIT) C.fail('BWL_ABC_DATA_LIMIT', 413);
      const id = crypto.randomUUID(), chunks = []; let size = 0;
      for (let offset = 0; offset < json.length; offset += CHUNK) {
        const chunk = protection.seal(json.slice(offset, offset + CHUNK), [...context, id, chunks.length]);
        size += Buffer.byteLength(chunk); chunks.push(chunk);
      }
      if (size > ENTRY_LIMIT) C.fail('BWL_ABC_DATA_LIMIT', 413);
      while (entries.size >= ENTRIES || bytes + size > STORE_LIMIT) remove(entries.keys().next().value);
      entries.set(id, { analysisId, purpose, expires: a.expires, chunks, bytes: size }); bytes += size;
      return protection.seal({ id, analysisId, purpose, expires: a.expires, chunks: chunks.length }, context);
    },
    take(protection, context, token) { return load(protection, context, token, 'cursor', true); },
    read(protection, context, token) { return load(protection, context, token, 'snapshot', false); },
    cancel(protection, context, token) {
      const value = decode(protection, context, token), a = analysis(value.analysisId, context);
      a.cancelled = true; for (const [id, e] of entries) if (e.analysisId === value.analysisId) remove(id);
      return { cancelled: true };
    },
    assertActive(analysisId, context) { analysis(analysisId, context); },
    clear() { entries.clear(); analyses.clear(); bytes = 0; },
  });
}
module.exports = { createSalesBwlAbcStore, TTL };

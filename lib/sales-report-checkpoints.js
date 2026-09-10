'use strict';
const crypto = require('node:crypto');
const C = require('./data-import-contract');
const CHUNK_CHARACTERS = 64 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024, MAX_STORE_BYTES = 128 * 1024 * 1024;
const TTL = 15 * 60 * 1000;

// Ephemeral, authenticated chunks, never source rows or plaintext checkpoints in
// the queue/database. The small cursor is bound to the original principal context.
function createSalesReportCheckpointStore({ now = Date.now } = {}) {
  const entries = new Map();
  let bytes = 0;
  function remove(id) { const entry = entries.get(id); if (entry) bytes -= entry.bytes; entries.delete(id); }
  return Object.freeze({
    put(protection, context, state) {
      for (const [id, entry] of entries) if (entry.expires <= now()) remove(id);
      const json = C.canonical(state);
      if (Buffer.byteLength(json) > MAX_ENTRY_BYTES) C.fail('IMPORT_REPORT_DATA_LIMIT', 413);
      const id = crypto.randomUUID(), chunks = [];
      let size = 0;
      for (let offset = 0; offset < json.length; offset += CHUNK_CHARACTERS) {
        const chunk = protection.seal(json.slice(offset, offset + CHUNK_CHARACTERS), [...context, id, chunks.length]);
        size += Buffer.byteLength(chunk); chunks.push(chunk);
      }
      if (size > MAX_ENTRY_BYTES) C.fail('IMPORT_REPORT_DATA_LIMIT', 413);
      while (entries.size >= 16 || bytes + size > MAX_STORE_BYTES) remove(entries.keys().next().value);
      const expires = now() + TTL;
      const token = protection.seal({ id, expires, chunks: chunks.length }, context);
      entries.set(id, { chunks, expires, bytes: size }); bytes += size;
      return token;
    },
    take(protection, context, token) {
      const cursor = protection.open(token, context), entry = entries.get(cursor.id);
      if (!entry || cursor.expires !== entry.expires || cursor.chunks !== entry.chunks.length || entry.expires <= now()) {
        C.fail('IMPORT_HISTORY_ANALYSIS_EXPIRED', 409);
      }
      // A cursor advances once; replay and interrupted batches cannot reuse state.
      remove(cursor.id);
      const json = entry.chunks.map((chunk, index) => protection.open(chunk, [...context, cursor.id, index])).join('');
      return JSON.parse(json);
    },
    clear() { entries.clear(); bytes = 0; },
  });
}
module.exports = { createSalesReportCheckpointStore };

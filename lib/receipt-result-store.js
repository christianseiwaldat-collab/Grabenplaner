'use strict';
const crypto = require('node:crypto');
const C = require('./data-import-contract');
const { compareRows } = require('./receipt-search');
const MAX_ROWS = 10000, MAX_ENTRY_BYTES = 16 * 1024 * 1024, MAX_STORE_BYTES = 64 * 1024 * 1024;
const TTL = 15 * 60 * 1000;
function createReceiptResultStore() { return { entries: new Map(), busy: new Set() }; }

// Only bounded, encrypted search summaries live here. Receipt lines and source
// copies are never persisted; an incomplete scan is never presented as sorted.
async function sortedSearch({ store, protection, owner, query: q, epoch, scan, now }) {
  const signature = protection.digest({ ...q, cursor: '', resultSet: '', limit: 0, sort: '', direction: '' });
  const context = ['receipt-sorted-results-v1', owner];
  const chunkContext = (id, index) => [...context, id, index];
  let saved, token = null, id;
  for (const [key, entry] of store.entries) if (entry.expires < now() && !store.busy.has(key)) store.entries.delete(key);
  if (q.cursor || q.resultSet) {
    try { token = protection.open(q.cursor || q.resultSet, context); } catch { C.fail('IMPORT_HISTORY_RESULTS_CHANGED', 409); }
    saved = store.entries.get(token.id); id = token.id;
    if (!saved || saved.owner !== owner || saved.signature !== signature || saved.epoch !== epoch || token.expires !== saved.expires
      || token.signature !== signature || saved.expires < now() || (token.mode === 'scan' && token.version !== saved.version)
      || (q.cursor && token.mode === 'page' && (token.sort !== q.sort || token.direction !== q.direction))) C.fail('IMPORT_HISTORY_RESULTS_CHANGED', 409);
    if (q.resultSet && !q.cursor && (!saved.complete || token.mode !== 'resultSet')) C.fail('IMPORT_HISTORY_RESULTS_CHANGED', 409);
  } else {
    const own = [...store.entries].filter(([key, e]) => e.owner === owner && !store.busy.has(key));
    while (own.length >= 4) store.entries.delete(own.shift()[0]);
    if (store.entries.size >= 16) C.fail('IMPORT_RECEIPT_SEARCH_BUSY', 429);
    id = crypto.randomUUID();
    saved = { owner, signature, epoch, expires: now() + TTL, version: 0, count: 0, bytes: 0, chunks: [], cursor: '', complete: false };
    store.entries.set(id, saved);
  }
  if (store.busy.has(id)) C.fail('IMPORT_RECEIPT_SEARCH_BUSY', 409);
  store.busy.add(id);
  const seal = data => protection.seal({ id, signature, expires: saved.expires, ...data }, context);
  try {
    let processed = 0;
    if (!saved.complete) {
      const batch = await scan({ ...q, sort: 'date', direction: 'desc', resultSet: '', cursor: saved.cursor, limit: 100 });
      if (batch.epoch !== epoch) C.fail('IMPORT_HISTORY_RESULTS_CHANGED', 409);
      const chunk = batch.items.length ? protection.seal(batch.items, chunkContext(id, saved.chunks.length)) : null;
      const bytes = chunk ? Buffer.byteLength(chunk) : 0;
      if (saved.count + batch.items.length > MAX_ROWS || saved.bytes + bytes > MAX_ENTRY_BYTES) C.fail('IMPORT_RECEIPT_SEARCH_LIMIT', 413);
      if ([...store.entries.values()].reduce((n, e) => n + e.bytes, 0) + bytes > MAX_STORE_BYTES) C.fail('IMPORT_RECEIPT_SEARCH_BUSY', 429);
      if (chunk) saved.chunks.push(chunk);
      saved.bytes += bytes; saved.count += batch.items.length; saved.cursor = batch.next; saved.complete = batch.complete; saved.version++; processed = batch.processed;
    }
    if (!saved.complete) return { items: [], processed, matched: saved.count, complete: false, sorting: true,
      next: seal({ mode: 'scan', version: saved.version }), resultSet: null };
    const items = saved.chunks.flatMap((chunk, index) => protection.open(chunk, chunkContext(id, index)));
    if (items.length !== saved.count) C.fail('IMPORT_HISTORY_INTEGRITY');
    items.sort((a, b) => compareRows(a, b, q.sort, q.direction));
    const offset = q.cursor && token?.mode === 'page' ? token.offset : 0;
    C.integer(offset, 0, MAX_ROWS);
    const end = offset + q.limit, more = end < items.length;
    return { items: items.slice(offset, end), processed, matched: saved.count, total: saved.count, complete: !more, sorting: false,
      next: more ? seal({ mode: 'page', offset: end, sort: q.sort, direction: q.direction }) : null,
      resultSet: seal({ mode: 'resultSet' }), order: q.sort + '_' + q.direction };
  } catch (error) { store.entries.delete(id); throw error; }
  finally { store.busy.delete(id); }
}
module.exports = { createReceiptResultStore, sortedSearch };

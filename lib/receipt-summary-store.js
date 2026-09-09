'use strict';
const C = require('./data-import-contract');
const MAX_ENTRIES = 2000, MAX_BYTES = 16 * 1024 * 1024, MAX_ENTRY_BYTES = 256 * 1024, TTL = 15 * 60 * 1000;

// A bounded runtime cache of verified position summaries. No complete source
// rows, per-line prices or CRM records live here. Keys bind the authenticated
// publication, source revision and personal permission projection; values are
// encrypted with the managed import key and never outlive their process.
function createReceiptSummaryStore() { return { entries: new Map(), bytes: 0 }; }
function remove(store, key) {
  const entry = store.entries.get(key);
  if (entry) { store.bytes -= entry.bytes; store.entries.delete(key); }
}
function readReceiptSummary({ store, protection, context, now }) {
  const key = protection.digest(context), entry = store.entries.get(key);
  if (!entry) return null;
  if (entry.expires <= now()) { remove(store, key); return null; }
  try {
    const value = protection.open(entry.payload, context);
    store.entries.delete(key); store.entries.set(key, entry);
    return value;
  } catch {
    // Rebuild a damaged derived entry from fully checked source data.
    remove(store, key); return null;
  }
}
function writeReceiptSummary({ store, protection, context, now, value }) {
  const key = protection.digest(context);
  remove(store, key);
  // Oversized receipts remain searchable; they simply bypass this cache.
  if (Buffer.byteLength(C.canonical(value)) > MAX_ENTRY_BYTES) return;
  const payload = protection.seal(value, context), bytes = Buffer.byteLength(payload);
  if (bytes > MAX_ENTRY_BYTES) return;
  while (store.entries.size && (store.entries.size >= MAX_ENTRIES || store.bytes + bytes > MAX_BYTES)) remove(store, store.entries.keys().next().value);
  store.entries.set(key, { payload, bytes, expires: now() + TTL }); store.bytes += bytes;
}
module.exports = { createReceiptSummaryStore, readReceiptSummary, writeReceiptSummary,
  RECEIPT_SUMMARY_LIMITS: Object.freeze({ MAX_ENTRIES, MAX_BYTES, MAX_ENTRY_BYTES, TTL }) };

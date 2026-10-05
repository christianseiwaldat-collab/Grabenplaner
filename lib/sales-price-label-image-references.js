'use strict';
const { createDataImportProtection } = require('./data-import-protection');
const IMAGE_KIND = 'price-label-image', REFERENCE_KIND = 'price-label-image-storage-v1';
const STORAGE_KEY = /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.amu$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = () => { throw Object.assign(new Error('Geschützte Bildreferenzen sind nicht konsistent.'), { code: 'PRICE_LABEL_IMAGE_INTEGRITY', status: 503 }); };
function validateImageMetadata(value, id) {
 if (!value || value.schemaVersion !== 1 || value.assetId !== id || !UUID.test(id)
  || typeof value.ownerId !== 'string' || !/^(employee|account):.+$/.test(value.ownerId)
  || !Number.isSafeInteger(value.width) || value.width < 1 || value.width > 1600
  || !Number.isSafeInteger(value.height) || value.height < 1 || value.height > 1600
  || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 10 * 1024 * 1024
  || !/^[a-f0-9]{64}$/.test(value.sha256) || !STORAGE_KEY.test(value.storageKey)) fail();
 return value;
}
// The only cleartext projection is an opaque random storage key. All associations
// remain encrypted and authenticated, including the marker's exact scope and ID.
function verifyImageReferenceRows(rows, protection) {
 if (!Array.isArray(rows) || !protection && rows.length) fail();
 const images = new Map(), markers = new Map(), ids = new Set(), keys = new Set();
 try {
  for (const row of rows) {
   if (!row || ![IMAGE_KIND, REFERENCE_KIND].includes(row.kind) || typeof row.scopeId !== 'string'
    || !/^[a-f0-9]{64}$/.test(row.id) || ids.has(row.id) || ![1, '1'].includes(row.revision)) fail();
   ids.add(row.id);
   // node-postgres returns BIGINT as decimal text; the authenticated application
   // revision remains the integer 1 on both adapters, never arbitrary coercion.
   const value = protection.open(row.payload, ['trade-annotation-v1', row.scopeId, row.kind, row.id, 1]);
   if (!value || !UUID.test(value.assetId) || row.id !== protection.digest(['trade-annotation-id', row.scopeId, row.kind, value.assetId])) fail();
   if (row.kind === IMAGE_KIND) {
    validateImageMetadata(value, value.assetId);
    if (!row.scopeId.endsWith(':price-label-images') || images.has(value.assetId) || keys.has(value.storageKey)) fail();
    images.set(value.assetId, value); keys.add(value.storageKey);
   } else {
    if (value.schemaVersion !== 1 || value.storageKey !== row.scopeId || !STORAGE_KEY.test(row.scopeId) || markers.has(value.assetId)) fail();
    markers.set(value.assetId, value.storageKey);
   }
  }
  if (images.size !== markers.size) fail();
  for (const [id, value] of images) if (markers.get(id) !== value.storageKey) fail();
  return [...images.values()].map(value => ({ storageKey: value.storageKey, byteSize: value.bytes, sha256: value.sha256, detectedMime: 'image/png' }));
 } catch { fail(); }
}
async function verifyPriceLabelImageRows({ rows, keyPayload, vault }) {
 if (!Array.isArray(rows)) fail();
 if (!rows.length) return [];
 let protection;
 try {
  if (!keyPayload || typeof vault?.useSecret !== 'function') fail();
  await vault.useSecret(keyPayload, { namespace: 'data-import', connectorId: 'data-import-v1', field: 'data-and-index-keys', purpose: 'source-archive-and-recovery' }, bytes => {
   if (bytes.length !== 64) fail();
   protection = createDataImportProtection({ encryptionKey: bytes.subarray(0, 32), indexKey: bytes.subarray(32), keyId: 'data-import-v1', compression: true });
  });
  return verifyImageReferenceRows(rows, protection);
 } catch { fail(); }
 finally { protection?.destroy(); }
}
function verifyPriceLabelImageRowsSync({ rows, keyPayload, vault }) {
 if (!Array.isArray(rows)) fail();
 if (!rows.length) return [];
 let protection;
 try {
  if (!keyPayload || typeof vault?.useSecretSync !== 'function') fail();
  vault.useSecretSync(keyPayload, { namespace: 'data-import', connectorId: 'data-import-v1', field: 'data-and-index-keys', purpose: 'source-archive-and-recovery' }, bytes => {
   if (bytes.length !== 64) fail();
   protection = createDataImportProtection({ encryptionKey: bytes.subarray(0, 32), indexKey: bytes.subarray(32), keyId: 'data-import-v1', compression: true });
  });
  return verifyImageReferenceRows(rows, protection);
 } catch { fail(); }
 finally { protection?.destroy(); }
}
module.exports = { IMAGE_KIND, REFERENCE_KIND, STORAGE_KEY, validateImageMetadata, verifyImageReferenceRows, verifyPriceLabelImageRows, verifyPriceLabelImageRowsSync };

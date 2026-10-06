'use strict';
const crypto = require('node:crypto');
const sharp = require('sharp');
const { assertPersistenceAccess } = require('./persistence/contract');
const { loadManagedDataImportProtection } = require('./data-import-managed-protection');
const { annotations } = require('./persistence/repositories/trade-annotations');
const { A } = require('./persistence/statements/trade-annotations');
const { REFERENCE_KIND, validateImageMetadata, verifyImageReferenceRows } = require('./sales-price-label-image-references');
const { assertTemplateContext, SalesPriceLabelTemplateError } = require('./sales-price-label-template-store');
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024, MAX_PIXELS = 24_000_000, MAX_EDGE = 1600;
const MAX_OWNER_IMAGES = 200, MAX_OWNER_BYTES = 256 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = (message, code = 'PRICE_LABEL_IMAGE_INPUT', status = 400) => { throw new SalesPriceLabelTemplateError(message, code, status); };
const unavailable = () => fail('Dieses Bild ist nicht verfügbar.', 'PRICE_LABEL_IMAGE_NOT_FOUND', 404);
function imageIds(options) {
 const boxes = options?.imageBoxes || [];
 if (!Array.isArray(boxes) || boxes.length > 3 || boxes.some(row => !UUID.test(row?.assetId)) || new Set(boxes.map(row => row.assetId)).size !== boxes.length)
  fail('Bitte höchstens drei unterschiedliche Bilder verwenden.');
 return boxes.map(row => row.assetId);
}
function rasterKind(buffer) {
 if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
 if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpeg';
 if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
 if (/^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) return 'gif';
 return null;
}
async function normalizeImage(buffer) {
 if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_UPLOAD_BYTES) fail('Die Bilddatei darf höchstens 10 MiB groß sein.', 'PRICE_LABEL_IMAGE_SIZE', 413);
 const kind = rasterKind(buffer); if (!kind) fail('Bitte PNG, JPEG, WebP oder ein unbewegtes GIF hochladen.');
 try {
  const image = sharp(buffer, { failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true }).timeout({ seconds: 10 });
  const metadata = await image.metadata();
  if (metadata.format !== kind || !metadata.width || !metadata.height || metadata.width > 10000 || metadata.height > 10000
    || metadata.width * metadata.height > MAX_PIXELS || (metadata.pages || 1) !== 1) fail('Das Bild ist zu groß oder enthält mehrere Bildseiten.');
  const { data, info } = await image.rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
   .toColourspace('srgb').png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true });
  if (!data.length || data.length > MAX_UPLOAD_BYTES) fail('Das aufbereitete Bild ist zu groß.', 'PRICE_LABEL_IMAGE_SIZE', 413);
  return { buffer: data, width: info.width, height: info.height };
 } catch (error) {
  if (error instanceof SalesPriceLabelTemplateError) throw error;
  fail('Die Bilddatei konnte nicht vollständig und sicher gelesen werden.');
 }
}
// Only this authenticated endpoint reads a bounded binary body. The global
// JSON limit is unchanged; client filenames never become persisted paths.
async function readImageUpload(req) {
 const type = String(req.get?.('Content-Type') || req.headers?.['content-type'] || '');
 const length = req.get?.('Content-Length') || req.headers?.['content-length'];
 const maximum = MAX_UPLOAD_BYTES + 16 * 1024;
 if (length && (!/^\d+$/.test(String(length)) || Number(length) > maximum)) fail('Die Bilddatei darf höchstens 10 MiB groß sein.', 'PRICE_LABEL_IMAGE_SIZE', 413);
 if (req.get?.('Content-Encoding') || req.headers?.['content-encoding']) fail('Komprimierte Upload-Anfragen sind nicht zulässig.');
 const chunks = []; let size = 0;
 for await (const chunk of req) { size += chunk.length; if (size > maximum) fail('Die Bilddatei darf höchstens 10 MiB groß sein.', 'PRICE_LABEL_IMAGE_SIZE', 413); chunks.push(chunk); }
 const body = Buffer.concat(chunks);
 if (/^(?:image\/(?:png|jpeg|webp|gif)|application\/octet-stream)(?:\s*;|$)/i.test(type)) {
  if (body.length > MAX_UPLOAD_BYTES) fail('Die Bilddatei darf höchstens 10 MiB groß sein.', 'PRICE_LABEL_IMAGE_SIZE', 413);
  return body;
 }
 const boundary = /^multipart\/form-data\s*;\s*boundary=(?:"([A-Za-z0-9'()+_,.\/:=? -]{1,70})"|([A-Za-z0-9'()+_,.\/:=?-]{1,70}))\s*$/i.exec(type);
 if (!boundary) fail('Bitte genau eine Bilddatei hochladen.');
 const token = boundary[1] || boundary[2], start = Buffer.from('--' + token + '\r\n'), end = Buffer.from('\r\n--' + token + '--');
 if (!body.subarray(0, start.length).equals(start)) fail('Der Bild-Upload ist unvollständig.');
 const headerEnd = body.indexOf('\r\n\r\n', start.length), closing = body.indexOf(end, start.length);
 if (headerEnd < 0 || headerEnd - start.length > 8192 || closing < headerEnd + 4 || !['', '\r\n'].includes(body.subarray(closing + end.length).toString('ascii'))) fail('Bitte genau eine Bilddatei hochladen.');
 const headers = body.subarray(start.length, headerEnd).toString('latin1').split('\r\n');
 if (headers.length > 2 || headers.filter(row => /^Content-Disposition:/i.test(row)).length !== 1
   || !headers.some(row => /^Content-Disposition:\s*form-data;\s*name="image";\s*filename="[^"\r\n\x00]{0,255}"\s*$/i.test(row))
   || headers.some(row => !/^(?:Content-Disposition|Content-Type):/i.test(row))) fail('Bitte das Datei-Feld „image“ verwenden.');
 const content = body.subarray(headerEnd + 4, closing);
 if (content.includes(Buffer.from('\r\n--' + token))) fail('Bitte genau eine Bilddatei hochladen.');
 if (content.length > MAX_UPLOAD_BYTES) fail('Die Bilddatei darf höchstens 10 MiB groß sein.', 'PRICE_LABEL_IMAGE_SIZE', 413);
 return content;
}
function createSalesPriceLabelImageStore({ access, vault, storage, canReadAsset = async () => false, scopeId = 'grabenplaner-main' }) {
 assertPersistenceAccess(access);
 if (typeof storage !== 'function') throw new TypeError('Protected image storage required');
 const scope = scopeId + ':price-label-images'; let processing = 0;
 async function protectedWork(write, operation, beforeTransaction = async () => {}) {
  let protection;
  try { protection = await loadManagedDataImportProtection({ access, vault, create: write });
   if (!protection) return operation(null, null);
   await beforeTransaction();
   return await access.transaction(tx => operation(annotations({ protection, scopeId: scope }), tx, protection), { isolation: 'serializable', readOnly: !write });
  } catch (error) {
   if (['IMPORT_CONCURRENT_CHANGE', 'PERSISTENCE_RETRYABLE_TRANSACTION', 'PERSISTENCE_BUSY', 'PERSISTENCE_UNIQUE_VIOLATION'].includes(error.code))
    fail('Die Bildablage wurde inzwischen geändert. Bitte den Upload erneut versuchen.', 'PRICE_LABEL_IMAGE_CONFLICT', 409);
   if (['IMPORT_VAULT_UNAVAILABLE', 'IMPORT_PROTECTED_PAYLOAD_INVALID', 'IMPORT_PROTECTION_KEY_INVALID'].includes(error.code))
    fail('Die geschützte Bildablage konnte nicht sicher geöffnet werden.', 'PRICE_LABEL_IMAGE_STORAGE', 503);
   throw error;
  } finally { protection?.destroy(); }
 }
 function valid(value, id) {
  return validateImageMetadata(value, id);
 }
 const descriptor = value => ({ assetId: value.assetId, width: value.width, height: value.height, bytes: value.bytes, mime: 'image/png', url: '/api/sales/price-labels/images/' + value.assetId });
 function availableIndex(value, bytes, checkQuota = true) {
  const index = value || { schemaVersion: 1, images: [] };
  if (index.schemaVersion !== 1 || !Array.isArray(index.images) || index.images.length > MAX_OWNER_IMAGES
    || index.images.some(row => !UUID.test(row.assetId) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_UPLOAD_BYTES)) fail('Die Bildablage konnte nicht geprüft werden.', 'PRICE_LABEL_IMAGE_INTEGRITY', 503);
  if (checkQuota && (index.images.length >= MAX_OWNER_IMAGES || index.images.reduce((sum, row) => sum + row.bytes, 0) + bytes > MAX_OWNER_BYTES)) fail('Die geschützte Bildablage dieses Kontos ist voll.', 'PRICE_LABEL_IMAGE_QUOTA', 413);
  return index;
 }
 async function metadata(context, id, assertFresh = async () => {}) {
  assertTemplateContext(context); if (!UUID.test(id)) unavailable();
  const value = await protectedWork(false, async (store, tx, protection) => {
   if (!store) return null;
   const value = (await store.read(tx, 'price-label-image', id)).value;
   if (!value) return null;
   valid(value, id);
   const marker = (await annotations({ protection, scopeId: value.storageKey }).read(tx, REFERENCE_KIND, id)).value;
   if (!marker || marker.schemaVersion !== 1 || marker.assetId !== id || marker.storageKey !== value.storageKey) fail('Die gespeicherte Bildreferenz ist beschädigt.', 'PRICE_LABEL_IMAGE_INTEGRITY', 503);
   return value;
  });
  if (!value) unavailable(); valid(value, id);
  if (value.ownerId !== context.owner.id && !await canReadAsset(context, id)) unavailable();
  await assertFresh(); return value;
 }
 async function content(context, id, { assertFresh = async () => {} } = {}) {
  const value = await metadata(context, id, assertFresh);
  try {
   const buffer = await storage().readBuffer({ storageKey: value.storageKey, byteSize: value.bytes, sha256: value.sha256, detectedMime: 'image/png', originalFilename: 'Preisschild-Bild.png' });
   if (buffer.length !== value.bytes || crypto.createHash('sha256').update(buffer).digest('hex') !== value.sha256) throw new Error();
   // A template share can be revoked independently of the account projection.
   // Re-read that grant after the encrypted file was opened and verified.
   await metadata(context, id, assertFresh); return { ...descriptor(value), buffer };
  } catch (error) { if (error instanceof SalesPriceLabelTemplateError || error.status === 403) throw error; fail('Das gespeicherte Bild konnte nicht sicher gelesen werden.', 'PRICE_LABEL_IMAGE_INTEGRITY', 503); }
 }
 return Object.freeze({
  async listOwned(context, { assertFresh = async () => {} } = {}) {
   assertTemplateContext(context);
   const index = await protectedWork(false, async (store, tx) => availableIndex(store ? (await store.read(tx, 'price-label-image-owner', context.owner.id)).value : null, 0, false));
   const result=[];
   for(const row of index.images.slice(-40).reverse()) { const value=await metadata(context,row.assetId,assertFresh); if(value.ownerId!==context.owner.id)unavailable();result.push({...descriptor(value),createdAt:value.createdAt}); }
   await assertFresh();return result;
  },
  async create(context, input, { assertFresh = async () => {}, uploadId } = {}) {
   assertTemplateContext(context); if (processing >= 2) fail('Die Bildaufbereitung ist gerade ausgelastet. Bitte erneut versuchen.', 'PRICE_LABEL_IMAGE_BUSY', 503);
   if(uploadId!==undefined&&!UUID.test(uploadId))fail('Die Upload-Kennung ist ungültig.');
   const sourceSha256=Buffer.isBuffer(input)?crypto.createHash('sha256').update(input).digest('hex'):'';
   if(uploadId){
    const receipt=await protectedWork(false,async(store,tx)=>store?(await store.read(tx,'price-label-upload-receipt',context.owner.id+':'+uploadId)).value:null);
    if(receipt){
     if(receipt.schemaVersion!==1||receipt.ownerId!==context.owner.id||receipt.uploadId!==uploadId||!UUID.test(receipt.assetId)||receipt.sourceSha256!==sourceSha256)fail('Diese Upload-Kennung gehört zu einer anderen Datei.','PRICE_LABEL_IMAGE_CONFLICT',409);
     await assertFresh();return descriptor(await metadata(context,receipt.assetId,assertFresh));
    }
   }
   processing++;
   try {
    await assertFresh(); const normalized = await normalizeImage(input); await assertFresh();
    const assetId = crypto.randomUUID(), value = { schemaVersion: 1, assetId, ownerId: context.owner.id, width: normalized.width, height: normalized.height,
     bytes: normalized.buffer.length, sha256: crypto.createHash('sha256').update(normalized.buffer).digest('hex'), createdAt: new Date().toISOString() };
    await protectedWork(false, async (store, tx) => availableIndex(store ? (await store.read(tx, 'price-label-image-owner', context.owner.id)).value : null, value.bytes));
    // AMU's authenticated encrypted blobs already participate in both local
    // SQLite and PostgreSQL paired backup/recovery, including virus scanning.
    const stored = await storage().saveBuffer({ buffer: normalized.buffer, originalName: 'Preisschild-Bild.png', maxBytes: MAX_UPLOAD_BYTES });
    value.storageKey = stored.storageKey; valid(value, assetId);
    const result = await protectedWork(true, async (store, tx, protection) => {
     const prior = await store.read(tx, 'price-label-image-owner', context.owner.id), index = availableIndex(prior.value, value.bytes);
     // Immutable assets survive replacement/removal from an editor. This never
     // breaks another draft/template; failed DB commits may leave private orphans.
     // Session/context freshness uses the application provider, so it runs just
     // before this transaction and again after commit. No global provider query
     // is allowed inside this transaction-bound metadata/ownership operation.
     await store.write(tx, 'price-label-image', assetId, value, 0, context.owner.id);
     await annotations({ protection, scopeId: value.storageKey }).write(tx, REFERENCE_KIND, assetId,
      { schemaVersion: 1, assetId, storageKey: value.storageKey }, 0, context.owner.id);
     index.images.push({ assetId, bytes: value.bytes }); await store.write(tx, 'price-label-image-owner', context.owner.id, index, prior.revision, context.owner.id);
     if(uploadId)await store.write(tx,'price-label-upload-receipt',context.owner.id+':'+uploadId,{schemaVersion:1,ownerId:context.owner.id,uploadId,sourceSha256,assetId},0,context.owner.id);
     return descriptor(value);
    }, assertFresh);
    await assertFresh(); return result;
   } finally { processing--; }
  },
  content,
  async verifyStoredImages({ verifyFiles = true } = {}) {
   const files = await protectedWork(false, async (store, tx, protection) => verifyImageReferenceRows(await (tx || access).queryAll(A.protectedImages, {}), protection));
   if (verifyFiles) for (const file of files) storage().readBuffer(file);
   return files.map(file => file.storageKey);
  },
  async validateOptions(context, options, { assertFresh = async () => {} } = {}) {
   const proof = []; for (const id of imageIds(options)) { const value = await metadata(context, id, assertFresh); proof.push({ assetId: id, ownerId: value.ownerId }); } return proof;
  },
  async resolve(context, options, { assertFresh = async () => {} } = {}) { const result = new Map(); for (const id of imageIds(options)) result.set(id, (await content(context, id, { assertFresh })).buffer); return result; },
 });
}
module.exports = { createSalesPriceLabelImageStore, normalizeImage, readImageUpload, imageIds, MAX_UPLOAD_BYTES, MAX_PIXELS, MAX_EDGE, MAX_OWNER_IMAGES };

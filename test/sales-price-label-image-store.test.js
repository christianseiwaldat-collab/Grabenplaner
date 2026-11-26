'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const sharp = require('sharp'), express = require('express'), { Readable } = require('node:stream');
const I = require('../lib/sales-price-label-image-store'), T = require('../lib/sales-price-label-template-store');
const { createAmuStorage, syncEncryptedFilesBackup, restoreEncryptedFilesBackup } = require('../lib/amu-storage');
const { registerSalesPriceLabelsRoutes } = require('../lib/sales-price-labels-routes');
const { sourceRoot: legacySourceRoot } = require('../test-support/legacy-baseline');
const rights = Object.values(require('../lib/sales-article-catalog-access').SALES_ARTICLE_CATALOG_PERMISSIONS);
const box = assetId => ({ assetId, xMm: 2, yMm: 2, widthMm: 20, heightMm: 15 });
const input = (assetId, extra = {}) => ({ title: 'Synthetic label', options: { imageBoxes: [box(assetId)] }, filenameOptions: {}, visibility: 'private', recipients: [], ...extra });
const png = () => sharp({ create: { width: 120, height: 80, channels: 4, background: '#25A98988' } }).png().toBuffer();
test('image decoding checks magic, complete raster decode and bounds; output strips metadata and scales without external references', async () => {
 const source = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#256477' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
 const image = await I.normalizeImage(source), meta = await sharp(image.buffer).metadata();
 assert.equal(meta.format, 'png'); assert.equal(Math.max(meta.width, meta.height), 1600); assert.equal(meta.exif, undefined); assert.equal(meta.icc, undefined);
 for (const buffer of [Buffer.from('<svg><image href="file:///etc/passwd"/></svg>'), Buffer.from('<html>bad</html>'), (await png()).subarray(0, 30), Buffer.alloc(0), Buffer.alloc(I.MAX_UPLOAD_BYTES + 1)])
  await assert.rejects(I.normalizeImage(buffer), error => error.status === 400 || error.status === 413);
 const bomb = Buffer.from(await png()); bomb.writeUInt32BE(250000, 16); await assert.rejects(I.normalizeImage(bomb));
 for (const format of ['webp', 'jpeg', 'gif']) assert.equal((await sharp((await I.normalizeImage(await sharp(await png())[format]().toBuffer())).buffer).metadata()).format, 'png');
});
test('bounded multipart accepts one image and rejects extra parts, forged field names, unsupported body types and oversized requests', async () => {
 const bytes = await png(), token = 'synthetic-boundary';
 const payload = name => Buffer.concat([Buffer.from(`--${token}\r\nContent-Disposition: form-data; name="${name}"; filename="../../ignored.png"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${token}--\r\n`)]);
 const request = (buffer, type = 'multipart/form-data; boundary=' + token, length = buffer.length) => Object.assign(Readable.from([buffer]), { headers: { 'content-type': type, 'content-length': String(length) } });
 assert.deepEqual(await I.readImageUpload(request(payload('image'))), bytes);
 for (const req of [request(payload('owner')), request(Buffer.concat([payload('image'), payload('image')])), request(bytes, 'application/json'), request(bytes, 'image/png', I.MAX_UPLOAD_BYTES + 20000)]) await assert.rejects(I.readImageUpload(req));
 assert.deepEqual(await I.readImageUpload(request(bytes, 'image/png')), bytes);
});

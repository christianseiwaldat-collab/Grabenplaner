'use strict';
const crypto = require('node:crypto');
const { assertPersistenceAccess } = require('../contract');
const { SALES_ARTICLE_IMAGE_STATEMENTS: S } = require('../statements/sales-article-images');
const { SALES_ARTICLE_CATALOG_STATEMENTS: A } = require('../statements/sales-article-catalog');
const { normalizeSalesArticleNumber, normalizeSalesArticleActor } = require('../../sales-article-catalog');
const { SalesArticleImageError, MAX_OUTPUT_BYTES, MAX_EDGE } = require('../../sales-article-image');
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const meta = row => ({ revision: row?.revision || null, present: Boolean(row?.mime), mime: row?.mime || null,
  width: row?.width || 0, height: row?.height || 0, byteSize: row?.byteSize || 0, updatedAt: row?.updatedAt || null });
const conflict = () => { throw new SalesArticleImageError('Das Artikelbild wurde zwischenzeitlich geändert. Bitte den aktuellen Stand neu laden.', 'ARTICLE_IMAGE_CONFLICT', 409); };
function createSalesArticleImagesRepository(access) {
  assertPersistenceAccess(access);
  return Object.freeze({
    async metadata(articleNumber) { return meta(await access.queryOne(S.metadata, { articleNumber: normalizeSalesArticleNumber(articleNumber) })); },
    async content(articleNumber) {
      const row = await access.queryOne(S.content, { articleNumber: normalizeSalesArticleNumber(articleNumber) });
      if (!row?.content) return null;
      const buffer = Buffer.from(row.content);
      if (buffer.length !== row.byteSize || hash(buffer) !== row.sha256) throw new SalesArticleImageError('Das gespeicherte Bild konnte nicht geprüft werden.', 'ARTICLE_IMAGE_INTEGRITY', 503);
      return { ...meta(row), buffer };
    },
    async save({ articleNumber, productId, expectedRevision, image, actor }) {
      articleNumber = normalizeSalesArticleNumber(articleNumber); actor = normalizeSalesArticleActor(actor);
      if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !/^[a-f0-9-]{36}$/.test(expectedRevision))) conflict();
      if (image && (!Buffer.isBuffer(image.buffer) || !image.buffer.length || image.buffer.length > MAX_OUTPUT_BYTES || image.mime !== 'image/webp'
        || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width > MAX_EDGE || image.height > MAX_EDGE)) {
        throw new SalesArticleImageError('Das aufbereitete Bild ist ungültig.', 'ARTICLE_IMAGE_INVALID');
      }
      return access.transaction(async tx => {
        const article = await tx.queryOne(A.getArticleByNumber, { articleNumber });
        if (!article || article.productId !== productId) conflict();
        const row = { articleNumber, revision: crypto.randomUUID(), mime: image?.mime || null, width: image?.width || 0, height: image?.height || 0,
          byteSize: image?.buffer.length || 0, updatedAt: new Date().toISOString(), content: image?.buffer || null, sha256: image ? hash(image.buffer) : null, actor };
        const result = await tx.execute(expectedRevision === null ? S.insert : S.replace, expectedRevision === null ? row : { ...row, expectedRevision });
        if (result.rowsAffected !== 1) conflict();
        await tx.execute(A.insertAudit, { actor, action: image ? 'sales.article-image.save' : 'sales.article-image.remove', entityType: 'sales_article', entityId: productId,
          detail: { articleNumber, imageRevision: row.revision, previousImageRevision: expectedRevision, byteSize: row.byteSize }, timestamp: row.updatedAt });
        return meta(row);
      }, { isolation: 'serializable' });
    },
  });
}
module.exports = { createSalesArticleImagesRepository };

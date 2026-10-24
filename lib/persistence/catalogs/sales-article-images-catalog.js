'use strict';
const { SALES_ARTICLE_IMAGE_STATEMENTS: S } = require('../statements/sales-article-images');
const meta = 'article_number AS articleNumber, revision, mime, width, height, byte_size AS byteSize, updated_at AS updatedAt';
const entry = (statement, sql) => Object.freeze({ statement, sql, returning: false });
module.exports.SQLITE_SALES_ARTICLE_IMAGES_CATALOG = Object.freeze([
  entry(S.metadata, `SELECT ${meta} FROM sales_article_own_images WHERE article_number=$articleNumber`),
  entry(S.content, `SELECT ${meta},content,sha256 FROM sales_article_own_images WHERE article_number=$articleNumber`),
  entry(S.insert, `INSERT INTO sales_article_own_images (article_number,revision,mime,width,height,byte_size,updated_at,content,sha256,updated_by)
    VALUES ($articleNumber,$revision,$mime,$width,$height,$byteSize,$updatedAt,$content,$sha256,$actor) ON CONFLICT(article_number) DO NOTHING`),
  entry(S.replace, `UPDATE sales_article_own_images SET revision=$revision,mime=$mime,width=$width,height=$height,byte_size=$byteSize,
    updated_at=$updatedAt,content=$content,sha256=$sha256,updated_by=$actor WHERE article_number=$articleNumber AND revision=$expectedRevision`),
]);

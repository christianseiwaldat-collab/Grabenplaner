'use strict';
function ensureSqliteSalesArticleImagesSchema(db) {
  // Business key and image revision are deliberately independent of imported snapshots.
  db.exec(`CREATE TABLE IF NOT EXISTS sales_article_own_images (
    article_number TEXT PRIMARY KEY CHECK(article_number=trim(article_number) AND length(article_number) BETWEEN 1 AND 80),
    revision TEXT NOT NULL CHECK(length(revision)=36),
    mime TEXT CHECK(mime IS NULL OR mime='image/webp'),
    width INTEGER NOT NULL CHECK(width BETWEEN 0 AND 1280),
    height INTEGER NOT NULL CHECK(height BETWEEN 0 AND 1280),
    byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 0 AND 524288),
    content BLOB, sha256 TEXT,
    updated_by TEXT NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 120),
    updated_at TEXT NOT NULL CHECK(length(updated_at)=24),
    CHECK((content IS NULL AND mime IS NULL AND sha256 IS NULL AND width=0 AND height=0 AND byte_size=0)
      OR (typeof(content)='blob' AND length(content)=byte_size AND byte_size>0 AND mime IS NOT NULL
        AND width>0 AND height>0 AND sha256 IS NOT NULL AND length(sha256)=64))
  )`);
}
module.exports = { ensureSqliteSalesArticleImagesSchema };

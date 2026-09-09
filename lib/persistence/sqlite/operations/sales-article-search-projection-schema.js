"use strict";

const { articleSearchProjection } = require("../../../sales-article-search-projection");
const { ARTICLE_SEARCH_PROJECTION_SOURCE_SQL, UPSERT_ARTICLE_SEARCH_PROJECTION_SQL } = require("../sales-article-search-projection-sql");

const ARTICLE_SEARCH_PROJECTION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sales_article_search_projection (
    product_id TEXT PRIMARY KEY REFERENCES sales_articles(product_id),
    article_number TEXT NOT NULL, current_revision INTEGER NOT NULL,
    description TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
    source_snapshot_id TEXT NOT NULL REFERENCES sales_article_import_snapshots(id),
    source_system TEXT NOT NULL, primary_identifier TEXT,
    search_text TEXT NOT NULL, article_number_sort TEXT NOT NULL, description_sort TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sales_article_search_number
    ON sales_article_search_projection(active, article_number_sort, product_id);
  CREATE INDEX IF NOT EXISTS idx_sales_article_search_description
    ON sales_article_search_projection(active, description_sort, article_number_sort, product_id);
  CREATE TABLE IF NOT EXISTS sales_article_search_dirty (product_id TEXT PRIMARY KEY) WITHOUT ROWID;
  CREATE TRIGGER IF NOT EXISTS trg_sales_article_search_insert AFTER INSERT ON sales_articles
    BEGIN INSERT OR IGNORE INTO sales_article_search_dirty VALUES (NEW.product_id); END;
  CREATE TRIGGER IF NOT EXISTS trg_sales_article_search_head AFTER UPDATE OF article_number,current_revision ON sales_articles
    BEGIN INSERT OR IGNORE INTO sales_article_search_dirty VALUES (NEW.product_id); END;
  CREATE TRIGGER IF NOT EXISTS trg_sales_article_search_revision AFTER INSERT ON sales_article_revisions
    WHEN EXISTS (SELECT 1 FROM sales_articles WHERE product_id=NEW.product_id AND current_revision=NEW.revision)
    BEGIN INSERT OR IGNORE INTO sales_article_search_dirty VALUES (NEW.product_id); END;
  CREATE TRIGGER IF NOT EXISTS trg_sales_article_search_identifier AFTER INSERT ON sales_article_identifiers
    WHEN EXISTS (SELECT 1 FROM sales_articles a JOIN sales_article_revisions r
      ON r.product_id=a.product_id AND r.revision=a.current_revision
      WHERE a.product_id=NEW.product_id AND r.source_snapshot_id=NEW.source_snapshot_id)
    BEGIN INSERT OR IGNORE INTO sales_article_search_dirty VALUES (NEW.product_id); END;
`;

function ensureSqliteArticleSearchProjection(database) {
  database.exec("SAVEPOINT sales_article_search_projection");
  let rebuilt = 0;
  try {
    database.exec(ARTICLE_SEARCH_PROJECTION_SCHEMA_SQL);
    database.exec(`INSERT OR IGNORE INTO sales_article_search_dirty
      SELECT a.product_id FROM sales_articles a LEFT JOIN sales_article_search_projection p ON p.product_id=a.product_id
      WHERE p.product_id IS NULL OR p.current_revision<>a.current_revision OR p.article_number<>a.article_number`);
    const pending = database.prepare("SELECT product_id FROM sales_article_search_dirty ORDER BY product_id LIMIT 500");
    const source = database.prepare(ARTICLE_SEARCH_PROJECTION_SOURCE_SQL);
    const upsert = database.prepare(UPSERT_ARTICLE_SEARCH_PROJECTION_SQL);
    const clear = database.prepare("DELETE FROM sales_article_search_dirty WHERE product_id=?");
    for (let batch = pending.all(); batch.length; batch = pending.all()) {
      for (const { product_id: productId } of batch) {
        const row = source.get({ productId });
        if (!row) throw new Error("sales-article-search-source-incomplete");
        upsert.run(articleSearchProjection(row));
        clear.run(productId);
        rebuilt++;
      }
    }
    database.exec("RELEASE SAVEPOINT sales_article_search_projection");
    return rebuilt;
  } catch (error) {
    database.exec("ROLLBACK TO SAVEPOINT sales_article_search_projection");
    database.exec("RELEASE SAVEPOINT sales_article_search_projection");
    throw error;
  }
}

module.exports = { ARTICLE_SEARCH_PROJECTION_SCHEMA_SQL, ensureSqliteArticleSearchProjection };

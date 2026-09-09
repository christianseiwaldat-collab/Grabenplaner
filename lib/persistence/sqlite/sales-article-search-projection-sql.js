"use strict";

const ARTICLE_SEARCH_PROJECTION_SOURCE_SQL = `
  SELECT article.product_id AS productId, article.article_number AS articleNumber,
    article.current_revision AS currentRevision, revision.description, revision.active,
    revision.source_snapshot_id AS sourceSnapshotId, snapshot.source_system AS sourceSystem,
    (SELECT identifier.identifier_value FROM sales_article_identifiers identifier
      WHERE identifier.product_id = article.product_id
        AND identifier.source_snapshot_id = revision.source_snapshot_id
      ORDER BY identifier.is_primary DESC,
        CASE WHEN identifier.source_rank IS NULL THEN 1 ELSE 0 END,
        identifier.source_rank, identifier.canonical_gtin14, identifier.identifier_value
      LIMIT 1) AS primaryIdentifier
  FROM sales_articles article
  JOIN sales_article_revisions revision ON revision.product_id = article.product_id
    AND revision.revision = article.current_revision
  JOIN sales_article_import_snapshots snapshot ON snapshot.id = revision.source_snapshot_id
  WHERE article.product_id = $productId
`;

const UPSERT_ARTICLE_SEARCH_PROJECTION_SQL = `
  INSERT INTO sales_article_search_projection
    (product_id, article_number, current_revision, description, active, source_snapshot_id,
     source_system, primary_identifier, search_text, article_number_sort, description_sort)
  VALUES ($productId, $articleNumber, $currentRevision, $description, $active, $sourceSnapshotId,
    $sourceSystem, $primaryIdentifier, $searchText, $articleNumberSort, $descriptionSort)
  ON CONFLICT(product_id) DO UPDATE SET
    article_number=excluded.article_number, current_revision=excluded.current_revision,
    description=excluded.description, active=excluded.active, source_snapshot_id=excluded.source_snapshot_id,
    source_system=excluded.source_system, primary_identifier=excluded.primary_identifier,
    search_text=excluded.search_text, article_number_sort=excluded.article_number_sort,
    description_sort=excluded.description_sort
`;

module.exports = { ARTICLE_SEARCH_PROJECTION_SOURCE_SQL, UPSERT_ARTICLE_SEARCH_PROJECTION_SQL };

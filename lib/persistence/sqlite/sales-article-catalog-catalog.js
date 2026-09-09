"use strict";
const { MAX_TERMS } = require("../../flexible-search");
const { PRICE_SEARCH_FIELDS: PRICES } = require('../../sales-article-table');
const { ARTICLE_SEARCH_PROJECTION_SOURCE_SQL, UPSERT_ARTICLE_SEARCH_PROJECTION_SQL } = require("./sales-article-search-projection-sql");

const {
  SALES_ARTICLE_CATALOG_STATEMENTS: S,
} = require("../statements/sales-article-catalog");

function entry(statement, sql, returning = false) {
  return Object.freeze({ statement, sql, returning });
}

const IMPORT_COLUMNS = `
  id,
  idempotency_key AS idempotencyKey,
  source_system AS sourceSystem,
  source_profile_version AS sourceProfileVersion,
  source_schema_sha256 AS sourceSchemaSha256,
  source_file_sha256 AS sourceFileSha256,
  content_sha256 AS contentSha256,
  snapshot_at AS snapshotAt,
  article_count AS articleCount,
  identifier_count AS identifierCount,
  price_count AS priceCount,
  imported_by AS importedBy,
  imported_at AS importedAt
`;

const ARTICLE_COLUMNS = `
  article.product_id AS productId,
  article.article_number AS articleNumber,
  article.source_system AS sourceSystem,
  article.source_article_key AS sourceArticleKey,
  article.current_revision AS currentRevision,
  revision.description,
  revision.active,
  revision.source_snapshot_id AS sourceSnapshotId,
  current_snapshot.source_system AS currentSourceSystem,
  revision.source_updated_at AS sourceUpdatedAt,
  article.created_by AS createdBy,
  article.created_at AS createdAt,
  article.updated_by AS updatedBy,
  article.updated_at AS updatedAt
`;

const PRIMARY_IDENTIFIER = "article.primary_identifier";

const ARTICLE_SEARCH_COLUMNS = `
  article.product_id AS productId,
  article.article_number AS articleNumber,
  article.description,
  ${PRIMARY_IDENTIFIER} AS primaryIdentifier,
  article.active,
  article.source_system AS sourceSystem,
  article.current_revision AS currentRevision,
  ${PRICES.map(p => `article.${p.column} AS ${p.id}`).join(', ')}
`;

const ARTICLE_SEARCH_FROM = `
  FROM sales_article_search_projection article
`;

const ARTICLE_NUMBER_SEARCH_VALUE = "article.article_number_sort";
const ARTICLE_DESCRIPTION_SEARCH_VALUE = "article.description_sort";

const ARTICLE_SEARCH_PREDICATE = `
  ${Array.from({ length: MAX_TERMS }, (_, i) => `($query${i} = '%' OR LOWER(article.search_text) LIKE LOWER($query${i}) ESCAPE '!')`).join('\n AND ')}
  AND ($active IS NULL OR article.active = $active)
  AND ($sourceSystem IS NULL OR article.source_system = $sourceSystem)
  AND (
    LOWER('') LIKE LOWER($identifierLike) ESCAPE '!'
    OR EXISTS (
      SELECT 1
      FROM sales_article_identifiers searched_identifier
      WHERE searched_identifier.product_id = article.product_id
        AND searched_identifier.source_snapshot_id = article.source_snapshot_id
        AND (
          LOWER(searched_identifier.identifier_value) LIKE LOWER($identifierLike) ESCAPE '!'
          OR LOWER(searched_identifier.canonical_gtin14) LIKE LOWER($identifierLike) ESCAPE '!'
        )
    )
  )
`;

const SQLITE_SALES_ARTICLE_CATALOG = Object.freeze([
  entry(S.listActiveByNumber, `SELECT ${ARTICLE_SEARCH_COLUMNS} ${ARTICLE_SEARCH_FROM}
    WHERE article.active=$active ORDER BY article.article_number_sort,article.product_id LIMIT $limit OFFSET $offset`),
  entry(S.countActive, 'SELECT COUNT(*) AS total FROM sales_article_search_projection WHERE active=$active'),
  entry(S.searchProjectionDirty, `SELECT product_id AS productId FROM sales_article_search_dirty LIMIT 1`),
  entry(S.searchProjectionSource, ARTICLE_SEARCH_PROJECTION_SOURCE_SQL),
  entry(S.upsertSearchProjection, UPSERT_ARTICLE_SEARCH_PROJECTION_SQL),
  entry(S.clearSearchProjectionDirty, `DELETE FROM sales_article_search_dirty WHERE product_id=$productId`),
  entry(S.search, `
    SELECT ${ARTICLE_SEARCH_COLUMNS}
    ${ARTICLE_SEARCH_FROM}
    WHERE ${ARTICLE_SEARCH_PREDICATE}
    ORDER BY
      ${PRICES.map(p => `CASE WHEN $sort='${p.id}' AND article.${p.column} IS NULL THEN 1 ELSE 0 END ASC,
      CASE WHEN $sort='${p.id}' AND $direction='asc' THEN article.${p.column}_sort END ASC,
      CASE WHEN $sort='${p.id}' AND $direction='desc' THEN article.${p.column}_sort END DESC,`).join('\n      ')}
      CASE WHEN $direction = 'asc' AND $sort = 'articleNumber'
        THEN ${ARTICLE_NUMBER_SEARCH_VALUE} END ASC,
      CASE WHEN $direction = 'desc' AND $sort = 'articleNumber'
        THEN ${ARTICLE_NUMBER_SEARCH_VALUE} END DESC,
      CASE WHEN $direction = 'asc' AND $sort = 'description'
        THEN ${ARTICLE_DESCRIPTION_SEARCH_VALUE} END ASC,
      CASE WHEN $direction = 'desc' AND $sort = 'description'
        THEN ${ARTICLE_DESCRIPTION_SEARCH_VALUE} END DESC,
      CASE WHEN $sort = 'primaryIdentifier' AND ${PRIMARY_IDENTIFIER} IS NULL
        THEN 1 ELSE 0 END ASC,
      CASE WHEN $direction = 'asc' AND $sort = 'primaryIdentifier'
        THEN ${PRIMARY_IDENTIFIER} END ASC,
      CASE WHEN $direction = 'desc' AND $sort = 'primaryIdentifier'
        THEN ${PRIMARY_IDENTIFIER} END DESC,
      CASE WHEN $direction = 'asc' AND $sort = 'status'
        THEN article.active END ASC,
      CASE WHEN $direction = 'desc' AND $sort = 'status'
        THEN article.active END DESC,
      CASE WHEN $direction = 'asc' AND $sort = 'sourceSystem'
        THEN article.source_system END ASC,
      CASE WHEN $direction = 'desc' AND $sort = 'sourceSystem'
        THEN article.source_system END DESC,
      ${ARTICLE_NUMBER_SEARCH_VALUE}, article.product_id
    LIMIT $limit OFFSET $offset
  `),
  entry(S.countSearch, `
    SELECT COUNT(*) AS total
    ${ARTICLE_SEARCH_FROM}
    WHERE ${ARTICLE_SEARCH_PREDICATE}
  `),
  entry(S.getImportSnapshotByIdempotencyKey, `
    SELECT ${IMPORT_COLUMNS}
    FROM sales_article_import_snapshots
    WHERE idempotency_key = $idempotencyKey
  `),
  entry(S.getLatestImportAtBySourceSystem, `
    SELECT imported_at AS importedAt
    FROM sales_article_import_snapshots
    WHERE source_system = $sourceSystem
    ORDER BY imported_at DESC, id DESC
    LIMIT 1
  `),
  entry(S.insertImportSnapshot, `
    INSERT INTO sales_article_import_snapshots (
      id, idempotency_key, source_system, source_profile_version, source_schema_sha256,
      source_file_sha256, content_sha256,
      snapshot_at, article_count, identifier_count, price_count, imported_by, imported_at
    ) VALUES (
      $id, $idempotencyKey, $sourceSystem, $sourceProfileVersion, $sourceSchemaSha256,
      $sourceFileSha256, $contentSha256,
      $snapshotAt, $articleCount, $identifierCount, $priceCount, $actor, $timestamp
    )
  `),
  entry(S.listImportFindings, `
    SELECT
      snapshot_id AS snapshotId,
      ordinal,
      source_row AS sourceRow,
      article_number AS articleNumber,
      code,
      detail_sha256 AS detailSha256,
      created_by AS createdBy,
      created_at AS createdAt
    FROM sales_article_import_findings
    WHERE snapshot_id = $snapshotId
    ORDER BY ordinal
  `),
  entry(S.insertImportFinding, `
    INSERT INTO sales_article_import_findings (
      snapshot_id, ordinal, source_row, article_number, code, detail_sha256,
      created_by, created_at
    ) VALUES (
      $snapshotId, $ordinal, $sourceRow, $articleNumber, $code, $detailSha256,
      $actor, $timestamp
    )
  `),
  entry(S.getImportRunMetadata, `
    SELECT
      snapshot_id AS snapshotId,
      total_count AS totalCount,
      create_count AS createCount,
      update_count AS updateCount,
      unchanged_count AS unchangedCount,
      quarantined_count AS quarantinedCount,
      created_by AS createdBy,
      created_at AS createdAt
    FROM sales_article_import_run_metadata
    WHERE snapshot_id = $snapshotId
  `),
  entry(S.insertImportRunMetadata, `
    INSERT INTO sales_article_import_run_metadata (
      snapshot_id, total_count, create_count, update_count,
      unchanged_count, quarantined_count, created_by, created_at
    ) VALUES (
      $snapshotId, $totalCount, $createCount, $updateCount,
      $unchangedCount, $quarantinedCount, $actor, $timestamp
    )
  `),
  entry(S.listImportImpacts, `
    SELECT
      snapshot_id AS snapshotId,
      ordinal,
      product_id AS productId,
      imported_revision AS importedRevision,
      previous_current_revision AS previousCurrentRevision,
      created_by AS createdBy,
      created_at AS createdAt
    FROM sales_article_import_impacts
    WHERE snapshot_id = $snapshotId
    ORDER BY ordinal
  `),
  entry(S.insertImportImpact, `
    INSERT INTO sales_article_import_impacts (
      snapshot_id, ordinal, product_id, imported_revision,
      previous_current_revision, created_by, created_at
    ) VALUES (
      $snapshotId, $ordinal, $productId, $importedRevision,
      $previousCurrentRevision, $actor, $timestamp
    )
  `),
  entry(S.countImportImpactHeadConflicts, `
    SELECT
      COUNT(*) AS totalCount,
      COALESCE(SUM(CASE
        WHEN article.current_revision = impact.imported_revision
          AND current_revision.source_snapshot_id = impact.snapshot_id
        THEN 0 ELSE 1 END), 0) AS conflictCount
    FROM sales_article_import_impacts impact
    LEFT JOIN sales_articles article
      ON article.product_id = impact.product_id
    LEFT JOIN sales_article_revisions current_revision
      ON current_revision.product_id = article.product_id
     AND current_revision.revision = article.current_revision
    WHERE impact.snapshot_id = $snapshotId
  `),
  entry(S.getArticleBySource, `
    SELECT ${ARTICLE_COLUMNS}
    FROM sales_articles article
    JOIN sales_article_source_links source_link
      ON source_link.product_id = article.product_id
    JOIN sales_article_revisions revision
      ON revision.product_id = article.product_id
     AND revision.revision = article.current_revision
    JOIN sales_article_import_snapshots current_snapshot
      ON current_snapshot.id = revision.source_snapshot_id
    WHERE source_link.source_system = $sourceSystem
      AND source_link.source_article_key = $sourceArticleKey
  `),
  entry(S.getArticleByNumber, `
    SELECT ${ARTICLE_COLUMNS}
    FROM sales_articles article
    JOIN sales_article_revisions revision
      ON revision.product_id = article.product_id
     AND revision.revision = article.current_revision
    JOIN sales_article_import_snapshots current_snapshot
      ON current_snapshot.id = revision.source_snapshot_id
    WHERE article.article_number = $articleNumber
  `),
  entry(S.getArticleByProductId, `
    SELECT ${ARTICLE_COLUMNS}
    FROM sales_articles article
    JOIN sales_article_revisions revision
      ON revision.product_id = article.product_id
     AND revision.revision = article.current_revision
    JOIN sales_article_import_snapshots current_snapshot
      ON current_snapshot.id = revision.source_snapshot_id
    WHERE article.product_id = $productId
  `),
  entry(S.insertArticle, `
    INSERT INTO sales_articles (
      product_id, article_number, source_system, source_article_key, current_revision,
      created_by, created_at, updated_by, updated_at
    ) VALUES (
      $productId, $articleNumber, $sourceSystem, $sourceArticleKey, $currentRevision,
      $actor, $timestamp, $actor, $timestamp
    )
  `),
  entry(S.insertSourceLink, `
    INSERT INTO sales_article_source_links (
      product_id, source_system, source_article_key, source_snapshot_id,
      match_method, match_confidence, matched_source_system,
      matched_source_article_key, source_provider, source_product_number,
      source_url, source_fetched_at, source_created_by, source_updated_by,
      source_created_at, source_updated_at, linked_by, linked_at
    ) VALUES (
      $productId, $sourceSystem, $sourceArticleKey, $sourceSnapshotId,
      $matchMethod, $matchConfidence, $matchedSourceSystem,
      $matchedSourceArticleKey, $sourceProvider, $sourceProductNumber,
      $sourceUrl, $sourceFetchedAt, $sourceCreatedBy, $sourceUpdatedBy,
      $sourceCreatedAt, $sourceUpdatedAt, $actor, $timestamp
    )
  `),
  entry(S.insertRevision, `
    INSERT INTO sales_article_revisions (
      product_id, revision, article_number, description, active, source_snapshot_id,
      source_updated_at, created_by, created_at
    ) VALUES (
      $productId, $revision, $articleNumber, $description, $active, $sourceSnapshotId,
      $sourceUpdatedAt, $actor, $timestamp
    )
  `),
  entry(S.advanceRevision, `
    UPDATE sales_articles
    SET article_number = $articleNumber,
        current_revision = $revision,
        updated_by = $actor,
        updated_at = $timestamp
    WHERE product_id = $productId
      AND current_revision = $expectedRevision
  `),
  entry(S.getLatestRevision, `
    SELECT MAX(revision) AS revision
    FROM sales_article_revisions
    WHERE product_id = $productId
  `),
  entry(S.getRevision, `
    SELECT
      product_id AS productId,
      revision,
      article_number AS articleNumber,
      description,
      active,
      source_snapshot_id AS sourceSnapshotId,
      source_updated_at AS sourceUpdatedAt,
      created_by AS createdBy,
      created_at AS createdAt
    FROM sales_article_revisions
    WHERE product_id = $productId
      AND revision = $revision
  `),
  entry(S.findIdentifierOwner, `
    SELECT product_id AS productId
    FROM sales_article_identifier_owners
    WHERE canonical_gtin14 = $canonicalGtin14
  `),
  entry(S.insertIdentifier, `
    INSERT INTO sales_article_identifiers (
      id, product_id, source_snapshot_id, identifier_type, identifier_value,
      canonical_gtin14, is_primary, source_field, source_rank,
      equivalent_identifiers_json, source_provider, verified_at,
      created_by, created_at, updated_by, updated_at
    ) VALUES (
      $id, $productId, $sourceSnapshotId, $identifierType, $identifierValue,
      $canonicalGtin14, $isPrimary, $sourceField, $sourceRank,
      $equivalentIdentifiers, $sourceProvider, $verifiedAt,
      $createdBy, $createdAt, $updatedBy, $updatedAt
    )
  `),
  entry(S.insertPriceSnapshot, `
    INSERT INTO sales_article_price_snapshots (
      id, product_id, source_snapshot_id, price_type, amount, currency,
      price_basis, quality_status, source_field, created_by, created_at
    ) VALUES (
      $id, $productId, $sourceSnapshotId, $priceType, $amount, $currency,
      $priceBasis, $qualityStatus, $sourceField, $actor, $timestamp
    )
  `),
  entry(S.listCurrentIdentifiers, `
    SELECT
      id,
      product_id AS productId,
      source_snapshot_id AS sourceSnapshotId,
      identifier_type AS identifierType,
      identifier_value AS identifierValue,
      canonical_gtin14 AS canonicalGtin14,
      is_primary AS isPrimary,
      source_field AS sourceField,
      source_rank AS sourceRank,
      equivalent_identifiers_json AS equivalentIdentifiers,
      source_provider AS sourceProvider,
      verified_at AS verifiedAt,
      created_by AS createdBy,
      created_at AS createdAt,
      COALESCE(NULLIF(updated_by, ''), created_by) AS updatedBy,
      COALESCE(NULLIF(updated_at, ''), created_at) AS updatedAt
    FROM sales_article_identifiers
    WHERE product_id = $productId
      AND source_snapshot_id = $sourceSnapshotId
    ORDER BY is_primary DESC, source_rank, canonical_gtin14, identifier_value
  `),
  entry(S.listCurrentPrices, `
    SELECT
      id,
      product_id AS productId,
      source_snapshot_id AS sourceSnapshotId,
      price_type AS priceType,
      amount,
      currency,
      price_basis AS priceBasis,
      quality_status AS qualityStatus,
      source_field AS sourceField,
      created_by AS createdBy,
      created_at AS createdAt
    FROM sales_article_price_snapshots
    WHERE product_id = $productId
      AND source_snapshot_id = $sourceSnapshotId
    ORDER BY price_type
  `),
  entry(S.listRevisions, `
    SELECT
      product_id AS productId,
      revision,
      article_number AS articleNumber,
      description,
      active,
      source_snapshot_id AS sourceSnapshotId,
      source_updated_at AS sourceUpdatedAt,
      created_by AS createdBy,
      created_at AS createdAt
    FROM sales_article_revisions
    WHERE product_id = $productId
    ORDER BY revision DESC
  `),
  entry(S.insertAudit, `
    INSERT INTO audit_log (actor, action, entity_type, entity_id, detail, created_at)
    VALUES ($actor, $action, $entityType, $entityId, $detail, $timestamp)
    RETURNING id
  `, true),
]);

module.exports = {
  SQLITE_SALES_ARTICLE_CATALOG,
};

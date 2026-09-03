"use strict";

const {
  SALES_ARTICLE_CATALOG_STATEMENTS: S,
} = require("../statements/sales-article-catalog");

function entry(statement, sql) {
  return Object.freeze({ statement, sql, returning: false });
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
  revision.source_updated_at AS sourceUpdatedAt,
  article.created_by AS createdBy,
  article.created_at AS createdAt,
  article.updated_by AS updatedBy,
  article.updated_at AS updatedAt
`;

const SQLITE_SALES_ARTICLE_CATALOG = Object.freeze([
  entry(S.getImportSnapshotByIdempotencyKey, `
    SELECT ${IMPORT_COLUMNS}
    FROM sales_article_import_snapshots
    WHERE idempotency_key = $idempotencyKey
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
  entry(S.getArticleBySource, `
    SELECT ${ARTICLE_COLUMNS}
    FROM sales_articles article
    JOIN sales_article_source_links source_link
      ON source_link.product_id = article.product_id
    JOIN sales_article_revisions revision
      ON revision.product_id = article.product_id
     AND revision.revision = article.current_revision
    WHERE source_link.source_system = $sourceSystem
      AND source_link.source_article_key = $sourceArticleKey
  `),
  entry(S.getArticleByNumber, `
    SELECT ${ARTICLE_COLUMNS}
    FROM sales_articles article
    JOIN sales_article_revisions revision
      ON revision.product_id = article.product_id
     AND revision.revision = article.current_revision
    WHERE article.article_number = $articleNumber
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
  `),
]);

module.exports = {
  SQLITE_SALES_ARTICLE_CATALOG,
};

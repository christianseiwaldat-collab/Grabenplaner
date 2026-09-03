"use strict";

const { definePersistenceStatement } = require("../contract");

const nullable = (kind) => Object.freeze({ kind, nullable: true });

function queryOne(id, parameters, columns) {
  return definePersistenceStatement({
    id: `sales-article-catalog.${id}`,
    operation: "queryOne",
    parameters,
    columns,
  });
}

function queryAll(id, parameters, columns) {
  return definePersistenceStatement({
    id: `sales-article-catalog.${id}`,
    operation: "queryAll",
    parameters,
    columns,
  });
}

function execute(id, parameters) {
  return definePersistenceStatement({
    id: `sales-article-catalog.${id}`,
    operation: "execute",
    parameters,
  });
}

const IMPORT_SNAPSHOT_COLUMNS = Object.freeze({
  id: "text",
  idempotencyKey: "text",
  sourceSystem: "text",
  sourceProfileVersion: "text",
  sourceSchemaSha256: "text",
  sourceFileSha256: "text",
  contentSha256: "text",
  snapshotAt: "utc_timestamp",
  articleCount: "safe_integer",
  identifierCount: "safe_integer",
  priceCount: "safe_integer",
  importedBy: "text",
  importedAt: "utc_timestamp",
});

const ARTICLE_COLUMNS = Object.freeze({
  productId: "text",
  articleNumber: "text",
  sourceSystem: "text",
  sourceArticleKey: "text",
  currentRevision: "safe_integer",
  description: "text",
  active: "boolean",
  sourceSnapshotId: "text",
  sourceUpdatedAt: nullable("utc_timestamp"),
  createdBy: "text",
  createdAt: "utc_timestamp",
  updatedBy: "text",
  updatedAt: "utc_timestamp",
});

const REVISION_COLUMNS = Object.freeze({
  productId: "text",
  revision: "safe_integer",
  articleNumber: "text",
  description: "text",
  active: "boolean",
  sourceSnapshotId: "text",
  sourceUpdatedAt: nullable("utc_timestamp"),
  createdBy: "text",
  createdAt: "utc_timestamp",
});

const IDENTIFIER_COLUMNS = Object.freeze({
  id: "text",
  productId: "text",
  sourceSnapshotId: "text",
  identifierType: "text",
  identifierValue: "text",
  canonicalGtin14: "text",
  isPrimary: "boolean",
  sourceField: "text",
  sourceRank: nullable("safe_integer"),
  equivalentIdentifiers: "json",
  sourceProvider: "text",
  verifiedAt: "utc_timestamp",
  createdBy: "text",
  createdAt: "utc_timestamp",
  updatedBy: "text",
  updatedAt: "utc_timestamp",
});

const PRICE_COLUMNS = Object.freeze({
  id: "text",
  productId: "text",
  sourceSnapshotId: "text",
  priceType: "text",
  amount: nullable("decimal_string"),
  currency: "text",
  priceBasis: "text",
  qualityStatus: "text",
  sourceField: "text",
  createdBy: "text",
  createdAt: "utc_timestamp",
});

const SALES_ARTICLE_CATALOG_STATEMENTS = Object.freeze({
  getImportSnapshotByIdempotencyKey: queryOne(
    "imports.get-by-idempotency-key",
    { idempotencyKey: "text" },
    IMPORT_SNAPSHOT_COLUMNS,
  ),
  insertImportSnapshot: execute("imports.insert", {
    id: "text",
    idempotencyKey: "text",
    sourceSystem: "text",
    sourceProfileVersion: "text",
    sourceSchemaSha256: "text",
    sourceFileSha256: "text",
    contentSha256: "text",
    snapshotAt: "utc_timestamp",
    articleCount: "safe_integer",
    identifierCount: "safe_integer",
    priceCount: "safe_integer",
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  getArticleBySource: queryOne("articles.get-by-source", {
    sourceSystem: "text",
    sourceArticleKey: "text",
  }, ARTICLE_COLUMNS),
  getArticleByNumber: queryOne("articles.get-by-number", {
    articleNumber: "text",
  }, ARTICLE_COLUMNS),
  insertArticle: execute("articles.insert", {
    productId: "text",
    articleNumber: "text",
    sourceSystem: "text",
    sourceArticleKey: "text",
    currentRevision: "safe_integer",
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  insertSourceLink: execute("articles.insert-source-link", {
    productId: "text",
    sourceSystem: "text",
    sourceArticleKey: "text",
    sourceSnapshotId: "text",
    matchMethod: "text",
    matchConfidence: "text",
    matchedSourceSystem: nullable("text"),
    matchedSourceArticleKey: nullable("text"),
    sourceProvider: "text",
    sourceProductNumber: "text",
    sourceUrl: "text",
    sourceFetchedAt: nullable("text"),
    sourceCreatedBy: "text",
    sourceUpdatedBy: "text",
    sourceCreatedAt: nullable("text"),
    sourceUpdatedAt: nullable("text"),
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  insertRevision: execute("revisions.insert", {
    productId: "text",
    revision: "safe_integer",
    articleNumber: "text",
    description: "text",
    active: "boolean",
    sourceSnapshotId: "text",
    sourceUpdatedAt: nullable("utc_timestamp"),
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  advanceRevision: execute("articles.advance-revision", {
    productId: "text",
    articleNumber: "text",
    revision: "safe_integer",
    expectedRevision: "safe_integer",
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  getLatestRevision: queryOne("revisions.get-latest", {
    productId: "text",
  }, { revision: "safe_integer" }),
  findIdentifierOwner: queryOne("identifiers.find-owner", {
    canonicalGtin14: "text",
  }, { productId: "text" }),
  insertIdentifier: execute("identifiers.insert", {
    id: "text",
    productId: "text",
    sourceSnapshotId: "text",
    identifierType: "text",
    identifierValue: "text",
    canonicalGtin14: "text",
    isPrimary: "boolean",
    sourceField: "text",
    sourceRank: nullable("safe_integer"),
    equivalentIdentifiers: "json",
    sourceProvider: "text",
    verifiedAt: "utc_timestamp",
    createdBy: "text",
    createdAt: "utc_timestamp",
    updatedBy: "text",
    updatedAt: "utc_timestamp",
  }),
  insertPriceSnapshot: execute("prices.insert", {
    id: "text",
    productId: "text",
    sourceSnapshotId: "text",
    priceType: "text",
    amount: nullable("decimal_string"),
    currency: "text",
    priceBasis: "text",
    qualityStatus: "text",
    sourceField: "text",
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  listCurrentIdentifiers: queryAll("identifiers.list-current", {
    productId: "text",
    sourceSnapshotId: "text",
  }, IDENTIFIER_COLUMNS),
  listCurrentPrices: queryAll("prices.list-current", {
    productId: "text",
    sourceSnapshotId: "text",
  }, PRICE_COLUMNS),
  listRevisions: queryAll("revisions.list", {
    productId: "text",
  }, REVISION_COLUMNS),
  insertAudit: execute("audit.insert", {
    actor: "text",
    action: "text",
    entityType: "text",
    entityId: "text",
    detail: "json",
    timestamp: "utc_timestamp",
  }),
});

module.exports = {
  SALES_ARTICLE_CATALOG_STATEMENTS,
};

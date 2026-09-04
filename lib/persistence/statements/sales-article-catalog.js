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

function execute(id, parameters, columns = {}) {
  return definePersistenceStatement({
    id: `sales-article-catalog.${id}`,
    operation: "execute",
    parameters,
    columns,
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

const IMPORT_FINDING_COLUMNS = Object.freeze({
  snapshotId: "text",
  ordinal: "safe_integer",
  sourceRow: "safe_integer",
  articleNumber: nullable("text"),
  code: "text",
  detailSha256: "text",
  createdBy: "text",
  createdAt: "utc_timestamp",
});

const IMPORT_RUN_METADATA_COLUMNS = Object.freeze({
  snapshotId: "text",
  totalCount: "safe_integer",
  createCount: "safe_integer",
  updateCount: "safe_integer",
  unchangedCount: "safe_integer",
  quarantinedCount: "safe_integer",
  createdBy: "text",
  createdAt: "utc_timestamp",
});

const IMPORT_IMPACT_COLUMNS = Object.freeze({
  snapshotId: "text",
  ordinal: "safe_integer",
  productId: "text",
  importedRevision: "safe_integer",
  previousCurrentRevision: nullable("safe_integer"),
  createdBy: "text",
  createdAt: "utc_timestamp",
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
  currentSourceSystem: "text",
  sourceUpdatedAt: nullable("utc_timestamp"),
  createdBy: "text",
  createdAt: "utc_timestamp",
  updatedBy: "text",
  updatedAt: "utc_timestamp",
});

const ARTICLE_SEARCH_COLUMNS = Object.freeze({
  productId: "text",
  articleNumber: "text",
  description: "text",
  primaryIdentifier: nullable("text"),
  active: "boolean",
  sourceSystem: "text",
  currentRevision: "safe_integer",
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
  search: queryAll("articles.search", {
    likeQuery: "text",
    identifierLike: "text",
    active: nullable("boolean"),
    sourceSystem: nullable("text"),
    sort: "text",
    direction: "text",
    limit: "safe_integer",
    offset: "safe_integer",
  }, ARTICLE_SEARCH_COLUMNS),
  countSearch: queryOne("articles.search.count", {
    likeQuery: "text",
    identifierLike: "text",
    active: nullable("boolean"),
    sourceSystem: nullable("text"),
  }, { total: "safe_integer" }),
  getImportSnapshotByIdempotencyKey: queryOne(
    "imports.get-by-idempotency-key",
    { idempotencyKey: "text" },
    IMPORT_SNAPSHOT_COLUMNS,
  ),
  getLatestImportAtBySourceSystem: queryOne(
    "imports.latest-at-by-source-system",
    { sourceSystem: "text" },
    { importedAt: "utc_timestamp" },
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
  listImportFindings: queryAll("imports.findings.list", {
    snapshotId: "text",
  }, IMPORT_FINDING_COLUMNS),
  insertImportFinding: execute("imports.findings.insert", {
    snapshotId: "text",
    ordinal: "safe_integer",
    sourceRow: "safe_integer",
    articleNumber: nullable("text"),
    code: "text",
    detailSha256: "text",
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  getImportRunMetadata: queryOne("imports.run-metadata.get", {
    snapshotId: "text",
  }, IMPORT_RUN_METADATA_COLUMNS),
  insertImportRunMetadata: execute("imports.run-metadata.insert", {
    snapshotId: "text",
    totalCount: "safe_integer",
    createCount: "safe_integer",
    updateCount: "safe_integer",
    unchangedCount: "safe_integer",
    quarantinedCount: "safe_integer",
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  listImportImpacts: queryAll("imports.impacts.list", {
    snapshotId: "text",
  }, IMPORT_IMPACT_COLUMNS),
  insertImportImpact: execute("imports.impacts.insert", {
    snapshotId: "text",
    ordinal: "safe_integer",
    productId: "text",
    importedRevision: "safe_integer",
    previousCurrentRevision: nullable("safe_integer"),
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  countImportImpactHeadConflicts: queryOne("imports.impacts.head-conflicts", {
    snapshotId: "text",
  }, {
    totalCount: "safe_integer",
    conflictCount: "safe_integer",
  }),
  getArticleBySource: queryOne("articles.get-by-source", {
    sourceSystem: "text",
    sourceArticleKey: "text",
  }, ARTICLE_COLUMNS),
  getArticleByNumber: queryOne("articles.get-by-number", {
    articleNumber: "text",
  }, ARTICLE_COLUMNS),
  getArticleByProductId: queryOne("articles.get-by-product-id", {
    productId: "text",
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
  getRevision: queryOne("revisions.get", {
    productId: "text",
    revision: "safe_integer",
  }, REVISION_COLUMNS),
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
  }, { id: "safe_integer" }),
});

module.exports = {
  SALES_ARTICLE_CATALOG_STATEMENTS,
};

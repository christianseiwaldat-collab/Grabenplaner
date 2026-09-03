"use strict";

const crypto = require("node:crypto");
const {
  SalesArticleCatalogError,
  normalizeSalesArticleActor,
  normalizeSalesArticleImportSnapshot,
  normalizeSalesArticleNumber,
  normalizeSalesArticleSha256,
  normalizeSalesArticleSourceKey,
  normalizeSalesArticleSourceSystem,
  normalizeSalesArticleTimestamp,
} = require("../../sales-article-catalog");
const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  SALES_ARTICLE_CATALOG_STATEMENTS: S,
} = require("../statements/sales-article-catalog");

function persistenceError(code, operation, cause = null) {
  return new PersistenceError(code, { operation, cause });
}

function invalidInput(operation, cause = null) {
  return persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, operation, cause);
}

function uniqueViolation(operation) {
  return persistenceError(PERSISTENCE_ERROR_CODES.UNIQUE_VIOLATION, operation);
}

function retryable(operation) {
  return persistenceError(PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION, operation);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, operation) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw invalidInput(operation);
  }
}

function normalizedUuid(value, operation) {
  const result = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result)) {
    throw invalidInput(operation);
  }
  return result;
}

function normalize(operation, work) {
  try {
    return work();
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    if (error instanceof SalesArticleCatalogError) throw invalidInput(operation, error);
    throw error;
  }
}

function primitiveOperations(access) {
  return Object.freeze({
    queryOne(statement, parameters) {
      return access.queryOne(statement, parameters);
    },
    queryAll(statement, parameters) {
      return access.queryAll(statement, parameters);
    },
    execute(statement, parameters) {
      return access.execute(statement, parameters);
    },
  });
}

function operationalSourceProvider(sourceSystem) {
  if (sourceSystem === "manual.loan") return "manual";
  if (sourceSystem === "shopware.storefront") return "shopware_storefront";
  return "import";
}

function sourceLinkMetadata(article, sourceSystem, actor, timestamp) {
  const metadata = article.sourceMetadata || {};
  return Object.freeze({
    sourceProvider: metadata.provider || operationalSourceProvider(sourceSystem),
    sourceProductNumber: metadata.productNumber ?? article.sourceArticleKey,
    sourceUrl: metadata.url || "",
    sourceFetchedAt: metadata.fetchedAt ?? article.sourceUpdatedAt,
    sourceCreatedBy: metadata.createdBy || actor,
    sourceUpdatedBy: metadata.updatedBy || metadata.createdBy || actor,
    sourceCreatedAt: metadata.createdAt || timestamp,
    sourceUpdatedAt: metadata.updatedAt || metadata.createdAt || timestamp,
  });
}

async function hydratedArticle(operations, article) {
  if (!article) return null;
  const [identifiers, prices] = await Promise.all([
    operations.queryAll(S.listCurrentIdentifiers, {
      productId: article.productId,
      sourceSnapshotId: article.sourceSnapshotId,
    }),
    operations.queryAll(S.listCurrentPrices, {
      productId: article.productId,
      sourceSnapshotId: article.sourceSnapshotId,
    }),
  ]);
  return Object.freeze({
    ...article,
    identifiers: Object.freeze(identifiers),
    prices: Object.freeze(prices),
  });
}

async function resolveArticle(operations, sourceSystem, article, actor, timestamp, snapshotId) {
  const [bySource, byNumber] = await Promise.all([
    operations.queryOne(S.getArticleBySource, {
      sourceSystem,
      sourceArticleKey: article.sourceArticleKey,
    }),
    operations.queryOne(S.getArticleByNumber, { articleNumber: article.articleNumber }),
  ]);
  if (bySource && byNumber && bySource.productId !== byNumber.productId) {
    throw uniqueViolation("sales-article-catalog-import");
  }
  const existing = bySource || byNumber;

  const productId = existing?.productId || crypto.randomUUID();
  const latestRevision = existing
    ? await operations.queryOne(S.getLatestRevision, { productId })
    : null;
  const revision = existing ? latestRevision.revision + 1 : 1;
  if (!existing) {
    await operations.execute(S.insertArticle, {
      productId,
      articleNumber: article.articleNumber,
      sourceSystem,
      sourceArticleKey: article.sourceArticleKey,
      currentRevision: revision,
      actor,
      timestamp,
    });
  }
  if (!bySource) {
    const matchMethod = existing ? "article_number_exact" : "source_import";
    const matchConfidence = existing ? "exact" : "authoritative";
    const metadata = sourceLinkMetadata(article, sourceSystem, actor, timestamp);
    await operations.execute(S.insertSourceLink, {
      productId,
      sourceSystem,
      sourceArticleKey: article.sourceArticleKey,
      sourceSnapshotId: snapshotId,
      matchMethod,
      matchConfidence,
      matchedSourceSystem: existing?.sourceSystem || null,
      matchedSourceArticleKey: existing?.sourceArticleKey || null,
      ...metadata,
      actor,
      timestamp,
    });
    await operations.execute(S.insertAudit, {
      actor,
      action: "sales.article-catalog.source-link",
      entityType: "sales_article",
      entityId: productId,
      detail: {
        sourceSystem,
        sourceArticleKey: article.sourceArticleKey,
        matchMethod,
        matchConfidence,
        matchedSourceSystem: existing?.sourceSystem || null,
        matchedSourceArticleKey: existing?.sourceArticleKey || null,
        sourceSnapshotId: snapshotId,
      },
      timestamp,
    });
  }
  await operations.execute(S.insertRevision, {
    productId,
    revision,
    articleNumber: article.articleNumber,
    description: article.description,
    active: article.active,
    sourceSnapshotId: snapshotId,
    sourceUpdatedAt: article.sourceUpdatedAt,
    actor,
    timestamp,
  });
  if (existing && article.active) {
    const advanced = await operations.execute(S.advanceRevision, {
      productId,
      articleNumber: article.articleNumber,
      revision,
      expectedRevision: existing.currentRevision,
      actor,
      timestamp,
    });
    if (advanced.rowsAffected !== 1) throw retryable("sales-article-catalog-import");
  }
  return Object.freeze({ productId, revision });
}

async function persistSnapshot(operations, snapshot, actor, timestamp) {
  const existingSnapshot = await operations.queryOne(S.getImportSnapshotByIdempotencyKey, {
    idempotencyKey: snapshot.idempotencyKey,
  });
  if (existingSnapshot) {
    return Object.freeze({ snapshot: existingSnapshot, replayed: true });
  }

  await operations.execute(S.insertImportSnapshot, {
    id: snapshot.id,
    idempotencyKey: snapshot.idempotencyKey,
    sourceSystem: snapshot.sourceSystem,
    sourceProfileVersion: snapshot.sourceProfileVersion,
    sourceSchemaSha256: snapshot.sourceSchemaSha256,
    sourceFileSha256: snapshot.sourceFileSha256,
    contentSha256: snapshot.contentSha256,
    snapshotAt: snapshot.snapshotAt,
    articleCount: snapshot.articleCount,
    identifierCount: snapshot.identifierCount,
    priceCount: snapshot.priceCount,
    actor,
    timestamp,
  });

  for (const article of snapshot.articles) {
    const { productId } = await resolveArticle(
      operations,
      snapshot.sourceSystem,
      article,
      actor,
      timestamp,
      snapshot.id,
    );
    for (const identifier of article.identifiers) {
      const owner = await operations.queryOne(S.findIdentifierOwner, {
        canonicalGtin14: identifier.canonicalGtin14,
      });
      if (owner && owner.productId !== productId) {
        throw uniqueViolation("sales-article-catalog-import-identifier");
      }
      await operations.execute(S.insertIdentifier, {
        id: crypto.randomUUID(),
        productId,
        sourceSnapshotId: snapshot.id,
        identifierType: identifier.identifierType,
        identifierValue: identifier.identifierValue,
        canonicalGtin14: identifier.canonicalGtin14,
        isPrimary: identifier.isPrimary,
        sourceField: identifier.sourceField,
        sourceRank: identifier.sourceRank,
        equivalentIdentifiers: identifier.equivalentIdentifiers || [],
        sourceProvider: identifier.sourceProvider || operationalSourceProvider(
          snapshot.sourceSystem,
        ),
        verifiedAt: identifier.verifiedAt || timestamp,
        createdBy: identifier.createdBy || actor,
        createdAt: identifier.createdAt || timestamp,
        updatedBy: identifier.updatedBy || identifier.createdBy || actor,
        updatedAt: identifier.updatedAt || identifier.createdAt || timestamp,
      });
    }
    for (const price of article.prices) {
      await operations.execute(S.insertPriceSnapshot, {
        id: crypto.randomUUID(),
        productId,
        sourceSnapshotId: snapshot.id,
        priceType: price.priceType,
        amount: price.amount,
        currency: price.currency,
        priceBasis: price.priceBasis,
        qualityStatus: price.qualityStatus,
        sourceField: price.sourceField,
        actor,
        timestamp,
      });
    }
  }

  await operations.execute(S.insertAudit, {
    actor,
    action: "sales.article-catalog.import",
    entityType: "sales_article_import_snapshot",
    entityId: snapshot.id,
    detail: {
      sourceSystem: snapshot.sourceSystem,
      sourceProfileVersion: snapshot.sourceProfileVersion,
      sourceSchemaSha256: snapshot.sourceSchemaSha256,
      sourceFileSha256: snapshot.sourceFileSha256,
      contentSha256: snapshot.contentSha256,
      snapshotAt: snapshot.snapshotAt,
      articleCount: snapshot.articleCount,
      identifierCount: snapshot.identifierCount,
      priceCount: snapshot.priceCount,
    },
    timestamp,
  });
  const stored = await operations.queryOne(S.getImportSnapshotByIdempotencyKey, {
    idempotencyKey: snapshot.idempotencyKey,
  });
  return Object.freeze({ snapshot: stored, replayed: false });
}

const createSalesArticleCatalogRepository = Object.freeze(function createSalesArticleCatalogRepository(
  access,
) {
  assertPersistenceAccess(access);
  const direct = primitiveOperations(access);
  return Object.freeze({
    async importSnapshot(value) {
      const operation = "sales-article-catalog-import";
      exactKeys(value, ["snapshot", "actor", "timestamp"], operation);
      const { snapshot, actor, timestamp } = normalize(operation, () => ({
        snapshot: normalizeSalesArticleImportSnapshot(value.snapshot),
        actor: normalizeSalesArticleActor(value.actor),
        timestamp: normalizeSalesArticleTimestamp(value.timestamp),
      }));
      return typeof access.transaction === "function"
        ? access.transaction(
          (executor) => persistSnapshot(primitiveOperations(executor), snapshot, actor, timestamp),
          { isolation: "serializable" },
        )
        : persistSnapshot(direct, snapshot, actor, timestamp);
    },

    async getByArticleNumber(value) {
      const articleNumber = normalize("sales-article-catalog-get-by-number", () => (
        normalizeSalesArticleNumber(value)
      ));
      return hydratedArticle(
        direct,
        await direct.queryOne(S.getArticleByNumber, { articleNumber }),
      );
    },

    async getBySource(value) {
      const operation = "sales-article-catalog-get-by-source";
      exactKeys(value, ["sourceSystem", "sourceArticleKey"], operation);
      const parameters = normalize(operation, () => ({
        sourceSystem: normalizeSalesArticleSourceSystem(value.sourceSystem),
        sourceArticleKey: normalizeSalesArticleSourceKey(value.sourceArticleKey),
      }));
      return hydratedArticle(direct, await direct.queryOne(S.getArticleBySource, parameters));
    },

    listRevisions(productId) {
      return direct.queryAll(S.listRevisions, {
        productId: normalizedUuid(productId, "sales-article-catalog-list-revisions"),
      });
    },

    getImportSnapshot(idempotencyKey) {
      const normalized = normalize("sales-article-catalog-get-import", () => (
        normalizeSalesArticleSha256(idempotencyKey, "Der Idempotenzschlüssel")
      ));
      return direct.queryOne(S.getImportSnapshotByIdempotencyKey, { idempotencyKey: normalized });
    },
  });
});

module.exports = {
  createSalesArticleCatalogRepository,
};

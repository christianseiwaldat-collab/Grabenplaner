"use strict";
const { parameters: searchParameters } = require("../../flexible-search");

const crypto = require("node:crypto");
const {
  SalesArticleCatalogError,
  normalizeSalesArticleActor,
  normalizeSalesArticleImportSnapshot,
  normalizeSalesArticleManualArchive,
  normalizeSalesArticleManualCopy,
  normalizeSalesArticleManualCreate,
  normalizeSalesArticleManualUpdate,
  normalizeSalesArticleExpectedRevision,
  normalizeSalesArticleNumber,
  normalizeSalesArticleSearch,
  normalizeSalesArticleSha256,
  normalizeSalesArticleSourceKey,
  normalizeSalesArticleSourceSystem,
  normalizeSalesArticleTimestamp,
} = require("../../sales-article-catalog");
const {
  salesArticlePriceGroup,
} = require("../../sales-article-catalog-access");
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

function auditIdFromResult(result, operation) {
  const id = Number(result?.returnedRows?.[0]?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw persistenceError(
    PERSISTENCE_ERROR_CODES.RESULT_INVALID,
    operation,
  );
  return id;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const MANUAL_SOURCE_SYSTEM = "manual.article-catalog";
const MANUAL_SOURCE_PROFILE_VERSION = "manual.v1";
const MANUAL_SCHEMA_SHA256 = sha256("grabenplaner-sales-article-manual-schema-v1");
const IMPORT_UNDO_SOURCE_SYSTEM = "tradefoto.article.import.undo";
const IMPORT_UNDO_SOURCE_PROFILE_VERSION = "import-undo.v1";
const IMPORT_UNDO_SCHEMA_SHA256 = sha256("grabenplaner-sales-article-import-undo-schema-v1");

function normalize(operation, work) {
  try {
    return work();
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    if (error instanceof SalesArticleCatalogError) throw invalidInput(operation, error);
    throw error;
  }
}

function normalizeImportFindings(value, operation) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 100000) throw invalidInput(operation);
  return Object.freeze(value.map((entry) => {
    exactKeys(
      entry,
      ["rowNumber", "articleNumber", "code", "detailSha256"],
      operation,
    );
    if (!Number.isSafeInteger(entry.rowNumber) || entry.rowNumber < 1 || entry.rowNumber > 25000
      || typeof entry.code !== "string" || !/^[a-z0-9_]{1,80}$/.test(entry.code)
      || typeof entry.detailSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.detailSha256)) {
      throw invalidInput(operation);
    }
    return Object.freeze({
      rowNumber: entry.rowNumber,
      articleNumber: entry.articleNumber === null
        ? null
        : normalize(operation, () => normalizeSalesArticleNumber(entry.articleNumber)),
      code: entry.code,
      detailSha256: entry.detailSha256,
    });
  }));
}

function normalizeImportRunSummary(value, snapshot, operation) {
  if (value === undefined) return null;
  exactKeys(
    value,
    ["total", "safe", "create", "update", "unchanged", "quarantined"],
    operation,
  );
  if (Object.values(value).some((count) => !Number.isSafeInteger(count) || count < 0)
    || value.safe !== value.create + value.update
    || value.total !== value.safe + value.unchanged + value.quarantined
    || value.safe !== snapshot.articleCount) {
    throw invalidInput(operation);
  }
  return Object.freeze({ ...value });
}

function storedSnapshotMatches(stored, snapshot) {
  return Boolean(stored
    && stored.id === snapshot.id
    && stored.idempotencyKey === snapshot.idempotencyKey
    && stored.sourceSystem === snapshot.sourceSystem
    && stored.sourceProfileVersion === snapshot.sourceProfileVersion
    && stored.sourceSchemaSha256 === snapshot.sourceSchemaSha256
    && stored.sourceFileSha256 === snapshot.sourceFileSha256
    && stored.contentSha256 === snapshot.contentSha256
    && stored.snapshotAt === snapshot.snapshotAt
    && stored.articleCount === snapshot.articleCount
    && stored.identifierCount === snapshot.identifierCount
    && stored.priceCount === snapshot.priceCount);
}

function storedFindingsMatch(stored, findings) {
  return stored.length === findings.length && stored.every((entry, index) => (
    entry.ordinal === index + 1
      && entry.sourceRow === findings[index].rowNumber
      && entry.articleNumber === findings[index].articleNumber
      && entry.code === findings[index].code
      && entry.detailSha256 === findings[index].detailSha256
  ));
}

function storedRunMetadataMatches(stored, runSummary) {
  if (!stored || !runSummary) return !stored && !runSummary;
  return stored.totalCount === runSummary.total
    && stored.createCount === runSummary.create
    && stored.updateCount === runSummary.update
    && stored.unchangedCount === runSummary.unchanged
    && stored.quarantinedCount === runSummary.quarantined;
}

function importImpactFingerprint(impacts) {
  return sha256(JSON.stringify(impacts.map((impact) => ({
    snapshotId: impact.snapshotId,
    ordinal: impact.ordinal,
    productId: impact.productId,
    importedRevision: impact.importedRevision,
    previousCurrentRevision: impact.previousCurrentRevision,
  }))));
}

function importStateArticle(head) {
  if (!head) return null;
  return Object.freeze({
    productId: head.productId,
    articleNumber: head.articleNumber,
    currentRevision: head.currentRevision,
    active: head.active,
    currentSourceSystem: head.currentSourceSystem,
  });
}

function canonicalImportIdentifiers(identifiers) {
  return (identifiers || []).flatMap((identifier) => (
    Array.isArray(identifier.equivalentIdentifiers) && identifier.equivalentIdentifiers.length
      ? identifier.equivalentIdentifiers
      : [identifier]
  )).map((identifier) => ({
    canonicalGtin14: identifier.canonicalGtin14,
    identifierValue: identifier.identifierValue,
    isPrimary: identifier.isPrimary === true,
    sourceField: identifier.sourceField,
    sourceRank: identifier.sourceRank ?? null,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function canonicalImportPrices(prices) {
  return (prices || []).map((price) => ({
    priceType: price.priceType,
    amount: price.amount,
    currency: price.currency,
    priceBasis: price.priceBasis,
    qualityStatus: price.qualityStatus,
    sourceField: price.sourceField,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function importArticleMatchesHead(article, head, sourceSystem, hasSourceLink) {
  return Boolean(head
    && hasSourceLink
    && head.currentSourceSystem === sourceSystem
    && head.articleNumber === article.articleNumber
    && head.description === article.description
    && head.active === article.active
    && JSON.stringify(canonicalImportIdentifiers(head.identifiers))
      === JSON.stringify(canonicalImportIdentifiers(article.identifiers))
    && JSON.stringify(canonicalImportPrices(head.prices))
      === JSON.stringify(canonicalImportPrices(article.prices)));
}

async function inspectSnapshotState(operations, snapshot) {
  const rows = [];
  const stateRecords = [];
  for (const article of snapshot.articles) {
    const [bySource, byNumber] = await Promise.all([
      operations.queryOne(S.getArticleBySource, {
        sourceSystem: snapshot.sourceSystem,
        sourceArticleKey: article.sourceArticleKey,
      }),
      operations.queryOne(S.getArticleByNumber, { articleNumber: article.articleNumber }),
    ]);
    const issueCodes = [];
    if (bySource && byNumber && bySource.productId !== byNumber.productId) {
      issueCodes.push("number_source_conflict");
    }
    const existingHead = bySource || byNumber;
    const existing = existingHead
      ? await hydratedArticle(operations, existingHead)
      : null;
    if (bySource && bySource.articleNumber !== article.articleNumber) {
      issueCodes.push("number_source_conflict");
    }
    if (existing?.currentSourceSystem === MANUAL_SOURCE_SYSTEM) {
      issueCodes.push("manual_head");
    }
    if (existing && !existing.active) issueCodes.push("archived_head");
    if (!article.active) issueCodes.push("inactive_import");
    const identifierOwners = [];
    for (const identifier of article.identifiers) {
      const owner = await operations.queryOne(S.findIdentifierOwner, {
        canonicalGtin14: identifier.canonicalGtin14,
      });
      identifierOwners.push(Object.freeze({
        canonicalGtin14: identifier.canonicalGtin14,
        productId: owner?.productId || null,
      }));
      if (owner && (!existing || owner.productId !== existing.productId)) {
        issueCodes.push("gtin_conflict");
      }
    }
    const uniqueIssues = Object.freeze([...new Set(issueCodes)]);
    rows.push(Object.freeze({
      articleNumber: article.articleNumber,
      action: uniqueIssues.length
        ? "blocked"
        : importArticleMatchesHead(article, existing, snapshot.sourceSystem, Boolean(bySource))
          ? "unchanged"
          : existing ? "update" : "create",
      issueCodes: uniqueIssues,
    }));
    stateRecords.push(Object.freeze({
      sourceArticleKey: article.sourceArticleKey,
      articleNumber: article.articleNumber,
      bySource: importStateArticle(bySource),
      byNumber: importStateArticle(byNumber),
      identifierOwners,
    }));
  }
  stateRecords.sort((left, right) => (
    `${left.sourceArticleKey}\0${left.articleNumber}`
      .localeCompare(`${right.sourceArticleKey}\0${right.articleNumber}`)
  ));
  return Object.freeze({
    stateSha256: sha256(JSON.stringify(stateRecords)),
    rows: Object.freeze(rows),
  });
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
  // An import may record that an upstream source considers an archived product
  // active again, but it must never override the locally governed archive head.
  // Such a revision remains staged until an explicit governance/undo action
  // creates the next managed revision.
  if (existing && existing.active && article.active) {
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
  return Object.freeze({
    productId,
    revision,
    previousCurrentRevision: existing?.currentRevision || null,
  });
}

async function persistSnapshot(
  operations,
  snapshot,
  actor,
  timestamp,
  findings = [],
  runSummary = null,
) {
  const existingSnapshot = await operations.queryOne(S.getImportSnapshotByIdempotencyKey, {
    idempotencyKey: snapshot.idempotencyKey,
  });
  if (existingSnapshot) {
    const [storedFindings, storedRunMetadata, impacts] = await Promise.all([
      operations.queryAll(S.listImportFindings, { snapshotId: existingSnapshot.id }),
      operations.queryOne(S.getImportRunMetadata, { snapshotId: existingSnapshot.id }),
      operations.queryAll(S.listImportImpacts, { snapshotId: existingSnapshot.id }),
    ]);
    if (!storedSnapshotMatches(existingSnapshot, snapshot)
      || !storedFindingsMatch(storedFindings, findings)
      || !storedRunMetadataMatches(storedRunMetadata, runSummary)
      || impacts.length !== snapshot.articleCount) {
      throw invalidInput("sales-article-catalog-import-replay-mismatch");
    }
    return Object.freeze({
      snapshot: existingSnapshot,
      replayed: true,
      auditId: null,
      impactSha256: importImpactFingerprint(impacts),
    });
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

  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    await operations.execute(S.insertImportFinding, {
      snapshotId: snapshot.id,
      ordinal: index + 1,
      sourceRow: finding.rowNumber,
      articleNumber: finding.articleNumber,
      code: finding.code,
      detailSha256: finding.detailSha256,
      actor,
      timestamp,
    });
  }

  if (runSummary) {
    await operations.execute(S.insertImportRunMetadata, {
      snapshotId: snapshot.id,
      totalCount: runSummary.total,
      createCount: runSummary.create,
      updateCount: runSummary.update,
      unchangedCount: runSummary.unchanged,
      quarantinedCount: runSummary.quarantined,
      actor,
      timestamp,
    });
  }

  const impacts = [];
  for (let index = 0; index < snapshot.articles.length; index += 1) {
    const article = snapshot.articles[index];
    const { productId, revision, previousCurrentRevision } = await resolveArticle(
      operations,
      snapshot.sourceSystem,
      article,
      actor,
      timestamp,
      snapshot.id,
    );
    const impact = Object.freeze({
      snapshotId: snapshot.id,
      ordinal: index + 1,
      productId,
      importedRevision: revision,
      previousCurrentRevision,
    });
    await operations.execute(S.insertImportImpact, {
      ...impact,
      actor,
      timestamp,
    });
    impacts.push(impact);
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

  const auditResult = await operations.execute(S.insertAudit, {
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
      ...(findings.length ? {
        findingCount: findings.length,
        findingCodes: [...new Set(findings.map(({ code }) => code))].sort(),
      } : {}),
      ...(runSummary ? { runSummary } : {}),
    },
    timestamp,
  });
  const stored = await operations.queryOne(S.getImportSnapshotByIdempotencyKey, {
    idempotencyKey: snapshot.idempotencyKey,
  });
  return Object.freeze({
    snapshot: stored,
    replayed: false,
    auditId: auditIdFromResult(auditResult, "sales-article-catalog-import-audit"),
    impactSha256: importImpactFingerprint(impacts),
  });
}

async function inspectImportUndoState(operations, snapshotId) {
  const [impacts, headStatus] = await Promise.all([
    operations.queryAll(S.listImportImpacts, { snapshotId }),
    operations.queryOne(S.countImportImpactHeadConflicts, { snapshotId }),
  ]);
  if (!impacts.length) {
    return Object.freeze({
      outcome: "not_found",
      snapshotId,
      articleCount: 0,
      impactSha256: null,
      canUndo: false,
    });
  }
  const canUndo = headStatus?.totalCount === impacts.length
    && headStatus?.conflictCount === 0;
  return Object.freeze({
    outcome: "found",
    snapshotId,
    articleCount: impacts.length,
    impactSha256: importImpactFingerprint(impacts),
    canUndo,
  });
}

function importUndoContentFingerprint(restorations) {
  return sha256(JSON.stringify(restorations.map(({ impact, target, active }) => ({
    productId: impact.productId,
    importedRevision: impact.importedRevision,
    previousCurrentRevision: impact.previousCurrentRevision,
    articleNumber: target.articleNumber,
    description: target.description,
    active,
    sourceUpdatedAt: target.sourceUpdatedAt,
    identifiers: target.identifiers.map((identifier) => ({
      identifierType: identifier.identifierType,
      identifierValue: identifier.identifierValue,
      canonicalGtin14: identifier.canonicalGtin14,
      isPrimary: identifier.isPrimary,
      sourceField: identifier.sourceField,
      sourceRank: identifier.sourceRank,
      equivalentIdentifiers: [...(identifier.equivalentIdentifiers || [])].sort(),
      sourceProvider: identifier.sourceProvider,
      verifiedAt: identifier.verifiedAt,
      createdBy: identifier.createdBy,
      createdAt: identifier.createdAt,
      updatedBy: identifier.updatedBy,
      updatedAt: identifier.updatedAt,
    })).sort((left, right) => {
      const leftJson = JSON.stringify(left);
      const rightJson = JSON.stringify(right);
      return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
    }),
    prices: target.prices.map((price) => ({
      priceType: price.priceType,
      amount: price.amount,
      currency: price.currency,
      priceBasis: price.priceBasis,
      qualityStatus: price.qualityStatus,
      sourceField: price.sourceField,
      createdBy: price.createdBy,
      createdAt: price.createdAt,
    })).sort((left, right) => {
      const leftJson = JSON.stringify(left);
      const rightJson = JSON.stringify(right);
      return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
    }),
  }))));
}

async function persistImportUndo(
  operations,
  { snapshotId, expectedImpactSha256, actor, timestamp, undoId },
) {
  const impacts = await operations.queryAll(S.listImportImpacts, { snapshotId });
  if (!impacts.length) return Object.freeze({ outcome: "not_found" });
  const impactSha256 = importImpactFingerprint(impacts);
  if (impactSha256 !== expectedImpactSha256) {
    return Object.freeze({ outcome: "conflict", impactSha256 });
  }

  const restorations = [];
  for (const impact of impacts) {
    const current = await hydratedArticle(
      operations,
      await operations.queryOne(S.getArticleByProductId, { productId: impact.productId }),
    );
    if (!current
      || current.currentRevision !== impact.importedRevision
      || current.sourceSnapshotId !== snapshotId) {
      return Object.freeze({ outcome: "conflict", impactSha256 });
    }
    const target = impact.previousCurrentRevision === null
      ? current
      : await hydratedRevision(operations, impact.productId, impact.previousCurrentRevision);
    if (!target) return Object.freeze({ outcome: "conflict", impactSha256 });
    restorations.push(Object.freeze({
      impact,
      target,
      active: impact.previousCurrentRevision === null ? false : target.active,
    }));
  }

  const idempotencyKey = sha256(`sales-article-import-undo-v1\0${undoId}`);
  const undoSnapshotId = sha256(`sales-article-import-undo-snapshot-v1\0${idempotencyKey}`);
  const identifierCount = restorations.reduce(
    (sum, restoration) => sum + restoration.target.identifiers.length,
    0,
  );
  const priceCount = restorations.reduce(
    (sum, restoration) => sum + restoration.target.prices.length,
    0,
  );
  await operations.execute(S.insertImportSnapshot, {
    id: undoSnapshotId,
    idempotencyKey,
    sourceSystem: IMPORT_UNDO_SOURCE_SYSTEM,
    sourceProfileVersion: IMPORT_UNDO_SOURCE_PROFILE_VERSION,
    sourceSchemaSha256: IMPORT_UNDO_SCHEMA_SHA256,
    sourceFileSha256: sha256(`sales-article-import-undo-event-v1\0${snapshotId}\0${undoId}`),
    contentSha256: importUndoContentFingerprint(restorations),
    snapshotAt: timestamp,
    articleCount: restorations.length,
    identifierCount,
    priceCount,
    actor,
    timestamp,
  });

  for (const { impact, target, active } of restorations) {
    const revision = await managedRevisionNumber(operations, impact.productId);
    await operations.execute(S.insertRevision, {
      productId: impact.productId,
      revision,
      articleNumber: target.articleNumber,
      description: target.description,
      active,
      sourceSnapshotId: undoSnapshotId,
      sourceUpdatedAt: target.sourceUpdatedAt,
      actor,
      timestamp,
    });
    await insertManualRevisionValues(operations, {
      productId: impact.productId,
      snapshotId: undoSnapshotId,
      identifiers: target.identifiers,
      prices: target.prices,
      actor,
      timestamp,
    });
    const advanced = await operations.execute(S.advanceRevision, {
      productId: impact.productId,
      articleNumber: target.articleNumber,
      revision,
      expectedRevision: impact.importedRevision,
      actor,
      timestamp,
    });
    if (advanced.rowsAffected !== 1) {
      throw retryable("sales-article-catalog-import-undo-advance");
    }
  }

  const auditResult = await operations.execute(S.insertAudit, {
    actor,
    action: "sales.article-catalog.import.undo",
    entityType: "sales_article_import_snapshot",
    entityId: snapshotId,
    detail: {
      snapshotId,
      undoSnapshotId,
      impactSha256,
      articleCount: restorations.length,
      archivedNewArticleCount: restorations.filter(
        ({ impact }) => impact.previousCurrentRevision === null,
      ).length,
      restoredArticleCount: restorations.filter(
        ({ impact }) => impact.previousCurrentRevision !== null,
      ).length,
    },
    timestamp,
  });
  return Object.freeze({
    outcome: "updated",
    snapshotId,
    undoSnapshotId,
    articleCount: restorations.length,
    impactSha256,
    auditId: auditIdFromResult(auditResult, "sales-article-catalog-import-undo-audit"),
  });
}

function manualMutationEnvelope(value, allowedKeys, operation) {
  exactKeys(value, allowedKeys, operation);
  return normalize(operation, () => ({
    actor: normalizeSalesArticleActor(value.actor),
    timestamp: normalizeSalesArticleTimestamp(value.timestamp),
    mutationId: normalizedUuid(value.mutationId, operation),
  }));
}

function manualPricePayloadGroup(priceType) {
  const accessGroup = salesArticlePriceGroup(priceType);
  return accessGroup === "prices" ? "sales" : accessGroup;
}

function manualPricesFromGroups(groups) {
  if (!groups) return [];
  const prices = [];
  for (const group of ["sales", "costs"]) {
    for (const price of groups[group] || []) {
      if (manualPricePayloadGroup(price.priceType) !== group) {
        throw invalidInput("sales-article-catalog-manual-price-group");
      }
      prices.push(price);
    }
  }
  return prices;
}

function mergedManualPrices(currentPrices, groupPatch) {
  if (!groupPatch) return [...currentPrices];
  const replacedGroups = new Set(Object.keys(groupPatch));
  return [
    ...currentPrices.filter((price) => (
      !replacedGroups.has(manualPricePayloadGroup(price.priceType))
      || !["confirmed", "inferred"].includes(price.qualityStatus)
    )),
    ...manualPricesFromGroups(groupPatch),
  ];
}

async function hydratedRevision(operations, productId, revision) {
  const row = await operations.queryOne(S.getRevision, { productId, revision });
  if (!row) return null;
  const [identifiers, prices] = await Promise.all([
    operations.queryAll(S.listCurrentIdentifiers, {
      productId,
      sourceSnapshotId: row.sourceSnapshotId,
    }),
    operations.queryAll(S.listCurrentPrices, {
      productId,
      sourceSnapshotId: row.sourceSnapshotId,
    }),
  ]);
  return Object.freeze({
    ...row,
    identifiers: Object.freeze(identifiers),
    prices: Object.freeze(prices),
  });
}

function manualSnapshotFingerprint(value) {
  return sha256(JSON.stringify({
    productId: value.productId,
    revision: value.revision,
    articleNumber: value.articleNumber,
    description: value.description,
    active: value.active,
    identifiers: value.identifiers.map((identifier) => ({
      identifierType: identifier.identifierType,
      identifierValue: identifier.identifierValue,
      canonicalGtin14: identifier.canonicalGtin14,
      isPrimary: identifier.isPrimary,
    })),
    prices: value.prices.map((price) => ({
      priceType: price.priceType,
      amount: price.amount,
      currency: price.currency,
      priceBasis: price.priceBasis,
      qualityStatus: price.qualityStatus,
    })),
  }));
}

async function insertManualSnapshot(operations, value) {
  const contentSha256 = manualSnapshotFingerprint(value);
  const idempotencyKey = sha256(`sales-article-manual-action-v1\0${value.mutationId}`);
  const snapshotId = sha256(`sales-article-manual-snapshot-v1\0${idempotencyKey}`);
  await operations.execute(S.insertImportSnapshot, {
    id: snapshotId,
    idempotencyKey,
    sourceSystem: MANUAL_SOURCE_SYSTEM,
    sourceProfileVersion: MANUAL_SOURCE_PROFILE_VERSION,
    sourceSchemaSha256: MANUAL_SCHEMA_SHA256,
    sourceFileSha256: sha256(`sales-article-manual-event-v1\0${value.mutationId}`),
    contentSha256,
    snapshotAt: value.timestamp,
    articleCount: 1,
    identifierCount: value.identifiers.length,
    priceCount: value.prices.length,
    actor: value.actor,
    timestamp: value.timestamp,
  });
  return snapshotId;
}

async function insertManualRevisionValues(operations, value) {
  for (const identifier of value.identifiers) {
    const owner = await operations.queryOne(S.findIdentifierOwner, {
      canonicalGtin14: identifier.canonicalGtin14,
    });
    if (owner && owner.productId !== value.productId) {
      throw uniqueViolation("sales-article-catalog-manual-identifier");
    }
    await operations.execute(S.insertIdentifier, {
      id: crypto.randomUUID(),
      productId: value.productId,
      sourceSnapshotId: value.snapshotId,
      identifierType: identifier.identifierType,
      identifierValue: identifier.identifierValue,
      canonicalGtin14: identifier.canonicalGtin14,
      isPrimary: identifier.isPrimary,
      sourceField: identifier.sourceField || "manual.ean_gtin",
      sourceRank: identifier.sourceRank,
      equivalentIdentifiers: identifier.equivalentIdentifiers || [],
      sourceProvider: identifier.sourceProvider || "manual",
      verifiedAt: identifier.verifiedAt || value.timestamp,
      createdBy: identifier.createdBy || value.actor,
      createdAt: identifier.createdAt || value.timestamp,
      updatedBy: value.actor,
      updatedAt: value.timestamp,
    });
  }
  for (const price of value.prices) {
    await operations.execute(S.insertPriceSnapshot, {
      id: crypto.randomUUID(),
      productId: value.productId,
      sourceSnapshotId: value.snapshotId,
      priceType: price.priceType,
      amount: price.amount,
      currency: price.currency,
      priceBasis: price.priceBasis,
      qualityStatus: price.qualityStatus,
      sourceField: price.sourceField || `manual.${price.priceType}`,
      actor: price.createdBy || value.actor,
      timestamp: price.createdAt || value.timestamp,
    });
  }
}

async function ensureManualSourceLink(operations, value) {
  const existing = await operations.queryOne(S.getArticleBySource, {
    sourceSystem: MANUAL_SOURCE_SYSTEM,
    sourceArticleKey: value.productId,
  });
  if (existing) return;
  await operations.execute(S.insertSourceLink, {
    productId: value.productId,
    sourceSystem: MANUAL_SOURCE_SYSTEM,
    sourceArticleKey: value.productId,
    sourceSnapshotId: value.snapshotId,
    matchMethod: value.matchedSourceSystem ? "manual_review" : "source_import",
    matchConfidence: value.matchedSourceSystem ? "reviewed" : "authoritative",
    matchedSourceSystem: value.matchedSourceSystem || null,
    matchedSourceArticleKey: value.matchedSourceArticleKey || null,
    sourceProvider: "manual",
    sourceProductNumber: value.articleNumber,
    sourceUrl: "",
    sourceFetchedAt: value.timestamp,
    sourceCreatedBy: value.actor,
    sourceUpdatedBy: value.actor,
    sourceCreatedAt: value.timestamp,
    sourceUpdatedAt: value.timestamp,
    actor: value.actor,
    timestamp: value.timestamp,
  });
}

async function insertManualAudit(operations, value) {
  const result = await operations.execute(S.insertAudit, {
    actor: value.actor,
    action: value.action,
    entityType: "sales_article",
    entityId: value.productId,
    detail: value.detail,
    timestamp: value.timestamp,
  });
  return auditIdFromResult(result, "sales-article-catalog-manual-audit");
}

async function persistNewManualArticle(operations, value) {
  const productId = crypto.randomUUID();
  const revision = 1;
  const identifiers = value.article.identifiers || [];
  const prices = manualPricesFromGroups(value.article.prices);
  const snapshotId = await insertManualSnapshot(operations, {
    ...value,
    productId,
    revision,
    articleNumber: value.article.articleNumber,
    description: value.article.description,
    active: true,
    identifiers,
    prices,
  });
  await operations.execute(S.insertArticle, {
    productId,
    articleNumber: value.article.articleNumber,
    sourceSystem: MANUAL_SOURCE_SYSTEM,
    sourceArticleKey: productId,
    currentRevision: revision,
    actor: value.actor,
    timestamp: value.timestamp,
  });
  await operations.execute(S.insertRevision, {
    productId,
    revision,
    articleNumber: value.article.articleNumber,
    description: value.article.description,
    active: true,
    sourceSnapshotId: snapshotId,
    sourceUpdatedAt: value.timestamp,
    actor: value.actor,
    timestamp: value.timestamp,
  });
  await ensureManualSourceLink(operations, {
    ...value,
    productId,
    snapshotId,
    articleNumber: value.article.articleNumber,
    matchedSourceSystem: value.copiedFrom?.sourceSystem || null,
    matchedSourceArticleKey: value.copiedFrom?.sourceArticleKey || null,
  });
  await insertManualRevisionValues(operations, {
    ...value,
    productId,
    snapshotId,
    identifiers,
    prices,
  });
  const action = value.copiedFrom
    ? "sales.article-catalog.copy"
    : "sales.article-catalog.create";
  const auditId = await insertManualAudit(operations, {
    ...value,
    action,
    productId,
    detail: {
      articleNumber: value.article.articleNumber,
      revision,
      copiedFromProductId: value.copiedFrom?.productId || null,
      copiedFromRevision: value.copiedFrom?.currentRevision || null,
      identifierCount: identifiers.length,
      priceCount: prices.length,
    },
  });
  return Object.freeze({
    outcome: "created",
    article: await hydratedArticle(
      operations,
      await operations.queryOne(S.getArticleByProductId, { productId }),
    ),
    previousRevision: null,
    revision,
    auditId,
  });
}

async function managedRevisionNumber(operations, productId) {
  const latest = await operations.queryOne(S.getLatestRevision, { productId });
  if (!Number.isSafeInteger(latest?.revision) || latest.revision < 1) {
    throw persistenceError(
      PERSISTENCE_ERROR_CODES.RESULT_INVALID,
      "sales-article-catalog-manual-latest-revision",
    );
  }
  return latest.revision + 1;
}

async function persistManagedRevision(operations, value) {
  const current = await hydratedArticle(
    operations,
    await operations.queryOne(S.getArticleByProductId, { productId: value.productId }),
  );
  if (!current) return Object.freeze({ outcome: "not_found" });
  if (current.currentRevision !== value.expectedRevision) {
    return Object.freeze({
      outcome: "conflict",
      currentRevision: current.currentRevision,
      articleNumber: current.articleNumber,
    });
  }
  const revision = await managedRevisionNumber(operations, value.productId);
  const snapshotId = await insertManualSnapshot(operations, {
    ...value,
    revision,
  });
  await operations.execute(S.insertRevision, {
    productId: value.productId,
    revision,
    articleNumber: value.articleNumber,
    description: value.description,
    active: value.active,
    sourceSnapshotId: snapshotId,
    sourceUpdatedAt: value.timestamp,
    actor: value.actor,
    timestamp: value.timestamp,
  });
  await ensureManualSourceLink(operations, {
    ...value,
    snapshotId,
    matchedSourceSystem: current.sourceSystem,
    matchedSourceArticleKey: current.sourceArticleKey,
  });
  await insertManualRevisionValues(operations, {
    ...value,
    snapshotId,
  });
  const advanced = await operations.execute(S.advanceRevision, {
    productId: value.productId,
    articleNumber: value.articleNumber,
    revision,
    expectedRevision: value.expectedRevision,
    actor: value.actor,
    timestamp: value.timestamp,
  });
  if (advanced.rowsAffected !== 1) throw retryable("sales-article-catalog-manual-advance");
  const auditId = await insertManualAudit(operations, {
    ...value,
    action: value.action,
    detail: {
      revisionBefore: value.expectedRevision,
      revisionAfter: revision,
      articleNumberBefore: current.articleNumber,
      articleNumberAfter: value.articleNumber,
      activeBefore: current.active,
      activeAfter: value.active,
      restoredRevision: value.restoredRevision ?? null,
      identifierCount: value.identifiers.length,
      priceCount: value.prices.length,
    },
  });
  return Object.freeze({
    outcome: "updated",
    article: await hydratedArticle(
      operations,
      await operations.queryOne(S.getArticleByProductId, { productId: value.productId }),
    ),
    previousRevision: value.expectedRevision,
    revision,
    auditId,
  });
}

const createSalesArticleCatalogRepository = Object.freeze(function createSalesArticleCatalogRepository(
  access,
) {
  assertPersistenceAccess(access);
  const direct = primitiveOperations(access);
  const transact = (work) => (typeof access.transaction === "function"
    ? access.transaction(
      (executor) => work(primitiveOperations(executor)),
      { isolation: "serializable" },
    )
    : work(direct));
  return Object.freeze({
    async search(value = {}) {
      const operation = "sales-article-catalog-search";
      const input = normalize(operation, () => normalizeSalesArticleSearch(value));
      const parameters = {
        ...searchParameters(input.query),
        identifierLike: input.identifierLike,
        active: input.active,
        sourceSystem: input.sourceSystem,
      };
      const [items, count] = await Promise.all([
        direct.queryAll(S.search, {
          ...parameters,
          sort: input.sort,
          direction: input.direction,
          limit: input.limit,
          offset: input.offset,
        }),
        direct.queryOne(S.countSearch, parameters),
      ]);
      return Object.freeze({
        items: Object.freeze(items),
        total: count?.total || 0,
        limit: input.limit,
        offset: input.offset,
        sort: input.sort,
        direction: input.direction,
      });
    },

    async inspectImportSnapshot(value) {
      const operation = "sales-article-catalog-import-inspect";
      exactKeys(value, ["snapshot"], operation);
      const snapshot = normalize(operation, () => normalizeSalesArticleImportSnapshot(value.snapshot));
      return inspectSnapshotState(direct, snapshot);
    },

    async importSnapshot(value) {
      const operation = "sales-article-catalog-import";
      exactKeys(
        value,
        [
          "snapshot", "actor", "timestamp", "expectedStateSha256", "findings",
          "runSummary",
        ],
        operation,
      );
      const { snapshot, actor, timestamp, expectedStateSha256 } = normalize(operation, () => ({
        snapshot: normalizeSalesArticleImportSnapshot(value.snapshot),
        actor: normalizeSalesArticleActor(value.actor),
        timestamp: normalizeSalesArticleTimestamp(value.timestamp),
        expectedStateSha256: value.expectedStateSha256 === undefined
          ? null
          : normalizeSalesArticleSha256(value.expectedStateSha256, "Der Vorschau-Zustand"),
      }));
      const findings = normalizeImportFindings(value.findings, operation);
      const runSummary = normalizeImportRunSummary(value.runSummary, snapshot, operation);
      if (snapshot.articleCount === 0
        && (!runSummary
          || runSummary.safe !== 0
          || runSummary.quarantined < 1
          || findings.length < 1)) {
        throw invalidInput("sales-article-catalog-import-empty-without-findings");
      }
      return typeof access.transaction === "function"
        ? access.transaction(
          async (executor) => {
            const operations = primitiveOperations(executor);
            if (expectedStateSha256) {
              const inspection = await inspectSnapshotState(operations, snapshot);
              if (inspection.stateSha256 !== expectedStateSha256
                || inspection.rows.some(({ action }) => !["create", "update"].includes(action))) {
                throw retryable("sales-article-catalog-import-preview-stale");
              }
            }
            return persistSnapshot(
              operations,
              snapshot,
              actor,
              timestamp,
              findings,
              runSummary,
            );
          },
          { isolation: "serializable" },
        )
        : (async () => {
          if (expectedStateSha256) {
            const inspection = await inspectSnapshotState(direct, snapshot);
            if (inspection.stateSha256 !== expectedStateSha256
              || inspection.rows.some(({ action }) => !["create", "update"].includes(action))) {
              throw retryable("sales-article-catalog-import-preview-stale");
            }
          }
          return persistSnapshot(direct, snapshot, actor, timestamp, findings, runSummary);
        })();
    },

    async inspectImportUndo(value) {
      const operation = "sales-article-catalog-import-undo-inspect";
      exactKeys(value, ["snapshotId"], operation);
      const snapshotId = normalize(operation, () => (
        normalizeSalesArticleSha256(value.snapshotId, "Der Import-Snapshot")
      ));
      return inspectImportUndoState(direct, snapshotId);
    },

    async undoImport(value) {
      const operation = "sales-article-catalog-import-undo";
      exactKeys(
        value,
        ["snapshotId", "expectedImpactSha256", "actor", "timestamp", "undoId"],
        operation,
      );
      const input = normalize(operation, () => ({
        snapshotId: normalizeSalesArticleSha256(value.snapshotId, "Der Import-Snapshot"),
        expectedImpactSha256: normalizeSalesArticleSha256(
          value.expectedImpactSha256,
          "Der Import-Auswirkungsfingerprint",
        ),
        actor: normalizeSalesArticleActor(value.actor),
        timestamp: normalizeSalesArticleTimestamp(value.timestamp),
        undoId: normalizedUuid(value.undoId, operation),
      }));
      return transact((operations) => persistImportUndo(operations, input));
    },

    async createManual(value) {
      const operation = "sales-article-catalog-manual-create";
      const envelope = manualMutationEnvelope(
        value,
        ["input", "actor", "timestamp", "mutationId"],
        operation,
      );
      const article = normalize(operation, () => normalizeSalesArticleManualCreate(value.input));
      return transact((operations) => persistNewManualArticle(operations, {
        ...envelope,
        article,
        copiedFrom: null,
      }));
    },

    async updateManual(value) {
      const operation = "sales-article-catalog-manual-update";
      const envelope = manualMutationEnvelope(
        value,
        ["input", "actor", "timestamp", "mutationId"],
        operation,
      );
      const input = normalize(operation, () => normalizeSalesArticleManualUpdate(value.input));
      return transact(async (operations) => {
        const current = await hydratedArticle(
          operations,
          await operations.queryOne(S.getArticleByNumber, {
            articleNumber: input.currentArticleNumber,
          }),
        );
        if (!current) return Object.freeze({ outcome: "not_found" });
        if (current.currentRevision !== input.expectedRevision) {
          return Object.freeze({
            outcome: "conflict",
            currentRevision: current.currentRevision,
            articleNumber: current.articleNumber,
          });
        }
        if (!current.active) return Object.freeze({ outcome: "already_archived" });
        return persistManagedRevision(operations, {
          ...envelope,
          productId: current.productId,
          expectedRevision: input.expectedRevision,
          articleNumber: input.articleNumber,
          description: input.description,
          active: current.active,
          identifiers: input.identifiers,
          prices: mergedManualPrices(current.prices, input.prices),
          action: "sales.article-catalog.update",
        });
      });
    },

    async copyManual(value) {
      const operation = "sales-article-catalog-manual-copy";
      const envelope = manualMutationEnvelope(
        value,
        ["input", "actor", "timestamp", "mutationId"],
        operation,
      );
      const input = normalize(operation, () => normalizeSalesArticleManualCopy(value.input));
      return transact(async (operations) => {
        const source = await hydratedArticle(
          operations,
          await operations.queryOne(S.getArticleByNumber, {
            articleNumber: input.sourceArticleNumber,
          }),
        );
        if (!source) return Object.freeze({ outcome: "not_found" });
        if (source.currentRevision !== input.expectedRevision) {
          return Object.freeze({
            outcome: "conflict",
            currentRevision: source.currentRevision,
            articleNumber: source.articleNumber,
          });
        }
        const article = normalize(operation, () => normalizeSalesArticleManualCreate({
          articleNumber: input.articleNumber,
          description: input.description || source.description,
          identifiers: input.identifiers || [],
          ...(input.prices ? { prices: input.prices } : {}),
        }));
        return persistNewManualArticle(operations, {
          ...envelope,
          article,
          copiedFrom: source,
        });
      });
    },

    async archiveManual(value) {
      const operation = "sales-article-catalog-manual-archive";
      const envelope = manualMutationEnvelope(
        value,
        ["input", "actor", "timestamp", "mutationId"],
        operation,
      );
      const input = normalize(operation, () => normalizeSalesArticleManualArchive(value.input));
      return transact(async (operations) => {
        const current = await hydratedArticle(
          operations,
          await operations.queryOne(S.getArticleByNumber, {
            articleNumber: input.articleNumber,
          }),
        );
        if (!current) return Object.freeze({ outcome: "not_found" });
        if (current.currentRevision !== input.expectedRevision) {
          return Object.freeze({
            outcome: "conflict",
            currentRevision: current.currentRevision,
            articleNumber: current.articleNumber,
          });
        }
        if (!current.active) return Object.freeze({ outcome: "already_archived" });
        return persistManagedRevision(operations, {
          ...envelope,
          productId: current.productId,
          expectedRevision: input.expectedRevision,
          articleNumber: current.articleNumber,
          description: current.description,
          active: false,
          identifiers: current.identifiers,
          prices: current.prices,
          action: "sales.article-catalog.archive",
        });
      });
    },

    async restoreManual(value) {
      const operation = "sales-article-catalog-manual-restore";
      const envelope = manualMutationEnvelope(
        value,
        [
          "productId", "expectedRevision", "restoreRevision", "actor", "timestamp",
          "mutationId",
        ],
        operation,
      );
      const productId = normalizedUuid(value.productId, operation);
      const expectedRevision = normalize(operation, () => (
        normalizeSalesArticleExpectedRevision(value.expectedRevision)
      ));
      const restoreRevision = value.restoreRevision === null
        ? null
        : normalize(operation, () => normalizeSalesArticleExpectedRevision(value.restoreRevision));
      return transact(async (operations) => {
        const current = await hydratedArticle(
          operations,
          await operations.queryOne(S.getArticleByProductId, { productId }),
        );
        if (!current) return Object.freeze({ outcome: "not_found" });
        if (current.currentRevision !== expectedRevision) {
          return Object.freeze({
            outcome: "conflict",
            currentRevision: current.currentRevision,
            articleNumber: current.articleNumber,
          });
        }
        const target = restoreRevision === null
          ? current
          : await hydratedRevision(operations, productId, restoreRevision);
        if (!target) return Object.freeze({ outcome: "restore_not_found" });
        return persistManagedRevision(operations, {
          ...envelope,
          productId,
          expectedRevision,
          articleNumber: target.articleNumber,
          description: target.description,
          active: restoreRevision === null ? false : target.active,
          identifiers: target.identifiers,
          prices: target.prices,
          action: "sales.article-catalog.undo",
          restoredRevision: restoreRevision,
        });
      });
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

    async getByProductId(value) {
      const productId = normalizedUuid(value, "sales-article-catalog-get-by-product-id");
      return hydratedArticle(
        direct,
        await direct.queryOne(S.getArticleByProductId, { productId }),
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

    async getLatestImportAt(sourceSystem) {
      const normalized = normalize("sales-article-catalog-get-latest-import-at", () => (
        normalizeSalesArticleSourceSystem(sourceSystem)
      ));
      const result = await direct.queryOne(S.getLatestImportAtBySourceSystem, {
        sourceSystem: normalized,
      });
      return result?.importedAt || null;
    },
  });
});

module.exports = {
  createSalesArticleCatalogRepository,
};

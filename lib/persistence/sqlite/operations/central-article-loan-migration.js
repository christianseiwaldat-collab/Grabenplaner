"use strict";

const crypto = require("node:crypto");
const {
  normalizeSalesArticleImportSnapshot,
  salesArticleImportContentSha256,
} = require("../../../sales-article-catalog");

const CENTRAL_ARTICLE_LOAN_MIGRATION_ID = "v0.92.24-central-sales-article-loans";
const LEGACY_ARTICLE_SOURCE_SYSTEM = "legacy.loan_articles";
const LEGACY_ARTICLE_SOURCE_PROFILE_VERSION = "legacy-loan-catalog-v1";
const CENTRAL_ARTICLE_MIGRATION_ACTOR = "system:central-article-migration";

const SQLITE_CENTRAL_LOAN_ITEMS_CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS loan_items (
    id TEXT PRIMARY KEY,
    loan_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 5),
    product_id TEXT NOT NULL,
    product_revision_snapshot INTEGER NOT NULL CHECK(product_revision_snapshot > 0),
    article_number_snapshot TEXT NOT NULL
      CHECK(article_number_snapshot = trim(article_number_snapshot)
        AND length(article_number_snapshot) BETWEEN 1 AND 80),
    description_snapshot TEXT NOT NULL,
    serial_number TEXT NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity = 1),
    condition_out TEXT NOT NULL DEFAULT '',
    condition_return TEXT NOT NULL DEFAULT '',
    item_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(loan_id, position),
    FOREIGN KEY (loan_id) REFERENCES loans(id)
      ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (product_id, product_revision_snapshot)
      REFERENCES sales_article_revisions(product_id, revision)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS idx_loan_items_product
    ON loan_items(product_id, product_revision_snapshot, loan_id);
  CREATE INDEX IF NOT EXISTS idx_loan_items_article_snapshot
    ON loan_items(article_number_snapshot, loan_id);

  CREATE TRIGGER IF NOT EXISTS trg_loan_items_central_article_insert
  BEFORE INSERT ON loan_items
  WHEN NOT EXISTS (
    SELECT 1
    FROM sales_article_revisions revision
    WHERE revision.product_id = NEW.product_id
      AND revision.revision = NEW.product_revision_snapshot
      AND revision.article_number = NEW.article_number_snapshot
  )
  BEGIN
    SELECT RAISE(ABORT, 'loan item central article mismatch');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_loan_items_central_article_update
  BEFORE UPDATE OF product_id, product_revision_snapshot, article_number_snapshot ON loan_items
  WHEN NOT EXISTS (
    SELECT 1
    FROM sales_article_revisions revision
    WHERE revision.product_id = NEW.product_id
      AND revision.revision = NEW.product_revision_snapshot
      AND revision.article_number = NEW.article_number_snapshot
  )
  BEGIN
    SELECT RAISE(ABORT, 'loan item central article mismatch');
  END;
`;

function assertDatabase(database) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  return database;
}

function tableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(name));
}

function columnExists(database, table, column) {
  return tableExists(database, table) && database.prepare(`PRAGMA table_info("${table}")`).all()
    .some((entry) => String(entry.name || "") === column);
}

function centralLoanItemForeignKeyValid(database) {
  if (!tableExists(database, "loan_items")) return false;
  const groups = new Map();
  for (const entry of database.prepare("PRAGMA foreign_key_list(loan_items)").all()) {
    const id = Number(entry.id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(entry);
  }
  return [...groups.values()].some((entries) => (
    entries.length === 2
    && entries.every((entry) => (
      String(entry.table || "") === "sales_article_revisions"
      && String(entry.on_update || "").toUpperCase() === "RESTRICT"
      && String(entry.on_delete || "").toUpperCase() === "RESTRICT"
    ))
    && entries.some((entry) => (
      String(entry.from || "") === "product_id"
      && String(entry.to || "") === "product_id"
    ))
    && entries.some((entry) => (
      String(entry.from || "") === "product_revision_snapshot"
      && String(entry.to || "") === "revision"
    ))
  ));
}

function inspectSqliteCentralArticleLoanMigration(database) {
  const target = assertDatabase(database);
  const legacyArticles = tableExists(target, "articles");
  const legacyIdentifiers = tableExists(target, "article_identifiers");
  const loanItems = tableExists(target, "loan_items");
  const loanDomainPresent = legacyArticles || legacyIdentifiers || loanItems || tableExists(target, "loans");
  const centralSnapshots = tableExists(target, "sales_article_import_snapshots");
  const centralArticles = tableExists(target, "sales_articles");
  const centralRevisions = tableExists(target, "sales_article_revisions");
  const centralSourceLinks = tableExists(target, "sales_article_source_links");
  const centralIdentifierOwners = tableExists(target, "sales_article_identifier_owners");
  const centralIdentifiers = tableExists(target, "sales_article_identifiers");
  const centralPrices = tableExists(target, "sales_article_price_snapshots");
  const productColumn = columnExists(target, "loan_items", "product_id");
  const revisionColumn = columnExists(target, "loan_items", "product_revision_snapshot");
  const articleSnapshotColumn = columnExists(target, "loan_items", "article_number_snapshot");
  const centralForeignKey = centralLoanItemForeignKeyValid(target);
  const missingOriginSourceLinks = centralArticles && centralSourceLinks
    ? Number(target.prepare(`
      SELECT COUNT(*) AS count
      FROM sales_articles article
      WHERE NOT EXISTS (
        SELECT 1
        FROM sales_article_source_links source_link
        WHERE source_link.product_id = article.product_id
          AND source_link.source_system = article.source_system
          AND source_link.source_article_key = article.source_article_key
      )
    `).get()?.count || 0)
    : 0;
  const issues = [];
  if (loanDomainPresent) {
    if (!centralSnapshots) issues.push("central-import-snapshots-missing");
    if (!centralArticles) issues.push("central-articles-missing");
    if (!centralRevisions) issues.push("central-revisions-missing");
    if (!centralSourceLinks) issues.push("central-source-links-missing");
    if (!centralIdentifierOwners) issues.push("central-identifier-owners-missing");
    if (!centralIdentifiers) issues.push("central-identifiers-missing");
    if (!centralPrices) issues.push("central-prices-missing");
  }
  if (legacyArticles) issues.push("legacy-articles-present");
  if (legacyIdentifiers) issues.push("legacy-article-identifiers-present");
  if (missingOriginSourceLinks) issues.push("central-origin-source-links-missing");
  if (!loanItems) {
    if (tableExists(target, "loans")) issues.push("loan-items-missing");
  } else {
    if (!productColumn) issues.push("loan-items-product-id-missing");
    if (!revisionColumn) issues.push("loan-items-product-revision-missing");
    if (!articleSnapshotColumn) issues.push("loan-items-article-snapshot-missing");
    if (!centralForeignKey) issues.push("loan-items-central-foreign-key-missing");
  }
  return Object.freeze({
    required: issues.length > 0,
    legacyArticles,
    legacyIdentifiers,
    loanItems,
    centralSnapshots,
    centralArticles,
    centralRevisions,
    centralSourceLinks,
    centralIdentifierOwners,
    centralIdentifiers,
    centralPrices,
    productColumn,
    revisionColumn,
    articleSnapshotColumn,
    centralForeignKey,
    missingOriginSourceLinks,
    issues: Object.freeze(issues),
  });
}

function backfillOriginSourceLinks(database, timestamp) {
  const unresolved = database.prepare(`
    SELECT article.product_id, article.source_system, article.source_article_key
    FROM sales_articles article
    WHERE NOT EXISTS (
      SELECT 1
      FROM sales_article_source_links source_link
      WHERE source_link.product_id = article.product_id
        AND source_link.source_system = article.source_system
        AND source_link.source_article_key = article.source_article_key
    )
      AND NOT EXISTS (
        SELECT 1
        FROM sales_article_revisions revision
        JOIN sales_article_import_snapshots snapshot
          ON snapshot.id = revision.source_snapshot_id
        WHERE revision.product_id = article.product_id
          AND snapshot.source_system = article.source_system
      )
    ORDER BY article.product_id
  `).all();
  if (unresolved.length) {
    throw migrationError(
      "Mindestens ein fehlender Ursprungslink kann keinem Snapshot desselben Quellsystems zugeordnet werden.",
      "CENTRAL_ARTICLE_SOURCE_LINK_SNAPSHOT_MISSING",
      { unresolved },
    );
  }
  const rows = database.prepare(`
    SELECT article.product_id, article.source_system, article.source_article_key,
           revision.source_snapshot_id
    FROM sales_articles article
    JOIN sales_article_revisions revision
      ON revision.product_id = article.product_id
     AND revision.revision = (
       SELECT MIN(origin_revision.revision)
       FROM sales_article_revisions origin_revision
       JOIN sales_article_import_snapshots origin_snapshot
         ON origin_snapshot.id = origin_revision.source_snapshot_id
       WHERE origin_revision.product_id = article.product_id
         AND origin_snapshot.source_system = article.source_system
     )
    WHERE NOT EXISTS (
      SELECT 1
      FROM sales_article_source_links source_link
      WHERE source_link.product_id = article.product_id
        AND source_link.source_system = article.source_system
        AND source_link.source_article_key = article.source_article_key
    )
    ORDER BY article.product_id
  `).all();
  const insert = database.prepare(`
    INSERT INTO sales_article_source_links (
      product_id, source_system, source_article_key, source_snapshot_id,
      match_method, match_confidence, matched_source_system,
      matched_source_article_key, source_provider, source_product_number,
      source_url, source_fetched_at, source_created_by, source_updated_by,
      source_created_at, source_updated_at, linked_by, linked_at
    ) VALUES (
      ?, ?, ?, ?, 'source_import', 'authoritative', NULL, NULL,
      ?, ?, '', NULL, ?, ?, ?, ?, ?, ?
    )
  `);
  for (const row of rows) {
    if (!row.source_snapshot_id) {
      throw migrationError(
        `Der Ursprungslink fuer Produkt ${row.product_id} kann keinem Snapshot zugeordnet werden.`,
        "CENTRAL_ARTICLE_SOURCE_LINK_SNAPSHOT_MISSING",
        { productId: row.product_id },
      );
    }
    insert.run(
      row.product_id,
      row.source_system,
      row.source_article_key,
      row.source_snapshot_id,
      row.source_system,
      row.source_article_key,
      CENTRAL_ARTICLE_MIGRATION_ACTOR,
      CENTRAL_ARTICLE_MIGRATION_ACTOR,
      timestamp,
      timestamp,
      CENTRAL_ARTICLE_MIGRATION_ACTOR,
      timestamp,
    );
  }
  return rows.length;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value) {
  const hex = sha256(`central-sales-article-v1\0${value}`).slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "89ab"[Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function migrationError(message, code, detail = null) {
  const error = new Error(message);
  error.code = code;
  if (detail) error.detail = detail;
  return error;
}

function sourceKeyForTradeFotoArticleNumber(articleNumber) {
  const normalized = String(articleNumber || "").trim();
  if (!/^\d{6}$/.test(normalized)) {
    throw migrationError(
      `Die Legacy-Artikelnummer ${normalized || "(leer)"} ist nicht eindeutig sechsstellig.`,
      "CENTRAL_ARTICLE_LEGACY_NUMBER_INVALID",
      { articleNumber: normalized },
    );
  }
  return normalized.padStart(13, "0");
}

function legacyTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(String(value).includes("T") ? String(value) : `${value}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function requiredLegacyTimestamp(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = legacyTimestamp(value);
  if (!normalized) {
    throw migrationError(
      `${label} ist kein sicher migrierbarer Zeitpunkt.`,
      "CENTRAL_ARTICLE_LEGACY_METADATA_INVALID",
      { value: String(value) },
    );
  }
  return normalized;
}

function centralActor(value) {
  const normalized = String(value || "").trim();
  return normalized || CENTRAL_ARTICLE_MIGRATION_ACTOR;
}

function normalizedLegacyDescription(database, article) {
  const direct = String(article.description || "").replace(/\s+/g, " ").trim();
  if (direct) return direct;
  const snapshot = database.prepare(`
    SELECT description_snapshot
    FROM loan_items
    WHERE article_number = ? AND TRIM(description_snapshot) <> ''
    ORDER BY updated_at DESC, created_at DESC, id DESC
    LIMIT 1
  `).get(article.article_number);
  const fallback = String(snapshot?.description_snapshot || "").replace(/\s+/g, " ").trim();
  if (fallback) return fallback;
  throw migrationError(
    `Der Legacy-Artikel ${article.article_number} hat keine pruefbare Artikelbezeichnung.`,
    "CENTRAL_ARTICLE_LEGACY_DESCRIPTION_MISSING",
    { articleNumber: article.article_number },
  );
}

function legacyRows(database) {
  if (!tableExists(database, "articles")) return [];
  const identifiers = tableExists(database, "article_identifiers")
    ? database.prepare(`
      SELECT article_number, identifier_type, identifier_value, source_provider
           , verified_at, created_by, updated_by, created_at, updated_at
      FROM article_identifiers
      ORDER BY article_number, identifier_type, identifier_value
    `).all()
    : [];
  const identifiersByArticle = new Map();
  for (const identifier of identifiers) {
    const key = String(identifier.article_number || "");
    if (!identifiersByArticle.has(key)) identifiersByArticle.set(key, []);
    identifiersByArticle.get(key).push(identifier);
  }
  return database.prepare(`
    SELECT article_number, description, source_provider, source_product_number,
           source_url, source_fetched_at, active, created_by, updated_by,
           created_at, updated_at
    FROM articles
    ORDER BY article_number
  `).all().map((legacy) => {
    const articleNumber = String(legacy.article_number || "");
    sourceKeyForTradeFotoArticleNumber(articleNumber);
    return {
      sourceArticleKey: articleNumber,
      articleNumber,
      description: normalizedLegacyDescription(database, legacy),
      active: Number(legacy.active) === 1,
      sourceUpdatedAt: legacyTimestamp(legacy.source_fetched_at),
      identifiers: (identifiersByArticle.get(articleNumber) || []).map((identifier) => ({
        identifierType: String(identifier.identifier_type || ""),
        identifierValue: String(identifier.identifier_value || ""),
        isPrimary: false,
        sourceField: `legacy.${String(identifier.source_provider || "unknown")}`.slice(0, 80),
        sourceRank: null,
        sourceProvider: String(identifier.source_provider || ""),
        verifiedAt: requiredLegacyTimestamp(identifier.verified_at, "Der Identifier-Prüfzeitpunkt"),
        createdBy: String(identifier.created_by || ""),
        updatedBy: String(identifier.updated_by || ""),
        createdAt: requiredLegacyTimestamp(identifier.created_at, "Der Identifier-Anlagezeitpunkt"),
        updatedAt: requiredLegacyTimestamp(identifier.updated_at, "Der Identifier-Änderungszeitpunkt"),
      })),
      prices: [],
      sourceMetadata: {
        provider: String(legacy.source_provider || ""),
        productNumber: String(legacy.source_product_number || ""),
        url: String(legacy.source_url || ""),
        fetchedAt: legacy.source_fetched_at == null ? null : String(legacy.source_fetched_at),
        createdBy: String(legacy.created_by || ""),
        updatedBy: String(legacy.updated_by || ""),
        createdAt: legacy.created_at == null ? null : String(legacy.created_at),
        updatedAt: legacy.updated_at == null ? null : String(legacy.updated_at),
      },
      legacy,
    };
  });
}

function migrationSnapshot(rows, timestamp) {
  const articles = rows.map(({ legacy, ...article }) => article);
  const contentSha256 = salesArticleImportContentSha256(articles);
  const sourceFileSha256 = sha256(JSON.stringify(rows.map(({ legacy, ...article }) => ({
    ...article,
    legacySourceProvider: legacy.source_provider,
    legacySourceProductNumber: legacy.source_product_number,
    legacySourceUrl: legacy.source_url,
    legacyCreatedAt: legacy.created_at,
    legacyUpdatedAt: legacy.updated_at,
  }))));
  return normalizeSalesArticleImportSnapshot({
    sourceSystem: LEGACY_ARTICLE_SOURCE_SYSTEM,
    sourceProfileVersion: LEGACY_ARTICLE_SOURCE_PROFILE_VERSION,
    sourceSchemaSha256: sha256("legacy-loan-articles-v085"),
    sourceFileSha256,
    contentSha256,
    snapshotAt: timestamp,
    articles,
  });
}

function assertLegacyLoanReferences(database, rows) {
  if (!tableExists(database, "loan_items")) return;
  const catalogNumbers = new Set(rows.map((row) => row.articleNumber));
  const missing = database.prepare(`
    SELECT article_number, COUNT(*) AS item_count
    FROM loan_items
    GROUP BY article_number
    ORDER BY article_number
  `).all().filter((row) => !catalogNumbers.has(String(row.article_number || "")));
  if (missing.length) {
    throw migrationError(
      "Mindestens ein Leihvorgang verweist auf eine nicht eindeutig zuordenbare Legacy-Artikelnummer.",
      "CENTRAL_ARTICLE_LOAN_REFERENCE_UNRESOLVED",
      { missing },
    );
  }
}

function insertSnapshot(database, snapshot, timestamp) {
  database.prepare(`
    INSERT INTO sales_article_import_snapshots (
      id, idempotency_key, source_system, source_profile_version,
      source_schema_sha256, source_file_sha256, content_sha256, snapshot_at,
      article_count, identifier_count, price_count, imported_by, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.id,
    snapshot.idempotencyKey,
    snapshot.sourceSystem,
    snapshot.sourceProfileVersion,
    snapshot.sourceSchemaSha256,
    snapshot.sourceFileSha256,
    snapshot.contentSha256,
    snapshot.snapshotAt,
    snapshot.articleCount,
    snapshot.identifierCount,
    snapshot.priceCount,
    CENTRAL_ARTICLE_MIGRATION_ACTOR,
    timestamp,
  );
}

function insertMigratedArticles(database, snapshot, timestamp) {
  const products = new Map();
  let createdArticleCount = 0;
  let reusedArticleCount = 0;
  let sourceLinkCount = 0;
  const getByNumber = database.prepare(`
    SELECT product_id, article_number, current_revision, source_system, source_article_key
    FROM sales_articles WHERE article_number = ?
  `);
  const getBySource = database.prepare(`
    SELECT article.product_id, article.article_number, article.current_revision,
           article.source_system, article.source_article_key
    FROM sales_article_source_links source_link
    JOIN sales_articles article ON article.product_id = source_link.product_id
    WHERE source_link.source_system = ? AND source_link.source_article_key = ?
  `);
  const getIdentifierOwners = database.prepare(`
    SELECT product_id
    FROM sales_article_identifier_owners
    WHERE canonical_gtin14 = ?
  `);
  const insertProduct = database.prepare(`
    INSERT INTO sales_articles (
      product_id, article_number, source_system, source_article_key, current_revision,
      created_by, created_at, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
  `);
  const insertRevision = database.prepare(`
    INSERT INTO sales_article_revisions (
      product_id, revision, article_number, description, active, source_snapshot_id,
      source_updated_at, created_by, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSourceLink = database.prepare(`
    INSERT INTO sales_article_source_links (
      product_id, source_system, source_article_key, source_snapshot_id,
      match_method, match_confidence, matched_source_system,
      matched_source_article_key, source_provider, source_product_number,
      source_url, source_fetched_at, source_created_by, source_updated_by,
      source_created_at, source_updated_at, linked_by, linked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSourceLinkAudit = database.prepare(`
    INSERT INTO audit_log (actor, action, entity_type, entity_id, detail, created_at)
    VALUES (?, 'sales.article-catalog.source-link', 'sales_article', ?, ?, ?)
  `);
  const insertIdentifier = database.prepare(`
    INSERT INTO sales_article_identifiers (
      id, product_id, source_snapshot_id, identifier_type, identifier_value,
      canonical_gtin14, is_primary, source_field, source_rank, verified_at,
      equivalent_identifiers_json, source_provider, created_by, created_at,
      updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const article of snapshot.articles) {
    const byNumber = getByNumber.get(article.articleNumber);
    const bySource = getBySource.get(snapshot.sourceSystem, article.sourceArticleKey);
    if (byNumber && bySource && byNumber.product_id !== bySource.product_id) {
      throw migrationError(
        `Der Legacy-Artikel ${article.articleNumber} ist ueber Artikelnummer und Herkunft verschiedenen Produkten zugeordnet.`,
        "CENTRAL_ARTICLE_IDENTITY_CONFLICT",
        {
          articleNumber: article.articleNumber,
          sourceArticleKey: article.sourceArticleKey,
          productByNumber: byNumber.product_id,
          productBySource: bySource.product_id,
        },
      );
    }
    const existing = bySource || byNumber;
    if (existing && existing.article_number !== article.articleNumber) {
      throw migrationError(
        `Der Legacy-Artikel ${article.articleNumber} kollidiert mit der zentralen Artikelnummer ${existing.article_number}.`,
        "CENTRAL_ARTICLE_IDENTITY_CONFLICT",
        {
          articleNumber: article.articleNumber,
          sourceArticleKey: article.sourceArticleKey,
          productId: existing.product_id,
          centralArticleNumber: existing.article_number,
        },
      );
    }
    const productId = existing?.product_id
      || deterministicUuid(`${snapshot.sourceSystem}\0${article.sourceArticleKey}`);
    const revision = existing?.current_revision || 1;
    for (const identifier of article.identifiers) {
      const owners = getIdentifierOwners.all(identifier.canonicalGtin14);
      if (owners.some((owner) => owner.product_id !== productId)) {
        throw migrationError(
          `Die Kennung ${identifier.identifierValue} des Legacy-Artikels ${article.articleNumber} gehoert bereits zu einem anderen zentralen Produkt.`,
          "CENTRAL_ARTICLE_IDENTIFIER_CONFLICT",
          {
            articleNumber: article.articleNumber,
            canonicalGtin14: identifier.canonicalGtin14,
            productId,
            conflictingProductIds: owners.map((owner) => owner.product_id),
          },
        );
      }
    }
    if (!existing) {
      const sourceMetadata = article.sourceMetadata || {};
      const createdAt = requiredLegacyTimestamp(
        sourceMetadata.createdAt,
        "Der Artikel-Anlagezeitpunkt",
      ) || timestamp;
      const updatedAt = requiredLegacyTimestamp(
        sourceMetadata.updatedAt,
        "Der Artikel-Änderungszeitpunkt",
      ) || createdAt;
      if (createdAt > updatedAt) {
        throw migrationError(
          `Der Legacy-Artikel ${article.articleNumber} hat eine Änderung vor seiner Anlage.`,
          "CENTRAL_ARTICLE_LEGACY_METADATA_INVALID",
          { articleNumber: article.articleNumber, createdAt, updatedAt },
        );
      }
      const createdBy = centralActor(sourceMetadata.createdBy);
      const updatedBy = centralActor(sourceMetadata.updatedBy || sourceMetadata.createdBy);
      insertProduct.run(
        productId,
        article.articleNumber,
        snapshot.sourceSystem,
        article.sourceArticleKey,
        createdBy,
        createdAt,
        updatedBy,
        updatedAt,
      );
      insertRevision.run(
        productId,
        article.articleNumber,
        article.description,
        article.active ? 1 : 0,
        snapshot.id,
        article.sourceUpdatedAt,
        updatedBy,
        updatedAt,
      );
      createdArticleCount += 1;
    } else {
      reusedArticleCount += 1;
    }
    if (!bySource) {
      const matchMethod = existing ? "article_number_exact" : "legacy_migration";
      const matchConfidence = existing ? "exact" : "authoritative";
      const matchedSourceSystem = existing?.source_system || null;
      const matchedSourceArticleKey = existing?.source_article_key || null;
      insertSourceLink.run(
        productId,
        snapshot.sourceSystem,
        article.sourceArticleKey,
        snapshot.id,
        matchMethod,
        matchConfidence,
        matchedSourceSystem,
        matchedSourceArticleKey,
        article.sourceMetadata?.provider || snapshot.sourceSystem,
        article.sourceMetadata?.productNumber ?? article.sourceArticleKey,
        article.sourceMetadata?.url || "",
        article.sourceMetadata?.fetchedAt || article.sourceUpdatedAt,
        article.sourceMetadata?.createdBy || "",
        article.sourceMetadata?.updatedBy || "",
        article.sourceMetadata?.createdAt || null,
        article.sourceMetadata?.updatedAt || null,
        CENTRAL_ARTICLE_MIGRATION_ACTOR,
        timestamp,
      );
      insertSourceLinkAudit.run(
        CENTRAL_ARTICLE_MIGRATION_ACTOR,
        productId,
        JSON.stringify({
          sourceSystem: snapshot.sourceSystem,
          sourceArticleKey: article.sourceArticleKey,
          sourceSnapshotId: snapshot.id,
          matchMethod,
          matchConfidence,
          matchedSourceSystem,
          matchedSourceArticleKey,
        }),
        timestamp,
      );
      sourceLinkCount += 1;
    }
    for (const identifier of article.identifiers) {
      insertIdentifier.run(
        deterministicUuid(`${article.sourceArticleKey}\0${identifier.canonicalGtin14}`),
        productId,
        snapshot.id,
        identifier.identifierType,
        identifier.identifierValue,
        identifier.canonicalGtin14,
        identifier.isPrimary ? 1 : 0,
        identifier.sourceField,
        identifier.sourceRank,
        identifier.verifiedAt || timestamp,
        JSON.stringify(identifier.equivalentIdentifiers || []),
        identifier.sourceProvider || "",
        centralActor(identifier.createdBy),
        identifier.createdAt || timestamp,
        centralActor(identifier.updatedBy || identifier.createdBy),
        identifier.updatedAt || identifier.createdAt || timestamp,
      );
    }
    products.set(article.articleNumber, { productId, revision });
  }
  return Object.freeze({ products, createdArticleCount, reusedArticleCount, sourceLinkCount });
}

function rebuildLoanItems(database, products) {
  if (!tableExists(database, "loan_items")) {
    database.exec(SQLITE_CENTRAL_LOAN_ITEMS_CREATE_SQL);
    return 0;
  }
  const legacyItems = database.prepare(`
    SELECT id, loan_id, position, article_number, description_snapshot, serial_number,
           quantity, condition_out, condition_return, item_note, created_at, updated_at
    FROM loan_items
    ORDER BY loan_id, position
  `).all();
  database.exec(`
    DROP TRIGGER IF EXISTS trg_loan_items_central_article_insert;
    DROP TRIGGER IF EXISTS trg_loan_items_central_article_update;
    DROP INDEX IF EXISTS idx_loan_items_product;
    DROP INDEX IF EXISTS idx_loan_items_article_snapshot;
    DROP INDEX IF EXISTS idx_loan_items_article;
    ALTER TABLE loan_items RENAME TO loan_items_legacy_v09224;
    ${SQLITE_CENTRAL_LOAN_ITEMS_CREATE_SQL}
  `);
  const insertItem = database.prepare(`
    INSERT INTO loan_items (
      id, loan_id, position, product_id, product_revision_snapshot,
      article_number_snapshot, description_snapshot, serial_number, quantity,
      condition_out, condition_return, item_note, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of legacyItems) {
    const product = products.get(String(item.article_number || ""));
    if (!product) {
      throw migrationError(
        `Der Leihartikel ${item.article_number || "(leer)"} kann keiner zentralen Produktidentitaet zugeordnet werden.`,
        "CENTRAL_ARTICLE_LOAN_REFERENCE_UNRESOLVED",
        { loanId: item.loan_id, loanItemId: item.id, articleNumber: item.article_number },
      );
    }
    insertItem.run(
      item.id,
      item.loan_id,
      item.position,
      product.productId,
      product.revision,
      item.article_number,
      item.description_snapshot,
      item.serial_number,
      item.quantity,
      item.condition_out,
      item.condition_return,
      item.item_note,
      item.created_at,
      item.updated_at,
    );
  }
  database.exec("DROP TABLE loan_items_legacy_v09224");
  return legacyItems.length;
}

function migrateSqliteCentralArticleLoans(database, { timestamp = new Date().toISOString() } = {}) {
  const target = assertDatabase(database);
  const before = inspectSqliteCentralArticleLoanMigration(target);
  if (!before.required) {
    return Object.freeze({ migrated: false, articleCount: 0, identifierCount: 0, loanItemCount: 0 });
  }
  const structuralIssues = before.issues.filter(
    (issue) => issue !== "central-origin-source-links-missing",
  );
  if (!before.legacyArticles && structuralIssues.length) {
    throw migrationError(
      `Die zentrale Artikelmigration kann den Schema-Drift nicht sicher reparieren: ${before.issues.join(", ")}.`,
      "CENTRAL_ARTICLE_SCHEMA_DRIFT",
    );
  }
  const normalizedTimestamp = new Date(timestamp).toISOString();
  if (normalizedTimestamp !== timestamp) {
    throw new TypeError("Der zentrale Artikel-Migrationszeitpunkt ist ungueltig.");
  }
  const rows = legacyRows(target);
  assertLegacyLoanReferences(target, rows);
  const snapshot = rows.length ? migrationSnapshot(rows, timestamp) : null;
  const foreignKeysEnabled = Number(target.prepare("PRAGMA foreign_keys").get()?.foreign_keys || 0) === 1;
  target.exec("PRAGMA foreign_keys = OFF");
  target.exec("BEGIN IMMEDIATE");
  try {
    const sourceLinkBackfillCount = backfillOriginSourceLinks(target, timestamp);
    let articleMigration = Object.freeze({
      products: new Map(),
      createdArticleCount: 0,
      reusedArticleCount: 0,
      sourceLinkCount: 0,
    });
    if (snapshot) {
      insertSnapshot(target, snapshot, timestamp);
      articleMigration = insertMigratedArticles(target, snapshot, timestamp);
    }
    const loanItemCount = before.legacyArticles
      ? rebuildLoanItems(target, articleMigration.products)
      : 0;
    if (tableExists(target, "article_identifiers")) target.exec("DROP TABLE article_identifiers");
    if (tableExists(target, "articles")) target.exec("DROP TABLE articles");
    target.prepare(`
      INSERT INTO audit_log (actor, action, entity_type, entity_id, detail, created_at)
      VALUES (?, ?, 'sales_article_import_snapshot', ?, ?, ?)
    `).run(
      CENTRAL_ARTICLE_MIGRATION_ACTOR,
      before.legacyArticles
        ? "sales.article-catalog.legacy-loans.migrate"
        : "sales.article-catalog.source-links.backfill",
      snapshot?.id || CENTRAL_ARTICLE_LOAN_MIGRATION_ID,
      JSON.stringify({
        articleCount: snapshot?.articleCount || 0,
        identifierCount: snapshot?.identifierCount || 0,
        loanItemCount,
        sourceSystem: LEGACY_ARTICLE_SOURCE_SYSTEM,
        futureTradeFotoBindingMethod: "article_number_exact",
        sourceLinkBackfillCount,
        sourceLinkCount: articleMigration.sourceLinkCount,
        createdArticleCount: articleMigration.createdArticleCount,
        reusedArticleCount: articleMigration.reusedArticleCount,
      }),
      timestamp,
    );
    const quickCheck = target.prepare("PRAGMA quick_check").get()?.quick_check;
    if (quickCheck !== "ok") {
      throw migrationError(
        `Die zentrale Artikelmigration hat einen SQLite-Integritaetsfehler erkannt: ${quickCheck}.`,
        "CENTRAL_ARTICLE_QUICK_CHECK_FAILED",
      );
    }
    const foreignKeyViolation = target.prepare("PRAGMA foreign_key_check").get();
    if (foreignKeyViolation) {
      throw migrationError(
        "Die zentrale Artikelmigration hat eine Fremdschluesselverletzung erkannt.",
        "CENTRAL_ARTICLE_FOREIGN_KEY_INVALID",
        foreignKeyViolation,
      );
    }
    const after = inspectSqliteCentralArticleLoanMigration(target);
    if (after.required) {
      throw migrationError(
        `Die zentrale Artikelmigration ist unvollstaendig: ${after.issues.join(", ")}.`,
        "CENTRAL_ARTICLE_SCHEMA_DRIFT",
      );
    }
    target.exec("COMMIT");
    return Object.freeze({
      migrated: true,
      snapshotId: snapshot?.id || null,
      articleCount: snapshot?.articleCount || 0,
      identifierCount: snapshot?.identifierCount || 0,
      loanItemCount,
      sourceLinkBackfillCount,
      sourceLinkCount: articleMigration.sourceLinkCount,
      createdArticleCount: articleMigration.createdArticleCount,
      reusedArticleCount: articleMigration.reusedArticleCount,
    });
  } catch (error) {
    try { target.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    target.exec(`PRAGMA foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"}`);
  }
}

module.exports = {
  CENTRAL_ARTICLE_LOAN_MIGRATION_ID,
  CENTRAL_ARTICLE_MIGRATION_ACTOR,
  LEGACY_ARTICLE_SOURCE_PROFILE_VERSION,
  LEGACY_ARTICLE_SOURCE_SYSTEM,
  SQLITE_CENTRAL_LOAN_ITEMS_CREATE_SQL,
  inspectSqliteCentralArticleLoanMigration,
  migrateSqliteCentralArticleLoans,
  sourceKeyForTradeFotoArticleNumber,
};

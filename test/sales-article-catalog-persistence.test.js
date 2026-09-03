"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/contract");
const {
  compilePostgresqlDialectEntry,
} = require("../lib/persistence/postgresql/dialect-compiler");
const {
  createSalesArticleCatalogRepository,
} = require("../lib/persistence/repositories/sales-article-catalog");
const {
  ensureSqliteSalesArticleCatalogSchema,
} = require("../lib/persistence/sqlite/operations/sales-article-catalog-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  SQLITE_SALES_ARTICLE_CATALOG,
} = require("../lib/persistence/sqlite/sales-article-catalog-catalog");
const {
  SALES_ARTICLE_CATALOG_STATEMENTS,
} = require("../lib/persistence/statements/sales-article-catalog");
const {
  salesArticleImportContentSha256,
} = require("../lib/sales-article-catalog");

const IMPORTED_AT = "2026-09-03T08:05:00.000Z";

function price(overrides = {}) {
  return {
    priceType: "sales",
    amount: "13.67144267874",
    currency: "EUR",
    priceBasis: "gross",
    qualityStatus: "confirmed",
    sourceField: "Verkaufspreis",
    ...overrides,
  };
}

function article(overrides = {}) {
  return {
    sourceArticleKey: "0000000093757",
    articleNumber: "093757",
    description: "Synthetischer Testartikel",
    active: true,
    sourceUpdatedAt: null,
    identifiers: [],
    prices: [
      price(),
      price({ priceType: "internet_2", amount: "0", sourceField: "InternetVK2" }),
      price({
        priceType: "internet_2",
        amount: null,
        priceBasis: "net",
        qualityStatus: "unresolved",
        sourceField: "InternetVKN2",
      }),
      price({
        priceType: "internet_5",
        amount: "-1.25",
        qualityStatus: "quarantined",
        sourceField: "InternetVK5",
      }),
    ],
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  const value = {
    sourceSystem: "tradefoto",
    sourceProfileVersion: "tradefoto-article-v1",
    sourceSchemaSha256: "a".repeat(64),
    sourceFileSha256: "f".repeat(64),
    snapshotAt: "2026-09-03T08:00:00.000Z",
    articles: [article()],
    ...overrides,
  };
  return {
    ...value,
    contentSha256: Object.hasOwn(overrides, "contentSha256")
      ? overrides.contentSha256
      : salesArticleImportContentSha256(value.articles),
  };
}

async function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_SALES_ARTICLE_CATALOG,
  });
  application.database.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  ensureSqliteSalesArticleCatalogSchema(application.database);
  return {
    ...application,
    repository: createSalesArticleCatalogRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

function count(database, table) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

function persistenceCode(code) {
  return (error) => error?.code === code;
}

test("Statementkatalog ist vollständig und PostgreSQL-portabel kompilierbar", () => {
  const statements = Object.values(SALES_ARTICLE_CATALOG_STATEMENTS);
  assert.equal(statements.length, 16);
  assert.equal(SQLITE_SALES_ARTICLE_CATALOG.length, statements.length);
  assert.equal(new Set(statements).size, statements.length);
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_SALES_ARTICLE_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
  for (const entry of SQLITE_SALES_ARTICLE_CATALOG) {
    const compiled = compilePostgresqlDialectEntry(entry);
    assert.equal(compiled.strategy, "portable-generated", entry.statement.id);
  }
});

test("Inaktive Importrevision bleibt Staging und braucht eine explizit aktive Promotion", async () => {
  const context = await fixture();
  try {
    await context.repository.importSnapshot({
      snapshot: snapshot({
        sourceSystem: "manual.loan",
        sourceFileSha256: "1".repeat(64),
        articles: [article({
          description: "Manuell kuratierte Bezeichnung",
          active: true,
          sourceMetadata: {
            provider: "manual",
            productNumber: "093757",
            url: "",
            fetchedAt: null,
            createdBy: "419",
            updatedBy: "419",
            createdAt: "2026-09-03T07:00:00.000Z",
            updatedAt: "2026-09-03T07:00:00.000Z",
          },
        })],
      }),
      actor: "419",
      timestamp: "2026-09-03T08:00:00.000Z",
    });
    await context.repository.importSnapshot({
      snapshot: snapshot({
        sourceSystem: "tradefoto.artikel_stamm",
        sourceFileSha256: "2".repeat(64),
        articles: [article({
          description: "Ungeprüfte TradeFoto-Bezeichnung",
          active: false,
        })],
      }),
      actor: "importer",
      timestamp: "2026-09-03T09:00:00.000Z",
    });

    const staged = await context.repository.getByArticleNumber("093757");
    assert.equal(staged.currentRevision, 1);
    assert.equal(staged.active, true);
    assert.equal(staged.description, "Manuell kuratierte Bezeichnung");
    assert.deepEqual(
      (await context.repository.listRevisions(staged.productId)).map((entry) => [
        entry.revision,
        entry.active,
        entry.description,
      ]),
      [
        [2, false, "Ungeprüfte TradeFoto-Bezeichnung"],
        [1, true, "Manuell kuratierte Bezeichnung"],
      ],
    );

    await context.repository.importSnapshot({
      snapshot: snapshot({
        sourceSystem: "tradefoto.artikel_stamm",
        sourceFileSha256: "3".repeat(64),
        articles: [article({
          description: "Explizit freigegebene TradeFoto-Bezeichnung",
          active: true,
        })],
      }),
      actor: "reviewer",
      timestamp: "2026-09-03T10:00:00.000Z",
    });
    const promoted = await context.repository.getByArticleNumber("093757");
    assert.equal(promoted.currentRevision, 3);
    assert.equal(promoted.description, "Explizit freigegebene TradeFoto-Bezeichnung");
  } finally {
    await context.close();
  }
});

test("Import ist atomar, revisionssicher, verlustfrei und zusammengefasst auditiert", async () => {
  const context = await fixture();
  try {
    const first = await context.repository.importSnapshot({
      snapshot: snapshot(),
      actor: "tester",
      timestamp: IMPORTED_AT,
    });
    assert.equal(first.replayed, false);
    assert.equal(first.snapshot.articleCount, 1);
    assert.equal(first.snapshot.identifierCount, 0);
    assert.equal(first.snapshot.priceCount, 4);

    const stored = await context.repository.getByArticleNumber("093757");
    assert.match(stored.productId, /^[a-f0-9-]{36}$/);
    assert.equal(stored.articleNumber, "093757");
    assert.equal(stored.sourceArticleKey, "0000000093757");
    assert.equal(stored.currentRevision, 1);
    assert.deepEqual(stored.identifiers, []);
    assert.equal(stored.prices.length, 4);
    const byField = Object.fromEntries(stored.prices.map((entry) => [entry.sourceField, entry]));
    assert.equal(byField.Verkaufspreis.amount, "13.671442678740");
    assert.equal(byField.InternetVK2.amount, "0.000000000000");
    assert.equal(byField.InternetVKN2.amount, null);
    assert.equal(byField.InternetVKN2.priceBasis, "net");
    assert.equal(byField.InternetVK5.amount, "-1.250000000000");
    assert.equal(byField.InternetVK5.qualityStatus, "quarantined");

    const sourceLink = context.database.prepare(`
      SELECT product_id, source_system, source_article_key, source_snapshot_id,
        match_method, match_confidence, matched_source_system,
        matched_source_article_key, linked_by, linked_at
      FROM sales_article_source_links
    `).get();
    assert.deepEqual({ ...sourceLink }, {
      product_id: stored.productId,
      source_system: "tradefoto",
      source_article_key: "0000000093757",
      source_snapshot_id: first.snapshot.id,
      match_method: "source_import",
      match_confidence: "authoritative",
      matched_source_system: null,
      matched_source_article_key: null,
      linked_by: "tester",
      linked_at: IMPORTED_AT,
    });

    const audits = context.database.prepare(`
      SELECT actor, action, entity_type, entity_id, detail
      FROM audit_log ORDER BY id
    `).all();
    assert.equal(audits.length, 2);
    assert.deepEqual({
      ...audits[0],
      detail: JSON.parse(audits[0].detail),
    }, {
      actor: "tester",
      action: "sales.article-catalog.source-link",
      entity_type: "sales_article",
      entity_id: stored.productId,
      detail: {
        sourceSystem: "tradefoto",
        sourceArticleKey: "0000000093757",
        matchMethod: "source_import",
        matchConfidence: "authoritative",
        matchedSourceSystem: null,
        matchedSourceArticleKey: null,
        sourceSnapshotId: first.snapshot.id,
      },
    });
    assert.equal(audits[1].actor, "tester");
    assert.equal(audits[1].action, "sales.article-catalog.import");
    assert.equal(audits[1].entity_type, "sales_article_import_snapshot");
    assert.equal(audits[1].entity_id, first.snapshot.id);
    assert.deepEqual(JSON.parse(audits[1].detail), {
      sourceSystem: "tradefoto",
      sourceProfileVersion: "tradefoto-article-v1",
      sourceSchemaSha256: "a".repeat(64),
      sourceFileSha256: "f".repeat(64),
      contentSha256: salesArticleImportContentSha256([article()]),
      snapshotAt: "2026-09-03T08:00:00.000Z",
      articleCount: 1,
      identifierCount: 0,
      priceCount: 4,
    });

    await assert.rejects(
      context.repository.importSnapshot({
        snapshot: snapshot({
          articles: [article({ description: "Manipulierter Replay-Inhalt" })],
          contentSha256: first.snapshot.contentSha256,
        }),
        actor: "second-actor",
        timestamp: "2026-09-03T08:09:00.000Z",
      }),
      persistenceCode(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID),
    );
    assert.equal(count(context.database, "sales_article_import_snapshots"), 1);
    assert.equal(count(context.database, "sales_article_revisions"), 1);
    assert.equal(count(context.database, "audit_log"), 2);

    const replay = await context.repository.importSnapshot({
      snapshot: snapshot(),
      actor: "second-actor",
      timestamp: "2026-09-03T08:10:00.000Z",
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.snapshot.id, first.snapshot.id);
    assert.equal(replay.snapshot.importedBy, "tester");
    assert.equal(count(context.database, "sales_article_import_snapshots"), 1);
    assert.equal(count(context.database, "sales_article_revisions"), 1);
    assert.equal(count(context.database, "sales_article_price_snapshots"), 4);
    assert.equal(count(context.database, "audit_log"), 2);

    const second = await context.repository.importSnapshot({
      snapshot: snapshot({
        snapshotAt: "2026-09-03T09:00:00.000Z",
        articles: [article({
          description: "Synthetischer Testartikel, neue Beschreibung",
          sourceUpdatedAt: "2026-09-03T08:55:00.000Z",
          identifiers: [{
            identifierValue: "4006381333931",
            isPrimary: true,
            sourceField: "EAN",
          }],
          prices: [price({ amount: "14.5" })],
        })],
      }),
      actor: "tester",
      timestamp: "2026-09-03T09:05:00.000Z",
    });
    assert.equal(second.replayed, false);
    const current = await context.repository.getBySource({
      sourceSystem: "tradefoto",
      sourceArticleKey: "0000000093757",
    });
    assert.equal(current.currentRevision, 2);
    assert.equal(current.description, "Synthetischer Testartikel, neue Beschreibung");
    assert.equal(current.prices[0].amount, "14.500000000000");
    assert.equal(current.identifiers[0].identifierValue, "4006381333931");
    assert.equal(current.identifiers[0].canonicalGtin14, "04006381333931");
    assert.equal(current.identifiers[0].sourceRank, null);
    const revisions = await context.repository.listRevisions(current.productId);
    assert.deepEqual(revisions.map(({ revision }) => revision), [2, 1]);
    assert.equal(count(context.database, "sales_article_source_links"), 1);
    assert.equal(count(context.database, "audit_log"), 3);
  } finally {
    await context.close();
  }
});

test("Identitäts- und Identifierkonflikte rollen den gesamten Snapshot zurück", async () => {
  const context = await fixture();
  try {
    await context.repository.importSnapshot({
      snapshot: snapshot({
        articles: [article({
          identifiers: [{
            identifierValue: "4006381333931",
            isPrimary: true,
            sourceField: "EAN",
          }],
        })],
      }),
      actor: "tester",
      timestamp: IMPORTED_AT,
    });
    const before = {
      imports: count(context.database, "sales_article_import_snapshots"),
      articles: count(context.database, "sales_articles"),
      revisions: count(context.database, "sales_article_revisions"),
      audit: count(context.database, "audit_log"),
    };

    await assert.rejects(
      context.repository.importSnapshot({
        snapshot: snapshot({
          articles: [
            article({
              sourceArticleKey: "0000000000001",
              articleNumber: "000001",
              description: "Muss zurückgerollt werden",
              identifiers: [],
            }),
            article({
              sourceArticleKey: "0000000000002",
              articleNumber: "093757",
              description: "Kollidierende Identität",
              identifiers: [],
            }),
          ],
        }),
        actor: "tester",
        timestamp: "2026-09-03T09:00:00.000Z",
      }),
      persistenceCode(PERSISTENCE_ERROR_CODES.UNIQUE_VIOLATION),
    );
    assert.equal(await context.repository.getByArticleNumber("000001"), null);
    assert.deepEqual({
      imports: count(context.database, "sales_article_import_snapshots"),
      articles: count(context.database, "sales_articles"),
      revisions: count(context.database, "sales_article_revisions"),
      audit: count(context.database, "audit_log"),
    }, before);

    await assert.rejects(
      context.repository.importSnapshot({
        snapshot: snapshot({
          articles: [article({
            sourceArticleKey: "0000000000003",
            articleNumber: "000003",
            description: "Identifierkonflikt",
            identifiers: [{
              identifierValue: "4006381333931",
              isPrimary: true,
              sourceField: "EAN",
            }],
          })],
        }),
        actor: "tester",
        timestamp: "2026-09-03T09:05:00.000Z",
      }),
      persistenceCode(PERSISTENCE_ERROR_CODES.UNIQUE_VIOLATION),
    );
    assert.equal(await context.repository.getByArticleNumber("000003"), null);
    assert.deepEqual({
      imports: count(context.database, "sales_article_import_snapshots"),
      articles: count(context.database, "sales_articles"),
      revisions: count(context.database, "sales_article_revisions"),
      audit: count(context.database, "audit_log"),
    }, before);
  } finally {
    await context.close();
  }
});

test("Ungültige Number-Preise werden vor jeder Datenbankmutation abgewiesen", async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      context.repository.importSnapshot({
        snapshot: snapshot({
          articles: [article({ prices: [price({ amount: 13.67 })] })],
          contentSha256: "b".repeat(64),
        }),
        actor: "tester",
        timestamp: IMPORTED_AT,
      }),
      persistenceCode(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID),
    );
    assert.equal(count(context.database, "sales_article_import_snapshots"), 0);
    assert.equal(count(context.database, "sales_articles"), 0);
    assert.equal(count(context.database, "audit_log"), 0);
  } finally {
    await context.close();
  }
});

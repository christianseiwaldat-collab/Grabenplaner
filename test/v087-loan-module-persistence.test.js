"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createLoanModuleRepository,
} = require("../lib/persistence/repositories/loan-module");
const {
  createSalesArticleCatalogRepository,
} = require("../lib/persistence/repositories/sales-article-catalog");
const {
  SQLITE_LOAN_MODULE_CATALOG,
} = require("../lib/persistence/sqlite/loan-module-catalog");
const {
  SQLITE_SALES_ARTICLE_CATALOG,
} = require("../lib/persistence/sqlite/sales-article-catalog-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  LOAN_MODULE_STATEMENTS,
} = require("../lib/persistence/statements/loan-module");
const {
  salesArticleImportContentSha256,
} = require("../lib/sales-article-catalog");

function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: [
      ...SQLITE_LOAN_MODULE_CATALOG,
      ...SQLITE_SALES_ARTICLE_CATALOG,
    ],
  });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`
    INSERT INTO locations (id, name, active)
      VALUES ('18', 'Filiale 18', 1);
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      time_confirmation_level, active
    ) VALUES
      ('E18', 'Erika Beispiel', 'Erika', '18', 'B', 1),
      ('M18', 'Max Muster', 'Max', '18', 'B', 1);
  `);
  return {
    repository: createLoanModuleRepository(application.provider),
    salesArticleCatalog: createSalesArticleCatalogRepository(application.provider),
    transaction(work) {
      return application.provider.transaction(
        (executor) => work(createLoanModuleRepository(executor)),
      );
    },
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

async function importCentralArticle(context, articleNumber, description, identifier = null) {
  const article = {
    sourceArticleKey: articleNumber,
    articleNumber,
    description,
    active: true,
    sourceUpdatedAt: null,
    identifiers: identifier ? [{
      identifierType: "ean13",
      identifierValue: identifier,
      isPrimary: true,
      sourceField: "manual-test",
      sourceRank: 0,
    }] : [],
    prices: [],
  };
  const snapshot = {
    sourceSystem: "manual.loan",
    sourceProfileVersion: "test-v1",
    sourceSchemaSha256: "a".repeat(64),
    sourceFileSha256: "b".repeat(64),
    contentSha256: salesArticleImportContentSha256([article]),
    snapshotAt: "2026-07-29T11:59:00.000Z",
    articles: [article],
  };
  await context.salesArticleCatalog.importSnapshot({
    snapshot,
    actor: "M18",
    timestamp: "2026-07-29T12:00:00.000Z",
  });
  return context.salesArticleCatalog.getByArticleNumber(articleNumber);
}

test("Block 3/7: Leihmodul-Katalog deckt jedes typisierte Statement genau einmal ab", () => {
  const statements = Object.values(LOAN_MODULE_STATEMENTS);
  assert.equal(SQLITE_LOAN_MODULE_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_LOAN_MODULE_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_LOAN_MODULE_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

test("Block 3/7: Artikel, Leihe, Position und Ereignis bleiben providerneutral lesbar", async () => {
  const context = fixture();
  try {
    const centralArticle = await importCentralArticle(
      context,
      "123456",
      "Bohrmaschine",
      "4006381333931",
    );

    const article = await context.repository.getArticle({ articleNumber: "123456" });
    assert.equal(article.description, "Bohrmaschine");
    assert.deepEqual(article.identifiers, [{
      identifier_type: "ean13",
      identifier_value: "4006381333931",
      source_provider: "manual",
      verified_at: article.identifiers[0].verified_at,
    }]);

    await context.transaction(async (repository) => {
      await repository.insertLoan({
        id: "loan-1",
        locationId: "18",
        borrowerEmployeeNumber: "E18",
        createdByEmployeeNumber: "M18",
        dueDate: "2026-08-15",
        notes: "Testleihe",
        issuedAt: "2026-07-29T12:00:00.000Z",
      });
      await repository.insertLoanItem({
        id: "item-1",
        loanId: "loan-1",
        position: 1,
        productId: centralArticle.productId,
        productRevisionSnapshot: centralArticle.currentRevision,
        articleNumber: "123456",
        descriptionSnapshot: "Bohrmaschine",
        serialNumber: "SN-1",
        conditionOut: "neu",
        conditionReturn: "",
        itemNote: "",
        createdAt: "2026-07-29T12:00:00.000Z",
        updatedAt: "2026-07-29T12:00:00.000Z",
      });
      await repository.insertLoanEvent({
        loanId: "loan-1",
        actorEmployeeNumber: "M18",
        eventType: "issued",
        revision: 1,
        payloadJson: "{}",
      });
    });

    const loan = await context.repository.getLoan({ loanId: "loan-1" });
    assert.equal(loan.borrower_employee_number, "E18");
    assert.equal(loan.status, "issued");
    assert.equal((await context.repository.listLoanItems({ loanId: "loan-1" }))[0].id, "item-1");
    assert.equal((await context.repository.listLoanEvents({ loanId: "loan-1" }))[0].event_type, "issued");
  } finally {
    await context.close();
  }
});

test("Block 3/7: Gebundene Leihmodul-Transaktion rollt alle Schreibvorgänge zurück", async () => {
  const context = fixture();
  try {
    const centralArticle = await importCentralArticle(context, "123456", "Bohrmaschine");

    await assert.rejects(
      context.transaction(async (repository) => {
        await repository.insertLoan({
          id: "loan-rollback",
          locationId: "18",
          borrowerEmployeeNumber: "E18",
          createdByEmployeeNumber: "M18",
          dueDate: null,
          notes: "",
          issuedAt: "2026-07-29T12:00:00.000Z",
        });
        await repository.insertLoanItem({
          id: "item-rollback",
          loanId: "loan-rollback",
          position: 1,
          productId: centralArticle.productId,
          productRevisionSnapshot: centralArticle.currentRevision,
          articleNumber: "123456",
          descriptionSnapshot: "Bohrmaschine",
          serialNumber: "",
          conditionOut: "",
          conditionReturn: "",
          itemNote: "",
          createdAt: "2026-07-29T12:00:00.000Z",
          updatedAt: "2026-07-29T12:00:00.000Z",
        });
        throw new Error("rollback");
      }),
      /rollback/,
    );

    assert.equal(await context.repository.getLoan({ loanId: "loan-rollback" }), null);
    assert.deepEqual(
      await context.repository.listLoanItems({ loanId: "loan-rollback" }),
      [],
    );
  } finally {
    await context.close();
  }
});

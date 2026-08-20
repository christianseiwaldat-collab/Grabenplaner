"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/contract");
const {
  createPortalBirthdayPresentationsRepository,
} = require("../lib/persistence/repositories/portal-birthday-presentations");
const {
  SQLITE_PORTAL_BIRTHDAY_PRESENTATION_CATALOG,
} = require("../lib/persistence/sqlite/portal-birthday-presentations");
const {
  ensureSqlitePortalBirthdayPresentationSchema,
  inspectSqlitePortalBirthdayPresentationRows,
} = require("../lib/persistence/sqlite/operations/portal-birthday-presentation-schema");
const {
  createSqlitePersistenceProvider,
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");
const {
  PORTAL_BIRTHDAY_PRESENTATION_STATEMENTS,
} = require("../lib/persistence/statements/portal-birthday-presentations");

function fixture() {
  const database = openSqliteLegacyDatabase(":memory:");
  database.exec(`
    CREATE TABLE employees (
      personnel_number TEXT PRIMARY KEY,
      full_name TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO employees (personnel_number, full_name) VALUES
      ('252', 'Seiwald Christian'),
      ('412', 'Weber Nicolai Sascha');
  `);
  ensureSqlitePortalBirthdayPresentationSchema(database);
  const provider = createSqlitePersistenceProvider({
    database,
    catalog: SQLITE_PORTAL_BIRTHDAY_PRESENTATION_CATALOG,
  });
  return {
    database,
    provider,
    repository: createPortalBirthdayPresentationsRepository(provider),
  };
}

test("Statement- und SQLite-Katalog sind typisiert, vollständig und isoliert", () => {
  assert.deepEqual(Object.keys(PORTAL_BIRTHDAY_PRESENTATION_STATEMENTS).sort(), [
    "getAssignment",
    "getPolicy",
    "insertAssignment",
    "listAssignments",
    "updateAssignment",
    "updatePolicy",
  ]);
  assert.equal(SQLITE_PORTAL_BIRTHDAY_PRESENTATION_CATALOG.length, 6);
  assert.equal(new Set(SQLITE_PORTAL_BIRTHDAY_PRESENTATION_CATALOG
    .map(({ statement }) => statement.id)).size, 6);
  assert.equal(Object.isFrozen(SQLITE_PORTAL_BIRTHDAY_PRESENTATION_CATALOG), true);
});

test("Repository liest und aktualisiert Policy optimistisch revisionsgebunden", async () => {
  const { database, provider, repository } = fixture();
  try {
    const initial = await repository.getPolicy();
    assert.equal(initial.enabled, false);
    assert.equal(initial.revision, 1);
    assert.match(initial.updatedAt, /\.\d{3}Z$/);

    const changed = await repository.updatePolicy({
      enabled: true,
      expectedRevision: 1,
      updatedAt: "2026-08-20T11:00:00.000Z",
    });
    assert.equal(changed.rowsAffected, 1);
    assert.deepEqual(changed.returnedRows, [{
      enabled: true,
      revision: 2,
      updatedAt: "2026-08-20T11:00:00.000Z",
    }]);

    const stale = await repository.updatePolicy({
      enabled: false,
      expectedRevision: 1,
      updatedAt: "2026-08-20T11:01:00.000Z",
    });
    assert.deepEqual(stale, { rowsAffected: 0, returnedRows: [] });
    assert.equal((await repository.getPolicy()).revision, 2);
    assert.equal(inspectSqlitePortalBirthdayPresentationRows(database).valid, true);
  } finally {
    await provider.close();
    database.close();
  }
});

test("Repository persistiert ausschließlich standard/off und schützt Revisionen", async () => {
  const { database, provider, repository } = fixture();
  try {
    assert.equal(repository.deleteAssignment, undefined);
    assert.equal(await repository.getAssignment("252"), null);

    const inserted = await repository.insertAssignment({
      employeeNumber: "252",
      presentationId: "standard",
      updatedAt: "2026-08-20T12:00:00.000Z",
    });
    assert.equal(inserted.rowsAffected, 1);
    assert.deepEqual(inserted.returnedRows[0], {
      employeeNumber: "252",
      presentationId: "standard",
      revision: 1,
      createdAt: "2026-08-20T12:00:00.000Z",
      updatedAt: "2026-08-20T12:00:00.000Z",
    });

    const changed = await repository.updateAssignment({
      employeeNumber: "252",
      presentationId: null,
      expectedRevision: 1,
      updatedAt: "2026-08-20T12:01:00.000Z",
    });
    assert.equal(changed.rowsAffected, 1);
    assert.equal(changed.returnedRows[0].presentationId, "off");
    assert.equal(changed.returnedRows[0].revision, 2);

    const stale = await repository.updateAssignment({
      employeeNumber: "252",
      presentationId: "standard",
      expectedRevision: 1,
      updatedAt: "2026-08-20T12:02:00.000Z",
    });
    assert.equal(stale.rowsAffected, 0);
    assert.deepEqual((await repository.listAssignments()).map((row) => row.employeeNumber), [
      "252",
    ]);
    assert.equal((await repository.getAssignment("252")).presentationId, "off");
    assert.equal(inspectSqlitePortalBirthdayPresentationRows(database).valid, true);
  } finally {
    await provider.close();
    database.close();
  }
});

test("Repository validiert Eingaben strikt und rollt Transaktionen zurück", async () => {
  const { database, provider, repository } = fixture();
  try {
    assert.throws(() => repository.getAssignment(" 252"), (error) => (
      error.code === PERSISTENCE_ERROR_CODES.STATEMENT_INVALID
    ));
    assert.throws(() => repository.insertAssignment({
      employeeNumber: "252",
      presentationId: "confetti",
      updatedAt: "2026-08-20T12:00:00.000Z",
    }), (error) => error.code === PERSISTENCE_ERROR_CODES.STATEMENT_INVALID);
    assert.throws(() => repository.updatePolicy({
      enabled: true,
      expectedRevision: 1,
      updatedAt: "2026-08-20 12:00:00",
    }), (error) => error.code === PERSISTENCE_ERROR_CODES.STATEMENT_INVALID);
    assert.throws(() => repository.updatePolicy({
      enabled: true,
      expectedRevision: 1,
      updatedAt: "2026-08-20T12:00:00.000Z",
      employeeNumber: "252",
    }), (error) => error.code === PERSISTENCE_ERROR_CODES.STATEMENT_INVALID);

    await assert.rejects(repository.transaction(async (transactionRepository) => {
      await transactionRepository.insertAssignment({
        employeeNumber: "412",
        presentationId: "standard",
        updatedAt: "2026-08-20T13:00:00.000Z",
      });
      throw new Error("rollback-test");
    }, { isolation: "serializable" }), /rollback-test/);
    assert.equal(await repository.getAssignment("412"), null);
  } finally {
    await provider.close();
    database.close();
  }
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

function schemaSnapshot(database) {
  return database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
}

test("Block 3/7: SQLite-Anwendungsschema wird neu aufgebaut und idempotent erhalten", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    ensureSqliteApplicationSchema(database);

    const firstSnapshot = schemaSnapshot(database);
    const objects = new Map(firstSnapshot.map((entry) => [entry.name, entry.type]));

    assert.equal(objects.get("cost_centers"), "table");
    assert.equal(objects.get("employees"), "table");
    assert.equal(objects.get("shifts"), "table");
    assert.equal(objects.get("settings"), "table");
    assert.equal(objects.get("work_rule_profiles"), "table");
    assert.equal(objects.get("idx_shifts_date"), "index");
    assert.equal(objects.get("trg_loan_documents_immutable_update"), "trigger");
    assert.equal(objects.has("system_center_trust_metrics"), false);

    database.prepare(`
      INSERT INTO cost_center_types
        (id, code, name, is_branch, active, builtin, sort_order)
      VALUES (?, ?, ?, 1, 1, 0, 10)
    `).run("branch-test", "BRANCH-TEST", "Testfiliale");

    ensureSqliteApplicationSchema(database);

    assert.deepEqual(schemaSnapshot(database), firstSnapshot);
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT id, code, name
          FROM cost_center_types
          WHERE id = ?
        `).get("branch-test"),
      },
      {
        id: "branch-test",
        code: "BRANCH-TEST",
        name: "Testfiliale",
      },
    );
    assert.equal(
      database.prepare("PRAGMA quick_check").get().quick_check,
      "ok",
    );
  } finally {
    database.close();
  }
});

test("Block 3/7: SQLite-Anwendungsschema lehnt ungueltige Operationsdatenbanken ab", () => {
  assert.throws(
    () => ensureSqliteApplicationSchema({}),
    /SQLite-Operationsdatenbank/,
  );
});

test("SQLite-Anwendungsschema reserviert den lokalen Systemprinzipal case-insensitiv", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    ensureSqliteApplicationSchema(database);

    const insertEmployee = database.prepare(`
      INSERT INTO employees (personnel_number, full_name, nickname)
      VALUES (?, ?, ?)
    `);
    assert.throws(
      () => insertEmployee.run(" LoCaL ", "Unzulaessiger Benutzer", "Unzulaessig"),
      /employee principal local is reserved/,
    );
    assert.throws(
      () => insertEmployee.run("\tLoCaL\r\n", "Unzulaessiger Benutzer", "Unzulaessig"),
      /employee principal local is reserved/,
    );

    insertEmployee.run("E-LOCAL", "Gueltiger Benutzer", "Gueltig");
    assert.throws(
      () => database.prepare(`
        UPDATE employees SET personnel_number = ? WHERE personnel_number = ?
      `).run("LOCAL", "E-LOCAL"),
      /employee principal local is reserved/,
    );

    assert.deepEqual(
      database.prepare("SELECT personnel_number FROM employees ORDER BY personnel_number").all()
        .map((row) => ({ ...row })),
      [{ personnel_number: "E-LOCAL" }],
    );
  } finally {
    database.close();
  }
});

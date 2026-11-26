"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createAbsenceManagementRepository,
} = require("../lib/persistence/repositories/absence-management");
const {
  SQLITE_ABSENCE_MANAGEMENT_CATALOG,
} = require("../lib/persistence/sqlite/absence-management-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  ABSENCE_MANAGEMENT_STATEMENTS,
} = require("../lib/persistence/statements/absence-management");

function flattenedStatements(value, result = []) {
  for (const entry of Object.values(value)) {
    if (entry && typeof entry === "object" && typeof entry.id === "string") {
      result.push(entry);
    } else if (entry && typeof entry === "object") {
      flattenedStatements(entry, result);
    }
  }
  return result;
}


test("Block 3/7: Abwesenheitskatalog deckt jedes typisierte Statement genau einmal ab", () => {
  const statements = flattenedStatements(ABSENCE_MANAGEMENT_STATEMENTS);
  assert.equal(SQLITE_ABSENCE_MANAGEMENT_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_ABSENCE_MANAGEMENT_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_ABSENCE_MANAGEMENT_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

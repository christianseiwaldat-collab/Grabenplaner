"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createIntegrationRuntimeRepository,
} = require("../lib/persistence/repositories/integration-runtime");
const {
  SQLITE_INTEGRATION_RUNTIME_CATALOG,
} = require("../lib/persistence/sqlite/integration-runtime-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  INTEGRATION_RUNTIME_STATEMENTS,
} = require("../lib/persistence/statements/integration-runtime");


test("Block 3/7: Integrationskatalog deckt jedes typisierte Statement genau einmal ab", () => {
  const statements = Object.values(INTEGRATION_RUNTIME_STATEMENTS);
  assert.equal(SQLITE_INTEGRATION_RUNTIME_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_INTEGRATION_RUNTIME_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_INTEGRATION_RUNTIME_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

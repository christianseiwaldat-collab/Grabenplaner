"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const catalog = require("../lib/persistence/postgresql/core/catalog");
const base = require("../lib/persistence/postgresql/contracts/block-4-catalog.json");
const schema = require("../lib/persistence/postgresql/contracts/source-schema-v09237.json");
const extension = require("../lib/persistence/postgresql/contracts/payroll-handoff-department-catalog-v1.json");
const id = "governance-store.insert-payroll-handoff";
const source = catalog.sourceEntries().find(entry => entry.statement.id === id);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

test("the historical payroll handoff department is TEXT with an empty-string sentinel", () => {
  const column = schema.tables.find(table => table.name === "payroll_handoffs").columns.find(column => column.name === "department_id");
  assert.equal(column.type, "TEXT");
  assert.equal(column.notnull, 1);
  assert.equal(column.dflt_value, "''");
  const compiled = catalog.compileCoreEntry(source);
  const binding = compiled.providerEntry.parameterBindings.findIndex(binding => binding.path?.[0] === "departmentId") + 1;
  assert.equal(binding, 4);
  assert.ok(compiled.providerEntry.sql.includes(`( $${binding} :: text )`));
  assert.ok(!compiled.providerEntry.sql.includes(`( $${binding} :: bigint )`));
  assert.ok(compiled.providerEntry.sql.includes("( $5 :: bigint )"), "revision keeps its strict integer conversion");
});

test("only the explicitly qualified handoff query changes and keeps its source and binding contracts", () => {
  assert.equal(extension.entries.length, 1);
  const reviewed = extension.entries[0];
  const previous = base.entries.find(entry => entry.statementId === id);
  const compiled = catalog.compileCoreEntry(source);
  assert.equal(reviewed.statementId, id);
  assert.equal(compiled.provenance.sourceContract, previous.sourceContract);
  assert.equal(reviewed.baseSqlSha256, previous.sqlSha256);
  assert.equal(reviewed.sqlSha256, compiled.provenance.sqlSha256);
  assert.equal(reviewed.parameterBindingsSha256, sha(JSON.stringify(compiled.providerEntry.parameterBindings)));
  assert.equal(reviewed.parameterOrderSha256, sha(JSON.stringify(compiled.providerEntry.parameterOrder)));
  const other = catalog.sourceEntries().find(entry => entry.statement.id === "custom-process-management.insert-onboarding-operation");
  assert.equal(catalog.compileCoreEntry(other).provenance.sqlSha256, base.entries.find(entry => entry.statementId === other.statement.id).sqlSha256);
  assert.equal(catalog.createCoreCatalog().entries.length, 1125);
});

test("a changed department query receipt cannot authorize a different compiled query", () => {
  const compiled = catalog.sourceEntries().map(catalog.compileCoreEntry);
  const original = extension.entries[0].parameterBindingsSha256;
  try {
    extension.entries[0].parameterBindingsSha256 = "f".repeat(64);
    assert.throws(() => catalog.assertCoreCatalogLock(compiled, base), /Core catalog lock drift/);
  } finally { extension.entries[0].parameterBindingsSha256 = original; }
  catalog.assertCoreCatalogLock(compiled, base);
});

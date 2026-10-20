"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { openSqliteLegacyDatabase } = require("../lib/persistence/sqlite/provider");
const { functionSource } = require("../test-support/learning-workspace-ui");
const context = vm.createContext({});
vm.runInContext(functionSource("jsonObject", "../lib/persistence/sqlite/custom-process-management-catalog.js"), context);

for (const count of [63, 64, 126, 127, 190]) {
  test(`bounded onboarding JSON preserves ${count} fields, explicit nulls and nested values`, () => {
    const database = openSqliteLegacyDatabase(":memory:");
    try {
      const fields = {}, expected = {};
      for (let n = 0; n < count; n++) {
        const kind = n % 4, key = `field_${n}`;
        fields[key] = ["NULL", String(n), "'synthetic text'", "json('[1,null,\"value\"]')"][kind];
        expected[key] = [null, n, "synthetic text", [1, null, "value"]][kind];
      }
      const actual = database.prepare("SELECT " + context.jsonObject(fields)).get();
      assert.deepEqual(JSON.parse(actual.data), expected);
    } finally { database.close(); }
  });
}

test("onboarding compatibility retains exact PostgreSQL SQL and rejects unreviewed source or binding changes", () => {
  const catalog = require("../lib/persistence/postgresql/core/catalog");
  const lock = require("../lib/persistence/postgresql/contracts/block-4-catalog.json");
  const extension = require("../lib/persistence/postgresql/contracts/onboarding-json-catalog-v1.json");
  const compiled = catalog.sourceEntries().map(catalog.compileCoreEntry);
  catalog.assertCoreCatalogLock(compiled, lock);
  for (const row of extension.entries) {
    const item = compiled.find(e => e.provenance.statementId === row.statementId);
    assert.equal(item.provenance.sqlSha256, lock.entries.find(e => e.statementId === row.statementId).sqlSha256);
    for (const mutation of ["source", "bindings"]) {
      const changed = structuredClone(compiled), target = changed.find(e => e.provenance.statementId === row.statementId);
      if (mutation === "source") target.provenance.sourceContract = "0".repeat(64);
      else target.providerEntry.parameterBindings.push({ parameter: "unreviewed", source: "value", path: [] });
      assert.throws(() => catalog.assertCoreCatalogLock(changed, lock), /explicit qualification required/);
    }
    assert.equal(row.parameterBindingsSha256,
      crypto.createHash("sha256").update(JSON.stringify(item.providerEntry.parameterBindings)).digest("hex"));
  }
});

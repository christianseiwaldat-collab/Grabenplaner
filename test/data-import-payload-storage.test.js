"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PERSISTENCE_ERROR_CODES: ERROR } = require("../lib/persistence/errors");
const { createDataImportRepository } = require("../lib/persistence/repositories/data-import");
const { DATA_IMPORT_SCHEMA_SQL, SQLITE_DATA_IMPORT_PAYLOAD_GUARDS_SQL, ensureSqliteDataImportSchema } = require("../lib/persistence/sqlite/operations/data-import-schema");
const { DATA_IMPORT_STATEMENTS: S } = require("../lib/persistence/statements/data-import");
const { SQLITE_DATA_IMPORT_CATALOG } = require("../lib/persistence/sqlite/data-import-catalog");
const { compilePostgresqlDialectEntry } = require("../lib/persistence/postgresql/dialect-compiler");
const NOW = "2026-09-06T12:00:00.000Z", HASH = "a".repeat(64);

function block(number = 1, changes = {}) {
  return { id: number.toString(16).padStart(64, "0"), scopeId: "synthetic-scope", ownerId: "synthetic-owner", profileHash: HASH,
    sourceSystem: "synthetic-source", sourceInstance: "synthetic-instance", sourceTable: "SyntheticRows", entity: "synthetic-record",
    blockType: "object", payload: "gp-import-block-v1:synthetic:authenticated-test-envelope", keyId: "synthetic-key",
    nonce: Buffer.alloc(12, number).toString("base64"), createdAt: NOW, ...changes };
}

test("all eight additive payload statements compile portably without opening PostgreSQL acceptance", () => {
  const names = ["getPayloadBlock", "insertPayloadBlock", "getRowPayloadRefs", "getChangePayloadRefs", "deleteRowPayloadRefs",
    "deleteChangePayloadRefs", "insertRowPayloadRef", "insertChangePayloadRef"];
  for (const name of names) {
    const entry = SQLITE_DATA_IMPORT_CATALOG.find(value => value.statement === S[name]);
    assert.ok(entry, name);
    const compiled = compilePostgresqlDialectEntry(entry);
    assert.equal(compiled.strategy, "portable-generated", name);
    assert.doesNotMatch(compiled.compiledSql, /\$[a-z]/i);
  }
  assert.match(SQLITE_DATA_IMPORT_CATALOG.find(value => value.statement === S.insertPayloadBlock).sql, /ON CONFLICT \(id\) DO NOTHING$/);
  assert.equal(Object.keys(S).some(name => /(?:update|delete|purge)PayloadBlock/i.test(name)), false);
});

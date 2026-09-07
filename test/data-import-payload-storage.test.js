"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PERSISTENCE_ERROR_CODES: ERROR } = require("../lib/persistence/errors");
const { openSqliteApplicationPersistence } = require("../lib/persistence/sqlite/provider");
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
async function fixture(t) {
  const app = openSqliteApplicationPersistence({ databasePath: ":memory:", catalog: SQLITE_DATA_IMPORT_CATALOG });
  ensureSqliteDataImportSchema(app.database);
  const repository = createDataImportRepository(app.provider);
  t.after(async () => { await app.provider.close(); app.database.close(); });
  await repository.atomic(async tx => {
    await tx.insertRun({ id: "synthetic-run", scopeId: "synthetic-scope", ownerId: "synthetic-owner", attemptId: "synthetic-attempt",
      profileHash: HASH, profile: { synthetic: true }, manifest: {}, status: "staging", revision: 1, receivedCount: 2,
      createdAt: NOW, updatedAt: NOW, expiresAt: "2026-10-06T12:00:00.000Z" });
    for (const rowNumber of [1, 2]) await tx.insertRow({ runId: "synthetic-run", rowNumber, identityHash: HASH,
      contentHash: HASH, state: "staged", issue: "", payload: "legacy-inline-payload" });
    await tx.insertChange({ runId: "synthetic-run", rowNumber: 1, identityHash: HASH, payload: "legacy-change-payload", revertedAt: null });
  });
  return { ...app, repository, ref: { runId: "synthetic-run", rowNumber: 1, slot: "record.data", blockId: block().id } };
}

test("payload storage schema is additive, idempotent and preserves existing inline import rows", async t => {
  const f = await fixture(t);
  const original = f.database.prepare("SELECT * FROM data_import_rows ORDER BY row_number").all();
  ensureSqliteDataImportSchema(f.database);
  assert.deepEqual(f.database.prepare("SELECT * FROM data_import_rows ORDER BY row_number").all(), original);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM data_import_payload_blocks").get().n, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM data_import_row_payload_refs").get().n, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM data_import_change_payload_refs").get().n, 0);
  assert.doesNotMatch(DATA_IMPORT_SCHEMA_SQL, /AUTOINCREMENT|rowid|json_extract|GLOB|PRAGMA|COLLATE NOCASE|CREATE TRIGGER/i);
  assert.match(SQLITE_DATA_IMPORT_PAYLOAD_GUARDS_SQL, /BEFORE UPDATE ON data_import_payload_blocks/);
  assert.match(SQLITE_DATA_IMPORT_PAYLOAD_GUARDS_SQL, /BEFORE DELETE ON data_import_payload_blocks/);
});

test("payload blocks return exact camelCase fields and distinguish ID reuse from nonce collisions", async t => {
  const f = await fixture(t), first = block();
  await f.repository.atomic(async tx => {
    assert.equal((await tx.insertPayloadBlock(first)).rowsAffected, 1);
    assert.deepEqual(await tx.getPayloadBlock({ id: first.id }), first);
    assert.equal((await tx.insertPayloadBlock({ ...first, payload: "must-not-replace-existing-ciphertext" })).rowsAffected, 0);
    assert.deepEqual(await tx.getPayloadBlock({ id: first.id }), first);
  });
  await assert.rejects(f.repository.atomic(tx => tx.insertPayloadBlock(block(2, { nonce: first.nonce }))), { code: ERROR.UNIQUE_VIOLATION });
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM data_import_payload_blocks").get().n, 1);
  assert.throws(() => f.database.prepare("UPDATE data_import_payload_blocks SET payload='changed' WHERE id=?").run(first.id), /IMMUTABLE/);
  assert.throws(() => f.database.prepare("DELETE FROM data_import_payload_blocks WHERE id=?").run(first.id), /IMMUTABLE/);
  for (const parameters of [block(3, { id: "short" }), block(3, { profileHash: "short" }), block(3, { nonce: "short" }),
    block(3, { blockType: "unexpected" }), block(3, { keyId: "" }), block(3, { createdAt: "2026-09-06" }),
    block(3, { payload: "" }), block(3, { payload: "x".repeat(2359297) })]) {
    await assert.rejects(f.repository.atomic(tx => tx.insertPayloadBlock(parameters)));
  }
});

test("payload row and change refs enforce composite parent FKs, slots, uniqueness and sorted minimal results", async t => {
  const f = await fixture(t);
  await f.repository.atomic(async tx => {
    await tx.insertPayloadBlock(block());
    for (const slot of ["record.source", "record.data", "beforeTarget.data", "afterTarget.data", "beforeLink.payload", "patch"]) {
      await tx.insertRowPayloadRef({ ...f.ref, slot });
      await tx.insertChangePayloadRef({ ...f.ref, slot });
    }
    const expected = ["afterTarget.data", "beforeLink.payload", "beforeTarget.data", "patch", "record.data", "record.source"]
      .map(slot => ({ slot, blockId: f.ref.blockId }));
    assert.deepEqual(await tx.getRowPayloadRefs({ runId: f.ref.runId, rowNumber: 1 }), expected);
    assert.deepEqual(await tx.getChangePayloadRefs({ runId: f.ref.runId, rowNumber: 1 }), expected);
  });
  for (const method of ["insertRowPayloadRef", "insertChangePayloadRef"]) {
    for (const [invalid, code] of [[{ ...f.ref }, ERROR.UNIQUE_VIOLATION], [{ ...f.ref, slot: "unknown" }, ERROR.CHECK_VIOLATION],
      [{ ...f.ref, blockId: "f".repeat(64) }, ERROR.FOREIGN_KEY_VIOLATION], [{ ...f.ref, runId: "missing" }, ERROR.FOREIGN_KEY_VIOLATION],
      [{ ...f.ref, rowNumber: 0 }, ERROR.CHECK_VIOLATION], [{ ...f.ref, rowNumber: 3 }, ERROR.FOREIGN_KEY_VIOLATION]]) {
      await assert.rejects(f.repository.atomic(async tx => {
        // Remove the occupied primary key inside this rolled-back transaction
        // so a missing block is checked independently of ref uniqueness.
        if (invalid.blockId !== f.ref.blockId) {
          const remove = method === "insertRowPayloadRef" ? "deleteRowPayloadRefs" : "deleteChangePayloadRefs";
          await tx[remove]({ runId: f.ref.runId, rowNumber: 1 });
        }
        return tx[method](invalid);
      }), { code });
    }
  }
  await assert.rejects(f.repository.atomic(tx => tx.insertChangePayloadRef({ ...f.ref, rowNumber: 2 })), { code: ERROR.FOREIGN_KEY_VIOLATION });
  assert.throws(() => f.database.prepare("DELETE FROM data_import_changes WHERE run_id=? AND row_number=1").run(f.ref.runId), /FOREIGN KEY/);
  assert.throws(() => f.database.prepare("DELETE FROM data_import_rows WHERE run_id=? AND row_number=1").run(f.ref.runId), /FOREIGN KEY/);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("failed row/block/ref writes roll back atomically and ref cleanup never deletes immutable blocks", async t => {
  const f = await fixture(t), second = block(2);
  await assert.rejects(f.repository.atomic(async tx => {
    await tx.insertPayloadBlock(second);
    await tx.insertRowPayloadRef({ ...f.ref, blockId: second.id });
    await tx.insertChangePayloadRef({ ...f.ref, blockId: second.id });
    await tx.updateRow({ runId: f.ref.runId, rowNumber: 1, state: "staged", issue: "", payload: "new-envelope" });
    throw new Error("SYNTHETIC_ROLLBACK");
  }), /SYNTHETIC_ROLLBACK/);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM data_import_payload_blocks").get().n, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM data_import_row_payload_refs").get().n, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM data_import_change_payload_refs").get().n, 0);
  assert.equal(f.database.prepare("SELECT payload FROM data_import_rows WHERE row_number=1").get().payload, "legacy-inline-payload");
  await f.repository.atomic(async tx => {
    await tx.insertPayloadBlock(block());
    await tx.insertRowPayloadRef(f.ref);
    await tx.insertRowPayloadRef({ ...f.ref, rowNumber: 2 });
    await tx.insertChangePayloadRef(f.ref);
    assert.equal((await tx.deleteRowPayloadRefs({ runId: f.ref.runId, rowNumber: 1 })).rowsAffected, 1);
    assert.equal((await tx.deleteChangePayloadRefs({ runId: f.ref.runId, rowNumber: 1 })).rowsAffected, 1);
    assert.deepEqual(await tx.getRowPayloadRefs({ runId: f.ref.runId, rowNumber: 2 }), [{ slot: "record.data", blockId: f.ref.blockId }]);
    assert.deepEqual(await tx.getPayloadBlock({ id: f.ref.blockId }), block());
  });
});

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

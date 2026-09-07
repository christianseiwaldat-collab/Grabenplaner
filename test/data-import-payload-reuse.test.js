"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const C = require("../lib/data-import-contract");
const { createDataImportProtection } = require("../lib/data-import-protection");
const { createDataImportEngine } = require("../lib/data-import-engine");
const { createDataImportRepository } = require("../lib/persistence/repositories/data-import");
const { definePersistenceStatement } = require("../lib/persistence/contract");
const { openSqliteApplicationPersistence } = require("../lib/persistence/sqlite/provider");
const { SQLITE_DATA_IMPORT_CATALOG } = require("../lib/persistence/sqlite/data-import-catalog");
const { ensureSqliteDataImportSchema } = require("../lib/persistence/sqlite/operations/data-import-schema");
const { createSqliteMaintenanceOperations } = require("../lib/persistence/sqlite/operations/maintenance");

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const AT_A = "2026-09-05T10:00:00.000Z";
const AT_B = "2026-09-06T10:00:00.000Z";
const errorCode = (...codes) => error => codes.includes(error?.code);

const customerProfile = C.defineDataImportProfile({
  id: "synthetic-customer-payload-reuse",
  version: 1,
  entity: "synthetic-customer-payload-reuse",
  sourceSystem: "synthetic-crm",
  sourceTable: "KUNDEN",
  schemaSha256: SHA_C,
  keyFields: ["CustomerNumber"],
  excludedFields: ["Password"],
  dataClasses: ["customer_restricted"],
  fields: [
    { source: "CustomerNumber", target: "number", type: "identifier", nullable: false },
    { source: "Name", target: "name", type: "text", nullable: false },
    { source: "Note", target: "note", type: "text", nullable: false },
    { source: "PrivateMemo", target: null, type: "text", nullable: true },
  ],
});

// TradeFoto tables without a business key use these two source coordinates as
// their key. The shared codec may remove them from reusable leaves only if one
// authenticated root overlay restores key, source and data consistently.
const keylessProfile = C.defineDataImportProfile({
  id: "synthetic-keyless-payload-reuse",
  version: 1,
  entity: "synthetic-keyless-payload-reuse",
  sourceSystem: "synthetic-crm",
  sourceTable: "KEYLESS_DAILY",
  schemaSha256: SHA_C,
  keyFields: ["_source_snapshot_sha256", "_source_row"],
  excludedFields: [],
  dataClasses: ["customer_restricted"],
  fields: [
    { source: "Kind", target: "kind", type: "text", nullable: false },
    { source: "Note", target: "note", type: "text", nullable: false },
    { source: "_source_snapshot_sha256", target: "snapshot", type: "identifier", nullable: false },
    { source: "_source_row", target: "ordinal", type: "integer", nullable: false },
  ],
});

const TARGET_COLUMNS = Object.freeze({ id: "text", revision: "safe_integer", data: "json" });
const TARGET = Object.freeze({
  read: definePersistenceStatement({ id: "payload-reuse-fixture.read", operation: "queryOne", parameters: { id: "text" }, columns: TARGET_COLUMNS }),
  find: definePersistenceStatement({ id: "payload-reuse-fixture.find", operation: "queryAll", parameters: { entity: "text", naturalKey: "text" }, columns: TARGET_COLUMNS }),
  create: definePersistenceStatement({ id: "payload-reuse-fixture.create", operation: "execute", parameters: { id: "text", entity: "text", naturalKey: "text", data: "json" } }),
  update: definePersistenceStatement({ id: "payload-reuse-fixture.update", operation: "execute", parameters: { id: "text", expectedRevision: "safe_integer", data: "json" } }),
  remove: definePersistenceStatement({ id: "payload-reuse-fixture.remove", operation: "execute", parameters: { id: "text", expectedRevision: "safe_integer" } }),
  dependencies: definePersistenceStatement({ id: "payload-reuse-fixture.dependencies", operation: "queryOne", parameters: { id: "text" }, columns: { count: "safe_integer" } }),
});
const TARGET_CATALOG = Object.freeze([
  { statement: TARGET.read, sql: "SELECT id,revision,data FROM payload_reuse_targets WHERE id=$id", returning: false },
  { statement: TARGET.find, sql: "SELECT id,revision,data FROM payload_reuse_targets WHERE entity=$entity AND natural_key=$naturalKey", returning: false },
  { statement: TARGET.create, sql: "INSERT INTO payload_reuse_targets(id,entity,natural_key,revision,data) VALUES($id,$entity,$naturalKey,1,$data)", returning: false },
  { statement: TARGET.update, sql: "UPDATE payload_reuse_targets SET data=$data,revision=revision+1 WHERE id=$id AND revision=$expectedRevision", returning: false },
  { statement: TARGET.remove, sql: "DELETE FROM payload_reuse_targets WHERE id=$id AND revision=$expectedRevision", returning: false },
  { statement: TARGET.dependencies, sql: "SELECT COUNT(*) AS count FROM payload_reuse_dependencies WHERE target_id=$id", returning: false },
]);

function naturalKey(entity, data) {
  return entity === customerProfile.entity ? data.number : `${data.snapshot}:${data.ordinal}`;
}

async function fixture({ databasePath = ":memory:", sharedPayloads = false, encryptionByte = 7, failOnNumber = null } = {}) {
  const application = openSqliteApplicationPersistence({ databasePath, catalog: [...SQLITE_DATA_IMPORT_CATALOG, ...TARGET_CATALOG] });
  ensureSqliteDataImportSchema(application.database);
  application.database.exec(`
    CREATE TABLE IF NOT EXISTS payload_reuse_targets (
      id TEXT PRIMARY KEY, entity TEXT NOT NULL, natural_key TEXT NOT NULL,
      revision INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(entity,natural_key)
    );
    CREATE TABLE IF NOT EXISTS payload_reuse_dependencies (
      target_id TEXT NOT NULL REFERENCES payload_reuse_targets(id)
    );
  `);
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, encryptionByte), indexKey: Buffer.alloc(32, 9), keyId: "payload-reuse-test-key" });
  const context = { who: { scopeId: "payload-reuse-scope", ownerId: "payload-reuse-owner" }, denied: new Set(), time: AT_A };
  const read = (tx, id) => tx.queryOne(TARGET.read, { id });
  const writer = entity => ({
    read,
    findExisting: (tx, record) => tx.queryAll(TARGET.find, { entity, naturalKey: naturalKey(entity, record.data) }),
    async create(tx, { id, data }) {
      await tx.execute(TARGET.create, { id, entity, naturalKey: naturalKey(entity, data), data });
      if (data.number === failOnNumber) throw new Error("Injected payload reuse transaction failure");
      return read(tx, id);
    },
    async update(tx, parameters) {
      assert.equal((await tx.execute(TARGET.update, parameters)).rowsAffected, 1);
      return read(tx, parameters.id);
    },
    restore(tx, parameters) { return this.update(tx, parameters); },
    async canRestore(tx, current) { return (await tx.queryOne(TARGET.dependencies, { id: current.id })).count === 0; },
    async canRemove(tx, id) { return (await tx.queryOne(TARGET.dependencies, { id })).count === 0; },
    async remove(tx, parameters) { return (await tx.execute(TARGET.remove, parameters)).rowsAffected === 1; },
  });
  const repository = createDataImportRepository(application.provider);
  const composition = {
    repository,
    protection,
    profiles: [customerProfile, keylessProfile],
    writers: {
      [customerProfile.entity]: writer(customerProfile.entity),
      [keylessProfile.entity]: writer(keylessProfile.entity),
    },
    sharedPayloads,
    getActor: () => context.who,
    authorize: ({ action }) => !context.denied.has(action),
    clock: () => context.time,
  };
  const engine = createDataImportEngine(composition);
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    protection.destroy();
    await application.provider.close();
    application.database.close();
  }
  return { ...application, protection, repository, composition, engine, context, close };
}

function manifest(profile, rows, fileSha256, snapshotAt) {
  return { sourceInstance: "synthetic-crm-main", fileSha256, schemaSha256: profile.schemaSha256,
    expectedRows: rows.length, declaredRows: rows.length, snapshotAt, gates: [] };
}

async function ready(f, profile, rows, { fileSha256 = SHA_A, snapshotAt = AT_A, attemptId = "default" } = {}) {
  let run = await f.engine.start({ profileHash: profile.fingerprint, manifest: manifest(profile, rows, fileSha256, snapshotAt), attemptId });
  for (let offset = 0; offset < rows.length; offset += C.LIMITS.batch) {
    run = await f.engine.stage(run.id, { expectedRevision: run.revision, startRow: offset + 1, rows: rows.slice(offset, offset + C.LIMITS.batch) });
  }
  run = await f.engine.seal(run.id, run.revision);
  do { run = await f.engine.review(run.id, run.revision); } while (run.status === "reviewing");
  return run;
}

async function applyAll(f, run) {
  do { run = await f.engine.apply(run.id, run.revision); } while (run.status === "applying");
  return run;
}

async function undoAll(f, run) {
  do { run = await f.engine.undo(run.id, run.revision); } while (run.status === "reverting");
  return run;
}

function customerRows(changed = false) {
  return Array.from({ length: 128 }, (_, index) => {
    const number = String(index + 1).padStart(6, "0");
    const stable = `Kundenhinweis ${number}: ` + (`synthetic-${number}-`.repeat(270));
    return { CustomerNumber: number, Name: `Synthetischer Kunde ${number}`,
      Note: changed && index === 127 ? stable + " fachlich geändert" : stable,
      PrivateMemo: index % 2 ? null : `Nur Prüfdaten ${number}`, Password: "never-store-this" };
  });
}

function smallCustomerRows(noteBytes, changed = false) {
  return Array.from({ length: 2 }, (_, index) => {
    const number = String(index + 1).padStart(6, "0");
    const prefix = `Kundenhinweis ${number}: `;
    let note = prefix + "x".repeat(noteBytes - Buffer.byteLength(prefix));
    if (changed && index === 1) note = note.slice(0, -1) + "y";
    assert.equal(Buffer.byteLength(note), noteBytes);
    return { CustomerNumber: number, Name: `Synthetischer Kunde ${number}`, Note: note,
      PrivateMemo: null, Password: "never-store-this" };
  });
}

function keylessRows(fileSha256) {
  return Array.from({ length: 8 }, (_, index) => ({
    Kind: "daily-note",
    Note: `Keyless ${index + 1}: ` + (`same-business-payload-${index + 1}-`.repeat(80)),
    _source_snapshot_sha256: fileSha256,
    _source_row: index + 1,
  }));
}

function refs(database, table, runId, rowNumber) {
  return Object.fromEntries(database.prepare(`SELECT slot,block_id FROM ${table} WHERE run_id=? AND row_number=? ORDER BY slot`).all(runId, rowNumber)
    .map(row => [row.slot, row.block_id]));
}

function storageMeasure(database) {
  database.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'data_import_%' ORDER BY name").all().map(row => row.name);
  let importTableBytes = 0;
  for (const table of tables) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
    const expression = columns.map(column => `COALESCE(length(CAST(\"${column.replaceAll('"', '""')}\" AS BLOB)),0)`).join("+") || "0";
    importTableBytes += database.prepare(`SELECT COALESCE(SUM(${expression}),0) AS bytes FROM \"${table.replaceAll('"', '""')}\"`).get().bytes;
  }
  const pageCount = database.prepare("PRAGMA page_count").get().page_count;
  const pageSize = database.prepare("PRAGMA page_size").get().page_size;
  return { importTableBytes, databasePageBytes: pageCount * pageSize, tables };
}

async function exerciseStorage(f) {
  const firstCustomers = await applyAll(f, await ready(f, customerProfile, customerRows(false), { fileSha256: SHA_A, snapshotAt: AT_A }));
  const secondCustomersReady = await ready(f, customerProfile, customerRows(true), { fileSha256: SHA_B, snapshotAt: AT_B });
  assert.equal(secondCustomersReady.counts.unchanged, 127);
  assert.equal(secondCustomersReady.counts.update, 1);
  const secondCustomers = await applyAll(f, secondCustomersReady);

  const firstKeyless = await applyAll(f, await ready(f, keylessProfile, keylessRows(SHA_A), { fileSha256: SHA_A, snapshotAt: AT_A }));
  const secondKeyless = await applyAll(f, await ready(f, keylessProfile, keylessRows(SHA_B), { fileSha256: SHA_B, snapshotAt: AT_B }));
  assert.notEqual(firstCustomers.id, secondCustomers.id);
  assert.notEqual(firstKeyless.id, secondKeyless.id);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM payload_reuse_targets").get().count, 144);
  return { firstCustomers, secondCustomers, firstKeyless, secondKeyless };
}

test("shared payloads retain all run/snapshot identities and use less storage without deletion credit", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-payload-reuse-size-"));
  const legacyPath = path.join(directory, "legacy.sqlite");
  const sharedPath = path.join(directory, "shared.sqlite");
  const legacy = await fixture({ databasePath: legacyPath });
  const shared = await fixture({ databasePath: sharedPath, sharedPayloads: true });
  t.after(async () => {
    await legacy.close(); await shared.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await exerciseStorage(legacy);
  const runs = await exerciseStorage(shared);

  const firstCustomerRefs = refs(shared.database, "data_import_row_payload_refs", runs.firstCustomers.id, 1);
  const unchangedCustomerRefs = refs(shared.database, "data_import_row_payload_refs", runs.secondCustomers.id, 1);
  assert.equal(firstCustomerRefs["record.source"], unchangedCustomerRefs["record.source"]);
  assert.equal(firstCustomerRefs["record.data"], unchangedCustomerRefs["record.data"]);

  const originalChangedCustomerRefs = refs(shared.database, "data_import_row_payload_refs", runs.firstCustomers.id, 128);
  const changedCustomerRefs = refs(shared.database, "data_import_row_payload_refs", runs.secondCustomers.id, 128);
  assert.notEqual(originalChangedCustomerRefs["record.data"], changedCustomerRefs["record.data"]);
  const firstKeylessRefs = refs(shared.database, "data_import_row_payload_refs", runs.firstKeyless.id, 1);
  const secondKeylessRefs = refs(shared.database, "data_import_row_payload_refs", runs.secondKeyless.id, 1);
  assert.equal(firstKeylessRefs["record.source"], secondKeylessRefs["record.source"]);
  assert.equal(firstKeylessRefs["record.data"], secondKeylessRefs["record.data"]);

  const firstKeylessDetail = await shared.engine.detail(runs.firstKeyless.id, 1);
  const secondKeylessDetail = await shared.engine.detail(runs.secondKeyless.id, 1);
  assert.equal(firstKeylessDetail.source._source_snapshot_sha256, SHA_A);
  assert.equal(secondKeylessDetail.source._source_snapshot_sha256, SHA_B);
  assert.equal(firstKeylessDetail.proposed.snapshot, SHA_A);
  assert.equal(secondKeylessDetail.proposed.snapshot, SHA_B);
  assert.equal(firstKeylessDetail.proposed.ordinal, secondKeylessDetail.proposed.ordinal);

  const retainedBlocks = shared.database.prepare("SELECT COUNT(*) AS count FROM data_import_payload_blocks").get().count;
  const retainedRefs = shared.database.prepare("SELECT (SELECT COUNT(*) FROM data_import_row_payload_refs)+(SELECT COUNT(*) FROM data_import_change_payload_refs) AS count").get().count;
  assert.ok(retainedBlocks > 0);
  assert.ok(retainedRefs > 0);
  await assert.rejects(shared.engine.purge(runs.firstCustomers.id, runs.firstCustomers.revision), errorCode("IMPORT_PURGE_DISABLED"));
  assert.equal(shared.database.prepare("SELECT COUNT(*) AS count FROM data_import_payload_blocks").get().count, retainedBlocks);
  assert.equal(shared.database.prepare("SELECT (SELECT COUNT(*) FROM data_import_row_payload_refs)+(SELECT COUNT(*) FROM data_import_change_payload_refs) AS count").get().count, retainedRefs);

  const legacySize = storageMeasure(legacy.database);
  const sharedSize = storageMeasure(shared.database);
  assert.ok(sharedSize.importTableBytes < legacySize.importTableBytes,
    `shared SQL bytes ${sharedSize.importTableBytes} must be below legacy ${legacySize.importTableBytes}`);
  assert.ok(sharedSize.databasePageBytes < legacySize.databasePageBytes,
    `shared pages ${sharedSize.databasePageBytes} must be below legacy ${legacySize.databasePageBytes}`);
  t.diagnostic(JSON.stringify({ legacy: legacySize, shared: sharedSize, retainedBlocks, retainedRefs }));
});

test("small two-run payloads never inflate storage or create shared block overhead", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-payload-reuse-small-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const noteBytes of [100, 300, 600]) {
    const legacy = await fixture({ databasePath: path.join(directory, `legacy-${noteBytes}.sqlite`) });
    const shared = await fixture({ databasePath: path.join(directory, `shared-${noteBytes}.sqlite`), sharedPayloads: true });
    try {
      for (const f of [legacy, shared]) {
        await applyAll(f, await ready(f, customerProfile, smallCustomerRows(noteBytes), { fileSha256: SHA_A, snapshotAt: AT_A }));
        const next = await ready(f, customerProfile, smallCustomerRows(noteBytes, true), { fileSha256: SHA_B, snapshotAt: AT_B });
        assert.equal(next.counts.unchanged, 1);
        assert.equal(next.counts.update, 1);
        await applyAll(f, next);
      }
      const retained = {
        blocks: shared.database.prepare("SELECT COUNT(*) AS count FROM data_import_payload_blocks").get().count,
        rowRefs: shared.database.prepare("SELECT COUNT(*) AS count FROM data_import_row_payload_refs").get().count,
        changeRefs: shared.database.prepare("SELECT COUNT(*) AS count FROM data_import_change_payload_refs").get().count,
      };
      assert.deepEqual(retained, { blocks: 0, rowRefs: 0, changeRefs: 0 });
      const legacySize = storageMeasure(legacy.database);
      const sharedSize = storageMeasure(shared.database);
      assert.ok(sharedSize.importTableBytes <= legacySize.importTableBytes,
        `${noteBytes} B shared SQL bytes ${sharedSize.importTableBytes} must not exceed legacy ${legacySize.importTableBytes}`);
      t.diagnostic(JSON.stringify({ noteBytes, legacy: legacySize, shared: sharedSize, retained }));
    } finally {
      await legacy.close(); await shared.close();
    }
  }
});

test("shared roots and references fail closed on swaps, missing blocks, extra refs and row metadata tampering", async t => {
  async function prepared() {
    const f = await fixture({ sharedPayloads: true });
    const run = await ready(f, customerProfile, customerRows(false).slice(0, 2));
    return { f, run };
  }

  await t.test("typed block reference swap", async () => {
    const { f, run } = await prepared();
    try {
      const one = refs(f.database, "data_import_row_payload_refs", run.id, 1);
      const two = refs(f.database, "data_import_row_payload_refs", run.id, 2);
      assert.notEqual(one["record.data"], two["record.data"]);
      f.database.prepare("UPDATE data_import_row_payload_refs SET block_id=? WHERE run_id=? AND row_number=1 AND slot='record.data'").run(two["record.data"], run.id);
      await assert.rejects(f.engine.detail(run.id, 1), errorCode("IMPORT_EVIDENCE_REFS_MISMATCH"));
    } finally { await f.close(); }
  });

  await t.test("missing block is checked only after authorization", async () => {
    const { f, run } = await prepared();
    try {
      f.database.exec("PRAGMA foreign_keys=OFF");
      f.database.prepare("UPDATE data_import_row_payload_refs SET block_id=? WHERE run_id=? AND row_number=1 AND slot='record.data'").run("f".repeat(64), run.id);
      f.database.exec("PRAGMA foreign_keys=ON");
      f.context.denied.add("read");
      await assert.rejects(f.engine.detail(run.id, 1), errorCode("IMPORT_FORBIDDEN"));
      f.context.denied.clear();
      await assert.rejects(f.engine.detail(run.id, 1), errorCode("IMPORT_EVIDENCE_REFS_MISMATCH", "IMPORT_EVIDENCE_BLOCK_MISSING"));
    } finally { await f.close(); }
  });

  await t.test("unexpected extra typed ref", async () => {
      const { f, run } = await prepared();
    try {
      const rowRefs = refs(f.database, "data_import_row_payload_refs", run.id, 1);
      const unusedSlot = ["record.source", "record.data", "beforeTarget.data", "afterTarget.data", "beforeLink.payload", "patch"]
        .find(slot => rowRefs[slot] === undefined);
      assert.ok(unusedSlot);
      f.database.prepare("INSERT INTO data_import_row_payload_refs(run_id,row_number,slot,block_id) VALUES(?,1,?,?)")
        .run(run.id, unusedSlot, rowRefs["record.data"]);
      await assert.rejects(f.engine.detail(run.id, 1), errorCode("IMPORT_EVIDENCE_REFS_MISMATCH"));
    } finally { await f.close(); }
  });

  await t.test("row content and identity metadata remain authenticated", async () => {
    for (const column of ["content_hash", "identity_hash"]) {
      const { f, run } = await prepared();
      try {
        f.database.prepare(`UPDATE data_import_rows SET ${column}=? WHERE run_id=? AND row_number=1`).run("e".repeat(64), run.id);
        await assert.rejects(f.engine.apply(run.id, run.revision), errorCode("IMPORT_ROW_INTEGRITY", "IMPORT_EVIDENCE_BINDING_MISMATCH"));
        assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM payload_reuse_targets").get().count, 0);
      } finally { await f.close(); }
    }
  });
});

test("shared block/ref publication and target writes roll back as one transaction", async () => {
  const f = await fixture({ sharedPayloads: true, failOnNumber: "000002" });
  try {
    const run = await ready(f, customerProfile, customerRows(false).slice(0, 2));
    const before = {
      blocks: f.database.prepare("SELECT COUNT(*) AS count FROM data_import_payload_blocks").get().count,
      rowRefs: f.database.prepare("SELECT COUNT(*) AS count FROM data_import_row_payload_refs").get().count,
      changeRefs: f.database.prepare("SELECT COUNT(*) AS count FROM data_import_change_payload_refs").get().count,
    };
    await assert.rejects(f.engine.apply(run.id, run.revision), errorCode("IMPORT_OPERATION_FAILED"));
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM payload_reuse_targets").get().count, 0);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM data_import_changes").get().count, 0);
    assert.deepEqual({
      blocks: f.database.prepare("SELECT COUNT(*) AS count FROM data_import_payload_blocks").get().count,
      rowRefs: f.database.prepare("SELECT COUNT(*) AS count FROM data_import_row_payload_refs").get().count,
      changeRefs: f.database.prepare("SELECT COUNT(*) AS count FROM data_import_change_payload_refs").get().count,
    }, before);
  } finally { await f.close(); }
});

test("keyless snapshot coordinates fail before any row, block or ref is committed", async () => {
  const f = await fixture({ sharedPayloads: true });
  try {
    const rows = keylessRows(SHA_A);
    const run = await f.engine.start({ profileHash: keylessProfile.fingerprint, manifest: manifest(keylessProfile, rows, SHA_A, AT_A) });
    for (const invalid of [
      { ...rows[0], _source_snapshot_sha256: SHA_B },
      { ...rows[0], _source_row: 2 },
      { ...rows[0], _source_snapshot_sha256: "not-a-sha" },
      { ...rows[0], _source_row: 0 },
    ]) {
      await assert.rejects(f.engine.stage(run.id, { expectedRevision: run.revision, startRow: 1, rows: [invalid] }),
        errorCode("IMPORT_EVIDENCE_SNAPSHOT_MISMATCH", "IMPORT_SHA_INVALID", "IMPORT_INTEGER_INVALID"));
      assert.deepEqual({
        rows: f.database.prepare("SELECT COUNT(*) AS count FROM data_import_rows").get().count,
        blocks: f.database.prepare("SELECT COUNT(*) AS count FROM data_import_payload_blocks").get().count,
        rowRefs: f.database.prepare("SELECT COUNT(*) AS count FROM data_import_row_payload_refs").get().count,
        changeRefs: f.database.prepare("SELECT COUNT(*) AS count FROM data_import_change_payload_refs").get().count,
      }, { rows: 0, blocks: 0, rowRefs: 0, changeRefs: 0 });
      assert.equal((await f.engine.preview(run.id)).receivedRows, 0);
    }
  } finally { await f.close(); }
});

test("legacy/shared dual readers, restart and whole-database restore preserve detail and undo", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-payload-reuse-restore-"));
  const livePath = path.join(directory, "live.sqlite");
  const backupPath = path.join(directory, "backup.sqlite");
  const legacyPath = path.join(directory, "legacy.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const legacyWriter = await fixture({ databasePath: legacyPath });
  let legacyRun = await applyAll(legacyWriter, await ready(legacyWriter, customerProfile, customerRows(false).slice(0, 1)));
  await legacyWriter.close();
  const sharedReader = await fixture({ databasePath: legacyPath, sharedPayloads: true });
  assert.equal((await sharedReader.engine.detail(legacyRun.id, 1)).proposed.number, "000001");
  legacyRun = await undoAll(sharedReader, legacyRun);
  assert.equal(legacyRun.status, "reverted");
  await sharedReader.close();

  const live = await fixture({ databasePath: livePath, sharedPayloads: true });
  let sharedRun = await applyAll(live, await ready(live, customerProfile, customerRows(false).slice(0, 3)));
  createSqliteMaintenanceOperations(live.database).vacuumInto(backupPath);
  await live.close();

  const wrongKey = await fixture({ databasePath: backupPath, encryptionByte: 8 });
  await assert.rejects(wrongKey.engine.detail(sharedRun.id, 1), errorCode("IMPORT_PROTECTED_PAYLOAD_INVALID"));
  await wrongKey.close();

  // Default false is the release-A legacy writer with the same dual reader.
  const restored = await fixture({ databasePath: backupPath });
  assert.equal((await restored.engine.detail(sharedRun.id, 1)).proposed.number, "000001");
  sharedRun = await undoAll(restored, sharedRun);
  assert.equal(sharedRun.status, "reverted");
  assert.equal(restored.database.prepare("SELECT COUNT(*) AS count FROM payload_reuse_targets").get().count, 0);
  assert.equal(restored.database.prepare("PRAGMA foreign_key_check").all().length, 0);
  await restored.close();
});

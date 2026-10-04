"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const migrationFile = path.resolve(__dirname, "../lib/persistence/postgresql/core/vocational-school.js");
const baseHash = "a".repeat(64), targetHash = "b".repeat(64);

function fixture({ failureSql, environmentFailure } = {}) {
  let state = { column: false, history: false, ledger: [], rows: [{ note: "legacy retained" }], drift: false };
  let transactionSnapshot, migration;
  const calls = [], environments = [];
  const fingerprint = () => state.drift ? "c".repeat(64) : state.history && state.column ? targetHash : baseHash;
  const client = { async query(sql, parameters = []) {
    calls.push({ sql, parameters });
    if (failureSql && sql.startsWith(failureSql)) throw new Error("synthetic DDL failure");
    if (sql.startsWith("BEGIN")) transactionSnapshot = structuredClone(state);
    else if (sql === "ROLLBACK") state = transactionSnapshot;
    else if (sql.startsWith("SELECT to_regclass")) return { rows: [{ name: state.history ? "gp.vocational_school_migration_history" : null }] };
    else if (sql.startsWith("SELECT version,plan_sha256")) return { rows: structuredClone(state.ledger) };
    else if (sql.startsWith("ALTER TABLE gp.week_options ADD COLUMN")) {
      if (state.column) throw new Error("unrecorded column already exists");
      state.column = true; for (const row of state.rows) row.school_details_json = null;
    } else if (sql.startsWith("CREATE TABLE gp.vocational_school_migration_history")) state.history = true;
    else if (sql.startsWith("INSERT INTO gp.vocational_school_migration_history")) state.ledger.push({
      version: 1, plan_sha256: parameters[0], base_target_sha256: parameters[1], target_sha256: parameters[2],
    });
    return { rows: [] };
  } };
  const context = { module: { exports: {} }, require(id) {
    if (id === "./fingerprint") return { schemaFingerprint: async () => fingerprint() };
    if (id === "./environment") return { async verifyEnvironment(_client, options) {
      environments.push(options); if (environmentFailure) throw environmentFailure;
    } };
    if (id === "../boundary/migrate") return { async verifyCoreSchema() {
      const expected = await migration.target(client, baseHash);
      if (expected !== fingerprint()) throw new Error("Core development schema contract mismatch");
    } };
    return require(id);
  } };
  vm.runInNewContext(fs.readFileSync(migrationFile, "utf8"), context, { filename: migrationFile });
  migration = context.module.exports;
  return { migration, client, calls, environments, state: () => state };
}

test("school column migration keeps legacy values and atomically seals one exact schema transition", async () => {
  const f = fixture(), result = await f.migration.migrate(f.client, { binding: "synthetic-binding" });
  assert.equal(result.applied, true);
  assert.equal(result.target, targetHash);
  assert.deepEqual(f.state().rows, [{ note: "legacy retained", school_details_json: null }]);
  assert.deepEqual(f.state().ledger, [{ version: 1, plan_sha256: f.migration.digest, base_target_sha256: baseHash, target_sha256: targetHash }]);
  assert.equal(f.environments[0].purpose, "migrator");
  assert.equal(f.environments[0].binding, "synthetic-binding");
  assert.match(f.calls[0].sql, /pg_advisory_lock/);
  assert.match(f.calls.find(call => call.sql.startsWith("BEGIN")).sql, /SERIALIZABLE; SET LOCAL ROLE gp_core_owner; SET LOCAL search_path=pg_catalog,gp/);
  assert.match(f.calls.at(-1).sql, /pg_advisory_unlock/);
  assert.equal(result.rollbackBoundary.automaticRollback, false);
  assert.equal(result.rollbackBoundary.destructiveColumnDrop, false);
});

test("repeat migration verifies its exact ledger and performs no additional DDL or ledger write", async () => {
  const f = fixture(); await f.migration.migrate(f.client);
  const before = structuredClone(f.state()), offset = f.calls.length;
  assert.equal((await f.migration.migrate(f.client)).applied, false);
  assert.deepEqual(f.state(), before);
  assert.ok(!f.calls.slice(offset).some(call => /^(ALTER|CREATE|INSERT|REVOKE|GRANT)/.test(call.sql)));
});

for (const failureSql of ["CREATE TABLE", "REVOKE ALL", "INSERT INTO gp.vocational_school_migration_history"]) {
  test(`migration failure at ${failureSql} restores legacy schema/data and unlocks`, async () => {
    const f = fixture({ failureSql }), before = structuredClone(f.state());
    await assert.rejects(f.migration.migrate(f.client), /synthetic DDL failure/);
    assert.deepEqual(f.state(), before);
    assert.ok(f.calls.some(call => call.sql === "ROLLBACK"));
    assert.ok(!f.calls.some(call => call.sql === "COMMIT"));
    assert.match(f.calls.at(-1).sql, /pg_advisory_unlock/);
  });
}

test("wrong environment fails before lock, transaction or DDL", async () => {
  const failure = new Error("synthetic unauthorized environment"), f = fixture({ environmentFailure: failure });
  await assert.rejects(f.migration.migrate(f.client), error => error === failure);
  assert.equal(f.calls.length, 0);
});

test("required startup fails on the old schema while optional backup qualification remains available", async () => {
  const f = fixture();
  assert.equal(await f.migration.target(f.client, baseHash), baseHash);
  await assert.rejects(f.migration.target(f.client, baseHash, { required: true }), /PG_VOCATIONAL_SCHOOL_MIGRATION_REQUIRED/);
  assert.ok(f.calls.every(call => call.sql.startsWith("SELECT")));
});

test("a changed plan, missing/duplicate ledger or malformed fingerprint is rejected", async () => {
  for (const mutate of [
    state => { state.ledger[0].plan_sha256 = "c".repeat(64); },
    state => { state.ledger[0].base_target_sha256 = "invalid"; },
    state => { state.ledger[0].target_sha256 = "invalid"; },
    state => { state.ledger.push({ ...state.ledger[0] }); },
    state => { state.ledger = []; },
  ]) {
    const f = fixture(); await f.migration.migrate(f.client); mutate(f.state());
    const offset = f.calls.length;
    await assert.rejects(f.migration.migrate(f.client), /PG_VOCATIONAL_SCHOOL_MIGRATION_CONTRACT/);
    assert.ok(!f.calls.slice(offset).some(call => /^(ALTER|CREATE|INSERT|REVOKE|GRANT)/.test(call.sql)));
  }
});

test("schema drift or an unrecorded existing column cannot be accepted through IF NOT EXISTS", async () => {
  const f = fixture(); f.state().drift = true;
  await assert.rejects(f.migration.migrate(f.client), /schema contract mismatch/);
  assert.ok(!f.calls.some(call => call.sql.startsWith("ALTER")));
  assert.ok(f.migration.statements.every(sql => !/IF NOT EXISTS/.test(sql)));
});

test("Core qualification anchors the school ledger after all earlier extensions and checks actual schema", async () => {
  const f = fixture(); await f.migration.migrate(f.client);
  const file = path.resolve(__dirname, "../lib/persistence/postgresql/boundary/migrate.js");
  const context = { module: { exports: {} }, require(id) {
    if (id === "../core/environment") return {};
    if (id === "../core/fingerprint") return { schemaFingerprint: async () => f.state().drift ? "c".repeat(64) : targetHash };
    if (id === "../core/schema") return { createSchemaPlan: () => ({ sourceSchemaSha256: "source", digest: "baseline-plan" }) };
    if (id === "./schema") return {};
    if (id === "../core/vocational-school") return f.migration;
    return { target: async (_client, base) => base };
  } };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  const client = { async query(sql, parameters) {
    if (sql.startsWith("SELECT version,source_sha256")) return { rows: [{ version: 1, source_sha256: "source", plan_sha256: "baseline-plan", target_sha256: baseHash }] };
    if (sql.includes("boundary_migration_history")) return { rows: [{ name: null }] };
    return f.client.query(sql, parameters);
  } };
  await context.module.exports.verifyCoreSchema(client, { requireVocationalSchool: true });
  f.state().ledger[0].base_target_sha256 = "d".repeat(64);
  await assert.rejects(context.module.exports.verifyCoreSchema(client), /PG_VOCATIONAL_SCHOOL_MIGRATION_CONTRACT/);
  f.state().ledger[0].base_target_sha256 = baseHash; f.state().drift = true;
  await assert.rejects(context.module.exports.verifyCoreSchema(client), /schema contract mismatch/);
});

test("historical transfer explicitly preserves the extension as NULL and rejects unreviewed column definitions", async () => {
  const { columnsFor } = require("../lib/persistence/postgresql/transfer/history");
  const source = require("../lib/persistence/postgresql/contracts/source-schema-v09237.json");
  const original = source.tables.find(table => table.name === "week_options");
  const columns = original.columns.map(column => ({ name: column.name, type: { INTEGER: "int8", TEXT: "text" }[column.type], generated: "" }));
  const school = { name: "school_details_json", type: "text", generated: "", notNull: false, defaultExpression: null, collation: "C" };
  const table = { name: "week_options", schema: "gp", database: "core" };
  const client = additions => ({ query: async () => ({ rows: [...columns, ...additions] }) });
  assert.equal((await columnsFor(client([]), table)).length, original.columns.length);
  const extended = await columnsFor(client([school]), table);
  assert.deepEqual(extended.at(-1), { name: "school_details_json", kind: "text", source: "legacy-null" });
  for (const changed of [{ notNull: true }, { type: "jsonb" }, { defaultExpression: "'{}'" }, { collation: "default" }, { generated: "s" }]) {
    await assert.rejects(columnsFor(client([{ ...school, ...changed }]), table), /MIGRATION_COLUMNS_DRIFT/);
  }
  await assert.rejects(columnsFor(client([school, { name: "unreviewed", type: "text", generated: "" }]), table), /MIGRATION_COLUMNS_DRIFT/);
  const historicalSql = fs.readFileSync(path.resolve(__dirname, "../lib/persistence/postgresql/transfer/history.js"), "utf8");
  assert.match(historicalSql, /source==='legacy-null'\?'NULL AS '\+q\(c\.name\)/);
});

test("historical transfer rejects a new SQLite school column rather than omitting stored school data", () => {
  const { createSqliteSource } = require("../test-support/postgresql-migration/sqlite-source");
  const { verifySqlite } = require("../lib/persistence/postgresql/transfer/history");
  const db = createSqliteSource();
  try {
    verifySqlite(db);
    db.exec("ALTER TABLE week_options ADD COLUMN school_details_json TEXT");
    assert.throws(() => verifySqlite(db), /MIGRATION_SOURCE_SCHEMA_DRIFT/);
  } finally { db.close(); }
});

test("transfer/replay content verification includes school JSON and refuses changed values", async () => {
  const { verifyTable } = require("../lib/persistence/postgresql/transfer/history");
  const { createRowDigest } = require("../lib/persistence/postgresql/transfer/values");
  const columns = [{ name: "id", kind: "integer" }, { name: "school_details_json", kind: "text", source: "legacy-null" }];
  const expectedDigest = createRowDigest(columns); expectedDigest.add([1n, null]);
  const expected = { columns, ...expectedDigest.finish() }, statements = [];
  let fetched = false;
  const client = { async query(input) {
    const sql = typeof input === "string" ? input : input.text;
    statements.push(sql);
    if (sql.startsWith("FETCH") && !fetched) { fetched = true; return { rows: [[1n, '{"school":"new-record"}']] }; }
    return { rows: [] };
  } };
  await assert.rejects(verifyTable(client, { name: "week_options", schema: "gp", database: "core" }, expected), /MIGRATION_CONTENT_MISMATCH/);
  assert.match(statements[0], /"school_details_json"/);
  assert.equal(statements.at(-1), "CLOSE migration_content");
});

test("PostgreSQL startup metadata declares the additive column and never executes DDL", () => {
  const { schema } = require("../lib/persistence/postgresql/application-operations/startup");
  assert.equal(schema.columnExists("week_options", "school_details_json"), true);
  assert.equal(schema.ensureColumn("week_options", "school_details_json"), false);
  assert.throws(() => schema.ensureColumn("week_options", "unreviewed_column"), /PG_APPLICATION_MIGRATION_REQUIRED/);
});

test("database export carries the school schema ledger separately from application data", () => {
  const { OPERATIONS_ONLY_TABLES } = require("../lib/persistence/postgresql/operations/application-export");
  assert.ok(OPERATIONS_ONLY_TABLES.core.includes("gp.vocational_school_migration_history"));
  assert.ok(!OPERATIONS_ONLY_TABLES.core.includes("gp.week_options"));
});

test("school migration CLI refuses local/uninstalled execution before reading configuration or connecting", async () => {
  await assert.rejects(require("../server-tools/linux/lib/vocational-school-migrate").main([]), /PG_VOCATIONAL_SCHOOL_MIGRATION_INSTALLED_SCOPE/);
});

test("operation connections require the school migration before allowing any application SQL", async () => {
  const file = path.resolve(__dirname, "../lib/persistence/postgresql/application-operations/access.js");
  const calls = [], closed = [];
  const client = { query: async sql => { calls.push(sql); }, release: damaged => closed.push(["client", damaged]) };
  const pool = { connect: async () => client, end: async () => closed.push(["pool"]) };
  const context = { module: { exports: {} }, require(id) {
    if (id === "../core/environment") return { configuration: () => ({}), verifyEnvironment: async () => {} };
    if (id === "../boundary/migrate") return { verifyCoreSchema: async (_client, options) => {
      assert.equal(options.requireVocationalSchool, true); throw new Error("PG_VOCATIONAL_SCHOOL_MIGRATION_REQUIRED");
    } };
    if (id === "../core/sql") return require("../lib/persistence/postgresql/core/sql");
    return require(id);
  } };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  await assert.rejects(context.module.exports.openCoreOperations({}, { pool }), /PG_VOCATIONAL_SCHOOL_MIGRATION_REQUIRED/);
  assert.deepEqual(calls, ["SET search_path=pg_catalog,gp"]);
  assert.deepEqual(closed, [["client", true], ["pool"]]);
});

test("explicit CLI rejects catalog drift before opening operations configuration or database", async () => {
  const file = path.resolve(__dirname, "../server-tools/linux/lib/vocational-school-migrate.js");
  const root = "/opt/grabenplaner/app", reads = [];
  const paths = ["server-tools/linux/lib/vocational-school-migrate.js", "lib/persistence/postgresql/core/vocational-school.js",
    "lib/persistence/postgresql/core/catalog.js", "lib/persistence/postgresql/boundary/migrate.js",
    "lib/persistence/sqlite/planning-settings-catalog.js", "lib/persistence/statements/planning-settings.js"];
  const hash = bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  const manifest = Buffer.from(JSON.stringify({ files: paths.map(relative => ({ path: relative, sha256: hash(Buffer.from(relative)) })) }));
  const context = { module: { exports: {} }, __dirname: root + "/server-tools/linux/lib",
    process: { platform: "linux", getuid: () => 0 }, require(id) {
      if (id === "node:fs") return { realpathSync: value => value === "/proc/self/fd/9" ? "/run/grabenplaner/maintenance.lock" : root,
        readFileSync: value => { reads.push(value); return value.endsWith("grabenplaner-server-manifest.json") ? manifest : Buffer.from(value.slice(root.length + 1)); } };
      if (id === "node:child_process") return { spawnSync: () => ({ status: 0 }) };
      if (id === "./deploy-policy") return { applicationContract: () => {} };
      if (id === "../../../lib/persistence/postgresql/core/catalog") return { createCoreCatalog() { throw new Error("synthetic unreviewed catalog drift"); } };
      if (id === "../../../lib/persistence/postgresql/operations/runtime") return { loadConfiguration() { throw new Error("must not read private configuration"); } };
      return require(id);
    } };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  await assert.rejects(context.module.exports.main([hash(manifest), "--maintenance-lock-held"]), /synthetic unreviewed catalog drift/);
  assert.equal(reads.length, paths.length + 1);
});

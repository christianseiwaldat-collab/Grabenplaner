"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const test = require("node:test");

test("native PostgreSQL API fixture preserves technical ledgers, rejects unknown populated relations and enforces read-only access", {
  skip: process.env.GP_PG_API_FIXTURE_BRIDGE !== "1", timeout: 120000,
}, async () => {
  require("../test-support/postgresql-api/guard").assertSyntheticEnvironment();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-pg-api-native-fixture-"));
  Object.assign(process.env, { DB_PATH: path.join(temporary, "fixture.postgresql"), GRABENPLANER_DATA_DIR: path.join(temporary, "runtime"), GRABENPLANER_SEED_DEMO: "0" });
  const { Client } = require("pg");
  const { verifyEnvironment } = require("../lib/persistence/postgresql/core/environment");
  const { databaseForCurrentTest, closeCurrentTestFixture } = require("../test-support/postgresql-api/preload");
  const core = new Client({ connectionString: process.env.GP_CORE_MIGRATOR_URL });
  const sales = new Client({ connectionString: process.env.GP_SALES_MIGRATOR_URL });
  const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  let created = false;
  await core.connect(); await sales.connect();
  try {
    await verifyEnvironment(core, { purpose: "migrator" });
    await verifyEnvironment(sales, { domain: "sales", purpose: "migrator" });
    const before = digest((await sales.query("SELECT * FROM gp.import_delete_performance_history ORDER BY version")).rows);
    assert.equal((await core.query("SELECT to_regclass('gp.unreviewed_migration_history') AS relation")).rows[0].relation, null);
    await core.query("SET ROLE gp_core_owner");
    await core.query("CREATE TABLE gp.unreviewed_migration_history(value TEXT NOT NULL)"); created = true;
    await core.query("INSERT INTO gp.unreviewed_migration_history VALUES('synthetic must be preserved')");
    assert.throws(() => databaseForCurrentTest(), /PG_API_FIXTURE_REFUSES_EXISTING_BUSINESS_DATA: core/);
    assert.deepEqual((await core.query("SELECT value FROM gp.unreviewed_migration_history")).rows, [{ value: "synthetic must be preserved" }]);
    assert.equal(digest((await sales.query("SELECT * FROM gp.import_delete_performance_history ORDER BY version")).rows), before);
    await core.query("DROP TABLE gp.unreviewed_migration_history"); created = false;
    const database = databaseForCurrentTest();
    database.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run("synthetic-api-fixture-proof", "00001");
    assert.equal(database.prepare("SELECT value AS actualValue FROM settings WHERE key=?").get("synthetic-api-fixture-proof").actualValue, "00001");
    const reader = databaseForCurrentTest(undefined, { readOnly: true });
    assert.throws(() => reader.prepare("INSERT INTO settings(key,value) VALUES('synthetic-readonly-forbidden','value') RETURNING key").all(), /read-only transaction/);
    assert.equal(database.prepare("SELECT key FROM settings WHERE key='synthetic-readonly-forbidden'").get(), undefined);
    closeCurrentTestFixture();
    assert.equal((await core.query("SELECT COUNT(*)::integer AS count FROM gp.settings")).rows[0].count, 0);
    assert.equal((await sales.query("SELECT COUNT(*)::integer AS count FROM gp.migration_fixture_owner")).rows[0].count, 0);
    assert.equal(digest((await sales.query("SELECT * FROM gp.import_delete_performance_history ORDER BY version")).rows), before);
  } finally {
    if (created) await core.query("DROP TABLE gp.unreviewed_migration_history");
    closeCurrentTestFixture();
    await core.end(); await sales.end();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

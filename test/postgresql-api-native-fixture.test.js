"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const test = require("node:test");

test("native PostgreSQL API fixture preserves technical ledgers, rejects unknown populated relations and enforces read-only access", {
  skip: process.env.GP_PG_API_FIXTURE_BRIDGE !== "1", timeout: 180000,
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
  let created = false, releaseRead, pendingRead;
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
    const schema = require("../test-support/postgresql-api/metadata");
    assert.equal(schema.assertCoreSchemaLedger(database).version, 1);
    assert.equal(schema.tableExists(database, "employees"), true);
    assert.equal(schema.tableExists(database, "sales_articles"), true);
    assert.equal(schema.tableExists(database, "synthetic_absent_table"), false);
    assert.equal(schema.columns(database, "employees").find(column => column.name === "time_confirmation_level").notnull, 1);
    assert.ok(schema.foreignKeys(database, "shifts").some(key => key.from === "location_id" && key.table === "locations" && key.to === "id"));
    assert.ok(schema.indexes(database, "shifts").some(index => index.name === "idx_shifts_location_date"));
    assert.ok(schema.triggers(database, "shifts").some(trigger => trigger.name === "trg_shifts_location_update" && trigger.definition.startsWith("CREATE TRIGGER")));
    assert.ok(schema.triggerByName(database, "trg_shifts_location_update").sql.includes("RETURNS trigger"));
    assert.deepEqual(schema.foreignKeyViolations(database), []);
    assert.throws(() => database.postgresqlCatalogQuery("unregistered", "SELECT 1"), /CATALOG_DOMAIN/);
    assert.throws(() => database.postgresqlCatalogQuery("core", "INSERT INTO settings(key,value) VALUES('synthetic-catalog-write-forbidden','value') RETURNING key"), /read-only transaction/);
    const days = JSON.parse(database.prepare("SELECT day_settings_json FROM locations WHERE id='01'").get().day_settings_json);
    assert.deepEqual(Object.keys(days), ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);
    assert.deepEqual(days.monday, { open: true, start: "09:00", end: "18:00", lunchEnabled: false,
      lunchStart: "13:00", lunchEnd: "14:00", minStaff: 0, minFrom: "09:00", minTo: "18:00" });
    assert.equal(days.saturday.start, "10:00"); assert.equal(days.saturday.end, "17:00");
    assert.throws(() => database.postgresqlFixtureDdl("core", "DROP TABLE gp.settings"), /PG_API_FIXTURE_DDL_KIND/);
    assert.throws(() => database.postgresqlFixtureDdl("core", "DROP TRIGGER missing ON gp.settings; DROP TABLE gp.settings"), /PG_API_FIXTURE_DDL_KIND/);
    database.exec("BEGIN IMMEDIATE");
    database.prepare("INSERT INTO settings(key,value) VALUES('synthetic-read-inside-seed-transaction','pending')").run();
    assert.equal(schema.tableExists(database, "employees"), true);
    database.exec("ROLLBACK");
    assert.equal(database.prepare("SELECT key FROM settings WHERE key='synthetic-read-inside-seed-transaction'").get(), undefined,
      "read-only catalog access must never commit or roll back the seed transaction");
    const { createFixtureAttemptCounter, installFixtureTrigger, suspendFixtureGuards } = require("../test-support/postgresql-api/trigger-fixture");
    const originalShiftGuard = schema.triggerByName(database, "trg_shifts_location_update").definition;
    const restoreShiftGuard = suspendFixtureGuards(database, ["trg_shifts_location_update"]);
    assert.equal(schema.triggerByName(database, "trg_shifts_location_update"), undefined);
    restoreShiftGuard();
    assert.equal(schema.triggerByName(database, "trg_shifts_location_update").definition, originalShiftGuard);
    const attemptCounter = createFixtureAttemptCounter(database);
    const removeFailure = installFixtureTrigger(database, `CREATE TRIGGER test_native_settings_failure
      BEFORE INSERT ON settings WHEN NEW.key='synthetic-trigger-failure'
      BEGIN SELECT RAISE(ABORT, 'synthetic expected native failure'); END`, { attemptCounter });
    assert.throws(() => database.prepare("INSERT INTO settings(key,value) VALUES('synthetic-trigger-failure','value')").run(), /synthetic expected native failure/);
    assert.equal(database.prepare("SELECT key FROM settings WHERE key='synthetic-trigger-failure'").get(), undefined);
    assert.equal(attemptCounter.count(), 1, "native attempt proof must survive the failed transaction");
    removeFailure(); attemptCounter.close();
    database.prepare("INSERT INTO settings(key,value) VALUES('synthetic-trigger-failure','value')").run();
    assert.equal(database.prepare("DELETE FROM settings WHERE key='synthetic-trigger-failure'").run().changes, 1);
    const removeSalesFailure = installFixtureTrigger(database, `CREATE TRIGGER test_native_sales_failure
      BEFORE INSERT ON sales_articles BEGIN SELECT RAISE(ABORT, 'synthetic expected Sales failure'); END`);
    assert.ok(schema.triggerByName(database, "test_native_sales_failure", { domain: "sales" }).definition.includes('trade.sales_articles'));
    removeSalesFailure();
    const { prepareLocationFixture } = require("../test-support/postgresql-api/location-fixture");
    assert.equal(prepareLocationFixture(database, "INSERT INTO locations(id,name,active) VALUES(?,?,1),('native-extra-02','Synthetic second',1)")
      .run("native-extra-01", "Synthetic ? :literal").changes, 2);
    assert.equal(database.prepare("SELECT l.name,c.cost_center_type_id AS typeId FROM locations l JOIN cost_centers c ON c.id=l.cost_center_id WHERE l.id=?")
      .get("native-extra-01").name, "Synthetic ? :literal");
    assert.equal(database.prepare("SELECT c.cost_center_type_id AS typeId FROM locations l JOIN cost_centers c ON c.id=l.cost_center_id WHERE l.id=?")
      .get("native-extra-01").typeId, "branch");
    assert.throws(() => database.prepare("INSERT INTO locations(id,name,active) VALUES('synthetic-invalid-no-cost-center','Must be rejected',1)").run(), /LOCATION_COST_CENTER_INVALID/);
    database.prepare("INSERT INTO employees(personnel_number,full_name,nickname,active) VALUES('synthetic-locationless-actor','Synthetic actor','Synthetic',1)").run();
    const locationless = database.prepare("SELECT home_location_id,cost_center_id FROM employees WHERE personnel_number='synthetic-locationless-actor'").get();
    assert.equal(locationless.home_location_id, null);
    assert.equal(locationless.cost_center_id, "cc-administration");
    const department = database.prepare("INSERT INTO departments(location_id,name) VALUES('01','Synthetic identity proof')").run();
    assert.ok(Number.isSafeInteger(department.lastInsertRowid) && department.lastInsertRowid > 0);
    assert.equal(database.prepare("SELECT name FROM departments WHERE id=?").get(department.lastInsertRowid).name, "Synthetic identity proof");
    database.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run("synthetic-api-fixture-proof", "00001");
    assert.equal(database.prepare("SELECT value AS actualValue FROM settings WHERE key=?").get("synthetic-api-fixture-proof").actualValue, "00001");
    const reader = databaseForCurrentTest(undefined, { readOnly: true });
    assert.throws(() => reader.prepare("INSERT INTO settings(key,value) VALUES('synthetic-readonly-forbidden','value') RETURNING key").all(), /read-only transaction/);
    assert.equal(database.prepare("SELECT key FROM settings WHERE key='synthetic-readonly-forbidden'").get(), undefined);
    const application = require("../lib/persistence/sqlite/provider").openSqliteApplicationPersistence({ databasePath: process.env.DB_PATH });
    assert.equal(application.provider.getCapabilities().providerId, "postgresql");
    let announceRead;
    const readStarted = new Promise(resolve => { announceRead = resolve; });
    const heldRead = new Promise(resolve => { releaseRead = resolve; });
    pendingRead = application.provider.transaction(async transaction => {
      await transaction.queryOne(require("../lib/persistence/statements/ui-preferences").UI_PREFERENCES_STATEMENTS.get,
        { employeeNumber: "synthetic-no-person", preferenceKey: "synthetic-no-preference" });
      announceRead(); await heldRead;
    }, { readOnly: true });
    await Promise.race([readStarted, pendingRead.then(() => { throw new Error("HELD_READ_ENDED_EARLY"); })]);
    const closingFixture = closeCurrentTestFixture();
    assert.equal((await core.query("SELECT COUNT(*)::integer AS count FROM gp.settings WHERE key='migration-test-owner'")).rows[0].count, 1,
      "owned fixture data must remain while a real application snapshot is still running");
    releaseRead(); await pendingRead;
    await closingFixture;
    assert.equal((await core.query("SELECT COUNT(*)::integer AS count FROM gp.settings")).rows[0].count, 0);
    assert.equal((await sales.query("SELECT COUNT(*)::integer AS count FROM gp.migration_fixture_owner")).rows[0].count, 0);
    assert.equal(digest((await sales.query("SELECT * FROM gp.import_delete_performance_history ORDER BY version")).rows), before);
  } finally {
    releaseRead?.(); await pendingRead?.catch(() => {});
    if (created) await core.query("DROP TABLE gp.unreviewed_migration_history");
    await closeCurrentTestFixture();
    await core.end(); await sales.end();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

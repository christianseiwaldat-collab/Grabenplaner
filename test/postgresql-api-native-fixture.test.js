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
  let created = false, releaseRead, pendingRead, pendingChallenge = null;
  await core.connect(); await sales.connect();
  try {
    await verifyEnvironment(core, { purpose: "migrator" });
    await verifyEnvironment(sales, { domain: "sales", purpose: "migrator" });
    const before = digest((await sales.query("SELECT * FROM gp.import_delete_performance_history ORDER BY version")).rows);
    const passkeyLedger = (await core.query("SELECT * FROM gp.passkeys_migration_history ORDER BY version")).rows;
    assert.equal(passkeyLedger.length, 1, "the normal bootstrap must have installed the technical passkey ledger");
    assert.equal(passkeyLedger[0].plan_sha256, require("../lib/persistence/postgresql/core/passkeys").digest);
    assert.equal((await core.query("SELECT to_regclass('gp.unreviewed_migration_history') AS relation")).rows[0].relation, null);
    await core.query("SET ROLE gp_core_owner");
    await core.query("CREATE TABLE gp.unreviewed_migration_history(value TEXT NOT NULL)"); created = true;
    await core.query("INSERT INTO gp.unreviewed_migration_history VALUES('synthetic must be preserved')");
    assert.throws(() => databaseForCurrentTest(), /PG_API_FIXTURE_REFUSES_EXISTING_BUSINESS_DATA: core/);
    assert.deepEqual((await core.query("SELECT value FROM gp.unreviewed_migration_history")).rows, [{ value: "synthetic must be preserved" }]);
    assert.equal(digest((await sales.query("SELECT * FROM gp.import_delete_performance_history ORDER BY version")).rows), before);
    assert.deepEqual((await core.query("SELECT * FROM gp.passkeys_migration_history ORDER BY version")).rows, passkeyLedger);
    await core.query("DROP TABLE gp.unreviewed_migration_history"); created = false;
    pendingChallenge = crypto.randomUUID();
    const challenge = crypto.randomBytes(32).toString("base64url"), now = new Date().toISOString(), expires = new Date(Date.now() + 120000).toISOString();
    await core.query(`INSERT INTO gp.passkey_challenges(id,purpose,challenge,binding_hash,rp_id,origin,payload,created_at,expires_at)
      VALUES($1,'authenticate',$2,$3,'native-fixture.example.test','https://native-fixture.example.test','{}',$4,$5)`,
    [pendingChallenge, challenge, digest("synthetic native ownership guard"), now, expires]);
    assert.throws(() => databaseForCurrentTest(), /PG_API_FIXTURE_REFUSES_EXISTING_BUSINESS_DATA: core/,
      "a populated passkey challenge remains business/security data, never infrastructure");
    assert.deepEqual((await core.query("SELECT id,challenge,consumed_at FROM gp.passkey_challenges WHERE id=$1", [pendingChallenge])).rows,
      [{ id: pendingChallenge, challenge, consumed_at: null }], "refusal must preserve the existing challenge unchanged");
    assert.deepEqual((await core.query("SELECT * FROM gp.passkeys_migration_history ORDER BY version")).rows, passkeyLedger);
    await core.query("DELETE FROM gp.passkey_challenges WHERE id=$1", [pendingChallenge]); pendingChallenge = null;
    const database = databaseForCurrentTest();
    assert.deepEqual((await core.query("SELECT * FROM gp.passkeys_migration_history ORDER BY version")).rows, passkeyLedger,
      "fixture acquisition must retain the installed technical ledger");
    const configuration = require("../lib/persistence/configuration").resolvePersistenceConfiguration();
    const { readPostgresqlSystemHealth } = require("../lib/persistence/postgresql/application-operations/system-health");
    assert.equal(configuration.profile, require("../lib/persistence/postgresql/core/environment").PROFILE);
    const health = await readPostgresqlSystemHealth(configuration);
    assert.equal(health.foreignKeys, true);
    assert.ok(Number.isSafeInteger(health.databaseBytes) && health.databaseBytes > 0);
    for (const [domain, client] of [["core", core], ["sales", sales]]) {
      const measured = (await client.query("SELECT pg_database_size(current_database())::text AS bytes, (SELECT COUNT(*)::integer FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='gp' AND c.contype='f') AS foreign_keys")).rows[0];
      assert.equal(health.databases[domain].foreignKeys, measured.foreign_keys);
      assert.ok(Number.isSafeInteger(health.databases[domain].bytes) && health.databases[domain].bytes > 0);
      assert.equal(health.databases[domain].invalidForeignKeys, 0);
    }
    await assert.rejects(readPostgresqlSystemHealth({ ...configuration, profile: "unreviewed-profile" }), /Verified database profile required/);
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
    database.postgresqlFixtureWrite("sales", "INSERT INTO integration.core_location_references(id,source_sha256) VALUES (?,?)",
      ["synthetic-native-write", "b".repeat(64)]);
    assert.equal(database.postgresqlCatalogQuery("sales", "SELECT id FROM integration.core_location_references WHERE id=?", ["synthetic-native-write"])[0].id, "synthetic-native-write");
    assert.throws(() => databaseForCurrentTest(undefined, { readOnly: true }).postgresqlFixtureWrite("sales",
      "DELETE FROM integration.core_location_references WHERE id=?", ["synthetic-native-write"]), /PG_API_FIXTURE_READ_ONLY/);
    assert.throws(() => database.postgresqlFixtureWrite("core", "DROP TABLE gp.settings"), /PG_API_FIXTURE_WRITE_KIND/);
    assert.throws(() => database.postgresqlFixtureWrite("core", "DELETE FROM gp.settings; DROP TABLE gp.settings"), /PG_API_FIXTURE_WRITE_KIND/);
    assert.throws(() => database.postgresqlFixtureWrite("core", "DELETE FROM pg_catalog.pg_class"), /PG_API_FIXTURE_WRITE_KIND/);
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
    const removeUniqueRace = installFixtureTrigger(database, `CREATE TRIGGER test_native_unique_race
      BEFORE INSERT ON settings
      WHEN NEW.key='synthetic-unique-race' AND pg_trigger_depth()=1
      BEGIN INSERT INTO settings(key,value) VALUES(NEW.key,NEW.value); END`);
    try {
      assert.throws(() => database.prepare("INSERT INTO settings(key,value) VALUES('synthetic-unique-race','value')").run(),
        error => error.code === "23505", "one nested insert must produce the intended unique conflict, never recursive stack exhaustion");
      assert.equal(database.prepare("SELECT key FROM settings WHERE key='synthetic-unique-race'").get(), undefined,
        "the nested competing insert must roll back with the failed statement");
    } finally { removeUniqueRace(); }
    database.prepare("INSERT INTO settings(key,value) VALUES('synthetic-trigger-failure','value')").run();
    assert.equal(database.prepare("DELETE FROM settings WHERE key='synthetic-trigger-failure'").run().changes, 1);
    const removeSalesFailure = installFixtureTrigger(database, `CREATE TRIGGER test_native_sales_failure
      BEFORE INSERT ON sales_articles BEGIN SELECT RAISE(ABORT, 'synthetic expected Sales failure'); END`);
    assert.ok(schema.triggerByName(database, "test_native_sales_failure", { domain: "sales" }).definition.includes('trade.sales_articles'));
    removeSalesFailure();
    const { installSalesOutboxFailure } = require("../test-support/postgresql-api/trigger-fixture");
    for (const [index, failure] of [
      { action: "sales.article-catalog.import" },
      { action: "sales.article-catalog.import.undo" },
      { receiptActionType: "sales.article-catalog.create" },
    ].entries()) {
      const name = "test_native_outbox_failure_" + index;
      const remove = installSalesOutboxFailure(database, { name, ...failure });
      try {
        const actualTrigger = schema.triggerByName(database, name, { domain: "sales" });
        assert.equal(actualTrigger.schema, "integration");
        assert.equal(actualTrigger.table, "core_audit_outbox");
        const before = database.postgresqlCatalogQuery("sales", "SELECT COUNT(*) AS count FROM integration.core_audit_outbox")[0].count;
        const insert = (action, detail) => database.postgresqlFixtureWrite("sales",
          "INSERT INTO integration.core_audit_outbox(actor,action,entity_type,entity_id,detail,created_at) VALUES(?,?,?,?,?,?)",
          ["synthetic-native", action, "synthetic", "native-outbox", JSON.stringify(detail), "2026-10-24T00:00:00.000Z"]);
        database.exec("BEGIN");
        try {
          insert("synthetic.allowed-before-failure", {});
          assert.throws(() => insert(failure.action || "database-boundary.personal-action-v1",
            failure.receiptActionType ? { actionType: failure.receiptActionType } : {}), /synthetic Sales intent failure/);
        } finally { database.exec("ROLLBACK"); }
        assert.equal(database.postgresqlCatalogQuery("sales", "SELECT COUNT(*) AS count FROM integration.core_audit_outbox")[0].count, before,
          "failure must roll back earlier writes in the same actual PostgreSQL transaction");
        assert.equal(insert("synthetic.unrelated-action", {}).changes, 1);
        if (failure.receiptActionType) assert.equal(insert("database-boundary.personal-action-v1", { actionType: "synthetic.other-receipt" }).changes, 1);
      } finally { remove(); }
      assert.equal(schema.triggerByName(database, name, { domain: "sales" }), undefined);
      // Positive controls deliberately use synthetic event payloads. Remove
      // only these owned controls before the actual application starts its
      // real ordered outbox delivery later in this test.
      assert.equal(database.postgresqlFixtureWrite("sales",
        "DELETE FROM integration.core_audit_outbox WHERE actor=? AND entity_id=?",
        ["synthetic-native", "native-outbox"]).changes, failure.receiptActionType ? 2 : 1);
    }
    assert.throws(() => installSalesOutboxFailure(database, { name: "test_native_outbox_unknown", action: "arbitrary-action" }));
    assert.equal(schema.triggerByName(database, "test_native_outbox_unknown", { domain: "sales" }), undefined);
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
    const { installLegacyLearningScopeFixture, permissionCheck } = require("../test-support/postgresql-api/constraint-fixture");
    database.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active) VALUES('synthetic-locationless-actor','synthetic-only','employee',1)").run();
    database.prepare(`INSERT INTO portal_permission_grants(employee_number,permission,granted_by)
      VALUES('synthetic-locationless-actor','personnel:learning:assignments:write','101'),
      ('synthetic-locationless-actor','personnel:candidates:read','101')`).run();
    database.prepare(`INSERT INTO portal_access_scopes(employee_number,location_id,department_id,assigned_by)
      VALUES('synthetic-locationless-actor','01',0,'101'),('synthetic-locationless-actor','native-extra-01',0,'101')`).run();
    const removeLegacyScope = installLegacyLearningScopeFixture(database, "synthetic-locationless-actor", "01");
    try {
      assert.equal(permissionCheck(database).validated, false);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM portal_permission_scope_grants WHERE permission='personnel:learning:assignments:write'").get().count, 1);
      assert.throws(() => database.prepare(`INSERT INTO portal_permission_scope_grants
        (employee_number,permission,location_id,department_id,approved_by)
        VALUES('synthetic-locationless-actor','personnel:learning:assignments:write','native-extra-01',0,'101')`).run(), /portal_permission_scope_grants_permission_check/);
      database.prepare(`INSERT INTO portal_permission_scope_grants
        (employee_number,permission,location_id,department_id,approved_by)
        VALUES('synthetic-locationless-actor','personnel:candidates:read','01',0,'101')`).run();
    } finally { removeLegacyScope(); }
    assert.equal(permissionCheck(database).validated, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM portal_permission_scope_grants WHERE permission='personnel:learning:assignments:write'").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM portal_permission_scope_grants WHERE permission='personnel:candidates:read'").get().count, 1);
    assert.throws(() => database.postgresqlFixtureDdl("core", 'ALTER TABLE gp."settings" DROP CONSTRAINT "arbitrary"'), /PG_API_FIXTURE_DDL_KIND/);
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
    assert.deepEqual((await core.query("SELECT * FROM gp.passkeys_migration_history ORDER BY version")).rows, passkeyLedger,
      "fixture cleanup must retain the installed technical ledger");
  } finally {
    releaseRead?.(); await pendingRead?.catch(() => {});
    if (created) await core.query("DROP TABLE gp.unreviewed_migration_history");
    if (pendingChallenge) await core.query("DELETE FROM gp.passkey_challenges WHERE id=$1", [pendingChallenge]);
    await closeCurrentTestFixture();
    await core.end(); await sales.end();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { Client } = require("pg");
const { fixtureHtml, mhtml } = require("../test-support/xoffi-mhtml");
const { withCoreFixture } = require("../test-support/postgresql-migration/core-fixture");
const { withSalesFixture } = require("../test-support/postgresql-migration/sales-fixture");

test("Native PostgreSQL: MHTML migration, upload, employee mapping, retained vacation and immutable snapshots", {
  skip: !process.env.GP_PG_MIGRATION_LIVE, timeout: process.env.GP_XOFFI_BROWSER_QA ? 600000 : 120000,
}, async () => {
  const migrator = new Client({ connectionString: process.env.GP_CORE_MIGRATOR_URL });
  await migrator.connect();
  await migrator.query("SET search_path=pg_catalog,gp");
  try {
    const migration = require("../lib/persistence/postgresql/core/xoffi-snapshots");
    const restoredSchema = await require("../server-tools/linux/recovery/lib/postgresql-recovery-worker").prepareRestoredSchema({
      config: { domains: [{ domain: "core", database: "gp_migration_core" }] },
      connect(database, role) {
        assert.equal(database, "gp_migration_core"); assert.equal(role, "gp_core_migrator");
        return new Client({ connectionString: process.env.GP_CORE_MIGRATOR_URL });
      },
    });
    assert.equal(restoredSchema.xoffi.digest, migration.digest);
    assert.equal((await migration.migrate(migrator)).applied, false);
    await require("../lib/persistence/postgresql/boundary/migrate").verifyCoreSchema(migrator);
  } finally { await migrator.end(); }
  await withCoreFixture(async (core) => withSalesFixture(8, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-xoffi-native-"));
    const configuration = require("../lib/persistence/configuration"), original = configuration.resolvePersistenceConfiguration;
    const environment = { NODE_ENV: "test", DB_PROVIDER: "postgresql", GRABENPLANER_DATA_DIR: root,
      DB_PATH: path.join(root, "core.postgresql"), BACKUP_DIR: path.join(root, "backups"), GRABENPLANER_HOST: "127.0.0.1",
      GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_TEST_TODAY: "2026-09-17", TZ: "Europe/Vienna" };
    const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    Object.assign(process.env, environment);
    configuration.resolvePersistenceConfiguration = () => ({ providerId: "postgresql", databasePath: environment.DB_PATH,
      coreUrl: process.env.GP_CORE_APP_URL, salesUrl: process.env.GP_SALES_APP_URL,
      readers: { coreUrl: process.env.GP_CORE_READER_URL, salesUrl: process.env.GP_SALES_READER_URL }, rehearsal: true });
    let subject, server;
    try {
      const token = crypto.randomBytes(32).toString("hex"), csrf = crypto.randomBytes(24).toString("hex");
      await core.migrator.query("BEGIN; SET LOCAL ROLE gp_core_owner");
      await core.migrator.query("UPDATE gp.employees SET full_name='Mara Filialleitung',nickname='Mara' WHERE personnel_number='00001'");
      await core.migrator.query("UPDATE gp.portal_users SET must_change_password=0 WHERE employee_number='00001'");
      await core.migrator.query("INSERT INTO gp.portal_sessions(id,employee_number,token_hash,expires_at) VALUES($1,'00001',$2,'2099-01-01T00:00:00.000Z')", [crypto.randomUUID(), crypto.createHash("sha256").update(token).digest("hex")]);
      await core.migrator.query("COMMIT");
      const before = (await core.migrator.query("SELECT * FROM gp.employees WHERE personnel_number='00001'")).rows[0];
      subject = require("../server"); await subject.initializeApplicationPersistence();
      server = await new Promise(resolve => { const instance = subject.app.listen(0, "127.0.0.1", () => resolve(instance)); });
      const base = "http://127.0.0.1:" + server.address().port;
      const cookie = `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`;
      async function request(route, body, expected = 200, withCsrf = true) {
        const response = await fetch(base + route, { method: body ? "POST" : "GET", headers: { Cookie: cookie,
          ...(withCsrf ? { "X-CSRF-Token": csrf } : {}), ...(body ? { "Content-Type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json", "X-Import-Filename": "synthetic.mhtml" } : {}) },
          ...(body ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}) });
        const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
      }
      const input = mhtml();
      await request("/api/portal/v1/xoffi-time-import/inspect?locationId=18", input, 403, false);
      const preview = await request("/api/portal/v1/xoffi-time-import/inspect?locationId=18", input);
      assert.equal(preview.employees[0].employeeNumber, "00001");
      const applied = await request("/api/portal/v1/xoffi-time-import/apply", { previewId: preview.previewId, confirmed: true, useAsActual: true, employees: preview.employees }, 201);
      assert.equal(applied.schedule.weekStart, "2026-09-07");
      assert.equal(applied.schedule.xoffiTime.weekByEmployee["00001"].snapshot.remainingVacationDays, 37.5);
      assert.equal(applied.schedule.xoffiTime.weekByEmployee["00001"].days.length, 7);
      const next = await request("/api/schedule?week=2026-09-14&location=18");
      assert.equal(next.xoffiTime.snapshotByEmployee["00001"].balanceDate, "2026-09-06");
      assert.equal(next.xoffiTime.weekByEmployee["00001"], undefined);
      const vacationPlan = await request("/api/vacations?year=2026&location=18");
      assert.deepEqual(vacationPlan.xoffiVacationByEmployee,{"00001":{balanceDate:"2026-09-06",remainingVacationDays:37.5}});
      assert.deepEqual((await request("/api/vacations?year=2025&location=18")).xoffiVacationByEmployee,{});
      assert.deepEqual((await core.migrator.query("SELECT * FROM gp.employees WHERE personnel_number='00001'")).rows[0], before);
      const saturday = await subject.evaluateTimeDay("00001", "2026-09-12", new Date("2026-09-17T12:00:00Z"), 1, null, { locationId: "18", filterLocation: true });
      assert.equal(saturday.actualValuedMinutes, 180);
      const bad = await request("/api/portal/v1/xoffi-time-import/inspect?locationId=18", mhtml(fixtureHtml({week:38,balanceDate:"13.09.2026"})), 409);
      assert.equal(bad.code, "XOFFI_WEEK_NOT_PAST");
      await assert.rejects(() => core.migrator.query("UPDATE gp.xoffi_time_snapshots SET snapshot_json='{}'"));
      const complete = mhtml(fixtureHtml() + fixtureHtml({ name: "Testperson 2" }));
      for (let repeat = 0; repeat < 2; repeat++) {
        const full = await request("/api/portal/v1/xoffi-time-import/inspect?locationId=18", complete);
        const updated = await request("/api/portal/v1/xoffi-time-import/apply", { previewId: full.previewId,
          confirmed: true, useAsActual: true, employees: full.employees }, 201);
        assert.equal(Object.keys(updated.schedule.xoffiTime.weekByEmployee).length, 2);
      }
      const partial = await request("/api/portal/v1/xoffi-time-import/inspect?locationId=18", input);
      const incomplete = await request("/api/portal/v1/xoffi-time-import/apply", { previewId: partial.previewId,
        confirmed: true, useAsActual: true, employees: partial.employees }, 409);
      assert.equal(incomplete.code, "XOFFI_REIMPORT_INCOMPLETE");
      assert.equal((await core.migrator.query(`SELECT COUNT(*)::int n FROM gp.xoffi_time_employee_rows r
        JOIN gp.xoffi_time_imports i ON i.id=r.import_id WHERE i.status='active'`)).rows[0].n, 2);
      await core.migrator.query("BEGIN; SET LOCAL ROLE gp_core_owner");
      await core.migrator.query(`UPDATE gp.xoffi_time_imports SET status='superseded',superseded_by_import_id=$1,
        superseded_by='test',superseded_at=CURRENT_TIMESTAMP WHERE status='active'`, [crypto.randomUUID()]);
      await assert.rejects(() => core.migrator.query("COMMIT"), { code: "23503" });
      assert.equal((await core.migrator.query("SELECT COUNT(*)::int n FROM gp.xoffi_time_imports WHERE status='active'")).rows[0].n, 1);
      if (process.env.GP_XOFFI_BROWSER_QA) {
        const password = "Synthetic-Xoffi-QA-2026!";
        await core.migrator.query("BEGIN; SET LOCAL ROLE gp_core_owner");
        await core.migrator.query("UPDATE gp.portal_users SET password_hash=$1 WHERE employee_number='00001'", [await subject.hashPortalPassword(password)]);
        await core.migrator.query("COMMIT");
        const directory = path.join(process.cwd(), "tmp", "xoffi-browser-20260917");fs.mkdirSync(directory,{recursive:true});
        fs.writeFileSync(path.join(directory,"synthetic.mhtml"),input);
        fs.writeFileSync(path.join(directory,"ready.json"),JSON.stringify({url:base,employeeNumber:"00001",password}));
        const deadline=Date.now()+480000;
        while(!fs.existsSync(path.join(directory,"done"))&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,300));
      }
    } finally {
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      await subject?.closePersistenceForTests();
      configuration.resolvePersistenceConfiguration = original;
      for (const [key,value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key]=value;
      const resolved=fs.realpathSync(root);assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir())+path.sep));
      fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    }
  }));
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("PostgreSQL enforces separate scheduling, vacation, order and location rights over HTTP", {
  skip: !process.env.GP_CORE_MIGRATOR_URL,
}, async () => {
  const { withCoreFixture } = require("../test-support/postgresql-migration/core-fixture");
  const { withSalesFixture } = require("../test-support/postgresql-migration/sales-fixture");
  await withCoreFixture(core => withSalesFixture(8, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-location-functions-"));
    const configuration = require("../lib/persistence/configuration");
    const originalConfiguration = configuration.resolvePersistenceConfiguration;
    let subject, listener;
    try {
      await core.migrator.query("SET ROLE gp_core_owner; SET search_path=pg_catalog,gp");
      await core.migrator.query(`INSERT INTO cost_centers(id,code,name,type,cost_center_type_id)
        SELECT 'cc' || id, 'FIL' || id, name, 'branch', 'branch'
        FROM (VALUES ('60','Testfiliale A'),('61','Testfiliale B'),('62','Testfiliale C'),('63','Testfiliale D')) sites(id,name)`);
      await core.migrator.query(`INSERT INTO locations(id,name,cost_center_id) VALUES
        ('60','Testfiliale A','cc60'),('61','Testfiliale B','cc61'),('62','Testfiliale C','cc62'),('63','Testfiliale D','cc63')`);
      const password = "Q7?" + crypto.randomBytes(8).toString("hex");
      const salt = crypto.randomBytes(16);
      const hash = ["scrypt-v1", salt.toString("base64url"),
        crypto.scryptSync(password, salt, 64).toString("base64url")].join("$");
      await core.migrator.query("UPDATE portal_users SET password_hash=$1, must_change_password=0 WHERE employee_number='00001'", [hash]);
      for (const [id, location] of [["91001", "60"], ["91002", "61"], ["91003", "63"]]) {
        await core.migrator.query(`INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,active)
          VALUES ($1,$2,$2,$3,1)`, [id, "Synthetische Testperson " + id, location]);
        await core.migrator.query(`INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password)
          VALUES ($1,$2,'location_planner',1,0)`, [id, hash]);
      }
      Object.assign(process.env, {
        NODE_ENV: "test", DB_PROVIDER: "postgresql", DATABASE_URL: "",
        GRABENPLANER_DATA_DIR: path.join(root, "data"), BACKUP_DIR: path.join(root, "backup"),
        GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_FORCE_PORTAL: "1",
        GRABENPLANER_OPERATION_MODE: "server", GRABENPLANER_PUBLIC_URL: "https://plan.example.test",
        GRABENPLANER_TRUST_PROXY: "loopback", GRABENPLANER_DEPLOYMENT_KIND: "codespaces-test",
        GRABENPLANER_AMU_KEY_ID: "synthetic-location-functions", GRABENPLANER_AMU_KEY: Buffer.alloc(32, 71).toString("base64"),
        GRABENPLANER_INTEGRATION_KEY_ID: "synthetic-migration", GRABENPLANER_INTEGRATION_KEY: Buffer.alloc(32, 78).toString("base64"),
        GRABENPLANER_TEST_AMU_SCANNER: "clean",
      });
      configuration.resolvePersistenceConfiguration = () => ({
        providerId: "postgresql", databasePath: path.join(root, "core.postgresql"), databaseUrlConfigured: true,
        coreUrl: process.env.GP_CORE_APP_URL, salesUrl: process.env.GP_SALES_APP_URL,
        readers: { coreUrl: process.env.GP_CORE_READER_URL, salesUrl: process.env.GP_SALES_READER_URL },
        rehearsal: true, productActivation: false,
      });
      subject = require("../server");
      await subject.initializeApplicationPersistence();
      listener = await new Promise(resolve => {
        const server = subject.app.listen(0, "127.0.0.1", () => resolve(server));
      });
      const base = "http://127.0.0.1:" + listener.address().port;
      async function request(actor, route, status = 200, method = "GET", body) {
        const response = await fetch(base + route, {
          method,
          headers: {
            "Content-Type": "application/json", "X-Forwarded-Proto": "https",
            "X-Forwarded-For": "198.51.100.90", ...actor,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const data = await response.json();
        assert.equal(response.status, status, method + " " + route + " " + (data.code || data.error || ""));
        return { response, data };
      }
      async function login(employeeNumber) {
        const { response } = await request({}, "/api/portal/v1/auth/login", 200, "POST", { employeeNumber, password });
        const cookies = response.headers.getSetCookie().map(cookie => cookie.split(";")[0]);
        return {
          Cookie: cookies.join("; "),
          "X-CSRF-Token": decodeURIComponent(cookies.find(cookie => cookie.startsWith("grabenplaner_csrf=")).split("=")[1]),
        };
      }
      const admin = await login("00001");
      const planner = await login("91001");
      const laterPlanner = await login("91002");
      const rights = "/api/portal/v1/rights/91001/location-functions";
      const revision = (await request(admin, rights)).data.revision;
      const access = {
        scheduleRead: ["18", "60", "61", "62"], scheduleWrite: ["60"],
        vacationPlanning: "all", branchOrders: ["60"], locationSettings: ["60"],
      };
      await request(planner, rights, 403);
      await request(admin, rights, 400, "PUT", { revision, access: { ...access, scheduleWrite: ["63"] } });
      await request(admin, rights, 200, "PUT", { revision, access });
      await request(admin, rights, 409, "PUT", { revision, access });
      assert.deepEqual((await request(planner, "/api/portal/v1/session")).data.user.locationFunctions, access);
      assert.doesNotMatch(JSON.stringify((await request(admin, "/api/settings")).data), /portal_location_functions_v1/);

      for (const id of access.scheduleRead) {
        await request(planner, "/api/schedule?fast=1&location=" + id);
      }
      await request(planner, "/api/schedule?fast=1&location=63", 403);
      await request(planner, "/api/SCHEDULE?fast=1&location=63", 403);
      const weekStart = (await request(planner, "/api/schedule?fast=1&location=60")).data.weekStart;
      const lock = { weekStart, locked: true, expectedRevision: 0 };
      await request(planner, "/api/schedule/manual-lock", 403, "PUT", { ...lock, locationId: "61" });
      await request(planner, "/api/schedule/manual-lock", 200, "PUT", { ...lock, locationId: "60" });
      await request(admin, "/api/schedule?fast=1&location=63");
      await request(planner, "/api/vacations?location=63");
      await request(admin, "/api/vacations?location=63");
      const vacationDate = new Date(Date.parse(weekStart + "T12:00:00Z") + 14 * 86400000).toISOString().slice(0, 10);
      const vacation = await request(planner, "/api/vacations", 201, "POST", {
        employeeNumber: "91003", dateFrom: vacationDate, dateTo: vacationDate, locationId: "63",
      });
      assert.ok(vacation.data.groupId);

      const settings = "/api/portal/v1/branch-orders/settings";
      const orderSettings = (await request(planner, settings)).data;
      assert.equal(orderSettings.locationId, "60");
      await request(planner, settings, 200, "PUT", {
        locationId: "60", configuration: orderSettings.configuration, expectedVersion: orderSettings.configurationVersion,
      });
      await request(planner, settings + "?locationId=61", 403);
      await request(planner, settings, 403, "PUT", { locationId: "61" });
      await request(planner, "/api/portal/v1/branch-orders/history?locationId=61", 403);
      await request(admin, settings + "?locationId=61");
      await request(planner, "/api/locations/61", 403, "PUT", { minStaff: 2 });
      await request(planner, "/api/locations/%36%31", 403, "PUT", { minStaff: 2 });
      const daySettings = Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
        .map(day => [day, { open: day !== "saturday", start: "09:00", end: "18:00",
          lunchEnabled: true, lunchStart: "14:00", lunchEnd: "14:30" }]));
      const branches = (await request(planner, "/api/locations/60", 200, "PUT", { minStaff: 2, daySettings })).data;
      const location = branches.find(entry => entry.id === "60");
      assert.equal(location.min_staff, 2);
      assert.equal(location.day_settings.monday.lunchEnd, "14:30");

      const laterRights = "/api/portal/v1/rights/91002/location-functions";
      const later = (await request(admin, laterRights)).data;
      assert.deepEqual(later.access, {});
      await request(admin, laterRights, 200, "PUT", {
        revision: later.revision, access: { scheduleRead: ["61", "62"], scheduleWrite: ["61", "62"] },
      });
      await request(laterPlanner, "/api/schedule?fast=1&location=62");
      await request(laterPlanner, "/api/schedule/manual-lock", 200, "PUT", { ...lock, locationId: "62" });
      await request(laterPlanner, settings + "?locationId=62", 403);
    } finally {
      if (listener) await new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); });
      await subject?.closePersistenceForTests();
      subject?.releaseInstanceLockForTests();
      configuration.resolvePersistenceConfiguration = originalConfiguration;
      assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }));
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  createSqliteApplicationSeedingOperations,
} = require("../lib/persistence/sqlite/operations/application-seeding");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

const PLANNING_DAYS = Object.freeze([
  ["monday", "09:00", "18:00"],
  ["tuesday", "09:00", "18:00"],
  ["wednesday", "09:00", "18:00"],
  ["thursday", "09:00", "18:00"],
  ["friday", "09:00", "18:00"],
  ["saturday", "10:00", "17:00"],
]);

function defaultSettings() {
  const settings = {
    toast_duration: "medium",
    branding_company_name: "Grabenplaner",
  };
  for (const [day, start, end] of PLANNING_DAYS) {
    settings[`${day}_open`] = "1";
    settings[`${day}_start_time`] = start;
    settings[`${day}_end_time`] = end;
    settings[`${day}_lunch_enabled`] = "0";
    settings[`${day}_lunch_start`] = "13:00";
    settings[`${day}_lunch_end`] = "14:00";
    settings[`${day}_min_staff`] = "0";
    settings[`${day}_min_from`] = start;
    settings[`${day}_min_to`] = end;
  }
  return settings;
}

function fixture() {
  const database = openSqliteLegacyDatabase(":memory:");
  ensureSqliteApplicationSchema(database);
  database.prepare(`
    INSERT INTO locations (id, name, day_settings_json, active)
    VALUES ('01', 'Hauptstandort', '', 1)
  `).run();
  return {
    database,
    seeding: createSqliteApplicationSeedingOperations(database),
  };
}

test("Block 3/7: Default-, Positions- und Rollen-Seeding ist idempotent", () => {
  const { database, seeding } = fixture();
  try {
    database.prepare("INSERT INTO settings (key, value) VALUES ('toast_duration', 'long')").run();
    const roles = [{
      id: "developer",
      name: "Developer",
      description: "Technische Rolle",
      permissions: ["system:read"],
      sortOrder: 10,
    }, {
      id: "employee",
      name: "Mitarbeitende",
      description: "Portalrolle",
      permissions: ["own_schedule:read"],
      sortOrder: 20,
    }];

    const first = seeding.seedApplicationDefaults({
      defaultSettings: defaultSettings(),
      planningDays: PLANNING_DAYS,
      builtinPortalRoles: roles,
    });
    const firstCounts = {
      settings: database.prepare("SELECT COUNT(*) AS count FROM settings").get().count,
      positions: database.prepare("SELECT COUNT(*) AS count FROM positions").get().count,
      roles: database.prepare("SELECT COUNT(*) AS count FROM portal_roles").get().count,
    };
    const second = seeding.seedApplicationDefaults({
      defaultSettings: defaultSettings(),
      planningDays: PLANNING_DAYS,
      builtinPortalRoles: roles,
    });

    assert.deepEqual({
      settings: database.prepare("SELECT COUNT(*) AS count FROM settings").get().count,
      positions: database.prepare("SELECT COUNT(*) AS count FROM positions").get().count,
      roles: database.prepare("SELECT COUNT(*) AS count FROM portal_roles").get().count,
    }, firstCounts);
    assert.equal(
      database.prepare("SELECT value FROM settings WHERE key = 'toast_duration'").get().value,
      "long",
    );
    assert.equal(
      database.prepare("SELECT permissions FROM portal_roles WHERE id = 'developer'").get().permissions,
      JSON.stringify(["system:read"]),
    );
    assert.deepEqual(second.legacyDaySettingsSnapshot(), first.legacyDaySettingsSnapshot());
    assert.equal(database.prepare("SELECT app_version FROM schema_migrations WHERE id='developer-permission-defaults-v1'").get().app_version, "0.92.32-beta");
    const runtime = { format: "grabenplaner-linux-runtime-contract", schemaVersion: 1, deploymentSchemaVersion: 1 };
    const current = require("../package.json");
    assert.equal(require("../server-tools/linux/recovery/lib/recovery-verify").assertCompatibility(database, current, current, runtime, runtime).targetVersion, current.version);
    assert.equal(
      JSON.parse(database.prepare("SELECT day_settings_json FROM locations WHERE id = '01'").get().day_settings_json)
        .saturday.end,
      "17:00",
    );
  } finally {
    database.close();
  }
});

test("Block 3/7: Standard-Demoseeding laeuft hoechstens einmal", () => {
  const { database, seeding } = fixture();
  try {
    seeding.seedDemoIfRequested({
      enabled: true,
      demoProfile: "",
      appVersion: "0.87-test",
      planningDays: PLANNING_DAYS,
      sporthandelProfilePath: "nicht-verwendet.json",
    });
    seeding.seedDemoIfRequested({
      enabled: true,
      demoProfile: "",
      appVersion: "0.87-test",
      planningDays: PLANNING_DAYS,
      sporthandelProfilePath: "nicht-verwendet.json",
    });

    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM employees").get().count, 6);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM employees WHERE home_location_id = '01'").get().count,
      6,
    );
  } finally {
    database.close();
  }
});

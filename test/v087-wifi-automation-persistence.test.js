"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createWifiAutomationRepository,
} = require("../lib/persistence/repositories/wifi-automation");
const {
  SQLITE_WIFI_AUTOMATION_CATALOG,
} = require("../lib/persistence/sqlite/wifi-automation-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  WIFI_AUTOMATION_STATEMENTS,
} = require("../lib/persistence/statements/wifi-automation");


test("Block 3/7: WLAN-Katalog deckt jedes typisierte Statement genau einmal ab", () => {
  const statements = Object.values(WIFI_AUTOMATION_STATEMENTS);
  assert.equal(SQLITE_WIFI_AUTOMATION_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_WIFI_AUTOMATION_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_WIFI_AUTOMATION_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

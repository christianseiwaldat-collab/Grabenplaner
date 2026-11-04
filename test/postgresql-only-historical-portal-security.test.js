"use strict";
const test = require("node:test");
const { runHistoricalServerTest } = require("../test-support/historical-server-tests");
test("Historische HTTPS-/USB-/Backup- und Bereichsrechte-Verträge bleiben im unveränderten SQLite-Stand prüfbar", () => {
  runHistoricalServerTest("test/portal-foundation.test.js");
});

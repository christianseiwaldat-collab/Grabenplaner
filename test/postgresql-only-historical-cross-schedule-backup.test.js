"use strict";
const test = require("node:test");
const { runHistoricalServerTest } = require("../test-support/historical-server-tests");
test("Original SQLite request-history and birthday backup restore is retained unchanged", { timeout: 240000 }, () => {
  runHistoricalServerTest("test/cross-location-schedule-view-api.test.js");
});

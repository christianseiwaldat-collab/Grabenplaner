"use strict";
const test = require("node:test");
const { runHistoricalServerTest } = require("../test-support/historical-server-tests");
test("Original SQLite sales-report backup and immutable restore is retained unchanged", { timeout: 240000 }, () => {
  runHistoricalServerTest("test/sales-analytics-production-hardening.test.js");
});

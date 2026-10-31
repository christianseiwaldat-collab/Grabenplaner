"use strict";
const test = require("node:test");
const { runHistoricalServerTest } = require("../test-support/historical-server-tests");
test("Original SQLite unsigned legacy receipt migration is retained unchanged", { timeout: 240000 }, () => {
  runHistoricalServerTest("test/v081-work-rule-safety-regressions.test.js");
});

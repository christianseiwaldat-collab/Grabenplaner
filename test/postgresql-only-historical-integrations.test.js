"use strict";
const test = require("node:test");
const { runHistoricalServerTest } = require("../test-support/historical-server-tests");
test("immutable historical integration-module upgrade compatibility", { timeout: 210000 }, () => {
  runHistoricalServerTest("test/v063-import-payroll.test.js");
});

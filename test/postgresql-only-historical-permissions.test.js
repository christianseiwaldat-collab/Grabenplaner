"use strict";
const test = require("node:test");
const { runHistoricalServerTest } = require("../test-support/historical-server-tests");
test("immutable historical permission-guard and version-repair compatibility", { timeout: 210000 }, () => {
  runHistoricalServerTest("test/portal-permission-defaults.test.js");
});

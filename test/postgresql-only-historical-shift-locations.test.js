"use strict";
const test = require("node:test");
const { runHistoricalServerTest } = require("../test-support/historical-server-tests");
test("immutable historical shift-location upgrade compatibility", { timeout: 210000 }, () => {
  runHistoricalServerTest("test/v071-shift-locations.test.js");
});

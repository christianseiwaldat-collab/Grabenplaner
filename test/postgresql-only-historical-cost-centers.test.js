"use strict";
const test = require("node:test");
const { runHistoricalServerTest } = require("../test-support/historical-server-tests");
test("immutable historical cost-center upgrade compatibility", { timeout: 210000 }, () => {
  runHistoricalServerTest("test/v071-cost-centers-personnel.test.js");
});

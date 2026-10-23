"use strict";
const test = require("node:test");
const { runHistoricalServerTest } = require("../test-support/historical-server-tests");
test("historical SQLite bootstrap fixture keeps its bounded writer coordination", { timeout: 210000 }, () => runHistoricalServerTest("test/v072-production-bootstrap.test.js"));

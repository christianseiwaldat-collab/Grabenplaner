"use strict";
const test = require("node:test");
const { runHistoricalServerTest } = require("../test-support/historical-server-tests");

test("Original plaintext personnel upgrade and six SQLite import rejection contracts remain unchanged", { timeout: 240000 }, () => {
  runHistoricalServerTest("test/v058-personnel-rights-encryption.test.js");
});

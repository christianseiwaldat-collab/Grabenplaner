"use strict";
const test = require("node:test");
const { runHistoricalServerTest } = require("../test-support/historical-server-tests");
// This file contains only the original SQLite-format upgrade/recovery contract.
// The unchanged assertions execute against the immutable pre-retirement source.
test("immutable historical migration: v087-block5-loan-photo-migration.test.js", { timeout: 210000 }, () => runHistoricalServerTest("test/v087-block5-loan-photo-migration.test.js"));

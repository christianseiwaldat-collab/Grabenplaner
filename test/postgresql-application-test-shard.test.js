"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { applicationTestShard } = require("../test-support/postgresql-migration/application-test-shard.cjs");

test("full application sharding uses all three fixed native Node partitions and keeps ordinary full runs", () => {
  assert.equal(applicationTestShard(["--full"]), null);
  assert.equal(applicationTestShard(["--bootstrap-only"]), null);
  for (const shard of ["1/3", "2/3", "3/3"]) assert.equal(applicationTestShard(["--full", "--application-shard", shard]), shard);
});

test("invalid, duplicate or diagnostic shard selections fail before any database setup", () => {
  for (const value of ["", "0/3", "4/3", "1/1", "1/4", "01/3", "1/3 --test-only", "../1/3"]) {
    assert.throws(() => applicationTestShard(["--full", "--application-shard", value]), /Explicit full application shard/);
  }
  for (const args of [
    ["--application-shard", "1/3"],
    ["--full", "--application-shard"],
    ["--full", "--application-shard", "1/3", "--application-shard", "2/3"],
    ["--full", "--bootstrap-only", "--application-shard", "1/3"],
    ["--full", "--diagnostic-api", "reports", "--application-shard", "1/3"],
  ]) assert.throws(() => applicationTestShard(args), /Explicit full application shard/);
});

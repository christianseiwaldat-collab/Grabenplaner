"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { assertSyntheticEndpoint } = require("../test-support/postgresql-migration/ci-endpoint");

test("native CI endpoint guard requires the disposable service and restricted fixture roles", () => {
  const env = { CI: "true", GITHUB_ACTIONS: "true",
    GP_CI_POSTGRESQL_FIXTURE: "github-actions-service-v1",
    TEST_POSTGRESQL_URL: "postgresql://postgres:synthetic@127.0.0.1:5432/grabenplaner_test" };
  const url = "postgresql://gp_core_app:synthetic@127.0.0.1:5432/gp_migration_core";
  assert.equal(assertSyntheticEndpoint(url, "core", ["55487"], env).port, "5432");
  for (const changed of [
    { CI: "false" }, { GITHUB_ACTIONS: "false" },
    { GP_CI_POSTGRESQL_FIXTURE: "" },
    { TEST_POSTGRESQL_URL: env.TEST_POSTGRESQL_URL.replace("127.0.0.1", "example.invalid") },
    { TEST_POSTGRESQL_URL: env.TEST_POSTGRESQL_URL.replace("grabenplaner_test", "production") },
  ]) assert.throws(() => assertSyntheticEndpoint(url, "core", ["55487"], { ...env, ...changed }));
  for (const value of [
    url.replace("127.0.0.1", "example.invalid"),
    url.replace("gp_migration_core", "grabenplaner_core"),
    url.replace("gp_core_app", "postgres"),
    url.replace("5432", "5433"),
  ]) assert.throws(() => assertSyntheticEndpoint(value, "core", ["55487"], env));
  assert.equal(assertSyntheticEndpoint(url.replace("5432", "55487"), "core", ["55487"], {}).port, "55487");
});

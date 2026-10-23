"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { translate, splitStatements } = require("../test-support/postgresql-api/sql");
const { assertSyntheticEnvironment } = require("../test-support/postgresql-api/guard");

test("PostgreSQL API fixture binds values without changing quoted parameter-looking text", () => {
  const result = translate("SELECT '?' AS literal, '$secret' AS marker FROM employees WHERE personnel_number=? AND full_name=?", ["101", "Synthetic"]);
  assert.equal(result.domain, "core");
  assert.deepEqual(result.values, ["101", "Synthetic"]);
  assert.match(result.sql, /'\?' AS literal/);
  assert.match(result.sql, /'\$secret' AS marker/);
  assert.match(result.sql, /personnel_number = \$1/);
  assert.throws(() => translate("SELECT id FROM employees WHERE personnel_number=?", []), /PARAMETER_COUNT/);
});

test("fixture writes route to the actual PostgreSQL database and reject mixed-database joins", () => {
  assert.equal(translate("INSERT INTO employees(personnel_number,full_name) VALUES(?,?)", ["101", "Synthetic"]).domain, "core");
  const sales = translate("SELECT id FROM sales_articles WHERE article_number=?", ["00001"]);
  assert.equal(sales.domain, "sales");
  assert.match(sales.sql, /trade/);
  assert.throws(() => translate("SELECT e.id FROM employees e JOIN sales_articles a ON a.id=e.id"), /MIXED_DATABASE/);
  assert.throws(() => translate("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", ["synthetic", "value"]), /EXPLICIT_UPSERT/);
});

test("fixture statement splitting preserves literals and refuses implicit endpoint authority", () => {
  assert.equal(splitStatements("SELECT 'a;b'; SELECT 'c'").length, 2);
  assert.throws(() => assertSyntheticEnvironment({}), /EXPLICIT_SYNTHETIC/);
  const environment = { GP_PG_API_FIXTURE_BRIDGE: "1", GP_CI_POSTGRESQL_FIXTURE: "github-actions-service-v1", CI: "true", GITHUB_ACTIONS: "true",
    TEST_POSTGRESQL_URL: "postgresql://postgres:synthetic@127.0.0.1:5432/grabenplaner_test" };
  for (const domain of ["core", "sales"]) for (const purpose of ["app", "reader", "migrator"]) {
    environment[`GP_${domain.toUpperCase()}_${purpose.toUpperCase()}_URL`] = `postgresql://gp_${domain}_${purpose}:synthetic@127.0.0.1:5432/gp_migration_${domain}`;
  }
  assert.equal(assertSyntheticEnvironment(environment), true);
  for (const replacement of ["postgresql://postgres@127.0.0.1:5432/grabenplaner_core", "postgresql://postgres@production.invalid:5432/grabenplaner_test", "postgresql://postgres@127.0.0.1:5433/grabenplaner_test"]) {
    assert.throws(() => assertSyntheticEnvironment({ ...environment, TEST_POSTGRESQL_URL: replacement }), /SYNTHETIC_ENDPOINT/);
  }
  assert.throws(() => assertSyntheticEnvironment({ ...environment, GITHUB_ACTIONS: "false" }), /EXPLICIT_SYNTHETIC/);
});

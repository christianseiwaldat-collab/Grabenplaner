"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { translate, splitStatements } = require("../test-support/postgresql-api/sql");
const { assertSyntheticEnvironment } = require("../test-support/postgresql-api/guard");
const { isTechnicalRelation } = require("../test-support/postgresql-api/ownership");

test("fixture ownership preserves only explicitly reviewed infrastructure relations", () => {
  assert.equal(isTechnicalRelation("sales", "gp", "import_delete_performance_history"), true);
  assert.equal(isTechnicalRelation("core", "gp", "import_delete_performance_history"), false);
  assert.equal(isTechnicalRelation("sales", "trade", "import_delete_performance_history"), false);
  assert.equal(isTechnicalRelation("sales", "gp", "unreviewed_migration_history"), false);
  assert.equal(isTechnicalRelation("core", "gp", "employees"), false);
});

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

test("native catalog assertions preserve physical Core boundary names and PostgreSQL booleans", () => {
  const result = translate("SELECT TRUE FROM gp.import_master_bindings WHERE binding_key=?", ["synthetic"], { postgresqlDomain: "core" });
  assert.equal(result.domain, "core");
  assert.match(result.sql, /gp \. import_master_bindings/);
  assert.doesNotMatch(result.sql, /trade\./);
  assert.match(result.sql, /SELECT TRUE/);
  assert.deepEqual(result.values, ["synthetic"]);
  assert.throws(() => translate("SELECT 1", [], { postgresqlDomain: "unknown" }), /CATALOG_DOMAIN/);
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


test("fixture startup barrier delays fixture seeds and requests until real initialization completes", async () => {
  const { registerStartupBarrier } = require("../test-support/postgresql-api/preload");
  const callbacks = [], effects = [], fakeTest = { before(callback) { callbacks.push(callback); } };
  let release, initialized = 0;
  const gate = new Promise(resolve => { release = resolve; });
  registerStartupBarrier(fakeTest, async () => { initialized += 1; await gate; effects.push("initialized"); });
  fakeTest.before(() => { effects.push("seed"); });
  fakeTest.before(() => { effects.push("http"); });
  const running = callbacks.map(callback => callback());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(initialized, 1); assert.deepEqual(effects, []);
  release(); await Promise.all(running);
  assert.deepEqual(effects, ["initialized", "seed", "http"]);
});

test("fixture startup failure never releases seed or request callbacks", async () => {
  const { registerStartupBarrier } = require("../test-support/postgresql-api/preload");
  const callbacks = [], effects = [], fakeTest = { before(callback) { callbacks.push(callback); } };
  const failure = new Error("synthetic actual startup rejected");
  let initialized = 0;
  registerStartupBarrier(fakeTest, async () => { initialized += 1; throw failure; });
  fakeTest.before(() => { effects.push("seed"); });
  fakeTest.before(() => { effects.push("http"); });
  const results = await Promise.allSettled(callbacks.map(callback => callback()));
  assert.equal(initialized, 1); assert.deepEqual(effects, []);
  assert.equal(results.length, 3);
  for (const result of results) { assert.equal(result.status, "rejected"); assert.equal(result.reason, failure); }
});

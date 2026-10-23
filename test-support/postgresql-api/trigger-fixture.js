"use strict";

// Explicit failure/race injection for synthetic current-server tests. It uses
// the reviewed PostgreSQL trigger compiler; application triggers stay enabled.
const assert = require("node:assert/strict");
const S = require("../../lib/persistence/postgresql/core/sql");
const { trigger } = require("../../lib/persistence/postgresql/core/schema");
const metadata = require("./metadata");
const layout = require("../../lib/persistence/postgresql/sales/layout");
const salesTables = new Map(layout.stageTables(8).map(table => [table.name, table]));
const installed = new WeakMap();
const quote = value => '"' + value.replaceAll('"', '""') + '"';

function installFixtureTrigger(db, sql, { attemptCounter } = {}) {
  assert.equal(db.postgresqlTestFixture, true);
  const tokens = S.tokens(sql);
  assert.equal(tokens[0]?.toUpperCase(), "CREATE");
  assert.equal(tokens[1]?.toUpperCase(), "TRIGGER");
  const name = S.name(tokens[2]);
  assert.match(name, /^(?:test_|maternity_)[a-z0-9_]+$/);
  const on = tokens.findIndex(token => token.toUpperCase() === "ON");
  const table = S.name(tokens[on + 1]);
  const physical = salesTables.get(table) || { name: table, schema: "gp" };
  const domain = salesTables.has(table) ? "sales" : "core";
  assert.match(table, /^[a-z_][a-z0-9_]*$/);
  assert.ok(metadata.tableExists(db, table), "fixture trigger table must already exist");
  assert.equal(metadata.triggerByName(db, name, { domain }), undefined, "fixture trigger cannot replace an application guard");
  // The migration compiler expects one complete trigger without a trailing
  // SQL terminator. Function bodies remain a single quoted PostgreSQL string,
  // so the seed statement splitter never treats their semicolons as commands.
  const plan = trigger({ name, table_name: table, sql: String(sql).trim().replace(/;\s*$/, "") });
  const functionName = /^CREATE FUNCTION gp\."([a-z0-9_]+)"\(\)/.exec(plan[0].sql)?.[1];
  assert.ok(functionName);
  let functionCreated = false;
  try {
    for (const step of plan) {
      let compiled = step.sql;
      if (attemptCounter && step.id === name + ":function") {
        assert.equal(domain, "core");
        assert.match(attemptCounter.sequence, /^test_attempt_[a-f0-9]{16}$/);
        compiled = compiled.replace("AS $gp_trigger$ BEGIN", "AS $gp_trigger$ BEGIN PERFORM pg_catalog.nextval('gp." + attemptCounter.sequence + "'::regclass);");
      }
      const native = domain === "sales" ? layout.qualify(compiled).replace(/SET search_path = pg_catalog , gp/, "SET search_path = " + layout.SEARCH_PATH) : compiled;
      const statement = native.replace(/\$gp_trigger\$([\s\S]*)\$gp_trigger\$/, (_match, body) => "'" + body.replaceAll("'", "''") + "'");
      db.postgresqlFixtureDdl(domain, statement); functionCreated = true;
    }
  } catch (error) {
    if (functionCreated) db.postgresqlFixtureDdl(domain, "DROP FUNCTION gp." + quote(functionName) + "()");
    throw error;
  }
  if (!installed.has(db)) installed.set(db, new Map());
  installed.get(db).set(name, { table: physical.name, schema: physical.schema, domain, functionName });
  return () => dropFixtureTrigger(db, name);
}

function dropFixtureTrigger(db, name, { ifExists = false } = {}) {
  const definition = installed.get(db)?.get(name);
  if (!definition) {
    if (ifExists) return;
    throw new Error("PG_TEST_TRIGGER_NOT_OWNED: " + name);
  }
  db.postgresqlFixtureDdl(definition.domain, "DROP TRIGGER " + (ifExists ? "IF EXISTS " : "") + quote(name) + " ON " + quote(definition.schema) + "." + quote(definition.table));
  db.postgresqlFixtureDdl(definition.domain, "DROP FUNCTION gp." + quote(definition.functionName) + "()");
  installed.get(db).delete(name);
}

// Only explicit synthetic tamper/reset cases suspend a named existing guard.
// Its actual PostgreSQL definition is restored byte-for-byte, never replaced by
// a newly compiled approximation. Rollback of an enclosing fixture transaction
// also restores the original trigger automatically.
function suspendFixtureGuards(db, names, { domain = "core" } = {}) {
  assert.equal(db.postgresqlTestFixture, true);
  assert.ok(Array.isArray(names) && names.length > 0);
  const guards = names.map(name => {
    assert.match(name, /^trg_[a-z0-9_]+$/);
    const guard = metadata.triggerByName(db, name, { domain });
    assert.ok(guard?.definition, "application guard must exist: " + name);
    assert.ok(["gp", "trade", "reporting", "integration", "kassa"].includes(guard.schema));
    return guard;
  });
  for (const guard of guards) db.postgresqlFixtureDdl(domain,
    "DROP TRIGGER " + quote(guard.name) + " ON " + quote(guard.schema) + "." + quote(guard.table));
  return () => {
    for (const guard of guards) {
      db.postgresqlFixtureDdl(domain, guard.definition);
      assert.equal(metadata.triggerByName(db, guard.name, { domain }).definition, guard.definition);
    }
  };
}

// PostgreSQL sequence increments survive rollback, giving the same independent
// attempt witness as the former test-only SQLite callback. No business record
// is committed to manufacture evidence of an aborted application transaction.
function createFixtureAttemptCounter(db) {
  assert.equal(db.postgresqlTestFixture, true);
  const sequence = "test_attempt_" + require("node:crypto").randomBytes(8).toString("hex");
  db.postgresqlFixtureDdl("core", "CREATE SEQUENCE gp." + quote(sequence));
  return Object.freeze({ sequence,
    count: () => db.postgresqlCatalogQuery("core", "SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS count FROM gp." + quote(sequence))[0].count,
    close: () => db.postgresqlFixtureDdl("core", "DROP SEQUENCE gp." + quote(sequence)),
  });
}

module.exports = { createFixtureAttemptCounter, dropFixtureTrigger, installFixtureTrigger, suspendFixtureGuards };

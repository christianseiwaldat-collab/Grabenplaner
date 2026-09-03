"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  POSTGRESQL_APPLICATION_DIALECT_FIXTURE,
  SQLITE_APPLICATION_DIALECT_MANIFEST,
  sqliteDialectFeatures,
} = require("../lib/persistence/dialects/application-manifest");
const {
  SQLITE_APPLICATION_CATALOG,
} = require("../lib/persistence/sqlite/application-catalog");

test("Block 4/7: alle Anwendungsstatements besitzen genau eine SQLite-Dialektbindung", () => {
  assert.equal(SQLITE_APPLICATION_CATALOG.length, 1148);
  assert.equal(
    SQLITE_APPLICATION_DIALECT_MANIFEST.entries.length,
    SQLITE_APPLICATION_CATALOG.length,
  );
  assert.equal(
    new Set(SQLITE_APPLICATION_DIALECT_MANIFEST.entries.map((entry) => entry.statement.id)).size,
    SQLITE_APPLICATION_CATALOG.length,
  );

  for (let index = 0; index < SQLITE_APPLICATION_CATALOG.length; index += 1) {
    const catalogEntry = SQLITE_APPLICATION_CATALOG[index];
    const dialectEntry = SQLITE_APPLICATION_DIALECT_MANIFEST.entries[index];
    assert.equal(dialectEntry.statement, catalogEntry.statement);
    assert.equal(dialectEntry.sql, catalogEntry.sql);
    assert.equal(dialectEntry.returning, catalogEntry.returning);
    assert.equal(dialectEntry.owner, catalogEntry.statement.id.split(".")[0]);
    if (dialectEntry.classification === "sqlite-baseline") {
      assert.deepEqual(dialectEntry.features, []);
    } else {
      assert.equal(dialectEntry.classification, "dialect-variant");
      assert.ok(dialectEntry.features.length > 0);
    }
  }
});

test("Block 4/7: bekannte SQLite-Syntax wird nicht als SQLite-Baseline ausgegeben", () => {
  const byId = new Map(
    SQLITE_APPLICATION_DIALECT_MANIFEST.entries
      .map((entry) => [entry.statement.id, entry]),
  );

  assert.equal(byId.get("ui-preferences.get").classification, "dialect-variant");
  assert.ok(
    byId.get("ui-preferences.get").features
      .includes("sqlite.named-dollar-parameters"),
  );
  assert.ok(
    byId.get("ui-preferences.upsert").features.includes("sqlite.upsert-clause"),
  );
  assert.ok(
    byId.get("loan-module.has-live-portal-session").features
      .includes("sqlite.julianday-function"),
  );
  assert.ok(
    SQLITE_APPLICATION_DIALECT_MANIFEST.entries
      .some((entry) => entry.features.includes("sqlite.json-functions")),
  );
});

test("Block 4/7: benannte Dollar-Parameter sind ein explizites SQLite-Dialektmerkmal", () => {
  assert.deepEqual(
    sqliteDialectFeatures("SELECT value FROM records WHERE id = $recordId"),
    ["sqlite.named-dollar-parameters"],
  );
  assert.deepEqual(
    sqliteDialectFeatures("SELECT '$not_a_runtime_parameter'"),
    ["sqlite.named-dollar-parameters"],
  );
  assert.deepEqual(sqliteDialectFeatures("SELECT value FROM records"), []);

  for (const entry of SQLITE_APPLICATION_DIALECT_MANIFEST.entries) {
    if (/\$[A-Za-z_][A-Za-z0-9_]*/.test(entry.sql)) {
      assert.equal(entry.classification, "dialect-variant", entry.statement.id);
      assert.ok(
        entry.features.includes("sqlite.named-dollar-parameters"),
        entry.statement.id,
      );
    }
  }
});

test("Block 4/7: PostgreSQL bleibt eine deckungsgleiche, nicht ausführbare Plan-Fixture", () => {
  const fixture = POSTGRESQL_APPLICATION_DIALECT_FIXTURE;
  assert.equal(fixture.dialectId, "postgresql");
  assert.equal(fixture.sourceDialectId, "sqlite");
  assert.equal(fixture.status, "contract-only");
  assert.equal(fixture.executable, false);
  assert.equal(fixture.entries.length, 1148);
  assert.equal(fixture.sourceFingerprint, SQLITE_APPLICATION_DIALECT_MANIFEST.fingerprint);

  for (let index = 0; index < fixture.entries.length; index += 1) {
    const planned = fixture.entries[index];
    const sqlite = SQLITE_APPLICATION_DIALECT_MANIFEST.entries[index];
    assert.equal(planned.statementId, sqlite.statement.id);
    assert.equal(planned.owner, sqlite.owner);
    assert.equal(planned.classification, sqlite.classification);
    assert.deepEqual(planned.requiredFeatures, sqlite.features);
    assert.equal(planned.status, "contract-only");
    assert.equal(Object.hasOwn(planned, "sql"), false);
    assert.equal(Object.hasOwn(planned, "execute"), false);
  }
});

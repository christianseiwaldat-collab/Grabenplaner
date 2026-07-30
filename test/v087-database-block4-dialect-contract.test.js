"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  definePersistenceStatement,
} = require("../lib/persistence/contract");
const {
  PLANNED_DIALECT_STATUS,
  defineDialectManifest,
  definePlannedDialectFixture,
} = require("../lib/persistence/dialects/contract");

function sampleStatement(id = "sample-domain.read") {
  return definePersistenceStatement({
    id,
    operation: "queryOne",
    parameters: { id: "text" },
    columns: { value: "text" },
  });
}

function sampleManifest() {
  return defineDialectManifest({
    dialectId: "sqlite",
    executable: true,
    entries: [{
      statement: sampleStatement(),
      owner: "sample-domain",
      classification: "sqlite-baseline",
      features: [],
      sql: "SELECT value FROM sample_values",
      returning: false,
    }],
  });
}

test("Block 4/7: Dialektmanifest bindet SQL eindeutig an neutrale Statementverträge", () => {
  const manifest = sampleManifest();

  assert.equal(manifest.contractVersion, 2);
  assert.equal(manifest.dialectId, "sqlite");
  assert.equal(manifest.executable, true);
  assert.match(manifest.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.entries), true);
  assert.equal(Object.isFrozen(manifest.entries[0].features), true);

  assert.throws(
    () => defineDialectManifest({
      dialectId: "sqlite",
      executable: true,
      entries: [{
        statement: sampleStatement("sample-domain.invalid"),
        owner: "sample-domain",
        classification: "sqlite-baseline",
        features: ["sqlite.upsert-clause"],
        sql: "SELECT value FROM sample_values",
        returning: false,
      }],
    }),
    /Klassifikation und Dialektmerkmale/,
  );
});

test("Block 4/7: geplante Dialekt-Fixture ist vollständig, aber niemals ausführbar", () => {
  const sourceManifest = sampleManifest();
  const fixture = definePlannedDialectFixture({
    dialectId: "postgresql",
    sourceManifest,
    entries: [{
      statementId: "sample-domain.read",
      owner: "sample-domain",
      classification: "sqlite-baseline",
      requiredFeatures: [],
      status: PLANNED_DIALECT_STATUS,
    }],
  });

  assert.equal(fixture.status, "contract-only");
  assert.equal(fixture.executable, false);
  assert.equal(Object.hasOwn(fixture.entries[0], "sql"), false);
  assert.equal(Object.hasOwn(fixture.entries[0], "statement"), false);
  assert.throws(
    () => definePlannedDialectFixture({
      dialectId: "postgresql",
      sourceManifest,
      entries: [],
    }),
    /deckt das Quellmanifest nicht ab/,
  );
});

test("Block 4/7: strukturell nachgebaute Statementobjekte werden nicht als Verträge akzeptiert", () => {
  const real = sampleStatement();
  const forged = Object.freeze({
    id: real.id,
    operation: real.operation,
    parameters: real.parameters,
    columns: real.columns,
  });

  assert.throws(
    () => defineDialectManifest({
      dialectId: "sqlite",
      executable: true,
      entries: [{
        statement: forged,
        owner: "sample-domain",
        classification: "sqlite-baseline",
        features: [],
        sql: "SELECT value FROM sample_values",
        returning: false,
      }],
    }),
    /Statementvertrag/,
  );
});

test("Block 4/7: Fingerprint bindet Operation, Parameter- und Ergebnisvertrag", () => {
  function manifestFor(statement) {
    return defineDialectManifest({
      dialectId: "sqlite",
      executable: true,
      entries: [{
        statement,
        owner: "sample-domain",
        classification: "sqlite-baseline",
        features: [],
        sql: "SELECT value FROM sample_values",
        returning: false,
      }],
    });
  }

  const baseline = manifestFor(definePersistenceStatement({
    id: "sample-domain.fingerprint",
    operation: "queryOne",
    parameters: { id: "text" },
    columns: { value: "text" },
  }));
  const changedOperation = manifestFor(definePersistenceStatement({
    id: "sample-domain.fingerprint",
    operation: "queryAll",
    parameters: { id: "text" },
    columns: { value: "text" },
  }));
  const changedParameter = manifestFor(definePersistenceStatement({
    id: "sample-domain.fingerprint",
    operation: "queryOne",
    parameters: { id: "safe_integer" },
    columns: { value: "text" },
  }));
  const changedResult = manifestFor(definePersistenceStatement({
    id: "sample-domain.fingerprint",
    operation: "queryOne",
    parameters: { id: "text" },
    columns: { value: { kind: "text", nullable: true } },
  }));

  assert.notEqual(baseline.fingerprint, changedOperation.fingerprint);
  assert.notEqual(baseline.fingerprint, changedParameter.fingerprint);
  assert.notEqual(baseline.fingerprint, changedResult.fingerprint);
});

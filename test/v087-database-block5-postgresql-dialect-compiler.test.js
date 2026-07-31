"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  definePersistenceStatement,
} = require("../lib/persistence/contract");
const {
  POSTGRESQL_DIALECT_COMPILER_VERSION,
  compilePostgresqlDialectEntry,
} = require("../lib/persistence/postgresql/dialect-compiler");
const {
  SQLITE_APPLICATION_CATALOG,
} = require("../lib/persistence/sqlite/application-catalog");

function statement({
  id = "compiler.sample",
  operation = "queryAll",
  parameters = {},
  columns = { value: "text" },
} = {}) {
  return definePersistenceStatement({
    id,
    operation,
    parameters,
    columns,
  });
}

function compile(sourceStatement, sql, returning = false) {
  return compilePostgresqlDialectEntry({
    statement: sourceStatement,
    sql,
    returning,
  });
}

test("Block 5/7: benannte Parameter werden lexikalisch und alphabetisch gebunden", () => {
  const sourceStatement = statement({
    parameters: {
      resultSha256: "text",
      id: "text",
      result: "text",
    },
    columns: {
      resultValue: "text",
      resultShaValue: "text",
    },
  });
  const result = compile(sourceStatement, `
    SELECT $result AS resultValue, $resultSha256 AS resultShaValue
    FROM compiler_records
    WHERE id = $id OR fallback_id = $id
    ORDER BY created_at DESC, id
  `);

  assert.equal(result.compilerVersion, POSTGRESQL_DIALECT_COMPILER_VERSION);
  assert.equal(result.strategy, "portable-generated");
  assert.deepEqual(result.parameterOrder, ["id", "result", "resultSha256"]);
  assert.match(result.compiledSql, /SELECT \$2 AS "resultValue", \$3 AS "resultShaValue"/);
  assert.match(result.compiledSql, /id = \$1 OR fallback_id = \$1/);
  assert.match(
    result.compiledSql,
    /ORDER BY created_at DESC NULLS LAST, id NULLS FIRST/,
  );
  assert.deepEqual(result.coveredFeatures, [
    "postgresql.camelcase-alias-quoting",
    "postgresql.named-parameter-binding",
    "postgresql.sqlite-null-ordering",
  ]);
  assert.deepEqual(result.blockingFeatures, []);
  assert.match(result.sourceSqlFingerprint, /^[a-f0-9]{64}$/);
  assert.match(result.compiledSqlFingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(result.sourceSqlFingerprint, result.compiledSqlFingerprint);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.parameterOrder), true);
  assert.equal(Object.isFrozen(result.coveredFeatures), true);
});

test("Block 5/7: Literale, quoted identifiers und Kommentare werden nicht als Parameter gelesen", () => {
  const sourceStatement = statement({
    id: "compiler.lexical-boundaries",
    parameters: { id: "text" },
    columns: {
      literalValue: "text",
      quotedValue: "text",
    },
  });
  const result = compile(sourceStatement, `
    SELECT '$id ? :name @name $tag$' AS literalValue,
           "$id" AS quotedValue
    FROM compiler_records
    -- $id ? :name @name
    WHERE id = $id /* $other ? :other @other */
  `);

  assert.equal(result.strategy, "portable-generated");
  assert.deepEqual(result.parameterOrder, ["id"]);
  assert.match(result.compiledSql, /'\$id \? :name @name \$tag\$' AS "literalValue"/);
  assert.match(result.compiledSql, /"\$id" AS "quotedValue"/);
  assert.match(result.compiledSql, /WHERE id = \$1/);
  assert.match(result.compiledSql, /-- \$id \? :name @name/);
  assert.match(result.compiledSql, /\/\* \$other \? :other @other \*\//);
});

test("Block 5/7: explizite NULL-Reihenfolge bleibt erhalten und verschachtelte ORDER BY werden gehärtet", () => {
  const sourceStatement = statement({
    id: "compiler.null-ordering",
    parameters: {},
    columns: { value: "text" },
  });
  const result = compile(sourceStatement, `
    SELECT value
    FROM compiler_records
    WHERE id IN (
      SELECT id
      FROM compiler_children
      ORDER BY rank DESC
      LIMIT 10
    )
    ORDER BY value ASC NULLS FIRST
  `);

  assert.equal(result.strategy, "portable-generated");
  assert.match(result.compiledSql, /ORDER BY rank DESC NULLS LAST\s+LIMIT 10/);
  assert.match(result.compiledSql, /ORDER BY value ASC NULLS FIRST/);
  assert.doesNotMatch(result.compiledSql, /NULLS FIRST NULLS/);
});

test("Block 5/7: statische SQLite-JSON-Pfade werden zu gebundenen PostgreSQL-Parametern", () => {
  const sourceStatement = statement({
    id: "compiler.json-parameters",
    parameters: {
      direct: "text",
      payload: "json",
    },
    columns: { data: "json" },
  });
  const result = compile(sourceStatement, `
    SELECT json_object(
      'id', json_extract($payload, '$.id'),
      'active', json_extract($payload, '$.active')
    ) AS data
    FROM compiler_records
    WHERE direct_value = $direct
      AND json_extract($payload, '$.id') IS NOT NULL
      AND json_type($payload) = 'object'
      AND json_extract($payload, '$') IS NOT NULL
  `);

  assert.equal(result.strategy, "portable-generated");
  assert.deepEqual(result.parameterOrder, ["direct", "payload"]);
  assert.deepEqual(result.parameterBindings, [
    { parameter: "direct", source: "value", path: [] },
    { parameter: "payload", source: "json-extract", path: ["id"] },
    { parameter: "payload", source: "json-extract", path: ["active"] },
    { parameter: "payload", source: "json-type", path: [] },
    { parameter: "payload", source: "json-extract", path: [] },
  ]);
  assert.match(result.compiledSql, /jsonb_build_object\(\s*'id', \$2,\s*'active', \$3/);
  assert.match(result.compiledSql, /direct_value = \$1/);
  assert.match(result.compiledSql, /\$2 IS NOT NULL/);
  assert.match(result.compiledSql, /\(\$4::text\) = 'object'/);
  assert.match(result.compiledSql, /\(\$5::jsonb\) IS NOT NULL/);
  assert.deepEqual(result.coveredFeatures, [
    "postgresql.camelcase-alias-quoting",
    "postgresql.jsonb-object-construction",
    "postgresql.named-parameter-binding",
    "postgresql.sqlite-json-parameter-binding",
    "postgresql.sqlite-json-type-binding",
  ]);
  assert.equal(Object.isFrozen(result.parameterBindings), true);
  assert.equal(Object.isFrozen(result.parameterBindings[1].path), true);
});

test("Block 5/7: alternative und rohe Parameterformen scheitern geschlossen", () => {
  const sourceStatement = statement({
    id: "compiler.invalid-parameters",
    parameters: { id: "text" },
  });
  const invalidSql = [
    "SELECT value FROM compiler_records WHERE id = $1",
    "SELECT value FROM compiler_records WHERE id = ?",
    "SELECT value FROM compiler_records WHERE id = :id",
    "SELECT value FROM compiler_records WHERE id = @id",
    "SELECT $$secret$$ FROM compiler_records WHERE id = $id",
    "SELECT $tag$secret$tag$ FROM compiler_records WHERE id = $id",
  ];

  for (const sql of invalidSql) {
    assert.throws(() => compile(sourceStatement, sql), TypeError, sql);
  }
  assert.throws(
    () => compile(sourceStatement, "SELECT value FROM compiler_records WHERE id = $other"),
    /Statementvertrag/,
  );
  assert.throws(
    () => compile(sourceStatement, "SELECT value FROM compiler_records"),
    /Statementvertrag/,
  );
});

test("Block 5/7: nicht eindeutige ORDER-BY-Ausdrücke verlangen einen Override", () => {
  const sourceStatement = statement({
    id: "compiler.ambiguous-order",
  });
  const result = compile(
    sourceStatement,
    "SELECT value FROM compiler_records ORDER BY value USING <",
  );

  assert.equal(result.strategy, "requires-override");
  assert.equal(result.compiledSql, null);
  assert.equal(result.compiledSqlFingerprint, null);
  assert.deepEqual(result.blockingFeatures, ["postgresql.order-by-ambiguous"]);
});

test("Block 5/7: SQLite- und semantische Sonderfälle werden niemals automatisch übersetzt", () => {
  const cases = [
    ["SELECT json_group_array(json_object('id', id)) AS value FROM records", "sqlite.json-functions"],
    ["INSERT OR IGNORE INTO records (id) VALUES ('x')", "sqlite.insert-or-ignore"],
    ["INSERT OR REPLACE INTO records (id) VALUES ('x')", "sqlite.insert-or-replace"],
    ["SELECT value FROM records ORDER BY value COLLATE NOCASE", "sqlite.collate-nocase"],
    ["SELECT value FROM records WHERE value LIKE 'x%'", "sqlite.like-operator"],
    ["SELECT rowid AS value FROM records", "sqlite.rowid-pseudocolumn"],
    ["SELECT date(created_at) AS value FROM records", "sqlite.date-time-functions"],
    ["SELECT julianday(created_at) AS value FROM records", "sqlite.julianday-function"],
    ["SELECT name AS value FROM sqlite_master", "sqlite.schema-catalog"],
    ["SELECT group_concat(value) AS value FROM records", "sqlite.group-concat"],
    ["SELECT instr(value, ':') AS value FROM records", "sqlite.instr-function"],
    ["SELECT CHAR(10) AS value FROM records", "sqlite.char-function"],
    ["SELECT CAST(value AS INTEGER) AS value FROM records", "sqlite.cast-integer"],
    ["SELECT value FROM records WHERE value GLOB 'x*'", "sqlite.glob-operator"],
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const [sql, expectedFeature] = cases[index];
    const result = compile(statement({
      id: `compiler.blocked-${index}`,
    }), sql);
    assert.equal(result.strategy, "requires-override", sql);
    assert.equal(result.compiledSql, null, sql);
    assert.equal(result.compiledSqlFingerprint, null, sql);
    assert.ok(result.blockingFeatures.includes(expectedFeature), sql);
    assert.deepEqual(result.coveredFeatures, [], sql);
    assert.match(result.sourceSqlFingerprint, /^[a-f0-9]{64}$/, sql);
  }
});

test("Block 5/7: SQLite-Quoted-Identifier werden erkannt, ihre Inhalte aber nicht fehlgebunden", () => {
  const sourceStatement = statement({
    id: "compiler.sqlite-identifiers",
    parameters: { id: "text" },
  });
  const result = compile(
    sourceStatement,
    "SELECT [$notAParameter] AS value FROM records WHERE id = $id",
  );

  assert.equal(result.strategy, "requires-override");
  assert.deepEqual(result.parameterOrder, ["id"]);
  assert.deepEqual(result.blockingFeatures, ["sqlite.quoted-identifier"]);
});

test("Block 5/7: der reale 899er SQLite-Katalog wird vollständig und geschlossen klassifiziert", () => {
  const compiled = SQLITE_APPLICATION_CATALOG.map((entry) => (
    compilePostgresqlDialectEntry(entry)
  ));
  const portable = compiled.filter((entry) => entry.strategy === "portable-generated");
  const blocked = compiled.filter((entry) => entry.strategy === "requires-override");

  assert.equal(compiled.length, 899);
  assert.equal(portable.length, 797);
  assert.equal(blocked.length, 102);
  assert.ok(portable.every((entry) => (
    typeof entry.compiledSql === "string"
    && /^[a-f0-9]{64}$/.test(entry.compiledSqlFingerprint)
    && entry.blockingFeatures.length === 0
  )));
  assert.ok(blocked.every((entry) => (
    entry.compiledSql === null
    && entry.compiledSqlFingerprint === null
    && entry.blockingFeatures.length > 0
  )));

  const blockerCounts = new Map();
  for (const entry of blocked) {
    for (const feature of entry.blockingFeatures) {
      blockerCounts.set(feature, (blockerCounts.get(feature) || 0) + 1);
    }
  }
  assert.equal(blockerCounts.get("sqlite.json-functions"), 26);
  assert.equal(blockerCounts.get("sqlite.insert-or-ignore"), 16);
  assert.equal(blockerCounts.get("sqlite.collate-nocase"), 26);
  assert.equal(blockerCounts.get("sqlite.rowid-pseudocolumn"), 3);
  assert.equal(blockerCounts.get("sqlite.like-operator"), 9);
  assert.equal(blockerCounts.get("sqlite.cast-integer"), 24);
});

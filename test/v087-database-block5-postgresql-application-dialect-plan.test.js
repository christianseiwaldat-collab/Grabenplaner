"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");

const {
  POSTGRESQL_APPLICATION_DIALECT_FIXTURE,
  POSTGRESQL_APPLICATION_DIALECT_PLAN,
  SQLITE_APPLICATION_DIALECT_MANIFEST,
} = require("../lib/persistence/dialects/application-manifest");

function isDeepFrozen(value, visited = new Set()) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return true;
  }
  if (visited.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  visited.add(value);
  return Reflect.ownKeys(value)
    .every((key) => isDeepFrozen(value[key], visited));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("Block 5/7: der nicht ausführbare PostgreSQL-Plan deckt alle 1471 Statements genau einmal ab", () => {
  const plan = POSTGRESQL_APPLICATION_DIALECT_PLAN;
  const sqliteEntries = SQLITE_APPLICATION_DIALECT_MANIFEST.entries;

  assert.equal(plan.compilerVersion, 2);
  assert.equal(plan.sourceFingerprint, SQLITE_APPLICATION_DIALECT_MANIFEST.fingerprint);
  assert.equal(plan.status, "implementation-in-progress");
  assert.equal(plan.executable, false);
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(plan.entries.length, 1471);
  assert.equal(new Set(plan.entries.map((entry) => entry.statementId)).size, 1471);

  for (let index = 0; index < sqliteEntries.length; index += 1) {
    const source = sqliteEntries[index];
    const planned = plan.entries[index];
    assert.equal(planned.statementId, source.statement.id);
    assert.equal(planned.owner, source.owner);
    assert.equal(planned.sourceClassification, source.classification);
    assert.deepEqual(planned.sourceFeatures, source.features);
    assert.equal(planned.returning, source.returning);
    assert.equal(planned.sourceSqlFingerprint, sha256(source.sql));
    assert.deepEqual(
      planned.parameterOrder,
      [...planned.parameterOrder].sort(),
      planned.statementId,
    );
    assert.equal(Object.hasOwn(planned, "statement"), false);
    assert.equal(Object.hasOwn(planned, "execute"), false);
    assert.equal(Object.hasOwn(planned, "handler"), false);
  }
});

test("Block 5/7: nur portable Einträge enthalten kompiliertes PostgreSQL-SQL", () => {
  const { entries, summary } = POSTGRESQL_APPLICATION_DIALECT_PLAN;
  const portable = entries.filter((entry) => entry.strategy === "portable-generated");
  const blocked = entries.filter((entry) => entry.strategy === "requires-override");

  assert.equal(summary.statementCount, 1471);
  assert.equal(summary.portableGeneratedCount, 1338);
  assert.equal(summary.requiresOverrideCount, 133);
  assert.equal(portable.length, summary.portableGeneratedCount);
  assert.equal(blocked.length, summary.requiresOverrideCount);

  for (const entry of portable) {
    assert.equal(typeof entry.sql, "string", entry.statementId);
    assert.ok(entry.sql.trim(), entry.statementId);
    assert.equal(entry.compiledSqlFingerprint, sha256(entry.sql), entry.statementId);
    assert.deepEqual(entry.blockingFeatures, [], entry.statementId);
    assert.equal(Array.isArray(entry.parameterBindings), true, entry.statementId);
    assert.equal(Object.isFrozen(entry.parameterBindings), true, entry.statementId);
  }
  for (const entry of blocked) {
    assert.equal(Object.hasOwn(entry, "sql"), false, entry.statementId);
    assert.equal(
      Object.hasOwn(entry, "compiledSqlFingerprint"),
      false,
      entry.statementId,
    );
    assert.ok(entry.blockingFeatures.length > 0, entry.statementId);
  }
});

test("Trade-Artikeldetails: alle sechs neuen Abfragen sind einmal registriert und vollständig portabel gebunden", () => {
  const movementStatements = require("../lib/persistence/statements/trade-insights")
    .MOVEMENT_ARTICLE;
  const salesStatements = require("../lib/sales-article-sales-statements");
  const additions = [
    ...Object.values(movementStatements),
    salesStatements.searchArticle,
    salesStatements.articleSourceLinks,
  ];
  const ids = additions.map((statement) => statement.id).sort();
  assert.deepEqual(ids, [
    "sales-article-sales.search",
    "sales-article-sales.source-links",
    "trade-insights.article-movements-records",
    "trade-insights.article-movements-references",
    "trade-insights.article-movements-segments",
    "trade-insights.article-movements-versions",
  ]);

  for (const statement of additions) {
    const sourceEntries = SQLITE_APPLICATION_DIALECT_MANIFEST.entries
      .filter((entry) => entry.statement.id === statement.id);
    const planEntries = POSTGRESQL_APPLICATION_DIALECT_PLAN.entries
      .filter((entry) => entry.statementId === statement.id);
    assert.equal(sourceEntries.length, 1, statement.id);
    assert.equal(planEntries.length, 1, statement.id);
    const source = sourceEntries[0];
    const plan = planEntries[0];
    assert.equal(source.statement, statement, statement.id);
    assert.equal(source.statement.operation, "queryAll", statement.id);
    assert.deepEqual(source.features, ["sqlite.named-dollar-parameters"], statement.id);
    assert.equal(plan.strategy, "portable-generated", statement.id);
    assert.deepEqual(plan.blockingFeatures, [], statement.id);
    assert.equal(plan.sourceSqlFingerprint, sha256(source.sql), statement.id);
    assert.equal(plan.compiledSqlFingerprint, sha256(plan.sql), statement.id);
    assert.equal(plan.returning, false, statement.id);
    assert.deepEqual(plan.parameterOrder, Object.keys(statement.parameters).sort(), statement.id);
    assert.deepEqual(plan.parameterBindings, plan.parameterOrder.map((parameter) => ({
      parameter, source: "value", path: [],
    })), statement.id);
    assert.doesNotMatch(plan.sql, /\$[A-Za-z_]/, statement.id);
    const positions = [...new Set([...plan.sql.matchAll(/\$(\d+)\b/g)]
      .map((match) => Number(match[1])))].sort((left, right) => left - right);
    assert.deepEqual(positions, plan.parameterOrder.map((_, index) => index + 1), statement.id);
  }
  assert.equal(POSTGRESQL_APPLICATION_DIALECT_PLAN.executable, false);
});

test("Block 5/7: Summary erfasst die bekannten Override-Grenzen stabil", () => {
  const counts = POSTGRESQL_APPLICATION_DIALECT_PLAN.summary.blockingFeatureCounts;

  assert.equal(counts["sqlite.json-functions"], 46);
  assert.equal(counts["sqlite.insert-or-ignore"], 18);
  assert.equal(counts["sqlite.collate-nocase"], 27);
  assert.equal(counts["sqlite.like-operator"], 11);
  assert.equal(counts["sqlite.rowid-pseudocolumn"], 3);
  assert.equal(counts["sqlite.cast-integer"], 27);
  assert.equal(counts["sqlite.julianday-function"], 8);
  assert.equal(counts["sqlite.schema-catalog"], 2);
  assert.deepEqual(
    Object.keys(counts),
    Object.keys(counts).sort(),
  );
});

test("Block 5/7: Plan und Fingerprint sind reproduzierbar und tief eingefroren", () => {
  const first = POSTGRESQL_APPLICATION_DIALECT_PLAN;
  const modulePath = require.resolve("../lib/persistence/dialects/application-manifest");
  delete require.cache[modulePath];
  const reloaded = require("../lib/persistence/dialects/application-manifest")
    .POSTGRESQL_APPLICATION_DIALECT_PLAN;

  assert.equal(reloaded.fingerprint, first.fingerprint);
  assert.deepEqual(reloaded.summary, first.summary);
  assert.deepEqual(
    reloaded.entries.map((entry) => ({
      statementId: entry.statementId,
      strategy: entry.strategy,
      sourceSqlFingerprint: entry.sourceSqlFingerprint,
      compiledSqlFingerprint: entry.compiledSqlFingerprint || null,
    })),
    first.entries.map((entry) => ({
      statementId: entry.statementId,
      strategy: entry.strategy,
      sourceSqlFingerprint: entry.sourceSqlFingerprint,
      compiledSqlFingerprint: entry.compiledSqlFingerprint || null,
    })),
  );
  assert.equal(isDeepFrozen(first), true);
  assert.equal(isDeepFrozen(reloaded), true);
});

test("Block 5/7: die Block-4-Plan-Fixture bleibt unverändert nicht ausführbar", () => {
  const fixture = POSTGRESQL_APPLICATION_DIALECT_FIXTURE;

  assert.equal(fixture.status, "contract-only");
  assert.equal(fixture.executable, false);
  assert.equal(fixture.entries.length, 1471);
  assert.equal(fixture.sourceFingerprint, SQLITE_APPLICATION_DIALECT_MANIFEST.fingerprint);
  for (const entry of fixture.entries) {
    assert.equal(entry.status, "contract-only");
    assert.equal(Object.hasOwn(entry, "sql"), false);
    assert.equal(Object.hasOwn(entry, "execute"), false);
  }
});

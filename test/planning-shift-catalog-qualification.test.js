"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");

const file = path.resolve(__dirname, "../lib/persistence/postgresql/core/planning-shift-precondition-catalog.js");
const localRequire = createRequire(file);
const core = localRequire("./catalog");
const { PLANNING_SHIFT_PRECONDITION_CATALOG: sources, SQLITE_APPLICATION_CATALOG: historicalSources } = localRequire("../../catalogs/application-catalog");
const contract = localRequire("../contracts/planning-shift-precondition-catalog-v1.json");
const baseline = localRequire("../contracts/block-4-catalog.json");
const inventory = localRequire("../contracts/block-1-inventory.json");
const moduleSource = fs.readFileSync(file, "utf8");
const IDS = Object.freeze(["planning-settings.shift-revision.get", "work-rule-planning.update-shift-if-current"]);
const HASH_FIELDS = Object.freeze(["sourceSqlSha256", "sourceContract", "sqlSha256", "parameterBindingsSha256", "parameterOrderSha256"]);
const sha = value => createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));

function isolated({ sourceEntries = sources, receipt = contract, compileCoreEntry = core.compileCoreEntry,
  text = moduleSource } = {}) {
  const context = { module: { exports: {} }, __dirname: path.dirname(file), require(id) {
    if (id === "../../catalogs/application-catalog") return { PLANNING_SHIFT_PRECONDITION_CATALOG: sourceEntries };
    if (id === "../contracts/planning-shift-precondition-catalog-v1.json") return receipt;
    if (id === "../contracts/block-4-catalog.json") return baseline;
    if (id === "./catalog") return { ...core, compileCoreEntry };
    return localRequire(id);
  } };
  vm.runInNewContext(text, context, { filename: file });
  return context.module.exports;
}

function alterSource(id, change) {
  return sources.map(entry => entry.statement.id === id ? change(entry) : entry);
}

test("the planning revision extension qualifies exactly two additive IDs and explicit immutable metadata", () => {
  assert.equal(contract.version, 1);
  assert.equal(contract.scope, "planning-shift-precondition-application-extension");
  assert.equal(contract.baseCatalog, "block-4-catalog.json");
  assert.equal(contract.baseSchemaPlanSha256, baseline.schemaPlanSha256);
  assert.equal(contract.productActivation, false);
  assert.equal(contract.entries.length, 2);
  assert.deepEqual(contract.entries.map(entry => entry.statementId).sort(), [...IDS].sort());
  assert.ok(contract.entries.every(entry => entry.added === true));
  const actual = isolated();
  assert.equal(actual.CATALOG.length, 2);
  assert.ok(Object.isFrozen(actual.CATALOG));
  assert.ok(actual.CATALOG.every(Object.isFrozen));
  assert.deepEqual(Array.from(actual.CATALOG, entry => entry.statement.id).sort(), [...IDS].sort());
});

test("each addition binds actual source, PostgreSQL SQL, source contract and both parameter hashes", () => {
  const actual = isolated();
  for (const record of contract.entries) {
    for (const field of HASH_FIELDS) assert.match(record[field], /^[a-f0-9]{64}$/, field);
    const source = sources.find(entry => entry.statement.id === record.statementId);
    assert.ok(source, record.statementId);
    const compiled = actual.compilePlanningShiftPreconditionEntry(source);
    const provider = compiled.providerEntry;
    assert.equal(provider.statement.id, record.statementId);
    assert.equal(compiled.provenance.statementId, record.statementId);
    assert.equal(record.sourceSqlSha256, sha(source.sql));
    assert.equal(record.sourceContract, core.sourceContract(source));
    assert.equal(record.sourceContract, compiled.provenance.sourceContract);
    assert.equal(record.sqlSha256, sha(provider.sql));
    assert.equal(record.sqlSha256, compiled.provenance.sqlSha256);
    assert.equal(record.parameterBindingsSha256, sha(JSON.stringify(provider.parameterBindings)));
    assert.equal(record.parameterOrderSha256, sha(JSON.stringify(provider.parameterOrder)));
  }
  const read = actual.CATALOG.find(entry => entry.statement.id === IDS[0]);
  assert.match(read.sql, /jsonb_build_object\(/);
  assert.match(read.sql, /WHERE id = \(\$1::bigint\)/);
  assert.deepEqual(clone(read.parameterBindings), [{ parameter: "payload", source: "json-extract", path: ["id"] }]);
  assert.deepEqual(clone(read.parameterOrder), ["payload"]);
});

test("the frozen historical inventory and Block 4 catalog remain unchanged with 1125 base entries", () => {
  assert.equal(sha(JSON.stringify(baseline)), "2088f71213db7d595d3c900aa944b21e236aa31c3c8f910a6c06d9997359ed70");
  assert.equal(sha(JSON.stringify(inventory)), "fee930837cc7b3f4bdb36ad644e5a31c95364c7d9f5c94c2eb3854382042ad5f");
  const qualified = core.createCoreCatalog();
  assert.equal(qualified.entries.length, 1125);
  assert.equal(qualified.provenance.length, 1125);
  assert.equal(new Set(qualified.entries.map(entry => entry.statement.id)).size, 1125);
  assert.ok(IDS.every(id => !qualified.entries.some(entry => entry.statement.id === id)));
  assert.ok(IDS.every(id => !baseline.entries.some(entry => entry.statementId === id)));
  assert.equal(historicalSources.length, 1507);
  assert.ok(IDS.every(id => !historicalSources.some(entry => entry.statement.id === id)));
});

test("missing, duplicate or unexpected source and receipt identities fail closed", () => {
  for (const id of IDS) {
    assert.throws(() => isolated({ sourceEntries: sources.filter(entry => entry.statement.id !== id) }), /catalog drift/i);
    assert.throws(() => isolated({ sourceEntries: [...sources, sources.find(entry => entry.statement.id === id)] }), /catalog drift/i);
  }
  for (const change of [
    value => { value.entries.pop(); },
    value => { value.entries.push(clone(value.entries[0])); },
    value => { value.entries[0] = clone(value.entries[1]); },
    value => { value.entries[0].statementId = "planning-settings.unreviewed-addition"; },
    value => { value.entries[0].added = false; },
    value => { delete value.entries[0].added; },
  ]) {
    const changed = clone(contract);
    change(changed);
    assert.throws(() => isolated({ receipt: changed }), /catalog drift/i);
  }
});

test("metadata changes cannot activate or re-anchor the extension", () => {
  for (const [field, value] of [
    ["version", 2], ["scope", "unreviewed"], ["baseCatalog", "other-catalog.json"],
    ["productActivation", true], ["baseSchemaPlanSha256", "0".repeat(64)],
  ]) {
    const changed = clone(contract);
    changed[field] = value;
    assert.throws(() => isolated({ receipt: changed }), /catalog drift/i, field);
    delete changed[field];
    assert.throws(() => isolated({ receipt: changed }), /catalog drift/i, field + " missing");
  }
});

for (const id of IDS) {
  for (const field of HASH_FIELDS) {
    test(`${id} rejects missing or changed ${field}`, () => {
      const changed = clone(contract);
      const record = changed.entries.find(entry => entry.statementId === id);
      record[field] = "0".repeat(64);
      assert.throws(() => isolated({ receipt: changed }), /catalog drift/i);
      delete record[field];
      assert.throws(() => isolated({ receipt: changed }), /catalog drift/i);
    });
  }
}

test("changed source SQL and parameter contracts require explicit fresh qualification", () => {
  for (const id of IDS) {
    assert.throws(() => isolated({ sourceEntries: alterSource(id, entry => ({ ...entry, sql: entry.sql + "\n-- unreviewed change" })) }), /catalog drift/i);
    const parameter = id === IDS[0] ? "payload" : "expectedNote";
    const changed = alterSource(id, entry => ({ ...entry, statement: {
      ...entry.statement, parameters: { ...entry.statement.parameters,
        [parameter]: { ...entry.statement.parameters[parameter], nullable: !entry.statement.parameters[parameter].nullable } },
    } }));
    assert.throws(() => isolated({ sourceEntries: changed }), /catalog drift/i);
  }
});

test("actual compiled SQL bytes are checked even if compiler provenance still claims the old hash", () => {
  assert.throws(() => isolated({ compileCoreEntry(entry) {
    const compiled = core.compileCoreEntry(entry);
    return { ...compiled, providerEntry: { ...compiled.providerEntry, sql: compiled.providerEntry.sql + "\n-- compiler drift" } };
  } }), /catalog drift/i);
  const changed = moduleSource.replace("'id', id,", "'id', id + 0,");
  assert.notEqual(changed, moduleSource, "Mutate the actual new read SQL in isolation");
  assert.throws(() => isolated({ text: changed }), /catalog drift/i);
});

test("actual compiled parameter bindings and order cannot drift behind unchanged receipt hashes", () => {
  for (const field of ["parameterBindings", "parameterOrder"]) {
    assert.throws(() => isolated({ compileCoreEntry(entry) {
      const compiled = core.compileCoreEntry(entry);
      const providerEntry = { ...compiled.providerEntry, [field]: [...compiled.providerEntry[field],
        field === "parameterBindings" ? { parameter: "unreviewed", source: "parameter" } : "unreviewed"] };
      return { ...compiled, providerEntry };
    } }), /catalog drift/i, field);
  }
});

test("the production compiler rejects unrelated IDs instead of relabelling historical statements", () => {
  const actual = isolated();
  const unrelated = historicalSources.find(entry => !IDS.includes(entry.statement.id));
  assert.ok(unrelated);
  assert.throws(() => actual.compilePlanningShiftPreconditionEntry(unrelated), /catalog drift/i);
});

test("Core and boundary register only the reviewed PostgreSQL extension without a SQLite runtime fallback", () => {
  const files = [
    path.join(path.dirname(file), "application.js"),
    path.resolve(path.dirname(file), "../boundary/application.js"),
  ];
  for (const target of files) {
    const source = fs.readFileSync(target, "utf8");
    assert.match(source, /require\(['"](?:\.\/|\.\.\/core\/)planning-shift-precondition-catalog['"]\)\.CATALOG/);
    assert.doesNotMatch(source, /require\(['"](?:node:sqlite|better-sqlite3|sqlite3|[^'"]*\/sqlite(?:\/|['"]))[^'"]*['"]\)/);
    assert.doesNotMatch(source, /createSqlitePersistenceProvider|openSqliteDatabase|new\s+DatabaseSync\s*\(/);
  }
});

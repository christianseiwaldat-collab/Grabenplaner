"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createHash } = require("node:crypto"), { createRequire } = require("node:module");
const catalogFile = path.resolve(__dirname, "../lib/persistence/postgresql/core/catalog.js");
const catalogRequire = createRequire(catalogFile);
const core = catalogRequire("./catalog");
const { SQLITE_APPLICATION_CATALOG } = catalogRequire("../../sqlite/application-catalog");
const baseline = catalogRequire("../contracts/block-4-catalog.json");
const inventory = catalogRequire("../contracts/block-1-inventory.json");
const extension = catalogRequire("../contracts/vocational-school-catalog-v1.json");
const SCHOOL_IDS = Object.freeze([
  "planning-settings.validation.overlapping-week-options",
  "planning-settings.schedule.week-options",
  "planning-settings.week-option.insert",
  "planning-settings.week-option.get",
  "planning-settings.week-option.update",
]);
const sha = value => createHash("sha256").update(value).digest("hex");
const qualified = core.createCoreCatalog();
const compiled = qualified.entries.map((providerEntry, index) => ({ providerEntry, provenance: qualified.provenance[index] }));
const copyCompiled = () => compiled.map(entry => ({ providerEntry: { ...entry.providerEntry }, provenance: { ...entry.provenance } }));
const qualificationError = /drift; explicit qualification required/;

function isolatedCatalog({ sourceEntries = SQLITE_APPLICATION_CATALOG, reviewedExtension = extension } = {}) {
  const context = { module: { exports: {} }, __dirname: path.dirname(catalogFile), require(id) {
    if (id === "../../sqlite/application-catalog") return { SQLITE_APPLICATION_CATALOG: sourceEntries };
    if (id === "../contracts/vocational-school-catalog-v1.json") return reviewedExtension;
    return catalogRequire(id);
  } };
  vm.runInNewContext(fs.readFileSync(catalogFile, "utf8"), context, { filename: catalogFile });
  return context.module.exports;
}

test("frozen source schema, inventory and Block 4 catalog retain their independently pinned content", () => {
  for (const [name, fixture, expected] of [
    ["source-schema-v09237.json", "postgresql-migration/source-schema-v09237.json", "03e37a18d08a1bd52b1e959cb3bf72f35224ff28bb31e61b7e191764cff16723"],
    ["block-1-inventory.json", "postgresql-migration-doc-fixtures/block-1-inventory.json", "fee930837cc7b3f4bdb36ad644e5a31c95364c7d9f5c94c2eb3854382042ad5f"],
    ["block-4-catalog.json", "postgresql-migration-doc-fixtures/block-4-catalog.json", "2088f71213db7d595d3c900aa944b21e236aa31c3c8f910a6c06d9997359ed70"],
  ]) {
    const original = catalogRequire("../contracts/" + name);
    const independentFixture = require("../test-support/" + fixture);
    assert.equal(sha(JSON.stringify(original)), expected, name);
    assert.equal(sha(JSON.stringify(independentFixture)), expected, fixture);
  }
  const source = catalogRequire("../contracts/source-schema-v09237.json");
  assert.ok(!source.tables.find(table => table.name === "week_options").columns.some(column => column.name === "school_details_json"));
  assert.equal(catalogRequire("./schema").createSchemaPlan().digest, "1e7c18f7ea80e5214de4a20add006cad466e80f201663f52e5f27e7d63f3861e");
});

test("exactly five school statements extend the baseline; the other 1120 source and compiled contracts remain identical", () => {
  const reviewed = new Map(extension.entries.map(entry => [entry.statementId, entry]));
  assert.deepEqual([...reviewed.keys()].sort(), [...SCHOOL_IDS].sort());
  assert.equal(extension.entries.length, 5);
  assert.equal(extension.baseCatalog, "block-4-catalog.json");
  assert.equal(extension.baseSchemaPlanSha256, baseline.schemaPlanSha256);
  assert.equal(extension.productActivation, false);
  const originalSources = new Map(inventory.statements.map(entry => [entry.id, entry]));
  const originalCompiled = new Map(baseline.entries.map(entry => [entry.statementId, entry]));
  const currentSources = core.sourceEntries();
  assert.equal(currentSources.length, 1125);
  assert.equal(new Set(currentSources.map(entry => entry.statement.id)).size, 1125);
  const changedSourceIds = currentSources.filter(entry => sha(entry.sql) !== originalSources.get(entry.statement.id).sourceSha256).map(entry => entry.statement.id);
  assert.deepEqual(changedSourceIds.sort(), [...SCHOOL_IDS].sort());
  const changedCompiledIds = [];
  let preserved = 0;
  for (const provenance of qualified.provenance) {
    const old = originalCompiled.get(provenance.statementId), current = reviewed.get(provenance.statementId);
    assert.ok(old, provenance.statementId);
    if (current) {
      assert.equal(current.baseSourceContract, old.sourceContract);
      assert.equal(current.baseSqlSha256, old.sqlSha256);
      assert.equal(current.sourceContract, provenance.sourceContract);
      assert.equal(current.sqlSha256, provenance.sqlSha256);
      assert.notEqual(provenance.sourceContract, old.sourceContract);
      assert.notEqual(provenance.sqlSha256, old.sqlSha256);
      changedCompiledIds.push(provenance.statementId);
    } else {
      assert.equal(provenance.sourceContract, old.sourceContract, provenance.statementId);
      assert.equal(provenance.sqlSha256, old.sqlSha256, provenance.statementId);
      preserved++;
    }
  }
  assert.equal(preserved, 1120);
  assert.deepEqual(changedCompiledIds.sort(), [...SCHOOL_IDS].sort());
});

test("qualified school SQL reads the new field and inserts/updates it through its explicit payload binding", () => {
  for (const id of SCHOOL_IDS) {
    const entry = qualified.entries.find(item => item.statement.id === id);
    assert.match(entry.sql, /school_details_json/, id);
    assert.equal(sha(entry.sql), extension.entries.find(item => item.statementId === id).sqlSha256);
    if (id.endsWith(".insert") || id.endsWith(".update")) {
      assert.equal(entry.parameterBindings.filter(binding => binding.source === "json-extract" && binding.path.join(".") === "schoolDetailsJson").length, 1, id);
    }
  }
});

test("each school source SQL modification fails its exact reviewed source hash before compilation", () => {
  for (const id of SCHOOL_IDS) {
    const entries = SQLITE_APPLICATION_CATALOG.map(entry => entry.statement.id === id ? { ...entry, sql: entry.sql + "\n-- synthetic unreviewed SQL change" } : entry);
    assert.throws(() => isolatedCatalog({ sourceEntries: entries }).sourceEntries(), /Core source catalog drift/);
  }
});

test("the school extension cannot permit a changed SQL source from any other baseline statement", () => {
  const id = qualified.entries.find(entry => !SCHOOL_IDS.includes(entry.statement.id)).statement.id;
  const entries = SQLITE_APPLICATION_CATALOG.map(entry => entry.statement.id === id ? { ...entry, sql: entry.sql + "\n-- synthetic unrelated change" } : entry);
  assert.throws(() => isolatedCatalog({ sourceEntries: entries }).sourceEntries(), /Core source catalog drift/);
});

test("all five compiled school statements reject changed current SQL and source provenance anchors", () => {
  for (const id of SCHOOL_IDS) for (const field of ["sqlSha256", "sourceContract"]) {
    const altered = copyCompiled();
    altered.find(entry => entry.provenance.statementId === id).provenance[field] = "0".repeat(64);
    assert.throws(() => core.assertCoreCatalogLock(altered, baseline), qualificationError, `${id}.${field}`);
  }
});

test("a compiled school SQL change cannot reuse a valid unchanged provenance receipt", () => {
  const altered = copyCompiled();
  altered.find(entry => entry.provenance.statementId === SCHOOL_IDS[0]).providerEntry.sql += " WHERE false";
  assert.throws(() => core.assertCoreCatalogLock(altered, baseline), qualificationError);
});

test("a compiled statement cannot claim another statement identity through an unchanged provenance receipt", () => {
  const altered = copyCompiled(), item = altered.find(entry => entry.provenance.statementId === SCHOOL_IDS[0]);
  item.providerEntry.statement = { ...item.providerEntry.statement, id: SCHOOL_IDS[1] };
  assert.throws(() => core.assertCoreCatalogLock(altered, baseline), qualificationError);
});

test("unreviewed baseline statements also reject changed provenance anchors", () => {
  const id = qualified.entries.find(entry => !SCHOOL_IDS.includes(entry.statement.id)).statement.id;
  for (const field of ["sqlSha256", "sourceContract"]) {
    const altered = copyCompiled(); altered.find(entry => entry.provenance.statementId === id).provenance[field] = "0".repeat(64);
    assert.throws(() => core.assertCoreCatalogLock(altered, baseline), qualificationError);
  }
});

test("replacing one compiled statement with a duplicate cannot hide a missing baseline or school statement", () => {
  const altered = copyCompiled();
  altered[0] = { providerEntry: { ...altered[1].providerEntry }, provenance: { ...altered[1].provenance } };
  assert.equal(altered.length, 1125);
  assert.throws(() => core.assertCoreCatalogLock(altered, baseline), qualificationError);
});

test("all five new provenance receipts stay anchored to their unchanged historical source and SQL hashes", () => {
  for (const id of SCHOOL_IDS) for (const field of ["sourceContract", "sqlSha256"]) {
    const changed = structuredClone(baseline); changed.entries.find(entry => entry.statementId === id)[field] = "0".repeat(64);
    assert.throws(() => core.assertCoreCatalogLock(compiled, changed), qualificationError, `${id}.${field}`);
  }
});

test("changes to any new or old anchor inside the school extension are rejected independently", () => {
  for (const id of SCHOOL_IDS) for (const field of ["sourceContract", "sqlSha256", "baseSourceContract", "baseSqlSha256"]) {
    const changed = structuredClone(extension); changed.entries.find(entry => entry.statementId === id)[field] = "0".repeat(64);
    assert.throws(() => isolatedCatalog({ reviewedExtension: changed }).assertCoreCatalogLock(compiled, baseline), qualificationError, `${id}.${field}`);
  }
});

test("the extension rejects another version, scope, base, schema, activation claim or statement set", () => {
  const mutations = [
    value => { value.version = 2; }, value => { value.scope = "unreviewed"; },
    value => { value.baseCatalog = "other.json"; }, value => { value.baseSchemaPlanSha256 = "0".repeat(64); },
    value => { value.productActivation = true; }, value => { value.entries.pop(); },
    value => { value.entries.push({ ...value.entries[0] }); },
    value => { value.entries[0].statementId = "unreviewed.statement"; },
    value => { value.entries[0].statementId = value.entries[1].statementId; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(extension); mutate(changed);
    assert.throws(() => isolatedCatalog({ reviewedExtension: changed }).assertCoreCatalogLock(compiled, baseline), qualificationError);
  }
});

test("the extension cannot bypass changed frozen catalog version, scope, schema-plan or statement counts", () => {
  for (const mutate of [
    value => { value.version = 2; }, value => { value.scope = "unreviewed"; },
    value => { value.productActivation = true; }, value => { value.schemaPlanSha256 = "0".repeat(64); },
    value => { value.entries.pop(); }, value => { value.entries.push({ ...value.entries[0] }); },
  ]) {
    const changed = structuredClone(baseline); mutate(changed);
    assert.throws(() => core.assertCoreCatalogLock(compiled, changed), qualificationError);
  }
});

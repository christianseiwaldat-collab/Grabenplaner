"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createHash } = require("node:crypto"), { createRequire } = require("node:module");
const file = path.resolve(__dirname, "../lib/persistence/postgresql/core/catalog.js");
const localRequire = createRequire(file), core = localRequire("./catalog");
const { SQLITE_APPLICATION_CATALOG: sources } = localRequire("../../sqlite/application-catalog");
const receipt = localRequire("../contracts/session-security-catalog-v1.json");
const baseline = localRequire("../contracts/block-4-catalog.json");
const sha = value => createHash("sha256").update(value).digest("hex");
const qualified = core.createCoreCatalog();
const compiled = qualified.entries.map((providerEntry, i) => ({ providerEntry, provenance: qualified.provenance[i] }));
function isolated({ sourceEntries = sources, contract = receipt, addition = false } = {}) {
  const target = addition ? path.join(path.dirname(file), "session-security-catalog.js") : file;
  const context = { module: { exports: {} }, __dirname: path.dirname(target), require(id) {
    if (id === "../../sqlite/application-catalog") return { SQLITE_APPLICATION_CATALOG: sourceEntries };
    if (id === "../contracts/session-security-catalog-v1.json") return contract;
    return localRequire(id);
  } };
  vm.runInNewContext(fs.readFileSync(target, "utf8"), context, { filename: target });
  return context.module.exports;
}
test("session SQL qualifies exactly 25 historical overrides and four additions without rewriting historical locks", () => {
  assert.equal(receipt.entries.length, 29); assert.equal(receipt.entries.filter(e => e.added).length, 4);
  assert.equal(new Set(receipt.entries.map(e => e.statementId)).size, 29);
  assert.equal(sha(JSON.stringify(baseline)), "2088f71213db7d595d3c900aa944b21e236aa31c3c8f910a6c06d9997359ed70");
  assert.equal(sha(JSON.stringify(localRequire("../contracts/block-1-inventory.json"))), "fee930837cc7b3f4bdb36ad644e5a31c95364c7d9f5c94c2eb3854382042ad5f");
  for (const record of receipt.entries) {
    const source = sources.find(e => e.statement.id === record.statementId), current = core.compileCoreEntry(source);
    assert.equal(record.sourceSqlSha256, sha(source.sql));
    assert.equal(record.sourceContract, current.provenance.sourceContract);
    assert.equal(record.sqlSha256, sha(current.providerEntry.sql));
    assert.equal(record.parameterBindingsSha256, sha(JSON.stringify(current.providerEntry.parameterBindings)));
    assert.equal(record.parameterOrderSha256, sha(JSON.stringify(current.providerEntry.parameterOrder)));
    if (!record.added) { const old = baseline.entries.find(e => e.statementId === record.statementId);
      assert.equal(record.baseSourceContract, old.sourceContract); assert.equal(record.baseSqlSha256, old.sqlSha256); }
  }
  assert.equal(isolated({ addition: true }).CATALOG.length, 4);
});
test("every altered session SQL source fails closed before execution", () => {
  for (const record of receipt.entries) {
    const changed = sources.map(e => e.statement.id === record.statementId ? { ...e, sql: e.sql + "\n-- unreviewed" } : e);
    if (record.added) assert.throws(() => isolated({ sourceEntries: changed, addition: true }), /catalog drift/i);
    else assert.throws(() => isolated({ sourceEntries: changed }).sourceEntries(), /catalog drift/i);
  }
});
test("historical session qualifications reject SQL, binding, provenance and anchor drift", () => {
  for (const record of receipt.entries.filter(e => !e.added)) {
    for (const field of ["baseSourceContract", "baseSqlSha256", "sourceContract", "sqlSha256", "parameterBindingsSha256", "parameterOrderSha256"]) {
      const altered = structuredClone(receipt); altered.entries.find(e => e.statementId === record.statementId)[field] = "0".repeat(64);
      assert.throws(() => isolated({ contract: altered }).assertCoreCatalogLock(compiled, baseline), /drift/);
    }
  }
});
test("new session qualifications reject SQL, binding and provenance drift", () => {
  for (const record of receipt.entries.filter(e => e.added)) for (const field of ["sourceSqlSha256", "sourceContract", "sqlSha256", "parameterBindingsSha256", "parameterOrderSha256"]) {
    const altered = structuredClone(receipt); altered.entries.find(e => e.statementId === record.statementId)[field] = "0".repeat(64);
    assert.throws(() => isolated({ contract: altered, addition: true }), /catalog drift/i);
  }
});
test("session extension rejects duplicate, missing and changed qualification metadata", () => {
  for (const change of [e => e.entries.pop(), e => e.entries.push({ ...e.entries[0] }), e => { e.entries[0] = { ...e.entries[1] }; },
    e => { e.version = 2; }, e => { e.scope = "unreviewed"; }, e => { e.productActivation = true; }, e => { e.baseSchemaPlanSha256 = "0".repeat(64); }]) {
    const altered = structuredClone(receipt); change(altered);
    assert.throws(() => isolated({ contract: altered }).assertCoreCatalogLock(compiled, baseline), /drift/);
  }
});

"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { Module, createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const original = require("../test-support/postgresql-migration/f0d-core-inspector.json");
const frozen = require("../test-support/postgresql-migration/f0d-core-inspector-frozen-dependencies.json");
const fixturePath = require.resolve("../test-support/postgresql-migration/passkeys-compatibility-transition-fixture.cjs");
const root = path.resolve(__dirname, ".."), source = fs.readFileSync(fixturePath, "utf8");
const localRequire = createRequire(fixturePath);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));

function isolated(readFileSync = fs.readFileSync) {
  const loaded = new Map();
  class OriginalModule extends Module {
    _compile(text, filename) {
      super._compile(text, filename);
      loaded.set(path.relative(root, filename).replaceAll("\\", "/"), { instance: this, sha256: sha(text) });
    }
  }
  const entry = new Module(fixturePath, module);
  vm.runInNewContext(source, { module: entry, Buffer, JSON, process, console, __dirname: path.dirname(fixturePath), require(id) {
    if (id === "node:fs") return { ...fs, readFileSync };
    if (id === "node:module") return { Module: OriginalModule };
    return localRequire(id);
  } }, { filename: fixturePath });
  return { fixture: entry.exports, loaded };
}

test("all five frozen historical blobs retain their original identities and differ from today's CAS additions", () => {
  assert.equal(frozen.sourceCommit, original.sourceCommit);
  assert.equal(frozen.files.length, 5);
  assert.equal(sha(JSON.stringify(original.sharedDependencies)), frozen.sharedDependenciesSha256);
  assert.equal(frozen.files.reduce((count, file) => count + file.bytes, 0), 78327);
  for (const file of frozen.files) {
    const bytes = Buffer.from(file.sourceBase64, "base64");
    assert.equal(bytes.length, file.bytes);
    assert.equal(sha(bytes), original.sharedDependencies.find(item => item.path === file.path).gitLfSha256);
    assert.equal(createHash("sha1").update(Buffer.concat([Buffer.from("blob " + bytes.length + "\0"), bytes])).digest("hex"), file.gitBlob);
    assert.notEqual(sha(Buffer.from(fs.readFileSync(path.join(root, file.path), "utf8").replace(/\r\n/g, "\n"))), file.gitLfSha256);
    assert.doesNotMatch(bytes.toString("utf8"), /planning-settings\.shift-revision\.get|updatePlanningShiftIfCurrent|getShiftForRevisionById/);
  }
});

test("the original closure executes frozen bytes instead of the already loaded current CAS module cache", () => {
  require("../lib/persistence/postgresql/core/planning-shift-precondition-catalog");
  const { fixture, loaded } = isolated();
  const inspector = fixture.originalInspector();
  assert.equal(typeof inspector.verifyCoreSchema, "function");
  // Exercise the original recorded compiler dependency through this same
  // isolated resolver; it imports all five original catalogs/statements.
  loaded.get(original.inspector.path).instance.require("../core/catalog");
  for (const file of frozen.files) {
    assert.equal(loaded.get(file.path)?.sha256, file.gitLfSha256, file.path);
    assert.notStrictEqual(loaded.get(file.path).instance.exports, require(path.join(root, file.path)));
  }
  const catalog = loaded.get("lib/persistence/catalogs/application-catalog.js").instance.exports;
  assert.equal(catalog.SQLITE_APPLICATION_CATALOG.length, 1507);
  assert.equal(Object.hasOwn(catalog, "PLANNING_SHIFT_PRECONDITION_CATALOG"), false);
  const oldSchema = loaded.get("lib/persistence/postgresql/core/schema.js").instance.exports.createSchemaPlan();
  assert.equal(oldSchema.digest, require("../lib/persistence/postgresql/core/schema").createSchemaPlan().digest);
  assert.throws(() => loaded.get(original.inspector.path).instance.require("../core/planning-shift-precondition-catalog"),
    /PASSKEY_TRANSITION_OLD_DEPENDENCY/, "No fallback to an unrecorded current dependency");
});

test("frozen dependency paths never read today's changed source bytes", () => {
  const frozenNames = new Set(frozen.files.map(file => file.path));
  const { fixture } = isolated((filename, ...options) => {
    const relative = path.relative(root, filename).replaceAll("\\", "/");
    assert.equal(frozenNames.has(relative), false, relative);
    return fs.readFileSync(filename, ...options);
  });
  assert.equal(typeof fixture.originalInspector().verifyCoreSchema, "function");
});

test("an altered unfrozen dependency is still rejected by its unchanged original hash", () => {
  const target = original.sharedDependencies.find(item => !frozen.files.some(file => file.path === item.path)).path;
  const { fixture } = isolated((filename, ...options) => {
    const value = fs.readFileSync(filename, ...options);
    return path.relative(root, filename).replaceAll("\\", "/") === target ? value + "\n// unreviewed drift" : value;
  });
  assert.throws(() => fixture.originalInspector(), /PASSKEY_TRANSITION_OLD_DEPENDENCY/);
});

test("the original schema-plan SQL data is separately pinned and drift is rejected", () => {
  assert.equal(frozen.readOnlyData.length, 1);
  const file = frozen.readOnlyData[0];
  assert.equal(file.path, "lib/persistence/postgresql/core/compatibility.sql");
  const bytes = Buffer.from(fs.readFileSync(path.join(root, file.path), "utf8").replace(/\r\n/g, "\n"));
  assert.equal(bytes.length, file.bytes);
  assert.equal(sha(bytes), file.gitLfSha256);
  assert.equal(createHash("sha1").update(Buffer.concat([Buffer.from("blob " + bytes.length + "\0"), bytes])).digest("hex"), file.gitBlob);
  const { fixture } = isolated((filename, ...options) => {
    const value = fs.readFileSync(filename, ...options);
    return path.relative(root, filename).replaceAll("\\", "/") === file.path ? value + "\n-- unreviewed data drift" : value;
  });
  assert.throws(() => fixture.originalInspector(), /PASSKEY_TRANSITION_OLD_DEPENDENCY/);
});

for (const [label, mutate] of [
  ["missing file", value => value.files.pop()],
  ["duplicate file", value => { value.files[1] = clone(value.files[0]); }],
  ["changed bytes", value => { value.files[0].sourceBase64 = Buffer.from("module.exports={}").toString("base64"); }],
  ["current CAS replacement", value => { value.files[0].sourceBase64 = fs.readFileSync(path.join(root, value.files[0].path)).toString("base64"); }],
  ["changed source hash", value => { value.files[0].gitLfSha256 = "0".repeat(64); }],
  ["changed Git blob", value => { value.files[0].gitBlob = "0".repeat(40); }],
  ["changed source commit", value => { value.sourceCommit = "0".repeat(40); }],
  ["changed original manifest", value => { value.sharedDependenciesSha256 = "0".repeat(64); }],
  ["missing schema-plan data", value => { value.readOnlyData = []; }],
  ["changed schema-plan data hash", value => { value.readOnlyData[0].gitLfSha256 = "0".repeat(64); }],
  ["unrecorded schema-plan data path", value => { value.readOnlyData[0].path = "package.json"; }],
]) test("original dependency isolation rejects " + label, () => {
  const changed = clone(frozen); mutate(changed);
  assert.throws(() => isolated().fixture.originalInspector(original, changed), /PASSKEY_TRANSITION_OLD_DEPENDENCY/);
});

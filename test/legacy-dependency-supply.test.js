"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { INPUTS, baselineInputs, createManifest, validateLegacyDependencies, dependencyInventory, prepareLegacyDependencies } = require("../test-support/legacy-dependencies.cjs");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const inputs = baselineInputs();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-legacy-supply-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); fs.mkdirSync(source);
  for (const relative of INPUTS) {
    const file = path.join(source, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, inputs[relative]);
  }
  const dependencies = path.join(source, "node_modules"); fs.mkdirSync(dependencies);
  fs.mkdirSync(path.join(dependencies, "synthetic"));
  const item = path.join(dependencies, "synthetic/index.js"); fs.writeFileSync(item, "module.exports = 'immutable fixture';\n");
  const installation = { pnpmVersion: "11.7.0", exitCode: 0, policy: {
    frozenLockfile: true, ignoreScripts: true, ignorePnpmfile: true, verifyStoreIntegrity: true,
    sideEffectsCache: false, privateStore: true, privateHome: true, nodeLinker: "hoisted", packageImportMethod: "copy",
  } };
  const manifest = createManifest(source, inputs, installation);
  const write = () => {
    const bytes = Buffer.from(JSON.stringify(manifest) + "\n"); fs.writeFileSync(path.join(root, "legacy-dependencies-manifest.json"), bytes); return sha(bytes);
  };
  return { root, source, dependencies, item, manifest, write };
}

test("Historical dependency supply validates external manifest, immutable metadata and every installed file", t => {
  const f = fixture(t); assert.equal(validateLegacyDependencies({ root: f.root, manifestSha256: f.write() }), f.dependencies);
});
test("Historical dependency supply refuses a missing or altered external manifest pin", t => {
  const f = fixture(t); f.write();
  assert.throws(() => validateLegacyDependencies({ root: f.root }));
  assert.throws(() => validateLegacyDependencies({ root: f.root, manifestSha256: "0".repeat(64) }));
});
test("Historical dependency supply refuses changed baseline metadata even with a recomputed manifest", t => {
  const f = fixture(t); const file = path.join(f.source, "pnpm-lock.yaml"); fs.appendFileSync(file, "\n# substituted current graph\n");
  const actual = fs.readFileSync(file); f.manifest.inputs["pnpm-lock.yaml"] = { sha256: sha(actual), bytes: actual.length };
  assert.throws(() => validateLegacyDependencies({ root: f.root, manifestSha256: f.write() }), /immutable baseline/);
});
test("Historical dependency supply refuses changed, extra and missing dependency files", t => {
  const f = fixture(t), digest = f.write(), original = fs.readFileSync(f.item);
  fs.appendFileSync(f.item, "// substituted patch\n");
  assert.throws(() => validateLegacyDependencies({ root: f.root, manifestSha256: digest }), /inventory mismatch/);
  fs.writeFileSync(f.item, original); const extra = path.join(f.dependencies, "shadow.js"); fs.writeFileSync(extra, "shadow");
  assert.throws(() => validateLegacyDependencies({ root: f.root, manifestSha256: digest }), /inventory mismatch/);
  fs.unlinkSync(extra); fs.unlinkSync(f.item);
  assert.throws(() => validateLegacyDependencies({ root: f.root, manifestSha256: digest }));
});
test("Historical dependency supply rejects symlinks and hardlinks rather than following a new graph", t => {
  const f = fixture(t), alias = path.join(f.dependencies, "alias.js"); fs.linkSync(f.item, alias);
  assert.throws(() => dependencyInventory(f.dependencies), /must be regular/);
  fs.unlinkSync(alias);
  const linked = path.join(f.dependencies, "linked"); fs.symlinkSync(path.dirname(f.item), linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => dependencyInventory(f.dependencies));
});
test("Historical dependency supply refuses a changed installation policy or package-manager claim", t => {
  const f = fixture(t); f.manifest.installation.policy.ignoreScripts = false;
  assert.throws(() => validateLegacyDependencies({ root: f.root, manifestSha256: f.write() }));
  f.manifest.installation.policy.ignoreScripts = true; f.manifest.installation.pnpmVersion = "11.25.0";
  assert.throws(() => validateLegacyDependencies({ root: f.root, manifestSha256: f.write() }));
});
test("Historical preparation never overwrites an existing supply directory", t => {
  const f = fixture(t), sentinel = path.join(f.root, "sentinel"); fs.writeFileSync(sentinel, "keep");
  assert.throws(() => prepareLegacyDependencies({ target: f.root, pnpmEntry: process.execPath }), /EEXIST/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
});
test("Historical runner has no current-graph fallback after lock divergence", () => {
  const environment = { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", NODE_TEST_CONTEXT: "child-v8" };
  delete environment.GP_LEGACY_DEPENDENCIES_ROOT;
  delete environment.GP_LEGACY_DEPENDENCIES_MANIFEST_SHA256;
  const result = spawnSync(process.execPath, ["--no-global-search-paths", "-e", "require('./test-support/legacy-baseline').linkFrozenDependencies()"], {
    cwd: path.join(__dirname, ".."), env: environment, encoding: "utf8", windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LEGACY_TEST_FROZEN_DEPENDENCIES_REQUIRED/);
});

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
test("Historical dependency supply rejects package symlinks and hardlinks rather than following a new graph", t => {
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
const linuxBinLinks = { skip: process.platform !== "linux" ? "pnpm Linux executable symlink contract" : false };
function binFixture(t) {
  const f = fixture(t), directory = path.join(f.dependencies, ".bin"); fs.mkdirSync(directory);
  const target = path.join(f.dependencies, "synthetic/cli.cjs"), link = path.join(directory, "synthetic");
  fs.writeFileSync(target, "#!/usr/bin/env node\nprocess.stdout.write(require('./index.js'));\n", { mode: 0o755 });
  fs.symlinkSync("../synthetic/cli.cjs", link);
  f.manifest.files = dependencyInventory(f.dependencies);
  return { ...f, target, link };
}

test("Historical Linux supply binds ordinary pnpm .bin links and preserves relative CLI imports", linuxBinLinks, t => {
  const f = binFixture(t), pin = f.write();
  assert.equal(validateLegacyDependencies({ root: f.root, manifestSha256: pin }), f.dependencies);
  assert.deepEqual(f.manifest.files[".bin/synthetic"], { type: "symlink", linkText: "../synthetic/cli.cjs",
    targetPath: "synthetic/cli.cjs", targetSha256: sha(fs.readFileSync(f.target)), targetBytes: fs.statSync(f.target).size,
    targetMode: 0o755, mode: 0o777 });
  const result = spawnSync(process.execPath, [f.link], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0); assert.equal(result.stdout, "immutable fixture");
  assert(fs.lstatSync(f.link).isSymbolicLink(), "Do not flatten an executable and break relative requires");
});

test("Historical Linux supply permits the same narrow .bin contract in nested hoisted node_modules", linuxBinLinks, t => {
  const f = fixture(t), nested = path.join(f.dependencies, "synthetic/node_modules");
  fs.mkdirSync(path.join(nested, ".bin"), { recursive: true }); fs.mkdirSync(path.join(nested, "child"));
  const target = path.join(nested, "child/cli.js"); fs.writeFileSync(target, "module.exports = 1;\n");
  fs.symlinkSync("../child/cli.js", path.join(nested, ".bin/child"));
  f.manifest.files = dependencyInventory(f.dependencies);
  assert.equal(validateLegacyDependencies({ root: f.root, manifestSha256: f.write() }), f.dependencies);
});

test("Historical executable symlink exception remains closed on a non-Linux platform", linuxBinLinks, t => {
  const f = binFixture(t), filename = require.resolve("../test-support/legacy-dependencies.cjs");
  const moduleUnderTest = { exports: {} };
  require("node:vm").runInNewContext(fs.readFileSync(filename, "utf8"), {
    require, module: moduleUnderTest, __dirname: path.dirname(filename), process: { platform: "win32" },
  }, { filename });
  assert.throws(() => moduleUnderTest.exports.dependencyInventory(f.dependencies), /exception is Linux-only/);
});

test("Historical Linux supply rejects absolute, escaping, noncanonical and non-.bin links", linuxBinLinks, t => {
  const f = binFixture(t);
  for (const text of [f.target, "../../../outside.js", "./../synthetic/cli.cjs", "../synthetic//cli.cjs", "..\\synthetic\\cli.cjs"]) {
    fs.unlinkSync(f.link); fs.symlinkSync(text, f.link);
    assert.throws(() => dependencyInventory(f.dependencies), undefined, text);
  }
  fs.unlinkSync(f.link); fs.symlinkSync("synthetic/cli.cjs", path.join(f.dependencies, "alias"));
  assert.throws(() => dependencyInventory(f.dependencies), /not a .bin entry/);
});

test("Historical Linux supply rejects .bin link chains, directory aliases and hardlinked targets", linuxBinLinks, t => {
  const f = binFixture(t), intermediate = path.join(f.dependencies, "synthetic/intermediate.cjs");
  fs.symlinkSync("cli.cjs", intermediate); fs.unlinkSync(f.link); fs.symlinkSync("../synthetic/intermediate.cjs", f.link);
  assert.throws(() => dependencyInventory(f.dependencies), /must be regular/);
  fs.unlinkSync(intermediate); fs.unlinkSync(f.link); fs.symlinkSync("../synthetic", f.link);
  assert.throws(() => dependencyInventory(f.dependencies), /must be regular/);
  fs.unlinkSync(f.link); fs.symlinkSync("../synthetic/cli.cjs", f.link);
  fs.linkSync(f.target, path.join(f.dependencies, "synthetic/hardlink.cjs"));
  assert.throws(() => dependencyInventory(f.dependencies), /must be regular/);
});

test("Historical Linux supply rejects hardlinks of the executable symlink inode itself", linuxBinLinks, t => {
  const f = binFixture(t), alias = path.join(f.dependencies, ".bin/alias");
  fs.linkSync(f.link, alias);
  assert.equal(fs.lstatSync(f.link).nlink, 2);
  assert.throws(() => dependencyInventory(f.dependencies), /link inode must not be hardlinked/);
});

test("Historical Linux supply rejects changed executable link text, target bytes and mode against the external pin", linuxBinLinks, t => {
  const f = binFixture(t), alternative = path.join(f.dependencies, "synthetic/alternative.cjs");
  const original = fs.readFileSync(f.target); fs.writeFileSync(alternative, original, { mode: 0o755 });
  f.manifest.files = dependencyInventory(f.dependencies); const pin = f.write();
  fs.unlinkSync(f.link); fs.symlinkSync("../synthetic/alternative.cjs", f.link);
  assert.throws(() => validateLegacyDependencies({ root: f.root, manifestSha256: pin }), /inventory mismatch/);
  fs.unlinkSync(f.link); fs.symlinkSync("../synthetic/cli.cjs", f.link);
  fs.appendFileSync(f.target, "// mutation\n");
  assert.throws(() => validateLegacyDependencies({ root: f.root, manifestSha256: pin }), /inventory mismatch/);
  fs.writeFileSync(f.target, original); fs.chmodSync(f.target, 0o644);
  assert.throws(() => validateLegacyDependencies({ root: f.root, manifestSha256: pin }), /inventory mismatch/);
  fs.chmodSync(f.target, 0o755);
  assert.equal(validateLegacyDependencies({ root: f.root, manifestSha256: pin }), f.dependencies);
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

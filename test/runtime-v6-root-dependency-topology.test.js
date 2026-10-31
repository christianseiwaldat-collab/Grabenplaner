"use strict";
// The real bridge, builtins only, real root-owned Linux paths; no legacy Git extraction or application import.
const assert = require("node:assert/strict"), test = require("node:test");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const transition = require("../server-tools/linux/lib/runtime-v6-transition.js");
const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(ROOT, "test-support/runtime-v6/installed-addd4c3-pnpm-workspace.yaml");
const FIXTURE_SHA = "64509458e01c67fe9a97e59870d25dd636239db9fe06cdb7187756555f49ae35";
const MSAL = "lib/vendor-patches/@azure__msal-node@5.4.0.patch";
const nativeOnly = { skip: process.platform !== "linux" || process.getuid?.() !== 0 };
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
// These exact eleven raw link shapes are independently observed on addd4c3.
const LINKS = Object.freeze([
  [".bin/mkdirp", "../mkdirp/bin/cmd.js"],
  [".bin/opencollective-postinstall", "../opencollective-postinstall/index.js"],
  [".bin/sha.js", "../sha.js/bin.js"],
  [".bin/fxparser", "../fast-xml-parser/src/cli/cli.js"],
  [".bin/uuid", "../uuid/dist/esm/bin/uuid"],
  [".bin/semver", "../semver/bin/semver.js"],
  [".bin/rimraf", "../rimraf/bin.js"],
  [".bin/is-docker", "../is-docker/cli.js"],
  [".bin/is-inside-container", "../is-inside-container/cli.js"],
  [".bin/crc32", "../crc-32/bin/crc32.njs"],
  ["tesseract.js/node_modules/.bin/opencollective-postinstall", "../../../opencollective-postinstall/index.js"],
]);
function directory(file) {
  fs.mkdirSync(file, { recursive: true, mode: 0o750 });
  fs.chownSync(file, 0, 982); fs.chmodSync(file, 0o750);
}
function put(file, bytes, mode = 0o640) {
  directory(path.dirname(file)); fs.writeFileSync(file, bytes, { mode });
  fs.chownSync(file, 0, 982); fs.chmodSync(file, mode);
}
function fixture(t) {
  const temporary = fs.mkdtempSync("/root/gp-runtime-v6-dependency-test-");
  fs.chmodSync(temporary, 0o700);
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const oldRoot = path.join(temporary, "old"), candidateRoot = path.join(temporary, "candidate");
  for (const target of [oldRoot, candidateRoot]) {
    directory(target);
    put(path.join(target, "package.json"), JSON.stringify({ packageManager: "pnpm@11.7.0", dependencies: { pg: "8.22.0" } }));
    put(path.join(target, "pnpm-lock.yaml"), "synthetic frozen lock: no installation or package execution\n");
    put(path.join(target, MSAL), fs.readFileSync(path.join(ROOT, MSAL)));
    const globPatch = "lib/vendor-patches/glob@7.2.3.patch";
    put(path.join(target, globPatch), fs.readFileSync(path.join(ROOT, globPatch)));
  }
  put(path.join(oldRoot, "pnpm-workspace.yaml"), fs.readFileSync(FIXTURE));
  put(path.join(candidateRoot, "pnpm-workspace.yaml"), fs.readFileSync(path.join(ROOT, "pnpm-workspace.yaml")));
  const dependencies = path.join(oldRoot, "node_modules");
  put(path.join(dependencies, "pg/index.js"), "module.exports = {};\n");
  const targets = new Set();
  for (const [relative, rawTarget] of LINKS) {
    const entry = path.join(dependencies, relative), target = path.resolve(path.dirname(entry), rawTarget);
    assert(target.startsWith(dependencies + path.sep));
    if (!targets.has(target)) { put(target, "synthetic command bytes; never executed\n", 0o750); targets.add(target); }
    directory(path.dirname(entry)); fs.symlinkSync(rawTarget, entry); fs.lchownSync(entry, 0, 982);
  }
  return { temporary, oldRoot, candidateRoot, dependencies, targets };
}
function plan(f) { return transition.verifyFrozenDependencyPlan(f.oldRoot, f.candidateRoot, { requireRoot: true }); }
function replaceLink(f, rawTarget) {
  const file = path.join(f.dependencies, LINKS[0][0]); fs.unlinkSync(file); fs.symlinkSync(rawTarget, file); fs.lchownSync(file, 0, 982);
}
function target(f) { return path.join(f.dependencies, "mkdirp/bin/cmd.js"); }
function pipe(file) { const result = spawnSync("/usr/bin/mkfifo", ["--", file], { encoding: "utf8", timeout: 5000 }); assert.equal(result.status, 0, result.stderr); fs.chownSync(file, 0, 982); fs.chmodSync(file, 0o640); }

test("runtime-v6 native fixture pins actual installed workspace and the bridge imports only Node builtins", () => {
  assert.equal(fs.readFileSync(FIXTURE).length, 359); assert.equal(digest(fs.readFileSync(FIXTURE)), FIXTURE_SHA);
  const source = fs.readFileSync(path.join(ROOT, "server-tools/linux/lib/runtime-v6-transition.js"), "utf8");
  const imports = [...source.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]);
  assert(imports.length > 0 && imports.every(value => value.startsWith("node:")));
  assert.equal(LINKS.length, 11); assert.equal(new Set(LINKS.map(([name]) => name)).size, 11);
});

test("runtime-v6 root dependency inventory accepts all eleven actual bin link shapes including nested Tesseract", nativeOnly, t => {
  const f = fixture(t), result = plan(f);
  assert.equal(result.predecessor.workspaceSha256, FIXTURE_SHA);
  assert.deepEqual(result.reviewedCanvasOverride, { previous: null, candidate: "1.0.13" });
  assert.equal(result.predecessor.symbolicLinkCount, 11);
  assert.equal(result.predecessor.regularFileCount, f.targets.size + 1);
  assert.equal(result.predecessor.fileCount, f.targets.size + 12);
  for (const [relative, raw] of LINKS) {
    const file = path.join(f.dependencies, relative), s = fs.lstatSync(file), destination = fs.lstatSync(fs.realpathSync(file));
    assert(s.isSymbolicLink()); assert.equal(s.uid, 0); assert.equal(s.gid, 982); assert.equal(s.nlink, 1); assert.equal(s.mode & 0o777, 0o777);
    assert.equal(fs.readlinkSync(file), raw); assert(destination.isFile()); assert.equal(destination.uid, 0); assert.equal(destination.gid, 982); assert.equal(destination.nlink, 1); assert.equal(destination.mode & 0o777, 0o750);
  }
  assert.equal(fs.existsSync(path.join(f.candidateRoot, "node_modules")), false);
});

test("runtime-v6 root frozen plan admits only the exact additive WebAuthn pair and root-only workspace", nativeOnly, t => {
  const f = fixture(t), candidateMetadata = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json")));
  const previousMetadata = structuredClone(candidateMetadata);
  delete previousMetadata.dependencies["@simplewebauthn/browser"]; delete previousMetadata.dependencies["@simplewebauthn/server"];
  put(path.join(f.oldRoot, "package.json"), JSON.stringify(previousMetadata));
  put(path.join(f.candidateRoot, "package.json"), JSON.stringify(candidateMetadata));
  const before = plan(f);
  const pair = { "@simplewebauthn/browser": "14.0.0", "@simplewebauthn/server": "14.0.3" };
  assert.deepEqual(before.reviewedWebAuthnDependencies, { previous: null, candidate: pair });
  assert.deepEqual(before.reviewedRootOnlyWorkspace, { previous: false, candidate: true });
  put(path.join(f.oldRoot, "package.json"), JSON.stringify(candidateMetadata));
  put(path.join(f.oldRoot, "pnpm-workspace.yaml"), fs.readFileSync(path.join(f.candidateRoot, "pnpm-workspace.yaml")));
  const retained = plan(f);
  assert.deepEqual(retained.reviewedWebAuthnDependencies, { previous: pair, candidate: pair });
  assert.deepEqual(retained.reviewedRootOnlyWorkspace, { previous: true, candidate: true });
  assert.equal(retained.predecessor.sha256, before.predecessor.sha256);
  assert.equal(fs.existsSync(path.join(f.candidateRoot, "node_modules")), false);
  const originalPackage = fs.readFileSync(path.join(f.candidateRoot, "package.json"));
  const originalWorkspace = fs.readFileSync(path.join(f.candidateRoot, "pnpm-workspace.yaml"));
  for (const mutation of ["removePair", "partialPair", "changedVersion", "extraDependency", "removeWorkspace", "glob", "quotes", "duplicate"]) {
    let metadata = structuredClone(candidateMetadata), workspace = originalWorkspace.toString("utf8");
    if (mutation === "removePair") { delete metadata.dependencies["@simplewebauthn/browser"]; delete metadata.dependencies["@simplewebauthn/server"]; }
    if (mutation === "partialPair") delete metadata.dependencies["@simplewebauthn/browser"];
    if (mutation === "changedVersion") metadata.dependencies["@simplewebauthn/server"] = "^14.0.3";
    if (mutation === "extraDependency") metadata.dependencies["@simplewebauthn/unknown"] = "14.0.3";
    if (mutation === "removeWorkspace") workspace = workspace.replace(/^packages:\r?\n  - '\.'\r?\n\r?\n/, "");
    if (mutation === "glob") workspace = workspace.replace("  - '.'", "  - '**'");
    if (mutation === "quotes") workspace = workspace.replace("  - '.'", "  - \".\"");
    if (mutation === "duplicate") workspace = "packages:\n  - '.'\n\n" + workspace;
    put(path.join(f.candidateRoot, "package.json"), JSON.stringify(metadata)); put(path.join(f.candidateRoot, "pnpm-workspace.yaml"), workspace);
    assert.throws(() => plan(f), mutation); assert.equal(fs.existsSync(path.join(f.candidateRoot, "node_modules")), false);
  }
  put(path.join(f.candidateRoot, "package.json"), originalPackage); put(path.join(f.candidateRoot, "pnpm-workspace.yaml"), originalWorkspace);
  assert.deepEqual(plan(f), retained);
});
test("runtime-v6 root dependency inventory is deterministic without changing source files", nativeOnly, t => {
  const f = fixture(t), before = fs.readFileSync(target(f)); assert.deepEqual(plan(f), plan(f)); assert.deepEqual(fs.readFileSync(target(f)), before);
});
test("runtime-v6 root dependency digest binds raw link text even for the same final target", nativeOnly, t => {
  const f = fixture(t), before = plan(f); replaceLink(f, "../mkdirp/bin/./cmd.js");
  const after = plan(f); assert.notEqual(after.predecessor.sha256, before.predecessor.sha256); assert.equal(after.predecessor.fileCount, before.predecessor.fileCount);
});
test("runtime-v6 root dependency digest binds the resolved target even when target bytes match", nativeOnly, t => {
  const f = fixture(t), before = plan(f); assert.deepEqual(fs.readFileSync(target(f)), fs.readFileSync(path.join(f.dependencies, "semver/bin/semver.js")));
  replaceLink(f, "../semver/bin/semver.js"); assert.notEqual(plan(f).predecessor.sha256, before.predecessor.sha256);
});
test("runtime-v6 root dependency digest binds actual final file contents", nativeOnly, t => {
  const f = fixture(t), before = plan(f); fs.appendFileSync(target(f), "changed\n"); assert.notEqual(plan(f).predecessor.sha256, before.predecessor.sha256);
});
test("runtime-v6 root dependency digest distinguishes a regular file from a link at the same path", nativeOnly, t => {
  const f = fixture(t), before = plan(f), file = path.join(f.dependencies, LINKS[0][0]), bytes = fs.readFileSync(target(f));
  fs.unlinkSync(file); put(file, bytes, 0o750); const after = plan(f);
  assert.notEqual(after.predecessor.sha256, before.predecessor.sha256); assert.equal(after.predecessor.fileCount, before.predecessor.fileCount);
  assert.equal(after.predecessor.symbolicLinkCount, before.predecessor.symbolicLinkCount - 1); assert.equal(after.predecessor.regularFileCount, before.predecessor.regularFileCount + 1);
});
test("runtime-v6 strict dependency reuse accepts an exact protected link copy and rejects changed copied bytes", nativeOnly, t => {
  const f = fixture(t); fs.cpSync(f.dependencies, path.join(f.candidateRoot, "node_modules"), { recursive: true, dereference: false, verbatimSymlinks: true });
  for (const [relative] of LINKS) fs.lchownSync(path.join(f.candidateRoot, "node_modules", relative), 0, 982);
  const result = transition.verifyDependencyContinuity(f.oldRoot, f.candidateRoot, { requireRoot: true }); assert.equal(result.copiedTreeVerified, true); assert.equal(result.symbolicLinkCount, 11);
  fs.appendFileSync(path.join(f.candidateRoot, "node_modules/pg/index.js"), "changed\n");
  assert.throws(() => transition.verifyDependencyContinuity(f.oldRoot, f.candidateRoot, { requireRoot: true }), /Copied runtime dependencies differ/);
});
const negatives = {
  relativeEscape(f) { put(path.join(f.oldRoot, "outside.js"), "outside\n"); replaceLink(f, "../../outside.js"); },
  absoluteEscape(f) { const outside = path.join(f.temporary, "outside.js"); put(outside, "outside\n"); replaceLink(f, outside); },
  lexicalOutsideThenBack(f) { replaceLink(f, "../../node_modules/mkdirp/bin/cmd.js"); },
  linkedDirectoryOutsideThenBack(f) { const outside = path.join(f.temporary, "outside"); directory(outside); fs.symlinkSync(f.dependencies, path.join(outside, "back")); fs.symlinkSync(outside, path.join(f.dependencies, "hop")); replaceLink(f, "../hop/back/mkdirp/bin/cmd.js"); },
  arbitraryNonBinLink(f) { fs.symlinkSync("pg/index.js", path.join(f.dependencies, "package-link.js")); },
  linkedDependencyRoot(f) { const actual = f.dependencies + "-actual"; fs.renameSync(f.dependencies, actual); fs.symlinkSync(actual, f.dependencies); },
  dangling(f) { replaceLink(f, "../missing.js"); },
  cycle(f) { replaceLink(f, "../.bin/mkdirp"); },
  directoryTarget(f) { replaceLink(f, "../pg"); },
  foreignLinkOwner(f) { fs.lchownSync(path.join(f.dependencies, LINKS[0][0]), 65534, 982); },
  foreignTargetOwner(f) { fs.chownSync(target(f), 65534, 982); },
  foreignBinParentOwner(f) { fs.chownSync(path.join(f.dependencies, ".bin"), 65534, 982); },
  foreignIntermediateOwner(f) { fs.chownSync(path.join(f.dependencies, "mkdirp/bin"), 65534, 982); },
  writableTarget(f) { fs.chmodSync(target(f), 0o770); },
  writableBinParent(f) { fs.chmodSync(path.join(f.dependencies, ".bin"), 0o770); },
  writableIntermediate(f) { fs.chmodSync(path.join(f.dependencies, "mkdirp/bin"), 0o770); },
  writableDependencyRoot(f) { fs.chmodSync(f.dependencies, 0o770); },
  linkedBinParent(f) { const bin = path.join(f.dependencies, ".bin"); fs.renameSync(bin, bin + "-actual"); fs.symlinkSync(bin + "-actual", bin); },
  hardlinkedFinalFile(f) { fs.linkSync(target(f), path.join(f.dependencies, "additional-writer.js")); },
  hardlinkedSymlink(f) { fs.linkSync(path.join(f.dependencies, LINKS[0][0]), path.join(f.dependencies, ".bin/additional-link-writer")); },
  fifoTarget(f) { fs.unlinkSync(target(f)); pipe(target(f)); },
  ordinaryFifo(f) { pipe(path.join(f.dependencies, "non-command-pipe")); },
  nestedCrossTreeTarget(f) { const file = path.join(f.dependencies, LINKS[10][0]); put(path.join(f.candidateRoot, "outside.js"), "candidate\n"); fs.unlinkSync(file); fs.symlinkSync(path.join(f.candidateRoot, "outside.js"), file); },
  hardlinkedMetadata(f) { fs.linkSync(path.join(f.oldRoot, "pnpm-workspace.yaml"), path.join(f.temporary, "another-metadata-writer")); },
  linkedMetadata(f) { const file = path.join(f.oldRoot, "pnpm-workspace.yaml"); fs.renameSync(file, file + "-actual"); fs.symlinkSync(file + "-actual", file); },
};
for (const [name, mutate] of Object.entries(negatives)) {
  test("runtime-v6 root dependency plan rejects " + name + " before candidate graph creation", nativeOnly, t => {
    const f = fixture(t); plan(f); mutate(f); assert.throws(() => plan(f));
    assert.equal(fs.existsSync(path.join(f.candidateRoot, "node_modules")), false);
  });
}

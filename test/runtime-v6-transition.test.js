"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const assert = require("node:assert/strict"), test = require("node:test");
const { spawnSync } = require("node:child_process");
const transition = require("../server-tools/linux/lib/runtime-v6-transition");
const { legacyPath } = require("../test-support/legacy-baseline");
const root = path.resolve(__dirname, "..");
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-core6-contract-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const oldRoot = path.join(temporary, "old"), candidateRoot = path.join(temporary, "new");
  for (const relative of ["server-tools/linux/runtime-schema.json", "server-tools/linux/offsite/module-schema.json", ...Object.keys(transition.OLD_FILES)]) {
    const before = fs.readFileSync(legacyPath(relative)), after = fs.readFileSync(path.join(root, relative));
    for (const [target, bytes] of [[oldRoot, before], [candidateRoot, after]]) {
      const file = path.join(target, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    }
  }
  // git archive preserves canonical blobs. The qualified old deployment uses
  // the explicit versioned monitor.timer.in CRLF checkout form, not generic
  // text normalization or an invented hash fallback.
  const timer = path.join(oldRoot, "server-tools/linux/grabenplaner-monitor.timer.in");
  fs.writeFileSync(timer, fs.readFileSync(timer, "utf8").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"));
  return { oldRoot, candidateRoot };
}
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
test("Core6 accepts exactly the qualified Core5 bytes and the two reviewed PostgreSQL runtime changes", t => {
  const { oldRoot, candidateRoot } = fixture(t);
  const actual = transition.validateTransition(oldRoot, candidateRoot);
  assert.deepEqual(actual, { fromSchema: 5, toSchema: 6, providerId: "postgresql", installedFingerprint: transition.OLD_FINGERPRINT,
    candidateFingerprint: transition.NEW_FINGERPRINT, offsiteInstalledRequired: 13, unitsUnchanged: true });
  const changed = Object.keys(transition.OLD_FILES).filter(file => sha(path.join(oldRoot, file)) !== sha(path.join(candidateRoot, file)));
  assert.deepEqual(changed.sort(), ["server-tools/linux/grabenplaner-bootstrap-admin.sh.in", "server-tools/linux/grabenplaner.env.example"]);
});
test("Core6 refuses unreviewed old runtime, new units, and a modified PostgreSQL bootstrap template", t => {
  for (const [side, relative] of [["oldRoot", "server-tools/linux/grabenplaner-bootstrap-admin.sh.in"],
    ["candidateRoot", "server-tools/linux/grabenplaner.service.in"], ["candidateRoot", "server-tools/linux/grabenplaner-bootstrap-admin.sh.in"]]) {
    const values = fixture(t); fs.appendFileSync(path.join(values[side], relative), "\n# unreviewed delta\n");
    assert.throws(() => transition.validateTransition(values.oldRoot, values.candidateRoot), /Unapproved/);
  }
});
test("Core6 refuses unsupported predecessors, downgrade bridges, and changes to the managed artifact set", t => {
  for (const change of [{ deploymentSchemaVersion: 4 }, { managedArtifacts: [] }, { extraField: true }]) {
    const { oldRoot, candidateRoot } = fixture(t), file = path.join(oldRoot, "server-tools/linux/runtime-schema.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ...change }));
    assert.throws(() => transition.validateTransition(oldRoot, candidateRoot));
  }
  const { oldRoot, candidateRoot } = fixture(t);
  fs.copyFileSync(path.join(oldRoot, "server-tools/linux/runtime-schema.json"), path.join(candidateRoot, "server-tools/linux/runtime-schema.json"));
  assert.throws(() => transition.validateTransition(oldRoot, candidateRoot));
});
test("Core6 refuses unsupported Offsite transitions rather than silently authorizing a new module", t => {
  for (const [side, version] of [["oldRoot", 11], ["candidateRoot", 12], ["candidateRoot", 14]]) {
    const values = fixture(t), file = path.join(values[side], "server-tools/linux/offsite/module-schema.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), moduleVersion: version }));
    assert.throws(() => transition.validateTransition(values.oldRoot, values.candidateRoot));
  }
});
test("Core6 rejects an additional hard link to a managed runtime artifact", t => {
  const { oldRoot, candidateRoot } = fixture(t), file = path.join(candidateRoot, "server-tools/linux/grabenplaner.service.in");
  fs.linkSync(file, path.join(candidateRoot, "untrusted-hard-link"));
  assert.throws(() => transition.validateTransition(oldRoot, candidateRoot));
});
test("Core6 rejects symlinked parent directories even when the target bytes match", { skip: process.platform !== "linux" }, t => {
  const { oldRoot, candidateRoot } = fixture(t), folder = path.join(candidateRoot, "server-tools/linux/host-control/systemd");
  const target = folder + "-target"; fs.renameSync(folder, target); fs.symlinkSync(target, folder);
  assert.throws(() => transition.validateTransition(oldRoot, candidateRoot));
});
test("Core6 rejects ordinary, non-root and unbound invocations before accessing productive credentials", () => {
  assert.throws(() => transition.validateInvocation({ uid: 1000 }));
  assert.throws(() => transition.validateInvocation({ uid: 0, marker: "/tmp/updater-commit.json", transitionFile: "/tmp/transition.json", script: "/tmp/update.sh", packageSha256: "a".repeat(64) }));
});
test("current package declares Core6 / Offsite13 and preserves the qualified Core6 fingerprint", () => {
  const result = spawnSync(process.execPath, [path.join(root, "server-tools/linux/lib/verify-package.js"), "--runtime-contract", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); const value = JSON.parse(result.stdout);
  assert.equal(value.deploymentSchemaVersion, 6); assert.equal(value.fingerprint, transition.NEW_FINGERPRINT);
  assert.equal(value.offsiteModule.moduleVersion, 13); assert.equal(value.managedArtifacts.length, 11);
});
function dependencyFixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-core6-dependencies-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const oldRoot = path.join(temporary, "old"), candidateRoot = path.join(temporary, "new");
  for (const directory of [oldRoot, candidateRoot]) {
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ packageManager: "pnpm@11.7.0", dependencies: { pg: "8.22.0" } }));
    fs.writeFileSync(path.join(directory, "pnpm-lock.yaml"), "frozen fixture bytes\n");
    fs.writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "allowBuilds:\n  sharp: true\noverrides:\n  qs: 6.16.1\npatchedDependencies:\n");
  }
  fs.mkdirSync(path.join(oldRoot, "node_modules/pg"), { recursive: true }); fs.writeFileSync(path.join(oldRoot, "node_modules/pg/index.js"), "module.exports={};\n");
  return { oldRoot, candidateRoot };
}
test("Core6 binds unchanged dependency metadata and every copied dependency byte to the qualified predecessor", t => {
  const values = dependencyFixture(t);
  const before = transition.verifyDependencyContinuity(values.oldRoot, values.candidateRoot, { requireRoot: false });
  assert.equal(before.exactLock, true); assert.equal(before.copiedTreeVerified, false);
  fs.cpSync(path.join(values.oldRoot, "node_modules"), path.join(values.candidateRoot, "node_modules"), { recursive: true });
  const after = transition.verifyDependencyContinuity(values.oldRoot, values.candidateRoot, { requireRoot: false });
  assert.equal(after.copiedTreeVerified, true); assert.equal(after.sha256, before.sha256); assert.equal(after.fileCount, 1);
  fs.appendFileSync(path.join(values.candidateRoot, "node_modules/pg/index.js"), "unreviewed builder code");
  assert.throws(() => transition.verifyDependencyContinuity(values.oldRoot, values.candidateRoot, { requireRoot: false }), /Copied runtime dependencies differ/);
});
test("Core6 dependency reuse refuses lock changes, changed runtime dependencies and package manager drift", t => {
  for (const key of ["lock", "dependencies", "packageManager"]) {
    const values = dependencyFixture(t);
    if (key === "lock") fs.appendFileSync(path.join(values.candidateRoot, "pnpm-lock.yaml"), "changed\n");
    else {
      const file = path.join(values.candidateRoot, "package.json"), document = JSON.parse(fs.readFileSync(file));
      document[key] = key === "dependencies" ? { pg: "different" } : "pnpm@different"; fs.writeFileSync(file, JSON.stringify(document));
    }
    assert.throws(() => transition.verifyDependencyContinuity(values.oldRoot, values.candidateRoot, { requireRoot: false }));
  }
});
test("Core6 dependency reuse refuses a hardlinked predecessor dependency", t => {
  const values = dependencyFixture(t), original = path.join(values.oldRoot, "node_modules/pg/index.js");
  fs.linkSync(original, path.join(values.oldRoot, "another-writer-path"));
  assert.throws(() => transition.verifyDependencyContinuity(values.oldRoot, values.candidateRoot, { requireRoot: false }));
});

test("Core6 frozen dependency plan binds both graphs and retains the predecessor instead of copying its packages", t => {
  const values = dependencyFixture(t), previous = fs.readFileSync(path.join(values.oldRoot, "node_modules/pg/index.js"));
  const original = transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false });
  fs.appendFileSync(path.join(values.candidateRoot, "pnpm-lock.yaml"), "reviewed new frozen resolution\n");
  const workspace = path.join(values.candidateRoot, "pnpm-workspace.yaml");
  fs.writeFileSync(workspace, fs.readFileSync(workspace, "utf8").replace("overrides:\n", "overrides:\n  # Reviewed CVE-2026-111181 security fix; keep the Express major unchanged.\n  body-parser: 2.4.0\n"));
  const actual = transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false });
  assert.deepEqual(actual.predecessor, original.predecessor); assert.notEqual(actual.candidate.lockSha256, original.candidate.lockSha256);
  assert.notEqual(actual.candidate.workspaceSha256, original.candidate.workspaceSha256);
  assert.deepEqual(actual.reviewedBodyParserOverride, { previous: null, candidate: "2.4.0" });
  assert.deepEqual(actual.requirements, { originalZipByteBinding: true, unprivilegedFrozenProductionBuild: true,
    freshRootPostgresqlClosureBeforePreflight: true, freshRootPostgresqlClosureAfterBuild: true });
  assert.equal(fs.existsSync(path.join(values.candidateRoot, "node_modules")), false);
  assert.deepEqual(fs.readFileSync(path.join(values.oldRoot, "node_modules/pg/index.js")), previous);
});

test("Core6 frozen dependency plan rejects unreviewed package and workspace changes", t => {
  for (const key of ["packageManager", "dependencies", "pnpm", "buildHook", "otherOverride", "parserVersion", "duplicateParser", "parserOutsideOverrides"]) {
    const values = dependencyFixture(t), metadata = path.join(values.candidateRoot, "package.json"), workspace = path.join(values.candidateRoot, "pnpm-workspace.yaml");
    const body = JSON.parse(fs.readFileSync(metadata));
    if (key === "packageManager") body.packageManager = "pnpm@different";
    if (key === "dependencies") body.dependencies.pg = "different";
    if (key === "pnpm") body.pnpm = { overrides: { unexpected: "changed" } };
    fs.writeFileSync(metadata, JSON.stringify(body));
    const text = fs.readFileSync(workspace, "utf8");
    if (key === "buildHook") fs.writeFileSync(workspace, text.replace("sharp: true", "sharp: false"));
    if (key === "otherOverride") fs.appendFileSync(workspace, "  unexpected: 1.0.0\n");
    if (key === "parserVersion") fs.appendFileSync(workspace, "  body-parser: 2.5.0\n");
    if (key === "duplicateParser") fs.appendFileSync(workspace, "  body-parser: 2.4.0\n  body-parser: 2.4.0\n");
    if (key === "parserOutsideOverrides") fs.writeFileSync(workspace, "  body-parser: 2.4.0\n" + text);
    assert.throws(() => transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false }), key);
  }
});

test("Core6 frozen dependency plan rejects linked metadata and hardlinked predecessor packages", t => {
  for (const relative of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "node_modules/pg/index.js"]) {
    const values = dependencyFixture(t); fs.linkSync(path.join(values.oldRoot, relative), path.join(values.oldRoot, "other-writer"));
    assert.throws(() => transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false }));
  }
});

const msalPatchRelative = "lib/vendor-patches/@azure__msal-node@5.4.0.patch";
const msalWorkspaceLine = "  '@azure/msal-node@5.4.0': " + msalPatchRelative + "\n";
function addReviewedMsal(root) {
  const workspace = path.join(root, "pnpm-workspace.yaml"), original = fs.readFileSync(workspace, "utf8");
  assert.ok(original.includes("patchedDependencies:\n"));
  fs.writeFileSync(workspace, original.replace("patchedDependencies:\n", "patchedDependencies:\n" + msalWorkspaceLine));
  const patch = path.join(root, msalPatchRelative); fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "..", msalPatchRelative), patch);
  return patch;
}
test("Core6 frozen dependency plan binds only the exact reviewed MSAL compatibility patch and keeps it on later transitions", t => {
  const values = dependencyFixture(t); addReviewedMsal(values.candidateRoot);
  const actual = transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false });
  assert.deepEqual(actual.reviewedMsalPatch, { package: "@azure/msal-node@5.4.0", path: msalPatchRelative, previous: null,
    candidate: "bbdf16bb0cf6a18ab384b515bd8a378cc5c736698c486881c60c1cbb1cbeda01" });
  addReviewedMsal(values.oldRoot);
  const retained = transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false });
  assert.equal(retained.reviewedMsalPatch.previous, retained.reviewedMsalPatch.candidate);
  fs.writeFileSync(path.join(values.candidateRoot, "pnpm-workspace.yaml"), "allowBuilds:\n  sharp: true\noverrides:\n  qs: 6.16.1\npatchedDependencies:\n");
  assert.throws(() => transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false }), /Removing/);
});
test("Core6 frozen dependency plan rejects other MSAL entries, altered bytes and multiple patch writer paths", t => {
  for (const change of ["version", "path", "outsideSection", "duplicate", "bytes", "hardlink", "missing"]) {
    const values = dependencyFixture(t), patch = addReviewedMsal(values.candidateRoot);
    const workspace = path.join(values.candidateRoot, "pnpm-workspace.yaml"), text = fs.readFileSync(workspace, "utf8");
    if (change === "version") fs.writeFileSync(workspace, text.replace("'@azure/msal-node@5.4.0'", "'@azure/msal-node@7.1.0'"));
    if (change === "path") fs.writeFileSync(workspace, text.replace(msalPatchRelative, "lib/vendor-patches/other.patch"));
    if (change === "outsideSection") fs.writeFileSync(workspace, text.replace("patchedDependencies:\n", "otherSection:\n"));
    if (change === "duplicate") fs.appendFileSync(workspace, msalWorkspaceLine);
    if (change === "bytes") fs.appendFileSync(patch, "\n# unreviewed patch delta\n");
    if (change === "hardlink") fs.linkSync(patch, path.join(values.candidateRoot, "second-patch-writer"));
    if (change === "missing") fs.unlinkSync(patch);
    assert.throws(() => transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false }), change);
  }
});
test("Core6 frozen dependency plan accepts the exact final repository workspace security delta against the immutable predecessor", t => {
  const values = dependencyFixture(t);
  fs.copyFileSync(legacyPath("pnpm-workspace.yaml"), path.join(values.oldRoot, "pnpm-workspace.yaml"));
  fs.copyFileSync(path.join(root, "pnpm-workspace.yaml"), path.join(values.candidateRoot, "pnpm-workspace.yaml"));
  fs.copyFileSync(path.join(root, "pnpm-lock.yaml"), path.join(values.candidateRoot, "pnpm-lock.yaml"));
  const patch = path.join(values.candidateRoot, msalPatchRelative); fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.copyFileSync(path.join(root, msalPatchRelative), patch);
  const actual = transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false });
  assert.equal(actual.reviewedBodyParserOverride.candidate, "2.4.0");
  assert.equal(actual.reviewedMsalPatch.candidate, sha(patch));
  assert.equal(actual.candidate.lockSha256, sha(path.join(root, "pnpm-lock.yaml")));
});


const actualAdddWorkspace = path.join(__dirname, "../test-support/runtime-v6/installed-addd4c3-pnpm-workspace.yaml");
const actualAdddWorkspaceSha256 = "64509458e01c67fe9a97e59870d25dd636239db9fe06cdb7187756555f49ae35";
const canvasWorkspaceComment = "  # Native parser/encoder fixes and platform SBOM; qualify PDF/OCR before release.\n";
const canvasWorkspaceLine = "  'pdfjs-dist>@napi-rs/canvas': 1.0.13\n";
function actualWorkspaceFixture(t, previousCurrent = false) {
  const values = dependencyFixture(t), original = fs.readFileSync(actualAdddWorkspace);
  assert.equal(original.length, 359); assert.equal(sha(actualAdddWorkspace), actualAdddWorkspaceSha256);
  for (const directory of [values.oldRoot, values.candidateRoot]) {
    const target = path.join(directory, msalPatchRelative); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, msalPatchRelative), target);
  }
  fs.writeFileSync(path.join(values.oldRoot, "pnpm-workspace.yaml"), previousCurrent
    ? fs.readFileSync(path.join(root, "pnpm-workspace.yaml")) : original);
  fs.copyFileSync(path.join(root, "pnpm-workspace.yaml"), path.join(values.candidateRoot, "pnpm-workspace.yaml"));
  fs.copyFileSync(path.join(root, "pnpm-lock.yaml"), path.join(values.candidateRoot, "pnpm-lock.yaml"));
  return values;
}
test("Core6 actual installed addd workspace accepts exactly the qualified Canvas body-parser MSAL delta", t => {
  const values = actualWorkspaceFixture(t);
  const result = transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false });
  assert.equal(result.predecessor.workspaceSha256, actualAdddWorkspaceSha256);
  assert.equal(result.candidate.workspaceSha256, sha(path.join(root, "pnpm-workspace.yaml")));
  assert.deepEqual(result.reviewedCanvasOverride, { previous: null, candidate: "1.0.13" });
  assert.deepEqual(result.reviewedBodyParserOverride, { previous: null, candidate: "2.4.0" });
  assert.equal(result.reviewedMsalPatch.candidate, sha(path.join(root, msalPatchRelative)));
  assert.equal(fs.existsSync(path.join(values.candidateRoot, "node_modules")), false);
  assert.equal(sha(actualAdddWorkspace), actualAdddWorkspaceSha256);
});
test("Core6 actual installed reviewed Canvas override is preserved in an unchanged later workspace", t => {
  const values = actualWorkspaceFixture(t, true);
  const result = transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false });
  assert.deepEqual(result.reviewedCanvasOverride, { previous: "1.0.13", candidate: "1.0.13" });
  assert.equal(result.reviewedBodyParserOverride.previous, result.reviewedBodyParserOverride.candidate);
  assert.equal(result.reviewedMsalPatch.previous, result.reviewedMsalPatch.candidate);
});
for (const change of ["removal", "wrongVersion", "wrongSection", "duplicate", "commentOutsideOverrides", "changedComment", "unreviewedComment"]) {
  test("Core6 actual installed Canvas metadata rejects " + change + " without rewriting either graph", t => {
    const values = actualWorkspaceFixture(t, change === "removal");
    const workspace = path.join(values.candidateRoot, "pnpm-workspace.yaml"); let text = fs.readFileSync(workspace, "utf8");
    assert.equal(text.split(canvasWorkspaceLine).length, 2);
    if (change === "removal") text = text.replace(canvasWorkspaceComment + canvasWorkspaceLine, "");
    if (change === "wrongVersion") text = text.replace(canvasWorkspaceLine, canvasWorkspaceLine.replace("1.0.13", "1.0.12"));
    if (change === "wrongSection") text = text.replace(canvasWorkspaceComment + canvasWorkspaceLine, "")
      .replace("patchedDependencies:\n", "patchedDependencies:\n" + canvasWorkspaceLine);
    if (change === "duplicate") text = text.replace(canvasWorkspaceLine, canvasWorkspaceLine + canvasWorkspaceLine);
    if (change === "commentOutsideOverrides") text = canvasWorkspaceComment + text.replace(canvasWorkspaceComment, "");
    if (change === "changedComment") text = text.replace(canvasWorkspaceComment, "  # Unreviewed Canvas qualification.\n");
    if (change === "unreviewedComment") text += "# Unreviewed workspace change.\n";
    fs.writeFileSync(workspace, text);
    const previous = fs.readFileSync(path.join(values.oldRoot, "pnpm-workspace.yaml")), next = fs.readFileSync(workspace);
    assert.throws(() => transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false }));
    assert.deepEqual(fs.readFileSync(path.join(values.oldRoot, "pnpm-workspace.yaml")), previous);
    assert.deepEqual(fs.readFileSync(workspace), next);
    assert.equal(fs.existsSync(path.join(values.candidateRoot, "node_modules")), false);
    assert.equal(sha(actualAdddWorkspace), actualAdddWorkspaceSha256);
  });
}

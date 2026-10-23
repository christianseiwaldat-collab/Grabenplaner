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
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ packageManager: "pnpm@11.7.0", dependencies: { pg: "8.20.0" } }));
    fs.writeFileSync(path.join(directory, "pnpm-lock.yaml"), "frozen fixture bytes\n");
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

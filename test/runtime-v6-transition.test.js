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

test("Core6 dependency-plan helper is limited to the explicit migration and its sealed candidate entrypoint", () => {
  const updater = fs.readFileSync(path.join(root, "server-tools/linux/update-grabenplaner-server.sh"), "utf8").replaceAll("\r\n", "\n");
  const guarded = [...updater.matchAll(/^if \[\[ -n "\$runtime_v6_transition" \]\]; then\n[\s\S]*?^fi$/gm)];
  const calls = [...updater.matchAll(/^\s*root_node "\$SCRIPT_DIR\/lib\/runtime-v6-transition\.js" (?:invocation|verify|dependency-plan) /gm)];
  assert(calls.length >= 4);
  for (const call of calls) assert(guarded.some(block => block.index <= call.index && call.index < block.index + block[0].length),
    "A regular already-Core6 update must not invoke the Core5-to-Core6 dependency-plan guard");
  assert(updater.includes('[[ "$runtime_gate" == "migration-required:5->6" ]]'));
  const migration = fs.readFileSync(path.join(root, "server-tools/linux/migrate-grabenplaner-runtime-v6.sh"), "utf8").replaceAll("\r\n", "\n");
  const helper = migration.indexOf('transition_helper="$extract_root/server-tools/linux/lib/runtime-v6-transition.js"');
  assert(helper > migration.indexOf('gp_verify_sealed_zip "$staged_package" "$extract_root" 0'));
  assert(migration.includes('root_node "$transition_helper" dependency-plan "$app_dir" "$extract_root"'));
  assert(migration.includes('cmp --silent -- "$SCRIPT_PATH" "$extract_root/server-tools/linux/migrate-grabenplaner-runtime-v6.sh"'));
  assert(migration.includes('bash "$extract_root/server-tools/linux/update-grabenplaner-server.sh" "${update_args[@]}"'));
});
function dependencyFixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-core6-dependencies-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const oldRoot = path.join(temporary, "old"), candidateRoot = path.join(temporary, "new");
  for (const directory of [oldRoot, candidateRoot]) {
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ packageManager: "pnpm@11.7.0", dependencies: { pg: "8.22.0" } }));
    fs.writeFileSync(path.join(directory, "pnpm-lock.yaml"), "frozen fixture bytes\n");
    fs.writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "allowBuilds:\n  sharp: true\noverrides:\n  qs: 6.16.1\npatchedDependencies:\n");
    const relative = "lib/vendor-patches/glob@7.2.3.patch";
    fs.mkdirSync(path.dirname(path.join(directory,relative)),{recursive:true}); fs.copyFileSync(path.join(root,relative),path.join(directory,relative));
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

test("Core6 rejects large unequal locks with a bounded diagnostic and a constrained child heap", t => {
  const { oldRoot, candidateRoot } = dependencyFixture(t);
  const previous = Buffer.alloc(100_000, 0x61), candidate = Buffer.from(previous);
  candidate[candidate.length - 1] = 0x62;
  const files = [path.join(oldRoot, "pnpm-lock.yaml"), path.join(candidateRoot, "pnpm-lock.yaml")];
  fs.writeFileSync(files[0], previous); fs.writeFileSync(files[1], Buffer.concat([candidate, Buffer.from("\n")]));
  const before = files.map(sha);
  const script = `
    const transition = require(process.argv[1]);
    try {
      transition.verifyDependencyContinuity(process.argv[2], process.argv[3], { requireRoot: false });
      process.exitCode = 2;
    } catch (error) {
      process.stdout.write(JSON.stringify({ name: error.name, message: error.message }));
    }
  `;
  const result = spawnSync(process.execPath, ["--max-old-space-size=96", "--no-global-search-paths", "-e", script,
    path.join(root, "server-tools/linux/lib/runtime-v6-transition.js"), oldRoot, candidateRoot],
  { encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert(result.stdout.length < 512, "Rejection must not render lock contents");
  assert.deepEqual(JSON.parse(result.stdout), { name: "AssertionError",
    message: "The Core6 bridge requires the exact installed frozen lock bytes" });
  assert.deepEqual(files.map(sha), before);
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

function addReviewedMinimatch(root) {
  const workspace = path.join(root,"pnpm-workspace.yaml");
  fs.writeFileSync(workspace,fs.readFileSync(workspace,"utf8").replace("overrides:\n","overrides:\n  minimatch: 11.0.3\n")
    .replace("patchedDependencies:\n","patchedDependencies:\n  glob@7.2.3: lib/vendor-patches/glob@7.2.3.patch\n"));
  const relative = "lib/vendor-patches/glob@7.2.3.patch", file = path.join(root,relative);
  fs.mkdirSync(path.dirname(file),{recursive:true}); fs.copyFileSync(path.join(__dirname,"..",relative),file);
  return {workspace,patch:file};
}
test("Core6 permits the exact repaired matcher pair and retains it on later transitions", t => {
  const values = dependencyFixture(t); addReviewedMinimatch(values.candidateRoot);
  assert.deepEqual(transition.verifyFrozenDependencyPlan(values.oldRoot,values.candidateRoot,{requireRoot:false}).reviewedMinimatchOverride,{previous:null,candidate:"11.0.3"});
  addReviewedMinimatch(values.oldRoot);
  assert.deepEqual(transition.verifyFrozenDependencyPlan(values.oldRoot,values.candidateRoot,{requireRoot:false}).reviewedMinimatchOverride,{previous:"11.0.3",candidate:"11.0.3"});
});
for (const mutation of ["version","patchVersion","path","duplicateOverride","duplicatePatch","wrongSection","overrideOnly","patchOnly","patchBytes","missingPatch","linkedPatch","hardlinkedPatch","removal"]) {
  test("Core6 rejects an unqualified matcher transition: " + mutation,{skip:mutation === "linkedPatch" && process.platform === "win32" ? "File symlink creation requires Windows privileges; exercised on Linux" : false},t => {
    const values=dependencyFixture(t), files=addReviewedMinimatch(values.candidateRoot);
    let text=fs.readFileSync(files.workspace,"utf8");
    if(mutation==="version") text=text.replace("minimatch: 11.0.3","minimatch: 11.0.4");
    if(mutation==="patchVersion") text=text.replace("glob@7.2.3:","glob@7.2.4:");
    if(mutation==="path") text=text.replace("lib/vendor-patches/glob@7.2.3.patch","lib/vendor-patches/unreviewed.patch");
    if(mutation==="duplicateOverride") text=text.replace("overrides:\n","overrides:\n  minimatch: 11.0.3\n");
    if(mutation==="duplicatePatch") text+="  glob@7.2.3: lib/vendor-patches/glob@7.2.3.patch\n";
    if(mutation==="wrongSection") text=text.replace("overrides:\n  minimatch: 11.0.3\n","  minimatch: 11.0.3\noverrides:\n");
    if(mutation==="overrideOnly") text=text.replace("  glob@7.2.3: lib/vendor-patches/glob@7.2.3.patch\n","");
    if(mutation==="patchOnly") text=text.replace("  minimatch: 11.0.3\n","");
    if(mutation==="patchBytes") fs.appendFileSync(files.patch,"unreviewed");
    if(mutation==="missingPatch") fs.unlinkSync(files.patch);
    if(mutation==="linkedPatch" || mutation==="hardlinkedPatch") {
      const original=files.patch+".original"; fs.renameSync(files.patch,original);
      if(mutation==="linkedPatch") fs.symlinkSync(original,files.patch); else fs.linkSync(original,files.patch);
    }
    if(mutation==="removal") { addReviewedMinimatch(values.oldRoot); text=text.replace("  minimatch: 11.0.3\n","").replace("  glob@7.2.3: lib/vendor-patches/glob@7.2.3.patch\n",""); }
    fs.writeFileSync(files.workspace,text);
    assert.throws(()=>transition.verifyFrozenDependencyPlan(values.oldRoot,values.candidateRoot,{requireRoot:false}));
  });
}

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

const rootOnlyWorkspacePrefix = "packages:\n  - '.'\n\n";
const reviewedWebAuthn = { "@simplewebauthn/browser": "14.0.0", "@simplewebauthn/server": "14.0.3" };
function changeMetadata(directory, update) {
  const file = path.join(directory, "package.json"), value = JSON.parse(fs.readFileSync(file));
  update(value); fs.writeFileSync(file, JSON.stringify(value));
}
function introduceWebAuthn(directory) { changeMetadata(directory, value => Object.assign(value.dependencies, reviewedWebAuthn)); }
function addRootOnlyWorkspace(directory) {
  const file = path.join(directory, "pnpm-workspace.yaml"); fs.writeFileSync(file, rootOnlyWorkspacePrefix + fs.readFileSync(file, "utf8"));
}

test("Core6 frozen plan permits only the exact root-only workspace introduction and retains it on later transitions", t => {
  for (const eol of ["\n", "\r\n"]) {
    const values = dependencyFixture(t), prefix = rootOnlyWorkspacePrefix.replaceAll("\n", eol);
    for (const directory of [values.oldRoot, values.candidateRoot]) {
      const file = path.join(directory, "pnpm-workspace.yaml"); fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("\n", eol));
    }
    const oldFile = path.join(values.oldRoot, "pnpm-workspace.yaml"), nextFile = path.join(values.candidateRoot, "pnpm-workspace.yaml");
    const original = fs.readFileSync(oldFile); fs.writeFileSync(nextFile, prefix + original.toString("utf8"));
    const introduced = transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false });
    assert.deepEqual(introduced.reviewedRootOnlyWorkspace, { previous: false, candidate: true });
    assert.deepEqual(fs.readFileSync(oldFile), original); assert.equal(fs.existsSync(path.join(values.candidateRoot, "node_modules")), false);
    fs.copyFileSync(nextFile, oldFile);
    assert.deepEqual(transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false }).reviewedRootOnlyWorkspace,
      { previous: true, candidate: true });
    fs.writeFileSync(nextFile, original);
    assert.throws(() => transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false }), /Removing.*root-only/);
  }
});

test("Core6 frozen plan rejects alternative, scoped, duplicate and displaced workspace declarations", t => {
  const alternatives = [
    "packages:\n  - \".\"\n\n", "packages:\n  - .\n\n", "packages:\n  - '**'\n\n", "packages:\n  - 'other'\n\n",
    "packages:\n  - '.'\n  - 'plugins/*'\n\n", rootOnlyWorkspacePrefix + rootOnlyWorkspacePrefix,
    "# Different prefix\n" + rootOnlyWorkspacePrefix, "'packages':\n  - '.'\n\n", "\"packages\":\n  - '.'\n\n",
    "packages: ['.']\n\n", "packages:\n  - '.'\n", "packages:\r\n  - '.'\n\n",
  ];
  for (const prefix of alternatives) {
    const values = dependencyFixture(t), file = path.join(values.candidateRoot, "pnpm-workspace.yaml");
    fs.writeFileSync(file, prefix + fs.readFileSync(file, "utf8")); const before = fs.readFileSync(file);
    assert.throws(() => transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false }), JSON.stringify(prefix));
    assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.existsSync(path.join(values.candidateRoot, "node_modules")), false);
  }
  const values = dependencyFixture(t), file = path.join(values.candidateRoot, "pnpm-workspace.yaml");
  fs.appendFileSync(file, rootOnlyWorkspacePrefix);
  assert.throws(() => transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false }));
});

test("Core6 frozen plan binds the exact WebAuthn pair additively while retaining the original dependency tree", t => {
  const values = dependencyFixture(t), original = sha(path.join(values.oldRoot, "node_modules/pg/index.js"));
  assert.deepEqual(transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false }).reviewedWebAuthnDependencies,
    { previous: null, candidate: null });
  introduceWebAuthn(values.candidateRoot); addRootOnlyWorkspace(values.candidateRoot);
  const added = transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false });
  assert.deepEqual(added.reviewedWebAuthnDependencies, { previous: null, candidate: reviewedWebAuthn });
  introduceWebAuthn(values.oldRoot); addRootOnlyWorkspace(values.oldRoot);
  const retained = transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false });
  assert.deepEqual(retained.reviewedWebAuthnDependencies, { previous: reviewedWebAuthn, candidate: reviewedWebAuthn });
  assert.equal(sha(path.join(values.oldRoot, "node_modules/pg/index.js")), original);
  assert.equal(fs.existsSync(path.join(values.candidateRoot, "node_modules")), false);
  changeMetadata(values.candidateRoot, value => { for (const name of Object.keys(reviewedWebAuthn)) delete value.dependencies[name]; });
  assert.throws(() => transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false }), /Removing.*WebAuthn/);
});

test("Core6 frozen plan rejects partial, changed, downgraded and extra WebAuthn or unrelated dependency metadata", t => {
  const mutations = [
    value => { delete value.dependencies["@simplewebauthn/browser"]; },
    value => { delete value.dependencies["@simplewebauthn/server"]; },
    value => { value.dependencies["@simplewebauthn/server"] = "14.0.4"; },
    value => { value.dependencies["@simplewebauthn/server"] = "13.3.0"; },
    value => { value.dependencies["@simplewebauthn/browser"] = "^14.0.0"; },
    value => { value.dependencies["@simplewebauthn/helpers"] = "14.0.3"; },
    value => { value.dependencies["@other/server"] = "14.0.3"; },
    value => { value.optionalDependencies = { ...reviewedWebAuthn }; },
    value => { value.peerDependencies = { ...reviewedWebAuthn }; },
    value => { value.dependencies.pg = "8.21.0"; },
    value => { delete value.dependencies.pg; },
    value => { value.pnpm = { overrides: { "@simplewebauthn/server": "14.0.3" } }; },
  ];
  for (const mutate of mutations) {
    const values = dependencyFixture(t); introduceWebAuthn(values.candidateRoot); changeMetadata(values.candidateRoot, mutate);
    assert.throws(() => transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false }));
    assert.equal(fs.existsSync(path.join(values.candidateRoot, "node_modules")), false);
  }
  const values = dependencyFixture(t); introduceWebAuthn(values.oldRoot); introduceWebAuthn(values.candidateRoot);
  changeMetadata(values.oldRoot, value => { delete value.dependencies["@simplewebauthn/server"]; });
  assert.throws(() => transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false }));
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
  fs.copyFileSync(legacyPath("package.json"), path.join(values.oldRoot, "package.json"));
  fs.copyFileSync(path.join(root, "package.json"), path.join(values.candidateRoot, "package.json"));
  fs.copyFileSync(legacyPath("pnpm-workspace.yaml"), path.join(values.oldRoot, "pnpm-workspace.yaml"));
  fs.copyFileSync(path.join(root, "pnpm-workspace.yaml"), path.join(values.candidateRoot, "pnpm-workspace.yaml"));
  fs.copyFileSync(path.join(root, "pnpm-lock.yaml"), path.join(values.candidateRoot, "pnpm-lock.yaml"));
  const patch = path.join(values.candidateRoot, msalPatchRelative); fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.copyFileSync(path.join(root, msalPatchRelative), patch);
  const actual = transition.verifyFrozenDependencyPlan(values.oldRoot, values.candidateRoot, { requireRoot: false });
  assert.equal(actual.reviewedBodyParserOverride.candidate, "2.4.0");
  assert.equal(actual.reviewedMsalPatch.candidate, sha(patch));
  assert.equal(actual.candidate.lockSha256, sha(path.join(root, "pnpm-lock.yaml")));
  assert.deepEqual(actual.reviewedWebAuthnDependencies, { previous: null, candidate: reviewedWebAuthn });
  assert.deepEqual(actual.reviewedRootOnlyWorkspace, { previous: false, candidate: true });
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

"use strict";

// Offline preservation, never a selectable current application provider.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const BASELINE = "b2ba03cdc0b738d44766857de052e090db557807";
const FORMAT = "grabenplaner-legacy-sqlite-recovery-capsule-v1";
const HASH = /^[a-f0-9]{64}$/;
const hashFile = (file) => {
  const hash = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest("hex");
};
function fail(code) { throw Object.assign(new Error(code), { code }); }
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("LEGACY_CAPSULE_REGULAR_FILE");
  return stat;
}
function run(command, args, options = {}) {
  const { diagnosticPhase = "external-command", ...spawnOptions } = options;
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: "C.UTF-8" }, ...spawnOptions });
  if (result.error || result.status !== 0) {
    // Never surface command arguments, environment, stdout, raw stderr, or key
    // material. Preserve only bounded fixed diagnostic codes from our child.
    let child;
    for (const line of String(result.stderr || "").split(/\r?\n/).slice(-8)) {
      try {
        const value = JSON.parse(line);
        if (/^[A-Z][A-Z0-9_]{2,100}$/.test(value.code || "")) child = { code: value.code,
          ...(typeof value.phase === "string" && /^[a-z-]{1,64}$/.test(value.phase) ? { phase: value.phase } : {}),
          ...(value.child && /^[A-Z][A-Z0-9_]{2,100}$/.test(value.child.code || "") ? { causeCode: value.child.code } : {}) };
      } catch { /* Non-diagnostic stderr is intentionally not retained. */ }
    }
    throw Object.assign(new Error("LEGACY_CAPSULE_COMMAND_FAILED"), { code: "LEGACY_CAPSULE_COMMAND_FAILED", legacyPhase: diagnosticPhase,
      child: child || { code: /^[A-Z][A-Z0-9_]{2,100}$/.test(result.error?.code || "") ? result.error.code : "CHILD_FAILED", status: result.status } });
  }
  return result.stdout;
}
async function phase(name, action) {
  try { return await action(); }
  catch (error) { error.legacyPhase ||= name; throw error; }
}
function inventory(root, relative = "") {
  const result = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const file = relative ? relative + "/" + name : name;
    if (!relative && name === "capsule.json") continue;
    if (/[\x00-\x1f\\]/.test(file) || file.split("/").some(x => x === "..")) fail("LEGACY_CAPSULE_PATH");
    const target = path.join(root, file), stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fail("LEGACY_CAPSULE_LINK");
    if (stat.isDirectory()) result.push(...inventory(root, file));
    else { regular(target); result.push({ file, bytes: stat.size, sha256: hashFile(target) }); }
  }
  return result;
}
function newRoot(value) {
  const root = path.resolve(value), parent = path.dirname(root);
  if (!path.isAbsolute(value) || root === path.parse(root).root || fs.existsSync(root)
    || fs.realpathSync(parent) !== parent) fail("LEGACY_CAPSULE_NEW_ROOT_REQUIRED");
  return root;
}
function preserveNativeLibraries(binary, root) {
  const os = require("node:os");
  const contract = { platform: process.platform, arch: process.arch, kernelRelease: os.release(),
    portability: "same-architecture-Linux-kernel-and-exact-recorded-system-loader/libraries-required; no historical application bootstrap", libraries: [] };
  if (process.platform !== "linux") return contract;
  const result = spawnSync("ldd", [binary], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C" } });
  if (result.status !== 0 || /not found/.test(result.stdout || "")) fail("LEGACY_CAPSULE_NATIVE_INVENTORY");
  const files = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/=>\s+(\/\S+)\s+\(/) || line.match(/^\s*(\/\S+)\s+\(/);
    if (match) files.push(match[1]);
    else if (line.trim() && !/linux-vdso\.so/.test(line)) fail("LEGACY_CAPSULE_NATIVE_INVENTORY");
  }
  if (!files.length) fail("LEGACY_CAPSULE_NATIVE_INVENTORY");
  fs.mkdirSync(path.join(root, "runtime/lib"), { mode: 0o700 });
  for (const file of [...new Set(files)].sort()) {
    const actual = fs.realpathSync(file); regular(actual);
    const loader = /\/ld-linux[^/]*\.so(?:\.\d+)*$/.test(file);
    const destination = loader ? "runtime/loader" : "runtime/lib/" + path.basename(file);
    if (fs.existsSync(path.join(root, destination))) fail("LEGACY_CAPSULE_NATIVE_COLLISION");
    fs.copyFileSync(actual, path.join(root, destination), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(root, destination), loader ? 0o500 : 0o400);
    const librarySha256 = hashFile(actual);
    if (hashFile(path.join(root, destination)) !== librarySha256) fail("LEGACY_CAPSULE_NATIVE_COPY_MISMATCH");
    contract.libraries.push({ file: destination, originalPath: file, realPath: actual, sha256: librarySha256 });
    if (loader) contract.loader = destination;
  }
  if (!contract.loader) fail("LEGACY_CAPSULE_NATIVE_LOADER");
  if (fs.existsSync("/etc/os-release")) contract.osRelease = fs.readFileSync("/etc/os-release", "utf8").split("\n").filter(line => /^(ID|VERSION_ID)=/.test(line));
  return contract;
}
function assertNativeHost(manifest) {
  if (process.platform !== "linux" || process.arch !== manifest.runtime.arch) fail("LEGACY_CAPSULE_LINUX_REQUIRED");
  // Original recovery helpers spawn process.execPath with a deliberately empty
  // loader environment. Therefore require the same system libraries for every
  // descendant, rather than silently mixing a preserved parent with host libs.
  for (const library of manifest.runtime.native.libraries) {
    let actual;
    try { actual = fs.realpathSync(library.originalPath); regular(actual); }
    catch { fail("LEGACY_CAPSULE_NATIVE_HOST_MISMATCH"); }
    if (hashFile(actual) !== library.sha256) fail("LEGACY_CAPSULE_NATIVE_HOST_MISMATCH");
  }
}
function createCapsule({ repository, node, nodeSha256, nodeVersion, output }) {
  if (!HASH.test(nodeSha256 || "") || !/^v(?:22|24)\.\d+\.\d+$/.test(nodeVersion || "")) fail("LEGACY_CAPSULE_RUNTIME_PIN_REQUIRED");
  const [major, minor] = nodeVersion.slice(1).split(".").map(Number);
  if (major === 22 && minor < 13) fail("LEGACY_CAPSULE_RUNTIME_UNSUPPORTED");
  const binary = path.resolve(node); regular(binary);
  if (hashFile(binary) !== nodeSha256) fail("LEGACY_CAPSULE_RUNTIME_HASH");
  const runtime = JSON.parse(run(binary, ["-p", "JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})"]));
  if (runtime.version !== nodeVersion) fail("LEGACY_CAPSULE_RUNTIME_VERSION");
  const git = args => run("git", ["-C", path.resolve(repository), ...args]);
  if (git(["rev-parse", BASELINE + "^{commit}"]).trim() !== BASELINE) fail("LEGACY_CAPSULE_BASELINE");
  // Only immutable tracked source is captured. Runtime data, secrets and npm
  // installations can never enter through the caller's dirty working tree.
  const entries = git(["ls-tree", "-r", "-z", BASELINE]).split("\0").filter(Boolean);
  for (const item of entries) {
    const match = item.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/);
    if (!match || /(?:^|\/)(?:node_modules|private-workspace|\.env|data|backups)(?:\/|$)|\.(?:db|sqlite|sqlite3|key)$/i.test(match[3])
      || (/\.pem$/i.test(match[3]) && match[3] !== ".github/security-evidence-public-key.pem")) fail("LEGACY_CAPSULE_SOURCE_UNSAFE");
  }
  const root = newRoot(output);
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(path.join(root, "source"), { mode: 0o700 });
  git(["archive", "--format=tar", "--output", path.join(root, "source.tar"), BASELINE]);
  run("tar", ["-xf", path.join(root, "source.tar"), "-C", path.join(root, "source")]);
  fs.mkdirSync(path.join(root, "runtime"), { mode: 0o700 });
  const executable = "runtime/" + (runtime.platform === "win32" ? "node.exe" : "node");
  fs.copyFileSync(binary, path.join(root, executable), fs.constants.COPYFILE_EXCL);
  fs.chmodSync(path.join(root, executable), 0o500);
  const native = preserveNativeLibraries(binary, root);
  const manifest = { format: FORMAT, baseline: BASELINE, sourceTree: git(["rev-parse", BASELINE + "^{tree}"]).trim(),
    runtime: { ...runtime, executable, sha256: nodeSha256, native },
    scope: "offline-sqlite-verification-and-isolated-filesystem-restore", applicationStart: false,
    dependencies: { recovery: "node-builtins-only", applicationLockSha256: hashFile(path.join(root, "source", "pnpm-lock.yaml")) },
    files: inventory(root) };
  fs.writeFileSync(path.join(root, "capsule.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o400 });
  verifyCapsule(root, hashFile(path.join(root, "capsule.json")));
  return { baseline: BASELINE, capsule: root, manifestSha256: hashFile(path.join(root, "capsule.json")), files: manifest.files.length,
    runtime: { ...runtime, sha256: nodeSha256, nativeLibraries: native.libraries.length }, applicationStart: false };
}
function verifyCapsule(root, expectedSha256) {
  root = path.resolve(root);
  if (!HASH.test(expectedSha256 || "") || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) fail("LEGACY_CAPSULE_TRUST_PIN_REQUIRED");
  const file = path.join(root, "capsule.json");
  if (regular(file).size > 8 * 1024 * 1024 || hashFile(file) !== expectedSha256) fail("LEGACY_CAPSULE_MANIFEST_HASH");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest.format !== FORMAT || manifest.baseline !== BASELINE || manifest.applicationStart !== false
    || !Array.isArray(manifest.files) || !HASH.test(manifest.runtime?.sha256 || "")
    || !["runtime/node", "runtime/node.exe"].includes(manifest.runtime?.executable)) fail("LEGACY_CAPSULE_MANIFEST");
  if (JSON.stringify(inventory(root)) !== JSON.stringify(manifest.files)) fail("LEGACY_CAPSULE_CONTENT_HASH");
  if (hashFile(path.join(root, manifest.runtime.executable)) !== manifest.runtime.sha256
    || hashFile(path.join(root, "source/pnpm-lock.yaml")) !== manifest.dependencies?.applicationLockSha256) fail("LEGACY_CAPSULE_BINDING");
  if (manifest.runtime.platform === "linux" && (manifest.runtime.native?.loader !== "runtime/loader"
    || !Array.isArray(manifest.runtime.native?.libraries) || !manifest.runtime.native.libraries.length)) fail("LEGACY_CAPSULE_NATIVE_INVENTORY");
  for (const library of manifest.runtime.native?.libraries || []) {
    if ((!/^runtime\/lib\/[^/]+$/.test(library.file || "") && library.file !== "runtime/loader")
      || !path.isAbsolute(library.originalPath || "") || !HASH.test(library.sha256 || "")
      || hashFile(path.join(root, library.file)) !== library.sha256) fail("LEGACY_CAPSULE_NATIVE_BINDING");
  }
  return manifest;
}
function freeze(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) freeze(target); else { regular(target); fs.chmodSync(target, 0o400); }
  }
  fs.chmodSync(root, 0o500);
}
function copyTree(source, target) {
  // inventory rejects links, special files and multiply-linked files before copying.
  inventory(source); fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
}
function assertSeparatedOutput(output, ...retainedInputs) {
  for (const input of retainedInputs) {
    const relative = path.relative(path.resolve(input), path.resolve(output));
    if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))) {
      fail("LEGACY_CAPSULE_OUTPUT_OVERLAPS_RETAINED_INPUT");
    }
  }
}
async function restoreCapsule({ capsule, manifestSha256, stage, environment, output }) {
  const manifest = verifyCapsule(capsule, manifestSha256);
  const currentBinary = path.resolve(process.execPath), expectedBinary = path.join(path.resolve(capsule), manifest.runtime.executable);
  if (currentBinary !== expectedBinary) fail("LEGACY_CAPSULE_PINNED_RUNTIME_REQUIRED");
  if (process.platform !== "linux") fail("LEGACY_CAPSULE_LINUX_REQUIRED");
  assertNativeHost(manifest);
  const root = newRoot(output);
  if (!path.isAbsolute(stage) || !path.isAbsolute(environment)) fail("LEGACY_CAPSULE_INPUT_PATH");
  if (fs.realpathSync(stage) !== stage || !fs.lstatSync(stage).isDirectory() || fs.lstatSync(stage).isSymbolicLink()) fail("LEGACY_CAPSULE_INPUT_PATH");
  assertSeparatedOutput(root, stage, capsule);
  regular(environment); inventory(stage);
  fs.mkdirSync(root, { mode: 0o700 });
  const source = path.join(path.resolve(capsule), "source");
  const moduleAt = name => require(path.join(source, name));
  const { verifyRecovery } = moduleAt("server-tools/linux/recovery/lib/recovery-verify.js");
  const { applyRecovery } = moduleAt("server-tools/linux/recovery/lib/recovery-apply.js");
  const { __internalTestOnly } = moduleAt("server-tools/linux/recovery/lib/recovery-metadata.js");
  // This ownership policy applies only to this newly created private offline
  // workspace. It is never accepted by the installed recovery command.
  const policy = __internalTestOnly.nonRootOwnershipPolicy;
  const frozenStage = path.join(root, "input"); copyTree(stage, frozenStage); freeze(frozenStage);
  const stageProof = JSON.parse(run(expectedBinary, [path.join(source, "server-tools/linux/offsite/lib/offsite-stage.js"), "verify", frozenStage], { diagnosticPhase: "verify-frozen-stage" }));
  if (stageProof.providerId === "postgresql-pair") fail("LEGACY_CAPSULE_SQLITE_ONLY");
  run(expectedBinary, [path.join(source, "server-tools/linux/lib/verify-backup.js"), stageProof.database, stageProof.documents,
    path.join(source, "lib/amu-storage.js"), stageProof.commitMarker], { diagnosticPhase: "verify-legacy-backup-artifacts" });
  const environmentCopy = path.join(root, "keys.env");
  fs.copyFileSync(environment, environmentCopy, fs.constants.COPYFILE_EXCL); fs.chmodSync(environmentCopy, 0o600);
  const result = await phase("verify-legacy-recovery", () => verifyRecovery({ stage: frozenStage,
    stageHelper: path.join(source, "server-tools/linux/offsite/lib/offsite-stage.js"),
    backupVerifier: path.join(source, "server-tools/linux/lib/verify-backup.js"),
    amuModule: path.join(source, "lib/amu-storage.js"), integrationModule: path.join(source, "lib/integration-secret-vault.js"),
    environment: environmentCopy, targetPackage: path.join(source, "package.json"),
    targetRuntime: path.join(source, "server-tools/linux/runtime-schema.json"), scratchRoot: root,
    output: path.join(root, "verification.json") }, policy));
  if (result.providerId === "postgresql-pair") fail("LEGACY_CAPSULE_SQLITE_ONLY");
  const recoveryId = crypto.randomBytes(32).toString("hex"), snapshotId = hashFile(path.join(frozenStage, "offsite-stage-manifest.json"));
  const receipt = { format: "grabenplaner-linux-recovery", schemaVersion: 1, recoveryId, snapshotId,
    databaseSha256: result.databaseSha256, stageManifestSha256: result.stageManifestSha256 };
  for (const state of ["prepared", "verified"]) fs.writeFileSync(path.join(root, state + ".json"), JSON.stringify({ ...receipt, state }) + "\n", { flag: "wx", mode: 0o600 });
  const target = path.join(root, "restored"), safety = path.join(root, "safety");
  fs.mkdirSync(target, { mode: 0o700 }); fs.mkdirSync(safety, { mode: 0o700 });
  // Preserve the original prior-state safety contract. Only this new private
  // offline destination receives an explicitly empty DB and empty encrypted
  // store before applying the archived backup. No historical guard is bypassed.
  await phase("prepare-empty-offline-target", () => {
    fs.mkdirSync(path.join(target, "data"), { mode: 0o700 });
    fs.mkdirSync(path.join(target, "private"), { mode: 0o700 });
    const empty = moduleAt("lib/persistence/sqlite/provider.js").openSqliteLegacyDatabase(path.join(target, "data/dienstplan.db"));
    try { empty.exec("CREATE TABLE legacy_capsule_empty_target (offline_only INTEGER NOT NULL CHECK (offline_only = 1)); INSERT INTO legacy_capsule_empty_target VALUES (1)"); }
    finally { empty.close(); }
    const checks = moduleAt("server-tools/linux/recovery/lib/recovery-verify.js");
    const keys = checks.encryptionConfiguration(checks.readEnvironment(environmentCopy, policy));
    moduleAt("lib/amu-storage.js").createAmuStorage({ rootDirectory: path.join(target, "private/amu"), activeKeyId: keys.amuKeyId,
      encryptionKeys: { [keys.amuKeyId]: keys.amuKey } });
  });
  fs.writeFileSync(path.join(target, "runtime-config.json"), "{}\n", { flag: "wx", mode: 0o600 });
  const applied = await phase("apply-isolated-recovery", () => applyRecovery({ stage: frozenStage, "prepared-receipt": path.join(root, "prepared.json"),
    "verified-receipt": path.join(root, "verified.json"), "safety-receipt": path.join(safety, "pre-restore-safety.json"),
    "safety-root": safety, "recovery-id": recoveryId, snapshot: snapshotId, "data-root": target,
    database: path.join(target, "data/dienstplan.db"), "amu-module": path.join(source, "lib/amu-storage.js"),
    "database-lock-module": path.join(source, "lib/database-lock.js"), output: path.join(root, "application.json") }, policy));
  // Recheck the retained reader/runtime after execution, too.
  verifyCapsule(capsule, manifestSha256);
  return { ok: true, offlineOnly: true, servicesStarted: false, restored: target,
    databaseSha256: applied.databaseSha256, capsuleManifestSha256: manifestSha256, baseline: BASELINE,
    sourcePreserved: true, applicationStart: false };
}
function argumentsFor(argv) {
  const [command, ...args] = argv, values = {};
  const allowed = new Set(["repository", "node", "node-sha256", "node-version", "output", "capsule", "manifest-sha256", "stage", "environment"]);
  while (args.length) {
    const key = args.shift();
    if (!key?.startsWith("--") || !allowed.has(key.slice(2)) || !args.length || Object.hasOwn(values, key.slice(2))) fail("LEGACY_CAPSULE_ARGUMENTS");
    values[key.slice(2)] = args.shift();
  }
  const options = { repository: values.repository, node: values.node, nodeSha256: values["node-sha256"], nodeVersion: values["node-version"],
    output: values.output, capsule: values.capsule, manifestSha256: values["manifest-sha256"], stage: values.stage, environment: values.environment };
  const required = command === "create" ? ["repository", "node", "nodeSha256", "nodeVersion", "output"]
    : command === "verify" ? ["capsule", "manifestSha256"] : command === "restore" ? ["capsule", "manifestSha256", "stage", "environment", "output"] : [];
  if (!required.length || required.some(key => !options[key])) fail("LEGACY_CAPSULE_ARGUMENTS");
  return { command, options };
}
if (require.main === module) Promise.resolve().then(async () => {
  const { command, options } = argumentsFor(process.argv.slice(2));
  if (command === "create") return createCapsule(options);
  if (command === "verify") { const manifest = verifyCapsule(options.capsule, options.manifestSha256); return { ok: true, baseline: manifest.baseline, files: manifest.files.length }; }
  const manifest = verifyCapsule(options.capsule, options.manifestSha256);
  assertNativeHost(manifest);
  const binary = path.join(path.resolve(options.capsule), manifest.runtime.executable);
  if (path.resolve(process.execPath) !== binary) {
    const output = run(binary, [__filename, ...process.argv.slice(2)], { diagnosticPhase: "pinned-runtime-reexec" }); return JSON.parse(output);
  }
  return restoreCapsule(options);
}).then(result => process.stdout.write(JSON.stringify(result) + "\n"))
  .catch(error => { process.stderr.write(JSON.stringify({ ok: false, code: error.code || "LEGACY_CAPSULE_FAILED",
    ...(error.legacyPhase ? { phase: error.legacyPhase } : {}), ...(error.child ? { child: error.child } : {}) }) + "\n"); process.exitCode = 1; });
module.exports = { BASELINE, createCapsule, verifyCapsule, restoreCapsule, hashFile, inventory, argumentsFor, assertSeparatedOutput };

"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict"), { createRequire } = require("node:module"), { spawnSync } = require("node:child_process");
const repository = path.resolve(__dirname, "../..");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const hash = file => digest(fs.readFileSync(file));

function checkDates(policy, now) {
  assert.deepEqual(policy.advisoryExceptions, []);
  assert.ok(policy.owner && policy.reason && policy.removalCondition);
  assert.match(policy.expiresOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(policy.reviewedOn, /^\d{4}-\d{2}-\d{2}$/);
  const expiry = new Date(policy.expiresOn + "T23:59:59Z"), review = new Date(policy.reviewedOn + "T00:00:00Z");
  assert.ok(Number.isFinite(+expiry) && Number.isFinite(+review) && review <= now && expiry >= now
    && new Date(policy.expiresOn + "T00:00:00Z") - review <= 30 * 86400000, "Expired or overbroad patch registration");
}

function patchedDeclarations(text) {
  const lines = text.replaceAll("\r\n", "\n").split("\n"), result = {};
  assert.equal(lines.filter(line => line === "patchedDependencies:").length, 1, "Exactly one patchedDependencies block is required");
  const start = lines.indexOf("patchedDependencies:") + 1;
  for (const line of lines.slice(start)) {
    if (!line.trim()) continue;
    if (!line.startsWith(" ")) break;
    assert(line.startsWith("  ") && line[2] !== " ", "Unexpected nested patch declaration");
    const separator = line.indexOf(": ", 2);
    assert(separator > 2);
    let key = line.slice(2, separator), value = line.slice(separator + 2);
    if (key.startsWith("'") || key.startsWith('"')) { assert.equal(key.at(-1), key[0]); key = key.slice(1, -1); }
    assert(key && value && !Object.hasOwn(result, key), "Duplicate or empty patch declaration");
    result[key] = value;
  }
  return result;
}

function checkDeclarations(policies, workspace, lock) {
  const expectedWorkspace = {}, expectedLock = {};
  for (const policy of policies) {
    const key = policy.package + "@" + policy.version;
    assert(!Object.hasOwn(expectedWorkspace, key));
    expectedWorkspace[key] = policy.patch; expectedLock[key] = policy.patchSha256;
  }
  assert.deepEqual(patchedDeclarations(workspace), expectedWorkspace, "Unexpected patched dependency declaration");
  assert.deepEqual(patchedDeclarations(lock), expectedLock, "Unexpected patched lock entry");
}

function checkPolicy(policy, context, now = new Date()) {
  assert.equal(policy.schemaVersion, 1); assert.equal(policy.package, "brace-expansion"); assert.equal(policy.version, "5.0.12");
  checkDates(policy, now);
  assert.equal(context.patchHash, policy.patchSha256); assert.equal(context.installedHash, policy.installedCommonJsSha256);
  checkDeclarations(context.registeredPolicies || [policy], context.workspace, context.lock);
}

function checkBackportPolicy(policy, context, now = new Date()) {
  assert.equal(policy.schemaVersion, 1); assert.equal(policy.kind, "verified_security_backport");
  assert.equal(policy.package, "@azure/msal-node"); assert.equal(policy.version, "5.4.0");
  assert.equal(policy.advisory, "GHSA-xcx6-jx8p-x3h5"); assert.equal(policy.cve, "CVE-2026-109461");
  assert.equal(policy.upstreamCommit, "f550958586475dbfeb1cd44be14a2d653728850e"); assert.equal(policy.upstreamFixedVersion, "7.1.0");
  checkDates(policy, now);
  assert.equal(context.patchHash, policy.patchSha256); assert.equal(context.packageJsonHash, policy.packageJsonSha256);
  assert.equal(context.licenseHash, policy.licenseSha256); assert.equal(context.treeHash, policy.installedTreeSha256);
  assert.equal(context.fileCount, policy.installedFileCount); assert.equal(context.regressionHash, policy.regressionTestSha256);
  assert.equal(policy.regressionTest, "test/security-msal-auth-code-backport.test.js"); assert.equal(policy.regressionPassCount, 14);
  const required = ["dist/client/ConfidentialClientApplication.mjs", "dist/error/NodeAuthError.mjs", "lib/msal-node.cjs",
    "src/client/ConfidentialClientApplication.ts", "src/error/NodeAuthError.ts", "types/client/ConfidentialClientApplication.d.ts", "types/error/NodeAuthError.d.ts"];
  assert.deepEqual(Object.keys(policy.installedFiles).sort(), required.sort()); assert.deepEqual(Object.keys(context.installedHashes).sort(), required.sort());
  for (const relative of required) {
    assert.match(policy.installedFiles[relative].beforeSha256, /^[a-f0-9]{64}$/);
    assert.equal(context.installedHashes[relative], policy.installedFiles[relative].afterSha256, "Installed MSAL patch file drift: " + relative);
  }
  const lines = context.lock.replaceAll("\r\n", "\n").split("\n");
  const packageEntry = "  '@azure/msal-node@5.4.0':", packageStart = lines.indexOf("packages:") + 1, snapshotStart = lines.indexOf("snapshots:");
  assert(packageStart > 0 && snapshotStart > packageStart);
  const matches = lines.map((line, index) => line === packageEntry && index >= packageStart && index < snapshotStart ? index : -1).filter(index => index >= 0);
  assert.equal(matches.length, 1);
  assert.equal(lines[matches[0] + 1], "    resolution: {integrity: " + policy.originalTarballIntegrity + "}", "Original MSAL tarball integrity drift");
  checkDeclarations(context.registeredPolicies, context.workspace, context.lock);
}

function packageInventory(root) {
  const files = [];
  const walk = (directory, prefix = "") => {
    const folder = fs.lstatSync(directory); assert(folder.isDirectory() && !folder.isSymbolicLink());
    for (const name of fs.readdirSync(directory).sort()) {
      assert(name && !name.includes("\\") && !/[\x00-\x1f\x7f]/.test(name));
      const file = path.join(directory, name), info = fs.lstatSync(file);
      if (info.isDirectory()) walk(file, prefix + name + "/");
      else {
        assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 32 * 1024 * 1024);
        files.push({ path: prefix + name, sha256: hash(file), bytes: info.size }); assert(files.length <= 2000);
      }
    }
  };
  walk(root); return { sha256: digest(Buffer.from(JSON.stringify(files))), files };
}

function checkGlobCompatibilityPolicy(policy, context, now = new Date()) {
  assert.equal(policy.schemaVersion, 1); assert.equal(policy.kind, "verified_compatibility_patch");
  assert.equal(policy.package, "glob"); assert.equal(policy.version, "7.2.3");
  assert.equal(policy.minimatchVersion, "11.0.3");
  checkDates(policy, now);
  for (const [actual, expected] of [["patchHash","patchSha256"],["packageJsonHash","packageJsonSha256"],
    ["licenseHash","licenseSha256"],["treeHash","installedTreeSha256"],["fileCount","installedFileCount"],
    ["regressionHash","regressionTestSha256"]]) assert.equal(context[actual], policy[expected], actual);
  assert.equal(policy.regressionTest, "test/security-minimatch-compatibility.test.js");
  const required = ["glob.js","sync.js"];
  assert.deepEqual(Object.keys(policy.installedFiles).sort(), required);
  assert.deepEqual(Object.keys(context.installedHashes).sort(), required);
  for (const file of required) {
    assert.match(policy.installedFiles[file].beforeSha256, /^[a-f0-9]{64}$/);
    assert.equal(context.installedHashes[file], policy.installedFiles[file].afterSha256, "Installed glob compatibility drift: " + file);
  }
  assert.equal(context.minimatchVersion, policy.minimatchVersion);
  const packages = context.lock.replaceAll("\r\n","\n").split("packages:\n")[1]?.split("\nsnapshots:")[0];
  assert(packages?.includes("  glob@7.2.3:\n    resolution: {integrity: " + policy.originalTarballIntegrity + "}\n"), "Original glob tarball integrity drift");
  checkDeclarations(context.registeredPolicies, context.workspace, context.lock);
}

function consumer(root, ...packages) {
  let parent = createRequire(path.join(root, "package.json"));
  for (const name of packages) parent = createRequire(parent.resolve(name)); return parent;
}
function childEnvironment(extra = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP, TMP: process.env.TMP, LANG: "C.UTF-8", NODE_ENV: "test", ...extra };
}

function verify(root = repository) {
  const policy = JSON.parse(fs.readFileSync(path.join(__dirname, "patch-policy.json"), "utf8"));
  assert(Array.isArray(policy.securityBackports) && policy.securityBackports.length === 1, "Exactly the registered MSAL security backport is required");
  assert(Array.isArray(policy.compatibilityPatches) && policy.compatibilityPatches.length === 1, "Exactly the registered glob compatibility patch is required");
  const policies = [policy, ...policy.securityBackports, ...policy.compatibilityPatches], workspace = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"), lock = fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  const compatibility = policy.compatibilityPatches[0];
  for (const chain of [["exceljs","archiver","archiver-utils"], ["exceljs","archiver","zip-stream","archiver-utils"], ["exceljs","unzipper","fstream","rimraf"]]) {
    const parent = consumer(root, ...chain), packageFile = parent.resolve("glob/package.json"), packageRoot = path.dirname(packageFile);
    const metadata = JSON.parse(fs.readFileSync(packageFile,"utf8")); assert.equal(metadata.name, "glob"); assert.equal(metadata.version, "7.2.3");
    const inventory = packageInventory(packageRoot), req = createRequire(parent.resolve("glob"));
    checkGlobCompatibilityPolicy(compatibility, { patchHash: hash(path.join(root,compatibility.patch)), packageJsonHash: hash(packageFile),
      licenseHash: hash(path.join(packageRoot,"LICENSE")), treeHash: inventory.sha256, fileCount: inventory.files.length,
      installedHashes: Object.fromEntries(["glob.js","sync.js"].map(file => [file,hash(path.join(packageRoot,file))])),
      regressionHash: hash(path.join(repository,compatibility.regressionTest)), minimatchVersion: req("minimatch/package.json").version,
      workspace,lock,registeredPolicies:policies });
  }
  for (const chain of [["exceljs", "archiver", "archiver-utils", "glob", "minimatch"], ["exceljs", "archiver", "readdir-glob", "minimatch"]]) {
    const req = consumer(root, ...chain), entry = req.resolve("brace-expansion");
    assert.equal(req("minimatch/package.json").version, compatibility.minimatchVersion);
    checkPolicy(policy, { patchHash: hash(path.join(root, policy.patch)), installedHash: hash(entry), workspace, lock, registeredPolicies: policies });
    const expand = req("brace-expansion"); assert.equal(typeof expand, "function"); assert.equal(expand.expand, expand);
    for (const key of ["EXPANSION_MAX", "EXPANSION_MAX_LENGTH", "EXPANSION_MAX_DEPTH", "EXPANSION_MAX_REWRITES"]) assert.ok(Number.isFinite(expand[key]) && expand[key] > 0, key);
    assert.deepEqual(expand("file-{a,b}-{1..2}"), ["file-a-1", "file-a-2", "file-b-1", "file-b-2"]); assert.equal(expand("{a,b,c}", { max: 2 }).length, 2);
  }
  for (const scenario of ["brace-nesting", "brace-comma", "brace-rewrite", "minimatch-optimization"]) {
    const result = spawnSync(process.execPath, ["--no-global-search-paths", "--max-old-space-size=192", path.join(repository, "test-support/security-audit/ops-dependency-remediation.probe.cjs"), scenario],
      { env: childEnvironment(), timeout: 15000, encoding: "utf8", windowsHide: true });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "completed");
  }
  const remediations = [];
  for (const backport of policy.securityBackports) {
    const req = consumer(root, "tedious", "@azure/identity"), packageFile = req.resolve("@azure/msal-node/package.json"), packageRoot = path.dirname(packageFile);
    const metadata = JSON.parse(fs.readFileSync(packageFile, "utf8")); assert.equal(metadata.name, backport.package); assert.equal(metadata.version, backport.version);
    const inventory = packageInventory(packageRoot), installedHashes = {};
    for (const relative of Object.keys(backport.installedFiles)) installedHashes[relative] = hash(path.join(packageRoot, relative));
    const regression = path.join(repository, backport.regressionTest);
    checkBackportPolicy(backport, { patchHash: hash(path.join(root, backport.patch)), packageJsonHash: hash(packageFile),
      licenseHash: hash(path.join(packageRoot, "LICENSE")), treeHash: inventory.sha256, fileCount: inventory.files.length,
      installedHashes, regressionHash: hash(regression), workspace, lock, registeredPolicies: policies });
    const run = spawnSync(process.execPath, ["--no-global-search-paths", "--test", "--test-reporter=tap", regression], {
      env: childEnvironment({ GP_MSAL_TEST_PACKAGE_ROOT: packageRoot }), timeout: 30000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true,
    });
    assert.ifError(run.error); assert.equal(run.status, 0, (run.stdout || "").slice(-4000) + (run.stderr || "").slice(-1000));
    assert.match(run.stdout, /^# pass 14$/m); assert.match(run.stdout, /^# fail 0$/m); assert.match(run.stdout, /^# skipped 0$/m);
    remediations.push({ status: "remediated_by_verified_patch", package: backport.package, version: backport.version, advisory: backport.advisory,
      patchSha256: backport.patchSha256, originalTarballIntegrity: backport.originalTarballIntegrity, originalTarballSha256: backport.originalTarballSha256,
      upstreamCommit: backport.upstreamCommit, installedTreeSha256: inventory.sha256, installedFiles: installedHashes, regressionTestSha256: backport.regressionTestSha256,
      regressionPassed: true, regressionPassCount: 14, expiresOn: backport.expiresOn });
  }
  return { passed: true, package: policy.package, version: policy.version, patchSha256: policy.patchSha256, expiresOn: policy.expiresOn,
    consumers: 2, boundedSecurityRegressions: 4, advisoryWaivers: 0, securityBackports: remediations,
    compatibilityPatches: [{ package:compatibility.package, version:compatibility.version, minimatchVersion:compatibility.minimatchVersion,
      patchSha256:compatibility.patchSha256, installedTreeSha256:compatibility.installedTreeSha256, expiresOn:compatibility.expiresOn, consumers:3 }] };
}
module.exports = { checkPolicy, checkBackportPolicy, checkGlobCompatibilityPolicy, checkDeclarations, packageInventory, verify };
if (require.main === module) {
  try { console.log(JSON.stringify(verify())); } catch (error) { console.error("Patch verification rejected: " + error.message); process.exitCode = 1; }
}

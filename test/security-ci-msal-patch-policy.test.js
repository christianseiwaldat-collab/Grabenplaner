"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { checkBackportPolicy, checkDeclarations } = require("../scripts/security/verify-patch.cjs");
const policy = require("../scripts/security/patch-policy.json");
const backport = policy.securityBackports[0];
function fixture() {
  const installedHashes = Object.fromEntries(Object.entries(backport.installedFiles).map(([relative, hashes]) => [relative, hashes.afterSha256]));
  return { patchHash: backport.patchSha256, packageJsonHash: backport.packageJsonSha256, licenseHash: backport.licenseSha256,
    treeHash: backport.installedTreeSha256, fileCount: backport.installedFileCount, regressionHash: backport.regressionTestSha256,
    installedHashes, registeredPolicies: [policy, backport],
    workspace: `patchedDependencies:\n  '${backport.package}@${backport.version}': ${backport.patch}\n  ${policy.package}@${policy.version}: ${policy.patch}\n`,
    lock: `patchedDependencies:\n  '${backport.package}@${backport.version}': ${backport.patchSha256}\n  ${policy.package}@${policy.version}: ${policy.patchSha256}\n\npackages:\n  '${backport.package}@${backport.version}':\n    resolution: {integrity: ${backport.originalTarballIntegrity}}\n\nsnapshots:\n`,
  };
}
const now = new Date("2026-10-24T12:00:00Z");
test("MSAL registration requires exact repaired code and preserves an empty advisory exception list", () => {
  checkBackportPolicy(backport, fixture(), now); assert.deepEqual(backport.advisoryExceptions, []);
});
for (const key of ["patchHash", "packageJsonHash", "licenseHash", "treeHash", "regressionHash"]) {
  test("MSAL registration rejects drift in " + key, () => {
    const context = fixture(); context[key] = "0".repeat(64); assert.throws(() => checkBackportPolicy(backport, context, now));
  });
}
for (const relative of ["dist/client/ConfidentialClientApplication.mjs", "lib/msal-node.cjs", "src/client/ConfidentialClientApplication.ts", "types/client/ConfidentialClientApplication.d.ts"]) {
  test("MSAL registration rejects vulnerable or missing " + relative, () => {
    const context = fixture(); context.installedHashes[relative] = backport.installedFiles[relative].beforeSha256;
    assert.throws(() => checkBackportPolicy(backport, context, now)); delete context.installedHashes[relative];
    assert.throws(() => checkBackportPolicy(backport, context, now));
  });
}
test("MSAL registration rejects a different original tarball integrity", () => {
  const context = fixture(); context.lock = context.lock.replace(backport.originalTarballIntegrity, "sha512-untrusted");
  assert.throws(() => checkBackportPolicy(backport, context, now), /integrity drift/);
});
test("MSAL registration rejects changed package version, advisory or upstream security commit", () => {
  for (const key of ["package", "version", "advisory", "upstreamCommit"]) {
    assert.throws(() => checkBackportPolicy({ ...backport, [key]: "unreviewed" }, fixture(), now));
  }
});
test("MSAL registration rejects an advisory waiver, future review and expired approval", () => {
  assert.throws(() => checkBackportPolicy({ ...backport, advisoryExceptions: [backport.advisory] }, fixture(), now));
  assert.throws(() => checkBackportPolicy(backport, fixture(), new Date("2026-10-23T12:00:00Z")));
  assert.throws(() => checkBackportPolicy(backport, fixture(), new Date("2026-11-24T00:00:00Z")));
});
test("MSAL registration rejects an additional, duplicate or removed patch declaration", () => {
  for (const suffix of ["  another@1.0.0: lib/unreviewed.patch\n", `  '${backport.package}@${backport.version}': ${backport.patch}\n`]) {
    const context = fixture(); context.workspace += suffix;
    assert.throws(() => checkDeclarations(context.registeredPolicies, context.workspace, context.lock));
  }
  const context = fixture(); context.workspace = context.workspace.replace(`  '${backport.package}@${backport.version}': ${backport.patch}\n`, "");
  assert.throws(() => checkBackportPolicy(backport, context, now));
});

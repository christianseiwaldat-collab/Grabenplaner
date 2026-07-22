"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const prefix = "server-tools/linux/offsite/";
const installer = "install-grabenplaner-offsite.sh";
const compatPath = path.join(root, "server-tools", "linux", "lib", "offsite-update-compat.js");
const { classify, fingerprint } = require(compatPath);
const schema = JSON.parse(fs.readFileSync(
  path.join(root, "server-tools", "linux", "offsite", "module-schema.json"),
  "utf8",
));

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const relativeArtifacts = schema.managedArtifacts.map((relative) => relative.slice(prefix.length));

function baseFiles() {
  return relativeArtifacts.map((relative) => [relative, sha256(`installed:${relative}`)]);
}

function installedContract(entries = baseFiles()) {
  return {
    format: "grabenplaner-linux-offsite-installed-contract",
    schemaVersion: 1,
    moduleVersion: 1,
    fingerprint: fingerprint(entries),
    files: entries.map(([relative, hash]) => ({ path: relative, sha256: hash })),
  };
}

function candidateContract(entries = baseFiles()) {
  const hashes = new Map(entries);
  return {
    offsiteModule: {
      schemaVersion: 1,
      moduleVersion: 1,
      activationPolicy: "explicit-root-setup",
      fingerprint: fingerprint(entries),
      installerSha256: hashes.get(installer),
      managedArtifacts: relativeArtifacts.map((relative) => `${prefix}${relative}`),
    },
  };
}

test("v0.75.4 offsite bridge accepts an identical installed module fingerprint", () => {
  const files = baseFiles();
  assert.equal(classify(candidateContract(files), installedContract(files)), "compatible");
});

test("v0.75.4 offsite bridge accepts exactly an installer-only hash transition", () => {
  const installedFiles = baseFiles();
  const candidateFiles = installedFiles.map(([relative, hash]) => [
    relative,
    relative === installer ? sha256("candidate:canonical-os-release-installer") : hash,
  ]);

  assert.equal(
    classify(candidateContract(candidateFiles), installedContract(installedFiles)),
    "compatible-installer-only",
  );
});

test("v0.75.4 offsite bridge requires migration when another managed artifact changes", () => {
  const installedFiles = baseFiles();
  const candidateFiles = installedFiles.map(([relative, hash]) => [
    relative,
    relative === "lib/offsite-common.sh" ? sha256("candidate:changed-common-library") : hash,
  ]);

  assert.equal(
    classify(candidateContract(candidateFiles), installedContract(installedFiles)),
    "migration-required:1->1",
  );
});

test("v0.75.4 offsite bridge rejects incomplete, duplicate, or manipulated contracts", async (t) => {
  const files = baseFiles();
  const installed = installedContract(files);
  const candidate = candidateContract(files);

  await t.test("incomplete candidate artifact set", () => {
    const incomplete = structuredClone(candidate);
    incomplete.offsiteModule.managedArtifacts.pop();
    assert.equal(classify(incomplete, installed), "invalid");
  });

  await t.test("duplicate candidate artifact", () => {
    const duplicate = structuredClone(candidate);
    duplicate.offsiteModule.managedArtifacts[1] = duplicate.offsiteModule.managedArtifacts[0];
    assert.equal(classify(duplicate, installed), "invalid");
  });

  await t.test("duplicate installed receipt entry", () => {
    const duplicate = structuredClone(installed);
    duplicate.files[1] = structuredClone(duplicate.files[0]);
    assert.equal(classify(candidate, duplicate), "invalid");
  });

  await t.test("installer hash inconsistent with an unchanged fingerprint", () => {
    const manipulated = structuredClone(candidate);
    manipulated.offsiteModule.installerSha256 = sha256("not-the-fingerprinted-installer");
    assert.equal(classify(manipulated, installed), "invalid");
  });

  await t.test("unsafe artifact path and malformed fingerprint", () => {
    const manipulatedPath = structuredClone(candidate);
    manipulatedPath.offsiteModule.managedArtifacts[0] = `${prefix}../outside.sh`;
    assert.equal(classify(manipulatedPath, installed), "invalid");

    const malformedHash = structuredClone(candidate);
    malformedHash.offsiteModule.fingerprint = "not-a-sha256";
    assert.equal(classify(malformedHash, installed), "invalid");
  });
});

test("v0.75.4 updater uses the installed root-protected helper and accepts both safe bridge states", () => {
  const updater = fs.readFileSync(
    path.join(root, "server-tools", "linux", "update-grabenplaner-server.sh"),
    "utf8",
  );

  assert.match(updater, /offsite_gate_helper="\$SCRIPT_DIR\/lib\/offsite-update-compat\.js"/);
  assert.match(updater, /\[\[ -f "\$offsite_gate_helper" && ! -L "\$offsite_gate_helper"/);
  assert.match(updater, /service_group_gid="\$\(getent group "\$service_group" \| awk -F: 'NR == 1 \{ print \$3 \}'\)"/);
  assert.match(updater, /\[\[ "\$service_group_gid" =~ \^\[0-9\]\+\$ \]\]/);
  assert.match(updater, /stat --format='%u:%g:%h' -- "\$offsite_gate_helper"\)" == "0:\$service_group_gid:1"/);
  assert.match(updater, /offsite_gate_helper_mode="\$\(stat --format='%a' -- "\$offsite_gate_helper"\)"/);
  assert.match(updater, /8#\$offsite_gate_helper_mode & 022/);
  assert.match(updater, /"\$node" "\$offsite_gate_helper" "\$manifest_result_file" "\$installed_offsite_receipt"/);
  assert.match(updater, /compatible\|compatible-installer-only\)\s*;;/);
});

test("v0.75.4 package verifier emits the candidate installer SHA-256", () => {
  const verification = spawnSync(process.execPath, [
    path.join(root, "server-tools", "linux", "lib", "verify-package.js"),
    "--runtime-contract",
    root,
  ], { encoding: "utf8" });

  assert.equal(verification.status, 0, verification.stderr);
  const result = JSON.parse(verification.stdout);
  const expected = crypto.createHash("sha256").update(fs.readFileSync(
    path.join(root, "server-tools", "linux", "offsite", installer),
  )).digest("hex");
  assert.equal(result.offsiteModule.installerSha256, expected);
  const expectedFiles = result.offsiteModule.managedArtifacts.map((relative) => [
    relative.slice(prefix.length),
    crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex"),
  ]);
  assert.equal(result.offsiteModule.fingerprint, fingerprint(expectedFiles));
});

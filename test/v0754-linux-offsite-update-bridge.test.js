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
const legacyV1Artifacts = [
  "grabenplaner-offsite-check.sh",
  "grabenplaner-offsite-pre-update.sh",
  "grabenplaner-offsite-prepare.sh",
  "grabenplaner-offsite-read-secret.sh",
  "grabenplaner-offsite-rclone-wrapper.sh",
  "grabenplaner-offsite-restore-test.sh",
  "grabenplaner-offsite-upload.sh",
  "install-grabenplaner-offsite.sh",
  "lib/offsite-common.sh",
  "lib/offsite-contract.js",
  "lib/offsite-restore-verify.js",
  "lib/offsite-retention-verify.js",
  "lib/offsite-stage.js",
  "lib/offsite-status.js",
  "lib/offsite-setup-rclone-wrapper.sh",
  "systemd/grabenplaner-offsite-check.service.in",
  "systemd/grabenplaner-offsite-check.timer.in",
  "systemd/grabenplaner-offsite-prepare.service.in",
  "systemd/grabenplaner-offsite-restore-test.service.in",
  "systemd/grabenplaner-offsite-restore-test.timer.in",
  "systemd/grabenplaner-offsite-upload.service.in",
  "systemd/grabenplaner-offsite-upload.timer.in",
  "uninstall-grabenplaner-offsite.sh",
  "test-grabenplaner-offsite.sh",
];
const v4Artifacts = [
  "grabenplaner-offsite-application-smoke.sh",
  "lib/application-smoke.js",
  "systemd/grabenplaner-offsite-application-smoke.service.in",
  "systemd/grabenplaner-offsite-assurance.timer.in",
];
const legacyV3Artifacts = relativeArtifacts.filter((relative) => !v4Artifacts.includes(relative));
const legacyV2Artifacts = legacyV3Artifacts.filter((relative) => ![
  "lib/assurance-control-broker.js",
  "systemd/grabenplaner-offsite-assurance-control.socket.in",
  "systemd/grabenplaner-offsite-assurance-control@.service.in",
].includes(relative));

function baseFiles(artifacts = relativeArtifacts) {
  return artifacts.map((relative) => [relative, sha256(`installed:${relative}`)]);
}

function installedContract(entries = baseFiles(), moduleVersion = schema.moduleVersion) {
  return {
    format: "grabenplaner-linux-offsite-installed-contract",
    schemaVersion: 1,
    moduleVersion,
    fingerprint: fingerprint(entries),
    files: entries.map(([relative, hash]) => ({ path: relative, sha256: hash })),
  };
}

function candidateContract(entries = baseFiles(), moduleVersion = schema.moduleVersion, artifacts = relativeArtifacts) {
  const hashes = new Map(entries);
  return {
    offsiteModule: {
      schemaVersion: 1,
      moduleVersion,
      activationPolicy: "explicit-root-setup",
      fingerprint: fingerprint(entries),
      installerSha256: hashes.get(installer),
      managedArtifacts: artifacts.map((relative) => `${prefix}${relative}`),
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
    "migration-required:5->5",
  );
});

test("offsite bridge recognizes the exact v1 contract as an explicit v1 to v5 migration", () => {
  const installedV1Files = baseFiles(legacyV1Artifacts);
  const candidateV2Files = baseFiles();
  assert.equal(
    classify(candidateContract(candidateV2Files), installedContract(installedV1Files, 1)),
    "migration-required:1->5",
  );

  const forgedV1Files = installedV1Files.with(0, ["lib/not-a-v1-artifact.js", sha256("forged")]);
  assert.equal(classify(candidateContract(candidateV2Files), installedContract(forgedV1Files, 1)), "invalid");
});

test("offsite bridge recognizes the exact v2 contract as an explicit v2 to v5 migration", () => {
  const installedV2Files = baseFiles(legacyV2Artifacts);
  assert.equal(
    classify(candidateContract(baseFiles()), installedContract(installedV2Files, 2)),
    "migration-required:2->5",
  );

  const forgedV2Files = installedV2Files.with(0, ["lib/not-a-v2-artifact.js", sha256("forged")]);
  assert.equal(classify(candidateContract(baseFiles()), installedContract(forgedV2Files, 2)), "invalid");
});

test("offsite bridge recognizes only the exact v3 contract for a v3 to v5 migration", () => {
  const installedV3Files = baseFiles(legacyV3Artifacts);
  assert.equal(
    classify(candidateContract(baseFiles()), installedContract(installedV3Files, 3)),
    "migration-required:3->5",
  );

  const forgedV3Files = installedV3Files.with(0, ["lib/not-a-v3-artifact.js", sha256("forged")]);
  assert.equal(classify(candidateContract(baseFiles()), installedContract(forgedV3Files, 3)), "invalid");
});

test("offsite bridge requires the explicit v4 to v5 migration for the bounded lock wait", () => {
  const installedV4Files = baseFiles();
  assert.equal(
    classify(candidateContract(baseFiles()), installedContract(installedV4Files, 4)),
    "migration-required:4->5",
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

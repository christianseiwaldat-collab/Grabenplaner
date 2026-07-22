"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const verifier = path.join(root, "server-tools", "linux", "lib", "verify-package.js");
const { classify, fingerprint } = require("../server-tools/linux/lib/offsite-update-compat");
const PREFIX = "server-tools/linux/offsite/";
const V1_PATHS = Object.freeze([
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
  "test-grabenplaner-offsite.sh",
  "uninstall-grabenplaner-offsite.sh",
]);
const V4_PATHS = Object.freeze([
  "grabenplaner-offsite-application-smoke.sh",
  "grabenplaner-offsite-assurance.sh",
  "grabenplaner-offsite-check.sh",
  "grabenplaner-offsite-pre-update.sh",
  "grabenplaner-offsite-prepare.sh",
  "grabenplaner-offsite-read-secret.sh",
  "grabenplaner-offsite-rclone-wrapper.sh",
  "grabenplaner-offsite-rebind-rclone.sh",
  "grabenplaner-offsite-recovery-set.sh",
  "grabenplaner-offsite-restore-test.sh",
  "grabenplaner-offsite-upload.sh",
  "install-grabenplaner-offsite.sh",
  "lib/application-smoke.js",
  "lib/assurance-control-broker.js",
  "lib/assurance-history.js",
  "lib/offsite-common.sh",
  "lib/offsite-contract.js",
  "lib/offsite-rclone-policy.js",
  "lib/offsite-restore-verify.js",
  "lib/offsite-retention-verify.js",
  "lib/offsite-setup-rclone-wrapper.sh",
  "lib/offsite-stage.js",
  "lib/offsite-status.js",
  "systemd/grabenplaner-offsite-application-smoke.service.in",
  "systemd/grabenplaner-offsite-assurance-control.socket.in",
  "systemd/grabenplaner-offsite-assurance-control@.service.in",
  "systemd/grabenplaner-offsite-assurance.timer.in",
  "systemd/grabenplaner-offsite-assurance@.service.in",
  "systemd/grabenplaner-offsite-check.service.in",
  "systemd/grabenplaner-offsite-check.timer.in",
  "systemd/grabenplaner-offsite-prepare.service.in",
  "systemd/grabenplaner-offsite-restore-test.service.in",
  "systemd/grabenplaner-offsite-restore-test.timer.in",
  "systemd/grabenplaner-offsite-upload.service.in",
  "systemd/grabenplaner-offsite-upload.timer.in",
  "test-grabenplaner-offsite.sh",
  "uninstall-grabenplaner-offsite.sh",
]);

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function files(paths, seed) {
  return new Map(paths.map((relative) => [relative, sha(`${seed}:${relative}`)]));
}

function installed(version, paths, seed) {
  const mapped = files(paths, seed);
  return {
    format: "grabenplaner-linux-offsite-installed-contract",
    schemaVersion: 1,
    moduleVersion: version,
    fingerprint: fingerprint(mapped),
    files: [...mapped].map(([relative, sha256]) => ({ path: relative, sha256 })),
  };
}

function candidate(version, paths, seed) {
  const mapped = files(paths, seed);
  return { offsiteModule: {
    schemaVersion: 1,
    moduleVersion: version,
    activationPolicy: "explicit-root-setup",
    fingerprint: fingerprint(mapped),
    installerSha256: mapped.get("install-grabenplaner-offsite.sh"),
    managedArtifacts: paths.map((relative) => `${PREFIX}${relative}`),
  } };
}

function managedBlobFingerprint(schemaRelativePath) {
  const schema = JSON.parse(fs.readFileSync(path.join(root, schemaRelativePath), "utf8"));
  const managedArtifacts = schema.managedArtifacts.slice().sort();
  const result = spawnSync("git", ["ls-files", "-s", "--", ...managedArtifacts], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const blobs = new Map(result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^\d+ ([0-9a-f]{40,64}) \d+\t(.+)$/);
    assert.ok(match, `Unerwarteter Git-Indexeintrag: ${line}`);
    return [match[2].replace(/\\/g, "/"), match[1]];
  }));
  assert.equal(blobs.size, managedArtifacts.length);
  const payload = managedArtifacts.map((relative) => {
    assert.ok(blobs.has(relative), `Verwaltetes Git-Blob fehlt: ${relative}`);
    return `${relative}\0${blobs.get(relative)}\n`;
  }).join("");
  return { paths: managedArtifacts, fingerprint: sha(payload) };
}

test("v0.75.9: Bridge hält die Git-Blobs von Runtime 2, Offsite v1 und Hardening v1 bytegleich", () => {
  const result = spawnSync(process.execPath, [verifier, "--runtime-contract", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const contract = JSON.parse(result.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "0.75.9-beta");
  assert.equal(contract.deploymentSchemaVersion, 2);
  assert.equal(contract.offsiteModule.moduleVersion, 1);
  assert.equal(contract.hardeningModule.moduleVersion, 1);

  const runtime = managedBlobFingerprint("server-tools/linux/runtime-schema.json");
  const offsite = managedBlobFingerprint("server-tools/linux/offsite/module-schema.json");
  const hardening = managedBlobFingerprint("server-tools/linux/hardening/module-schema.json");
  assert.equal(runtime.paths.length, 7);
  assert.equal(runtime.fingerprint, "6d41a3478aea65096cbd5b06dbc8ba787d69cb4e4bcc568e2712121c576762fd");
  assert.equal(offsite.paths.length, 24);
  assert.equal(offsite.fingerprint, "f024baadf6ba64a07ba9138e58daa9d893dc6268027b3dff29424fe11f4da569");
  assert.equal(hardening.paths.length, 17);
  assert.equal(hardening.fingerprint, "483eb5126cf8b75c5b71ac0c36878ab2d22d01e3056e59ab441c12a842721c6a");
});

test("v0.75.9: Compat akzeptiert exakt v1 und v4 und erzwingt die Migration 1 nach 4", () => {
  assert.equal(classify(candidate(1, V1_PATHS, "v1"), installed(1, V1_PATHS, "v1")), "compatible");
  assert.equal(classify(candidate(4, V4_PATHS, "v4"), installed(4, V4_PATHS, "v4")), "compatible");
  assert.equal(classify(candidate(4, V4_PATHS, "v4"), installed(1, V1_PATHS, "v1")), "migration-required:1->4");
  assert.equal(classify(candidate(1, V1_PATHS, "v1"), installed(4, V4_PATHS, "v4")), "invalid");
  assert.equal(classify(candidate(2, V1_PATHS, "v2"), installed(1, V1_PATHS, "v1")), "invalid");
  assert.equal(classify(candidate(4, V4_PATHS.slice(1), "v4"), installed(1, V1_PATHS, "v1")), "invalid");
});

test("v0.75.9: Updater vertraut dem Helper nur im eigenen root:Dienstgruppe-Schutzvertrag", () => {
  const updater = fs.readFileSync(
    path.join(root, "server-tools", "linux", "update-grabenplaner-server.sh"),
    "utf8",
  );
  const common = fs.readFileSync(path.join(root, "server-tools", "linux", "lib", "common.sh"), "utf8");

  assert.match(common, /chown -R "root:\$group" -- "\$path"/);
  assert.match(common, /find "\$path" -type f ! -perm \/111 -exec chmod 0640/);
  assert.match(updater, /service_group_gid="\$\(getent group "\$service_group"/);
  assert.match(updater, /\[\[ "\$service_group_gid" =~ \^\[0-9\]\+\$ \]\]/);
  assert.match(updater, /\[\[ -f "\$offsite_gate_helper" && ! -L "\$offsite_gate_helper"/);
  assert.match(updater, /stat --format='%u:%g:%h' -- "\$offsite_gate_helper"\)" == "0:\$service_group_gid:1"/);
  assert.doesNotMatch(updater, /offsite_gate_helper[\s\S]{0,300}"0:0:1"/);
  assert.match(updater, /8#\$offsite_gate_helper_mode & 022/);
});

const bridgePackageRoot = process.env.GRABENPLANER_V0759_PACKAGE_ROOT;
const originalVerifier = process.env.GRABENPLANER_V0757_VERIFIER;
test("v0.75.9: originaler v0.75.7-Verifier akzeptiert das fertige Bridge-Paket", {
  skip: !(bridgePackageRoot && originalVerifier),
}, () => {
  const result = spawnSync(process.execPath, [originalVerifier, bridgePackageRoot], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).appVersion, "0.75.9-beta");
});

const v078PackageRoot = process.env.GRABENPLANER_V078_PACKAGE_ROOT;
test("v0.75.9: Bridge-Verifier akzeptiert das finale v0.78-Paket", { skip: !v078PackageRoot }, () => {
  const result = spawnSync(process.execPath, [verifier, v078PackageRoot], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const verified = JSON.parse(result.stdout);
  assert.equal(verified.appVersion, "0.78.0-beta");
  assert.equal(verified.offsiteModule.moduleVersion, 4);
});

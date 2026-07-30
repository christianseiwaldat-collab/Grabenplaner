"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const offsiteRoot = path.join(root, "server-tools", "linux", "offsite");
const contractHelper = path.join(offsiteRoot, "lib", "offsite-contract.js");
const policyHelper = path.join(offsiteRoot, "lib", "offsite-rclone-policy.js");
const installer = fs.readFileSync(path.join(offsiteRoot, "install-grabenplaner-offsite.sh"), "utf8");
const common = fs.readFileSync(path.join(offsiteRoot, "lib", "offsite-common.sh"), "utf8");
const broker = fs.readFileSync(path.join(offsiteRoot, "lib", "offsite-target-broker.js"), "utf8");
const statusWriter = fs.readFileSync(path.join(offsiteRoot, "lib", "offsite-status.js"), "utf8");

function runHelper(helper, args, options = {}) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

function policy(remote, config) {
  const result = runHelper(policyHelper, [remote], { input: config });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function unboundReceipt() {
  const result = runHelper(contractHelper, ["contract", offsiteRoot]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function googleConfig(remote) {
  return [
    `[${remote}]`,
    "type = drive",
    "client_id = XXX",
    "client_secret = XXX",
    "scope = drive.file",
    "token = XXX",
    "",
  ].join("\n");
}

function s3Config(remote, endpoint, region) {
  return [
    `[${remote}]`,
    "type = s3",
    "provider = Other",
    "env_auth = false",
    "access_key_id = XXX",
    "secret_access_key = XXX",
    `region = ${region}`,
    `endpoint = ${endpoint}`,
    "acl = private",
    "",
  ].join("\n");
}

function withBinding({ remote, config, repository }, callback) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-provider-binding-"));
  try {
    const receiptFile = path.join(temporary, "receipt.json");
    const policyFile = path.join(temporary, "policy.json");
    const repositoryFile = path.join(temporary, "repository");
    const boundFile = path.join(temporary, "bound.json");
    fs.writeFileSync(receiptFile, unboundReceipt());
    fs.writeFileSync(policyFile, policy(remote, config));
    fs.writeFileSync(repositoryFile, `${repository}\n`);
    const bound = runHelper(contractHelper, [
      "bind-provider",
      receiptFile,
      policyFile,
      repositoryFile,
    ]);
    assert.equal(bound.status, 0, bound.stderr);
    fs.writeFileSync(boundFile, bound.stdout);
    callback({
      temporary,
      receiptFile,
      policyFile,
      repositoryFile,
      boundFile,
      bound: JSON.parse(bound.stdout),
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

test("Google Drive binding is written into the installed contract and reverified", () => {
  withBinding({
    remote: "gpdrive",
    config: googleConfig("gpdrive"),
    repository: "rclone:gpdrive:Legacy-Sicherungen/Restic",
  }, ({ boundFile, policyFile, repositoryFile, bound }) => {
    assert.equal(bound.providerBinding.providerId, "google_drive");
    assert.equal(bound.providerBinding.repositoryLayout, "google-drive-direct-safe-path-v1");
    assert.equal(bound.providerBinding.storageRoot, null);
    assert.match(bound.providerBinding.policySha256, /^[a-f0-9]{64}$/);
    const verified = runHelper(contractHelper, [
      "verify-provider-binding",
      boundFile,
      policyFile,
      repositoryFile,
    ]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(verified.stdout, "google_drive\n");
  });
});

test("Hetzner and Backblaze bind only their fixed EU endpoint and managed S3 layout", () => {
  const cases = [
    {
      providerId: "hetzner_object_storage",
      endpoint: "nbg1.your-objectstorage.com",
      region: "nbg1",
      bucket: "grabenplaner-offsite-at",
    },
    {
      providerId: "backblaze_b2",
      endpoint: "s3.eu-central-003.backblazeb2.com",
      region: "eu-central-003",
      bucket: "grabenplaner-offsite-eu",
    },
  ];
  for (const item of cases) {
    withBinding({
      remote: "gps3",
      config: s3Config("gps3", item.endpoint, item.region),
      repository: `rclone:gps3:${item.bucket}/Grabenplaner-Offsite/Produktiv`,
    }, ({ boundFile, policyFile, repositoryFile, bound }) => {
      assert.equal(bound.providerBinding.providerId, item.providerId);
      assert.equal(bound.providerBinding.endpoint, item.endpoint);
      assert.equal(bound.providerBinding.region, item.region);
      assert.equal(bound.providerBinding.repositoryLayout, "s3-managed-prefix-v1");
      assert.equal(bound.providerBinding.storageRoot, item.bucket);
      const verified = runHelper(contractHelper, [
        "verify-provider-binding",
        boundFile,
        policyFile,
        repositoryFile,
      ]);
      assert.equal(verified.status, 0, verified.stderr);
      assert.equal(verified.stdout, `${item.providerId}\n`);
    });
  }
});

test("contract binding rejects free S3 paths and detects live policy or repository drift", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-provider-reject-"));
  try {
    const receiptFile = path.join(temporary, "receipt.json");
    const policyFile = path.join(temporary, "policy.json");
    const repositoryFile = path.join(temporary, "repository");
    fs.writeFileSync(receiptFile, unboundReceipt());
    fs.writeFileSync(policyFile, policy("gps3", s3Config(
      "gps3",
      "fsn1.your-objectstorage.com",
      "fsn1",
    )));
    for (const repository of [
      "rclone:gps3:bucket/free-prefix/repository",
      "rclone:gps3:bucket/Grabenplaner-Offsite/too/deep",
      "rclone:gps3:192.168.0.1/Grabenplaner-Offsite/Produktiv",
      "rclone:gps3:bucket/Grabenplaner-Offsite/../escape",
    ]) {
      fs.writeFileSync(repositoryFile, `${repository}\n`);
      const result = runHelper(contractHelper, [
        "bind-provider",
        receiptFile,
        policyFile,
        repositoryFile,
      ]);
      assert.notEqual(result.status, 0, repository);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /access_key|secret_access|token/i);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  withBinding({
    remote: "gps3",
    config: s3Config("gps3", "fsn1.your-objectstorage.com", "fsn1"),
    repository: "rclone:gps3:grabenplaner-at/Grabenplaner-Offsite/Produktiv",
  }, ({ boundFile, policyFile, repositoryFile }) => {
    fs.writeFileSync(policyFile, policy("gps3", s3Config(
      "gps3",
      "nbg1.your-objectstorage.com",
      "nbg1",
    )));
    const endpointDrift = runHelper(contractHelper, [
      "verify-provider-binding",
      boundFile,
      policyFile,
      repositoryFile,
    ]);
    assert.notEqual(endpointDrift.status, 0);

    fs.writeFileSync(policyFile, policy("gps3", s3Config(
      "gps3",
      "fsn1.your-objectstorage.com",
      "fsn1",
    )));
    fs.writeFileSync(repositoryFile, "rclone:gps3:other-bucket/Grabenplaner-Offsite/Produktiv\n");
    const bucketDrift = runHelper(contractHelper, [
      "verify-provider-binding",
      boundFile,
      policyFile,
      repositoryFile,
    ]);
    assert.notEqual(bucketDrift.status, 0);
  });
});

test("installer writes the validated provider and runtime checks do not trust ENV alone", () => {
  assert.match(installer, /validated_provider="\$\("\$OFFSITE_NODE"[\s\S]*?verify-provider-binding/);
  assert.match(installer, /GRABENPLANER_OFFSITE_PROVIDER=\$\{provider\}/);
  assert.doesNotMatch(installer, /GRABENPLANER_OFFSITE_PROVIDER=google_drive/);
  assert.match(common, /verify-installed-bound/);
  assert.match(common, /offsite_assert_bound_rclone_provider "\$credentials"/);
  assert.match(common, /verify-provider-binding/);
  assert.match(broker, /readBoundProviderId/);
  assert.match(broker, /!== "google_drive"\) fail\(\)/);
  assert.match(installer, /if \[\[ "\$validated_provider" == "google_drive" \]\]; then[\s\S]*?enable --now grabenplaner-offsite-target-control\.socket/);
  assert.match(installer, /disable --now grabenplaner-offsite-target-control\.socket/);
  assert.match(statusWriter, /"providerId"/);
  assert.match(statusWriter, /CURRENT_SCHEMA_VERSION = 2/);
  assert.match(statusWriter, /LEGACY_SCHEMA_VERSION = 1/);
  assert.match(statusWriter, /case "bind-provider":/);
  assert.match(statusWriter, /case "bind-provider":[\s\S]*?next = emptyStatus\(true, requestedProviderId\)/);
  assert.match(statusWriter, /legacySchema && normalized\.configured && normalized\.state !== "error"[\s\S]*?normalized\.state = "warning"/);
  assert.match(common, /--provider-id "\$provider_id"/);
  assert.match(installer, /offsite_status bind-provider/);
});

test("reinstall stays on the bound provider and repository while first-time S3 uses a bucket check", () => {
  assert.match(installer, /previous_provider_id="\$\("\$OFFSITE_NODE"[\s\S]*?provider-id/);
  assert.match(installer, /previous_provider_id="google_drive"/);
  assert.match(installer, /previous_provider_binding == 1[\s\S]*?verify-provider-binding[\s\S]*?Provider-, Endpoint- oder Repository-Richtlinie/);
  assert.match(installer, /"\$validated_provider" != "\$previous_provider_id"[\s\S]*?vollstaendig abgesicherten Migrationsvorgang/);
  assert.match(installer, /"\$repository" != "\$previous_repository"[\s\S]*?Repositorys ist im Installer nicht erlaubt/);
  assert.match(installer, /"\$repository_id" != "\$previous_repository_id"[\s\S]*?Repository-Identitaet weicht/);
  assert.match(installer, /--initialize-repository ist nur bei der ersten Offsite-Einrichtung erlaubt/);
  assert.match(installer, /if \[\[ "\$validated_provider" == "google_drive" \]\]; then[\s\S]*?about "\$rclone_remote:"[\s\S]*?else[\s\S]*?lsf "\$rclone_remote:\$s3_bucket"/);
});

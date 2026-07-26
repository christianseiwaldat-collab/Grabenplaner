"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const prefix = "server-tools/linux/offsite/";
const verifier = path.join(root, "server-tools", "linux", "lib", "verify-package.js");
const schema = JSON.parse(fs.readFileSync(
  path.join(root, "server-tools", "linux", "offsite", "module-schema.json"),
  "utf8",
));
const { classify, fingerprint } = require(path.join(
  root,
  "server-tools",
  "linux",
  "lib",
  "offsite-update-compat.js",
));

const artifacts = schema.managedArtifacts.map((relative) => relative.slice(prefix.length));
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const files = artifacts.map((relative) => [relative, sha256(`bridge:${relative}`)]);
const installerSha256 = new Map(files).get("install-grabenplaner-offsite.sh");

function candidateContract(moduleVersion) {
  return {
    offsiteModule: {
      schemaVersion: 1,
      moduleVersion,
      activationPolicy: "explicit-root-setup",
      fingerprint: fingerprint(files),
      installerSha256,
      managedArtifacts: artifacts.map((relative) => `${prefix}${relative}`),
    },
  };
}

function installedContract(moduleVersion = 4) {
  return {
    format: "grabenplaner-linux-offsite-installed-contract",
    schemaVersion: 1,
    moduleVersion,
    fingerprint: fingerprint(files),
    files: files.map(([relative, hash]) => ({ path: relative, sha256: hash })),
  };
}

function verifyRuntime(candidateRoot) {
  return spawnSync(process.execPath, [
    verifier,
    "--runtime-contract",
    candidateRoot,
  ], { encoding: "utf8" });
}

test("v0.85.4 keeps v4 compatible and exposes v5 only through an explicit migration", () => {
  assert.equal(schema.moduleVersion, 4);
  assert.equal(classify(candidateContract(4), installedContract(4)), "compatible");
  assert.equal(classify(candidateContract(5), installedContract(4)), "migration-required:4->5");
  assert.equal(classify(candidateContract(5), installedContract(5)), "compatible");
});

test("v0.85.4 verifier accepts exact v4 and v5 trees without weakening path validation", () => {
  const verifiedV4 = verifyRuntime(root);
  assert.equal(verifiedV4.status, 0, verifiedV4.stderr);
  assert.equal(JSON.parse(verifiedV4.stdout).offsiteModule.moduleVersion, 4);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v0854-verifier-"));
  try {
    fs.cpSync(
      path.join(root, "server-tools"),
      path.join(temporaryRoot, "server-tools"),
      { recursive: true },
    );
    const candidateSchemaPath = path.join(
      temporaryRoot,
      "server-tools",
      "linux",
      "offsite",
      "module-schema.json",
    );
    const candidateSchema = JSON.parse(fs.readFileSync(candidateSchemaPath, "utf8"));
    candidateSchema.moduleVersion = 5;
    fs.writeFileSync(candidateSchemaPath, `${JSON.stringify(candidateSchema, null, 2)}\n`);

    const verifiedV5 = verifyRuntime(temporaryRoot);
    assert.equal(verifiedV5.status, 0, verifiedV5.stderr);
    const v5Contract = JSON.parse(verifiedV5.stdout).offsiteModule;
    assert.equal(v5Contract.moduleVersion, 5);
    assert.deepEqual(v5Contract.managedArtifacts, [...schema.managedArtifacts].sort());

    candidateSchema.managedArtifacts[0] = "server-tools/linux/offsite/../outside.sh";
    fs.writeFileSync(candidateSchemaPath, `${JSON.stringify(candidateSchema, null, 2)}\n`);
    const rejectedUnsafeTree = verifyRuntime(temporaryRoot);
    assert.notEqual(rejectedUnsafeTree.status, 0);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("v0.85.4 changes only the package version while product labels remain v0.85 Beta", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const launcher = fs.readFileSync(path.join(root, "Grabenplaner v0.85 Beta starten.cmd"), "utf8");
  const indexHtml = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

  assert.equal(packageJson.version, "0.85.4-beta");
  assert.match(launcher, /set "APP_VERSION=v0\.85 Beta"/);
  assert.match(indexHtml, /v0\.85 Beta/);
});

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const schema = JSON.parse(read("server-tools/linux/hardening/module-schema.json"));
const hardeningRoot = path.join(root, "server-tools", "linux", "hardening");

function withHardeningCopy(callback) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-hardening-contract-"));
  const moduleRoot = path.join(temporaryRoot, "module");
  try {
    fs.cpSync(hardeningRoot, moduleRoot, { recursive: true });
    callback(moduleRoot);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function withRuntimeContractCopy(callback) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-package-contract-"));
  try {
    const runtimeSchema = JSON.parse(read("server-tools/linux/runtime-schema.json"));
    const offsiteSchema = JSON.parse(read("server-tools/linux/offsite/module-schema.json"));
    const required = [
      "server-tools/linux/runtime-schema.json",
      "server-tools/linux/offsite/module-schema.json",
      ...runtimeSchema.managedArtifacts,
      ...offsiteSchema.managedArtifacts,
      ...schema.managedArtifacts,
    ];
    for (const relative of new Set(required)) {
      const source = path.join(root, ...relative.split("/"));
      const destination = path.join(temporaryRoot, ...relative.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    callback(temporaryRoot);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test("v0.75 keeps hardening separate from the schema-2 core runtime and binds its exact fingerprint", () => {
  const verification = spawnSync(process.execPath, [
    path.join(root, "server-tools/linux/lib/verify-package.js"),
    "--runtime-contract",
    root,
  ], { encoding: "utf8" });
  assert.equal(verification.status, 0, verification.stderr);
  const result = JSON.parse(verification.stdout);
  assert.equal(result.deploymentSchemaVersion, 2);
  assert.equal(result.managedArtifacts.length, 7);
  assert.equal(result.managedArtifacts.some((relative) => relative.includes("/hardening/")), false);

  const { moduleContract } = require(path.join(root, "server-tools/linux/hardening/lib/hardening-contract.js"));
  const expected = moduleContract(hardeningRoot);
  assert.deepEqual(result.hardeningModule, expected);
  assert.equal(result.hardeningModule.format, "grabenplaner-linux-hardening-installed-contract");
  assert.match(result.hardeningModule.schemaSha256, /^[0-9a-f]{64}$/);
  assert.match(result.hardeningModule.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(result.hardeningModule.files.length, schema.managedArtifacts.length);
});

test("v0.75 hardening contract accepts only its exact regular-file tree", () => {
  const { moduleContract } = require(path.join(hardeningRoot, "lib", "hardening-contract.js"));
  withHardeningCopy((moduleRoot) => {
    assert.doesNotThrow(() => moduleContract(moduleRoot));

    const extraFile = path.join(moduleRoot, "not-manifested.txt");
    fs.writeFileSync(extraFile, "not part of the module", "utf8");
    assert.throws(() => moduleContract(moduleRoot), /Nicht manifestierte Hardening-Moduldatei/);
    fs.rmSync(extraFile);

    const extraDirectory = path.join(moduleRoot, "not-manifested");
    fs.mkdirSync(extraDirectory);
    assert.throws(() => moduleContract(moduleRoot), /Nicht manifestiertes Hardening-Verzeichnis/);
    fs.rmSync(extraDirectory, { recursive: true });

    const linkedDirectory = path.join(moduleRoot, "linked-lib");
    fs.symlinkSync(path.join(moduleRoot, "lib"), linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => moduleContract(moduleRoot), /symbolischer Link/);
  });
});

test("v0.75 package verifier rejects an extra hardening file or directory", () => {
  withRuntimeContractCopy((temporaryRoot) => {
    const verifier = path.join(root, "server-tools/linux/lib/verify-package.js");
    const verify = () => spawnSync(process.execPath, [verifier, "--runtime-contract", temporaryRoot], { encoding: "utf8" });
    const clean = verify();
    assert.equal(clean.status, 0, clean.stderr);

    const extraFile = path.join(temporaryRoot, "server-tools", "linux", "hardening", "not-manifested.txt");
    fs.writeFileSync(extraFile, "not part of the module", "utf8");
    const withExtraFile = verify();
    assert.notEqual(withExtraFile.status, 0);
    assert.match(withExtraFile.stderr, /Nicht manifestierte Hardening-Moduldatei/);
    fs.rmSync(extraFile);

    const extraDirectory = path.join(temporaryRoot, "server-tools", "linux", "hardening", "not-manifested");
    fs.mkdirSync(extraDirectory);
    const withExtraDirectory = verify();
    assert.notEqual(withExtraDirectory.status, 0);
    assert.match(withExtraDirectory.stderr, /Nicht manifestiertes Hardening-Verzeichnis/);
  });
});

test("v0.75 hardening fingerprint uses the package builder's ordinal order", () => {
  const contractSource = read("server-tools/linux/hardening/lib/hardening-contract.js");
  const builder = read("server-tools/package/New-GrabenplanerLinuxServerPackage.ps1");
  const { moduleContract } = require(path.join(hardeningRoot, "lib", "hardening-contract.js"));
  const contract = moduleContract(hardeningRoot);
  const orderedPaths = contract.files.map((item) => item.path);
  const expectedPaths = [...orderedPaths].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
  const payload = contract.files.map((item) => `server-tools/linux/hardening/${item.path}\0${item.sha256}\n`).join("");

  assert.deepEqual(orderedPaths, expectedPaths);
  assert.equal(contract.fingerprint, crypto.createHash("sha256").update(payload).digest("hex"));
  assert.doesNotMatch(contractSource, /localeCompare/);
  assert.match(contractSource, /ordinalCompare/);
  assert.match(builder, /\[Array\]::Sort\(\$sortedHardeningArtifacts, \[StringComparer\]::Ordinal\)/);
});

test("v0.75 package builder and both package verifiers require every hardening artifact", () => {
  const builder = read("server-tools/package/New-GrabenplanerLinuxServerPackage.ps1");
  const verifier = read("server-tools/linux/lib/verify-package.js");
  const installer = read("server-tools/linux/install-grabenplaner-server.sh");
  for (const relative of schema.managedArtifacts) {
    const escaped = relative.replaceAll("/", "[\\\\/]").replaceAll(".", "\\.");
    assert.match(builder, new RegExp(escaped), `Builder fordert ${relative} nicht an.`);
    assert.match(verifier, new RegExp(relative.replaceAll("/", "\\/").replaceAll(".", "\\.")), `Verifier fordert ${relative} nicht an.`);
    assert.match(installer, new RegExp(relative.replaceAll("/", "\\/").replaceAll(".", "\\.")), `Installer fordert ${relative} nicht an.`);
  }
  assert.match(builder, /hardeningModule = \$hardeningModuleContract/);
  assert.match(builder, /Get-Sha256Text -Value \$hardeningFingerprintPayload\.ToString\(\)/);
  assert.match(verifier, /hardeningContractMatches\(manifest\.hardeningModule, hardeningModuleContract\)/);
  assert.match(installer, /hardeningContractMatches\(manifest\.hardeningModule, hardeningModuleContract\)/);
  assert.match(builder, /Der Hardening-Modulbaum enthaelt nicht exakt die freigegebenen Dateien und Verzeichnisse/);
  assert.match(verifier, /assertExactHardeningTree\(\)/);
  assert.match(installer, /assertExactHardeningTree\(\)/);
  assert.match(verifier, /const sortedArtifacts = \[\.\.\.artifacts\]\.sort\(\(\[left\], \[right\]\) => ordinalCompare\(left, right\)\)/);
  assert.match(installer, /const sortedHardeningArtifacts = \[\.\.\.hardeningArtifacts\]\.sort\(\(\[left\], \[right\]\) => ordinalCompare\(left, right\)\)/);
});

test("v0.75 package integration never activates host hardening implicitly", () => {
  const installer = read("server-tools/linux/install-grabenplaner-server.sh");
  const builder = read("server-tools/package/New-GrabenplanerLinuxServerPackage.ps1");
  const installArtifact = /server-tools\/linux\/hardening\/install-grabenplaner-host-hardening\.sh/g;
  assert.equal((installer.match(installArtifact) || []).length, 1, "Der Core-Installer darf den Hardening-Installer nur als Paketartefakt kennen.");
  assert.equal((builder.match(/server-tools[\\/]linux[\\/]hardening[\\/]install-grabenplaner-host-hardening\.sh/g) || []).length, 1);
  assert.doesNotMatch(installer, /systemctl\s+(?:enable|start|restart).*grabenplaner-host-security/);
  assert.doesNotMatch(installer, /ufw\s+(?:--force\s+)?enable/);
  assert.doesNotMatch(installer, /sshd?\s+-t/);
});

test("v0.75 hardening package schema stays exact and explicitly activated", () => {
  assert.deepEqual(Object.keys(schema).sort(), ["activationPolicy", "format", "managedArtifacts", "moduleVersion", "schemaVersion"]);
  assert.equal(schema.format, "grabenplaner-linux-hardening-module-contract");
  assert.equal(schema.schemaVersion, 1);
  assert.equal(schema.moduleVersion, 1);
  assert.equal(schema.activationPolicy, "explicit-root-two-session");
  assert.equal(new Set(schema.managedArtifacts).size, schema.managedArtifacts.length);
  assert.ok(schema.managedArtifacts.every((relative) => relative.startsWith("server-tools/linux/hardening/")));
});

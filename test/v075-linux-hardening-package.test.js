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
const legacyV075HardeningArtifacts = [
  "server-tools/linux/hardening/grabenplaner-host-security.sh",
  "server-tools/linux/hardening/install-grabenplaner-host-hardening.sh",
  "server-tools/linux/hardening/lib/hardening-common.sh",
  "server-tools/linux/hardening/lib/hardening-contract.js",
  "server-tools/linux/hardening/lib/hardening-policy.js",
  "server-tools/linux/hardening/module-schema.json",
  "server-tools/linux/hardening/systemd/grabenplaner-host-security-audit.service.in",
  "server-tools/linux/hardening/systemd/grabenplaner-host-security-audit.timer.in",
  "server-tools/linux/hardening/systemd/grabenplaner-host-security-rollback.service.in",
  "server-tools/linux/hardening/systemd/grabenplaner-host-security-rollback.timer.in",
  "server-tools/linux/hardening/templates/00-grabenplaner-hardening.conf",
  "server-tools/linux/hardening/templates/60grabenplaner-auto-upgrades",
  "server-tools/linux/hardening/templates/60grabenplaner-unattended-upgrades",
  "server-tools/linux/hardening/templates/60-grabenplaner-journald.conf",
  "server-tools/linux/hardening/templates/60-grabenplaner-sysctl.conf",
  "server-tools/linux/hardening/test-grabenplaner-host-hardening.sh",
  "server-tools/linux/hardening/uninstall-grabenplaner-host-hardening.sh",
];

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

function withCleanGitSnapshot(callback) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-clean-package-source-"));
  const snapshotRoot = path.join(temporaryRoot, "source");
  const outputRoot = path.join(temporaryRoot, "output");
  const runGit = (args, cwd = root) => {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  try {
    const clone = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", root, snapshotRoot], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(clone.status, 0, `${clone.stdout}\n${clone.stderr}`);

    const currentFiles = runGit(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    ).split("\0").filter(Boolean);
    for (const relative of currentFiles) {
      const source = path.join(root, relative);
      const destination = path.join(snapshotRoot, relative);
      if (!fs.existsSync(source)) {
        fs.rmSync(destination, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }

    runGit(["add", "--all"], snapshotRoot);
    runGit([
      "-c", "user.name=Grabenplaner Test",
      "-c", "user.email=grabenplaner-test@example.invalid",
      "commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "Test snapshot",
    ], snapshotRoot);
    runGit(["checkout-index", "--force", "--all"], snapshotRoot);
    assert.equal(runGit(["status", "--porcelain", "--untracked-files=all"], snapshotRoot), "");
    callback(snapshotRoot, outputRoot);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test("v0.90.7 keeps every managed Linux byte contract platform-stable", () => {
  const runtimeSchema = JSON.parse(read("server-tools/linux/runtime-schema.json"));
  const offsiteSchema = JSON.parse(read("server-tools/linux/offsite/module-schema.json"));
  const expectedCrlf = new Set([
    "server-tools/linux/grabenplaner-monitor.timer.in",
    "server-tools/linux/hardening/lib/hardening-contract.js",
    "server-tools/linux/hardening/lib/hardening-policy.js",
    "server-tools/linux/hardening/module-schema.json",
  ]);
  const managedArtifacts = new Set([
    "server-tools/linux/runtime-schema.json",
    "server-tools/linux/offsite/module-schema.json",
    "server-tools/linux/hardening/module-schema.json",
    ...runtimeSchema.managedArtifacts,
    ...offsiteSchema.managedArtifacts,
    ...schema.managedArtifacts,
  ]);
  const attributeResult = spawnSync("git", [
    "-C", root,
    "check-attr", "-z", "--stdin", "text", "eol",
  ], {
    input: `${[...managedArtifacts].join("\0")}\0`,
    encoding: "utf8",
  });
  assert.equal(attributeResult.status, 0, attributeResult.stderr);
  const fields = attributeResult.stdout.split("\0");
  assert.equal(fields.pop(), "");
  const effectiveAttributes = new Map();
  for (let index = 0; index < fields.length; index += 3) {
    const [relative, attribute, value] = fields.slice(index, index + 3);
    if (!effectiveAttributes.has(relative)) effectiveAttributes.set(relative, new Map());
    effectiveAttributes.get(relative).set(attribute, value);
  }
  assert.equal(fields.length, managedArtifacts.size * 6);
  for (const relative of managedArtifacts) {
    const expectedEol = expectedCrlf.has(relative) ? "crlf" : "lf";
    assert.equal(effectiveAttributes.get(relative)?.get("text"), "set", `${relative}: text`);
    assert.equal(effectiveAttributes.get(relative)?.get("eol"), expectedEol, `${relative}: eol`);
    const content = fs.readFileSync(path.join(root, ...relative.split("/")), "utf8");
    if (expectedCrlf.has(relative)) {
      assert.equal(content.includes("\r\n"), true, relative);
      const withoutCrlf = content.replaceAll("\r\n", "");
      assert.equal(withoutCrlf.includes("\n"), false, `${relative}: bare LF`);
      assert.equal(withoutCrlf.includes("\r"), false, `${relative}: bare CR`);
    } else {
      assert.equal(content.includes("\r"), false, `${relative}: CR`);
    }
  }
});

test("hardening stays separate from the current core runtime and binds its exact fingerprint", () => {
  const verification = spawnSync(process.execPath, [
    path.join(root, "server-tools/linux/lib/verify-package.js"),
    "--runtime-contract",
    root,
  ], { encoding: "utf8" });
  assert.equal(verification.status, 0, verification.stderr);
  const result = JSON.parse(verification.stdout);
  assert.equal(result.deploymentSchemaVersion, 5);
  // The explicit large-backup timeout delta changes both managed app units.
  // Production adoption still requires the separate runtime migration gate.
  assert.equal(result.fingerprint, "e5e8edd4e7710263ce1b89a5a1214a18a2b7f8a6d37a9248dcccaeb5ca074ef9");
  // Bounded staging hashes, the 1500-second ready check and serialized
  // copy work change the pinned Offsite module independently of Hardening.
  assert.equal(result.offsiteModule.fingerprint, "6aaa26d35310754c15c5d9a85aafdad4ac73dc8939d3917b3617a48879a06394");
  assert.equal(result.managedArtifacts.length, 11);
  assert.equal(result.managedArtifacts.some((relative) => relative.includes("/hardening/")), false);

  const { moduleContract } = require(path.join(root, "server-tools/linux/hardening/lib/hardening-contract.js"));
  const expected = moduleContract(hardeningRoot);
  assert.deepEqual(result.hardeningModule, expected);
  // The bounded listener retry and unknown audit results require an explicit
  // Hardening module transition; an app update must not silently adopt it.
  assert.equal(result.hardeningModule.fingerprint, "dc42a15ed03fe6f10eae2fbc38754fb9c44d14377a1a6989ee27527564140a50");
  assert.equal(result.hardeningModule.format, "grabenplaner-linux-hardening-installed-contract");
  assert.equal(result.hardeningModule.schemaVersion, schema.schemaVersion);
  assert.equal(result.hardeningModule.moduleVersion, schema.moduleVersion);
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

test("v0.75 hardening contract rejects obsolete module schemas instead of reinterpreting transactions", () => {
  const { moduleContract } = require(path.join(hardeningRoot, "lib", "hardening-contract.js"));
  withHardeningCopy((moduleRoot) => {
    const schemaPath = path.join(moduleRoot, "module-schema.json");
    const obsolete = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    obsolete.moduleVersion = 2;
    fs.writeFileSync(schemaPath, `${JSON.stringify(obsolete, null, 2)}\n`, "utf8");
    assert.throws(() => moduleContract(moduleRoot), /wird nicht unterstuetzt/);
  });
});

test("v0.75.1 hardening package remains acceptable to the installed v0.75 verifier", () => {
  const { moduleContract } = require(path.join(hardeningRoot, "lib", "hardening-contract.js"));
  assert.equal(schema.schemaVersion, 1);
  assert.equal(schema.moduleVersion, 1);
  assert.deepEqual(schema.managedArtifacts, legacyV075HardeningArtifacts);
  assert.equal(fs.existsSync(path.join(hardeningRoot, "templates", "zz-grabenplaner-journald.conf")), false);
  const contract = moduleContract(hardeningRoot);
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.moduleVersion, 1);
  assert.equal(contract.files.length, legacyV075HardeningArtifacts.length);
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
  assert.match(builder, /schemaVersion = \[int\]\$hardeningSchema\.schemaVersion/);
  assert.match(builder, /moduleVersion = \[int\]\$hardeningSchema\.moduleVersion/);
  assert.match(builder, /Get-Sha256Text -Value \$hardeningFingerprintPayload\.ToString\(\)/);
  assert.match(verifier, /hardeningContractMatches\(manifest\.hardeningModule, hardeningModuleContract\)/);
  assert.match(installer, /hardeningContractMatches\(manifest\.hardeningModule, hardeningModuleContract\)/);
  assert.match(verifier, /schemaVersion: contract\.schemaVersion/);
  assert.match(verifier, /moduleVersion: contract\.moduleVersion/);
  assert.match(installer, /schemaVersion: hardeningSchema\.schemaVersion/);
  assert.match(installer, /moduleVersion: hardeningSchema\.moduleVersion/);
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

test("v0.75 Linux package builder expands the complete hardening artifact list", {
  skip: process.platform !== "win32" ? "PowerShell-Paketbau wird im Windows-Job geprüft." : false,
}, () => {
  withCleanGitSnapshot((snapshotRoot, outputRoot) => {
    const builder = path.join(snapshotRoot, "server-tools", "package", "New-GrabenplanerLinuxServerPackage.ps1");
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", builder,
      "-SourceDirectory", snapshotRoot,
      "-OutputDirectory", outputRoot,
    ], { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const packageVersion = JSON.parse(fs.readFileSync(path.join(snapshotRoot, "package.json"), "utf8")).version;
    const packageName = `Grabenplaner-Server-v${packageVersion}-linux-x64.zip`;
    assert.ok(fs.existsSync(path.join(outputRoot, packageName)));
    assert.ok(fs.existsSync(path.join(outputRoot, `${packageName}.sha256`)));
  });
});

test("v0.90.7 Linux package builder rejects a clean but stale-EOL worktree", {
  skip: process.platform !== "win32" ? "PowerShell-Paketbau wird im Windows-Job geprueft." : false,
}, () => {
  withCleanGitSnapshot((snapshotRoot, outputRoot) => {
    const stalePath = path.join(snapshotRoot, "server-tools", "linux", "grabenplaner-monitor.timer.in");
    const canonical = fs.readFileSync(stalePath, "utf8");
    assert.equal(canonical.includes("\r\n"), true);
    fs.writeFileSync(stalePath, canonical.replaceAll("\r\n", "\n"), "utf8");

    const hideStaleBytes = spawnSync("git", [
      "-C", snapshotRoot,
      "update-index", "--assume-unchanged", "--",
      "server-tools/linux/grabenplaner-monitor.timer.in",
    ], { encoding: "utf8" });
    assert.equal(hideStaleBytes.status, 0, hideStaleBytes.stderr);

    const status = spawnSync("git", ["-C", snapshotRoot, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, "", "Git normalisiert die falschen Arbeitsbaum-Bytes weiterhin als sauber.");

    const builder = path.join(snapshotRoot, "server-tools", "package", "New-GrabenplanerLinuxServerPackage.ps1");
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", builder,
      "-SourceDirectory", snapshotRoot,
      "-OutputDirectory", outputRoot,
    ], { encoding: "utf8", timeout: 120_000 });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /unzulaessige LF-Bytes/);
    assert.equal(fs.existsSync(path.join(outputRoot, "Grabenplaner-Server-v0.90.7-beta-linux-x64.zip")), false);
  });
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

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repository = path.resolve(__dirname, "..");
const verifier = path.join(repository, "server-tools/linux/lib/verify-package.js");
const verifierSource = fs.readFileSync(verifier, "utf8");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function packagePolicy() {
  const backup = verifierSource.match(/^const backupRuntimeScripts = new Set\([\s\S]*?^\]\);/m)?.[0];
  const functions = ["isAllowedRuntimePath", "isForbiddenRuntimePath"].map(name => {
    const definition = verifierSource.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"))?.[0];
    assert.ok(definition, name);
    return definition;
  });
  assert.ok(backup);
  // Only the pure path policy is read to assemble a source fixture. Every
  // verification below runs the actual complete CLI in a separate process.
  return vm.runInNewContext(`${backup}\n${functions.join("\n")}\n({
    accepts: value => isAllowedRuntimePath(value) && !isForbiddenRuntimePath(value),
    excludesDirectory: value => isForbiddenRuntimePath(value + "/"),
    backupEntries: [...backupRuntimeScripts]
  })`);
}

function command(root, runtimeOnly = false) {
  const result = spawnSync(process.execPath, ["--no-global-search-paths", verifier,
    ...(runtimeOnly ? ["--runtime-contract"] : []), root], {
    encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR, TEMP: os.tmpdir(), TMP: os.tmpdir() },
  });
  assert.ifError(result.error);
  return result;
}

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gp-package-dependencies-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(parent)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const root = path.join(parent, "package");
  fs.mkdirSync(root);
  const policy = packagePolicy(), files = [];
  function collect(relative) {
    const absolute = path.join(repository, relative);
    const info = fs.lstatSync(absolute);
    assert.equal(info.isSymbolicLink(), false, relative);
    if (info.isDirectory()) {
      if (policy.excludesDirectory(relative)) return;
      for (const name of fs.readdirSync(absolute).sort()) collect(path.posix.join(relative, name));
    } else if (info.isFile() && policy.accepts(relative)) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(absolute, target, fs.constants.COPYFILE_EXCL);
      const bytes = fs.readFileSync(target);
      files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  for (const name of ["lib", "public", "server-tools", "services", ...policy.backupEntries]
    .concat(fs.readdirSync(repository).filter(name => fs.lstatSync(path.join(repository, name)).isFile()))) {
    collect(name);
  }
  assert.ok(files.length > 700, "the fixture must retain the actual admitted source tree");
  const contract = command(root, true);
  assert.equal(contract.status, 0, contract.stderr);
  const runtime = JSON.parse(contract.stdout);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const manifest = {
    format: "grabenplaner-server-package", schemaVersion: 1,
    platform: "linux", architecture: "x64", dependenciesMode: "source-install",
    appVersion: metadata.version, minimumNode: ">=22.13.0", packageManager: "pnpm@11.7.0",
    sourceCommit: "a".repeat(40), createdAt: "2026-10-24T00:00:00.000Z",
    nodeRuntimeIncluded: false, nodeRuntimeSha256: null,
    hardeningModule: runtime.hardeningModule,
    files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  };
  fs.writeFileSync(path.join(root, "grabenplaner-server-manifest.json"), JSON.stringify(manifest));
  const clean = command(root);
  assert.equal(clean.status, 0, "invalid source fixture: " + clean.stderr);
  return { parent, root, files, runtime };
}

test("the real package CLI separates only a real top-level installed dependency directory", async t => {
  const f = fixture(t);
  const modules = path.join(f.root, "node_modules");
  function accepted() {
    const result = command(f.root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.fileCount, f.files.length);
    assert.deepEqual(output.runtimeContract, Object.fromEntries(Object.entries(f.runtime)
      .filter(([key]) => !["offsiteModule", "hardeningModule"].includes(key))));
  }
  function rejected(pattern, root = f.root) {
    const result = command(root);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, pattern);
    assert.equal(result.stdout, "");
  }
  await t.test("source package before dependency installation is accepted", accepted);
  await t.test("source package with installed dependency files retains the same manifest file count", () => {
    fs.mkdirSync(path.join(modules, "pg/lib"), { recursive: true });
    fs.writeFileSync(path.join(modules, "pg/lib/index.js"), "throw Error('dependency code must not execute during package verification');\n");
    fs.mkdirSync(path.join(modules, ".bin"));
    fs.writeFileSync(path.join(modules, ".bin/tool"), "#!/bin/sh\nexit 99\n");
    accepted();
  });
  await t.test("a foreign package file remains rejected alongside installed dependencies", () => {
    const file = path.join(f.root, "lib/not-in-manifest.txt");
    fs.writeFileSync(file, "foreign");
    try { rejected(/nicht im Manifest erfasste oder fehlende Dateien/); }
    finally { fs.unlinkSync(file); }
  });
  await t.test("a nested node_modules directory is not excluded from the source manifest", () => {
    const directory = path.join(f.root, "lib/node_modules");
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "foreign.txt"), "foreign");
    try { rejected(/nicht im Manifest erfasste oder fehlende Dateien/); }
    finally { fs.rmSync(directory, { recursive: true }); }
  });
  await t.test("a similarly prefixed dependency directory is not excluded", () => {
    const directory = path.join(f.root, "node_modules-extra");
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "foreign.txt"), "foreign");
    try { rejected(/nicht im Manifest erfasste oder fehlende Dateien/); }
    finally { fs.rmSync(directory, { recursive: true }); }
  });
  const sourceFile = path.join(f.root, "lib/retired-database-operation.js");
  await t.test("a missing manifested source file remains rejected", () => {
    const bytes = fs.readFileSync(sourceFile); fs.unlinkSync(sourceFile);
    try { rejected(/ENOENT|Manifestdatei fehlt/); }
    finally { fs.writeFileSync(sourceFile, bytes); }
  });
  await t.test("a same-length changed manifested source file remains rejected", () => {
    const bytes = fs.readFileSync(sourceFile), altered = Buffer.from(bytes);
    altered[0] ^= 1; fs.writeFileSync(sourceFile, altered);
    try { rejected(/Manifestpruefung fehlgeschlagen/); }
    finally { fs.writeFileSync(sourceFile, bytes); }
  });
  await t.test("a node_modules regular file is not a valid excluded directory", () => {
    const saved = path.join(f.parent, "saved-dependencies"); fs.renameSync(modules, saved);
    fs.writeFileSync(modules, "not a directory");
    try { rejected(/Abhaengigkeitsbaum ist kein Verzeichnis/); }
    finally { fs.unlinkSync(modules); fs.renameSync(saved, modules); }
  });
  await t.test("a linked dependency root is rejected before the exclusion", () => {
    const saved = path.join(f.parent, "saved-dependencies"); fs.renameSync(modules, saved);
    fs.symlinkSync(saved, modules, process.platform === "win32" ? "junction" : "dir");
    try { rejected(/Symbolische Links sind im Serverpaket nicht erlaubt: node_modules/); }
    finally { fs.rmSync(modules); fs.renameSync(saved, modules); }
  });
  await t.test("a linked package root remains rejected", () => {
    const link = path.join(f.parent, "linked-package");
    fs.symlinkSync(f.root, link, process.platform === "win32" ? "junction" : "dir");
    try { rejected(/Paket-Stagingordner ist ungueltig/, link); }
    finally { fs.rmSync(link); }
  });
  await t.test("all restored source bytes and the original manifest still verify", accepted);
});

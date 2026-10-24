"use strict";

// Test-only historical dependency supply. Never packaged with the live server.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const BASELINE = "b2ba03cdc0b738d44766857de052e090db557807";
const INPUTS = Object.freeze(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "lib/vendor-patches/brace-expansion@5.0.12.patch"]);
const repository = path.resolve(__dirname, "..");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function baselineInputs() {
  const result = {};
  for (const relative of INPUTS) {
    const command = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "show", BASELINE + ":" + relative],
      { cwd: repository, maxBuffer: 4 * 1024 * 1024, timeout: 30000, windowsHide: true });
    assert.equal(command.status, 0, "Historical dependency source is unavailable: " + relative);
    result[relative] = command.stdout;
  }
  assert.equal(JSON.parse(result["package.json"]).packageManager, "pnpm@11.7.0");
  return result;
}

function regular(file) {
  const info = fs.lstatSync(file);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, "Historical dependency file must be regular: " + file);
  assert.equal(fs.realpathSync(file), path.resolve(file), "Historical dependency path must be canonical");
  return info;
}

function dependencyInventory(root) {
  const result = {};
  let count = 0;
  const walk = (directory, prefix = "") => {
    const info = fs.lstatSync(directory);
    assert(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(fs.realpathSync(directory), path.resolve(directory));
    for (const name of fs.readdirSync(directory).sort()) {
      assert(name && name !== "." && name !== ".." && !name.includes("\\") && !/[\x00-\x1f\x7f]/.test(name));
      const file = path.join(directory, name), relative = prefix + name;
      if (fs.lstatSync(file).isDirectory()) walk(file, relative + "/");
      else {
        const item = regular(file);
        assert(item.size <= 128 * 1024 * 1024);
        result[relative] = { sha256: sha(fs.readFileSync(file)), bytes: item.size, mode: item.mode & 0o777 };
        assert(++count <= 100000);
      }
    }
  };
  walk(root);
  assert(Object.keys(result).length > 0, "Historical dependency tree is empty");
  return result;
}

function createManifest(source, inputs, installation) {
  const sourceFiles = {};
  for (const relative of INPUTS) {
    regular(path.join(source, relative));
    const bytes = fs.readFileSync(path.join(source, relative));
    assert(bytes.equals(inputs[relative]), "Historical source changed during installation");
    sourceFiles[relative] = { sha256: sha(bytes), bytes: bytes.length };
  }
  return { format: "gp-historical-frozen-dependencies/v1", baseline: BASELINE, packageManager: "pnpm@11.7.0",
    nodeVersion: process.version, platform: process.platform, architecture: process.arch, inputs: sourceFiles,
    installation, files: dependencyInventory(path.join(source, "node_modules")) };
}

function validateLegacyDependencies({ root, manifestSha256 }) {
  assert(typeof root === "string" && path.isAbsolute(root));
  assert.match(manifestSha256, /^[a-f0-9]{64}$/, "External historical manifest SHA256 is required");
  const directory = path.resolve(root), manifestFile = path.join(directory, "legacy-dependencies-manifest.json");
  regular(manifestFile);
  const bytes = fs.readFileSync(manifestFile);
  assert(bytes.length <= 32 * 1024 * 1024);
  assert.equal(sha(bytes), manifestSha256, "Historical dependency manifest digest mismatch");
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.format, "gp-historical-frozen-dependencies/v1");
  assert.equal(manifest.baseline, BASELINE);
  assert.equal(manifest.packageManager, "pnpm@11.7.0");
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.architecture, process.arch);
  assert.deepEqual(manifest.installation?.policy, { frozenLockfile: true, ignoreScripts: true, ignorePnpmfile: true,
    verifyStoreIntegrity: true, sideEffectsCache: false, privateStore: true, privateHome: true, nodeLinker: "hoisted", packageImportMethod: "copy" });
  assert.equal(manifest.installation.exitCode, 0);
  assert.equal(manifest.installation.pnpmVersion, "11.7.0");
  const source = path.join(directory, "source"), inputs = baselineInputs();
  for (const relative of INPUTS) {
    regular(path.join(source, relative));
    const actual = fs.readFileSync(path.join(source, relative));
    assert(actual.equals(inputs[relative]), "Historical metadata is not the immutable baseline: " + relative);
    assert.deepEqual(manifest.inputs[relative], { sha256: sha(actual), bytes: actual.length });
  }
  assert.deepEqual(Object.keys(manifest.inputs).sort(), [...INPUTS].sort());
  const dependencies = path.join(source, "node_modules");
  assert.deepEqual(dependencyInventory(dependencies), manifest.files, "Historical installed dependency inventory mismatch");
  return dependencies;
}

function prepareLegacyDependencies({ target, pnpmExecutable, pnpmEntry }) {
  assert(typeof target === "string" && path.isAbsolute(target));
  assert(Boolean(pnpmExecutable) !== Boolean(pnpmEntry), "Specify exactly one package-manager entrypoint");
  const manager = fs.realpathSync(pnpmEntry || pnpmExecutable);
  regular(manager);
  const directory = path.resolve(target);
  fs.mkdirSync(directory, { mode: 0o700 }); // Never replace an existing tree.
  const source = path.join(directory, "source"), inputs = baselineInputs();
  fs.mkdirSync(source, { mode: 0o700 });
  for (const [relative, bytes] of Object.entries(inputs)) {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  }
  const directories = {};
  for (const name of ["home", "config", "cache", "data", "tmp", "store"]) {
    directories[name] = path.join(directory, name); fs.mkdirSync(directories[name], { mode: 0o700 });
  }
  const npmrc = path.join(directories.home, "empty.npmrc");
  fs.writeFileSync(npmrc, "", { flag: "wx", mode: 0o600 });
  const environment = {
    PATH: path.dirname(process.execPath) + path.delimiter + (process.platform === "win32" ? path.join(process.env.SystemRoot, "System32") : "/usr/bin:/bin"),
    HOME: directories.home, USERPROFILE: directories.home, APPDATA: directories.config, LOCALAPPDATA: directories.data,
    XDG_CONFIG_HOME: directories.config, XDG_CACHE_HOME: directories.cache, XDG_DATA_HOME: directories.data,
    PNPM_HOME: path.join(directories.home, "pnpm"), COREPACK_HOME: path.join(directories.home, "corepack"),
    NPM_CONFIG_USERCONFIG: npmrc, NPM_CONFIG_GLOBALCONFIG: npmrc, TEMP: directories.tmp, TMP: directories.tmp, TMPDIR: directories.tmp,
    LANG: "C.UTF-8", NODE_ENV: "production", CI: "true", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC || path.join(process.env.SystemRoot, "System32/cmd.exe") } : {}),
  };
  const command = pnpmEntry ? [process.execPath, "--no-global-search-paths", manager] : [manager];
  const run = (args, name, timeout) => {
    const result = spawnSync(command[0], [...command.slice(1), ...args], { cwd: source, env: environment, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    fs.writeFileSync(path.join(directory, name + ".stdout.log"), result.stdout || "", { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(directory, name + ".stderr.log"), result.stderr || "", { flag: "wx", mode: 0o600 });
    assert.equal(result.status, 0, "Historical dependency preparation failed; inspect private " + name + " logs");
    return result;
  };
  const version = run(["--version"], "pnpm-version", 30000).stdout.trim();
  assert.equal(version, "11.7.0", "Historical installation requires the exact package-manager version");
  const flags = ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--verify-store-integrity=true",
    "--side-effects-cache=false", "--config.node-linker=hoisted", "--package-import-method=copy", "--store-dir", directories.store,
    "--registry=https://registry.npmjs.org", "--reporter=append-only"];
  run(flags, "frozen-install", 15 * 60 * 1000);
  const installation = { pnpmVersion: version, entrySha256: sha(fs.readFileSync(manager)), exitCode: 0,
    policy: { frozenLockfile: true, ignoreScripts: true, ignorePnpmfile: true, verifyStoreIntegrity: true,
      sideEffectsCache: false, privateStore: true, privateHome: true, nodeLinker: "hoisted", packageImportMethod: "copy" } };
  const manifest = createManifest(source, inputs, installation), bytes = Buffer.from(JSON.stringify(manifest) + "\n");
  const file = path.join(directory, "legacy-dependencies-manifest.json");
  fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  const digest = sha(bytes);
  assert.equal(validateLegacyDependencies({ root: directory, manifestSha256: digest }), path.join(source, "node_modules"));
  return { format: manifest.format, baseline: BASELINE, root: directory, manifestSha256: digest, manifestBytes: bytes.length,
    dependencyFiles: Object.keys(manifest.files).length, nodeVersion: process.version, historicalCompatibilityOnly: true };
}

module.exports = { BASELINE, INPUTS, baselineInputs, dependencyInventory, createManifest, validateLegacyDependencies, prepareLegacyDependencies };

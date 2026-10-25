"use strict";
// Separate disposable test toolchain. Never installs into the GP runtime graph.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs");
const path = require("node:path"), { spawnSync } = require("node:child_process");
const SOURCE = __dirname, INPUTS = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "browser-lock.json"];
const sha = data => crypto.createHash("sha256").update(data).digest("hex");
function exactFile(file, expected) {
  const info = fs.lstatSync(file);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && fs.realpathSync(file) === file, "Browser artifact must be a regular file");
  assert.equal(info.size, expected.bytes, "Browser artifact size differs");
  assert.equal(sha(fs.readFileSync(file)), expected.sha256, "Browser artifact digest differs");
  return file;
}
function targetPath(value, temporaryRoot) {
  assert(typeof value === "string" && path.isAbsolute(value) && typeof temporaryRoot === "string" && path.isAbsolute(temporaryRoot));
  const target = path.resolve(value), parent = path.dirname(target), anchor = fs.realpathSync(temporaryRoot);
  assert.equal(fs.realpathSync(parent), parent, "Browser target parent must be canonical");
  assert(parent === anchor || parent.startsWith(anchor + path.sep), "Browser toolchain must remain inside RUNNER_TEMP");
  assert(!fs.existsSync(target), "Browser target must be new");
  return target;
}
function prepare({ target, pnpmEntry, pnpmExecutable, temporaryRoot = process.env.RUNNER_TEMP }) {
  assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64");
  target = targetPath(target, temporaryRoot);
  assert(Boolean(pnpmEntry) !== Boolean(pnpmExecutable), "Specify exactly one package-manager entrypoint");
  const manager = fs.realpathSync(pnpmEntry || pnpmExecutable), inputs = Object.fromEntries(INPUTS.map(name => [name, fs.readFileSync(path.join(SOURCE, name))]));
  const pin = JSON.parse(inputs["browser-lock.json"]), metadata = JSON.parse(inputs["package.json"]);
  assert.equal(metadata.packageManager, "pnpm@11.7.0"); assert.deepEqual(metadata.dependencies, { playwright: pin.playwright });
  fs.mkdirSync(target, { mode: 0o700 });
  for (const [name, content] of Object.entries(inputs)) fs.writeFileSync(path.join(target, name), content, { flag: "wx", mode: 0o600 });
  for (const name of ["home", "tmp", "store", "browsers"]) fs.mkdirSync(path.join(target, name), { mode: 0o700 });
  const npmrc = path.join(target, "home/empty.npmrc"); fs.writeFileSync(npmrc, "", { flag: "wx", mode: 0o600 });
  const environment = { PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", LANG: "C.UTF-8", HOME: path.join(target, "home"),
    TMPDIR: path.join(target, "tmp"), CI: "true", NPM_CONFIG_USERCONFIG: npmrc, NPM_CONFIG_GLOBALCONFIG: npmrc,
    PLAYWRIGHT_BROWSERS_PATH: path.join(target, "browsers"), PLAYWRIGHT_SKIP_BROWSER_GC: "1" };
  function command(executable, args, name, timeout = 300000) {
    const result = spawnSync(executable, args, { cwd: target, env: environment, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
    fs.writeFileSync(path.join(target, name + ".stdout.log"), result.stdout || "", { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(target, name + ".stderr.log"), result.stderr || "", { flag: "wx", mode: 0o600 });
    assert.equal(result.status, 0, "Browser preparation failed; inspect private " + name + " logs");
    return result.stdout;
  }
  const run = (args, name, timeout) => command(process.execPath, ["--no-global-search-paths", ...args], name, timeout);
  const pnpm = (args, name, timeout) => pnpmEntry ? run([manager, ...args], name, timeout) : command(manager, args, name, timeout);
  assert.equal(pnpm(["--version"], "pnpm-version", 30000).trim(), "11.7.0");
  pnpm(["install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--verify-store-integrity=true", "--side-effects-cache=false",
    "--config.node-linker=hoisted", "--package-import-method=copy", "--store-dir", path.join(target, "store"), "--registry=https://registry.npmjs.org", "--reporter=append-only"], "frozen-install");
  const modulePath = path.join(target, "node_modules/playwright");
  assert.equal(require(path.join(modulePath, "package.json")).version, pin.playwright);
  run([path.join(modulePath, "cli.js"), "install", "chromium", "--no-shell", "--no-remove"], "browser-install");
  const executable = exactFile(path.join(target, "browsers", pin.executable), pin);
  const sandboxSource = exactFile(path.join(path.dirname(executable), pin.sandbox.member), pin.sandbox);
  for (const [name, content] of Object.entries(inputs)) assert(fs.readFileSync(path.join(target, name)).equals(content), "Frozen browser input changed");
  const receipt = { format: pin.format, playwright: pin.playwright, chromium: pin.chromium, node: process.version,
    inputSha256: Object.fromEntries(Object.entries(inputs).map(([name, content]) => [name, sha(content)])),
    executable, executableSha256: pin.sha256, sandboxSource, sandboxSha256: pin.sandbox.sha256,
    environment: { GP_BROWSER_TEST_MODULE: modulePath, GP_BROWSER_EXECUTABLE: executable, PLAYWRIGHT_BROWSERS_PATH: environment.PLAYWRIGHT_BROWSERS_PATH } };
  fs.writeFileSync(path.join(target, "browser-receipt.json"), JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
  return receipt;
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), values = {};
    for (let index = 0; index < args.length; index += 2) {
      assert(["--target", "--pnpm-entry", "--pnpm"].includes(args[index]) && args[index + 1] && !Object.hasOwn(values, args[index]));
      values[args[index]] = args[index + 1];
    }
    console.log(JSON.stringify(prepare({ target: values["--target"], pnpmEntry: values["--pnpm-entry"], pnpmExecutable: values["--pnpm"] })));
  } catch (error) { console.error("Passkey browser preparation rejected: " + error.message); process.exitCode = 1; }
}
module.exports = { exactFile, targetPath, prepare };

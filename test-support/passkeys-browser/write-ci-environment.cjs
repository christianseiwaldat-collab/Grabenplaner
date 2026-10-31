"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { exactFile } = require("./prepare.cjs"), pin = require("./browser-lock.json");
const sandboxRoot = "/var/lib/gp-passkeys-ci-sandbox", sandboxDirectory = sandboxRoot + "/" + pin.sandbox.sha256;
const sandboxAncestors = ["/", "/var", "/var/lib", sandboxRoot, sandboxDirectory];
function assertSandboxLocation(sandbox) {
  assert.equal(sandbox.format, "gp-passkeys-ci-sandbox-v1");
  assert.equal(sandbox.path, sandboxDirectory + "/chrome_sandbox");
  assert.equal(sandbox.sha256, pin.sandbox.sha256); assert.equal(sandbox.sandboxDisabled, false);
  assert.deepEqual(sandbox.directoryProofs.map(proof => proof.path), sandboxAncestors);
  for (const proof of sandbox.directoryProofs) {
    assert.equal(proof.uid, 0); assert.equal(proof.isDirectory, true); assert.equal(proof.canonical, proof.path);
    assert(Number.isInteger(proof.mode) && proof.mode >= 0 && proof.mode <= 0o7777 && !(proof.mode & 0o022));
  }
}
function environment(receipt, sandbox) {
  assert.equal(receipt.format, pin.format); assert.equal(receipt.playwright, pin.playwright); assert.equal(receipt.chromium, pin.chromium);
  assert.equal(receipt.executableSha256, pin.sha256); assert.equal(sandbox.sha256, pin.sandbox.sha256); assert.equal(sandbox.sandboxDisabled, false);
  assertSandboxLocation(sandbox);
  for (const directory of sandboxAncestors) {
    const info = fs.lstatSync(directory);
    assert(info.isDirectory() && info.uid === 0 && !(info.mode & 0o022) && fs.realpathSync(directory) === directory,
      "Sandbox ancestor changed after installation: " + directory);
  }
  exactFile(receipt.executable, pin); exactFile(sandbox.path, pin.sandbox);
  const info = fs.statSync(sandbox.path);
  assert.equal(info.uid, 0); assert.equal(info.gid, 0); assert.equal(info.mode & 0o7777, 0o4755);
  const values = { ...receipt.environment, CHROME_DEVEL_SANDBOX: sandbox.path };
  assert.deepEqual(Object.keys(values).sort(), ["CHROME_DEVEL_SANDBOX", "GP_BROWSER_EXECUTABLE", "GP_BROWSER_TEST_MODULE", "PLAYWRIGHT_BROWSERS_PATH"]);
  assert.equal(values.GP_BROWSER_EXECUTABLE, receipt.executable);
  for (const value of Object.values(values)) assert(typeof value === "string" && path.isAbsolute(value) && !/[\r\n\0]/.test(value));
  return values;
}
if (require.main === module) {
  assert.equal(process.platform, "linux"); assert(process.env.GITHUB_ENV && path.isAbsolute(process.env.GITHUB_ENV));
  const [receipt, sandbox] = process.argv.slice(2).map(file => JSON.parse(fs.readFileSync(file, "utf8")));
  const values = environment(receipt, sandbox);
  console.log(JSON.stringify({ format: "gp-passkeys-ci-sandbox-path-proof-v1", path: sandbox.path,
    sandboxDisabled: false, directoryProofs: sandbox.directoryProofs }));
  fs.appendFileSync(process.env.GITHUB_ENV, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(""));
}
module.exports = { environment, assertSandboxLocation };

"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { exactFile } = require("./prepare.cjs"), pin = require("./browser-lock.json");
function environment(receipt, sandbox) {
  assert.equal(receipt.format, pin.format); assert.equal(receipt.playwright, pin.playwright); assert.equal(receipt.chromium, pin.chromium);
  assert.equal(receipt.executableSha256, pin.sha256); assert.equal(sandbox.sha256, pin.sandbox.sha256); assert.equal(sandbox.sandboxDisabled, false);
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
  const values = environment(...process.argv.slice(2).map(file => JSON.parse(fs.readFileSync(file, "utf8"))));
  fs.appendFileSync(process.env.GITHUB_ENV, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(""));
}
module.exports = { environment };

"use strict";
// Historical migration compatibility, never a current SQLite server provider.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { legacyPath, sourceRoot, BASELINE } = require("../test-support/legacy-baseline");
const root = path.resolve(__dirname, "..");
const dependencyLockSha = file => crypto.createHash("sha256").update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")).digest("hex");
test("immutable pre-PostgreSQL-only baseline preserves the original minimal portal-schema upgrade assertions", { timeout: 240000 }, () => {
  assert.equal(BASELINE, "b2ba03cdc0b738d44766857de052e090db557807");
  // The complete historical application is not part of the recovery capsule.
  // Only this CI regression uses the same frozen dependency set as the source.
  // Git text checkout policy may change CRLF/LF; dependency entries must match.
  assert.equal(dependencyLockSha(legacyPath("pnpm-lock.yaml")), dependencyLockSha(path.join(root, "pnpm-lock.yaml")));
  const dependencyRoot = fs.realpathSync(path.join(root, "node_modules"));
  const historicalDependencies = legacyPath("node_modules");
  // The original server resolves vendored OCR assets through its own physical
  // node_modules path. Link the checked CI dependency installation only inside
  // this disposable test checkout; the historical source bytes stay unchanged.
  if (!fs.existsSync(historicalDependencies)) fs.symlinkSync(dependencyRoot, historicalDependencies, process.platform === "win32" ? "junction" : "dir");
  assert.equal(fs.realpathSync(historicalDependencies), dependencyRoot);
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot,
    LANG: "C.UTF-8", NODE_ENV: "test", NODE_PATH: path.join(root, "node_modules") };
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^alte Datenbank wird", legacyPath("test/portal-foundation.test.js")], {
    cwd: sourceRoot(), env: environment, encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  // The child receives only synthetic test input and no product environment.
  assert.equal(result.status, 0, (result.stdout || "").slice(-18000) + "\n" + (result.stderr || "").slice(-4000));
  assert.match(result.stdout, /^# pass 1$/m);
});

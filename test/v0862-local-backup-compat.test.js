"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

// Execute only the explicitly selected immutable historical assertion. The
// current server and current PostgreSQL API fixtures are never redirected.
function runFrozenHistoricalBackupTest(t, relative, expectedSha256, pattern, expectedPass) {
  const historical = require("../test-support/legacy-baseline");
  assert.equal(historical.BASELINE, "b2ba03cdc0b738d44766857de052e090db557807");
  historical.linkFrozenDependencies();
  const original = execFileSync("git", ["--no-replace-objects", "-C", path.resolve(__dirname, ".."),
    "show", historical.BASELINE + ":" + relative], { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  assert.equal(crypto.createHash("sha256").update(original).digest("hex"), expectedSha256);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-immutable-backup-test-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const driver = path.join(directory, "immutable-backup.test.js"), filename = historical.legacyPath(relative);
  fs.writeFileSync(driver, `const Module=require('node:module'),path=require('node:path');
const filename=${JSON.stringify(filename)},subject=new Module(filename,module);
subject.filename=filename;subject.paths=Module._nodeModulePaths(path.dirname(filename));
subject._compile(${JSON.stringify(original.toString("utf8"))},filename);\n`);
  // execFileSync deliberately avoids the PostgreSQL fixture's spawn adapter.
  // The child receives no inherited NODE_OPTIONS, connection URLs or owner marker.
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot,
    LANG: "C.UTF-8", NODE_ENV: "test", GP_PG_API_FIXTURE_BRIDGE: "0" };
  let output;
  try {
    output = execFileSync(process.execPath, ["--no-global-search-paths", "--test", "--test-reporter=tap",
      ...(pattern ? ["--test-name-pattern=" + pattern] : []), driver], {
      cwd: historical.sourceRoot(), env: environment, encoding: "utf8", timeout: 180000,
      maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
  } catch (error) {
    assert.fail(String(error.stdout || "").slice(-18000) + "\n" + String(error.stderr || error.message).slice(-4000));
  }
  assert.match(output, new RegExp("^# pass " + expectedPass + "$", "m"));
  assert.match(output, /^# fail 0$/m);
  t.diagnostic(`Immutable ${historical.BASELINE} ${relative}: ${expectedPass} original assertions passed; SHA256 ${expectedSha256}`);
}

test('immutable historical local backup retains its original configuration and atomic interval rules', { timeout: 240000 }, t => {
  runFrozenHistoricalBackupTest(t, 'test/v0862-local-backup-compat.test.js', '0b853e87cb6b080494ecc8e60adde71cb4dafe4872053270f8493384d083a428', null, 2);
});

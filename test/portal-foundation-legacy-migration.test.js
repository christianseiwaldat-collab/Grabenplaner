"use strict";
// Historical migration compatibility, never a current SQLite server provider.
const test = require("node:test"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { legacyPath, sourceRoot, BASELINE, linkFrozenDependencies } = require("../test-support/legacy-baseline");
for (const [description, pattern] of [
  ["the original minimal portal-schema upgrade assertions", "^alte Datenbank wird"],
  ["the retired unauthenticated local topology assertions", "^lokaler Einzelplatzmodus kann Filialen und Abteilungen deaktivieren und reaktivieren$"],
]) test("immutable pre-PostgreSQL-only baseline preserves " + description, { timeout: 240000 }, () => {
  assert.equal(BASELINE, "b2ba03cdc0b738d44766857de052e090db557807");
  // Preserve the complete original graph even after current security updates.
  // A changed current lock cannot substitute its freshly patched dependencies.
  linkFrozenDependencies();
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot,
    LANG: "C.UTF-8", NODE_ENV: "test" };
  const result = spawnSync(process.execPath, ["--no-global-search-paths", "--test", "--test-reporter=tap", "--test-name-pattern=" + pattern, legacyPath("test/portal-foundation.test.js")], {
    cwd: sourceRoot(), env: environment, encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  // The child receives only synthetic test input and no product environment.
  assert.equal(result.status, 0, (result.stdout || "").slice(-18000) + "\n" + (result.stderr || "").slice(-4000));
  assert.match(result.stdout, /^# pass 1$/m);
});

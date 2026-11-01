"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("PostgreSQL application catalogs and schema plans load while SQLite modules are forbidden", () => {
  const result = spawnSync(process.execPath, ["-e", `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (request === 'node:sqlite' || /[/\\\\]persistence[/\\\\]sqlite[/\\\\]/.test(resolved)) {
        throw new Error('POSTGRESQL_RUNTIME_SQLITE_DEPENDENCY: ' + request);
      }
      return load.call(this, request, parent, isMain);
    };
    for (const target of [
      './lib/persistence/dialects/application-manifest',
      './lib/persistence/postgresql/core/catalog',
      './lib/persistence/postgresql/sales/catalog',
      './lib/persistence/postgresql/reporting/catalog',
      './lib/persistence/postgresql/boundary/catalog',
      './lib/persistence/postgresql/core/session-security',
      './lib/persistence/postgresql/core/personnel-learning-runs',
      './lib/persistence/postgresql/core/xoffi-snapshots',
    ]) require(target);
  `], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("legacy catalog paths re-export the canonical objects without duplicating SQL", () => {
  const directory = path.join(root, "lib/persistence/catalogs");
  for (const filename of fs.readdirSync(directory).filter(name => name.endsWith(".js"))) {
    const source = require(path.join(directory, filename));
    const legacyPath = path.join(root, "lib/persistence/sqlite", filename);
    assert.strictEqual(require(legacyPath), source, filename);
    const wrapper = fs.readFileSync(legacyPath, "utf8");
    assert.match(wrapper, /Legacy SQLite fixtures and historical migration readers only/);
    assert.doesNotMatch(wrapper, /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER)\b/);
  }
});

test("the runtime dependency guard rejects an injected SQLite import", () => {
  const result = spawnSync(process.execPath, ["-e", `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (request === 'node:sqlite' || /[/\\\\]persistence[/\\\\]sqlite[/\\\\]/.test(resolved)) {
        throw new Error('POSTGRESQL_RUNTIME_SQLITE_DEPENDENCY');
      }
      return load.call(this, request, parent, isMain);
    };
    require('./lib/persistence/sqlite/application-catalog');
  `], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /POSTGRESQL_RUNTIME_SQLITE_DEPENDENCY/);
});

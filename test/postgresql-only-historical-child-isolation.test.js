"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const childProcess = require("node:child_process");

test("historical F18 execution excludes current PostgreSQL ownership and hostile Node preload", { timeout: 240000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-historical-child-isolation-"));
  const marker = path.join(directory, "inherited-preload.marker");
  const poison = path.join(directory, "poison.cjs");
  fs.writeFileSync(poison, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'inherited');throw new Error('HISTORICAL_CHILD_INHERITED_NODE_OPTIONS');\n`);
  const hostile = {
    NODE_OPTIONS: "--require " + JSON.stringify(poison),
    DB_PROVIDER: "postgresql",
    GP_PG_API_FIXTURE_BRIDGE: "1",
    GP_PG_API_FIXTURE_CHILD_OWNER: "synthetic-parent-owner-must-not-propagate",
    GP_CORE_APP_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/unreachable",
    GP_SALES_APP_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/unreachable",
  };
  const saved = Object.fromEntries(Object.keys(hostile).map(name => [name, process.env[name]]));
  const originalSpawnSync = childProcess.spawnSync;
  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  Object.assign(process.env, hostile);
  // Model the current bridge boundary: Node spawnSync is not an isolated
  // historical launch. Non-Node git/tar extraction remains available.
  childProcess.spawnSync = function (binary, ...args) {
    assert.notEqual(binary, process.execPath, "Historical Node must bypass the PostgreSQL spawn adapter");
    return originalSpawnSync.call(this, binary, ...args);
  };
  delete require.cache[require.resolve("../test-support/historical-server-tests")];
  const result = require("../test-support/historical-server-tests").runHistoricalServerTest("test/v085-loan-foundation.test.js");
  assert.equal(result.pass, 1);
  assert.equal(result.historicalCompatibilityOnly, true);
  assert.equal(fs.existsSync(marker), false);
  for (const [name, value] of Object.entries(hostile)) assert.equal(process.env[name], value, "Parent fixture remains intact");
});

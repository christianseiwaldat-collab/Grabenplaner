"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");

test("offsite module 10 preserves predecessors and requires the complete paired recovery entrypoints", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-deploy-core-"));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const source = fs.readFileSync(path.join(__dirname, "../server-tools/linux/offsite/lib/offsite-common.sh"), "utf8");
  const selected = source.slice(source.indexOf("offsite_core_deploy_workflow() {"), source.indexOf("offsite_fixed_failure() {"));
  assert.ok(selected.includes("legacy-full"));
  const write = (name, content) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, { mode: 0o644 }); };
  const moduleName = "server-tools/linux/offsite/module-schema.json";
  const run = () => spawnSync("/bin/bash", ["-e", "-c", `${selected}\noffsite_core_deploy_workflow`], {
    env: { ...process.env, OFFSITE_NODE: process.execPath, OFFSITE_APP_ROOT: root }, encoding: "utf8", timeout: 10000,
  });
  write("server-tools/linux/runtime-schema.json", JSON.stringify({ deploymentSchemaVersion: 5 }));
  write(moduleName, JSON.stringify({ moduleVersion: 7 }));
  assert.equal(run().stdout, "legacy-full");
  write(moduleName, JSON.stringify({ moduleVersion: 8 }));
  assert.notEqual(run().status, 0);
  for (const name of ["lib/backup-maintenance.js", "server-tools/linux/lib/deploy-policy.js",
    "server-tools/linux/lib/deferred-backups.js", "server-tools/linux/lib/backup-metadata.js"]) write(name, "// synthetic");
  assert.equal(run().stdout, "current");
  write(moduleName, JSON.stringify({ moduleVersion: 9 }));
  assert.notEqual(run().status, 0);
  for (const name of ['server-tools/linux/lib/postgresql-operations.js',
    'server-tools/linux/recovery/lib/postgresql-recovery.js',
    'server-tools/linux/recovery/lib/postgresql-recovery-worker.js']) write(name, '// synthetic');
  assert.equal(run().stdout, 'current');
  write(moduleName, JSON.stringify({ moduleVersion: 10 }));
  assert.equal(run().stdout, 'current');
  fs.chmodSync(path.join(root, "server-tools/linux/lib/deploy-policy.js"), 0o666);
  assert.notEqual(run().status, 0);
  write(moduleName, JSON.stringify({ moduleVersion: 6 }));
  assert.notEqual(run().status, 0);
});

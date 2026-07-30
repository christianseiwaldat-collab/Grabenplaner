"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("v0.88.4: the post-commit finalizer is package-bound and evidence-only", () => {
  const finalizer = read("server-tools", "linux", "finalize-grabenplaner-runtime-v3.sh");
  const builder = read("server-tools", "package", "New-GrabenplanerLinuxServerPackage.ps1");
  const verifier = read("server-tools", "linux", "lib", "verify-package.js");
  const installer = read("server-tools", "linux", "install-grabenplaner-server.sh");

  for (const contract of [
    /FINALIZER_VERSION="0\.88\.4-beta"/,
    /cmp --silent -- "\$SCRIPT_PATH" "\$candidate_finalizer"/,
    /"\$node" "\$candidate_verifier" "\$candidate_root"/,
    /clamscan --recursive --infected --no-summary/,
    /gp_acquire_maintenance_lock/,
    /\.runtime-v3-migration\\\.\[A-Za-z0-9\]\{8\}/,
    /updater-committed/,
    /POST-UPDATE-ACTION-REQUIRED/,
    /"\$node" "\$candidate_contract_helper"/,
    /"\$node" "\$candidate_backup_verifier"/,
    /--runtime-contract "\$app_dir"/,
    /env_mtime <= checkpoint_mtime && env_ctime <= checkpoint_mtime/,
    /verify-installed-bound/,
    /grabenplaner-offsite-assurance@app-updated\.service/,
    /rebootTriggered:false/,
    /grabenplaner-runtime-v3-postcommit-recovery/,
    /FINALIZED\.json/,
    /diagnosticRetained\\":true/,
  ]) {
    assert.match(finalizer, contract);
  }

  for (const packagingContract of [builder, verifier, installer]) {
    assert.match(packagingContract, /finalize-grabenplaner-runtime-v3\.sh/);
    assert.match(packagingContract, /extract-updater-contract\.js/);
  }

  assert.doesNotMatch(finalizer, /systemctl\s+(?:start|restart|stop|enable|disable)\b/);
  assert.doesNotMatch(finalizer, /\b(?:reboot|shutdown)\s+(?:--|-r)\b/);
  assert.doesNotMatch(finalizer, /grabenplaner-offsite-(?:rebind|switch-target)/);
  assert.doesNotMatch(finalizer, /initialize-repository/);
  assert.doesNotMatch(finalizer, /update-grabenplaner-server\.sh/);
  assert.doesNotMatch(finalizer, /migrate-grabenplaner-runtime-v3\.sh/);
  assert.doesNotMatch(finalizer, /rm -rf[^\\n]*\/opt\/grabenplaner\/app/);
});

test("v0.88.4: the post-commit finalizer shell parses on POSIX hosts", {
  skip: process.platform === "win32",
}, () => {
  const result = spawnSync("bash", [
    "-n",
    path.join(root, "server-tools/linux/finalize-grabenplaner-runtime-v3.sh"),
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

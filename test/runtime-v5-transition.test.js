"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { validateTransition, validateInvocation, boundOffsiteReceipt } = require("../server-tools/linux/lib/runtime-v5-transition");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-runtime-v5-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const old = path.join(temporary, "old"), candidate = path.join(temporary, "new");
  const runtime = JSON.parse(read("server-tools/linux/runtime-schema.json"));
  const offsite = JSON.parse(read("server-tools/linux/offsite/module-schema.json"));
  const hardening = JSON.parse(read("server-tools/linux/hardening/module-schema.json"));
  for (const relative of ["server-tools/linux/runtime-schema.json", "server-tools/linux/offsite/module-schema.json", "server-tools/linux/hardening/module-schema.json", ...runtime.managedArtifacts, ...offsite.managedArtifacts, ...hardening.managedArtifacts]) {
    const value = read(relative);
    for (const target of [old, candidate]) {
      fs.mkdirSync(path.dirname(path.join(target, relative)), { recursive: true });
      fs.writeFileSync(path.join(target, relative), value);
    }
  }
  fs.writeFileSync(path.join(old, "server-tools/linux/runtime-schema.json"), JSON.stringify({ ...runtime, deploymentSchemaVersion: 4 }));
  fs.writeFileSync(path.join(old, "server-tools/linux/offsite/module-schema.json"), JSON.stringify({ ...offsite, moduleVersion: 6 }));
  for (const name of ["grabenplaner", "grabenplaner-bootstrap"]) {
    const file = path.join(old, "server-tools/linux", name + ".service.in");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("TimeoutStartSec=1500s\n", "TimeoutStartSec=120s\n").replace("TimeoutStopSec=1500s\n", "TimeoutStopSec=120s\n"));
  }
  return { old, candidate };
}
test("runtime-v5 accepts only the timeout delta and preserves every other managed runtime artifact", t => {
  const { old, candidate } = fixture(t);
  assert.equal(validateTransition(old, candidate).toSchema, 5);
  const file = path.join(candidate, "server-tools/linux/grabenplaner.service.in");
  fs.appendFileSync(file, "ReadWritePaths=/etc\n");
  assert.throws(() => validateTransition(old, candidate));
});
test("runtime-v5 rejects provider/control-unit changes and unsupported predecessors", t => {
  const { old, candidate } = fixture(t);
  const file = path.join(candidate, "server-tools/linux/offsite/lib/offsite-rclone-policy.js");
  fs.appendFileSync(file, "\n// changed\n");
  assert.throws(() => validateTransition(old, candidate));
  fs.copyFileSync(path.join(old, "server-tools/linux/offsite/lib/offsite-rclone-policy.js"), file);
  const schemaFile = path.join(old, "server-tools/linux/runtime-schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
  fs.writeFileSync(schemaFile, JSON.stringify({ ...schema, deploymentSchemaVersion: 3 }));
  assert.throws(() => validateTransition(old, candidate));
});
test("runtime-v5 preserves the exact provider binding without accepting an alternative binding", () => {
  const previous = { format: "grabenplaner-linux-offsite-installed-contract", moduleVersion: 6, providerBinding: { providerId: "google_drive", policySha256: "a".repeat(64) } };
  const candidate = { format: previous.format, moduleVersion: 7, fingerprint: "b".repeat(64) };
  assert.deepEqual(boundOffsiteReceipt(previous, candidate), { ...candidate, providerBinding: previous.providerBinding });
  assert.throws(() => boundOffsiteReceipt(previous, { ...candidate, providerBinding: { providerId: "other" } }));
  assert.throws(() => boundOffsiteReceipt({ ...previous, moduleVersion: 5 }, candidate));
});
test("runtime-v5 updater trust transition rejects ordinary, unbound and non-root invocation", () => {
  assert.throws(() => validateInvocation({ uid: 1000 }));
  assert.throws(() => validateInvocation({ uid: 0, marker: "/tmp/commit.json", transitionFile: "/tmp/transition.json", script: "/tmp/update.sh" }));
});
test("runtime-v5 keeps the installed backup path until commit and binds offsite afterwards", () => {
  const migration = read("server-tools/linux/migrate-grabenplaner-runtime-v5.sh");
  const updater = read("server-tools/linux/update-grabenplaner-server.sh");
  assert.match(migration, /runtime-v5-transition\.js" verify/);
  assert.match(migration, /systemd-analyze verify/);
  assert.match(migration, /rollback_root\/runtime\/\$name/);
  assert.doesNotMatch(migration, /mv -T -- "\$app_dir\/server-tools\/linux"/);
  assert(migration.indexOf("if updater_commit_is_valid") < migration.indexOf('mv -T -- "$OFFSITE_MODULE"'));
  assert.match(updater, /local backup_script="\$app_dir\/server-tools\/linux\/backup-grabenplaner\.sh"/);
  assert.match(updater, /installedOffsiteReceiptSha256/);
  assert.match(updater, /-z "\$runtime_v5_transition"/);
  assert.match(migration, /--backup-keep 1000/);
  assert.match(migration, /POST-UPDATE-ACTION-REQUIRED/);
  assert.doesNotMatch(migration, /\bsystemctl\s+(reboot|poweroff)|\bshutdown\s+-r/);
});
test("runtime-v5 and offsite-v7 are the current package contracts", () => {
  const result = spawnSync(process.execPath, [path.join(root, "server-tools/linux/lib/verify-package.js"), "--runtime-contract", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).deploymentSchemaVersion, 5);
  assert.equal(JSON.parse(read("server-tools/linux/offsite/module-schema.json")).moduleVersion, 7);
});
test("runtime-v5 verifier reads the installed runtime-v4/offsite-v6 predecessor without accepting it as a new package", t => {
  const { old } = fixture(t);
  const verifier = path.join(root, "server-tools/linux/lib/verify-package.js");
  const result = spawnSync(process.execPath, [verifier, "--runtime-contract", old], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const contract = JSON.parse(result.stdout);
  assert.equal(contract.deploymentSchemaVersion, 4);
  assert.equal(contract.offsiteModule.moduleVersion, 6);
  assert.notEqual(spawnSync(process.execPath, [verifier, old], { encoding: "utf8" }).status, 0);
});

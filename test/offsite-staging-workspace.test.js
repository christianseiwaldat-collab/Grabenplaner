"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const helper = path.resolve(__dirname, "../server-tools/linux/offsite/lib/offsite-stage.js");

test("offsite preparation refuses existing work, files and links without removing them", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-offsite-workspace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, "staging");
  fs.mkdirSync(stage);
  const run = target => spawnSync(process.execPath, [helper, "assert-empty-root", target], { encoding: "utf8" });
  assert.equal(run(stage).status, 0);
  const stale = path.join(stage, ".prepare-interrupted");
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, "synthetic.txt"), "retain");
  assert.notEqual(run(stage).status, 0);
  assert.equal(fs.readFileSync(path.join(stale, "synthetic.txt"), "utf8"), "retain");
  const link = path.join(root, "linked-stage");
  fs.symlinkSync(stage, link, process.platform === "win32" ? "junction" : "dir");
  assert.notEqual(run(link).status, 0);
  assert.notEqual(run(path.join(stale, "synthetic.txt")).status, 0);
});

test("offsite staging inspection and allocation share the maintenance and repository locks", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../server-tools/linux/offsite/grabenplaner-offsite-prepare.sh"), "utf8");
  const maintenance = script.indexOf('offsite_acquire_maintenance_lock_with_wait "$OFFSITE_MAINTENANCE_LOCK_WAIT_SECONDS"');
  const repository = script.indexOf("offsite_acquire_repository_lock");
  const existing = script.indexOf('if [[ -d "$OFFSITE_STAGE_CURRENT"');
  const empty = script.indexOf('assert-empty-root "$OFFSITE_STAGE_ROOT"');
  const allocate = script.indexOf('temporary_stage="$(mktemp');
  assert.ok(maintenance >= 0 && repository > maintenance && existing > repository && empty > existing && allocate > empty);
  assert.match(script, /offsite_assert_inherited_repository_lock/);
  const updater = fs.readFileSync(path.resolve(__dirname, "../server-tools/linux/offsite/grabenplaner-offsite-pre-update.sh"), "utf8");
  assert.match(updater, /--backup-result "\$backup_result" --lock-already-held --repository-lock-already-held/);
});

"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const helper = path.join(root, "server-tools/linux/recovery/lib/recovery-metadata.js");
const snapshotA = "a".repeat(64);
const snapshotB = "b".repeat(64);
const recoveryId = "c".repeat(64);
const installationId = "d".repeat(32);
const host = `grabenplaner-${installationId}`;
const sourcePath = "/var/lib/grabenplaner-offsite/staging/current";

function run(args) {
  return childProcess.spawnSync(process.execPath, [helper, ...args], { encoding: "utf8" });
}

test("v0.74 snapshot selection rejects prefixes and snapshots outside the installation binding", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-recovery-meta-"));
  const list = path.join(temporary, "snapshots.json");
  try {
    fs.writeFileSync(list, JSON.stringify([
      { id: snapshotA, time: "2026-07-18T10:00:00Z", hostname: host, paths: [sourcePath], tags: ["grabenplaner-offsite"] },
      { id: snapshotB, time: "2026-07-19T10:00:00Z", hostname: host, paths: [sourcePath], tags: ["grabenplaner-offsite"] },
      { id: "e".repeat(64), time: "2026-07-20T10:00:00Z", hostname: "foreign", paths: [sourcePath], tags: ["grabenplaner-offsite"] },
      { id: "f".repeat(64), time: "2026-07-21T10:00:00Z", hostname: host, paths: ["/wrong"], tags: ["grabenplaner-offsite"] },
    ]));
    const listed = run(["list", list, host, sourcePath]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).map((item) => item.id), [snapshotB, snapshotA]);
    const exact = run(["select-exact", list, snapshotA, host, sourcePath]);
    assert.equal(exact.status, 0, exact.stderr);
    assert.equal(JSON.parse(exact.stdout).id, snapshotA);
    assert.notEqual(run(["select-exact", list, snapshotA.slice(0, 12), host, sourcePath]).status, 0);
    assert.notEqual(run(["select-exact", list, "e".repeat(64), host, sourcePath]).status, 0);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("v0.74 prepared and verified receipts remain bound to exact ids and current repository installation", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-recovery-receipt-"));
  const files = Object.fromEntries(["snapshot", "stats", "verification", "repository", "installation", "prepared", "verified", "restoreTest"]
    .map((name) => [name, path.join(temporary, `${name}.json`)]));
  files.repository = path.join(temporary, "repository-id");
  files.installation = path.join(temporary, "installation-id");
  try {
    fs.writeFileSync(files.snapshot, JSON.stringify({ id: snapshotA, time: "2026-07-19T10:00:00.000Z", hostname: host, path: sourcePath, tags: ["grabenplaner-offsite"] }));
    fs.writeFileSync(files.stats, JSON.stringify({ total_size: 2048, total_file_count: 8 }));
    fs.writeFileSync(files.verification, JSON.stringify({
      ok: true, databaseSha256: "1".repeat(64), stageManifestSha256: "2".repeat(64),
      sourceAppVersion: "0.73.0-beta", targetAppVersion: "0.74.0-beta", deploymentSchemaVersion: 1,
      frozenFiles: 8, protectedDocuments: 0, protectedRecords: 0, integrationCredentials: 0,
    }));
    fs.writeFileSync(files.repository, `${"3".repeat(32)}\n`);
    fs.writeFileSync(files.installation, `${installationId}\n`);
    let result = run(["prepared", files.prepared, recoveryId, files.snapshot, files.stats, files.verification, files.repository, files.installation]);
    assert.equal(result.status, 0, result.stderr);
    result = run(["verified", files.verified, files.prepared, files.verification, recoveryId, snapshotA]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(files.verified, "utf8")).state, "verified");
    assert.equal(run(["check-binding", files.verified, files.repository, files.installation, sourcePath]).status, 0);
    result = run(["restore-test-receipt", files.restoreTest, files.snapshot, files.stats, files.verification,
      "2026-07-19T10:00:00Z", files.repository, files.installation, sourcePath]);
    assert.equal(result.status, 0, result.stderr);
    const restoreTest = JSON.parse(fs.readFileSync(files.restoreTest, "utf8"));
    assert.equal(restoreTest.snapshotId, snapshotA);
    assert.equal(restoreTest.applicationSmoke.reasonCode, "RECOVERY_TEST_MODE_UNAVAILABLE");
    assert.match(restoreTest.repositoryBindingSha256, /^[a-f0-9]{64}$/);
    fs.writeFileSync(files.repository, `${"4".repeat(32)}\n`);
    assert.notEqual(run(["check-binding", files.verified, files.repository, files.installation, sourcePath]).status, 0);
    assert.notEqual(run(["check-receipt", files.verified, "verified", recoveryId, snapshotB]).status, 0);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("v0.74 frozen-tree validation rejects writable files, symlinks and hardlinks", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-recovery-tree-"));
  const tree = path.join(temporary, "tree");
  try {
    fs.mkdirSync(tree);
    const file = path.join(tree, "payload.db");
    fs.writeFileSync(file, "payload");
    fs.chmodSync(file, 0o400);
    fs.chmodSync(tree, 0o500);
    assert.equal(run(["frozen-tree", tree]).status, 0);
    fs.chmodSync(file, 0o600);
    assert.notEqual(run(["frozen-tree", tree]).status, 0);
    fs.chmodSync(file, 0o400);
    const link = path.join(tree, "linked.db");
    try {
      fs.symlinkSync(file, link, "file");
      assert.notEqual(run(["frozen-tree", tree]).status, 0);
      fs.unlinkSync(link);
    } catch (error) {
      if (error.code === "EPERM") context.diagnostic("Symlink-Erzeugung ist auf diesem Windows-Host nicht freigegeben.");
      else throw error;
    }
    const hardlink = path.join(tree, "hard.db");
    try {
      fs.linkSync(file, hardlink);
      assert.notEqual(run(["frozen-tree", tree]).status, 0);
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error.code)) throw error;
    }
  } finally {
    try { fs.chmodSync(tree, 0o700); } catch {}
    try { fs.chmodSync(path.join(tree, "payload.db"), 0o600); } catch {}
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

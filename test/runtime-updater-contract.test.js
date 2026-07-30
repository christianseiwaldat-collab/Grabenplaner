"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const { extractUpdaterContract } = require("../server-tools/linux/lib/extract-updater-contract");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("v0.88.4: both runtime migrations canonicalize the final updater contract", () => {
  const updater = read("server-tools", "linux", "update-grabenplaner-server.sh");
  const helper = read("server-tools", "linux", "lib", "extract-updater-contract.js");
  assert.match(updater, /--package-import-method=copy\) >&2/);
  assert.match(helper, /readProtectedFile\(sourcePath,[\s\S]*privateFile: true/);
  assert.match(helper, /requireRootOwner: true/);
  assert.match(helper, /updateReceipt\.packageFile !== "package\.zip"/);
  for (const migrationName of [
    "migrate-grabenplaner-runtime-v2.sh",
    "migrate-grabenplaner-runtime-v3.sh",
  ]) {
    const migration = read("server-tools", "linux", migrationName);
    assert.match(migration, /lib\/extract-updater-contract\.js/);
    assert.match(migration, /updater_contract_helper="\$app_dir\/server-tools\/linux\/lib\/extract-updater-contract\.js"/);
    assert.match(migration, /candidate_updater_contract_helper_sha256/);
    assert.match(migration, /install -m 0600 -o root -g root \/dev\/null "\$updater_output"/);
    assert.match(migration, /"\$updater_output" "\$updater_contract" "\$updater_commit_marker"/);
    assert.match(migration, /"\$backup_dir" "\$data_dir\/maintenance\/history"/);
    assert.match(migration, /"\$node" "\$backup_verifier" "\$backup_database" "\$backup_amu" "\$amu_storage_module" "\$backup_marker"/);
    assert.match(migration, /"\$updater_contract" <<'NODE'/);
  }
});

test("v0.88.4: noisy progress is accepted only before one exact, fully bound final contract", {
  skip: process.platform === "win32" ? "POSIX ownership and mode checks run in the Ubuntu test job" : false,
}, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-updater-contract-"));
  try {
    const expectedPreviousVersion = "0.87.0-beta";
    const expectedInstalledVersion = "0.88.4-beta";
    const expectedPackageSha256 = "a".repeat(64);
    const expectedPublicReadiness = "https://plan.example.test/api/health/ready";

    const fixture = (name, {
      contractOverrides = {},
      commitOverrides = {},
      receiptOverrides = {},
      trailingText = "",
      duplicateContract = false,
    } = {}) => {
      const fixtureRoot = path.join(temporary, name);
      const backupRoot = path.join(fixtureRoot, "backups");
      const historyRoot = path.join(fixtureRoot, "history");
      fs.mkdirSync(backupRoot, { recursive: true });
      fs.mkdirSync(historyRoot, { recursive: true });
      const backup = path.join(backupRoot, "dienstplan-2026-07-30T19-06-44-verified.db");
      const receipt = path.join(historyRoot, "update-2026-07-30T19-07-23-verified.json");
      const sourcePath = path.join(fixtureRoot, "updater.stdout");
      const targetPath = path.join(fixtureRoot, "updater.contract.json");
      const commitMarkerPath = path.join(fixtureRoot, "updater-commit.json");
      const contract = {
        ok: true,
        previousVersion: expectedPreviousVersion,
        installedVersion: expectedInstalledVersion,
        packageSha256: expectedPackageSha256,
        backup,
        receipt,
        publicReadiness: expectedPublicReadiness,
        ...contractOverrides,
      };
      const updateReceipt = {
        status: "success",
        completedAt: "2026-07-30T19:07:23.000Z",
        previousVersion: expectedPreviousVersion,
        requestedVersion: expectedInstalledVersion,
        packageFile: "package.zip",
        packageSha256: expectedPackageSha256,
        backupFile: contract.backup,
        error: null,
        rollbackServiceStopped: true,
        rollbackAppReady: true,
        rollbackDataReady: true,
        rollbackPublicReady: true,
        ...receiptOverrides,
      };
      const commit = {
        format: "grabenplaner-update-commit",
        schemaVersion: 1,
        status: "committed",
        committedAt: "2026-07-30T19:07:23.100Z",
        installedVersion: expectedInstalledVersion,
        packageSha256: expectedPackageSha256,
        updateReceipt: path.basename(receipt),
        ...commitOverrides,
      };
      fs.writeFileSync(receipt, `${JSON.stringify(updateReceipt)}\n`, { mode: 0o640 });
      fs.writeFileSync(commitMarkerPath, `${JSON.stringify(commit)}\n`, { mode: 0o600 });
      fs.writeFileSync(
        sourcePath,
        `✓ Lockfile passes supply-chain policies\nPackages: +42\n${duplicateContract ? `${JSON.stringify(contract)}\n` : ""}${JSON.stringify(contract)}\n${trailingText}`,
        { mode: 0o600 },
      );
      fs.chmodSync(receipt, 0o640);
      fs.chmodSync(commitMarkerPath, 0o600);
      fs.chmodSync(sourcePath, 0o600);
      const run = () => extractUpdaterContract({
        sourcePath,
        targetPath,
        commitMarkerPath,
        expectedPreviousVersion,
        expectedInstalledVersion,
        expectedPackageSha256,
        expectedPublicReadiness,
        expectedBackupRoot: backupRoot,
        expectedHistoryRoot: historyRoot,
        requireRootOwner: false,
      });
      return {
        contract,
        run,
        sourcePath,
        targetPath,
      };
    };

    const valid = fixture("valid");
    assert.deepEqual(valid.run(), valid.contract);
    assert.deepEqual(JSON.parse(fs.readFileSync(valid.targetPath, "utf8")), valid.contract);
    assert.equal(fs.statSync(valid.targetPath).mode & 0o777, 0o600);

    const trailing = fixture("trailing", { trailingText: "unerwartete Ausgabe nach dem Vertrag\n" });
    assert.throws(trailing.run, { code: "UPDATER_CONTRACT_INVALID" });
    assert.equal(fs.existsSync(trailing.targetPath), false);

    const duplicate = fixture("duplicate", { duplicateContract: true });
    assert.throws(duplicate.run, { code: "UPDATER_CONTRACT_INVALID" });
    assert.equal(fs.existsSync(duplicate.targetPath), false);

    const extraKey = fixture("extra-key", { contractOverrides: { unexpected: true } });
    assert.throws(extraKey.run, { code: "UPDATER_CONTRACT_INVALID" });
    assert.equal(fs.existsSync(extraKey.targetPath), false);

    const foreignBackup = fixture("foreign-backup", {
      contractOverrides: { backup: path.join(temporary, "foreign", "dienstplan-invalid.db") },
    });
    assert.throws(foreignBackup.run, { code: "UPDATER_CONTRACT_INVALID" });
    assert.equal(fs.existsSync(foreignBackup.targetPath), false);

    const wrongCommitReceipt = fixture("wrong-commit-receipt", {
      commitOverrides: { updateReceipt: "update-other.json" },
    });
    assert.throws(wrongCommitReceipt.run, { code: "UPDATER_CONTRACT_INVALID" });
    assert.equal(fs.existsSync(wrongCommitReceipt.targetPath), false);

    const tamperedReceipt = fixture("tampered-receipt", {
      receiptOverrides: { packageSha256: "b".repeat(64) },
    });
    assert.throws(tamperedReceipt.run, { code: "UPDATER_CONTRACT_INVALID" });
    assert.equal(fs.existsSync(tamperedReceipt.targetPath), false);

    const wrongPackageName = fixture("wrong-package-name", {
      receiptOverrides: { packageFile: "release.zip" },
    });
    assert.throws(wrongPackageName.run, { code: "UPDATER_CONTRACT_INVALID" });
    assert.equal(fs.existsSync(wrongPackageName.targetPath), false);

    const insecureTranscript = fixture("insecure-transcript");
    fs.chmodSync(insecureTranscript.sourcePath, 0o644);
    assert.throws(insecureTranscript.run, { code: "UPDATER_CONTRACT_INVALID" });
    assert.equal(fs.existsSync(insecureTranscript.targetPath), false);

    const hardlinkedTranscript = fixture("hardlinked-transcript");
    fs.linkSync(hardlinkedTranscript.sourcePath, `${hardlinkedTranscript.sourcePath}.hardlink`);
    assert.throws(hardlinkedTranscript.run, { code: "UPDATER_CONTRACT_INVALID" });
    assert.equal(fs.existsSync(hardlinkedTranscript.targetPath), false);

    const symlinkedTranscript = fixture("symlinked-transcript");
    const symlinkTarget = `${symlinkedTranscript.sourcePath}.target`;
    fs.renameSync(symlinkedTranscript.sourcePath, symlinkTarget);
    fs.symlinkSync(symlinkTarget, symlinkedTranscript.sourcePath);
    assert.throws(symlinkedTranscript.run, { code: "UPDATER_CONTRACT_INVALID" });
    assert.equal(fs.existsSync(symlinkedTranscript.targetPath), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

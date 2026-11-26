"use strict";

// Legacy SQLite helper assertions use the fixed b2 source via legacy-baseline.
// Other PostgreSQL and application assertions below still use current code.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { createAmuStorage, syncEncryptedFilesBackup } = require("../lib/amu-storage");
const { verifyCommittedBackup } = require("../lib/backup-commit");

const powershell = process.platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "";

test("Windows restore accepts only an empty installer-created AMU skeleton", {
  skip: !powershell || !fs.existsSync(powershell),
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-windows-restore-skeleton-"));
  const amuTarget = path.join(root, "private", "amu");
  const harness = path.join(root, "restore-amu-guard.ps1");
  try {
    fs.mkdirSync(path.join(amuTarget, "blobs"), { recursive: true });
    fs.mkdirSync(path.join(amuTarget, "tmp"), { recursive: true });
    const restore = fs.readFileSync(
      path.join(__dirname, "..", "server-tools", "windows", "Restore-Grabenplaner.ps1"),
      "utf8",
    );
    const guardStart = restore.indexOf("$amuTarget =");
    const guardEnd = restore.indexOf("$amuModule =", guardStart);
    assert.notEqual(guardStart, -1, "AMU-Zielpruefung im Restore-Skript fehlt.");
    assert.notEqual(guardEnd, -1, "Ende der AMU-Zielpruefung im Restore-Skript fehlt.");
    fs.writeFileSync(harness, [
      "param([Parameter(Mandatory = $true)][string]$AmuDirectory)",
      "$ErrorActionPreference = 'Stop'",
      restore.slice(guardStart, guardEnd).trim(),
      "Write-Output 'accepted'",
      "",
    ].join("\r\n"), "utf8");

    const emptySkeleton = spawnSync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", harness, "-AmuDirectory", amuTarget,
    ], { encoding: "utf8" });
    assert.equal(emptySkeleton.status, 0, emptySkeleton.stderr);
    assert.match(emptySkeleton.stdout, /accepted/);

    const sentinel = path.join(amuTarget, "blobs", "existing.amu");
    fs.writeFileSync(sentinel, "must-not-be-overwritten", "utf8");
    const nonEmptySkeleton = spawnSync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", harness, "-AmuDirectory", amuTarget,
    ], { encoding: "utf8" });
    assert.notEqual(nonEmptySkeleton.status, 0, nonEmptySkeleton.stdout);
    assert.match(
      `${nonEmptySkeleton.stderr}\n${nonEmptySkeleton.stdout}`,
      /AMU-Ziel ist nicht initialisiert und nicht leer/i,
    );
    assert.equal(fs.readFileSync(sentinel, "utf8"), "must-not-be-overwritten");

    const fileTarget = path.join(root, "private", "amu-file-target");
    fs.writeFileSync(fileTarget, "existing-file-must-survive", "utf8");
    const regularFileTarget = spawnSync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", harness, "-AmuDirectory", fileTarget,
    ], { encoding: "utf8" });
    assert.notEqual(regularFileTarget.status, 0, regularFileTarget.stdout);
    assert.match(
      `${regularFileTarget.stderr}\n${regularFileTarget.stdout}`,
      /AMU-Ziel muss ein regulaeres lokales Verzeichnis ohne Reparse-Point sein/i,
    );
    assert.equal(fs.readFileSync(fileTarget, "utf8"), "existing-file-must-survive");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

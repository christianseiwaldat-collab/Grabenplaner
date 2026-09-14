"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { openSqliteLegacyDatabase } = require("../lib/persistence/sqlite/provider");
const { createAmuStorage } = require("../lib/amu-storage");
const root = path.resolve(__dirname, "..");
const runtimeEntries = ["backup.js", "lib/backup-maintenance.js", "scripts/run-background-backup.js", "scripts/manage-local-backup-archive.js"];
const excluded = ["scripts/verify-tradefoto-full-import.mjs", "scripts/unapproved.js", "scripts/run-background-backup.js/extra",
  "scripts/run-background-backup.js.env", ".env", "data/private.db", "tmp/report.json", "import-jobs/private.source"];
function verifierPolicy() {
  const source = fs.readFileSync(path.join(root, "server-tools/linux/lib/verify-package.js"), "utf8");
  const definitions = [source.match(/^const backupRuntimeScripts = new Set\([\s\S]*?^\]\);/m)?.[0] || ""];
  for (const name of ["isAllowedRuntimePath", "isForbiddenRuntimePath"]) {
    const definition = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"))?.[0];
    assert.ok(definition, name); definitions.push(definition);
  }
  return vm.runInNewContext(`${definitions.join("\n")}\n({ accepts: p => isAllowedRuntimePath(p) && !isForbiddenRuntimePath(p) });`);
}
test("server verifier permits the exact backup entrypoints and still rejects other scripts and data", () => {
  const policy = verifierPolicy();
  for (const name of runtimeEntries) assert.equal(policy.accepts(name), true, name);
  for (const name of excluded) assert.equal(policy.accepts(name), false, name);
});

test("both Windows package builders carry the exact backup entrypoints without admitting arbitrary scripts", {
  skip: process.platform !== "win32",
}, () => {
  for (const builder of ["server-tools/package/New-GrabenplanerLinuxServerPackage.ps1", "server-tools/windows/New-GrabenplanerServerPackage.ps1"]) {
    const source = fs.readFileSync(path.join(root, builder), "utf8");
    const functions = ["Test-ExcludedRelativePath", "Test-AllowedTrackedRuntimePath"].map(name => {
      const definition = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"))?.[0];
      assert.ok(definition, name); return definition;
    }).join("\n");
    const names = [...runtimeEntries, ...excluded];
    const script = `${functions}\n$values = @(${names.map(name => `'${name}'`).join(",")})\n@($values | ForEach-Object { -not (Test-ExcludedRelativePath $_) -and (Test-AllowedTrackedRuntimePath $_) }) | ConvertTo-Json -Compress`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), names.map(name => runtimeEntries.includes(name)), builder);
  }
});

test("background worker creates a verified backup using only files admitted to the server package", { timeout: 30000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-backup-package-fixture-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const packageRoot = path.join(directory, "package"), liveRoot = path.join(directory, "synthetic-live"), backupDirectory = path.join(directory, "backups");
  for (const name of [packageRoot, liveRoot, backupDirectory]) fs.mkdirSync(name);
  const policy = verifierPolicy();
  const files = [...runtimeEntries, "package.json"];
  function collect(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile() && policy.accepts(file)) files.push(file);
    }
  }
  collect("lib");
  for (const file of new Set(files)) {
    if (!policy.accepts(file)) continue;
    const target = path.join(packageRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, file), target, fs.constants.COPYFILE_EXCL);
  }
  const databasePath = path.join(liveRoot, "live.db"), protectedDirectory = path.join(liveRoot, "amu");
  const database = openSqliteLegacyDatabase(databasePath);
  try { database.exec("PRAGMA user_version = 1"); } finally { database.close(); }
  const key = crypto.randomBytes(32);
  createAmuStorage({ rootDirectory: protectedDirectory, encryptionKeys: { synthetic: key }, activeKeyId: "synthetic" });
  key.fill(0);
  const entrypoint = path.join(packageRoot, "scripts/run-background-backup.js");
  const result = spawnSync(process.execPath, [entrypoint], { cwd: packageRoot, encoding: "utf8", windowsHide: true, timeout: 25000,
    input: JSON.stringify({ databasePath, protectedDirectory, backupDirectory, expectedStream: "app" }),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: directory, TMP: directory,
      DB_PATH: databasePath, GRABENPLANER_AMU_DIR: protectedDirectory, GRABENPLANER_LOCAL_BACKUP_ARCHIVE: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.backup.verified, true); assert.equal(outcome.backup.committed, true);
  assert.ok(fs.statSync(outcome.backup.path).size > 0);
});

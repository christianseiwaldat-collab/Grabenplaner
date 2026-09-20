"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { verifyBackupRepairCompatibility } = require("../server-tools/linux/lib/postgresql-backup-repair-compat");
const { copyRecoveryFiles } = require("../lib/persistence/postgresql/operations/runtime");
const { sealPairBundle } = require("../lib/persistence/postgresql/operations/paired-bundle");

const sourceRoot = path.resolve(__dirname, "..");
function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gp-pg-backup-repair-")));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const installed = path.join(temporary, "installed"), candidate = path.join(temporary, "candidate");
  for (const root of [installed, candidate]) {
    fs.mkdirSync(root);
    for (const relative of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
      "lib/persistence/postgresql/operations/runtime.js",
      "lib/persistence/postgresql/operations/paired-restore.js",
      "lib/persistence/postgresql/operations/paired-bundle.js",
      "lib/persistence/postgresql/operations/paired-retention.js",
      "lib/persistence/postgresql/operations/tools.js",
      "lib/persistence/postgresql/runtime-binding.js",
      "server-tools/linux/backup-grabenplaner.sh", "server-tools/linux/lib/common.sh",
      "server-tools/linux/lib/postgresql-maintenance.sh", "server-tools/linux/lib/deploy-policy.js",
      "server-tools/linux/lib/postgresql-operations.js"]) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(sourceRoot, relative), target);
    }
  }
  fs.copyFileSync(path.join(sourceRoot, "test-support/postgresql-backup-repair/runtime-before.txt"),
    path.join(installed, "lib/persistence/postgresql/operations/runtime.js"));
  fs.copyFileSync(path.join(sourceRoot, "test-support/postgresql-backup-repair/operations-before.txt"),
    path.join(installed, "server-tools/linux/lib/postgresql-operations.js"));
  fs.copyFileSync(path.join(sourceRoot, "test-support/postgresql-backup-repair/paired-restore-before.txt"),
    path.join(installed, "lib/persistence/postgresql/operations/paired-restore.js"));
  const metadata = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
  metadata.version = "0.92.58-beta";
  fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify(metadata));
  return { temporary, installed, candidate };
}

test("reviewed scanner repair retains the old configuration and paired-bundle contract", (t) => {
  const f = fixture(t);
  assert.deepEqual(verifyBackupRepairCompatibility(f.installed, f.candidate), {
    verified: true, configurationUnchanged: true, pairedFormatUnchanged: true, excludedVolatilePath: "private/amu/tmp",
  });
});

for (const scenario of ["runtime", "format", "retention", "native-tools", "restore-verification", "configuration-binding", "new-library", "dependency"]) {
  test(`the backup bridge rejects an unreviewed ${scenario} change`, (t) => {
    const f = fixture(t);
    const files = {
      runtime: "lib/persistence/postgresql/operations/runtime.js",
      format: "lib/persistence/postgresql/operations/paired-bundle.js",
      retention: "lib/persistence/postgresql/operations/paired-retention.js",
      "native-tools": "lib/persistence/postgresql/operations/tools.js",
      "restore-verification": "lib/persistence/postgresql/operations/paired-restore.js",
      "configuration-binding": "lib/persistence/postgresql/runtime-binding.js",
      "new-library": "lib/unreviewed-backup.js",
    };
    if (scenario === "dependency") {
      const target = path.join(f.candidate, "package.json"), value = JSON.parse(fs.readFileSync(target, "utf8"));
      value.dependencies.pg = "99.0.0";
      fs.writeFileSync(target, JSON.stringify(value));
    } else fs.appendFileSync(path.join(f.candidate, files[scenario]), "\n// unexpected change\n");
    assert.throws(() => verifyBackupRepairCompatibility(f.installed, f.candidate), /PG_BACKUP_REPAIR_/);
  });
}

test("a repaired bundle excludes the live probe and passes the installed verifier unchanged", async (t) => {
  const f = fixture(t);
  verifyBackupRepairCompatibility(f.installed, f.candidate);
  const source = path.join(f.temporary, "data"), bundle = path.join(f.temporary, "snapshot.pair");
  fs.mkdirSync(path.join(source, "private/amu/tmp"), { recursive: true });
  fs.mkdirSync(path.join(source, "private/amu/blobs"), { recursive: true });
  const probe = path.join(source, "private/amu/tmp/.scanner-probe-123.txt");
  fs.writeFileSync(probe, "Grabenplaner AMU scanner readiness probe\n");
  fs.writeFileSync(path.join(source, "private/amu/blobs/document.amu"), "protected document");
  fs.mkdirSync(bundle, { mode: 0o700 });
  fs.chmodSync(bundle, 0o700);
  for (const name of ["core.dump", "sales.dump", "configuration.env", "roles.sql"]) {
    fs.writeFileSync(path.join(bundle, name), "synthetic fixture", { mode: 0o600 });
  }
  copyRecoveryFiles(source, bundle);
  const sealed = await sealPairBundle(bundle, {
    databases: ["core", "sales"].map(domain => ({ domain, database: `grabenplaner_${domain}`, file: `${domain}.dump` })),
    checkpoint: { quiescence: "synthetic fixture" },
  });
  const oldVerifier = require(path.join(f.installed, "lib/persistence/postgresql/operations/paired-bundle.js"));
  const proof = await oldVerifier.verifyPairBundle(bundle, sealed.commitMarker);
  assert.equal(proof.verified, true);
  assert.equal(proof.files, 5);
  assert.equal(fs.existsSync(path.join(bundle, "private/amu/tmp")), false);
  assert.equal(fs.readFileSync(path.join(bundle, "private/amu/blobs/document.amu"), "utf8"), "protected document");
  assert.equal(fs.existsSync(probe), true, "the bridge never deletes a file from the live source");
});

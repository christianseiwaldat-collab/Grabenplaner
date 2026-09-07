"use strict";

const { validateJob, assertRawBackupCapacity } = require("../lib/background-backup-process");
const { openSqliteLegacyDatabase } = require("../lib/persistence/sqlite/provider");
const { inspectCommittedBackupMetadata } = require("../lib/backup-commit");
const { withBackupWorkspace, MAX_WAIT_MS } = require("../lib/backup-workspace");

function createBackupInChild(request) {
  const job = validateJob(request);
  return withBackupWorkspace(job.databasePath, () => createBackupWhileLocked(job), { waitMs: MAX_WAIT_MS });
}
function createBackupWhileLocked(job) {
  if (process.env.DB_PATH !== job.databasePath || process.env.GRABENPLANER_AMU_DIR !== job.protectedDirectory) {
    throw new Error("BACKGROUND_BACKUP_ENVIRONMENT_MISMATCH");
  }
  assertRawBackupCapacity(job);
  // This is a read-only snapshot connection, not a second application instance.
  // Concurrent writes remain possible. Missing protected references fail closed.
  const database = openSqliteLegacyDatabase(job.databasePath, { readOnly: true });
  const originalLog = console.log;
  try {
    console.log = () => {};
    const { createPairedBackup } = require("../backup");
    const result = createPairedBackup(database, job.backupDirectory, new Date().toISOString().replace(/[:.]/g, "-"),
      "Hintergrundsicherung", job.expectedStream);
    const metadata = inspectCommittedBackupMetadata(job.backupDirectory, result.marker);
    return { format: "grabenplaner-background-backup-result", schemaVersion: 1,
      backup: { path: result.path, protectedDirectory: result.protectedDirectory, marker: result.marker,
        snapshot: metadata.snapshot, databaseSha256: metadata.databaseSha256, committed: true, verified: true, archive: result.archive || null } };
  } finally { console.log = originalLog; database.close(); }
}

async function main() {
  if (process.argv.length !== 2) throw new Error("BACKGROUND_BACKUP_ARGUMENTS_INVALID");
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16 * 1024) throw new Error("BACKGROUND_BACKUP_INPUT_LIMIT");
    chunks.push(chunk);
  }
  return createBackupInChild(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
if (require.main === module) {
  main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`), () => {
    process.stderr.write("Die Hintergrundsicherung konnte nicht sicher abgeschlossen werden.\n");
    process.exitCode = 1;
  });
}
module.exports = { createBackupInChild };

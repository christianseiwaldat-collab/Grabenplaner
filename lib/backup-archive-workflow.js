"use strict";

const { openLocalBackupArchiveFromEnvironment } = require("./local-backup-environment");

function prepareLocalBackupArchive({ backupDirectory, keep = 20, vault, environment, archiveFactory, expectedStream, cachedMetadataOnly = false } = {}) {
  const archive = openLocalBackupArchiveFromEnvironment({ backupDirectory, vault, environment, archiveFactory, expectedStream, cachedMetadataOnly });
  if (archive && keep !== 20) throw new Error("LOCAL_ARCHIVE_RETENTION_REQUIRES_20_DAYS");
  return archive;
}

// Call only AFTER the raw pair has been committed. Archive errors must never
// enter the raw pair's incomplete-file cleanup branch. There is no fallback to
// the legacy pruner when an enabled archive cannot complete its verification.
function archivePublishedBackup(archive, snapshot, verifyPair) {
  if (!archive || typeof verifyPair !== "function") throw new Error("LOCAL_ARCHIVE_WORKFLOW_INVALID");
  const point = archive.archivePair(snapshot, { verifyPair });
  if (point?.archived !== true || !/^[a-f0-9]{64}$/.test(String(point?.archiveSnapshotId || ""))) {
    throw new Error("LOCAL_ARCHIVE_RECEIPT_INVALID");
  }
  const retention = archive.maintainRetention(snapshot, { verifyPair });
  if (!Number.isSafeInteger(retention?.retained)
    || retention.retained < 1 || retention.retained > 20) throw new Error("LOCAL_ARCHIVE_RECEIPT_INVALID");
  return { archived: true, archiveSnapshotId: point.archiveSnapshotId, retained: retention.retained,
    removedArchives: retention.removedArchives, removedRaw: retention.removedRaw };
}

module.exports = { prepareLocalBackupArchive, archivePublishedBackup };

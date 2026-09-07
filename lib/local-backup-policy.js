"use strict";

// Planning only. This module never changes retention, provisions credentials,
// deletes a snapshot, or activates an archive in place of a committed DB pair.
const { BACKUP_RETENTION_DAYS: LOCAL_BACKUP_RETENTION, planDailyBackups } = require('./backup-retention');
const RESERVE_BYTES = 10 * 1024 ** 3;
const HASH = /^[0-9a-f]{64}$/;
const TAG = "grabenplaner-local";

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`BACKUP_PLAN_INVALID_${label}`);
  return value;
}

function planLocalBackupCapacity({ freeBytes, liveGrowthBytes, coupledSnapshotBytes,
  baselineArchiveBytes, changedBytesPerPoint, walPeakBytes, candidateArchiveBytes,
  orphanBytes, gcDebtBytes, localAreas = 2, workingCopies,
  measuredFullSource = false, measuredChangeWindow = false,
  steadyStateGcMeasured = false, globalSerializationVerified = false,
  offsiteSingleStageVerified = false, peakCapacityMeasured = false,
  legacyDeletionCreditBytes = 0 }) {
  const serializedSingleStage = globalSerializationVerified === true && offsiteSingleStageVerified === true;
  const minimumWorkingCopies = serializedSingleStage ? 5 : 7;
  const selectedWorkingCopies = workingCopies === undefined ? (serializedSingleStage ? 5 : 8) : workingCopies;
  for (const [key, value] of Object.entries({ freeBytes, liveGrowthBytes, coupledSnapshotBytes,
    baselineArchiveBytes, changedBytesPerPoint, walPeakBytes, candidateArchiveBytes,
    orphanBytes, gcDebtBytes, localAreas, workingCopies: selectedWorkingCopies,
    legacyDeletionCreditBytes })) count(value, key);
  if (!coupledSnapshotBytes || !baselineArchiveBytes || !candidateArchiveBytes
    || localAreas < 2 || selectedWorkingCopies < minimumWorkingCopies || legacyDeletionCreditBytes !== 0) {
    throw new Error("BACKUP_PLAN_MISSING_SAFETY_COMPONENT");
  }
  const archivePerAreaBytes = baselineArchiveBytes + (LOCAL_BACKUP_RETENTION - 1) * changedBytesPerPoint;
  const requiredAdditionalBytes = liveGrowthBytes + walPeakBytes + localAreas * archivePerAreaBytes
    + selectedWorkingCopies * coupledSnapshotBytes + candidateArchiveBytes + orphanBytes + gcDebtBytes + RESERVE_BYTES;
  count(requiredAdditionalBytes, "total");
  const evidence = Object.freeze({ measuredFullSource: measuredFullSource === true,
    measuredChangeWindow: measuredChangeWindow === true, steadyStateGcMeasured: steadyStateGcMeasured === true,
    globalSerializationVerified: globalSerializationVerified === true,
    offsiteSingleStageVerified: offsiteSingleStageVerified === true, peakCapacityMeasured: peakCapacityMeasured === true });
  const evidenceComplete = Object.values(evidence).every(Boolean);
  return Object.freeze({ retentionPerArea: LOCAL_BACKUP_RETENTION, localAreas,
    workingCopies: selectedWorkingCopies, minimumWorkingCopies,
    workingCopyBasis: serializedSingleStage ? "verified-serialized-single-offsite-stage" : "conservative-unverified-coordinator",
    reserveBytes: RESERVE_BYTES, archivePerAreaBytes, walPeakBytes, candidateArchiveBytes,
    orphanBytes, gcDebtBytes, legacyDeletionCreditBytes: 0, requiredAdditionalBytes,
    remainingBytes: freeBytes - requiredAdditionalBytes,
    capacityFits: freeBytes >= requiredAdditionalBytes,
    qualified: evidenceComplete && freeBytes >= requiredAdditionalBytes,
    evidence,
    destructiveActions: false });
}

function assertRetentionScope({ host, stream }) {
  if (!/^gp-[a-z0-9-]{1,80}$/.test(String(host)) || !["app", "external"].includes(stream)) {
    throw new Error("BACKUP_RETENTION_SCOPE_INVALID");
  }
}

function planArchiveRetention({ snapshots, host, stream, latestId, now = new Date() }) {
  assertRetentionScope({ host, stream });
  const plan = planDailyBackups(snapshots, { now });
  const keep = new Set(plan.retainedIds);
  const groups = [{ host, tags: [TAG, `stream-${stream}`], keep: snapshots.filter(p => keep.has(p.id)), remove: snapshots.filter(p => !keep.has(p.id)) }];
  return verifyRetentionPreview({ groups, snapshots, host, stream, latestId, now });
}

function verifyRetentionPreview({ groups, snapshots, host, stream, latestId, now = new Date() }) {
  assertRetentionScope({ host, stream });
  if (!HASH.test(String(latestId)) || !Array.isArray(groups) || groups.length !== 1 || !Array.isArray(snapshots)) {
    throw new Error("BACKUP_RETENTION_PREVIEW_INVALID");
  }
  const tags = [TAG, `stream-${stream}`].sort();
  const scoped = entry => entry?.hostname === host && Array.isArray(entry.tags)
    && JSON.stringify([...entry.tags].sort()) === JSON.stringify(tags);
  if (snapshots.some(entry => !HASH.test(String(entry.id)) || !scoped(entry) || !Number.isFinite(Date.parse(entry.time)))) {
    throw new Error("BACKUP_RETENTION_FOREIGN_SNAPSHOT");
  }
  const inventory = new Map(snapshots.map(entry => [entry.id, entry]));
  if (inventory.size !== snapshots.length || !inventory.has(latestId)) throw new Error("BACKUP_RETENTION_INVENTORY_INVALID");
  const group = groups[0], keep = group.keep, remove = group.remove === null ? [] : group.remove;
  if (group.host !== host || JSON.stringify([...(group.tags || [])].sort()) !== JSON.stringify(tags)
    || !Array.isArray(keep) || !Array.isArray(remove)) throw new Error("BACKUP_RETENTION_GROUP_INVALID");
  const seen = new Set();
  for (const entry of [...keep, ...remove]) {
    if (!inventory.has(entry?.id) || seen.has(entry.id) || !scoped(entry)
      || entry.time !== inventory.get(entry.id).time) throw new Error("BACKUP_RETENTION_PARTITION_INVALID");
    seen.add(entry.id);
  }
  const daily = planDailyBackups(snapshots, { now });
  if (seen.size !== inventory.size || keep.length !== daily.retainedIds.length
    || keep.some(entry => !daily.retainedIds.includes(entry.id))
    || !keep.some(entry => entry.id === latestId)) throw new Error("BACKUP_RETENTION_POINTS_MISSING");
  return Object.freeze({ ok: true, dryRun: true, retained: keep.length, removable: remove.length,
    retainedIds: daily.retainedIds, policy: daily.policy, asOf: daily.asOf, cutoffDay: daily.cutoffDay, removed: 0 });
}

module.exports = { LOCAL_BACKUP_RETENTION, RESERVE_BYTES, planLocalBackupCapacity, assertRetentionScope, planArchiveRetention, verifyRetentionPreview };

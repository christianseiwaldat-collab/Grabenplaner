"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { planLocalBackupCapacity, assertRetentionScope, verifyRetentionPreview } = require("../lib/local-backup-policy");
const host = "gp-synthetic", stream = "app", tags = ["grabenplaner-local", "stream-app"];
const snapshots = Array.from({ length: 32 }, (_, i) => ({ id: i.toString(16).padStart(64, "0"),
  hostname: host, tags, time: new Date(Date.UTC(2026, 0, i + 1)).toISOString() }));
const preview = () => ({ groups: [{ host, tags, keep: snapshots.slice(12), remove: snapshots.slice(0, 12) }],
  snapshots, host, stream, latestId: snapshots.at(-1).id, now: '2026-02-01T12:00:00Z' });

test("local retention keeps twenty calendar days, independently of changing file names", () => {
  assertRetentionScope({ host, stream });
  assert.throws(() => assertRetentionScope({ host: 'foreign', stream }), /BACKUP_RETENTION_SCOPE_INVALID/);
  assert.equal(verifyRetentionPreview(preview()).retained, 20);
  assert.equal(verifyRetentionPreview(preview()).removed, 0);
  for (const change of [p => p.groups[0].keep.pop(), p => p.groups[0].keep.push(p.groups[0].keep[0]),
    p => p.groups.push(p.groups[0]), p => p.groups[0].keep[0].hostname = "gp-foreign",
    p => p.groups[0].tags.push("another-stream"), p => p.latestId = "f".repeat(64)]) {
    const p = structuredClone(preview()); change(p);
    assert.throws(() => verifyRetentionPreview(p), /BACKUP_RETENTION_/);
  }
});

test("capacity includes explicit peak, candidate, orphan and GC debt without legacy deletion credit", () => {
  const GiB = 1024 ** 3;
  const inputs = { freeBytes: 120 * GiB, liveGrowthBytes: 8 * GiB, coupledSnapshotBytes: 8 * GiB,
    baselineArchiveBytes: 6 * GiB, changedBytesPerPoint: 64 * 1024 ** 2,
    walPeakBytes: GiB, candidateArchiveBytes: 2 * GiB, orphanBytes: GiB, gcDebtBytes: 2 * GiB };
  const unmeasured = planLocalBackupCapacity(inputs);
  assert.equal(unmeasured.retentionPerArea, 20);
  assert.equal(unmeasured.localAreas, 2);
  assert.equal(unmeasured.workingCopies, 8);
  assert.equal(unmeasured.minimumWorkingCopies, 7);
  assert.equal(unmeasured.workingCopyBasis, "conservative-unverified-coordinator");
  assert.equal(unmeasured.requiredAdditionalBytes,
    inputs.liveGrowthBytes + inputs.walPeakBytes
      + 2 * (inputs.baselineArchiveBytes + 19 * inputs.changedBytesPerPoint)
      + 8 * inputs.coupledSnapshotBytes + inputs.candidateArchiveBytes + inputs.orphanBytes + inputs.gcDebtBytes + 10 * GiB);
  assert.equal(unmeasured.legacyDeletionCreditBytes, 0);
  assert.equal(unmeasured.capacityFits, true);
  assert.equal(unmeasured.qualified, false, "synthetic savings cannot qualify production");
  assert.equal(planLocalBackupCapacity({ ...inputs, measuredFullSource: true, measuredChangeWindow: true }).qualified, false,
    "source and change measurements alone are insufficient");

  const qualified = planLocalBackupCapacity({ ...inputs, measuredFullSource: true, measuredChangeWindow: true,
    steadyStateGcMeasured: true, globalSerializationVerified: true,
    offsiteSingleStageVerified: true, peakCapacityMeasured: true });
  assert.equal(qualified.workingCopies, 5);
  assert.equal(qualified.minimumWorkingCopies, 5);
  assert.equal(qualified.workingCopyBasis, "verified-serialized-single-offsite-stage");
  assert.equal(qualified.qualified, true);
  assert.ok(Object.values(qualified.evidence).every(Boolean));
  assert.equal(planLocalBackupCapacity({ ...inputs, freeBytes: GiB, measuredFullSource: true, measuredChangeWindow: true,
    steadyStateGcMeasured: true, globalSerializationVerified: true,
    offsiteSingleStageVerified: true, peakCapacityMeasured: true }).qualified, false);

  for (const change of [{ workingCopies: 4, globalSerializationVerified: true, offsiteSingleStageVerified: true },
    { workingCopies: 6 }, { localAreas: 1 }, { freeBytes: NaN }, { changedBytesPerPoint: -1 },
    { candidateArchiveBytes: 0 }, { legacyDeletionCreditBytes: GiB }]) {
    assert.throws(() => planLocalBackupCapacity({ ...inputs, ...change }), /BACKUP_PLAN_/);
  }
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { matchingNightly, matchingReceipt } = require('../scripts/operations/restore-timer/restore-proof.cjs');
const hash = s => createHash('sha256').update(s).digest('hex');

function fixture() {
  const slot = Date.parse('2026-11-19T04:30:00Z');
  const finished = '2026-11-19T06:05:53Z';
  const snapshot = { id: 'a'.repeat(64), time: '2026-11-19T04:50:51Z' };
  const receipt = { format: 'grabenplaner-offsite-restore-test', schemaVersion: 2, result: 'verified',
    providerId: 'postgresql-pair', databases: { core: {}, sales: {} }, targetAppVersion: '104',
    snapshotId: snapshot.id, snapshotTime: snapshot.time, repositoryBindingSha256: hash('repo'),
    installationBindingSha256: hash('site'), sourcePathSha256: hash('/var/lib/grabenplaner-offsite/staging/current'),
    startedAt: '2026-11-19T05:25:00Z' };
  const bytes = Buffer.from(JSON.stringify(receipt));
  const proof = { receiptSha256: hash(bytes), verifiedAt: finished, sequence: 3, runId: 'night', eventHash: hash('last') };
  const events = ['restore-test-passed','application-smoke-passed','full-assurance-passed'].map((eventType, i) => ({
    sequence: i+1, eventHash: i===2 ? proof.eventHash : hash(String(i)),
    payload: { eventType, runId: 'night', trigger: 'scheduled-nightly', occurredAt: finished,
      evidence: { receiptSha256: proof.receiptSha256, snapshotIdPrefix: snapshot.id.slice(0,12), appVersion: '104' } }
  }));
  return { slot, snapshot, receipt, bytes, proof, history: { ok: true, events }, now: Date.parse(finished)+60000 };
}
const covered = f => matchingNightly(f.history, f.proof, f.snapshot, f.slot, f.now);
const receiptMatches = (f, version='104', manifestChangedAt=0) =>
  matchingReceipt(f.bytes, f.proof, f.snapshot, version, 'repo', 'site', manifestChangedAt);

test('a timer waiting behind the full nightly recognizes the signed restore of its exact snapshot', () => {
  const f = fixture();
  assert.ok(covered(f) && receiptMatches(f));
  f.snapshot.id = 'a'.repeat(12) + 'b'.repeat(52);
  assert.equal(receiptMatches(f), false, 'a shared prefix does not bind a snapshot');
});
test('failed, newer, incomplete, stale or unauthenticated evidence leaves the restore due', () => {
  for (const mutate of [
    f => { f.history.ok=false; }, f => { f.proof.sequence++; },
    f => { f.history.events.at(-1).payload.eventType='full-assurance-failed'; },
    f => { f.history.events.push({payload:{eventType:'full-assurance-started'}}); },
    f => { f.history.events[1].payload.eventType='application-smoke-not-run'; },
    f => { f.history.events[0].payload.runId='different'; },
    f => { f.history.events[1].payload.evidence.receiptSha256=hash('another'); },
    f => { f.slot+=86400000; f.now+=86400000; }
  ]) { const f=fixture(); mutate(f); assert.equal(covered(f),false); }
});
test('changed application, Core-only scope, another repository, or tampering requires a restore', () => {
  const f=fixture();
  assert.equal(receiptMatches(f,'105'),false);
  assert.equal(receiptMatches(f,'104',f.now),false);
  f.bytes=Buffer.from('{}');
  assert.equal(receiptMatches(f),false);
  for (const delta of [{providerId:'postgresql-deploy-owned'}, {databases:{core:{}}},
    {installationBindingSha256:hash('other')}, {repositoryBindingSha256:hash('other')}]) {
    f.bytes=Buffer.from(JSON.stringify({...f.receipt,...delta}));
    f.proof.receiptSha256=hash(f.bytes);
    assert.equal(receiptMatches(f),false);
  }
});

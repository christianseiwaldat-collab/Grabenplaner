'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { FORMAT, validateProof, validateRestore, validateOffsiteBasis, decodeRestoreReceipt } = require('../server-tools/linux/lib/core-deploy-proof');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

function fixture() {
  const identity = { databaseIdentitySha256: hash('productive pair'), schemaSha256: hash('productive schema') };
  const proof = { format: FORMAT, schemaVersion: 1, scope: 'deploy-owned',
    sourceManifestSha256: hash('source manifest'), targetManifestSha256: hash('target manifest'),
    configurationSha256: hash('configuration'), ...identity,
    restoreFile: '/private/synthetic-restore.json', restoreSha256: hash('restored'),
    verifiedAt: '2026-11-18T19:20:00Z',
    backup: { ok: true, providerId: 'postgresql-deploy-owned', recoveryScope: 'deploy-owned',
      sha256: hash('point manifest'), createdAt: '2026-11-18T18:00:00Z' } };
  const context = { installedManifest: proof.sourceManifestSha256, candidateManifest: proof.targetManifestSha256,
    identity, configurationSha256: proof.configurationSha256, now: Date.parse('2026-11-18T19:21:00Z') };
  const restore = { ok: true, providerId: 'postgresql-deploy-owned', recoveryScope: 'deploy-owned',
    fullRecovery: false, ownedApplicationSmoke: true, pairManifestSha256: proof.backup.sha256,
    sourceAppVersion: '0.92.103-beta', targetAppVersion: '0.92.104-beta', verifiedAt: proof.verifiedAt };
  return { proof, context, restore };
}

test('a Core point with the exact source and qualified target is eligible independently of package inventory changes', () => {
  const f = fixture();
  assert.equal(validateProof(f.proof, f.context).verified, true);
  validateRestore(f.restore, f.proof.backup, '0.92.103-beta', '0.92.104-beta');
  assert.equal(validateProof(f.proof, { ...f.context, candidateManifest: undefined }).verified, true);
});

test('foreign packages, pair, configuration, missing evidence and stale points cannot authorize a Core deploy', () => {
  const f = fixture();
  for (const context of [
    { ...f.context, installedManifest: hash('foreign source') },
    { ...f.context, candidateManifest: hash('foreign candidate') },
    { ...f.context, identity: { ...f.context.identity, databaseIdentitySha256: hash('foreign pair') } },
    { ...f.context, configurationSha256: hash('changed configuration') },
    { ...f.context, now: f.context.now + 37 * 3600000 },
  ]) assert.throws(() => validateProof(f.proof, context));
  for (const mutate of [
    proof => proof.scope = 'full',
    proof => proof.restoreSha256 = null,
    proof => proof.backup.ok = false,
    proof => proof.backup.recoveryScope = 'full',
    proof => proof.verifiedAt = '2026-11-19T19:00:00Z',
  ]) {
    const proof = structuredClone(f.proof);mutate(proof);
    assert.throws(() => validateProof(proof, f.context));
  }
});

test('the isolated restore must prove own contents for the exact point and both application versions', () => {
  const f = fixture();
  for (const mutate of [
    r => r.ok = false,
    r => r.ownedApplicationSmoke = false,
    r => r.pairManifestSha256 = hash('different backup'),
    r => r.sourceAppVersion = 'different',
    r => r.targetAppVersion = 'different',
    r => r.recoveryScope = 'full',
  ]) {
    const restore = structuredClone(f.restore);mutate(restore);
    assert.throws(() => validateRestore(restore, f.proof.backup, '0.92.103-beta', '0.92.104-beta'));
  }
});

test('durable restore evidence preserves exact authenticated bytes and both application versions', () => {
  const f = fixture(), bytes = Buffer.from(JSON.stringify(f.restore, null, 2) + '\n');
  const restored = decodeRestoreReceipt(bytes.toString('base64'));
  assert.deepEqual(restored.bytes, bytes);
  assert.equal(hash(restored.bytes), hash(bytes));
  validateRestore(restored.value, f.proof.backup, '0.92.103-beta', '0.92.104-beta');
});

test('malformed, noncanonical or oversized embedded receipts cannot replace a protected restore', () => {
  for (const encoded of [null, '', 'e30', 'e30=\n', '%%%=', 'a'.repeat(Math.ceil(2 * 1024 * 1024 / 3) * 4 + 1)]) {
    assert.throws(() => decodeRestoreReceipt(encoded), { code: 'CORE_DEPLOY_RESTORE_ENCODING' });
  }
  assert.throws(() => decodeRestoreReceipt(Buffer.from('invalid JSON').toString('base64')), SyntaxError);
});

test('a signed external recovery stays attributable while a separate nightly backup failure remains visible', () => {
  const f = fixture(), identity = { providerId: 'postgresql-pair', ...f.context.identity };
  const full = { format: 'grabenplaner-deploy-verification', schemaVersion: 3, providerId: 'postgresql-pair',
    ...f.context.identity, configurationSha256: f.context.configurationSha256, verifiedAt: f.proof.verifiedAt,
    runId: 'verified-full-run', sequence: 3, eventHash: hash('full-pass'), receiptSha256: hash('external-full-receipt') };
  const history = { ok: true, events: [
    { sequence: 3, eventHash: full.eventHash, payload: { eventType: 'full-assurance-passed', runId: full.runId,
      occurredAt: full.verifiedAt, evidence: { receiptSha256: full.receiptSha256 } } },
    { sequence: 4, eventHash: hash('night-failure'), payload: { eventType: 'full-assurance-failed' } },
  ] };
  const before = structuredClone(history);
  assert.equal(validateOffsiteBasis(full, history, identity, f.context.configurationSha256, f.context.now).scope, 'full');
  assert.deepEqual(history, before);
  assert.throws(() => validateOffsiteBasis(full, { ...history, ok: false }, identity, f.context.configurationSha256, f.context.now));
  assert.throws(() => validateOffsiteBasis(full, history, identity, hash('foreign repository'), f.context.now));
});

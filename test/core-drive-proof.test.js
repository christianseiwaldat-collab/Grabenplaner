'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const drive = require('../server-tools/linux/lib/core-drive-proof');
const { MAX_AGE_MS } = require('../server-tools/linux/lib/deploy-policy');
const { validateOffsiteBasis } = require('../server-tools/linux/lib/core-deploy-proof');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const now = Date.parse('2026-11-20T00:00:00Z');
const host = 'grabenplaner-' + 'a'.repeat(32);

function fixture() {
  const proof = { format: 'grabenplaner-core-plus-drive-restore-v1', scope: 'deploy-owned', provider: 'google_drive',
    fullRecovery: false, archiveSha256: hash('download'), snapshotId: hash('drive'), manifestSha256: hash('point'),
    sourceManifestSha256: hash('installed'), targetManifestSha256: hash('candidate'), configurationSha256: hash('config'),
    databaseIdentitySha256: hash('pair'), schemaSha256: hash('schema'), sourceVersion: '1', targetVersion: '2',
    repositoryId: hash('repository'), installationId: host.slice('grabenplaner-'.length),
    createdAt: new Date(now - 3600000).toISOString(), verifiedAt: new Date(now).toISOString(),
    bundle: '/private/sealed.owned' };
  const receipt = { ok: true, recoveryScope: 'deploy-owned', fullRecovery: false, ownedApplicationSmoke: true,
    providerId: 'postgresql-deploy-owned', pairManifestSha256: proof.manifestSha256, sourceAppVersion: '1',
    targetAppVersion: '2', verifiedAt: proof.verifiedAt };
  return { proof, receipt };
}

function sign({ proof, receipt }) {
  const bytes = Buffer.from(JSON.stringify(receipt));
  const p = { ...proof, restoreBytes: bytes.toString('base64'), restoreSha256: hash(bytes) };
  return { proof: p, signature: crypto.sign(null, drive.signingBytes(p), privateKey).toString('base64') };
}

test('Drive receipt binds exact downloaded point, host, database, packages and configuration independently of nightly history', () => {
  const { proof, receipt } = fixture(), envelope = sign({ proof, receipt });
  const read = (context, date = now) => drive.verifySigned(envelope, publicKey, context, date, MAX_AGE_MS);
  assert.equal(read(proof).snapshotId, proof.snapshotId);
  assert.equal(drive.backupOf(read(proof)).sha256, proof.manifestSha256);
  for (const field of ['repositoryId','installationId','configurationSha256','databaseIdentitySha256','schemaSha256',
    'sourceManifestSha256','targetManifestSha256','snapshotId','archiveSha256','manifestSha256']) {
    assert.throws(() => read({ [field]: hash('other') }), /CORE_DRIVE_BINDING/);
  }
  assert.throws(() => read(proof, Date.parse(proof.createdAt) + MAX_AGE_MS + 1), /CORE_DRIVE_STALE/);
  assert.throws(() => validateOffsiteBasis(envelope.proof, { ok: true }, {}, proof.configurationSha256, now));
  envelope.proof.snapshotId = hash('replacement');
  assert.throws(() => read({}), /CORE_DRIVE_SIGNATURE/);
});

test('a signed upload cannot substitute for successful isolated Core recovery', () => {
  const { proof, receipt } = fixture();
  for (const changes of [{ ok: false }, { ownedApplicationSmoke: false }, { fullRecovery: true },
    { recoveryScope: 'full' }, { providerId: 'postgresql-pair' }, { pairManifestSha256: hash('other') },
    { sourceAppVersion: '0' }, { targetAppVersion: '3' }]) {
    assert.throws(() => drive.verifySigned(sign({ proof, receipt: { ...receipt, ...changes } }),
      publicKey, {}, now, MAX_AGE_MS), /CORE_DRIVE_RECEIPT/);
  }
  const otherKey = crypto.generateKeyPairSync('ed25519').publicKey;
  assert.throws(() => drive.verifySigned(sign({ proof, receipt }), otherKey, {}, now, MAX_AGE_MS), /CORE_DRIVE_SIGNATURE/);
});

test('only the exact Core tag, host, point, path and unique full snapshot id are eligible for reuse', () => {
  const point = hash('point'), id = hash('remote'), core = { id, hostname: host, paths: ['/core-plus.tar'],
    tags: ['grabenplaner-core-plus', 'core-' + point] };
  const nightly = { id: hash('nightly'), hostname: host, paths: ['/var/lib/grabenplaner-offsite/staging/current'], tags: ['grabenplaner-offsite'] };
  assert.equal(drive.snapshotId([nightly, { ...core, hostname: 'other' }], host, point), '');
  assert.equal(drive.snapshotId([nightly, core], host, point), id);
  for (const rows of [[core, core], [{ ...core, id: id.slice(0, 8) }], [{ ...core, paths: nightly.paths }]]) {
    assert.throws(() => drive.snapshotId(rows, host, point), /CORE_DRIVE_SNAPSHOT/);
  }
  const mirror = { id: hash('receipt snapshot'), hostname: host, paths: ['/core-plus-receipt.json'],
    tags: ['grabenplaner-core-plus-receipt', 'receipt-' + point, 'for-' + id] };
  assert.equal(drive.snapshotId([mirror, core], host, point, true), mirror.id);
  assert.equal(drive.snapshotId([mirror], host, point), '');
  assert.throws(() => drive.snapshotId([{ ...mirror, paths: core.paths }], host, point, true), /CORE_DRIVE_SNAPSHOT/);
});

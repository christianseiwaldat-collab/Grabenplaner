'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = '/var/lib/grabenplaner-assurance';
const FILE = path.join(ROOT, 'core-drive-verification.json');
const PENDING = path.join(ROOT, 'core-drive-pending-point.json');
const PENDING_RECEIPT = path.join(ROOT, 'core-drive-pending-verification.json');
const FORMAT = 'grabenplaner-core-plus-drive-restore-v1';
const SHA = /^[0-9a-f]{64}$/;
const TAG = 'grabenplaner-core-plus';
const ARCHIVE = '/core-plus.tar';
const ENV = '/etc/grabenplaner/grabenplaner.env';
const OPERATIONS = '/etc/grabenplaner/postgresql-operations.json';
const CONFIG = '/etc/grabenplaner/offsite';
const fail = code => { throw new Error(code); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const signingBytes = proof => Buffer.from(FORMAT + '\n' + JSON.stringify(proof));
const policy = app => require(path.join(app, 'server-tools/linux/lib/deploy-policy'));

function snapshotId(rows, host, manifest, receipt = false) {
  if (!Array.isArray(rows) || !SHA.test(manifest) || !/^grabenplaner-[a-f0-9]{32}$/.test(host)) fail('CORE_DRIVE_SNAPSHOT_LIST');
  const tag = receipt ? TAG + '-receipt' : TAG;
  const content = (receipt ? 'receipt-' : 'core-') + manifest;
  const file = receipt ? '/core-plus-receipt.json' : ARCHIVE;
  const matches = rows.filter(row => row.hostname === host && row.tags?.includes(tag) && row.tags.includes(content));
  if (matches.some(row => !SHA.test(row.id) || row.paths?.length !== 1 || row.paths[0] !== file)
      || matches.length > 1) fail('CORE_DRIVE_SNAPSHOT_AMBIGUOUS');
  return matches[0]?.id || '';
}

function verifySigned(envelope, publicKey, expected, now, maxAgeMs) {
  const p = envelope?.proof;
  if (publicKey.asymmetricKeyType !== 'ed25519' || p?.format !== FORMAT || p.scope !== 'deploy-owned'
      || p.provider !== 'google_drive' || p.fullRecovery !== false || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature || '')
      || !crypto.verify(null, signingBytes(p), publicKey, Buffer.from(envelope.signature, 'base64'))) fail('CORE_DRIVE_SIGNATURE');
  for (const name of ['snapshotId','archiveSha256','manifestSha256','sourceManifestSha256','targetManifestSha256',
    'configurationSha256','databaseIdentitySha256','schemaSha256','restoreSha256']) {
    if (!SHA.test(p[name] || '')) fail('CORE_DRIVE_BINDING');
  }
  for (const [name, value] of Object.entries(expected)) {
    if (p[name] !== value) fail('CORE_DRIVE_BINDING');
  }
  const captured = Date.parse(p.createdAt), verified = Date.parse(p.verifiedAt);
  if (!Number.isFinite(captured) || !Number.isFinite(verified) || verified < captured || verified > now + 300000
      || now - captured > maxAgeMs) fail('CORE_DRIVE_STALE');
  const bytes = Buffer.from(p.restoreBytes, 'base64');
  if (bytes.toString('base64') !== p.restoreBytes || digest(bytes) !== p.restoreSha256) fail('CORE_DRIVE_RECEIPT');
  const restore = JSON.parse(bytes);
  if (restore.ok !== true || restore.providerId !== 'postgresql-deploy-owned' || restore.recoveryScope !== 'deploy-owned'
      || restore.fullRecovery !== false || restore.ownedApplicationSmoke !== true || restore.pairManifestSha256 !== p.manifestSha256
      || restore.sourceAppVersion !== p.sourceVersion || restore.targetAppVersion !== p.targetVersion
      || restore.verifiedAt !== p.verifiedAt) fail('CORE_DRIVE_RECEIPT');
  return p;
}

function small(app, file, max = 2 * 1024 * 1024) {
  return policy(app).readRegular(file, max, { rootOnly: true });
}

function repository(app) {
  const repositoryId = small(app, path.join(CONFIG, 'repository-id'), 256).toString().trim();
  const installationId = small(app, path.join(CONFIG, 'installation-id'), 256).toString().trim();
  if (!/^[0-9a-f]{16,64}$/.test(repositoryId) || !/^[0-9a-f]{32}$/.test(installationId)) fail('CORE_DRIVE_REPOSITORY');
  return { repositoryId, installationId };
}

function readSigned(app, identity, configurationSha256, fields = {}, file = FILE) {
  const publicKey = crypto.createPublicKey(small(app, path.join(ROOT, 'signing-public.pem'), 4096));
  return verifySigned(JSON.parse(small(app, file)), publicKey, {
    ...repository(app), databaseIdentitySha256: identity.databaseIdentitySha256, schemaSha256: identity.schemaSha256,
    configurationSha256, ...fields }, Date.now(), policy(app).MAX_AGE_MS);
}

async function pointContext(app, target, bundle, verifyContent) {
  const legacy = policy(app);
  const config = require(path.join(app, 'lib/persistence/postgresql/operations/runtime')).loadConfiguration(OPERATIONS);
  if (!/^[a-f0-9-]{36}\.owned$/.test(path.basename(bundle)) || bundle !== path.join(config.backupDirectory, path.basename(bundle))
      || fs.realpathSync(bundle) !== bundle || fs.statSync(bundle).uid !== 0) fail('CORE_DRIVE_POINT_PATH');
  const marker = bundle + '.complete.json';
  const point = await require(path.join(app, 'lib/persistence/postgresql/operations/paired-bundle')).verifyPairBundle(
    bundle, marker, { scope: 'deploy-owned', verifyContent });
  const identity = legacy.postgresqlPairIdentity(point.manifest.checkpoint.domains);
  const live = await legacy.configuredDatabaseIdentity(path.join(config.sourceFiles, 'data/postgresql-pair.json'), ENV);
  if (!small(app, path.join(bundle, 'configuration.env'), 65536).equals(small(app, ENV, 65536))) fail('CORE_DRIVE_SOURCE_CONFIGURATION');
  if (point.manifest.recovery.basis !== 'fresh-source-rebuild' || identity.databaseIdentitySha256 !== live.databaseIdentitySha256
      || identity.schemaSha256 !== live.schemaSha256) fail('CORE_DRIVE_DATABASE');
  const createdAt = point.manifest.createdAt, age = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(age) || age < -300000 || age > legacy.MAX_AGE_MS) fail('CORE_DRIVE_STALE');
  const sourcePackage = legacy.applicationContract(app), targetPackage = app === target ? sourcePackage : legacy.applicationContract(target);
  return { ...repository(app), databaseIdentitySha256: live.databaseIdentitySha256, schemaSha256: live.schemaSha256,
    configurationSha256: legacy.configurationIdentity(ENV), manifestSha256: point.manifestSha256,
    sourceManifestSha256: sourcePackage.manifestSha256, targetManifestSha256: targetPackage.manifestSha256,
    sourceVersion: sourcePackage.appVersion, targetVersion: targetPackage.appVersion, createdAt, bundle };
}

function backupOf(p) {
  return { ok: true, providerId: 'postgresql-deploy-owned', recoveryScope: 'deploy-owned', fullRecovery: false,
    bundle: p.bundle, path: p.bundle, amuBackup: path.join(p.bundle, 'private/amu'), commitMarker: p.bundle + '.complete.json',
    sha256: p.manifestSha256, createdAt: p.createdAt };
}

function persist(file, value) {
  const parent = fs.lstatSync(ROOT);
  if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) || fs.realpathSync(ROOT) !== ROOT) fail('CORE_DRIVE_PROOF_DIRECTORY');
  const tmp = path.join(ROOT, '.core-drive-' + crypto.randomUUID());
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const dir = fs.openSync(ROOT, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { fs.rmSync(tmp, { force: true }); }
}

async function main([action, app, target, bundle, work, ...extra]) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(app || '') || extra.length) fail('CORE_DRIVE_ARGUMENTS');
  // This root-only pointer allows a failed upload to resume after updater staging is removed.
  // It is never accepted as evidence of an offsite recovery.
  if (action === 'remember') {
    const point = await pointContext(app, app, bundle, false);
    persist(PENDING, point);
    return point.manifestSha256;
  }
  if (action === 'resume') {
    const saved = JSON.parse(small(app, PENDING));
    const point = await pointContext(app, app, saved.bundle, false);
    if (JSON.stringify(saved) !== JSON.stringify(point)) fail('CORE_DRIVE_PENDING_CHANGED');
    return JSON.stringify({ backup: backupOf(point) });
  }
  if (action === 'select' || action === 'select-receipt') return snapshotId(JSON.parse(small(app, work)), target, bundle, action === 'select-receipt');
  if (action === 'prepare') return JSON.stringify(await pointContext(app, target, bundle, false));
  if (action === 'verify-files') {
    const saved = JSON.parse(small(app, path.join(work, 'context.json')));
    if (bundle !== saved.bundle || !SHA.test(saved.manifestSha256)) fail('CORE_DRIVE_POINT_PATH');
    await require(path.join(app, 'lib/persistence/postgresql/operations/paired-bundle')).verifyPairBundle(
      bundle, bundle + '.complete.json', { scope: 'deploy-owned', expectedSha256: saved.manifestSha256 });
    return;
  }
  if (!['seal','reusable','publish'].includes(action)) fail('CORE_DRIVE_ARGUMENTS');
  const ctx = await pointContext(app, target, bundle, false);
  if (JSON.stringify(ctx) !== JSON.stringify(JSON.parse(small(app, path.join(work, 'context.json'))))) fail('CORE_DRIVE_CONTEXT_CHANGED');
  const snapshot = small(app, path.join(work, 'snapshot'), 128).toString().trim();
  const fields = { ...ctx, snapshotId: snapshot };
  const receiptPath = path.join(work, 'receipt.json');
  if (action === 'reusable') {
    for (const file of [FILE, PENDING_RECEIPT]) {
      try { readSigned(app, ctx, ctx.configurationSha256, fields, file); }
      catch { continue; }
      fs.writeFileSync(receiptPath, small(app, file), { flag: 'wx', mode: 0o600 });
      return snapshot;
    }
    fail('CORE_DRIVE_RECEIPT_MISSING');
  }
  if (action === 'publish') {
    const downloaded = path.join(work, 'downloaded-receipt.json');
    readSigned(app, ctx, ctx.configurationSha256, fields, downloaded);
    const bytes = small(app, downloaded);
    if (!bytes.equals(small(app, receiptPath))) fail('CORE_DRIVE_RECEIPT');
    persist(FILE, JSON.parse(bytes));
    return snapshot;
  }
  const archive = small(app, path.join(work, 'archive.sha256'), 128).toString().trim();
  const expected = { ...ctx, snapshotId: snapshot, archiveSha256: archive };
  const bytes = small(app, path.join(work, 'restore.json'));
  const proof = { format: FORMAT, provider: 'google_drive', scope: 'deploy-owned', fullRecovery: false,
    ...expected, verifiedAt: JSON.parse(bytes).verifiedAt, restoreBytes: bytes.toString('base64'), restoreSha256: digest(bytes) };
  const privateKey = crypto.createPrivateKey(small(app, path.join(ROOT, 'signing-private.pem'), 4096));
  const envelope = { proof, signature: crypto.sign(null, signingBytes(proof), privateKey).toString('base64') };
  verifySigned(envelope, crypto.createPublicKey(small(app, path.join(ROOT, 'signing-public.pem'), 4096)),
    expected, Date.now(), policy(app).MAX_AGE_MS);
  persist(PENDING_RECEIPT, envelope);
  fs.writeFileSync(receiptPath, small(app, PENDING_RECEIPT), { flag: 'wx', mode: 0o600 });
  return readSigned(app, ctx, ctx.configurationSha256, expected, PENDING_RECEIPT).snapshotId;
}

if (require.main === module) main(process.argv.slice(2)).then(value => { if (value !== undefined) console.log(value); }).catch(error => {
  console.error(/^CORE_|^PG_|^DEPLOY_/.test(error.message) ? error.message : 'CORE_DRIVE_PROOF_FAILED');
  process.exitCode = 1;
});
module.exports = { FILE, verifySigned, readSigned, snapshotId, backupOf, signingBytes };

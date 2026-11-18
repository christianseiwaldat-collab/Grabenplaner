'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const legacy = require('./deploy-policy');
const FORMAT = 'grabenplaner-core-deploy-proof';
const PROOF_FILE = '/var/lib/grabenplaner-assurance/core-deploy-verification.json';
const SHA = /^[a-f0-9]{64}$/;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

function validateProof(proof, { installedManifest, candidateManifest, identity, configurationSha256, now = Date.now() }) {
  if (proof?.format !== FORMAT || proof.schemaVersion !== 1 || proof.scope !== 'deploy-owned'
      || !['sourceManifestSha256', 'targetManifestSha256', 'configurationSha256', 'databaseIdentitySha256',
        'schemaSha256', 'restoreSha256'].every(name => SHA.test(proof[name] || ''))) fail('CORE_DEPLOY_PROOF_INVALID');
  if (![proof.sourceManifestSha256, proof.targetManifestSha256].includes(installedManifest)
      || candidateManifest !== undefined && candidateManifest !== proof.targetManifestSha256) fail('CORE_DEPLOY_PACKAGE_BINDING');
  if (proof.configurationSha256 !== configurationSha256 || proof.databaseIdentitySha256 !== identity?.databaseIdentitySha256
      || proof.schemaSha256 !== identity?.schemaSha256) fail('CORE_DEPLOY_SOURCE_BINDING');
  const verified = Date.parse(proof.verifiedAt), captured = Date.parse(proof.backup?.createdAt);
  if (!Number.isFinite(now) || !Number.isFinite(verified) || !Number.isFinite(captured)
      || captured > verified || verified > now + 300000 || now - captured > legacy.MAX_AGE_MS) fail('CORE_DEPLOY_PROOF_STALE');
  if (proof.backup?.ok !== true || proof.backup.providerId !== 'postgresql-deploy-owned'
      || proof.backup.recoveryScope !== 'deploy-owned' || !SHA.test(proof.backup.sha256 || '')
      || typeof proof.restoreFile !== 'string') fail('CORE_DEPLOY_BACKUP_INVALID');
  return { verified: true, scope: 'deploy-owned', proof: proof.verifiedAt, backup: proof.backup,
    installedManifestSha256: installedManifest, candidateManifestSha256: candidateManifest ?? null };
}

function validateRestore(restore, backup, sourceVersion, targetVersion) {
  if (restore?.ok !== true || restore.providerId !== 'postgresql-deploy-owned' || restore.recoveryScope !== 'deploy-owned'
      || restore.fullRecovery !== false || restore.ownedApplicationSmoke !== true
      || restore.pairManifestSha256 !== backup.sha256 || restore.sourceAppVersion !== sourceVersion
      || restore.targetAppVersion !== targetVersion || !Number.isFinite(Date.parse(restore.verifiedAt))) fail('CORE_DEPLOY_RESTORE_BINDING');
}

function jsonFile(file, maximum = 2 * 1024 * 1024) {
  const bytes = legacy.readRegular(file, maximum, { rootOnly: true });
  return { bytes, value: JSON.parse(bytes) };
}

function validateOffsiteBasis(proof, history, identity, configurationSha256, now = Date.now()) {
  const at = Date.parse(proof?.verifiedAt);
  if (proof?.format !== legacy.FORMAT || !legacy.sameDatabaseIdentity(proof, identity) || proof.configurationSha256 !== configurationSha256
      || !Number.isFinite(at) || at > now + 300000 || now - at > legacy.MAX_AGE_MS || history?.ok !== true) fail('CORE_DEPLOY_OFFSITE_BASIS');
  const event = history.events?.find(item => item.sequence === proof.sequence && item.eventHash === proof.eventHash);
  if (event?.payload?.eventType !== 'full-assurance-passed' || event.payload.runId !== proof.runId
      || event.payload.occurredAt !== proof.verifiedAt || event.payload.evidence?.receiptSha256 !== proof.receiptSha256
      || !SHA.test(proof.receiptSha256 || '')) fail('CORE_DEPLOY_OFFSITE_BASIS');
  return { verifiedAt: proof.verifiedAt, receiptSha256: proof.receiptSha256, scope: 'full' };
}

function offsiteBasis(identity, configurationSha256) {
  const full = jsonFile('/var/lib/grabenplaner-assurance/deploy-verification.json').value;
  // The existing signed external recovery remains evidence of its own scope.
  // The new isolated Core restore supplies the current Core qualification.
  return validateOffsiteBasis(full, legacy.inspectedHistory(), identity, configurationSha256);
}

function backupPaths(backup, config) {
  const basename = path.basename(backup?.bundle || '');
  if (!/^[a-f0-9-]{36}\.owned$/.test(basename) || backup.bundle !== path.join(config.backupDirectory, basename)
      || backup.path !== backup.bundle || backup.commitMarker !== backup.bundle + '.complete.json'
      || backup.amuBackup !== backup.bundle + '/private/amu') fail('CORE_DEPLOY_BACKUP_PATH');
}

async function readProof(appRoot, candidateRoot, envFile) {
  const proof = jsonFile(PROOF_FILE).value;
  const runtime = require('../../../lib/persistence/postgresql/operations/runtime');
  const config = runtime.loadConfiguration('/etc/grabenplaner/postgresql-operations.json');
  backupPaths(proof.backup, config);
  const installed = legacy.applicationContract(appRoot);
  const candidate = candidateRoot ? legacy.applicationContract(candidateRoot) : null;
  const identity = await legacy.configuredDatabaseIdentity(config.sourceFiles + '/data/postgresql-pair.json', envFile);
  const evidence = validateProof(proof, { installedManifest: installed.manifestSha256,
    candidateManifest: candidate?.manifestSha256, identity, configurationSha256: legacy.configurationIdentity(envFile) });
  offsiteBasis(identity, proof.configurationSha256);
  const restore = jsonFile(proof.restoreFile);
  if (digest(restore.bytes) !== proof.restoreSha256) fail('CORE_DEPLOY_RESTORE_CHANGED');
  validateRestore(restore.value, proof.backup, proof.sourceVersion, proof.targetVersion);
  const bundle = await require('../../../lib/persistence/postgresql/operations/paired-bundle').verifyPairBundle(
    proof.backup.bundle, proof.backup.commitMarker, { scope: 'deploy-owned', expectedSha256: proof.backup.sha256, verifyContent: false });
  if (bundle.manifest.recovery.basis !== 'fresh-source-rebuild'
      || legacy.postgresqlPairIdentity(bundle.manifest.checkpoint.domains).databaseIdentitySha256 !== identity.databaseIdentitySha256) fail('CORE_DEPLOY_PAIR_BINDING');
  return { ...evidence, ownedRecovery: { verified: true, manifestSha256: proof.backup.sha256,
    verifiedAt: proof.verifiedAt, fullRecovery: false } };
}

async function recordProof(appRoot, candidateRoot, backupResultFile, restoreFile, envFile) {
  const backupResult = jsonFile(backupResultFile).value, restored = jsonFile(restoreFile);
  const source = legacy.applicationContract(appRoot), target = legacy.applicationContract(candidateRoot);
  validateRestore(restored.value, backupResult, source.appVersion, target.appVersion);
  const runtime = require('../../../lib/persistence/postgresql/operations/runtime');
  const config = runtime.loadConfiguration('/etc/grabenplaner/postgresql-operations.json');
  backupPaths(backupResult, config);
  const bundle = await require('../../../lib/persistence/postgresql/operations/paired-bundle').verifyPairBundle(
    backupResult.bundle, backupResult.commitMarker, { scope: 'deploy-owned', expectedSha256: backupResult.sha256 });
  const identity = legacy.postgresqlPairIdentity(bundle.manifest.checkpoint.domains);
  const live = await legacy.configuredDatabaseIdentity(config.sourceFiles + '/data/postgresql-pair.json', envFile);
  if (identity.databaseIdentitySha256 !== live.databaseIdentitySha256) fail('CORE_DEPLOY_PAIR_BINDING');
  const backup = Object.fromEntries(['ok', 'providerId', 'recoveryScope', 'fullRecovery', 'bundle', 'path', 'amuBackup',
    'commitMarker', 'sha256', 'createdAt'].map(name => [name, backupResult[name]]));
  const proof = { format: FORMAT, schemaVersion: 1, scope: 'deploy-owned',
    sourceManifestSha256: source.manifestSha256, targetManifestSha256: target.manifestSha256,
    sourceVersion: source.appVersion, targetVersion: target.appVersion, ...identity,
    configurationSha256: legacy.configurationIdentity(envFile), backup,
    restoreFile, restoreSha256: digest(restored.bytes), verifiedAt: restored.value.verifiedAt };
  proof.offsiteBasis = offsiteBasis(live, proof.configurationSha256);
  validateProof(proof, { installedManifest: source.manifestSha256, candidateManifest: target.manifestSha256,
    identity: live, configurationSha256: proof.configurationSha256 });
  const directory = path.dirname(PROOF_FILE), parent = fs.lstatSync(directory);
  if (!parent.isDirectory() || parent.uid !== 0 || parent.mode & 0o022 || fs.realpathSync(directory) !== directory) fail('CORE_DEPLOY_PROOF_DIRECTORY');
  const temporary = path.join(directory, '.core-deploy-' + crypto.randomUUID());
  fs.writeFileSync(temporary, JSON.stringify(proof) + '\n', { flag: 'wx', mode: 0o600 });
  const fd = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, PROOF_FILE);
  const parentFd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
  return { verified: true, scope: proof.scope, verifiedAt: proof.verifiedAt, manifestSha256: backup.sha256 };
}

async function checkBaseline(appRoot, envFile) {
  const installed = legacy.applicationContract(appRoot);
  const identity = await legacy.configuredDatabaseIdentity('/var/lib/grabenplaner/data/postgresql-pair.json', envFile);
  const checked = offsiteBasis(identity, legacy.configurationIdentity(envFile));
  return { verified: true, installedManifestSha256: installed.manifestSha256, offsiteBasis: checked };
}

async function main(args = process.argv.slice(2)) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) fail('CORE_DEPLOY_ROOT_REQUIRED');
  const [action, appRoot, candidateRoot, backupFile, restoreFile, ...extra] = args;
  const envFile = '/etc/grabenplaner/grabenplaner.env';
  if (action === 'baseline' && appRoot && !candidateRoot && !backupFile && !restoreFile && !extra.length) return checkBaseline(appRoot, envFile);
  if (action === 'inspect' && appRoot && !backupFile && !restoreFile && !extra.length) return readProof(appRoot, candidateRoot, envFile);
  if (action === 'record' && appRoot && candidateRoot && backupFile && restoreFile && !extra.length)
    return recordProof(appRoot, candidateRoot, backupFile, restoreFile, envFile);
  fail('CORE_DEPLOY_ARGUMENTS');
}

if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
  process.stderr.write(JSON.stringify({ failed: true, code: /^CORE_|^PG_|^DEPLOY_/.test(error.code || error.message)
    ? error.code || error.message : 'CORE_DEPLOY_PROOF_FAILED' }) + '\n');
  process.exitCode = 1;
});
module.exports = { FORMAT, PROOF_FILE, validateProof, validateRestore, validateOffsiteBasis, readProof, recordProof, main };

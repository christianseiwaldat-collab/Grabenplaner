'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const app = '/opt/grabenplaner/app';
const env = '/etc/grabenplaner/grabenplaner.env';
const config = '/etc/grabenplaner/offsite';
const offsite = '/var/lib/grabenplaner-offsite';
const stage = offsite + '/staging/current';
const receiptDir = offsite + '/restore-tests/receipts';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// inspectHistory has already authenticated every event and its ordering.
function matchingNightly(history, proof, snapshot, slot, now) {
  const last = history.events?.at(-1);
  const event = last?.payload;
  if (!history.ok || !/^[a-f0-9]{64}$/.test(snapshot.id) || event?.eventType !== 'full-assurance-passed'
      || event.trigger !== 'scheduled-nightly' || event.runId !== proof.runId || last.sequence !== proof.sequence
      || last.eventHash !== proof.eventHash || event.occurredAt !== proof.verifiedAt
      || !/^[a-f0-9]{64}$/.test(proof.receiptSha256) || event.evidence.receiptSha256 !== proof.receiptSha256
      || event.evidence.snapshotIdPrefix !== snapshot.id.slice(0, 12)) return false;
  const finished = new Date(event.occurredAt);
  // A timer occurrence is covered by this day's full rehearsal (possibly
  // finishing after the scheduled time). Yesterday's run cannot cover today.
  if (!Number.isSafeInteger(slot) || slot > now || !(finished <= now)
      || finished.toDateString() !== new Date(slot).toDateString()) return false;
  return ['restore-test-passed', 'application-smoke-passed'].every(type => history.events.some(({ payload }) =>
    payload.runId === event.runId && payload.trigger === event.trigger && payload.eventType === type
    && payload.evidence.receiptSha256 === proof.receiptSha256
    && payload.evidence.snapshotIdPrefix === event.evidence.snapshotIdPrefix
    && payload.evidence.appVersion === event.evidence.appVersion));
}

function matchingReceipt(bytes, proof, snapshot, version, repository, installation, manifestChangedAt) {
  if (hash(bytes) !== proof.receiptSha256) return false;
  const r = JSON.parse(bytes);
  return r.format === 'grabenplaner-offsite-restore-test' && r.schemaVersion === 2 && r.result === 'verified'
    && r.providerId === 'postgresql-pair' && Boolean(r.databases?.core && r.databases?.sales)
    && r.snapshotId === snapshot.id && r.snapshotTime === snapshot.time && r.targetAppVersion === version
    && r.repositoryBindingSha256 === hash(repository) && r.installationBindingSha256 === hash(installation)
    && r.sourcePathSha256 === hash(stage) && manifestChangedAt <= Date.parse(r.startedAt);
}

async function covered(selected, triggerUsec) {
  const policy = require(app + '/server-tools/linux/lib/deploy-policy.js');
  const read = (file, max = 16384) => policy.readRegular(file, max, { rootOnly: true });
  const snapshot = JSON.parse(read(selected));
  const proof = JSON.parse(read('/var/lib/grabenplaner-assurance/deploy-verification.json'));
  const history = policy.inspectedHistory();
  const now = Date.now();
  if (!matchingNightly(history, proof, snapshot, Math.trunc(Number(triggerUsec) / 1000), now)
      || now - Date.parse(proof.verifiedAt) > policy.MAX_AGE_MS) return false;
  const { readOffsiteBackupStatus } = require(app + '/lib/offsite-backup-status.js');
  const status = readOffsiteBackupStatus({ configured: true, requireRootOwner: true, statusPath: offsite + '/status.json' });
  if (!status.statusAvailable || status.state !== 'ok' || status.lastSnapshotId !== snapshot.id.slice(0, 12)
      || Object.values(status.unresolvedFailures).some(Boolean)) return false;

  const contract = policy.applicationContract(app);
  if (proof.format !== policy.FORMAT || proof.schemaVersion !== 3 || proof.policyId !== contract.policyId
      || proof.policyVersion !== contract.policyVersion || proof.inventoryPathsSha256 !== contract.inventoryPathsSha256
      || proof.contractSha256 !== contract.fingerprint || proof.configurationSha256 !== policy.configurationIdentity(env)
      || history.events.at(-1).payload.evidence.appVersion !== contract.appVersion) return false;
  const identity = await policy.configuredDatabaseIdentity(undefined, env);
  if (!policy.sameDatabaseIdentity(proof, identity)) return false;
  const repository = read(config + '/repository-id', 256).toString().trim();
  const installation = read(config + '/installation-id', 256).toString().trim();
  const manifestChangedAt = fs.statSync(app + '/grabenplaner-server-manifest.json').ctimeMs;
  const suffix = '-' + snapshot.id.slice(0, 12) + '.json';
  for (const name of fs.readdirSync(receiptDir)) {
    if (!/^restore-test-\d{8}T\d{6}Z-[a-f0-9]{12}\.json$/.test(name) || !name.endsWith(suffix)) continue;
    if (matchingReceipt(read(path.join(receiptDir, name)), proof, snapshot, contract.appVersion,
      repository, installation, manifestChangedAt)) {
      console.log(`Bereits durch den vollständigen Nachtlauf am ${proof.verifiedAt} geprüft. Snapshot ${snapshot.id}.`);
      return true;
    }
  }
  return false;
}

if (require.main === module) {
  covered(...process.argv.slice(2)).then(ok => { process.exitCode = ok ? 0 : 1; })
    .catch(() => { process.exitCode = 1; });
}
module.exports = { matchingNightly, matchingReceipt };

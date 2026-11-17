'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const legacy = require('../server-tools/linux/lib/deploy-policy');
const policy = require('../server-tools/linux/lib/deploy-owned-policy');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('fresh Access recovery requires one explicit canonical input directory and cannot silently select historical replay',t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'gp-fresh-arguments-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const parse=require('../server-tools/linux/lib/deploy-owned-recovery').parseArguments,base=[root,root,root,root];
 assert.equal(parse(base).option,undefined);assert.equal(parse([...base,'--rehydrate']).freshSourceDirectory,undefined);
 const fresh=parse([...base,'--fresh-access',root]);assert.equal(fresh.option,'--fresh-access');assert.equal(fresh.freshSourceDirectory,root);
 for(const rest of [['--fresh-access'],['--rehydrate',root],['--unknown'],['--fresh-access',root,'extra'],['--fresh-access','relative-path']]){
  assert.throws(()=>parse([...base,...rest]),/PG_DEPLOY_RECOVERY_ARGUMENTS/);
 }
 assert.throws(()=>parse(base.slice(0,3)),/PG_DEPLOY_RECOVERY_ARGUMENTS/);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-owned-policy-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true }); });
  const files = { 'server.js': 'server-business', 'package.json': JSON.stringify({ version: '1.0.0', dependencies: { pg: '8.22.0' }, scripts: { start: 'node server.js' } }),
    'pnpm-lock.yaml': 'locked-dependencies', 'lib/backup-maintenance.js': 'backup-lease', 'lib/auth.js': 'auth', 'lib/unfamiliar.js': 'unknown',
    'lib/absence-request-policy.js': 'absence', 'lib/planning-optimizer.js': 'planning', 'lib/personnel-learning-progress.js': 'learning',
    'lib/data-import-jobs.js': 'imports', 'lib/sales-report.js': 'sales', 'lib/cash-source-policies.js': 'cash', 'lib/trade-history.js': 'trade',
    'lib/persistence/repositories/employees.js': 'core-persistence', 'lib/persistence/postgresql/schema.js': 'schema',
    'lib/recovery-assurance-status.js': 'recovery', 'lib/feature-contract.js': 'contract', 'lib/new-migration.js': 'migration',
    'server-tools/linux/runtime-schema.json': 'runtime', 'server-tools/linux/offsite/module-schema.json': 'offsite',
    'server-tools/linux/lib/deploy-owned-policy.js': 'installed-chooser', 'public/app.js': 'screen' };
  function write(name, content) { const file = path.join(root, ...name.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  function seal() {
    const entries = Object.entries(files).map(([name, content]) => ({ path: name, bytes: Buffer.byteLength(content), sha256: hash(content) }));
    for (const [name, content] of Object.entries(files)) write(name, content);
    write('grabenplaner-server-manifest.json', JSON.stringify({ format: 'grabenplaner-server-package', schemaVersion: 1, appVersion: JSON.parse(files['package.json']).version, files: entries }));
    return policy.ownedApplicationContract(root);
  }
  return { root, files, write, seal };
}
function evidence(installed) {
  const verifiedAt = '2026-11-16T02:00:00.000Z', identity = { providerId: 'postgresql-pair', databaseIdentitySha256: hash('same-pair'), schemaSha256: hash('same-schema') };
  const proof = { format: legacy.FORMAT, schemaVersion: 3, policyVersion: legacy.POLICY_VERSION, policyId: legacy.POLICY_ID,
    inventoryPathsSha256: installed.inventoryPathsSha256, contractSha256: installed.fingerprint, ...identity, configurationSha256: hash('same-config'), verifiedAt,
    runId: 'synthetic-full-run', sequence: 1, eventHash: hash('verified-signed-event'), receiptSha256: hash('native-receipt-binding') };
  return { installed, candidate: installed, proof, identity, configurationSha256: proof.configurationSha256, now: Date.parse(verifiedAt) + 60000,
    timerActive: true, scheduledForMs: Date.parse(verifiedAt) + 24 * 3600000,
    history: { ok: true, events: [{ sequence: 1, eventHash: proof.eventHash, payload: { eventType: 'full-assurance-passed', runId: proof.runId, occurredAt: verifiedAt, evidence: { receiptSha256: proof.receiptSha256 } } }] } };
}

test('explicit owned choice permits existing GP business edits while automatic legacy policy stays full', t => {
  const app = fixture(t), value = evidence(app.seal());
  for (const name of ['server.js', 'lib/absence-request-policy.js', 'lib/planning-optimizer.js', 'lib/personnel-learning-progress.js', 'public/app.js']) app.files[name] += ' business fix';
  const metadata = JSON.parse(app.files['package.json']); metadata.version = '1.0.1'; app.files['package.json'] = JSON.stringify(metadata);
  value.candidate = app.seal();
  assert.notEqual(value.installed.fingerprint, value.candidate.fingerprint);
  assert.equal(value.installed.protectedFilesSha256, value.candidate.protectedFilesSha256);
  const decision = policy.evaluateOwnedDeploy(value); assert.equal(decision.mode, 'owned'); assert.equal(decision.classification, policy.OWNED_POLICY_ID);
  assert.equal(decision.protectedPolicySha256, policy.PROTECTED_POLICY_SHA256); assert.equal(decision.recoveryDeadline, '2026-11-17T05:00:00.000Z');
  assert.equal(legacy.evaluateDeploy(value).mode, 'full', 'opt-in classifier never changes the automatic choice');
  app.write('server.js', 'unsealed bytes'); assert.throws(() => policy.ownedApplicationContract(app.root), /DEPLOY_CONTRACT_CHANGED/);
});

test('Sales, import, persistence, schema, contract, migration, backup, recovery, dependencies and unknown paths force full', async t => {
  const changes = ['lib/data-import-jobs.js', 'lib/sales-report.js', 'lib/cash-source-policies.js', 'lib/trade-history.js', 'lib/auth.js', 'lib/unfamiliar.js',
    'lib/persistence/repositories/employees.js', 'lib/persistence/postgresql/schema.js', 'lib/feature-contract.js', 'lib/new-migration.js',
    'lib/backup-maintenance.js', 'lib/recovery-assurance-status.js', 'server-tools/linux/runtime-schema.json', 'server-tools/linux/lib/deploy-owned-policy.js', 'pnpm-lock.yaml'];
  for (const name of changes) await t.test(name, () => {
    const app = fixture(t), value = evidence(app.seal()); app.files[name] += ' changed'; value.candidate = app.seal();
    assert.equal(policy.evaluateOwnedDeploy(value).reason, 'OWNED_PROTECTED_CONTRACT_CHANGED');
  });
  for (const name of ['dependencies', 'scripts', 'engines']) await t.test('package ' + name, () => {
    const app = fixture(t), value = evidence(app.seal()), metadata = JSON.parse(app.files['package.json']); metadata[name] = { changed: 'runtime contract' }; app.files['package.json'] = JSON.stringify(metadata); value.candidate = app.seal();
    assert.equal(policy.evaluateOwnedDeploy(value).mode, 'full');
  });
});

test('new or removed inventory paths and the first classifier feature release require full qualification', async t => {
  for (const name of ['lib/new-business.js', 'public/new.js', 'server-tools/linux/lib/new-policy.js']) await t.test(name, () => {
    const app = fixture(t), value = evidence(app.seal()); app.files[name] = 'new feature'; value.candidate = app.seal(); assert.equal(policy.evaluateOwnedDeploy(value).reason, 'OWNED_INVENTORY_CHANGED');
  });
  const app = fixture(t), value = evidence(app.seal()); delete app.files['public/app.js']; value.candidate = app.seal(); assert.equal(policy.evaluateOwnedDeploy(value).mode, 'full');
  assert.equal(policy.evaluateOwnedDeploy({ ...value, installed: legacy.applicationContract(app.root) }).reason, 'OWNED_CLASSIFICATION_UNAVAILABLE');
});

test('owned choice retains every full-proof, pair, schema, configuration, history and deadline gate', async t => {
  const mutations = {
    expired: v => { v.now = Date.parse(v.proof.verifiedAt) + legacy.MAX_AGE_MS + 1; },
    futureProof: v => { v.now = Date.parse(v.proof.verifiedAt) - 1; },
    oldPolicy: v => { v.proof.schemaVersion = 2; },
    alteredPolicy: v => { v.proof.policyId = 'candidate-policy'; },
    wrongPair: v => { v.identity.databaseIdentitySha256 = hash('other-pair'); },
    wrongSchema: v => { v.identity.schemaSha256 = hash('other-schema'); },
    wrongConfig: v => { v.configurationSha256 = hash('changed-config'); },
    missingTimer: v => { v.timerActive = false; },
    missingSchedule: v => { delete v.scheduledForMs; },
    overdueSchedule: v => { v.scheduledForMs = v.now; },
    unverifiedHistory: v => { v.history.ok = false; },
    unknownReceipt: v => { v.proof.receiptSha256 = hash('other-receipt'); },
    wrongRun: v => { v.history.events[0].payload.runId = 'other-run'; },
    laterFailure: v => { v.history.events.push({ sequence: 2, payload: { eventType: 'full-assurance-failed' } }); },
    laterStarted: v => { v.history.events.push({ sequence: 2, payload: { eventType: 'full-assurance-started' } }); },
    configQueued: v => { v.history.events.push({ sequence: 2, payload: { eventType: 'configuration-change-queued' } }); },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
    const app = fixture(t), value = evidence(app.seal()); app.files['server.js'] += ' business fix'; value.candidate = app.seal(); mutate(value); assert.equal(policy.evaluateOwnedDeploy(value).mode, 'full');
  });
});

test('queued app updates retain their original full pass and fixed night deadline; repeated owned install falls back full', t => {
  const app = fixture(t), value = evidence(app.seal()), pass = value.history.events[0];
  const queue = { sequence: 2, eventHash: hash('first-queue'), payload: { eventType: 'update-queued', trigger: 'app-updated', occurredAt: new Date(value.now).toISOString() } };
  value.history.events.push(queue);
  value.queueSchedule = { format: 'grabenplaner-pending-recovery', schemaVersion: 1, queuedEventSequence: queue.sequence, queuedEventHash: queue.eventHash, queuedAt: queue.payload.occurredAt,
    scheduledFor: new Date(value.scheduledForMs).toISOString(), deadlineAt: new Date(value.scheduledForMs + 3 * 3600000).toISOString(), originalFullPassSequence: pass.sequence,
    originalFullPassEventHash: pass.eventHash, originalFullPassAt: pass.payload.occurredAt, recordedAt: queue.payload.occurredAt };
  app.files['server.js'] += ' fix'; value.candidate = app.seal(); assert.equal(policy.evaluateOwnedDeploy(value).mode, 'owned');
  assert.equal(policy.evaluateOwnedDeploy({ ...value, queueSchedule: undefined }).reason, 'RECOVERY_QUEUE_UNVERIFIED');
  const installedAfterFirstOwned = value.candidate;
  app.files['server.js'] += ' another fix'; const candidateAfterSecond = app.seal();
  assert.equal(policy.evaluateOwnedDeploy({ ...value, installed: installedAfterFirstOwned, candidate: candidateAfterSecond }).reason, 'VERIFICATION_BINDING_CHANGED');
});

test('classification identity covers explicit safe names and rejects overlapping critical or unfamiliar paths', () => {
  for (const name of ['server.js', 'public/app.js', 'lib/planning-optimizer.js']) assert.equal(policy.allowedBusinessPath(name), true);
  for (const name of ['lib/personnel-import.js', 'lib/planning-new.js', 'lib/persistence/planning.js', 'public/recovery.js', 'public/a/../app.js', '../server.js', 'server-tools/linux/anything.js']) assert.equal(policy.allowedBusinessPath(name), false);
  assert.match(policy.PROTECTED_POLICY_SHA256, /^[a-f0-9]{64}$/);
});

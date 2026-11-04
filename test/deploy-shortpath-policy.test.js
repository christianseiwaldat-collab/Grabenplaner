"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const policy = require("../server-tools/linux/lib/deploy-policy");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-shortpath-"));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true }); });
  const files = { "server.js": "server", "package.json": JSON.stringify({ version: "1.0.0", dependencies: {}, scripts: { start: "node server.js" } }),
    "pnpm-lock.yaml": "lock", "lib/backup-maintenance.js": "lease", "lib/auth.js": "auth", "lib/unfamiliar.js": "unknown",
    "lib/persistence/postgresql/schema.js": "schema", "server-tools/linux/runtime-schema.json": "runtime",
    "server-tools/linux/offsite/module-schema.json": "offsite", "public/app.js": "screen" };
  function write(name, contents) {
    const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents);
  }
  function seal() {
    const entries = Object.keys(files).map(name => ({ path: name, bytes: Buffer.byteLength(files[name]), sha256: hash(files[name]) }));
    for (const [name, content] of Object.entries(files)) write(name, content);
    write("grabenplaner-server-manifest.json", JSON.stringify({ format: "grabenplaner-server-package", schemaVersion: 1,
      appVersion: JSON.parse(files["package.json"]).version, files: entries }));
    return policy.applicationContract(root);
  }
  return { root, files, write, seal };
}
function evidence(contract) {
  const verifiedAt = "2026-10-28T02:00:00.000Z", receiptSha256 = hash("full native recovery receipt");
  const identity = { providerId: "postgresql-pair", databaseIdentitySha256: hash("pair"), schemaSha256: hash("schema") };
  const proof = { format: policy.FORMAT, schemaVersion: 3, policyVersion: policy.POLICY_VERSION, policyId: policy.POLICY_ID,
    inventoryPathsSha256: contract.inventoryPathsSha256, contractSha256: contract.fingerprint, ...identity,
    configurationSha256: hash("config"), verifiedAt, runId: crypto.randomUUID(), sequence: 1, eventHash: hash("signed event"), receiptSha256 };
  return { installed: contract, candidate: contract, proof, identity, configurationSha256: proof.configurationSha256,
    now: Date.parse(verifiedAt) + 60000, timerActive: true, scheduledForMs: Date.parse(verifiedAt) + 24 * 3600000,
    history: { ok: true, events: [{ sequence: 1, eventHash: proof.eventHash, payload: { eventType: "full-assurance-passed",
      runId: proof.runId, occurredAt: verifiedAt, evidence: { receiptSha256 } } }] } };
}
test("only existing public file edits and version changes qualify; each actual byte remains verified", t => {
  const app = fixture(t), installed = app.seal(), value = evidence(installed);
  app.files["public/app.js"] = "changed screen";
  app.files["package.json"] = JSON.stringify({ version: "1.0.1", dependencies: {}, scripts: { start: "node server.js" } });
  value.candidate = app.seal();
  assert.notEqual(value.candidate.manifestSha256, installed.manifestSha256);
  const decision = policy.evaluateDeploy(value);
  assert.equal(decision.mode, "short"); assert.equal(decision.policyId, policy.POLICY_ID);
  assert.equal(decision.recoveryDeadline, "2026-10-29T05:00:00.000Z");
  app.write("public/app.js", "undeclared change");
  assert.throws(() => policy.applicationContract(app.root), /DEPLOY_CONTRACT_CHANGED/);
});
test("unknown backend, startup, auth, dependency, scripts, migration and policy changes require full recovery", async t => {
  const changes = {
    unknown: f => { f["lib/unfamiliar.js"] += " changed"; }, auth: f => { f["lib/auth.js"] += " changed"; },
    startup: f => { f["server.js"] += " changed"; }, schema: f => { f["lib/persistence/postgresql/schema.js"] += " changed"; },
    backup: f => { f["lib/backup-maintenance.js"] += " changed"; },
    dependency: f => { const v = JSON.parse(f["package.json"]); v.dependencies.pg = "8.99.0"; f["package.json"] = JSON.stringify(v); },
    lifecycle: f => { const v = JSON.parse(f["package.json"]); v.scripts.start = "node alternate.js"; f["package.json"] = JSON.stringify(v); },
    newPublicFile: f => { f["public/new.js"] = "new"; }, deletedPublicFile: f => { delete f["public/app.js"]; },
  };
  for (const [name, mutate] of Object.entries(changes)) await t.test(name, () => {
    const app = fixture(t), value = evidence(app.seal()); mutate(app.files); value.candidate = app.seal();
    assert.equal(policy.evaluateDeploy(value).mode, "full");
  });
});
test("old or forged proof cannot bootstrap the new installed policy; queued changes do not renew its lifetime", t => {
  const app = fixture(t), value = evidence(app.seal());
  value.proof.schemaVersion = 2; assert.equal(policy.evaluateDeploy(value).reason, "POLICY_BOOTSTRAP_REQUIRED");
  value.proof.schemaVersion = 3; value.proof.policyId = "candidate-says-safe";
  assert.equal(policy.evaluateDeploy(value).mode, "full"); value.proof.policyId = policy.POLICY_ID;
  value.history.events.push({ sequence: 2, payload: { eventType: "update-queued", trigger: "app-updated", occurredAt: "2026-10-29T13:00:00Z" } });
  value.now = Date.parse(value.proof.verifiedAt) + policy.MAX_AGE_MS + 1;
  assert.equal(policy.evaluateDeploy(value).reason, "VERIFICATION_EXPIRED");
  value.now = Date.parse(value.proof.verifiedAt) + 60000; value.history.ok = false;
  assert.equal(policy.evaluateDeploy(value).reason, "HISTORY_UNVERIFIED");
});
test("linked files and parent directories cannot supply contract bytes", t => {
  if (process.platform === "win32") return; // Native Linux run exercises both cases.
  const app = fixture(t); app.seal(); const target = path.join(app.root, "public/app.js");
  fs.renameSync(target, target + ".saved"); fs.symlinkSync(target + ".saved", target);
  assert.throws(() => policy.applicationContract(app.root), /DEPLOY_CONTRACT_CHANGED/);
  fs.unlinkSync(target); fs.renameSync(target + ".saved", target);
  fs.renameSync(path.join(app.root, "public"), path.join(app.root, "elsewhere"));
  fs.symlinkSync("elsewhere", path.join(app.root, "public"));
  assert.throws(() => policy.applicationContract(app.root), /DEPLOY_DIRECTORY_INVALID/);
});
test("a later signed queue cannot replace the earliest outstanding deadline", t => {
  const app = fixture(t), value = evidence(app.seal()), pass = value.history.events[0];
  for (const sequence of [2, 3]) value.history.events.push({ sequence, eventHash: hash("queue" + sequence), payload: {
    eventType: "update-queued", trigger: "app-updated", occurredAt: new Date(Date.parse(value.proof.verifiedAt) + sequence * 60000).toISOString() } });
  const queue = value.history.events[1]; value.now += 5 * 60000;
  const document = { format: "grabenplaner-pending-recovery", schemaVersion: 1, queuedEventSequence: queue.sequence,
    queuedEventHash: queue.eventHash, queuedAt: queue.payload.occurredAt,
    scheduledFor: new Date(value.scheduledForMs).toISOString(), deadlineAt: new Date(value.scheduledForMs + 3 * 3600000).toISOString(),
    originalFullPassSequence: 1, originalFullPassEventHash: pass.eventHash, originalFullPassAt: pass.payload.occurredAt,
    recordedAt: queue.payload.occurredAt };
  assert.equal(policy.evaluateDeploy({ ...value, queueSchedule: document }).mode, "short");
  const later = value.history.events[2];
  assert.equal(policy.evaluateDeploy({ ...value, queueSchedule: { ...document, queuedEventSequence: later.sequence,
    queuedEventHash: later.eventHash, queuedAt: later.payload.occurredAt, recordedAt: later.payload.occurredAt } }).reason, "RECOVERY_QUEUE_BINDING_CHANGED");
  assert.equal(policy.evaluateDeploy({ ...value, queueSchedule: undefined }).reason, "RECOVERY_QUEUE_UNVERIFIED");
  assert.equal(policy.evaluateDeploy({ ...value, scheduledForMs: value.now }).reason, "RECOVERY_SCHEDULE_UNAVAILABLE");
});

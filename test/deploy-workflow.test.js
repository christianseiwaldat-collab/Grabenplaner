"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { openSqliteLegacyDatabase: DatabaseSync } = require("../lib/persistence/sqlite/provider");
const policy = require("../server-tools/linux/lib/deploy-policy");
const deferred = require("../server-tools/linux/lib/deferred-backups");
const { inspectBackupMetadata } = require("../server-tools/linux/lib/backup-metadata");
const { sha256File } = require("../lib/file-integrity");
const root = path.resolve(__dirname, "..");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-deploy-workflow-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function evidence() {
  const verifiedAt = "2026-09-11T02:00:00.000Z", runId = crypto.randomUUID(), fingerprint = hash("contract");
  const proof = { format: policy.FORMAT, schemaVersion: 1, contractSha256: fingerprint,
    databasePath: "/synthetic/dienstplan.db", schemaSha256: hash("schema"), configurationSha256: hash("configuration"),
    verifiedAt, runId, sequence: 7, eventHash: hash("event"), receiptSha256: hash("receipt") };
  const event = { sequence: 7, eventHash: proof.eventHash, payload: { eventType: "full-assurance-passed", runId,
    occurredAt: verifiedAt, evidence: { receiptSha256: proof.receiptSha256 } } };
  return { installed: { fingerprint }, candidate: { fingerprint }, proof,
    history: { ok: true, events: [event] }, identity: { databasePath: proof.databasePath, schemaSha256: proof.schemaSha256 },
    configurationSha256: proof.configurationSha256, now: Date.parse(verifiedAt) + 3600000, timerActive: true };
}

test("short deploy needs a fresh full recovery proof and permits ordinary updates until the next night", () => {
  const value = evidence();
  assert.equal(policy.evaluateDeploy(value).mode, "short");
  value.history.events.push({ sequence: 8, payload: { eventType: "update-queued", trigger: "app-updated" } });
  assert.equal(policy.evaluateDeploy(value).mode, "short");
  value.now = Date.parse(value.proof.verifiedAt) + policy.MAX_AGE_MS;
  assert.equal(policy.evaluateDeploy(value).mode, "short");
  value.now += 1;
  assert.equal(policy.evaluateDeploy(value).reason, "VERIFICATION_EXPIRED");
});

test("missing, stale, changed or failed recovery evidence falls back to the full workflow", async t => {
  const cases = {
    "schema migration": value => { value.identity.schemaSha256 = hash("new schema"); },
    "recovery code": value => { value.candidate.fingerprint = hash("new code"); },
    "other database": value => { value.identity.databasePath = "/other/database.db"; },
    "configuration": value => { value.configurationSha256 = hash("other configuration"); },
    "missing proof": value => { value.proof = null; },
    "future proof": value => { value.now = Date.parse(value.proof.verifiedAt) - 1; },
    "missing timer": value => { value.timerActive = false; },
    "unverified history": value => { value.history.ok = false; },
    "changed signature binding": value => { value.history.events[0].eventHash = hash("other event"); },
    "data restore without application start": value => { value.history.events[0].payload.eventType = "restore-test-passed"; },
    "failed follow-up": value => { value.history.events.push({ sequence: 8, payload: { eventType: "full-assurance-failed" } }); },
    "unfinished follow-up": value => { value.history.events.push({ sequence: 8, payload: { eventType: "full-assurance-started" } }); },
    "changed server": value => { value.history.events.push({ sequence: 8, payload: { eventType: "update-queued", trigger: "server-updated" } }); },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => {
    const value = evidence(); mutate(value); assert.equal(policy.evaluateDeploy(value).mode, "full");
  });
});

function packageFixture(directory, { version = "0.92.37-beta", screen = "screen one", schema = "schema one" } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const files = { "package.json": JSON.stringify({ version, engines: { node: ">=22.13" }, dependencies: {}, packageManager: "pnpm@11.7.0" }),
    "server.js": "server", "pnpm-lock.yaml": "lock", "lib/backup-maintenance.js": "lease",
    "server-tools/linux/runtime-schema.json": "runtime", "server-tools/linux/offsite/module-schema.json": "offsite",
    "lib/persistence/sqlite/operations/schema.js": schema, "public/app.js": screen };
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true }); fs.writeFileSync(path.join(directory, relative), content);
  }
  const entries = Object.keys(files).map(relative => ({ path: relative, bytes: fs.statSync(path.join(directory, relative)).size, sha256: sha256File(path.join(directory, relative)) }));
  fs.writeFileSync(path.join(directory, "grabenplaner-server-manifest.json"), JSON.stringify({ format: "grabenplaner-server-package", schemaVersion: 1, appVersion: version, files: entries }));
}
test("actual package contracts distinguish interface updates from schema, dependency and startup changes", t => {
  const directory = temporary(t), old = path.join(directory, "old"), candidate = path.join(directory, "candidate");
  packageFixture(old); packageFixture(candidate, { version: "0.92.38-beta", screen: "new screen" });
  assert.equal(policy.applicationContract(old).fingerprint, policy.applicationContract(candidate).fingerprint);
  packageFixture(candidate, { schema: "changed migration" });
  assert.notEqual(policy.applicationContract(old).fingerprint, policy.applicationContract(candidate).fingerprint);
  fs.writeFileSync(path.join(candidate, "server.js"), "tampered server");
  assert.throws(() => policy.applicationContract(candidate), /DEPLOY_CONTRACT_CHANGED/);
});
test("source binding survives ordinary data writes but changes when a migration changes the schema", t => {
  const file = path.join(temporary(t), "live.db"), db = new DatabaseSync(file);
  db.exec("CREATE TABLE schema_migrations(id TEXT PRIMARY KEY); CREATE TABLE sales(amount INTEGER); INSERT INTO schema_migrations VALUES('base')");
  const before = policy.databaseIdentity(file);
  db.exec("INSERT INTO sales VALUES(100)");
  assert.deepEqual(policy.databaseIdentity(file), before);
  db.exec("ALTER TABLE sales ADD COLUMN note TEXT");
  assert.notEqual(policy.databaseIdentity(file).schemaSha256, before.schemaSha256);
  db.close();
});

function pair(directory, day = 11) {
  const snapshot = `dienstplan-2026-09-${day}T02-00-00-000Z-abc123def456`;
  const database = path.join(directory, `${snapshot}.db`), documents = path.join(directory, `${snapshot}.amu`), marker = path.join(directory, `${snapshot}.complete.json`);
  fs.mkdirSync(documents, { recursive: true });
  const db = new DatabaseSync(database); db.exec("CREATE TABLE synthetic(id INTEGER)"); db.close();
  const manifest = JSON.stringify({ database: { fileName: path.basename(database), sha256: sha256File(database) }, files: [] });
  fs.writeFileSync(path.join(documents, "manifest.json"), manifest);
  const committedAt = `2026-09-${day}T02:00:00.000Z`;
  const value = { format: "grabenplaner-backup-commit", schemaVersion: 1, snapshot, committedAt,
    database: { fileName: path.basename(database), sha256: sha256File(database), bytes: fs.statSync(database).size },
    protectedDocuments: { directoryName: path.basename(documents), files: 0, manifestFileName: "manifest.json", manifestSha256: hash(manifest), manifestBytes: Buffer.byteLength(manifest) },
    verification: { status: "verified", verifiedAt: committedAt } };
  fs.writeFileSync(marker, JSON.stringify(value));
  return { snapshot, database, documents, marker };
}
test("periodic backup probe reports metadata scope and rejects a mismatched coupled pair", t => {
  const directory = temporary(t), value = pair(directory), options = { now: Date.parse("2026-09-11T04:00:00Z") };
  assert.equal(inspectBackupMetadata(value.database, value.documents, value.marker, options).verification, "metadata-only");
  const original = fs.readFileSync(value.marker);
  const changed = JSON.parse(original); changed.database.bytes++;
  fs.writeFileSync(value.marker, JSON.stringify(changed));
  assert.throws(() => inspectBackupMetadata(value.database, value.documents, value.marker, options), /BACKUP_METADATA_MISMATCH/);
  fs.writeFileSync(value.marker, original);
  fs.writeFileSync(path.join(value.documents, "manifest.json"), "{}");
  assert.throws(() => inspectBackupMetadata(value.database, value.documents, value.marker, options), /BACKUP_METADATA_MISMATCH/);
});
test("deferred archive resumes after interruption and preserves unknown old raw backups", t => {
  const dataRoot = temporary(t), backupDirectory = path.join(dataRoot, "backups"), options = { requireRoot: false };
  const old = pair(backupDirectory, 10), first = pair(backupDirectory, 11), second = pair(backupDirectory, 12);
  deferred.register({ dataRoot, backupDirectory, snapshot: first.snapshot }, options);
  deferred.register({ dataRoot, backupDirectory, snapshot: second.snapshot }, options);
  assert.equal(deferred.register({ dataRoot, backupDirectory, snapshot: first.snapshot }, options).pending, 2);
  const processed = [];
  assert.throws(() => deferred.drain({ dataRoot, backupDirectory, user: "fixture", archiveEnabled: true }, { ...options,
    archive(snapshot) { if (snapshot === second.snapshot) throw new Error("interrupted"); processed.push(snapshot); } }), /interrupted/);
  assert.deepEqual(processed, [first.snapshot]);
  assert.equal(deferred.pendingRecords(dataRoot, backupDirectory, options).length, 1);
  const result = deferred.drain({ dataRoot, backupDirectory, user: "fixture", archiveEnabled: true }, { ...options, archive: snapshot => processed.push(snapshot) });
  assert.equal(result.pending, 0); assert.deepEqual(processed, [first.snapshot, second.snapshot]);
  for (const item of [old, first, second]) assert.ok(fs.existsSync(item.database));
});
test("changed deferred receipts fail before archiving or deleting any point", t => {
  const dataRoot = temporary(t), backupDirectory = path.join(dataRoot, "backups"), options = { requireRoot: false };
  const item = pair(backupDirectory);
  deferred.register({ dataRoot, backupDirectory, snapshot: item.snapshot }, options);
  fs.appendFileSync(item.marker, " ");
  let called = false;
  assert.throws(() => deferred.drain({ dataRoot, backupDirectory, user: "fixture", archiveEnabled: true }, { ...options, archive: () => { called = true; } }), /DEFERRED_MARKER_CHANGED/);
  assert.equal(called, false); assert.ok(fs.existsSync(item.database));
});
test("changed Linux scripts remain valid Bash and short/nightly probes use separate labels", { skip: !fs.existsSync(bash) }, () => {
  for (const relative of ["lib/common.sh", "update-grabenplaner-server.sh", "backup-grabenplaner.sh", "test-grabenplaner-server.sh",
    "offsite/lib/offsite-common.sh", "offsite/grabenplaner-offsite-prepare.sh", "offsite/grabenplaner-offsite-assurance.sh", "offsite/install-grabenplaner-offsite.sh"]) {
    const source = fs.readFileSync(path.join(root, "server-tools/linux", relative), "utf8").replace(/\r\n/g, "\n");
    const result = spawnSync(bash, ["--noprofile", "--norc", "-n"], { input: source, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, `${relative}: ${result.stderr}`);
  }
});

test("deploy accepts a pending first full proof only with fresh successful external backup checks", t => {
  const directory = temporary(t);
  const source = fs.readFileSync(path.join(root, "server-tools/linux/test-grabenplaner-server.sh"), "utf8").replace(/\r\n/g, "\n");
  const begin = source.indexOf("const [readerPath, statusPath, deployChecks]");
  assert.ok(begin > 0);
  const code = source.slice(begin, source.indexOf("\nNODE", begin));
  const reader = path.join(directory, "reader.cjs"), status = path.join(directory, "status.json");
  fs.writeFileSync(reader, 'exports.readOffsiteBackupStatus=({statusPath})=>JSON.parse(require("node:fs").readFileSync(statusPath));');
  const pending = { statusAvailable: true, blocksMainReadiness: false, state: "warning",
    agesHours: { backup: 0.5, repositoryCheck: 0.5 }, unresolvedFailures: { backup: false, fullCheck: false, restoreTest: false } };
  function probe(value, mode = "1") {
    fs.writeFileSync(status, JSON.stringify(value));
    return spawnSync(process.execPath, ["-", reader, status, mode], { input: code, encoding: "utf8", timeout: 10000 });
  }
  const initial = probe(pending);
  assert.equal(initial.status, 0, initial.stderr);
  assert.equal(initial.stdout, "pending-full-verification");
  assert.notEqual(probe(pending, "0").status, 0, "monitor must still flag the missing full proof");
  assert.equal(probe({ ...pending, state: "ok" }, "0").stdout, "complete");
  for (const field of ["backup", "repositoryCheck"]) for (const age of [null, -1, 36.01]) {
    assert.notEqual(probe({ ...pending, agesHours: { ...pending.agesHours, [field]: age } }).status, 0);
  }
  for (const field of ["backup", "fullCheck", "restoreTest"]) {
    assert.notEqual(probe({ ...pending, unresolvedFailures: { ...pending.unresolvedFailures, [field]: true } }).status, 0);
  }
  for (const delta of [{ statusAvailable: false }, { blocksMainReadiness: true }, { state: "error" }]) {
    assert.notEqual(probe({ ...pending, ...delta }).status, 0);
  }
});

test("only an isolated current restore failure selects a real pre-commit recovery recheck", t => {
  const directory=temporary(t);
  const source=fs.readFileSync(path.join(root,"server-tools/linux/test-grabenplaner-server.sh"),"utf8").replace(/\r\n/g,"\n");
  const begin=source.indexOf('const [restoreReaderPath, restoreStatusPath]');assert.ok(begin>0);
  const code=source.slice(begin,source.indexOf('\nNODE',begin));
  const reader=path.join(directory,'reader.cjs'),status=path.join(directory,'status.json');
  fs.writeFileSync(reader,'exports.readOffsiteBackupStatus=({statusPath,requireRootOwner})=>{if(requireRootOwner!==true)throw Error();return JSON.parse(require("node:fs").readFileSync(statusPath));};');
  const failure={statusAvailable:true,blocksMainReadiness:false,state:'error',agesHours:{backup:0.1,repositoryCheck:1},unresolvedFailures:{backup:false,fullCheck:false,restoreTest:true}};
  function probe(value){fs.writeFileSync(status,JSON.stringify(value));const r=spawnSync(process.execPath,['-',reader,status],{input:code,encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout;}
  assert.equal(probe(failure),'restore-required');
  for(const delta of [{statusAvailable:false},{blocksMainReadiness:true},{state:'ok'},{state:'warning'},{unresolvedFailures:{backup:true,fullCheck:false,restoreTest:true}},{unresolvedFailures:{backup:false,fullCheck:true,restoreTest:true}},{unresolvedFailures:{backup:false,fullCheck:false,restoreTest:false}}])assert.equal(probe({...failure,...delta}),'none');
  for(const field of ['backup','repositoryCheck'])for(const age of [null,-1,36.01])assert.equal(probe({...failure,agesHours:{...failure.agesHours,[field]:age}}),'none');
  const shell=source.slice(source.indexOf('# A recovery fix'),source.indexOf('  offsite_status_current=0'));
  assert.match(shell,/deploy_checks == 1 && failures == 0 && offsite_timer_ok == 1/);
  assert.match(shell,/maintenance\.lock/);assert.match(shell,/flock --nonblock 9/);
  assert.match(shell,/if "\$offsite_restore_command"; then/);
  assert.doesNotMatch(shell,/offsite_status restore-test|reset-failed|restoreTest\s*=\s*false/);
});

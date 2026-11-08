"use strict";
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const uploadFile = path.join(root, "server-tools/linux/offsite/grabenplaner-offsite-upload.sh");
const source = fs.readFileSync(uploadFile, "utf8").replace(/\r\n/g, "\n");
const helperSection = source.split("# BEGIN_UPLOAD_EVIDENCE_HELPERS\n")[1].split("# END_UPLOAD_EVIDENCE_HELPERS")[0];
const helperCode = helperSection.split("<<'NODE'\n")[1].split("\nNODE\n")[0];
const snapshot = "a".repeat(64), host = "grabenplaner-" + "b".repeat(32);
const stage = "/var/lib/grabenplaner-offsite/staging/current";
const item = { id: snapshot, hostname: host, paths: [stage], tags: ["grabenplaner-offsite", "daily"], time: "2026-11-08T03:23:19+01:00" };

function fixture(t, result = { status: 0, stdout: JSON.stringify([item]), stderr: "" }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gp-upload-confirm-"));
  fs.chmodSync(base, 0o700);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const operation = path.join(base, ".upload.ABCdef12");
  fs.mkdirSync(operation, { mode: 0o700 });
  const calls = [];
  // Pure helper tests model the root-owned upload context. Real ownership and
  // subprocess behaviour are exercised separately by the root Linux cases.
  const fixtureFs = { ...fs, lstatSync(file) { const st = fs.lstatSync(file); st.uid = 0; return st; } };
  const context = { GP_OFFSITE_HELPER_TEST: true, module: { exports: {} }, Buffer,
    process: { platform: process.platform },
    require(name) {
      if (name === "node:fs") return fixtureFs;
      if (name === "node:child_process") return { spawnSync(...args) { calls.push(args); return { ...result }; } };
      return require(name);
    } };
  vm.runInNewContext(helperCode, context, { filename: uploadFile });
  const api = context.module.exports;
  return { base, operation, calls, api,
    confirm(attempt = 1) { return api.confirmSnapshot(["/verified/offsite-common.sh", "/private/credentials", snapshot, host, stage, operation, String(attempt)]); },
    retain(phase = "snapshot-confirmation") { return api.retainFailure([base, operation, phase, "SNAPSHOT_VERIFY_FAILED", "1", snapshot, "3"]); } };
}

test("exact uploaded snapshot requires its full ID and host/path/tag binding", (t) => {
  const f = fixture(t);
  assert.equal(f.confirm(), 0);
  assert.equal(f.calls.length, 1);
  const [binary, args, options] = f.calls[0];
  assert.equal(binary, "/usr/bin/timeout");
  assert.deepEqual(Array.from(args.slice(0, 4)), ["--signal=TERM", "--kill-after=5s", "120s", "/bin/bash"]);
  assert.equal(args.at(-1), snapshot);
  assert.match(args[5], /snapshots --json/);
  assert.doesNotMatch(args[5], /\bbackup\b/);
  assert.equal(options.timeout, 130000);
  assert.equal(options.maxBuffer, 1024 * 1024);
  const result = JSON.parse(fs.readFileSync(path.join(f.operation, "snapshot-confirm-1.result.json")));
  assert.equal(result.state, "confirmed");
});

test("only temporary absence is retriable among successfully returned snapshot lists", async (t) => {
  await t.test("temporary empty list", (t) => assert.equal(fixture(t, { status: 0, stdout: "[]" }).confirm(), 75));
  for (const [name, response] of [
    ["different full ID", [{ ...item, id: "c".repeat(64) }]],
    ["different host", [{ ...item, hostname: "grabenplaner-" + "c".repeat(32) }]],
    ["different path", [{ ...item, paths: ["/wrong/path"] }]],
    ["missing tag", [{ ...item, tags: ["daily"] }]],
    ["multiple snapshots", [item, item]],
    ["invalid shape", { snapshots: [item] }],
  ]) await t.test(name, (t) => assert.equal(fixture(t, { status: 0, stdout: JSON.stringify(response) }).confirm(), 1));
  await t.test("malformed JSON", (t) => assert.equal(fixture(t, { status: 0, stdout: "not json" }).confirm(), 1));
});

test("transport timeouts and rate limits may retry; authentication and unknown failures stop", async (t) => {
  for (const [name, status, stderr, expected] of [
    ["deadline", 1, "context deadline exceeded", 75],
    ["provider throttling", 1, "HTTP status 429 Too Many Requests", 75],
    ["Google Drive rate limit", 1, "googleapi: Error 403: userRateLimitExceeded", 75],
    ["provider unavailable", 1, "HTTP response 503 unavailable", 75],
    ["connect timeout", 124, "", 75],
    ["forbidden despite timeout words", 1, "403 Forbidden; connection timeout", 1],
    ["wrong password", 12, "wrong password", 1],
    ["missing repository", 10, "repository not found", 1],
    ["unknown failure", 1, "unclassified problem", 1],
  ]) await t.test(name, (t) => assert.equal(fixture(t, { status, stderr }).confirm(), expected));
  await t.test("response limit", (t) => assert.equal(fixture(t, { status: null, error: { code: "ENOBUFS" }, stderr: "timeout" }).confirm(), 1));
});

test("confirmation diagnostics redact credential-like lines before writing files", (t) => {
  const secret = "never-retain-this-token";
  const f = fixture(t, { status: 1, stderr: `Authorization: Bearer ${secret}\nHTTP response 503 unavailable\n` });
  assert.equal(f.confirm(), 75);
  const text = fs.readFileSync(path.join(f.operation, "snapshot-confirm-1.error"), "utf8");
  assert.doesNotMatch(text, new RegExp(secret));
  assert.match(text, /503/);
});

test("failed upload evidence is private, allowlisted, bounded and sanitized", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.operation, "backup.error"), "password=private-value\nHTTP response 503\n");
  fs.writeFileSync(path.join(f.operation, "backup.jsonl"), "x".repeat(400 * 1024));
  fs.writeFileSync(path.join(f.operation, "restic-password"), "credential-contents-must-never-be-read");
  assert.equal(f.retain(), 0);
  const evidenceRoot = path.join(f.base, "upload-failures");
  const names = fs.readdirSync(evidenceRoot);
  assert.equal(names.length, 1);
  const text = fs.readFileSync(path.join(evidenceRoot, names[0]), "utf8"), evidence = JSON.parse(text);
  assert.equal(evidence.snapshotId, snapshot);
  assert.equal(evidence.phase, "snapshot-confirmation");
  assert.equal(evidence.confirmationAttempts, 3);
  assert.equal(evidence.files.length, 2);
  assert.doesNotMatch(text, /private-value|credential-contents-must-never-be-read/);
  assert.match(text, /HTTP response 503/);
  assert.equal(evidence.files.find((f) => f.name === "backup.jsonl").truncated, true);
  assert.ok(Buffer.byteLength(evidence.files.find((f) => f.name === "backup.jsonl").text) <= 256 * 1024);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(evidenceRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(evidenceRoot, names[0])).mode & 0o777, 0o600);
  }
});

test("retention removes only own valid older records and keeps a bounded count", (t) => {
  const f = fixture(t), dir = path.join(f.base, "upload-failures");
  fs.mkdirSync(dir, { mode: 0o700 });
  for (let i = 0; i < 25; i++) {
    const date = new Date(Date.now() - (i + 1) * 86400000).toISOString();
    const name = `failure-${date.replace(/[-:.]/g, "")}-${crypto.randomUUID()}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ format: "grabenplaner-offsite-upload-failure", schemaVersion: 1, createdAt: date }), { mode: 0o600 });
  }
  const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
  const expired = `failure-${oldDate.replace(/[-:.]/g, "")}-${crypto.randomUUID()}.json`;
  fs.writeFileSync(path.join(dir, expired), JSON.stringify({ format: "grabenplaner-offsite-upload-failure", schemaVersion: 1, createdAt: oldDate }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "foreign-diagnostic.json"), "keep unrelated data", { mode: 0o600 });
  f.retain();
  assert.equal(fs.existsSync(path.join(dir, expired)), false);
  assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("failure-")).length, 20);
  assert.equal(fs.readFileSync(path.join(dir, "foreign-diagnostic.json"), "utf8"), "keep unrelated data");
});

test("retained diagnostics reject hardlinks instead of copying another protected file", (t) => {
  const f = fixture(t), protectedFile = path.join(f.base, "protected-secret");
  fs.writeFileSync(protectedFile, "protected content");
  fs.linkSync(protectedFile, path.join(f.operation, "backup.error"));
  assert.throws(() => f.retain(), /unsafe diagnostic/);
  assert.equal(fs.readFileSync(protectedFile, "utf8"), "protected content");
  assert.equal(fs.existsSync(path.join(f.base, "upload-failures")) && fs.readdirSync(path.join(f.base, "upload-failures")).length, 0);
});

test("an unrecognized operation path cannot be retained as upload evidence", (t) => {
  const f = fixture(t), other = path.join(f.base, "not-an-upload");
  fs.mkdirSync(other, { mode: 0o700 });
  assert.throws(() => f.api.retainFailure([f.base, other, "backup", "UPLOAD_FAILED", "1", "", "0"]), /unexpected operation root/);
});

test("successful uploads also expire old private failure records without creating an empty archive", (t) => {
  const f = fixture(t);
  assert.equal(f.api.pruneEvidence(f.base), 0);
  const dir = path.join(f.base, "upload-failures");
  assert.equal(fs.existsSync(dir), false);
  fs.mkdirSync(dir, { mode: 0o700 });
  const date = new Date(Date.now() - 40 * 86400000).toISOString();
  const file = path.join(dir, `failure-${date.replace(/[-:.]/g, "")}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ format: "grabenplaner-offsite-upload-failure", schemaVersion: 1, createdAt: date }), { mode: 0o600 });
  assert.equal(f.api.pruneEvidence(f.base), 0);
  assert.equal(fs.existsSync(file), false);
});

const linuxRoot = process.platform === "linux" && process.getuid() === 0;
function shellFixture(t, mode) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gp-upload-shell-"));
  fs.chmodSync(base, 0o700);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const operation = path.join(base, ".upload.ABCdef12"), lib = path.join(base, "lib");
  fs.mkdirSync(operation, { mode: 0o700 });fs.mkdirSync(lib);
  const calls = path.join(base, "calls"), counter = path.join(base, "counter");
  const good = JSON.stringify([item]), bad = JSON.stringify([{ ...item, id: "c".repeat(64) }]);
  const common = `offsite_restic(){
 printf '%s\\n' "$*" >> '${calls}'
 n=0; [[ ! -e '${counter}' ]] || n=$(cat '${counter}'); n=$((n+1)); printf '%s' "$n" > '${counter}'
 if [[ '${mode}' == 'recover' && "$n" == 1 ]]; then echo 'context deadline exceeded' >&2; return 1;fi
 if [[ '${mode}' == 'absent' && "$n" -lt 3 ]]; then echo '[]'; return 0;fi
 if [[ '${mode}' == 'always-fail' ]]; then echo 'connection reset by peer' >&2; return 1;fi
 if [[ '${mode}' == 'mismatch' ]]; then printf '%s\\n' '${bad}'; return 0;fi
 printf '%s\\n' '${good}'
}
`;
  fs.writeFileSync(path.join(lib, "offsite-common.sh"), common);
  const script = `set -Eeuo pipefail\numask 077\n${helperSection}
OFFSITE_NODE='${process.execPath}';SCRIPT_DIR='${base}';uploader_credentials='${base}';snapshot_id='${snapshot}'
installation_host='${host}';OFFSITE_STAGE_CURRENT='${stage}';operation_root='${operation}';confirmation_attempt=0
offsite_warn(){ printf '%s\\n' "$*" >&2; };sleep(){ :; }
if offsite_confirm_uploaded_snapshot; then result=0;else result=$?;fi
if (( result != 0 ));then offsite_upload_evidence_helper retain '${base}' "$operation_root" snapshot-confirmation SNAPSHOT_VERIFY_FAILED "$result" "$snapshot_id" "$confirmation_attempt";fi
exit "$result"
`;
  const result = childProcess.spawnSync("/bin/bash", ["-s"], { input: script, encoding: "utf8", timeout: 30000 });
  return { base, operation, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [], result };
}
test("root Linux: provider timeout recovery confirms only the same uploaded ID without backup", { skip: !linuxRoot }, (t) => {
  const f = shellFixture(t, "recover");
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) { assert.equal(call, `${f.base} snapshots --json ${snapshot}`); assert.doesNotMatch(call, /\bbackup\b/); }
  assert.equal(fs.existsSync(path.join(f.base, "upload-failures")), false);
});
test("root Linux: temporary absence has exactly three attempts and then succeeds", { skip: !linuxRoot }, (t) => {
  const f = shellFixture(t, "absent");
  assert.equal(f.result.status, 0, f.result.stderr);assert.equal(f.calls.length, 3);
});
test("root Linux: repeated transport failure stays failed and retains its bounded evidence", { skip: !linuxRoot }, (t) => {
  const f = shellFixture(t, "always-fail");
  assert.equal(f.result.status, 1, f.result.stderr);assert.equal(f.calls.length, 3);
  const dir = path.join(f.base, "upload-failures"), names = fs.readdirSync(dir);
  assert.equal(names.length, 1);
  assert.equal(fs.statSync(path.join(dir, names[0])).uid, 0);
  const record = JSON.parse(fs.readFileSync(path.join(dir, names[0])));
  assert.equal(record.confirmationAttempts, 3);assert.equal(record.snapshotId, snapshot);
});
test("root Linux: a different snapshot is rejected after one attempt", { skip: !linuxRoot }, (t) => {
  const f = shellFixture(t, "mismatch");
  assert.equal(f.result.status, 1, f.result.stderr);assert.equal(f.calls.length, 1);
});

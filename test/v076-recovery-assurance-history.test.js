"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const helperPath = path.join(__dirname, "..", "server-tools", "linux", "offsite", "lib", "assurance-history.js");
const history = require(helperPath);
const policy = history.__internalTestOnly.policy;
const statusGid = typeof process.getgid === "function" ? process.getgid() : 0;

function testRoot(context) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-assurance-history-"));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return path.join(parent, "assurance");
}

function initialize(context) {
  const root = testRoot(context);
  const result = history.initializeHistory({ root, statusGid, policy });
  assert.equal(result.ok, true);
  assert.equal(result.initialized, true);
  return root;
}

function evidence(seed = "a", appVersion = "0.76.0-beta") {
  return {
    snapshotIdPrefix: seed.repeat(12),
    receiptSha256: seed.repeat(64),
    appVersion,
  };
}

function record(root, runId, eventType, offset, options = {}) {
  return history.appendEvent({
    root,
    statusGid,
    policy,
    runId,
    eventType,
    trigger: options.trigger || "scheduled-weekly",
    errorCode: options.errorCode || null,
    evidence: options.evidence || {},
    now: new Date(Date.UTC(2026, 6, 21, 1, 0, offset)),
  });
}

function successfulRun(root, runId = crypto.randomUUID()) {
  record(root, runId, "full-assurance-started", 0);
  record(root, runId, "oauth-policy-passed", 1, { evidence: { appVersion: "0.76.0-beta" } });
  record(root, runId, "backup-passed", 2, { evidence: evidence("a") });
  record(root, runId, "repository-check-passed", 3, { evidence: evidence("b") });
  record(root, runId, "restore-test-passed", 4, { evidence: evidence("c") });
  record(root, runId, "application-smoke-not-run", 5, { evidence: { appVersion: "0.76.0-beta" } });
  const terminal = record(root, runId, "full-assurance-passed", 6, { evidence: evidence("d") });
  return { runId, terminal };
}

test("Windows transient head rename failures preserve the signed file until atomic replacement succeeds", {
  skip: process.platform !== "win32",
}, context => {
  const root = initialize(context), head = path.join(root, "head.json"), before = fs.readFileSync(head);
  const rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (source, destination, ...options) => {
    if (destination === head && ++attempts <= 6) {
      assert.deepEqual(fs.readFileSync(head), before);
      const error = new Error("synthetic sharing conflict"); error.code = "EPERM"; throw error;
    }
    return rename(source, destination, ...options);
  };
  try { record(root, crypto.randomUUID(), "full-assurance-started", 0); }
  finally { fs.renameSync = rename; }
  assert.equal(attempts, 7);
  assert.equal(history.inspectHistory({ root, statusGid, policy }).eventCount, 1);
});

test("Windows permanent head rename failure stays bounded and never removes the previous signed head", {
  skip: process.platform !== "win32",
}, context => {
  for (const [code, expectedAttempts] of [["EPERM", 11], ["EIO", 1]]) {
    const root = initialize(context), head = path.join(root, "head.json"), before = fs.readFileSync(head);
    const runId = crypto.randomUUID();
    const rename = fs.renameSync;
    let attempts = 0;
    fs.renameSync = (source, destination, ...options) => {
      if (destination === head) {
        attempts++; assert.deepEqual(fs.readFileSync(head), before);
        const error = new Error("synthetic permanent failure"); error.code = code; throw error;
      }
      return rename(source, destination, ...options);
    };
    try { assert.throws(() => record(root, runId, "full-assurance-started", 0), { code }); }
    finally { fs.renameSync = rename; }
    assert.equal(attempts, expectedAttempts);
    assert.deepEqual(fs.readFileSync(head), before);
    // The existing recovery protocol, rather than a deleted/recreated head,
    // repairs the already committed event after the failed publication.
    assert.throws(() => history.inspectHistory({ root, statusGid, policy }), {
      code: "ASSURANCE_HEAD_HISTORY_MISMATCH",
    });
    record(root, runId, "oauth-policy-passed", 1, { evidence: { appVersion: "0.76.0-beta" } });
    assert.equal(history.inspectHistory({ root, statusGid, policy }).eventCount, 2);
  }
});

test("v0.76 initializes a protected Ed25519 history with a signed empty head", (context) => {
  const root = initialize(context);
  const privatePath = path.join(root, "signing-private.pem");
  const publicPath = path.join(root, "signing-public.pem");
  const headPath = path.join(root, "head.json");
  const inspected = history.inspectHistory({ root, statusGid, policy });
  assert.deepEqual(inspected.events, []);
  assert.equal(inspected.eventCount, 0);
  assert.equal(inspected.lastSequence, 0);
  assert.equal(inspected.lastEventHash, null);
  assert.match(inspected.keyId, /^[a-f0-9]{64}$/);

  const privateKey = crypto.createPrivateKey(fs.readFileSync(privatePath));
  const publicKey = crypto.createPublicKey(fs.readFileSync(publicPath));
  const challenge = crypto.randomBytes(32);
  assert.equal(crypto.verify(null, challenge, publicKey, crypto.sign(null, challenge, privateKey)), true);
  const head = JSON.parse(fs.readFileSync(headPath, "utf8"));
  assert.deepEqual(Object.keys(head).sort(), [
    "eventCount", "format", "generatedAt", "keyId", "lastEventHash", "lastSequence", "schemaVersion", "signature",
  ].sort());
  assert.equal(head.format, "grabenplaner-recovery-assurance-head");

  if (process.platform !== "win32") {
    assert.equal(fs.lstatSync(root).mode & 0o7777, 0o750);
    assert.equal(fs.lstatSync(path.join(root, "history")).mode & 0o7777, 0o750);
    assert.equal(fs.lstatSync(privatePath).mode & 0o7777, 0o600);
    assert.equal(fs.lstatSync(publicPath).mode & 0o7777, 0o440);
    assert.equal(fs.lstatSync(headPath).mode & 0o7777, 0o640);
  }
});

test("v0.76 records a continuous signed SHA-256 chain with strict phase evidence", (context) => {
  const root = initialize(context);
  const { runId, terminal } = successfulRun(root);
  assert.equal(terminal.sequence, 7);
  assert.equal(terminal.idempotent, false);
  const inspected = history.inspectHistory({ root, statusGid, policy });
  assert.equal(inspected.eventCount, 7);
  assert.deepEqual(inspected.events.map((entry) => entry.payload.eventType), [
    "full-assurance-started",
    "oauth-policy-passed",
    "backup-passed",
    "repository-check-passed",
    "restore-test-passed",
    "application-smoke-not-run",
    "full-assurance-passed",
  ]);
  assert.ok(inspected.events.every((entry) => entry.payload.runId === runId));

  const files = fs.readdirSync(path.join(root, "history")).sort();
  assert.equal(files.length, 7);
  const publicKey = crypto.createPublicKey(fs.readFileSync(path.join(root, "signing-public.pem")));
  let previousHash = null;
  files.forEach((file, index) => {
    const event = JSON.parse(fs.readFileSync(path.join(root, "history", file), "utf8"));
    assert.deepEqual(Object.keys(event).sort(), [
      "eventHash", "format", "keyId", "payload", "previousHash", "schemaVersion", "sequence", "signature",
    ].sort());
    assert.deepEqual(Object.keys(event.payload).sort(), [
      "errorCode", "eventId", "eventType", "evidence", "occurredAt", "runId", "trigger",
    ].sort());
    assert.deepEqual(Object.keys(event.payload.evidence).sort(), ["appVersion", "receiptSha256", "snapshotIdPrefix"].sort());
    assert.equal(event.sequence, index + 1);
    assert.equal(event.previousHash, previousHash);
    const unsigned = {
      format: event.format,
      schemaVersion: event.schemaVersion,
      sequence: event.sequence,
      previousHash: event.previousHash,
      payload: event.payload,
      keyId: event.keyId,
    };
    const digest = crypto.createHash("sha256").update(history.canonicalJson(unsigned)).digest("hex");
    assert.equal(event.eventHash, digest);
    assert.equal(crypto.verify(null, Buffer.from(digest, "hex"), publicKey, Buffer.from(event.signature, "base64")), true);
    assert.equal(file, `${String(index + 1).padStart(12, "0")}-${digest}.json`);
    previousHash = digest;
  });
});

test("v0.76 terminal events are idempotent and conflicting outcomes are rejected", (context) => {
  const root = initialize(context);
  const { runId, terminal } = successfulRun(root);
  const countBefore = fs.readdirSync(path.join(root, "history")).length;
  const repeated = record(root, runId, "full-assurance-passed", 20, { evidence: evidence("d") });
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.sequence, terminal.sequence);
  assert.equal(repeated.eventHash, terminal.eventHash);
  assert.equal(fs.readdirSync(path.join(root, "history")).length, countBefore);
  assert.throws(() => record(root, runId, "full-assurance-failed", 21, {
    errorCode: "ASSURANCE_RUN_FAILED",
    evidence: evidence("d"),
  }), (error) => error.code === "ASSURANCE_TERMINAL_CONFLICT");
});

test("v0.76 repairs a valid signed head prefix before appending after an interrupted write", (context) => {
  const root = initialize(context);
  const headPath = path.join(root, "head.json");
  const emptyHead = fs.readFileSync(headPath);
  const runId = crypto.randomUUID();
  record(root, runId, "full-assurance-started", 0);
  fs.writeFileSync(headPath, emptyHead);

  record(root, runId, "oauth-policy-passed", 1, { evidence: { appVersion: "0.76.0-beta" } });
  const inspected = history.inspectHistory({ root, statusGid, policy });
  assert.equal(inspected.eventCount, 2);
  assert.deepEqual(inspected.events.map((entry) => entry.payload.eventType), [
    "full-assurance-started",
    "oauth-policy-passed",
  ]);
});

test("v0.76 enforces event enums, phase order, UUIDs, evidence and fixed failure codes", (context) => {
  const root = initialize(context);
  const runId = crypto.randomUUID();
  assert.throws(() => record(root, "a".repeat(32), "full-assurance-started", 0), (error) => error.code === "ASSURANCE_ID_INVALID");
  assert.throws(() => record(root, runId, "configuration-change-queued", 0), (error) => error.code === "ASSURANCE_EVENT_INVALID");
  record(root, runId, "full-assurance-started", 0);
  assert.throws(() => record(root, runId, "backup-passed", 1, { evidence: { appVersion: "latest" } }),
    (error) => error.code === "ASSURANCE_EVIDENCE_INVALID");
  assert.throws(() => record(root, runId, "restore-test-passed", 1, { evidence: evidence("a") }),
    (error) => error.code === "ASSURANCE_RUN_ORDER_INVALID");
  assert.throws(() => record(root, runId, "full-assurance-passed", 2, { evidence: evidence("b") }),
    (error) => error.code === "ASSURANCE_RUN_ORDER_INVALID" || error.code === "ASSURANCE_RUN_INCOMPLETE");
  assert.equal(fs.readdirSync(path.join(root, "history")).length, 1,
    "rejected phase or terminal events must not leave an unsigned or invalid receipt behind");
  assert.throws(() => record(root, runId, "full-assurance-failed", 2, { errorCode: "PASSWORD_BAD" }),
    (error) => error.code === "ASSURANCE_ERROR_CODE_INVALID");
  const failed = record(root, runId, "full-assurance-failed", 2, { errorCode: "UPLOAD_FAILED" });
  assert.equal(failed.idempotent, false);
});

test("v0.76 detects receipt tampering, unsafe permissions and hard links", (context) => {
  const tamperedRoot = initialize(context);
  successfulRun(tamperedRoot);
  const receipt = path.join(tamperedRoot, "history", fs.readdirSync(path.join(tamperedRoot, "history")).sort()[0]);
  const value = JSON.parse(fs.readFileSync(receipt, "utf8"));
  value.payload.trigger = "manual-cli";
  fs.writeFileSync(receipt, `${JSON.stringify(value)}\n`);
  assert.throws(() => history.inspectHistory({ root: tamperedRoot, statusGid, policy }),
    (error) => ["ASSURANCE_EVENT_SIGNATURE_INVALID", "ASSURANCE_FILE_UNSAFE"].includes(error.code));

  const nonCanonicalRoot = initialize(context);
  record(nonCanonicalRoot, crypto.randomUUID(), "full-assurance-started", 0);
  const nonCanonicalReceipt = path.join(nonCanonicalRoot, "history",
    fs.readdirSync(path.join(nonCanonicalRoot, "history"))[0]);
  const nonCanonical = JSON.parse(fs.readFileSync(nonCanonicalReceipt, "utf8"));
  nonCanonical.payload.eventId = nonCanonical.payload.eventId.toUpperCase();
  fs.writeFileSync(nonCanonicalReceipt, `${JSON.stringify(nonCanonical)}\n`);
  assert.throws(() => history.inspectHistory({ root: nonCanonicalRoot, statusGid, policy }),
    (error) => error.code === "ASSURANCE_EVENT_SCHEMA_INVALID");

  if (process.platform !== "win32") {
    const modeRoot = initialize(context);
    fs.chmodSync(path.join(modeRoot, "signing-public.pem"), 0o660);
    assert.throws(() => history.inspectHistory({ root: modeRoot, statusGid, policy }),
      (error) => error.code === "ASSURANCE_FILE_PERMISSIONS_INVALID");
  }

  const linkRoot = initialize(context);
  const runId = crypto.randomUUID();
  record(linkRoot, runId, "full-assurance-started", 0);
  const linkedReceipt = path.join(linkRoot, "history", fs.readdirSync(path.join(linkRoot, "history"))[0]);
  const externalLink = path.join(path.dirname(linkRoot), "receipt-hardlink.json");
  fs.linkSync(linkedReceipt, externalLink);
  assert.throws(() => history.inspectHistory({ root: linkRoot, statusGid, policy }),
    (error) => error.code === "ASSURANCE_FILE_UNSAFE");
});

test("v0.76 CLI requires the explicit test escape hatch and never prints paths or secrets", (context) => {
  const root = testRoot(context);
  const base = [helperPath, "init", "--root", root, "--status-gid", String(statusGid), "--allow-non-root"];
  const denied = spawnSync(process.execPath, base, { encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } });
  assert.equal(denied.status, 2);
  assert.equal(denied.stdout, "");
  assert.doesNotMatch(denied.stderr, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const initialized = spawnSync(process.execPath, base, { encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } });
  assert.equal(initialized.status, 0, initialized.stderr);
  const initResult = JSON.parse(initialized.stdout);
  assert.equal(initResult.ok, true);
  assert.equal("root" in initResult, false);

  const inspected = spawnSync(process.execPath, [
    helperPath, "inspect", "--root", root, "--status-gid", String(statusGid), "--allow-non-root",
  ], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).eventCount, 0);
  assert.equal(`${initialized.stdout}${inspected.stdout}`.includes(root), false);
});

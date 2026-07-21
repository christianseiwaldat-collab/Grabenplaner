"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  EVENT_FORMAT,
  HEAD_FORMAT,
  SCHEMA_VERSION,
  MAX_RETURNED_EVENTS,
  canonicalHash,
  eventUnsigned,
  headUnsigned,
  publicKeyId,
  readRecoveryAssuranceStatus,
} = require("../lib/recovery-assurance-status");
const assuranceWriter = require("../server-tools/linux/offsite/lib/assurance-history");

function signature(privateKey, hash) {
  return crypto.sign(null, Buffer.from(hash, "hex"), privateKey).toString("base64");
}

function makeFixture(count = 4) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-assurance-reader-"));
  const history = path.join(root, "history");
  fs.mkdirSync(history, { mode: 0o750 });
  fs.chmodSync(root, 0o750);
  fs.chmodSync(history, 0o750);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  const publicKeyPath = path.join(root, "signing-public.pem");
  fs.writeFileSync(publicKeyPath, publicPem, { mode: 0o440 });
  fs.chmodSync(publicKeyPath, 0o440);
  const keyId = publicKeyId(publicKey);
  const events = [];
  let previousHash = null;
  let runId = "";
  const cycle = [
    "full-assurance-started",
    "oauth-policy-passed",
    "backup-passed",
    "repository-check-passed",
    "restore-test-passed",
    "application-smoke-not-run",
    "full-assurance-passed",
  ];
  for (let index = 1; index <= count; index += 1) {
    const eventType = cycle[(index - 1) % cycle.length];
    if (eventType === "full-assurance-started") runId = crypto.randomUUID();
    const payload = {
      eventId: crypto.randomUUID(),
      runId,
      eventType,
      trigger: "scheduled-weekly",
      occurredAt: new Date(Date.UTC(2026, 6, 20, 0, index, 0)).toISOString(),
      errorCode: null,
      evidence: {
        snapshotIdPrefix: eventType === "full-assurance-passed" ? index.toString(16).padStart(12, "0") : null,
        receiptSha256: eventType === "full-assurance-passed" ? index.toString(16).padStart(64, "0") : null,
        appVersion: eventType === "full-assurance-passed" ? "0.76.0-beta" : null,
      },
    };
    const unsigned = { format: EVENT_FORMAT, schemaVersion: SCHEMA_VERSION, sequence: index, previousHash, payload, keyId };
    const eventHash = canonicalHash(unsigned);
    const event = { ...unsigned, eventHash, signature: signature(privateKey, eventHash) };
    const name = `${String(index).padStart(12, "0")}-${eventHash}.json`;
    const eventPath = path.join(history, name);
    fs.writeFileSync(eventPath, `${JSON.stringify(event)}\n`, { mode: 0o640 });
    fs.chmodSync(eventPath, 0o640);
    events.push({ event, path: eventPath });
    previousHash = eventHash;
  }
  const headUnsignedValue = {
    format: HEAD_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    eventCount: count,
    lastSequence: count,
    lastEventHash: previousHash,
    keyId,
    generatedAt: "2026-07-20T02:00:00.000Z",
  };
  const head = { ...headUnsignedValue, signature: signature(privateKey, canonicalHash(headUnsignedValue)) };
  const headPath = path.join(root, "head.json");
  fs.writeFileSync(headPath, `${JSON.stringify(head)}\n`, { mode: 0o640 });
  fs.chmodSync(headPath, 0o640);
  return {
    root, history, headPath, publicKeyPath, privateKey, publicKey, keyId, events, head,
    options: {
      configured: true,
      rootPath: root,
      requireRootOwner: false,
      now: new Date("2026-07-20T03:00:00.000Z"),
    },
  };
}

function addSignedEvent(fixture, { eventType, runId, trigger = "scheduled-weekly", occurredAt, errorCode = null, evidence = {} }) {
  const sequence = fixture.events.length + 1;
  const payload = {
    eventId: crypto.randomUUID(),
    runId,
    eventType,
    trigger,
    occurredAt,
    errorCode,
    evidence: {
      snapshotIdPrefix: evidence.snapshotIdPrefix ?? null,
      receiptSha256: evidence.receiptSha256 ?? null,
      appVersion: evidence.appVersion ?? null,
    },
  };
  const unsigned = {
    format: EVENT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    sequence,
    previousHash: fixture.events.at(-1)?.event.eventHash || null,
    payload,
    keyId: fixture.keyId,
  };
  const eventHash = canonicalHash(unsigned);
  const event = { ...unsigned, eventHash, signature: signature(fixture.privateKey, eventHash) };
  const file = path.join(fixture.history, `${String(sequence).padStart(12, "0")}-${eventHash}.json`);
  fs.writeFileSync(file, JSON.stringify(event), { mode: 0o640 });
  fs.chmodSync(file, 0o640);
  fixture.events.push({ event, path: file });
  const head = {
    ...fixture.head,
    eventCount: sequence,
    lastSequence: sequence,
    lastEventHash: eventHash,
    generatedAt: new Date(Math.max(Date.parse(fixture.head.generatedAt), Date.parse(occurredAt))).toISOString(),
  };
  head.signature = signature(fixture.privateKey, canonicalHash(headUnsigned(head)));
  fs.writeFileSync(fixture.headPath, JSON.stringify(head));
  fs.chmodSync(fixture.headPath, 0o640);
  fixture.head = head;
  return event;
}

function cleanup(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test("RAS reader verifies the complete signed chain but returns at most 30 redacted newest events", () => {
  const fixture = makeFixture(42);
  try {
    const result = readRecoveryAssuranceStatus(fixture.options);
    assert.equal(result.state, "ok", JSON.stringify(result));
    assert.equal(result.integrityVerified, true);
    assert.equal(result.eventCount, 42);
    assert.equal(result.events.length, MAX_RETURNED_EVENTS);
    assert.equal(result.events[0].sequence, 42);
    assert.equal(result.events.at(-1).sequence, 13);
    assert.equal(result.events[0].evidence.snapshotIdPrefix.length, 12);
    assert.equal(result.events[0].evidence.receiptSha256Prefix.length, 12);
    assert.equal(result.lastEventHashPrefix.length, 12);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      fixture.root,
      fixture.events[41].event.eventHash,
      fixture.events[41].event.payload.evidence.receiptSha256,
      fixture.events[41].event.signature,
      fixture.keyId,
      "signing-public.pem",
    ]) assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    for (const forbiddenKey of ["previousHash", "eventHash", "signature", "keyId", "path", "account", "oauth", "secret"]) {
      assert.equal(serialized.toLowerCase().includes(`\"${forbiddenKey.toLowerCase()}\"`), false, forbiddenKey);
    }
  } finally { cleanup(fixture); }
});

test("RAS reader returns a critical diagnostic instead of throwing on modified, missing or reordered evidence", async (t) => {
  await t.test("modified payload", () => {
    const fixture = makeFixture();
    try {
      const changed = JSON.parse(fs.readFileSync(fixture.events[1].path, "utf8"));
      changed.payload.trigger = "manual-cli";
      fs.writeFileSync(fixture.events[1].path, JSON.stringify(changed));
      fs.chmodSync(fixture.events[1].path, 0o640);
      const result = readRecoveryAssuranceStatus(fixture.options);
      assert.equal(result.state, "error");
      assert.equal(result.severity, "critical");
      assert.equal(result.integrityVerified, false);
      assert.equal(result.events.length, 0);
      assert.match(result.lastErrorCode, /^RAS_HISTORY_/);
    } finally { cleanup(fixture); }
  });

  await t.test("deleted event", () => {
    const fixture = makeFixture();
    try {
      fs.unlinkSync(fixture.events[1].path);
      const result = readRecoveryAssuranceStatus(fixture.options);
      assert.equal(result.state, "error");
      assert.equal(result.lastErrorCode, "RAS_HISTORY_CHAIN_INVALID");
    } finally { cleanup(fixture); }
  });

  await t.test("renamed sequence", () => {
    const fixture = makeFixture();
    try {
      fs.renameSync(fixture.events[1].path, path.join(fixture.history, `000000000099-${fixture.events[1].event.eventHash}.json`));
      const result = readRecoveryAssuranceStatus(fixture.options);
      assert.equal(result.state, "error");
      assert.equal(result.lastErrorCode, "RAS_HISTORY_CHAIN_INVALID");
    } finally { cleanup(fixture); }
  });
});

test("RAS reader rejects a forged signature, a signed head rollback and an unknown payload field", async (t) => {
  await t.test("forged event signature", () => {
    const fixture = makeFixture();
    try {
      const changed = JSON.parse(fs.readFileSync(fixture.events[0].path, "utf8"));
      changed.signature = Buffer.alloc(64, 0x5a).toString("base64");
      fs.writeFileSync(fixture.events[0].path, JSON.stringify(changed));
      fs.chmodSync(fixture.events[0].path, 0o640);
      assert.equal(readRecoveryAssuranceStatus(fixture.options).lastErrorCode, "RAS_HISTORY_SIGNATURE_INVALID");
    } finally { cleanup(fixture); }
  });

  await t.test("signed head rollback", () => {
    const fixture = makeFixture();
    try {
      const rolledBack = {
        ...fixture.head,
        eventCount: 3,
        lastSequence: 3,
        lastEventHash: fixture.events[2].event.eventHash,
      };
      rolledBack.signature = signature(fixture.privateKey, canonicalHash(headUnsigned(rolledBack)));
      fs.writeFileSync(fixture.headPath, JSON.stringify(rolledBack));
      fs.chmodSync(fixture.headPath, 0o640);
      assert.equal(readRecoveryAssuranceStatus(fixture.options).lastErrorCode, "RAS_HISTORY_CHAIN_INVALID");
    } finally { cleanup(fixture); }
  });

  await t.test("unknown payload field with a secret", () => {
    const fixture = makeFixture();
    try {
      const changed = JSON.parse(fs.readFileSync(fixture.events[0].path, "utf8"));
      changed.payload.oauthToken = "never-return-this-token";
      const unsigned = eventUnsigned(changed);
      changed.eventHash = canonicalHash(unsigned);
      changed.signature = signature(fixture.privateKey, changed.eventHash);
      const renamed = path.join(fixture.history, `000000000001-${changed.eventHash}.json`);
      fs.unlinkSync(fixture.events[0].path);
      fs.writeFileSync(renamed, JSON.stringify(changed), { mode: 0o640 });
      fs.chmodSync(renamed, 0o640);
      const result = readRecoveryAssuranceStatus(fixture.options);
      assert.equal(result.lastErrorCode, "RAS_HISTORY_SCHEMA_INVALID");
      assert.doesNotMatch(JSON.stringify(result), /never-return-this-token|oauthToken/i);
    } finally { cleanup(fixture); }
  });
});

test("RAS reader validates safe filesystem boundaries and never discloses rejected paths", async (t) => {
  await t.test("path outside the fixed root", () => {
    const fixture = makeFixture();
    try {
      const result = readRecoveryAssuranceStatus({ ...fixture.options, headPath: path.join(path.dirname(fixture.root), "outside.json") });
      assert.equal(result.lastErrorCode, "RAS_HISTORY_PATH_INVALID");
      assert.doesNotMatch(JSON.stringify(result), /outside\.json|grabenplaner-assurance-reader/i);
    } finally { cleanup(fixture); }
  });

  await t.test("unsafe mode", { skip: process.platform === "win32" }, () => {
    const fixture = makeFixture();
    try {
      fs.chmodSync(fixture.events[0].path, 0o660);
      assert.equal(readRecoveryAssuranceStatus(fixture.options).lastErrorCode, "RAS_HISTORY_FILE_UNSAFE");
    } finally { cleanup(fixture); }
  });

  await t.test("symbolic-link event", { skip: process.platform === "win32" }, () => {
    const fixture = makeFixture();
    try {
      const original = `${fixture.events[0].path}.target`;
      fs.renameSync(fixture.events[0].path, original);
      fs.symlinkSync(original, fixture.events[0].path);
      assert.equal(readRecoveryAssuranceStatus(fixture.options).lastErrorCode, "RAS_HISTORY_FILE_UNSAFE");
    } finally { cleanup(fixture); }
  });

  await t.test("hard-linked event", { skip: process.platform === "win32" }, () => {
    const fixture = makeFixture();
    try {
      fs.linkSync(fixture.events[0].path, path.join(fixture.root, "hardlink.json"));
      assert.equal(readRecoveryAssuranceStatus(fixture.options).lastErrorCode, "RAS_HISTORY_FILE_UNSAFE");
    } finally { cleanup(fixture); }
  });
});

test("RAS reader handles unconfigured, empty, future-dated and operational failure states", async (t) => {
  await t.test("unconfigured", () => {
    const result = readRecoveryAssuranceStatus({ configured: false });
    assert.equal(result.state, "unconfigured");
    assert.equal(result.lastErrorCode, null);
    assert.deepEqual(result.events, []);
  });

  await t.test("malformed options still return redacted diagnostics", () => {
    assert.doesNotThrow(() => readRecoveryAssuranceStatus(null));
    const result = readRecoveryAssuranceStatus({
      configured: true,
      get rootPath() { throw new Error("do-not-disclose-this-path"); },
    });
    assert.equal(result.state, "error");
    assert.equal(result.severity, "critical");
    assert.doesNotMatch(JSON.stringify(result), /do-not-disclose-this-path/i);
  });

  await t.test("empty signed history", () => {
    const fixture = makeFixture(0);
    try {
      const result = readRecoveryAssuranceStatus(fixture.options);
      assert.equal(result.state, "warning");
      assert.equal(result.integrityVerified, true, JSON.stringify(result));
      assert.equal(result.eventCount, 0);
      assert.equal(result.lastEventHashPrefix, null);
    } finally { cleanup(fixture); }
  });

  await t.test("future-dated event", () => {
    const fixture = makeFixture(2);
    try {
      const result = readRecoveryAssuranceStatus({ ...fixture.options, now: new Date("2026-07-19T00:00:00.000Z") });
      assert.equal(result.state, "error");
      assert.equal(result.lastErrorCode, "RAS_HISTORY_TIME_INVALID");
    } finally { cleanup(fixture); }
  });

  await t.test("verified assurance failure", () => {
    const fixture = makeFixture(1);
    try {
      addSignedEvent(fixture, {
        eventType: "full-assurance-failed",
        runId: fixture.events[0].event.payload.runId,
        occurredAt: "2026-07-20T00:03:00.000Z",
        errorCode: "RESTORE_TEST_FAILED",
      });
      const result = readRecoveryAssuranceStatus(fixture.options);
      assert.equal(result.integrityVerified, true, JSON.stringify(result));
      assert.equal(result.state, "error");
      assert.equal(result.severity, "critical");
      assert.equal(result.lastErrorCode, "RESTORE_TEST_FAILED");
    } finally { cleanup(fixture); }
  });

  await t.test("successful run requires every ordered assurance phase", () => {
    const fixture = makeFixture(1);
    try {
      addSignedEvent(fixture, {
        eventType: "full-assurance-passed",
        runId: fixture.events[0].event.payload.runId,
        occurredAt: "2026-07-20T00:03:00.000Z",
      });
      const result = readRecoveryAssuranceStatus(fixture.options);
      assert.equal(result.integrityVerified, false);
      assert.equal(result.lastErrorCode, "RAS_HISTORY_CHAIN_INVALID");
    } finally { cleanup(fixture); }
  });

  await t.test("assurance phases cannot skip the exact next phase", () => {
    const fixture = makeFixture(1);
    try {
      addSignedEvent(fixture, {
        eventType: "backup-passed",
        runId: fixture.events[0].event.payload.runId,
        occurredAt: "2026-07-20T00:02:00.000Z",
      });
      const result = readRecoveryAssuranceStatus(fixture.options);
      assert.equal(result.integrityVerified, false);
      assert.equal(result.lastErrorCode, "RAS_HISTORY_CHAIN_INVALID");
    } finally { cleanup(fixture); }
  });

  await t.test("a queued configuration change makes the last passed assurance stale", () => {
    const fixture = makeFixture(7);
    try {
      addSignedEvent(fixture, {
        eventType: "configuration-change-queued",
        runId: crypto.randomUUID(),
        trigger: "offsite-config-changed",
        occurredAt: "2026-07-20T02:30:00.000Z",
      });
      const result = readRecoveryAssuranceStatus(fixture.options);
      assert.equal(result.integrityVerified, true, JSON.stringify(result));
      assert.equal(result.state, "warning");
      assert.equal(result.severity, "warning");
      assert.equal(result.lastErrorCode, null);
    } finally { cleanup(fixture); }
  });
});

test("RAS reader accepts the exact history emitted by the privileged writer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-assurance-contract-"));
  const statusGid = process.platform === "win32" ? 0 : process.getgid();
  const policy = assuranceWriter.__internalTestOnly.policy;
  try {
    assuranceWriter.initializeHistory({ root, statusGid, policy });
    const runId = crypto.randomUUID();
    let occurredAt = Date.now() - 60_000;
    for (const eventType of [
      "full-assurance-started",
      ...assuranceWriter.PHASE_EVENTS,
      "full-assurance-passed",
    ]) {
      assuranceWriter.appendEvent({
        root,
        statusGid,
        policy,
        eventType,
        runId,
        trigger: "manual-cli",
        now: new Date(occurredAt += 1_000),
        errorCode: null,
        evidence: { snapshotIdPrefix: null, receiptSha256: null, appVersion: null },
      });
    }
    const result = readRecoveryAssuranceStatus({
      configured: true,
      rootPath: root,
      requireRootOwner: false,
      expectedGid: process.platform === "win32" ? null : statusGid,
      now: new Date(),
    });
    assert.equal(result.integrityVerified, true, JSON.stringify(result));
    assert.equal(result.state, "ok");
    assert.equal(result.eventCount, 7);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

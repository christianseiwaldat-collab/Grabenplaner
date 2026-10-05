"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  EVENT_FORMAT, HEAD_FORMAT, SCHEMA_VERSION, canonicalHash, publicKeyId,
  readRecoveryAssuranceStatus,
} = require("../lib/recovery-assurance-status");
const { createRecoveryAssuranceStatusReader } = require("../lib/recovery-assurance-status-reader");

// Sign a complete chain once, rather than repeatedly rescanning the growing
// directory through appendEvent. The verifier and worker both read real files.
function signedFixture(count = 7) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-assurance-worker-test-"));
  const history = path.join(root, "history");
  fs.mkdirSync(history, { mode: 0o750 });
  fs.chmodSync(root, 0o750);
  fs.chmodSync(history, 0o750);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const keyId = publicKeyId(publicKey);
  const sign = (value) => crypto.sign(null, Buffer.from(canonicalHash(value), "hex"), privateKey).toString("base64");
  const publicKeyPath = path.join(root, "signing-public.pem");
  fs.writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o440 });
  fs.chmodSync(publicKeyPath, 0o440);
  const phases = [
    "full-assurance-started", "oauth-policy-passed", "backup-passed",
    "repository-check-passed", "restore-test-passed", "application-smoke-not-run", "full-assurance-passed",
  ];
  // The 1,564-event fixture has three initial update events followed by 223
  // complete seven-phase runs, so its final assurance state is healthy.
  const prefix = count % phases.length;
  const events = [];
  let previousHash = null;
  let runId;
  const runIds = [];
  for (let index = 0; index < count; index += 1) {
    const eventType = index < prefix ? "update-queued" : phases[(index - prefix) % phases.length];
    if (index < prefix || eventType === "full-assurance-started") {
      runId = crypto.randomUUID();
      if (eventType === "full-assurance-started") runIds.push(runId);
    }
    const payload = {
      eventId: crypto.randomUUID(), runId, eventType,
      trigger: index < prefix ? "app-updated" : "scheduled-weekly",
      occurredAt: new Date(Date.UTC(2026, 6, 20) + (index + 1) * 1_000).toISOString(),
      errorCode: null,
      evidence: {
        snapshotIdPrefix: eventType === "full-assurance-passed" ? index.toString(16).padStart(12, "0") : null,
        receiptSha256: eventType === "full-assurance-passed" ? index.toString(16).padStart(64, "0") : null,
        appVersion: eventType === "full-assurance-passed" ? "0.92.75-beta" : null,
      },
    };
    const unsigned = { format: EVENT_FORMAT, schemaVersion: SCHEMA_VERSION, sequence: index + 1, previousHash, payload, keyId };
    const eventHash = canonicalHash(unsigned);
    const event = { ...unsigned, eventHash, signature: sign(unsigned) };
    const file = path.join(history, `${String(index + 1).padStart(12, "0")}-${eventHash}.json`);
    fs.writeFileSync(file, JSON.stringify(event), { mode: 0o640 });
    fs.chmodSync(file, 0o640);
    events.push({ file, event });
    previousHash = eventHash;
  }
  const headUnsigned = {
    format: HEAD_FORMAT, schemaVersion: SCHEMA_VERSION, eventCount: count,
    lastSequence: count, lastEventHash: previousHash, keyId,
    generatedAt: "2026-07-20T02:00:00.000Z",
  };
  const headPath = path.join(root, "head.json");
  fs.writeFileSync(headPath, JSON.stringify({ ...headUnsigned, signature: sign(headUnsigned) }), { mode: 0o640 });
  fs.chmodSync(headPath, 0o640);
  return {
    root, history, headPath, publicKeyPath, events, runIds,
    options: { configured: true, rootPath: root, requireRootOwner: false, now: new Date("2026-07-20T03:00:00.000Z") },
  };
}

function comparable(status) {
  // Error/unconfigured diagnostics stamp the actual wall clock. No other field
  // is excluded: dates supplied explicitly, redaction and report content agree.
  const { checkedAt, ...rest } = status;
  assert.ok(Number.isFinite(Date.parse(checkedAt)));
  return rest;
}

async function assertSame(reader, options) {
  const actual = await reader.read(options);
  const expected = readRecoveryAssuranceStatus(options);
  assert.deepEqual(comparable(actual), comparable(expected));
  if (actual.integrityVerified) assert.equal(actual.checkedAt, expected.checkedAt);
  return actual;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolveValue) => { resolve = resolveValue; });
  return { promise, resolve };
}

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
      res.on("error", reject);
    });
    req.setTimeout(10_000, () => req.destroy(new Error("Local test request timed out")));
    req.on("error", reject);
  });
}

test("RAS worker preserves the complete 1,564-event signed verification, report selection and freshness", { timeout: 30_000 }, async (t) => {
  const fixture = signedFixture(1_564);
  const reader = createRecoveryAssuranceStatusReader();
  try {
    await t.test("canonical redacted status matches the unchanged synchronous verifier", async () => {
      const status = await assertSame(reader, fixture.options);
      assert.equal(status.state, "ok");
      assert.equal(status.eventCount, 1_564);
      assert.equal(status.events.length, 30);
      assert.equal(status.recentRuns.length, 12);
      const serialized = JSON.stringify(status);
      assert.equal(serialized.includes(fixture.root), false);
      assert.equal(serialized.includes(fixture.events.at(-1).event.eventHash), false);
      assert.equal(serialized.includes(fixture.events.at(-1).event.signature), false);
      assert.equal(serialized.includes(fixture.events.at(-1).event.payload.evidence.receiptSha256), false);
    });
    await t.test("a report outside the newest twelve runs is still available", async () => {
      const reportId = crypto.createHash("sha256").update(fixture.runIds[0]).digest("hex");
      const status = await assertSame(reader, { ...fixture.options, reportId });
      assert.equal(status.recentRuns.length, 1);
      assert.equal(status.recentRuns[0].reportId, reportId);
      assert.equal(status.recentRuns[0].status, "passed");
    });
    await t.test("changed time recomputes freshness instead of retaining a previous success", async () => {
      const status = await assertSame(reader, { ...fixture.options, now: new Date("2027-01-01T00:00:00.000Z"), maximumRunAgeHours: 24 });
      assert.equal(status.state, "warning");
      assert.equal(status.stale, true);
      assert.equal(status.integrityVerified, true);
    });
    await t.test("tampering with an old event is detected without changing the signed head", async () => {
      const target = fixture.events[15];
      const original = fs.readFileSync(target.file);
      const originalHead = fs.readFileSync(fixture.headPath);
      try {
        const changed = { ...target.event, payload: { ...target.event.payload, trigger: "manual-cli" } };
        fs.writeFileSync(target.file, JSON.stringify(changed));
        fs.chmodSync(target.file, 0o640);
        const status = await assertSame(reader, fixture.options);
        assert.equal(status.state, "error");
        assert.equal(status.integrityVerified, false);
        assert.equal(status.lastErrorCode, "RAS_HISTORY_HASH_INVALID");
        assert.deepEqual(status.events, []);
        assert.deepEqual(fs.readFileSync(fixture.headPath), originalHead);
      } finally {
        fs.writeFileSync(target.file, original);
        fs.chmodSync(target.file, 0o640);
      }
      assert.equal((await assertSame(reader, fixture.options)).state, "ok");
    });
  } finally {
    await reader.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("RAS worker preserves safe-file diagnostics and unconfigured behavior", { timeout: 20_000 }, async (t) => {
  const fixture = signedFixture();
  const reader = createRecoveryAssuranceStatusReader();
  try {
    await t.test("unconfigured", async () => {
      const status = await assertSame(reader, { configured: false });
      assert.equal(status.state, "unconfigured");
      assert.equal(status.lastErrorCode, null);
    });
    await t.test("a missing signed head stays a redacted critical diagnostic", async () => {
      const head = fs.readFileSync(fixture.headPath);
      try {
        fs.unlinkSync(fixture.headPath);
        const status = await assertSame(reader, fixture.options);
        assert.equal(status.lastErrorCode, "RAS_HISTORY_MISSING");
        assert.equal(status.severity, "critical");
        assert.equal(JSON.stringify(status).includes(fixture.root), false);
      } finally {
        fs.writeFileSync(fixture.headPath, head, { mode: 0o640 });
        fs.chmodSync(fixture.headPath, 0o640);
      }
    });
    await t.test("unsafe file permissions", { skip: process.platform === "win32" }, async () => {
      try {
        fs.chmodSync(fixture.events[0].file, 0o660);
        assert.equal((await assertSame(reader, fixture.options)).lastErrorCode, "RAS_HISTORY_FILE_UNSAFE");
      } finally { fs.chmodSync(fixture.events[0].file, 0o640); }
    });
    await t.test("a symbolic link cannot substitute a signed event", { skip: process.platform === "win32" }, async () => {
      const eventPath = fixture.events[0].file;
      const target = path.join(fixture.root, "event-target.json");
      fs.renameSync(eventPath, target);
      try {
        fs.symlinkSync(target, eventPath);
        assert.equal((await assertSame(reader, fixture.options)).lastErrorCode, "RAS_HISTORY_FILE_UNSAFE");
      } finally {
        fs.unlinkSync(eventPath);
        fs.renameSync(target, eventPath);
      }
    });
    await t.test("hard-linked signed evidence is rejected on supported platforms", async () => {
      const extra = path.join(fixture.root, "hardlink.json");
      fs.linkSync(fixture.events[0].file, extra);
      try {
        assert.equal((await assertSame(reader, fixture.options)).lastErrorCode, "RAS_HISTORY_FILE_UNSAFE");
      } finally { fs.unlinkSync(extra); }
    });
  } finally {
    await reader.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a live HTTP request completes during real worker verification of 1,564 signed events", { timeout: 30_000 }, async (t) => {
  const fixture = signedFixture(1_564);
  const reader = createRecoveryAssuranceStatusReader();
  const readySubmitted = deferred();
  let readySettled = false;
  let verificationError;
  const server = http.createServer((req, res) => {
    if (req.url === "/live") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"live":true}');
      return;
    }
    if (req.url !== "/ready") { res.writeHead(404); res.end(); return; }
    const pending = reader.read(fixture.options);
    readySubmitted.resolve();
    pending.then((status) => {
      readySettled = true;
      res.writeHead(status.integrityVerified ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(status));
    }, (error) => {
      verificationError = error;
      readySettled = true;
      res.writeHead(500);
      res.end("verification failed");
    });
  });
  try {
    // Warm the actual worker so the check covers verification as well as startup.
    assert.equal((await reader.read(fixture.options)).integrityVerified, true);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const startedAt = performance.now();
    const readyRequest = request(port, "/ready");
    await readySubmitted.promise;
    assert.equal(readySettled, false, "readiness must still be waiting for verification");
    const liveStartedAt = performance.now();
    const live = await request(port, "/live");
    const liveMs = performance.now() - liveStartedAt;
    assert.equal(live.statusCode, 200);
    assert.deepEqual(JSON.parse(live.body), { live: true });
    assert.equal(readySettled, false, "the ordinary request must finish before the expensive readiness verification");
    const ready = await readyRequest;
    assert.equal(verificationError, undefined);
    assert.equal(ready.statusCode, 200);
    assert.equal(JSON.parse(ready.body).eventCount, 1_564);
    t.diagnostic(`Synthetic loopback HTTP: /live ${liveMs.toFixed(2)} ms while /ready verified 1,564 events in ${(performance.now() - startedAt).toFixed(2)} ms; no production latency claim.`);
  } finally {
    await reader.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const client = require(path.join(root, "lib", "recovery-assurance-control-client.js"));
const broker = require(path.join(root, "server-tools", "linux", "offsite", "lib", "assurance-control-broker.js"));

const requestId = "410d17bd-8eca-4f6a-9adf-9ab4ed897f63";

function request(action = "start-manual-assurance", id = requestId) {
  return Buffer.from(`${JSON.stringify({
    format: broker.REQUEST_FORMAT,
    schemaVersion: broker.SCHEMA_VERSION,
    action,
    requestId: id,
  })}\n`);
}

function systemctlMock(activeState = "inactive") {
  const calls = [];
  const spawnSync = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "show" && args[1] === "--property=LoadState") return { status: 0, stdout: "loaded\n" };
    if (args[0] === "show" && args[1] === "--property=ActiveState") return { status: 0, stdout: `${activeState}\n` };
    if (args[0] === "start") return { status: 0, stdout: "" };
    return { status: 1, stdout: "" };
  };
  return { calls, spawnSync };
}

test("RAS broker accepts only the exact bounded protocol", () => {
  assert.deepEqual(broker.parseRequest(request()), {
    format: broker.REQUEST_FORMAT,
    schemaVersion: broker.SCHEMA_VERSION,
    action: "start-manual-assurance",
    requestId,
  });
  assert.throws(() => broker.parseRequest(Buffer.from("{}\n")), { code: "ASSURANCE_REQUEST_INVALID" });
  assert.throws(() => broker.parseRequest(Buffer.from(`${"x".repeat(broker.MAX_REQUEST_BYTES)}\n`)), { code: "ASSURANCE_REQUEST_INVALID" });
  assert.throws(() => broker.parseRequest(Buffer.from(`${JSON.stringify({
    format: broker.REQUEST_FORMAT,
    schemaVersion: broker.SCHEMA_VERSION,
    action: "start-manual-assurance",
    requestId,
    unit: "attacker.service",
  })}\n`)), { code: "ASSURANCE_REQUEST_INVALID" });
});
test("RAS broker reserves one fixed root start and enforces the 15 minute root rate limit", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-ras-control-"));
  const statePath = path.join(temporary, "state.json");
  const systemctl = systemctlMock();
  try {
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o755);
    const first = broker.handleRequest(request(), {
      statePath,
      requireRootOwner: false,
      nowMs: Date.parse("2026-07-22T12:00:00.000Z"),
      spawnSync: systemctl.spawnSync,
    });
    assert.equal(first.accepted, true);
    assert.equal(first.code, "ASSURANCE_REQUEST_ACCEPTED");
    assert.deepEqual(systemctl.calls.find((call) => call[1] === "start"), [
      "/usr/bin/systemctl", "start", "--no-block", broker.ASSURANCE_UNIT,
    ]);

    const second = broker.handleRequest(request("start-manual-assurance", "02cd8c44-917d-4e17-a52c-76d7a38c841a"), {
      statePath,
      requireRootOwner: false,
      nowMs: Date.parse("2026-07-22T12:01:00.000Z"),
      spawnSync: systemctl.spawnSync,
    });
    assert.equal(second.accepted, false);
    assert.equal(second.code, "ASSURANCE_REQUEST_RATE_LIMITED");
    assert.equal(second.retryAfterSeconds, 840);
    assert.equal(systemctl.calls.filter((call) => call[1] === "start").length, 1);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("RAS broker reports a running assurance unit as busy without touching rate-limit state", () => {
  const systemctl = systemctlMock("active");
  const result = broker.handleRequest(request(), { spawnSync: systemctl.spawnSync });
  assert.equal(result.accepted, false);
  assert.equal(result.code, "ASSURANCE_REQUEST_BUSY");
  assert.equal(systemctl.calls.some((call) => call[1] === "start"), false);
});

test("RAS broker fails closed for unsafe rate-limit state", { skip: process.platform === "win32" }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-ras-control-"));
  const statePath = path.join(temporary, "state.json");
  const target = path.join(temporary, "target.json");
  try {
    fs.chmodSync(temporary, 0o755);
    fs.writeFileSync(target, "{}\n", { mode: 0o600 });
    fs.symlinkSync(target, statePath);
    assert.throws(() => broker.readRateLimitState(statePath, { requireRootOwner: false }), { code: "ASSURANCE_CONTROL_FAILED" });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("app client rejects contradictory or oversized broker responses", () => {
  const accepted = {
    format: client.RESPONSE_FORMAT,
    schemaVersion: client.SCHEMA_VERSION,
    requestId,
    accepted: true,
    code: "ASSURANCE_REQUEST_ACCEPTED",
    acceptedAt: "2026-07-22T12:00:00.000Z",
    retryAfterSeconds: null,
    scheduler: client.untrustedScheduler(),
  };
  assert.equal(client.parseResponse(Buffer.from(`${JSON.stringify(accepted)}\n`), requestId).accepted, true);
  assert.throws(() => client.parseResponse(Buffer.from(`${JSON.stringify({ ...accepted, acceptedAt: null })}\n`), requestId), {
    code: "ASSURANCE_CONTROL_RESPONSE_INVALID",
  });
  assert.throws(() => client.parseResponse(Buffer.alloc(client.MAX_RESPONSE_BYTES + 1, 1), requestId), {
    code: "ASSURANCE_CONTROL_RESPONSE_INVALID",
  });
});

test("app client exposes only BUSY, RATE_LIMITED and UNAVAILABLE control errors", { skip: process.platform === "win32" }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-ras-client-"));
  const socketPath = path.join(temporary, "request.sock");
  try {
    fs.chmodSync(temporary, 0o755);
    for (const [protocolCode, expectedCode, retryAfterSeconds] of [
      ["ASSURANCE_REQUEST_BUSY", "BUSY", null],
      ["ASSURANCE_REQUEST_RATE_LIMITED", "RATE_LIMITED", 300],
      ["ASSURANCE_CONTROL_FAILED", "UNAVAILABLE", null],
    ]) {
      const id = crypto.randomUUID();
      const server = net.createServer({ allowHalfOpen: true }, (socket) => {
        socket.resume();
        socket.on("end", () => {
          setTimeout(() => socket.end(`${JSON.stringify({
            format: client.RESPONSE_FORMAT,
            schemaVersion: client.SCHEMA_VERSION,
            requestId: id,
            accepted: false,
            code: protocolCode,
            acceptedAt: null,
            retryAfterSeconds,
            scheduler: client.untrustedScheduler(),
          })}\n`), 25);
        });
      });
      await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
      fs.chmodSync(socketPath, 0o660);
      await assert.rejects(
        client.requestRecoveryAssuranceRun({ requestId: id, socketPath, requireRootOwner: false, timeoutMs: 1000 }),
        (error) => error?.code === expectedCode && (expectedCode !== "RATE_LIMITED" || error.retryAfterSeconds === 300),
      );
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(socketPath, { force: true });
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

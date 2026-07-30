"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const client = require(path.join(root, "lib", "host-reboot-control-client.js"));

const requestId = "af24b6d2-a935-4af0-a738-69a99d106897";
const backupMarkerFileName = "dienstplan-2026-07-30T12-00-00-000Z-a1b2c3.complete.json";

function protocolResponse(code, options = {}) {
  const accepted = options.accepted === true;
  return {
    format: client.RESPONSE_FORMAT,
    schemaVersion: client.SCHEMA_VERSION,
    requestId: options.requestId || requestId,
    accepted,
    code,
    acceptedAt: accepted ? "2026-07-30T12:00:00.000Z" : null,
    retryAfterSeconds: code === "HOST_REBOOT_RATE_LIMITED"
      ? (options.retryAfterSeconds || 300)
      : null,
  };
}

test("host reboot client emits only the fixed action and exact bounded schema", () => {
  assert.deepEqual(JSON.parse(client.buildRequest(requestId, backupMarkerFileName)), {
    format: client.REQUEST_FORMAT,
    schemaVersion: client.SCHEMA_VERSION,
    action: "host-reboot",
    backupMarkerFileName,
    requestId,
  });
  assert.throws(
    () => client.buildRequest("not-a-uuid", backupMarkerFileName),
    { code: "HOST_REBOOT_CONTROL_REQUEST_INVALID" },
  );
  assert.throws(
    () => client.buildRequest(requestId, "../forged.complete.json"),
    { code: "HOST_REBOOT_CONTROL_REQUEST_INVALID" },
  );
});

test("host reboot client accepts one internally consistent response", () => {
  const accepted = protocolResponse("HOST_REBOOT_ACCEPTED", { accepted: true });
  assert.deepEqual(
    client.parseResponse(Buffer.from(`${JSON.stringify(accepted)}\n`), requestId),
    accepted,
  );
  assert.throws(
    () => client.parseResponse(
      Buffer.from(`${JSON.stringify({ ...accepted, acceptedAt: null })}\n`),
      requestId,
    ),
    { code: "HOST_REBOOT_CONTROL_RESPONSE_INVALID" },
  );
  assert.throws(
    () => client.parseResponse(
      Buffer.from(`${JSON.stringify({ ...accepted, unit: "attacker.service" })}\n`),
      requestId,
    ),
    { code: "HOST_REBOOT_CONTROL_RESPONSE_INVALID" },
  );
  assert.throws(
    () => client.parseResponse(Buffer.alloc(client.MAX_RESPONSE_BYTES + 1, 1), requestId),
    { code: "HOST_REBOOT_CONTROL_RESPONSE_INVALID" },
  );
});

test(
  "host reboot client exposes only bounded public control errors",
  { skip: process.platform === "win32" },
  async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-host-reboot-client-"));
    const socketPath = path.join(temporary, "request.sock");
    try {
      fs.chmodSync(temporary, 0o755);
      for (const [protocolCode, expectedCode, retryAfterSeconds] of [
        ["HOST_REBOOT_BUSY", "BUSY", null],
        ["HOST_REBOOT_RATE_LIMITED", "RATE_LIMITED", 300],
        ["HOST_REBOOT_NOT_REQUIRED", "NOT_REQUIRED", null],
        ["HOST_REBOOT_CONTROL_FAILED", "UNAVAILABLE", null],
      ]) {
        const id = crypto.randomUUID();
        const server = net.createServer((socket) => {
          socket.resume();
          socket.on("end", () => socket.end(`${JSON.stringify(protocolResponse(protocolCode, {
            requestId: id,
            retryAfterSeconds,
          }))}\n`));
        });
        await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
        fs.chmodSync(socketPath, 0o660);
        await assert.rejects(
          client.requestHostReboot({
            requestId: id,
            backupMarkerFileName,
            socketPath,
            requireRootOwner: false,
            timeoutMs: 1000,
          }),
          (error) => error?.code === expectedCode
            && (expectedCode !== "RATE_LIMITED" || error.retryAfterSeconds === 300),
        );
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(socketPath, { force: true });
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  },
);

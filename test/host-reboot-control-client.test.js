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

function procOneStat(startTime = "28") {
  const fields = Array(50).fill("0");
  fields[0] = "S";
  fields[19] = startTime;
  return `1 (systemd host) ${fields.join(" ")}\n`;
}

function safeProcOneMetadata(ctimeNs = 1785450333519564568n) {
  return {
    uid: 0n,
    gid: 0n,
    nlink: 9n,
    dev: 56n,
    ino: 4635890n,
    ctimeNs,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

function safeCredentialDirectoryMetadata() {
  return {
    mode: 0o40500n,
    nlink: 2n,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

function safeCredentialFileMetadata(size = 37n) {
  return {
    mode: 0o100400n,
    nlink: 1n,
    size,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

test("host boot generation prefers the bounded systemd boot-id credential", () => {
  const bootId = "8c9a6b20-2bb1-4a9e-bc2c-2d93b0d693ac";
  const credentialsDirectory = "/run/credentials/grabenplaner.service";
  const credentialPath = `${credentialsDirectory}/${client.BOOT_ID_CREDENTIAL_NAME}`;
  const expected = crypto.createHash("sha256")
    .update(`grabenplaner-host-boot:boot-id:${bootId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  const reads = [];
  assert.equal(client.readHostBootGeneration({
    platform: "linux",
    credentialsDirectory,
    readFile(file) {
      reads.push(file);
      if (file === credentialPath) return `${bootId}\n`;
      throw new Error(`unexpected fallback read: ${file}`);
    },
    lstat(file) {
      if (file === credentialsDirectory) return safeCredentialDirectoryMetadata();
      if (file === credentialPath) return safeCredentialFileMetadata();
      throw new Error(`unexpected stat: ${file}`);
    },
  }), expected);
  assert.deepEqual(reads, [credentialPath]);
});

test("host boot generation rejects unsafe systemd credential metadata before using the secure fallback", () => {
  const bootId = "8c9a6b20-2bb1-4a9e-bc2c-2d93b0d693ac";
  const credentialsDirectory = "/run/credentials/grabenplaner.service";
  const credentialPath = `${credentialsDirectory}/${client.BOOT_ID_CREDENTIAL_NAME}`;
  let credentialRead = false;
  const result = client.readHostBootGeneration({
    platform: "linux",
    credentialsDirectory,
    readFile(file) {
      if (file === credentialPath) {
        credentialRead = true;
        return `${bootId}\n`;
      }
      if (file === "/proc/sys/kernel/random/boot_id") return `${bootId}\n`;
      throw new Error(`unexpected read: ${file}`);
    },
    lstat(file) {
      if (file === credentialsDirectory) return safeCredentialDirectoryMetadata();
      if (file === credentialPath) return safeCredentialFileMetadata(65n);
      throw new Error(`unexpected stat: ${file}`);
    },
  });
  assert.equal(credentialRead, false);
  assert.match(result, /^[0-9a-f]{32}$/);
});

test("host boot generation rejects non-canonical credential content", () => {
  const bootId = "8c9a6b20-2bb1-4a9e-bc2c-2d93b0d693ac";
  const credentialsDirectory = "/run/credentials/grabenplaner.service";
  const credentialPath = `${credentialsDirectory}/${client.BOOT_ID_CREDENTIAL_NAME}`;
  const reads = [];
  const result = client.readHostBootGeneration({
    platform: "linux",
    credentialsDirectory,
    readFile(file) {
      reads.push(file);
      if (file === credentialPath) return ` ${bootId}\n`;
      if (file === "/proc/sys/kernel/random/boot_id") return `${bootId}\n`;
      throw new Error(`unexpected read: ${file}`);
    },
    lstat(file) {
      if (file === credentialsDirectory) return safeCredentialDirectoryMetadata();
      if (file === credentialPath) return safeCredentialFileMetadata(38n);
      throw new Error(`unexpected stat: ${file}`);
    },
  });
  assert.deepEqual(reads, [credentialPath, "/proc/sys/kernel/random/boot_id"]);
  assert.match(result, /^[0-9a-f]{32}$/);
});

test("host boot generation uses the kernel boot id when the service namespace exposes it", () => {
  const bootId = "8c9a6b20-2bb1-4a9e-bc2c-2d93b0d693ac";
  const expected = crypto.createHash("sha256")
    .update(`grabenplaner-host-boot:boot-id:${bootId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  assert.equal(client.readHostBootGeneration({
    platform: "linux",
    readFile: () => `${bootId}\n`,
    lstat: () => { throw new Error("PID 1 fallback must not run"); },
  }), expected);
});

test("host boot generation falls back to stable root-owned PID 1 metadata under ProcSubset=pid", () => {
  const readFile = (file) => {
    if (file === "/proc/sys/kernel/random/boot_id") {
      const error = new Error("hidden by ProcSubset");
      error.code = "ENOENT";
      throw error;
    }
    if (file === "/proc/1/stat") return procOneStat();
    throw new Error(`unexpected read: ${file}`);
  };
  const first = client.readHostBootGeneration({
    platform: "linux",
    readFile,
    lstat: () => safeProcOneMetadata(),
  });
  const repeated = client.readHostBootGeneration({
    platform: "linux",
    readFile,
    lstat: () => safeProcOneMetadata(),
  });
  const nextBoot = client.readHostBootGeneration({
    platform: "linux",
    readFile,
    lstat: () => safeProcOneMetadata(1785450999999999999n),
  });
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(repeated, first);
  assert.notEqual(nextBoot, first);
});

test("host boot generation rejects unsafe PID 1 fallback metadata and non-Linux hosts", () => {
  const hiddenBootId = (file) => {
    if (file === "/proc/1/stat") return procOneStat();
    throw Object.assign(new Error("hidden"), { code: "ENOENT" });
  };
  assert.equal(client.readHostBootGeneration({
    platform: "linux",
    readFile: hiddenBootId,
    lstat: () => ({ ...safeProcOneMetadata(), uid: 1000n }),
  }), null);
  assert.equal(client.readHostBootGeneration({
    platform: "linux",
    readFile: hiddenBootId,
    lstat: () => ({ ...safeProcOneMetadata(), isSymbolicLink: () => true }),
  }), null);
  assert.equal(client.readHostBootGeneration({
    platform: "win32",
    readFile: () => { throw new Error("must not read"); },
  }), null);
});

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
        const server = net.createServer({ allowHalfOpen: true }, (socket) => {
          socket.resume();
          socket.on("end", () => {
            setTimeout(() => socket.end(`${JSON.stringify(protocolResponse(protocolCode, {
              requestId: id,
              retryAfterSeconds,
            }))}\n`), 25);
          });
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

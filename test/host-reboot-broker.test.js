"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const broker = require(path.join(
  root,
  "server-tools",
  "linux",
  "host-control",
  "lib",
  "host-reboot-broker.js",
));

const requestId = "af24b6d2-a935-4af0-a738-69a99d106897";
const backupMarkerFileName = "dienstplan-2026-07-30T12-00-00-000Z-a1b2c3.complete.json";
const protectedStorageKey = "ab/11111111-1111-4111-8111-111111111111.amu";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function request(id = requestId, extra = {}) {
  return Buffer.from(`${JSON.stringify({
    format: broker.REQUEST_FORMAT,
    schemaVersion: broker.SCHEMA_VERSION,
    action: "host-reboot",
    backupMarkerFileName,
    requestId: id,
    ...extra,
  })}\n`);
}

function systemctlMock(activeState = "inactive") {
  const calls = [];
  const spawnSync = (command, args) => {
    calls.push([command, ...args]);
    if (command === "/usr/bin/flock") return { status: 0, stdout: "" };
    if (args[0] === "show") {
      return {
        status: 0,
        stdout: `LoadState=loaded\nFragmentPath=${broker.REBOOT_UNIT_FRAGMENT}\nActiveState=${activeState}\n`,
      };
    }
    if (args[0] === "start") return { status: 0, stdout: "" };
    return { status: 1, stdout: "" };
  };
  return { calls, spawnSync };
}

function fixture(nowMs = Date.now()) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-host-reboot-broker-"));
  if (process.platform !== "win32") fs.chmodSync(temporary, 0o755);
  const markerPath = path.join(temporary, "reboot-required");
  fs.writeFileSync(markerPath, "System restart required\n", { mode: 0o644 });
  const backupDirectory = path.join(temporary, "backups");
  const snapshot = backupMarkerFileName.replace(/\.complete\.json$/, "");
  const databasePath = path.join(backupDirectory, `${snapshot}.db`);
  const protectedDirectory = path.join(backupDirectory, `${snapshot}.amu`);
  const protectedManifestPath = path.join(protectedDirectory, "manifest.json");
  const keyCheckPath = path.join(protectedDirectory, "key-check.amu");
  const protectedFilePath = path.join(
    protectedDirectory,
    "blobs",
    ...protectedStorageKey.split("/"),
  );
  fs.mkdirSync(path.dirname(protectedFilePath), { recursive: true });
  if (process.platform !== "win32") {
    fs.chmodSync(backupDirectory, 0o755);
    fs.chmodSync(protectedDirectory, 0o750);
    fs.chmodSync(path.join(protectedDirectory, "blobs"), 0o750);
    fs.chmodSync(path.dirname(protectedFilePath), 0o750);
  }
  fs.writeFileSync(databasePath, "SQLite format 3\u0000verified reboot backup\n", { mode: 0o640 });
  const keyCheckContent = Buffer.from("GPAMU002 verified key check\n", "utf8");
  const protectedFileContent = Buffer.from("GPAMU002 verified protected document\n", "utf8");
  fs.writeFileSync(keyCheckPath, keyCheckContent, { mode: 0o640 });
  fs.writeFileSync(protectedFilePath, protectedFileContent, { mode: 0o640 });
  const databaseBytes = fs.statSync(databasePath).size;
  const databaseSha256 = sha256(fs.readFileSync(databasePath));
  const committedAt = new Date(nowMs).toISOString();
  fs.writeFileSync(protectedManifestPath, `${JSON.stringify({
    format: "grabenplaner-amu-backup",
    version: 1,
    createdAt: committedAt,
    database: {
      fileName: `${snapshot}.db`,
      sha256: databaseSha256,
    },
    keyCheck: {
      fileName: "key-check.amu",
      byteSize: keyCheckContent.length,
      sha256: sha256(keyCheckContent),
    },
    files: [{
      storageKey: protectedStorageKey,
      byteSize: protectedFileContent.length,
      sha256: sha256(protectedFileContent),
    }],
  }, null, 2)}\n`, { mode: 0o640 });
  const manifestBytes = fs.statSync(protectedManifestPath).size;
  const manifestSha256 = sha256(fs.readFileSync(protectedManifestPath));
  const backupMarkerPath = path.join(backupDirectory, backupMarkerFileName);
  fs.writeFileSync(backupMarkerPath, `${JSON.stringify({
    format: "grabenplaner-backup-commit",
    schemaVersion: 1,
    snapshot,
    committedAt,
    database: {
      fileName: `${snapshot}.db`,
      sha256: databaseSha256,
      bytes: databaseBytes,
    },
    protectedDocuments: {
      directoryName: `${snapshot}.amu`,
      files: 1,
      manifestFileName: "manifest.json",
      manifestSha256,
      manifestBytes,
    },
    verification: { status: "verified", verifiedAt: committedAt },
  })}\n`, { mode: 0o600 });
  fs.utimesSync(backupMarkerPath, new Date(nowMs), new Date(nowMs));

  const hostSecurityStatusPath = path.join(temporary, "host-security.json");
  fs.writeFileSync(hostSecurityStatusPath, `${JSON.stringify({
    format: "grabenplaner-host-security-status",
    schemaVersion: 1,
    checkedAt: committedAt,
    state: "warning",
    configured: true,
    pendingConfirmation: false,
    rebootRequired: true,
    checks: {
      ssh: true,
      firewall: true,
      publicPorts: true,
      automaticUpdates: true,
      sysctl: true,
      journald: true,
      accountProtection: true,
      secretFiles: true,
      failedUnits: true,
      timeSync: true,
    },
  })}\n`, { mode: 0o600 });
  const maintenanceDirectory = path.join(temporary, "maintenance");
  fs.mkdirSync(maintenanceDirectory);
  if (process.platform !== "win32") fs.chmodSync(maintenanceDirectory, 0o755);
  const maintenanceLockPath = path.join(maintenanceDirectory, "maintenance.lock");
  fs.writeFileSync(maintenanceLockPath, "", { mode: 0o600 });
  const controlDirectory = path.join(temporary, "control");
  fs.mkdirSync(controlDirectory);
  if (process.platform !== "win32") fs.chmodSync(controlDirectory, 0o755);
  const pendingPath = path.join(controlDirectory, "reboot-pending.json");
  const armedPath = path.join(controlDirectory, "reboot-armed.json");
  return {
    temporary,
    markerPath,
    statePath: path.join(temporary, "state.json"),
    backupDirectory,
    backupMarkerPath,
    databasePath,
    protectedDirectory,
    protectedManifestPath,
    keyCheckPath,
    protectedFilePath,
    hostSecurityStatusPath,
    maintenanceLockPath,
    pendingPath,
    armedPath,
    options: {
      rebootRequiredPath: markerPath,
      allowAlternateMarkerPath: true,
      backupDirectory,
      allowAlternateBackupDirectory: true,
      hostSecurityStatusPath,
      allowAlternateHostSecurityStatusPath: true,
      maintenanceLockPath,
      allowAlternateMaintenanceLockPath: true,
      pendingPath,
      armedPath,
      requireRootOwner: false,
      afterUnitStart({ armedPath: target, requestId: id, acceptedAt }) {
        fs.writeFileSync(target, `${JSON.stringify({
          format: "grabenplaner-host-reboot-armed",
          schemaVersion: 1,
          requestId: id,
          requestedAt: acceptedAt,
        })}\n`, { mode: 0o600 });
      },
    },
  };
}

function rewriteBackupMarker(current, mutate) {
  const marker = JSON.parse(fs.readFileSync(current.backupMarkerPath, "utf8"));
  mutate(marker);
  fs.writeFileSync(current.backupMarkerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  const committed = new Date(marker.committedAt);
  fs.utimesSync(current.backupMarkerPath, committed, committed);
}

test('root-owned read-only status group is accepted; non-root writers and link aliases are rejected', {
  skip: process.platform !== 'linux' || process.getuid() !== 0,
}, t => {
  const value = fixture(); t.after(() => fs.rmSync(value.temporary, { recursive: true, force: true }));
  const options = { ...value.options, requireRootOwner: true };
  fs.chownSync(value.hostSecurityStatusPath, 0, 65534);
  fs.chmodSync(value.hostSecurityStatusPath, 0o640);
  assert.equal(broker.assertHostSecurityAllowsReboot(Date.now(), options), true);
  fs.chmodSync(value.hostSecurityStatusPath, 0o660);
  assert.throws(() => broker.assertHostSecurityAllowsReboot(Date.now(), options));
  fs.chmodSync(value.hostSecurityStatusPath, 0o640);
  fs.chownSync(value.hostSecurityStatusPath, 65534, 65534);
  assert.throws(() => broker.assertHostSecurityAllowsReboot(Date.now(), options));
  fs.chownSync(value.hostSecurityStatusPath, 0, 65534);
  const alias = value.hostSecurityStatusPath + '.alias';
  fs.linkSync(value.hostSecurityStatusPath, alias);
  assert.throws(() => broker.assertHostSecurityAllowsReboot(Date.now(), options));
  fs.unlinkSync(alias);
  fs.renameSync(value.hostSecurityStatusPath, alias);
  fs.symlinkSync(alias, value.hostSecurityStatusPath);
  assert.throws(() => broker.assertHostSecurityAllowsReboot(Date.now(), options));
});

test('reboot state preparation creates only a private directory and preserves existing history', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-reboot-prepare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const statePath = path.join(root, 'state', 'state.json');
  const options = { statePath, allowAlternateStatePath: true, requireRootOwner: false };
  assert.throws(() => broker.ensureStateDirectory({ statePath }));
  broker.ensureStateDirectory(options);
  assert.equal(fs.statSync(path.dirname(statePath)).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(statePath), false);
  fs.writeFileSync(statePath, 'preserved-cooldown', { mode: 0o600 });
  broker.ensureStateDirectory(options);
  assert.equal(fs.readFileSync(statePath, 'utf8'), 'preserved-cooldown');
  fs.chmodSync(path.dirname(statePath), 0o777);
  assert.throws(() => broker.ensureStateDirectory(options));
  fs.chmodSync(path.dirname(statePath), 0o700);
  fs.symlinkSync(path.dirname(statePath), path.join(root, 'alias'));
  assert.throws(() => broker.ensureStateDirectory({ ...options, statePath: path.join(root, 'alias', 'state.json') }));
});

function rewriteProtectedManifest(current, mutate) {
  const manifest = JSON.parse(fs.readFileSync(current.protectedManifestPath, "utf8"));
  mutate(manifest);
  fs.writeFileSync(
    current.protectedManifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o640 },
  );
  rewriteBackupMarker(current, (marker) => {
    marker.protectedDocuments.manifestBytes = fs.statSync(current.protectedManifestPath).size;
    marker.protectedDocuments.manifestSha256 = sha256(
      fs.readFileSync(current.protectedManifestPath),
    );
  });
}

function assertBackupRejected(current, nowMs) {
  assert.throws(
    () => broker.assertVerifiedBackupEvidence(
      backupMarkerFileName,
      nowMs,
      current.options,
    ),
    { code: "HOST_REBOOT_BACKUP_REQUIRED" },
  );
}

test("host reboot broker accepts only the exact fixed protocol", () => {
  assert.deepEqual(broker.parseRequest(request()), {
    format: broker.REQUEST_FORMAT,
    schemaVersion: broker.SCHEMA_VERSION,
    action: "host-reboot",
    backupMarkerFileName,
    requestId,
  });
  assert.throws(() => broker.parseRequest(Buffer.from("{}\n")), {
    code: "HOST_REBOOT_REQUEST_INVALID",
  });
  assert.throws(
    () => broker.parseRequest(Buffer.from(`${"x".repeat(broker.MAX_REQUEST_BYTES)}\n`)),
    { code: "HOST_REBOOT_REQUEST_INVALID" },
  );
  assert.throws(
    () => broker.parseRequest(request(requestId, { unit: "attacker.service" })),
    { code: "HOST_REBOOT_REQUEST_INVALID" },
  );
});

test("host reboot broker refuses a missing reboot-required marker without systemctl", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-host-reboot-missing-"));
  const systemctl = systemctlMock();
  try {
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o755);
    const result = broker.handleRequest(request(), {
      rebootRequiredPath: path.join(temporary, "missing"),
      allowAlternateMarkerPath: true,
      requireRootOwner: false,
      spawnSync: systemctl.spawnSync,
    });
    assert.equal(result.accepted, false);
    assert.equal(result.code, "HOST_REBOOT_NOT_REQUIRED");
    assert.equal(systemctl.calls.length, 0);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("host reboot broker starts exactly one fixed unit and enforces root cooldown", () => {
  const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
  const current = fixture(nowMs);
  const systemctl = systemctlMock();
  try {
    const first = broker.handleRequest(request(), {
      ...current.options,
      statePath: current.statePath,
      nowMs,
      spawnSync: systemctl.spawnSync,
    });
    assert.equal(first.accepted, true);
    assert.equal(first.code, "HOST_REBOOT_ACCEPTED");
    assert.deepEqual(systemctl.calls.find((call) => call[1] === "start"), [
      "/usr/bin/systemctl",
      "start",
      "--no-block",
      broker.REBOOT_UNIT,
    ]);

    const second = broker.handleRequest(
      request("b6619008-5dd7-46bb-9456-08f2ee262963"),
      {
        ...current.options,
        statePath: current.statePath,
        nowMs: Date.parse("2026-07-30T12:01:00.000Z"),
        spawnSync: systemctl.spawnSync,
      },
    );
    assert.equal(second.accepted, false);
    assert.equal(second.code, "HOST_REBOOT_RATE_LIMITED");
    assert.equal(second.retryAfterSeconds, 840);
    assert.equal(systemctl.calls.filter((call) => call[1] === "start").length, 1);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("host reboot broker treats the fixed worker as busy without reserving cooldown", () => {
  const current = fixture();
  const systemctl = systemctlMock("activating");
  try {
    const result = broker.handleRequest(request(), {
      ...current.options,
      statePath: current.statePath,
      spawnSync: systemctl.spawnSync,
    });
    assert.equal(result.accepted, false);
    assert.equal(result.code, "HOST_REBOOT_BUSY");
    assert.equal(fs.existsSync(current.statePath), false);
    assert.equal(systemctl.calls.some((call) => call[1] === "start"), false);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("host reboot broker fails closed for a foreign fixed-unit fragment", () => {
  const current = fixture();
  const calls = [];
  const spawnSync = (command, args) => {
    calls.push([command, ...args]);
    if (command === "/usr/bin/flock") return { status: 0, stdout: "" };
    if (args[0] === "show") {
      return {
        status: 0,
        stdout: "LoadState=loaded\nFragmentPath=/tmp/attacker.service\nActiveState=inactive\n",
      };
    }
    return { status: 1, stdout: "" };
  };
  try {
    const result = broker.handleRequest(request(), {
      ...current.options,
      statePath: current.statePath,
      spawnSync,
    });
    assert.equal(result.accepted, false);
    assert.equal(result.code, "HOST_REBOOT_CONTROL_FAILED");
    assert.equal(calls.some((call) => call[1] === "start"), false);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test(
  "host reboot broker rejects a symlinked reboot-required marker",
  { skip: process.platform === "win32" },
  () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-host-reboot-link-"));
    const target = path.join(temporary, "target");
    const markerPath = path.join(temporary, "reboot-required");
    try {
      fs.chmodSync(temporary, 0o755);
      fs.writeFileSync(target, "required\n", { mode: 0o644 });
      fs.symlinkSync(target, markerPath);
      assert.throws(
        () => broker.assertRebootRequired(markerPath, {
          allowAlternateMarkerPath: true,
          requireRootOwner: false,
        }),
        { code: "HOST_REBOOT_CONTROL_FAILED" },
      );
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  },
);

test("host reboot broker requires a fresh root-verifiable backup marker", () => {
  const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
  const current = fixture(nowMs);
  const systemctl = systemctlMock();
  try {
    fs.rmSync(path.join(current.backupDirectory, backupMarkerFileName));
    const result = broker.handleRequest(request(), {
      ...current.options,
      statePath: current.statePath,
      nowMs,
      spawnSync: systemctl.spawnSync,
    });
    assert.equal(result.accepted, false);
    assert.equal(result.code, "HOST_REBOOT_BACKUP_REQUIRED");
    assert.equal(systemctl.calls.some((call) => call[1] === "start"), false);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("host reboot broker verifies every protected file hash", () => {
  const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
  const current = fixture(nowMs);
  try {
    const tampered = fs.readFileSync(current.protectedFilePath);
    tampered[tampered.length - 2] ^= 0xff;
    fs.writeFileSync(current.protectedFilePath, tampered, { mode: 0o640 });
    assertBackupRejected(current, nowMs);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("host reboot broker verifies every protected file size", () => {
  const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
  const current = fixture(nowMs);
  try {
    rewriteProtectedManifest(current, (manifest) => {
      manifest.files[0].byteSize += 1;
    });
    assertBackupRejected(current, nowMs);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("host reboot broker rejects a missing manifest-referenced protected file", () => {
  const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
  const current = fixture(nowMs);
  try {
    fs.rmSync(current.keyCheckPath);
    assertBackupRejected(current, nowMs);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("host reboot broker rejects fields outside the exact protected-manifest schema", () => {
  const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
  const current = fixture(nowMs);
  try {
    rewriteProtectedManifest(current, (manifest) => {
      manifest.untrustedExtension = true;
    });
    assertBackupRejected(current, nowMs);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("host reboot broker binds the exact protected-file count to the commit marker", () => {
  const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
  const current = fixture(nowMs);
  try {
    rewriteBackupMarker(current, (marker) => {
      marker.protectedDocuments.files = 0;
    });
    assertBackupRejected(current, nowMs);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("host reboot broker binds the protected manifest to the verified database", () => {
  const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
  const current = fixture(nowMs);
  try {
    rewriteProtectedManifest(current, (manifest) => {
      manifest.database.sha256 = "f".repeat(64);
    });
    assertBackupRejected(current, nowMs);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("host reboot broker rejects unsafe protected paths despite a matching manifest hash", () => {
  const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
  const current = fixture(nowMs);
  try {
    rewriteProtectedManifest(current, (manifest) => {
      manifest.files[0].storageKey = "../attacker.amu";
    });
    assertBackupRejected(current, nowMs);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("host reboot broker rejects files not declared by the protected manifest", () => {
  const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
  const current = fixture(nowMs);
  try {
    fs.writeFileSync(
      path.join(current.protectedDirectory, "unmanifested.amu"),
      "not declared\n",
      { mode: 0o640 },
    );
    assertBackupRejected(current, nowMs);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("host reboot broker blocks an open host-hardening confirmation", () => {
  const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
  const current = fixture(nowMs);
  const systemctl = systemctlMock();
  try {
    const status = JSON.parse(fs.readFileSync(current.hostSecurityStatusPath, "utf8"));
    status.pendingConfirmation = true;
    fs.writeFileSync(current.hostSecurityStatusPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    const result = broker.handleRequest(request(), {
      ...current.options,
      statePath: current.statePath,
      nowMs,
      spawnSync: systemctl.spawnSync,
    });
    assert.equal(result.accepted, false);
    assert.equal(result.code, "HOST_REBOOT_SECURITY_PENDING");
    assert.equal(systemctl.calls.some((call) => call[1] === "start"), false);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("host reboot broker blocks another central maintenance operation", () => {
  const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
  const current = fixture(nowMs);
  const systemctl = systemctlMock();
  const spawnSync = (command, args) => {
    if (command === "/usr/bin/flock") return { status: 1, stdout: "" };
    return systemctl.spawnSync(command, args);
  };
  try {
    const result = broker.handleRequest(request(), {
      ...current.options,
      statePath: current.statePath,
      nowMs,
      spawnSync,
    });
    assert.equal(result.accepted, false);
    assert.equal(result.code, "HOST_REBOOT_MAINTENANCE_BUSY");
    assert.equal(systemctl.calls.some((call) => call[1] === "start"), false);
  } finally {
    fs.rmSync(current.temporary, { recursive: true, force: true });
  }
});

test("host reboot broker creates only the fixed root maintenance lock when absent", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-host-lock-"));
  const lockPath = path.join(temporary, "maintenance.lock");
  try {
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o755);
    assert.equal(
      broker.ensureMaintenanceLock({
        maintenanceLockPath: lockPath,
        allowAlternateMaintenanceLockPath: true,
        requireRootOwner: false,
      }),
      path.resolve(lockPath),
    );
    const stat = fs.lstatSync(lockPath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    if (process.platform !== "win32") assert.equal(stat.mode & 0o7777, 0o600);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

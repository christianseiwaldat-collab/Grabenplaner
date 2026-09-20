"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CHECK_IDS,
  LEGACY_CHECK_IDS,
  LEGACY_STATUS_SCHEMA_VERSION,
  MAX_STATUS_BYTES,
  STATUS_FORMAT,
  STATUS_SCHEMA_VERSION,
  diagnosticsFromStatus,
  parseServerMonitorStatus,
  readServerMonitorStatus,
} = require("../lib/server-monitor-status");

function validStatus(overrides = {}) {
  return {
    format: STATUS_FORMAT,
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: "2026-07-20T12:00:00.000Z",
    state: "ok",
    complete: true,
    consecutiveLiveFailures: 0,
    lastRestartAt: null,
    checks: Object.fromEntries(CHECK_IDS.map((id) => [id, true])),
    recovery: { attempted: false, successful: false, suppressed: false },
    lastError: null,
    ...overrides,
  };
}

function legacyStatus(overrides = {}) {
  return {
    ...validStatus(),
    schemaVersion: LEGACY_STATUS_SCHEMA_VERSION,
    checks: Object.fromEntries(LEGACY_CHECK_IDS.map((id) => [id, true])),
    ...overrides,
  };
}

function withStatusFile(payload, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-monitor-status-"));
  const statusPath = path.join(root, "status.json");
  try {
    fs.writeFileSync(statusPath, `${JSON.stringify(payload)}\n`, { mode: 0o640 });
    return callback(statusPath, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("v0.74 accepts only the exact allowlisted monitor schema and returns no path or free text", () => {
  withStatusFile(validStatus(), (statusPath) => {
    const result = readServerMonitorStatus({
      configured: true,
      statusPath,
      requireRootOwner: false,
      now: new Date("2026-07-20T12:15:00.000Z"),
    });
    assert.equal(result.state, "ok");
    assert.equal(result.statusAvailable, true);
    assert.equal(result.ageHours, 0.25);
    assert.deepEqual(Object.keys(result.checks), CHECK_IDS);
    assert.deepEqual(result.failedChecks, []);
    for (const forbidden of ["path", "url", "summary", "httpStatus", "response", "secret"]) {
      assert.equal(JSON.stringify(result).toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
    }
  });

  assert.throws(() => parseServerMonitorStatus({ ...validStatus(), unexpected: true }), /freigegebenen Schema/);
  assert.throws(() => parseServerMonitorStatus(validStatus({ checks: { ...validStatus().checks, live: "yes" } })), /ungueltigen Wert/);
  const withoutCheck = validStatus();
  delete withoutCheck.checks.monitorTimer;
  assert.throws(() => parseServerMonitorStatus(withoutCheck), /freigegebenen Schema/);
});

test("v0.86.2 reads the legacy schema without inventing unavailable security checks", () => {
  const parsed = parseServerMonitorStatus(legacyStatus());
  const diagnostics = diagnosticsFromStatus(parsed, {
    now: new Date("2026-07-20T12:15:00.000Z"),
  });
  assert.equal(parsed.schemaVersion, LEGACY_STATUS_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(parsed.checks), LEGACY_CHECK_IDS);
  assert.deepEqual(diagnostics.failedChecks, []);
  assert.equal(diagnostics.state, "ok");
});

test("v0.74 rejects contradictory recovery, state and error values", () => {
  assert.throws(() => parseServerMonitorStatus(validStatus({ recovery: { attempted: false, successful: true, suppressed: false } })), /vorherigen Versuch/);
  assert.throws(() => parseServerMonitorStatus(validStatus({ checks: { ...validStatus().checks, ready: false } })), /widerspricht/);
  assert.throws(() => parseServerMonitorStatus(validStatus({
    state: "error",
    lastError: { code: "TOKEN=secret", at: "2026-07-20T11:59:00.000Z" },
  })), /freigegebenen Fehlercode/);
  const parsed = parseServerMonitorStatus(validStatus({
    state: "error",
    complete: false,
    checks: { ...validStatus().checks, ready: false },
    lastError: { code: "MONITOR_RUN_FAILED", at: "2026-07-20T11:59:00.000Z" },
  }));
  assert.equal(parsed.lastError.code, "MONITOR_RUN_FAILED");
});

test("daily monitoring accepts the daily interval but detects a missed next check", () => {
  const status = parseServerMonitorStatus(validStatus());
  const daily = diagnosticsFromStatus(status, { now: new Date("2026-07-21T11:00:00Z") });
  assert.equal(daily.state, "ok");
  assert.equal(daily.maximumAgeHours, 30);
  assert.equal(daily.stale, false);
  const missed = diagnosticsFromStatus(status, { now: new Date("2026-07-21T19:00:00Z") });
  assert.equal(missed.stale, true);
  assert.equal(missed.state, "warning");
});

test("v0.74 treats future and stale monitor timestamps as non-blocking operational warnings", () => {
  const future = diagnosticsFromStatus(parseServerMonitorStatus(validStatus({ generatedAt: "2099-07-20T12:00:00.000Z" })), {
    now: new Date("2026-07-20T12:00:00.000Z"),
  });
  assert.equal(future.state, "error");
  assert.equal(future.lastErrorCode, "MONITOR_STATUS_TIMESTAMP_FUTURE");
  assert.equal(future.blocksMainReadiness, false);

  const stale = diagnosticsFromStatus(parseServerMonitorStatus(validStatus()), {
    now: new Date("2026-07-20T14:00:00.000Z"),
    maximumAgeHours: 1,
  });
  assert.equal(stale.state, "warning");
  assert.equal(stale.lastErrorCode, "MONITOR_STATUS_STALE");
  assert.equal(stale.blocksMainReadiness, false);
});

test("v0.74 degrades cleanly when monitoring is unconfigured, missing or invalid", () => {
  const unconfigured = readServerMonitorStatus({ configured: false, statusPath: "not-an-absolute-path" });
  assert.equal(unconfigured.state, "unconfigured");
  assert.equal(unconfigured.lastErrorCode, null);
  assert.equal(unconfigured.statusAvailable, false);

  const missing = path.join(os.tmpdir(), `missing-grabenplaner-monitor-${process.pid}-${Date.now()}.json`);
  const configuredMissing = readServerMonitorStatus({ configured: true, statusPath: missing, requireRootOwner: false });
  assert.equal(configuredMissing.state, "error");
  assert.equal(configuredMissing.lastErrorCode, "MONITOR_STATUS_FILE_MISSING");
  assert.equal(configuredMissing.blocksMainReadiness, false);

  withStatusFile({ ...validStatus(), schemaVersion: 3 }, (statusPath) => {
    const invalid = readServerMonitorStatus({ configured: true, statusPath, requireRootOwner: false });
    assert.equal(invalid.state, "error");
    assert.equal(invalid.lastErrorCode, "MONITOR_STATUS_SCHEMA_INVALID");
  });
});

test("v0.74 rejects unsafe, linked and oversized status files", () => {
  withStatusFile(validStatus(), (statusPath, root) => {
    const hardLink = path.join(root, "status-hardlink.json");
    fs.linkSync(statusPath, hardLink);
    const linked = readServerMonitorStatus({ configured: true, statusPath, requireRootOwner: false });
    assert.equal(linked.lastErrorCode, "MONITOR_STATUS_FILE_SIZE_INVALID");
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-monitor-oversized-"));
  try {
    const statusPath = path.join(root, "status.json");
    fs.writeFileSync(statusPath, Buffer.alloc(MAX_STATUS_BYTES + 1, 0x20));
    const oversized = readServerMonitorStatus({ configured: true, statusPath, requireRootOwner: false });
    assert.equal(oversized.lastErrorCode, "MONITOR_STATUS_FILE_SIZE_INVALID");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("v0.74 rejects symbolic links and group-writable monitor status on POSIX", { skip: process.platform === "win32" }, () => {
  withStatusFile(validStatus(), (statusPath, root) => {
    const target = path.join(root, "target.json");
    fs.renameSync(statusPath, target);
    fs.symlinkSync(target, statusPath);
    const linked = readServerMonitorStatus({ configured: true, statusPath, requireRootOwner: false });
    assert.equal(linked.lastErrorCode, "MONITOR_STATUS_FILE_UNSAFE");
  });
  withStatusFile(validStatus(), (statusPath) => {
    fs.chmodSync(statusPath, 0o660);
    const writable = readServerMonitorStatus({ configured: true, statusPath, requireRootOwner: false });
    assert.equal(writable.lastErrorCode, "MONITOR_STATUS_FILE_PERMISSIONS_INVALID");
  });
});

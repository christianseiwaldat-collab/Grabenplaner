"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CHECK_IDS,
  parseHostSecurityStatus,
  readHostSecurityStatus,
} = require("../lib/host-security-status");

function validStatus(overrides = {}) {
  return {
    format: "grabenplaner-host-security-status",
    schemaVersion: 1,
    checkedAt: "2026-07-20T10:00:00.000Z",
    state: "ok",
    configured: true,
    pendingConfirmation: false,
    rebootRequired: false,
    checks: Object.fromEntries(CHECK_IDS.map((id) => [id, true])),
    ...overrides,
  };
}

test("v0.75 accepts only the exact redacted host-security status schema", () => {
  const parsed = parseHostSecurityStatus(validStatus());
  assert.equal(parsed.state, "ok");
  assert.deepEqual(Object.keys(parsed.checks), CHECK_IDS);
  assert.throws(() => parseHostSecurityStatus({ ...validStatus(), path: "/secret" }), /Schema/);
  assert.throws(() => parseHostSecurityStatus(validStatus({ checks: { ...validStatus().checks, ssh: "yes" } })), /ungueltig/);
  assert.throws(() => parseHostSecurityStatus(validStatus({ pendingConfirmation: true })), /widerspruechlich/);
});

test("v0.75 never exposes paths, users, ports or source addresses in host-security status", () => {
  const parsed = parseHostSecurityStatus(validStatus());
  const serialized = JSON.stringify(parsed);
  for (const forbidden of ["/etc/", "/var/", "admin", "203.0.113.10", "22", "password", "token"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false);
  }
});

test("v0.75 degrades stale or unavailable host-security status without blocking app readiness", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-host-status-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statusPath = path.join(root, "status.json");
  fs.writeFileSync(statusPath, `${JSON.stringify(validStatus())}\n`, { mode: 0o640 });
  const stale = readHostSecurityStatus({ statusPath, configured: true, requireRootOwner: false, now: Date.parse("2026-07-22T10:00:00Z") });
  assert.equal(stale.state, "warning");
  assert.equal(stale.lastErrorCode, "HOST_SECURITY_STATUS_STALE");
  const missing = readHostSecurityStatus({ statusPath: path.join(root, "missing.json"), configured: true, requireRootOwner: false });
  assert.equal(missing.state, "error");
  assert.equal(missing.statusAvailable, false);
});

test("v0.75 never downgrades an error status when its timestamp is in the future", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-host-security-future-error-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statusPath = path.join(directory, "status.json");
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  fs.writeFileSync(statusPath, JSON.stringify({
    ...validStatus(),
    checkedAt: future,
    state: "error",
    checks: { ...validStatus().checks, firewall: false },
  }));

  const status = readHostSecurityStatus({ statusPath, configured: true, requireRootOwner: false });
  assert.equal(status.state, "error");
  assert.equal(status.lastErrorCode, "HOST_SECURITY_STATUS_TIMESTAMP_FUTURE");
  assert.deepEqual(status.failedChecks, ["firewall"]);
});

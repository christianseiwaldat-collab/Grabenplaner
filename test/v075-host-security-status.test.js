"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CHECK_IDS,
  buildHostSecurityAlerts,
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

test("v0.80 accepts RFC3339 nanoseconds emitted by Ubuntu coreutils", () => {
  const parsed = parseHostSecurityStatus(validStatus({
    checkedAt: "2026-07-22T22:08:00.412111564Z",
  }));
  assert.equal(parsed.checkedAt, "2026-07-22T22:08:00.412Z");
  assert.throws(() => parseHostSecurityStatus(validStatus({
    checkedAt: "2026-07-22T22:08:00.4121115640Z",
  })), /ungueltig/);
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
  const justExpired = readHostSecurityStatus({ statusPath, configured: true, requireRootOwner: false,
    now: Date.parse(validStatus().checkedAt) + 36 * 60 * 60 * 1000 + 1 });
  assert.equal(justExpired.ageHours, 36, "the display rounds independently of the expiry gate");
  assert.equal(justExpired.lastErrorCode, "HOST_SECURITY_STATUS_STALE");
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

function auditedStatus(overrides = {}) {
  const parsed = parseHostSecurityStatus(validStatus(overrides));
  return {
    ...parsed, statusAvailable: true, lastErrorCode: null,
    failedChecks: CHECK_IDS.filter(id => parsed.checks[id] === false),
    unknownChecks: CHECK_IDS.filter(id => parsed.checks[id] === null),
  };
}

test("maintenance stays one stable warning while new audit errors remain separate", () => {
  const reboot = auditedStatus({ state: "warning", rebootRequired: true });
  const alerts = buildHostSecurityAlerts(reboot);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].id, "HOST_REBOOT_REQUIRED");
  assert.equal(alerts[0].severity, "warning");
  assert.deepEqual(buildHostSecurityAlerts({ ...reboot, checkedAt: "2026-07-21T10:00:00.000Z", ageHours: 1 }), alerts);
  const mixed = buildHostSecurityAlerts(auditedStatus({
    state: "error", rebootRequired: true,
    checks: { ...validStatus().checks, publicPorts: false, failedUnits: false },
  }));
  assert.deepEqual(mixed.map(alert => [alert.id, alert.severity]), [
    ["HOST_SECURITY_ATTENTION", "critical"], ["HOST_SERVICES_ATTENTION", "warning"], ["HOST_REBOOT_REQUIRED", "warning"],
  ]);
  assert.match(mixed[0].message, /Ports/);
  assert.doesNotMatch(mixed[0].message, /Neustart/);
  assert.equal(buildHostSecurityAlerts(auditedStatus()).length, 0);
});

test("unconfirmed checks retain the existing nullable schema and never imply successful isolation", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-host-unknown-"));
  context.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const statusPath = path.join(directory, "status.json");
  const value = validStatus({ state: "warning", checks: { ...validStatus().checks, publicPorts: null } });
  fs.writeFileSync(statusPath, JSON.stringify(value), { mode: 0o640 });
  const status = readHostSecurityStatus({ statusPath, configured: true, requireRootOwner: false, now: Date.parse(value.checkedAt) });
  assert.deepEqual(status.unknownChecks, ["publicPorts"]);
  assert.deepEqual(status.failedChecks, []);
  assert.equal(buildHostSecurityAlerts(status)[0].id, "HOST_SECURITY_CHECK_INCOMPLETE");
  assert.throws(() => parseHostSecurityStatus({ ...value, state: "ok" }), /widerspruechlich/);
});

test("unavailable, stale, pending and unexplained audit errors stay actionable", () => {
  assert.equal(buildHostSecurityAlerts({ configured: false }).length, 0);
  const unavailable = buildHostSecurityAlerts({ configured: true, statusAvailable: false, rebootRequired: true });
  assert.deepEqual(unavailable.map(alert => alert.id), ["HOST_SECURITY_ATTENTION"]);
  assert.equal(unavailable[0].severity, "critical");
  const stale = buildHostSecurityAlerts({ ...auditedStatus({ state: "warning", rebootRequired: true }), lastErrorCode: "HOST_SECURITY_STATUS_STALE" });
  assert.deepEqual(stale.map(alert => alert.id), ["HOST_SECURITY_STATUS_UNVERIFIED", "HOST_REBOOT_REQUIRED"]);
  const pending = buildHostSecurityAlerts(auditedStatus({ state: "warning", pendingConfirmation: true, rebootRequired: true }));
  assert.equal(pending[0].id, "HOST_SECURITY_CONFIRMATION_PENDING");
  const unexplained = buildHostSecurityAlerts(auditedStatus({ state: "error", rebootRequired: true }));
  assert.equal(unexplained[0].severity, "critical");
});

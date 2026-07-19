"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  DEFAULT_STATUS_PATH,
  MAX_STATUS_BYTES,
  STATUS_FORMAT,
  STATUS_SCHEMA_VERSION,
  parseOffsiteBackupStatus,
  readOffsiteBackupStatus,
  redactStatusSummary,
} = require("../lib/offsite-backup-status");

function validStatus(overrides = {}) {
  return {
    format: STATUS_FORMAT,
    schemaVersion: STATUS_SCHEMA_VERSION,
    configured: true,
    state: "ok",
    generatedAt: "2026-07-19T12:00:00.000Z",
    lastAttemptAt: "2026-07-19T11:58:00.000Z",
    lastSuccessAt: "2026-07-19T11:59:00.000Z",
    lastSnapshotId: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    lastRepositoryCheckAt: "2026-07-19T11:59:30.000Z",
    lastFullCheckAt: "2026-07-01T02:00:00.000Z",
    lastRestoreTestAt: "2026-07-01T03:00:00.000Z",
    lastFailureAt: null,
    lastError: null,
    unresolvedFailures: { backup: false, fullCheck: false, restoreTest: false },
    retention: { daily: 14, weekly: 8, monthly: 12 },
    ...overrides,
  };
}

function withStatusFile(payload, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-offsite-status-"));
  const statusPath = path.join(root, "status.json");
  try {
    fs.writeFileSync(statusPath, `${JSON.stringify(payload)}\n`, { mode: 0o640 });
    return callback(statusPath, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("offsite status reader returns only bounded diagnostics and never blocks main readiness", () => {
  withStatusFile(validStatus(), (statusPath) => {
    const diagnostics = readOffsiteBackupStatus({
      statusPath,
      requireRootOwner: false,
      now: new Date("2026-07-20T00:00:00.000Z"),
    });
    assert.deepEqual(diagnostics, {
      configured: true,
      state: "ok",
      statusAvailable: true,
      blocksMainReadiness: false,
      lastSuccessAt: "2026-07-19T11:59:00.000Z",
      lastSnapshotId: "abcdef123456",
      lastRepositoryCheckAt: "2026-07-19T11:59:30.000Z",
      lastFullCheckAt: "2026-07-01T02:00:00.000Z",
      lastRestoreTestAt: "2026-07-01T03:00:00.000Z",
      lastAttemptAt: "2026-07-19T11:58:00.000Z",
      lastFailureAt: null,
      lastErrorCode: null,
      unresolvedFailures: { backup: false, fullCheck: false, restoreTest: false },
      summary: "Verschluesseltes Offsite-Backup ist aktuell.",
      agesHours: {
        backup: 12.02,
        repositoryCheck: 12.01,
        fullCheck: 454,
        restoreTest: 453,
        attempt: 12.03,
        failure: null,
      },
      retention: { daily: 14, weekly: 8, monthly: 12 },
    });
    assert.equal("statusPath" in diagnostics, false);
    assert.equal("repository" in diagnostics, false);
    assert.equal(diagnostics.lastSnapshotId.length, 12);
  });
});

test("status schema is exact and rejects unknown fields, mismatched results and wrong retention", () => {
  assert.throws(
    () => parseOffsiteBackupStatus({ ...validStatus(), repository: "rclone:private:secret" }),
    (error) => error.code === "STATUS_SCHEMA_INVALID",
  );
  assert.throws(
    () => parseOffsiteBackupStatus(validStatus({ lastSnapshotId: null })),
    /gemeinsam vorliegen/,
  );
  assert.throws(
    () => parseOffsiteBackupStatus(validStatus({ retention: { daily: 7, weekly: 8, monthly: 12 } })),
    /14\/8\/12/,
  );
  assert.throws(
    () => parseOffsiteBackupStatus(validStatus({ generatedAt: "19.07.2026 12:00" })),
    /UTC-Zeitstempel/,
  );
  assert.throws(
    () => parseOffsiteBackupStatus(validStatus({ lastRepositoryCheckAt: "2026-07-19 11:59" })),
    /lastRepositoryCheckAt.*UTC-Zeitstempel/,
  );
  assert.throws(
    () => parseOffsiteBackupStatus(validStatus({ lastRepositoryCheckAt: "2026-07-19T12:06:00.000Z" })),
    /unplausibel nach dem Statuszeitpunkt/,
  );
  assert.throws(
    () => parseOffsiteBackupStatus(validStatus({ generatedAt: "2026-02-30T12:00:00.000Z" })),
    /generatedAt.*ungueltig/,
  );
});

test("a stale daily repository check becomes a warning but never a readiness blocker", () => {
  withStatusFile(validStatus({ lastRepositoryCheckAt: "2026-07-17T12:00:00.000Z" }), (statusPath) => {
    const diagnostics = readOffsiteBackupStatus({
      statusPath,
      requireRootOwner: false,
      now: new Date("2026-07-20T00:00:00.000Z"),
    });
    assert.equal(diagnostics.agesHours.repositoryCheck, 60);
    assert.equal(diagnostics.state, "warning");
    assert.equal(diagnostics.blocksMainReadiness, false);
    assert.match(diagnostics.summary, /ausstaendig oder zu alt/);
  });
});

test("error summaries redact credentials, accounts, remotes, addresses and local paths", () => {
  const secret = "super-secret-token-1234567890";
  const summary = redactStatusSummary(
    `token=${secret} https://drive.example/private rclone:my-drive:customer drive-private:repository/folder jane@example.at /mnt/backup/status.json C:\\Secrets\\rclone.conf \\\\server\\share\\token`,
  );
  for (const sensitive of [secret, "drive.example", "my-drive", "drive-private", "jane@example.at", "/mnt/backup", "C:\\Secrets", "server\\share"]) {
    assert.doesNotMatch(summary, new RegExp(sensitive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.match(summary, /entfernt/);

  const structured = redactStatusSummary(
    'Fehler {"token":"shortSecret123","oauth_token":"abc123XYZ"}; password = "secret with spaces"; Datei "C:\\Secret Folder\\rclone.conf"',
  );
  for (const sensitive of ["shortSecret123", "abc123XYZ", "secret with spaces", "Secret Folder", "rclone.conf"]) {
    assert.doesNotMatch(structured, new RegExp(sensitive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.doesNotMatch(structured, /\$1=/);

  const headers = redactStatusSummary(
    "Authorization: Basic dXNlcjpwYXNz; password: unquoted secret with spaces, Status fehlgeschlagen",
  );
  for (const sensitive of ["Basic", "dXNlcjpwYXNz", "unquoted", "secret with spaces"]) {
    assert.doesNotMatch(headers, new RegExp(sensitive, "i"));
  }
  assert.match(headers, /Authorization: \[entfernt\]/);
  assert.match(headers, /password: \[entfernt\]/);

  withStatusFile(validStatus({
    state: "error",
    lastAttemptAt: "2026-07-19T11:58:00.000Z",
    lastFailureAt: "2026-07-19T11:58:00.000Z",
    lastError: { code: "RCLONE_UPLOAD_FAILED", summary: `Passwort=${secret} rclone:private:repo` },
    unresolvedFailures: { backup: true, fullCheck: false, restoreTest: false },
  }), (statusPath) => {
    const diagnostics = readOffsiteBackupStatus({ statusPath, configured: true, requireRootOwner: false });
    assert.equal(diagnostics.state, "error");
    assert.equal(diagnostics.lastErrorCode, "RCLONE_UPLOAD_FAILED");
    assert.doesNotMatch(diagnostics.summary, new RegExp(secret));
    assert.doesNotMatch(diagnostics.summary, /private:repo/);
  });
});

test("a newer daily backup does not hide an unresolved full-check failure", () => {
  withStatusFile(validStatus({
    state: "error",
    generatedAt: "2026-07-19T12:00:00.000Z",
    lastAttemptAt: "2026-07-19T11:59:00.000Z",
    lastSuccessAt: "2026-07-19T11:59:00.000Z",
    lastRepositoryCheckAt: "2026-07-19T11:59:00.000Z",
    lastFailureAt: "2026-07-18T03:00:00.000Z",
    lastError: { code: "FULL_CHECK_FAILED", summary: "Die vollstaendige Repository-Pruefung ist fehlgeschlagen." },
    unresolvedFailures: { backup: false, fullCheck: true, restoreTest: false },
  }), (statusPath) => {
    const diagnostics = readOffsiteBackupStatus({
      statusPath,
      configured: true,
      requireRootOwner: false,
      now: new Date("2026-07-19T12:00:00.000Z"),
    });
    assert.equal(diagnostics.state, "error");
    assert.equal(diagnostics.lastErrorCode, "FULL_CHECK_FAILED");
    assert.deepEqual(diagnostics.unresolvedFailures, { backup: false, fullCheck: true, restoreTest: false });
  });
});

test("future-dated status evidence becomes a nonblocking warning instead of appearing current", () => {
  withStatusFile(validStatus({
    generatedAt: "2099-07-19T12:00:00.000Z",
    lastAttemptAt: "2099-07-19T11:58:00.000Z",
    lastSuccessAt: "2099-07-19T11:59:00.000Z",
    lastRepositoryCheckAt: "2099-07-19T11:59:30.000Z",
    lastFullCheckAt: "2099-07-01T02:00:00.000Z",
    lastRestoreTestAt: "2099-07-01T03:00:00.000Z",
  }), (statusPath) => {
    const diagnostics = readOffsiteBackupStatus({
      statusPath,
      configured: true,
      requireRootOwner: false,
      now: new Date("2026-07-19T12:00:00.000Z"),
    });
    assert.equal(diagnostics.state, "warning");
    assert.equal(diagnostics.blocksMainReadiness, false);
    assert.equal(diagnostics.agesHours.backup, null);
    assert.match(diagnostics.summary, /unplausibel in der Zukunft/);
  });
});

test("missing or invalid status files degrade safely without throwing", () => {
  const missing = path.join(os.tmpdir(), `missing-offsite-${process.pid}-${Date.now()}.json`);
  assert.deepEqual(readOffsiteBackupStatus({ statusPath: missing, requireRootOwner: false }), {
    configured: false,
    state: "unconfigured",
    statusAvailable: false,
    blocksMainReadiness: false,
    lastSuccessAt: null,
    lastSnapshotId: null,
    lastRepositoryCheckAt: null,
    lastFullCheckAt: null,
    lastRestoreTestAt: null,
    lastAttemptAt: null,
    lastFailureAt: null,
    lastErrorCode: null,
    unresolvedFailures: { backup: false, fullCheck: false, restoreTest: false },
    summary: "Verschluesseltes Offsite-Backup ist nicht eingerichtet.",
    agesHours: { backup: null, repositoryCheck: null, fullCheck: null, restoreTest: null, attempt: null, failure: null },
    retention: { daily: 14, weekly: 8, monthly: 12 },
  });
  const configuredMissing = readOffsiteBackupStatus({ statusPath: missing, configured: true, requireRootOwner: false });
  assert.equal(configuredMissing.state, "error");
  assert.equal(configuredMissing.blocksMainReadiness, false);
  assert.equal(configuredMissing.lastErrorCode, "STATUS_FILE_MISSING");

  withStatusFile({ ...validStatus(), unexpected: true }, (statusPath) => {
    const invalid = readOffsiteBackupStatus({ statusPath, configured: true, requireRootOwner: false });
    assert.equal(invalid.state, "error");
    assert.equal(invalid.lastErrorCode, "STATUS_SCHEMA_INVALID");
    assert.equal(invalid.statusAvailable, false);
    assert.equal(invalid.blocksMainReadiness, false);
  });

  withStatusFile(validStatus({
    configured: false,
    state: "unconfigured",
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastSnapshotId: null,
    lastRepositoryCheckAt: null,
    lastFullCheckAt: null,
    lastRestoreTestAt: null,
  }), (statusPath) => {
    const mismatch = readOffsiteBackupStatus({ statusPath, configured: true, requireRootOwner: false });
    assert.equal(mismatch.state, "error");
    assert.equal(mismatch.lastErrorCode, "STATUS_CONFIGURATION_MISMATCH");
    assert.equal(mismatch.blocksMainReadiness, false);
  });
});

test("reader honors the environment status path without returning it", () => {
  withStatusFile(validStatus(), (statusPath) => {
    const previous = process.env.GRABENPLANER_OFFSITE_STATUS_FILE;
    process.env.GRABENPLANER_OFFSITE_STATUS_FILE = statusPath;
    try {
      const diagnostics = readOffsiteBackupStatus({ requireRootOwner: false, now: new Date("2026-07-20T00:00:00Z") });
      assert.equal(diagnostics.statusAvailable, true);
      assert.equal(diagnostics.lastSnapshotId, "abcdef123456");
      assert.equal("statusPath" in diagnostics, false);
    } finally {
      if (previous === undefined) delete process.env.GRABENPLANER_OFFSITE_STATUS_FILE;
      else process.env.GRABENPLANER_OFFSITE_STATUS_FILE = previous;
    }
  });
  assert.equal(DEFAULT_STATUS_PATH, "/var/lib/grabenplaner-offsite/status.json");
});

test("an active status cannot silently disagree with a disabled server configuration", () => {
  withStatusFile(validStatus(), (statusPath) => {
    const diagnostics = readOffsiteBackupStatus({ statusPath, configured: false, requireRootOwner: false });
    assert.equal(diagnostics.configured, true);
    assert.equal(diagnostics.state, "error");
    assert.equal(diagnostics.lastErrorCode, "STATUS_CONFIGURATION_MISMATCH");
    assert.equal(diagnostics.blocksMainReadiness, false);
  });
});

test("oversized status files are rejected before parsing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-offsite-large-"));
  const statusPath = path.join(root, "status.json");
  try {
    fs.writeFileSync(statusPath, Buffer.alloc(MAX_STATUS_BYTES + 1, 0x20), { mode: 0o640 });
    const diagnostics = readOffsiteBackupStatus({ statusPath, configured: true, requireRootOwner: false });
    assert.equal(diagnostics.state, "error");
    assert.equal(diagnostics.lastErrorCode, "STATUS_FILE_SIZE_INVALID");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("symbolic-link status files are rejected", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-offsite-link-"));
  const target = path.join(root, "target.json");
  const statusPath = path.join(root, "status.json");
  try {
    fs.writeFileSync(target, JSON.stringify(validStatus()), { mode: 0o640 });
    fs.symlinkSync(target, statusPath);
    const diagnostics = readOffsiteBackupStatus({ statusPath, configured: true, requireRootOwner: false });
    assert.equal(diagnostics.state, "error");
    assert.equal(diagnostics.lastErrorCode, "STATUS_FILE_UNSAFE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("group- or world-writable status files are rejected on POSIX", { skip: process.platform === "win32" }, () => {
  withStatusFile(validStatus(), (statusPath) => {
    fs.chmodSync(statusPath, 0o660);
    const diagnostics = readOffsiteBackupStatus({ statusPath, configured: true, requireRootOwner: false });
    assert.equal(diagnostics.state, "error");
    assert.equal(diagnostics.lastErrorCode, "STATUS_FILE_PERMISSIONS_INVALID");
  });
});

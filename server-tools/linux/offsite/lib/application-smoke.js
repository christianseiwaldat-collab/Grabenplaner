"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const APP_ROOT = "/opt/grabenplaner/app";
const SMOKE_ROOT = "/var/lib/grabenplaner-offsite/application-smoke";
const DATA_ROOT = path.join(SMOKE_ROOT, "data-root");
const DATABASE = path.join(DATA_ROOT, "data", "dienstplan.db");
const RESULT = path.join(SMOKE_ROOT, "result.json");
const NODE = "/usr/bin/node";
const SERVER = path.join(APP_ROOT, "server.js");
const FORMAT = "grabenplaner-recovery-application-smoke";
const SCHEMA_VERSION = 1;
const START_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4096;
const MAX_RESULT_BYTES = 2048;
const PROTECTED_COLUMNS = new Set([
  "amu_documents.protected_payload",
  "amu_reports.protected_payload",
  "integration_connections.protected_credentials",
  "outbound_notification_jobs.protected_payload",
  "personnel_record_documents.protected_payload",
  "personnel_sensitive_records.protected_payload",
  "sickness_alerts.protected_payload",
  "sickness_cases.protected_payload",
  "sickness_notification_preferences.protected_destination",
]);
const PROTECTED_ROW_TABLES = Object.freeze([
  "amu_documents",
  "personnel_record_documents",
  "sickness_alerts",
  "outbound_notification_jobs",
  "amu_reports",
  "sickness_cases",
  "sickness_notification_preferences",
  "personnel_sensitive_records",
]);
const REASONS = new Set([
  "CHILD_EXITED",
  "HEALTH_INVALID",
  "READY_TIMEOUT",
  "SMOKE_PRECONDITION_FAILED",
  "SMOKE_TIMEOUT",
  "STOP_TIMEOUT",
]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("SMOKE_PRECONDITION_FAILED");
  if (process.platform === "linux" && stat.uid !== process.geteuid()) throw new Error("SMOKE_PRECONDITION_FAILED");
}

function assertRegular(file, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximumBytes) {
    throw new Error("SMOKE_PRECONDITION_FAILED");
  }
}

function atomicResult(ok, live, ready, reason) {
  const normalizedReason = reason === null ? null : (REASONS.has(reason) ? reason : "SMOKE_PRECONDITION_FAILED");
  const result = { format: FORMAT, schemaVersion: SCHEMA_VERSION, ok, live, ready, reason: normalizedReason };
  const temporary = path.join(SMOKE_ROOT, `.result.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, RESULT);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already absent */ }
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
    && left.size === right.size && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs;
}

function verifiedApplicationSmokeResult(file, expectedUid, expectedGid, serviceStatus, options = {}) {
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0 || !Number.isSafeInteger(expectedGid) || expectedGid < 0
    || !Number.isSafeInteger(serviceStatus) || serviceStatus < 0 || serviceStatus > 255) {
    throw new Error("SMOKE_RESULT_INVALID");
  }
  let descriptor;
  try {
    const expectedMode = Number.isInteger(options.expectedMode) ? options.expectedMode : 0o600;
    if (expectedMode < 0 || expectedMode > 0o7777) throw new Error("SMOKE_RESULT_INVALID");
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== BigInt(expectedUid)
      || before.gid !== BigInt(expectedGid) || (before.mode & 0o7777n) !== BigInt(expectedMode)
      || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_RESULT_BYTES)) {
      throw new Error("SMOKE_RESULT_INVALID");
    }
    if (typeof options.afterLstat === "function") options.afterLstat();
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_CLOEXEC || 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, opened)) throw new Error("SMOKE_RESULT_INVALID");
    if (typeof options.afterOpen === "function") options.afterOpen();

    const bytes = Number(opened.size);
    const buffer = Buffer.alloc(bytes);
    let offset = 0;
    while (offset < bytes) {
      const count = fs.readSync(descriptor, buffer, offset, bytes - offset, offset);
      if (count < 1) throw new Error("SMOKE_RESULT_INVALID");
      offset += count;
    }
    if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) throw new Error("SMOKE_RESULT_INVALID");
    if (typeof options.afterRead === "function") options.afterRead();
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(opened, after)) throw new Error("SMOKE_RESULT_INVALID");

    const value = JSON.parse(buffer.toString("utf8"));
    const keys = ["format", "live", "ok", "ready", "reason", "schemaVersion"];
    if (!value || typeof value !== "object" || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
      || value.format !== FORMAT || value.schemaVersion !== SCHEMA_VERSION
      || typeof value.ok !== "boolean" || typeof value.live !== "boolean" || typeof value.ready !== "boolean"
      || (value.reason !== null && !REASONS.has(value.reason))) throw new Error("SMOKE_RESULT_INVALID");
    return serviceStatus === 0 && value.ok === true && value.live === true
      && value.ready === true && value.reason === null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.unref();
    reservation.once("error", reject);
    reservation.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = reservation.address();
      const port = typeof address === "object" && address ? address.port : 0;
      reservation.close((error) => {
        if (error || !Number.isInteger(port) || port < 1024 || port > 65535) reject(error || new Error("invalid port"));
        else resolve(port);
      });
    });
  });
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
    .map((column) => String(column.name || "")));
}

function sanitizeSmokeDatabase(databaseFile = DATABASE) {
  assertRegular(databaseFile, 16 * 1024 * 1024 * 1024);
  const database = new DatabaseSync(databaseFile);
  let transactionOpen = false;
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => String(row.name || ""));
    const tableSet = new Set(tables);
    const observedProtectedColumns = new Set();
    for (const table of tables) {
      for (const column of tableColumns(database, table)) {
        if (column.startsWith("protected_")) observedProtectedColumns.add(`${table}.${column}`);
      }
    }
    for (const column of observedProtectedColumns) {
      if (!PROTECTED_COLUMNS.has(column)) throw new Error("SMOKE_PRECONDITION_FAILED");
    }

    database.exec("PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    transactionOpen = true;
    for (const table of PROTECTED_ROW_TABLES) {
      if (tableSet.has(table)) database.exec(`DELETE FROM ${quoteIdentifier(table)}`);
    }
    if (tableSet.has("integration_connections")) {
      const available = tableColumns(database, "integration_connections");
      const assignments = ["protected_credentials = ''"];
      if (available.has("credential_key_id")) assignments.push("credential_key_id = ''");
      if (available.has("active")) assignments.push("active = 0");
      database.exec(`UPDATE integration_connections SET ${assignments.join(", ")}`);
    }
    if (tableSet.has("portal_notifications")) database.exec("DELETE FROM portal_notifications");
    database.exec("COMMIT");
    transactionOpen = false;
    database.exec("VACUUM");

    const integrity = database.prepare("PRAGMA integrity_check").all().map((row) => String(Object.values(row)[0] || ""));
    if (integrity.length !== 1 || integrity[0] !== "ok") throw new Error("SMOKE_PRECONDITION_FAILED");
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) throw new Error("SMOKE_PRECONDITION_FAILED");
    const freelist = Number(Object.values(database.prepare("PRAGMA freelist_count").get())[0]);
    if (freelist !== 0) throw new Error("SMOKE_PRECONDITION_FAILED");
  } catch (error) {
    if (transactionOpen) {
      try { database.exec("ROLLBACK"); } catch { /* fail closed below */ }
    }
    throw error;
  } finally {
    database.close();
  }
  for (const suffix of ["-journal", "-shm", "-wal"]) {
    if (fs.existsSync(`${databaseFile}${suffix}`)) throw new Error("SMOKE_PRECONDITION_FAILED");
  }
  return true;
}

function healthRequest(port, pathname) {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname, timeout: 1500 }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) request.destroy(new Error("response too large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(response.statusCode === 200 && value && value.ok === true);
        } catch { resolve(false); }
      });
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  child.kill("SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(100);
  if (child.exitCode !== null || child.signalCode !== null) return true;
  child.kill("SIGKILL");
  await sleep(250);
  return child.exitCode !== null || child.signalCode !== null;
}

function childEnvironment(port) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: path.join(SMOKE_ROOT, "home"),
    USER: process.env.USER || "grabenplaner-offsite",
    LOGNAME: process.env.LOGNAME || "grabenplaner-offsite",
    LANG: "C.UTF-8",
    TZ: "UTC",
    NODE_ENV: "test",
    PORT: String(port),
    GRABENPLANER_OPERATION_MODE: "server",
    GRABENPLANER_DEPLOYMENT_KIND: "recovery-smoke",
    GRABENPLANER_PUBLIC_URL: "https://recovery-smoke.invalid",
    GRABENPLANER_SERVICE_CONTROL_TOKEN: crypto.randomBytes(48).toString("base64url"),
    GRABENPLANER_AMU_KEY_ID: "recovery-smoke",
    GRABENPLANER_AMU_KEY: crypto.randomBytes(32).toString("base64"),
    GRABENPLANER_INTEGRATION_KEY_ID: "recovery-smoke",
    GRABENPLANER_INTEGRATION_KEY: crypto.randomBytes(32).toString("base64"),
    GRABENPLANER_WIFI_WEBHOOK_SECRET: crypto.randomBytes(48).toString("base64url"),
    GRABENPLANER_TEST_AMU_SCANNER: "clean",
    GRABENPLANER_HOST: "127.0.0.1",
    GRABENPLANER_TRUST_PROXY: "loopback",
    GRABENPLANER_DATA_DIR: DATA_ROOT,
    DB_PATH: DATABASE,
    BACKUP_DIR: path.join(DATA_ROOT, "backups"),
    GRABENPLANER_LOG_DIR: path.join(DATA_ROOT, "logs"),
    GRABENPLANER_BACKUP_KEEP: "1",
    GRABENPLANER_OFFSITE_CONFIGURED: "0",
    GRABENPLANER_MONITOR_CONFIGURED: "0",
    GRABENPLANER_HOST_SECURITY_CONFIGURED: "0",
  };
}

async function main() {
  if (process.platform !== "linux" || typeof process.geteuid !== "function" || process.geteuid() === 0
    || process.argv.length !== 2 || fs.existsSync(RESULT)) {
    throw new Error("SMOKE_PRECONDITION_FAILED");
  }
  assertDirectory(SMOKE_ROOT);
  assertDirectory(DATA_ROOT);
  assertDirectory(path.dirname(DATABASE));
  assertDirectory(path.join(SMOKE_ROOT, "home"));
  assertRegular(DATABASE);
  assertRegular(NODE, 256 * 1024 * 1024);
  assertRegular(SERVER, 16 * 1024 * 1024);

  const port = await reserveLoopbackPort();
  const child = spawn(NODE, [SERVER], {
    cwd: APP_ROOT,
    env: childEnvironment(port),
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });
  let reason = "READY_TIMEOUT";
  let live = false;
  let ready = false;
  const deadline = Date.now() + START_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        reason = "CHILD_EXITED";
        break;
      }
      live = await healthRequest(port, "/api/health/live");
      if (live) {
        ready = await healthRequest(port, "/api/health/ready");
        if (ready) {
          const stopped = await stopChild(child);
          atomicResult(stopped, true, true, stopped ? null : "STOP_TIMEOUT");
          process.exitCode = stopped ? 0 : 1;
          return;
        }
      }
      await sleep(250);
    }
    if (Date.now() >= deadline) reason = live ? "READY_TIMEOUT" : "SMOKE_TIMEOUT";
  } finally {
    const stopped = await stopChild(child);
    if (!stopped) reason = "STOP_TIMEOUT";
  }
  atomicResult(false, live, ready, reason);
  process.exitCode = 1;
}

if (require.main === module) {
  if (process.argv[2] === "--sanitize-database") {
    try {
      if (process.platform !== "linux" || typeof process.geteuid !== "function" || process.geteuid() !== 0
        || process.argv.length !== 3 || fs.existsSync(RESULT)) throw new Error("SMOKE_PRECONDITION_FAILED");
      assertDirectory(SMOKE_ROOT);
      assertDirectory(DATA_ROOT);
      assertDirectory(path.dirname(DATABASE));
      if (fs.lstatSync(DATABASE).uid !== 0) throw new Error("SMOKE_PRECONDITION_FAILED");
      sanitizeSmokeDatabase();
      process.stdout.write("1");
    } catch { process.exitCode = 1; }
  } else if (process.argv[2] === "--verify-result") {
    try {
      if (process.argv.length !== 7 || !/^\d+$/.test(process.argv[4]) || !/^\d+$/.test(process.argv[5])
        || !/^\d+$/.test(process.argv[6])) throw new Error("SMOKE_RESULT_INVALID");
      const passed = verifiedApplicationSmokeResult(
        process.argv[3], Number(process.argv[4]), Number(process.argv[5]), Number(process.argv[6]),
      );
      process.stdout.write(passed ? "1" : "0");
    } catch { process.exitCode = 1; }
  } else {
    main().catch((error) => {
      try { atomicResult(false, false, false, String(error?.message || "SMOKE_PRECONDITION_FAILED")); } catch { /* fail closed */ }
      process.exitCode = 1;
    });
  }
}

module.exports = {
  APP_ROOT,
  SMOKE_ROOT,
  DATA_ROOT,
  DATABASE,
  RESULT,
  FORMAT,
  SCHEMA_VERSION,
  START_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  MAX_RESULT_BYTES,
  REASONS,
  PROTECTED_COLUMNS,
  PROTECTED_ROW_TABLES,
  childEnvironment,
  sanitizeSmokeDatabase,
  verifiedApplicationSmokeResult,
};

"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const POSTGRESQL_OPERATIONAL_PROFILE = "development-contract";
const POSTGRESQL_LOGICAL_BACKUP_METHOD = "postgresql-pg-dump-custom";
const POSTGRESQL_LOGICAL_RESTORE_METHOD = "postgresql-pg-restore-custom";
const DEFAULT_TOOL_TIMEOUT_MILLISECONDS = 15 * 60 * 1000;
const MAXIMUM_TOOL_TIMEOUT_MILLISECONDS = 4 * 60 * 60 * 1000;
const MAXIMUM_CAPTURE_BYTES = 64 * 1024;
const SERVICE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{2,62}$/;
const SCHEMA_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const EXPORTED_SNAPSHOT_PATTERN = /^[A-Fa-f0-9][A-Fa-f0-9-]{2,127}$/;

const ERROR_CODES = Object.freeze({
  CONFIGURATION_INVALID: "POSTGRESQL_OPERATIONS_CONFIGURATION_INVALID",
  CREDENTIAL_FILE_UNSAFE: "POSTGRESQL_OPERATIONS_CREDENTIAL_FILE_UNSAFE",
  TOOL_FAILED: "POSTGRESQL_OPERATIONS_TOOL_FAILED",
  TOOL_TIMEOUT: "POSTGRESQL_OPERATIONS_TOOL_TIMEOUT",
  TOOL_ABORTED: "POSTGRESQL_OPERATIONS_TOOL_ABORTED",
  TOOL_OUTPUT_INVALID: "POSTGRESQL_OPERATIONS_TOOL_OUTPUT_INVALID",
  TOOL_VERSION_MISMATCH: "POSTGRESQL_OPERATIONS_TOOL_VERSION_MISMATCH",
});

class PostgresqlOperationalError extends Error {
  constructor(code, operation, cause) {
    super("Der PostgreSQL-Betriebsvorgang konnte nicht sicher abgeschlossen werden.");
    this.name = "PostgresqlOperationalError";
    this.code = code;
    this.operation = operation;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false,
      });
    }
  }
}

function operationalError(code, operation, cause) {
  return new PostgresqlOperationalError(code, operation, cause);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, operation = "configuration") {
  if (!isPlainObject(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, operation);
  }
}

function safeAbsolutePath(value, operation = "configuration") {
  if (typeof value !== "string" || !value || value.includes("\0") || !path.isAbsolute(value)) {
    throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, operation);
  }
  return path.resolve(value);
}

function assertRegularPrivateFile(filePath, operation = "configuration") {
  const resolved = safeAbsolutePath(filePath, operation);
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      throw operationalError(ERROR_CODES.CREDENTIAL_FILE_UNSAFE, operation);
    }
  } catch (error) {
    if (error instanceof PostgresqlOperationalError) throw error;
    throw operationalError(ERROR_CODES.CREDENTIAL_FILE_UNSAFE, operation, error);
  }
  return resolved;
}

function normalizeToolBinary(filePath, expectedName) {
  const resolved = safeAbsolutePath(filePath);
  const basename = path.basename(resolved).toLowerCase().replace(/\.exe$/, "");
  if (basename !== expectedName) {
    throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, "configuration");
  }
  return resolved;
}

function normalizeTimeout(value) {
  const timeout = value === undefined ? DEFAULT_TOOL_TIMEOUT_MILLISECONDS : value;
  if (!Number.isSafeInteger(timeout)
    || timeout < 1_000
    || timeout > MAXIMUM_TOOL_TIMEOUT_MILLISECONDS) {
    throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, "configuration");
  }
  return timeout;
}

function createPostgresqlToolPolicy({
  profile,
  pgDumpPath,
  pgRestorePath,
  expectedToolMajor = 18,
  applicationSchema = "public",
  timeoutMilliseconds,
} = {}) {
  if (profile !== POSTGRESQL_OPERATIONAL_PROFILE
    || !Number.isSafeInteger(expectedToolMajor)
    || expectedToolMajor < 14
    || expectedToolMajor > 99
    || !SCHEMA_NAME_PATTERN.test(String(applicationSchema || ""))) {
    throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, "configuration");
  }
  return Object.freeze({
    profile: POSTGRESQL_OPERATIONAL_PROFILE,
    productActivation: false,
    backupMethod: POSTGRESQL_LOGICAL_BACKUP_METHOD,
    restoreMethod: POSTGRESQL_LOGICAL_RESTORE_METHOD,
    pgDumpPath: normalizeToolBinary(pgDumpPath, "pg_dump"),
    pgRestorePath: normalizeToolBinary(pgRestorePath, "pg_restore"),
    expectedToolMajor,
    applicationSchema,
    timeoutMilliseconds: normalizeTimeout(timeoutMilliseconds),
  });
}

function createPostgresqlToolCredentials({
  serviceName,
  serviceFilePath,
  passwordFilePath,
} = {}) {
  if (!SERVICE_NAME_PATTERN.test(String(serviceName || ""))) {
    throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, "configuration");
  }
  const credentials = {
    serviceName,
    serviceFilePath: assertRegularPrivateFile(serviceFilePath),
    passwordFilePath: assertRegularPrivateFile(passwordFilePath),
  };
  return Object.freeze(credentials);
}

function commandEnvironment(credentials, applicationName) {
  const environment = {
    PGSERVICE: credentials.serviceName,
    PGSERVICEFILE: credentials.serviceFilePath,
    PGPASSFILE: credentials.passwordFilePath,
    PGAPPNAME: applicationName,
    PGCONNECT_TIMEOUT: "15",
    LC_ALL: "C",
  };
  if (process.platform === "win32") {
    if (process.env.SYSTEMROOT) environment.SYSTEMROOT = process.env.SYSTEMROOT;
    if (process.env.WINDIR) environment.WINDIR = process.env.WINDIR;
  }
  return Object.freeze(environment);
}

function assertOutputPath(filePath, operation) {
  const resolved = safeAbsolutePath(filePath, operation);
  const parent = path.dirname(resolved);
  try {
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, operation);
    }
    if (fs.existsSync(resolved)) {
      throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, operation);
    }
  } catch (error) {
    if (error instanceof PostgresqlOperationalError) throw error;
    throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, operation, error);
  }
  return resolved;
}

function assertInputFile(filePath, operation) {
  const resolved = safeAbsolutePath(filePath, operation);
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0) {
      throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, operation);
    }
  } catch (error) {
    if (error instanceof PostgresqlOperationalError) throw error;
    throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, operation, error);
  }
  return resolved;
}

function buildPostgresqlDumpCommand({
  policy,
  credentials,
  targetPath,
  exportedSnapshot,
} = {}) {
  if (!policy || policy.profile !== POSTGRESQL_OPERATIONAL_PROFILE
    || !credentials || !credentials.serviceName
    || !EXPORTED_SNAPSHOT_PATTERN.test(String(exportedSnapshot || ""))) {
    throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, "backup");
  }
  const output = assertOutputPath(targetPath, "backup");
  return Object.freeze({
    operation: "backup",
    executable: policy.pgDumpPath,
    arguments: Object.freeze([
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--snapshot=${exportedSnapshot}`,
      `--schema=${policy.applicationSchema}`,
      `--file=${output}`,
    ]),
    environment: commandEnvironment(credentials, "grabenplaner-postgresql-backup"),
    timeoutMilliseconds: policy.timeoutMilliseconds,
    outputPath: output,
  });
}

function buildPostgresqlRestoreListCommand({
  policy,
  dumpPath,
} = {}) {
  if (!policy || policy.profile !== POSTGRESQL_OPERATIONAL_PROFILE) {
    throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, "backup-verification");
  }
  const input = assertInputFile(dumpPath, "backup-verification");
  return Object.freeze({
    operation: "backup-verification",
    executable: policy.pgRestorePath,
    arguments: Object.freeze(["--list", input]),
    environment: Object.freeze({ LC_ALL: "C" }),
    timeoutMilliseconds: policy.timeoutMilliseconds,
  });
}

function buildPostgresqlRestoreCommand({
  policy,
  credentials,
  dumpPath,
} = {}) {
  if (!policy || policy.profile !== POSTGRESQL_OPERATIONAL_PROFILE
    || !credentials || !credentials.serviceName) {
    throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, "restore");
  }
  const input = assertInputFile(dumpPath, "restore");
  return Object.freeze({
    operation: "restore",
    executable: policy.pgRestorePath,
    arguments: Object.freeze([
      `--dbname=service=${credentials.serviceName}`,
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      input,
    ]),
    environment: commandEnvironment(credentials, "grabenplaner-postgresql-restore-test"),
    timeoutMilliseconds: policy.timeoutMilliseconds,
  });
}

function buildPostgresqlVersionCommand({ executable, operation = "tool-version" } = {}) {
  return Object.freeze({
    operation,
    executable: safeAbsolutePath(executable, operation),
    arguments: Object.freeze(["--version"]),
    environment: Object.freeze({ LC_ALL: "C" }),
    timeoutMilliseconds: 30_000,
  });
}

function parsePostgresqlToolMajor(output, expectedMajor) {
  const match = String(output || "").trim().match(/\bPostgreSQL\)?\s+(\d+)(?:\.\d+)?\b/i);
  const major = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(major)
    || major !== expectedMajor) {
    throw operationalError(ERROR_CODES.TOOL_VERSION_MISMATCH, "tool-version");
  }
  return major;
}

function limitedAppend(chunks, chunk, state) {
  const buffer = Buffer.from(chunk);
  if (state.bytes >= MAXIMUM_CAPTURE_BYTES) return;
  const available = MAXIMUM_CAPTURE_BYTES - state.bytes;
  chunks.push(buffer.subarray(0, available));
  state.bytes += Math.min(buffer.length, available);
}

function runPostgresqlTool(command, {
  signal,
  spawn = childProcess.spawn,
} = {}) {
  exactKeys(command, [
    "operation",
    "executable",
    "arguments",
    "environment",
    "timeoutMilliseconds",
    "outputPath",
  ], command?.operation || "tool");
  if (typeof spawn !== "function"
    || !Array.isArray(command.arguments)
    || !isPlainObject(command.environment)
    || !Number.isSafeInteger(command.timeoutMilliseconds)) {
    throw operationalError(ERROR_CODES.CONFIGURATION_INVALID, command.operation || "tool");
  }
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer = null;
    const startedAt = Date.now();
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    const finish = (work) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      if (signal) signal.removeEventListener("abort", abort);
      work();
    };
    const requestTermination = () => {
      try { child?.kill("SIGTERM"); } catch {}
      forceKillTimer ||= setTimeout(() => {
        try { child?.kill("SIGKILL"); } catch {}
      }, 5_000);
    };
    const abort = () => {
      aborted = true;
      requestTermination();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, command.timeoutMilliseconds);
    try {
      child = spawn(command.executable, command.arguments, {
        env: command.environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish(() => reject(operationalError(ERROR_CODES.TOOL_FAILED, command.operation, error)));
      return;
    }
    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }
    child.stdout?.on("data", (chunk) => limitedAppend(stdoutChunks, chunk, stdoutState));
    child.stderr?.on("data", (chunk) => limitedAppend(stderrChunks, chunk, stderrState));
    child.once("error", (error) => {
      finish(() => reject(operationalError(
        timedOut
          ? ERROR_CODES.TOOL_TIMEOUT
          : aborted
            ? ERROR_CODES.TOOL_ABORTED
            : ERROR_CODES.TOOL_FAILED,
        command.operation,
        error,
      )));
    });
    child.once("close", (code, terminationSignal) => {
      finish(() => {
        if (timedOut) {
          reject(operationalError(ERROR_CODES.TOOL_TIMEOUT, command.operation));
          return;
        }
        if (aborted) {
          reject(operationalError(ERROR_CODES.TOOL_ABORTED, command.operation));
          return;
        }
        if (code !== 0 || terminationSignal) {
          reject(operationalError(ERROR_CODES.TOOL_FAILED, command.operation));
          return;
        }
        resolve(Object.freeze({
          operation: command.operation,
          exitCode: 0,
          durationMilliseconds: Math.max(0, Date.now() - startedAt),
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderrCaptured: stderrState.bytes > 0,
        }));
      });
    });
  });
}

module.exports = {
  DEFAULT_TOOL_TIMEOUT_MILLISECONDS,
  ERROR_CODES,
  POSTGRESQL_LOGICAL_BACKUP_METHOD,
  POSTGRESQL_LOGICAL_RESTORE_METHOD,
  POSTGRESQL_OPERATIONAL_PROFILE,
  PostgresqlOperationalError,
  buildPostgresqlDumpCommand,
  buildPostgresqlRestoreCommand,
  buildPostgresqlRestoreListCommand,
  buildPostgresqlVersionCommand,
  createPostgresqlToolCredentials,
  createPostgresqlToolPolicy,
  parsePostgresqlToolMajor,
  runPostgresqlTool,
};

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const {
  ERROR_CODES,
  POSTGRESQL_LOGICAL_BACKUP_METHOD,
  POSTGRESQL_LOGICAL_RESTORE_METHOD,
  POSTGRESQL_OPERATIONAL_PROFILE,
  buildPostgresqlDumpCommand,
  buildPostgresqlRestoreCommand,
  buildPostgresqlRestoreListCommand,
  buildPostgresqlVersionCommand,
  createPostgresqlToolCredentials,
  createPostgresqlToolPolicy,
  parsePostgresqlToolMajor,
  runPostgresqlTool,
} = require("../lib/persistence/postgresql/operations/tools");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-pg-tools-"));
  const pgDumpPath = path.join(root, process.platform === "win32" ? "pg_dump.exe" : "pg_dump");
  const pgRestorePath = path.join(root, process.platform === "win32" ? "pg_restore.exe" : "pg_restore");
  const serviceFilePath = path.join(root, "pg-service.conf");
  const passwordFilePath = path.join(root, "pg-pass");
  const dumpPath = path.join(root, "database.dump");
  for (const file of [pgDumpPath, pgRestorePath, serviceFilePath, passwordFilePath]) {
    fs.writeFileSync(file, "fixture", { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  const policy = createPostgresqlToolPolicy({
    profile: POSTGRESQL_OPERATIONAL_PROFILE,
    pgDumpPath,
    pgRestorePath,
    expectedToolMajor: 18,
    applicationSchema: "grabenplaner",
    timeoutMilliseconds: 5_000,
  });
  const credentials = createPostgresqlToolCredentials({
    serviceName: "grabenplaner_backup",
    serviceFilePath,
    passwordFilePath,
  });
  return {
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
    credentials,
    dumpPath,
    passwordFilePath,
    pgDumpPath,
    pgRestorePath,
    policy,
    root,
    serviceFilePath,
  };
}

function fakeSpawn({
  stdout = "",
  stderr = "",
  exitCode = 0,
  terminationSignal = null,
  error = null,
} = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      if (error) child.emit("error", error);
      else child.emit("close", exitCode, terminationSignal);
    });
    return child;
  };
}

function abortableSpawn(observed) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      observed.push(signal);
      setImmediate(() => child.emit("close", null, signal));
      return true;
    };
    return child;
  };
}

test("DB Block 6: PostgreSQL-Toolpolicy bleibt nicht produktiv und strikt gepinnt", () => {
  const value = fixture();
  try {
    assert.equal(value.policy.profile, "development-contract");
    assert.equal(value.policy.productActivation, false);
    assert.equal(value.policy.backupMethod, POSTGRESQL_LOGICAL_BACKUP_METHOD);
    assert.equal(value.policy.restoreMethod, POSTGRESQL_LOGICAL_RESTORE_METHOD);
    assert.equal(value.policy.expectedToolMajor, 18);
    assert.equal(Object.isFrozen(value.policy), true);
    assert.throws(
      () => createPostgresqlToolPolicy({
        ...value.policy,
        profile: "production",
      }),
      (error) => error?.code === ERROR_CODES.CONFIGURATION_INVALID,
    );
    assert.throws(
      () => createPostgresqlToolPolicy({
        profile: POSTGRESQL_OPERATIONAL_PROFILE,
        pgDumpPath: value.pgRestorePath,
        pgRestorePath: value.pgRestorePath,
      }),
      (error) => error?.code === ERROR_CODES.CONFIGURATION_INVALID,
    );
  } finally {
    value.cleanup();
  }
});

test("DB Block 6: Credentials verwenden private Service-/Passfiles statt URL oder Passwortargument", () => {
  const value = fixture();
  try {
    const command = buildPostgresqlDumpCommand({
      policy: value.policy,
      credentials: value.credentials,
      targetPath: value.dumpPath,
      exportedSnapshot: "00000003-0000001B-1",
    });
    assert.deepEqual(command.arguments, [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--snapshot=00000003-0000001B-1",
      "--schema=grabenplaner",
      `--file=${value.dumpPath}`,
    ]);
    assert.equal(command.environment.PGSERVICE, "grabenplaner_backup");
    assert.equal(command.environment.PGSERVICEFILE, value.serviceFilePath);
    assert.equal(command.environment.PGPASSFILE, value.passwordFilePath);
    const serialized = JSON.stringify(command.arguments);
    assert.doesNotMatch(serialized, /password|postgres(?:ql)?:\/\//i);
    assert.equal(Object.hasOwn(command.environment, "PGPASSWORD"), false);

    fs.writeFileSync(value.dumpPath, "dump", { mode: 0o600 });
    const list = buildPostgresqlRestoreListCommand({
      policy: value.policy,
      dumpPath: value.dumpPath,
    });
    assert.deepEqual(list.arguments, ["--list", value.dumpPath]);
    const restore = buildPostgresqlRestoreCommand({
      policy: value.policy,
      credentials: value.credentials,
      dumpPath: value.dumpPath,
    });
    assert.deepEqual(restore.arguments, [
      "--dbname=service=grabenplaner_backup",
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      value.dumpPath,
    ]);
    assert.doesNotMatch(JSON.stringify(restore.arguments), /password|postgres(?:ql)?:\/\//i);
  } finally {
    value.cleanup();
  }
});

test("DB Block 6: unsichere Credential-Datei, Symlink und vorhandenes Dumpziel scheitern geschlossen", (t) => {
  const value = fixture();
  try {
    if (process.platform !== "win32") {
      fs.chmodSync(value.passwordFilePath, 0o640);
      assert.throws(
        () => createPostgresqlToolCredentials({
          serviceName: "grabenplaner_backup",
          serviceFilePath: value.serviceFilePath,
          passwordFilePath: value.passwordFilePath,
        }),
        (error) => error?.code === ERROR_CODES.CREDENTIAL_FILE_UNSAFE,
      );
      fs.chmodSync(value.passwordFilePath, 0o600);
    }
    fs.writeFileSync(value.dumpPath, "already-here");
    assert.throws(
      () => buildPostgresqlDumpCommand({
        policy: value.policy,
        credentials: value.credentials,
        targetPath: value.dumpPath,
        exportedSnapshot: "00000003-0000001B-1",
      }),
      (error) => error?.code === ERROR_CODES.CONFIGURATION_INVALID,
    );

    const link = path.join(value.root, "linked-pass");
    try {
      fs.symlinkSync(value.passwordFilePath, link);
    } catch {
      t.diagnostic("Symlink-Erstellung ist in dieser Testumgebung nicht verfügbar.");
      return;
    }
    assert.throws(
      () => createPostgresqlToolCredentials({
        serviceName: "grabenplaner_backup",
        serviceFilePath: value.serviceFilePath,
        passwordFilePath: link,
      }),
      (error) => error?.code === ERROR_CODES.CREDENTIAL_FILE_UNSAFE,
    );
  } finally {
    value.cleanup();
  }
});

test("DB Block 6: Toolversion muss exakt zum freigegebenen Major passen", () => {
  assert.equal(parsePostgresqlToolMajor("pg_dump (PostgreSQL) 18.4", 18), 18);
  assert.throws(
    () => parsePostgresqlToolMajor("pg_restore (PostgreSQL) 17.9", 18),
    (error) => error?.code === ERROR_CODES.TOOL_VERSION_MISMATCH,
  );
  assert.throws(
    () => parsePostgresqlToolMajor("unbekannte Ausgabe", 18),
    (error) => error?.code === ERROR_CODES.TOOL_VERSION_MISMATCH,
  );
});

test("DB Block 6: Runner gibt nur begrenzte, redigierbare Ergebnisse zurück", async () => {
  const value = fixture();
  try {
    const result = await runPostgresqlTool(
      buildPostgresqlVersionCommand({ executable: value.pgDumpPath }),
      {
        spawn: fakeSpawn({
          stdout: "pg_dump (PostgreSQL) 18.4\n",
          stderr: "interne Diagnose mit postgresql://admin:secret@host/db",
        }),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "pg_dump (PostgreSQL) 18.4\n");
    assert.equal(result.stderrCaptured, true);
    assert.doesNotMatch(JSON.stringify(result), /secret|admin|host\/db/);
  } finally {
    value.cleanup();
  }
});

test("DB Block 6: Toolfehler transportieren weder stderr noch Secrets", async () => {
  const value = fixture();
  try {
    await assert.rejects(
      runPostgresqlTool(
        buildPostgresqlVersionCommand({ executable: value.pgDumpPath }),
        {
          spawn: fakeSpawn({
            stderr: "postgresql://admin:SEHR-GEHEIM@database.example/app",
            exitCode: 1,
          }),
        },
      ),
      (error) => {
        assert.equal(error?.code, ERROR_CODES.TOOL_FAILED);
        assert.doesNotMatch(`${error?.message}\n${JSON.stringify(error)}`, /SEHR-GEHEIM|database\.example|postgresql:\/\//);
        return true;
      },
    );
  } finally {
    value.cleanup();
  }
});

test("DB Block 6: Abort wartet auf das tatsaechliche Prozessende bevor Cleanup beginnen darf", async () => {
  const value = fixture();
  try {
    const controller = new AbortController();
    const observed = [];
    let settled = false;
    const running = runPostgresqlTool(
      buildPostgresqlVersionCommand({ executable: value.pgDumpPath }),
      {
        signal: controller.signal,
        spawn: abortableSpawn(observed),
      },
    ).finally(() => {
      settled = true;
    });
    controller.abort();
    assert.equal(settled, false);
    await assert.rejects(
      running,
      (error) => error?.code === ERROR_CODES.TOOL_ABORTED,
    );
    assert.deepEqual(observed, ["SIGTERM"]);
    assert.equal(settled, true);
  } finally {
    value.cleanup();
  }
});

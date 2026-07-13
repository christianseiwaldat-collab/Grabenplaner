"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { setTimeout: delay } = require("node:timers/promises");

const PORT = 3000;
const ADMIN_EMPLOYEE_NUMBER = "101";
const STATE_BASE = "/workspaces/.grabenplaner-codespaces";
const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(REPOSITORY_ROOT, "server.js");
const SHUTDOWN_GRACE_MS = 50_000;

process.umask(0o077);

let context = null;
let currentProcess = null;
let shutdownRequested = false;
const shutdownController = new AbortController();

class ShutdownRequestedError extends Error {}

function buildContext() {
  if (process.env.CODESPACES !== "true") {
    throw new Error("Der Codespaces-Runner darf nur in GitHub Codespaces gestartet werden.");
  }

  const codespaceName = String(process.env.CODESPACE_NAME || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(codespaceName)) {
    throw new Error("CODESPACE_NAME fehlt oder enthält unerwartete Zeichen.");
  }

  const forwardingDomain = String(process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || "app.github.dev").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(forwardingDomain) || !forwardingDomain.includes(".")) {
    throw new Error("GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ist ungültig.");
  }

  const stateRoot = path.join(STATE_BASE, codespaceName);
  if (path.dirname(stateRoot) !== STATE_BASE) {
    throw new Error("Das Codespaces-Datenverzeichnis konnte nicht sicher bestimmt werden.");
  }

  return {
    codespaceName,
    forwardingDomain,
    publicUrl: `https://${codespaceName}-${PORT}.${forwardingDomain}`,
    stateRoot,
    runtimeRoot: path.join(stateRoot, "runtime"),
    databasePath: path.join(stateRoot, "runtime", "data", "dienstplan.db"),
    backupRoot: path.join(stateRoot, "external-backups"),
    secretsPath: path.join(stateRoot, "secrets.json"),
    runnerPidPath: path.join(stateRoot, "runner.pid"),
    serverPidPath: path.join(stateRoot, "server.json"),
    readyPath: path.join(stateRoot, "ready.json"),
  };
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writePrivateFile(filePath, contents) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function writePrivateJson(filePath, value) {
  writePrivateFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireRunnerPidFile(ctx) {
  const candidatePath = `${ctx.runnerPidPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.candidate`;
  fs.writeFileSync(candidatePath, `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    try {
      // The hard link publishes an already complete PID file atomically.
      fs.linkSync(candidatePath, ctx.runnerPidPath);
      fs.chmodSync(ctx.runnerPidPath, 0o600);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existingPid = Number.parseInt(fs.readFileSync(ctx.runnerPidPath, "utf8").trim(), 10);
      if (!Number.isSafeInteger(existingPid) || existingPid <= 0) {
        throw new Error("Die Runner-Prozesssperre enthält keine gültige PID; sie wird nicht unsicher ersetzt.");
      }
      if (processIsAlive(existingPid)) {
        throw new Error(`Ein Codespaces-Runner läuft bereits in Prozess ${existingPid}.`);
      }
      throw new Error(`Die veraltete Runner-Prozesssperre für PID ${existingPid} muss vor dem Start entfernt werden.`);
    }
  } finally {
    fs.rmSync(candidatePath, { force: true });
  }
}

function removeRunnerPidFile(ctx) {
  try {
    const recordedPid = Number.parseInt(fs.readFileSync(ctx.runnerPidPath, "utf8").trim(), 10);
    if (recordedPid === process.pid) fs.rmSync(ctx.runnerPidPath, { force: true });
  } catch {}
}

function loadOrCreateSecrets(ctx) {
  let secrets;
  if (fs.existsSync(ctx.secretsPath)) {
    fs.chmodSync(ctx.secretsPath, 0o600);
    secrets = readJsonFile(ctx.secretsPath);
  } else {
    secrets = {
      schemaVersion: 1,
      warning: "Nur für die Codespaces-Demo-/Testumgebung verwenden.",
      adminEmployeeNumber: ADMIN_EMPLOYEE_NUMBER,
      adminPassword: `${crypto.randomBytes(18).toString("base64url")}aA7!`,
      serviceControlToken: crypto.randomBytes(48).toString("base64url"),
      amuKeyId: `codespaces-${crypto.randomUUID()}`,
      amuKey: crypto.randomBytes(32).toString("base64"),
      createdAt: new Date().toISOString(),
    };
    writePrivateJson(ctx.secretsPath, secrets);
  }

  const valid = secrets?.schemaVersion === 1
    && secrets.adminEmployeeNumber === ADMIN_EMPLOYEE_NUMBER
    && typeof secrets.adminPassword === "string" && secrets.adminPassword.length >= 10
    && typeof secrets.serviceControlToken === "string" && secrets.serviceControlToken.length >= 32
    && typeof secrets.amuKeyId === "string" && secrets.amuKeyId.length >= 8
    && typeof secrets.amuKey === "string" && Buffer.from(secrets.amuKey, "base64").length === 32;
  if (!valid) {
    throw new Error(`Die Secrets-Datei ist ungültig: ${ctx.secretsPath}`);
  }
  return secrets;
}

function hasConfiguredAdmin(ctx) {
  if (!fs.existsSync(ctx.databasePath)) return false;
  const database = new DatabaseSync(ctx.databasePath, { readOnly: true });
  try {
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'portal_users'").get();
    if (!table) return false;
    return Boolean(database.prepare(`
      SELECT 1 FROM portal_users
      WHERE active = 1 AND role = 'admin' AND TRIM(password_hash) <> ''
      LIMIT 1
    `).get());
  } finally {
    database.close();
  }
}

function isGitHubTokenVariable(name) {
  const upperName = String(name).toUpperCase();
  const segments = upperName.split("_");
  if (segments[0] !== "GITHUB" && segments[0] !== "GH") return upperName === "CODESPACES_TOKEN";
  return segments.includes("TOKEN") || segments.includes("PAT");
}

function cleanChildEnvironment() {
  const clean = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || isGitHubTokenVariable(name)) continue;
    if (name.startsWith("GRABENPLANER_")) continue;
    if (["PORT", "DB_PATH", "BACKUP_DIR", "ALLOW_UNSCANNED_AMU_UPLOADS"].includes(name)) continue;
    clean[name] = value;
  }
  return clean;
}

function commonServerEnvironment(ctx, secrets, port) {
  return {
    ...cleanChildEnvironment(),
    NODE_ENV: "test",
    TZ: "Europe/Vienna",
    PORT: String(port),
    DB_PATH: ctx.databasePath,
    BACKUP_DIR: ctx.backupRoot,
    GRABENPLANER_DATA_DIR: ctx.runtimeRoot,
    GRABENPLANER_HOST: "127.0.0.1",
    GRABENPLANER_AMU_KEY_ID: secrets.amuKeyId,
    GRABENPLANER_AMU_KEY: secrets.amuKey,
  };
}

function localSetupEnvironment(ctx, secrets, port) {
  return {
    ...commonServerEnvironment(ctx, secrets, port),
    GRABENPLANER_OPERATION_MODE: "local",
    GRABENPLANER_FORCE_PORTAL: "1",
    GRABENPLANER_SEED_DEMO: "1",
  };
}

function serverEnvironment(ctx, secrets) {
  return {
    ...commonServerEnvironment(ctx, secrets, PORT),
    GRABENPLANER_OPERATION_MODE: "server",
    GRABENPLANER_DEPLOYMENT_KIND: "codespaces-test",
    GRABENPLANER_PUBLIC_URL: ctx.publicUrl,
    GRABENPLANER_TRUST_PROXY: "loopback",
    GRABENPLANER_SERVICE_CONTROL_TOKEN: secrets.serviceControlToken,
    // Test-only switch requested for Codespaces plus the name used by the current server.
    ALLOW_UNSCANNED_AMU_UPLOADS: "1",
    GRABENPLANER_ALLOW_UNSCANNED_AMU: "1",
  };
}

function removeServerPidFile(ctx, expectedPid) {
  try {
    const recorded = readJsonFile(ctx.serverPidPath);
    if (Number(recorded.pid) === expectedPid) fs.rmSync(ctx.serverPidPath, { force: true });
  } catch {}
}

function spawnManagedServer(ctx, phase, environment) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const record = {
    child,
    phase,
    pid: child.pid,
    startedAt: Date.now(),
    result: null,
    spawnError: null,
    stopPromise: null,
  };
  record.exit = new Promise((resolve) => {
    child.once("error", (error) => { record.spawnError = error; });
    child.once("close", (code, signal) => {
      record.result = { code, signal, error: record.spawnError };
      removeServerPidFile(ctx, record.pid);
      if (currentProcess === record) currentProcess = null;
      resolve(record.result);
    });
  });
  currentProcess = record;
  writePrivateJson(ctx.serverPidPath, {
    pid: record.pid,
    phase,
    serverEntry: SERVER_ENTRY,
    dataRoot: ctx.runtimeRoot,
    startedAt: new Date(record.startedAt).toISOString(),
  });
  return record;
}

async function stopManagedServer(record, reason) {
  if (!record || record.result) return;
  if (record.stopPromise) return record.stopPromise;
  record.stopPromise = (async () => {
    console.log(`[Codespaces] Beende ${record.phase} sauber (${reason}) ...`);
    try { record.child.kill("SIGTERM"); } catch {}
    const graceful = await Promise.race([
      record.exit.then(() => true),
      delay(SHUTDOWN_GRACE_MS, false, { ref: false }),
    ]);
    if (!graceful && !record.result) {
      console.error(`[Codespaces] ${record.phase} reagiert nicht; erzwinge das Beenden.`);
      try { record.child.kill("SIGKILL"); } catch {}
      await Promise.race([
        record.exit,
        delay(5_000, undefined, { ref: false }),
      ]);
    }
  })();
  return record.stopPromise;
}

async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForPortalStatus(record, port, { timeoutMs = 60_000, forwardedHttps = false } = {}) {
  const url = `http://127.0.0.1:${port}/api/portal/v1/status`;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (shutdownRequested) throw new ShutdownRequestedError();
    if (record.result) {
      const detail = record.result.error?.message || `Exit ${record.result.code ?? "?"}/${record.result.signal || "ohne Signal"}`;
      throw new Error(`${record.phase} wurde vor der Bereitschaft beendet: ${detail}`);
    }
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          ...(forwardedHttps ? { "X-Forwarded-Proto": "https" } : {}),
        },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250, undefined, { ref: false });
  }
  throw new Error(`${record.phase} wurde nicht rechtzeitig bereit: ${lastError?.message || "Zeitüberschreitung"}`);
}

async function initialiseAdmin(ctx, secrets) {
  const setupPort = await freeLoopbackPort();
  console.log(`[Codespaces] Phase 1: lokale Demo-Initialisierung auf Loopback-Port ${setupPort}.`);
  const record = spawnManagedServer(ctx, "Phase 1", localSetupEnvironment(ctx, secrets, setupPort));
  try {
    const status = await waitForPortalStatus(record, setupPort);
    if (status.adminSetupState === "configured") return;
    const response = await fetch(`http://127.0.0.1:${setupPort}/api/portal/v1/setup/admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        employeeNumber: secrets.adminEmployeeNumber,
        password: secrets.adminPassword,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 201) {
      throw new Error(`Admin-Einrichtung fehlgeschlagen (HTTP ${response.status}): ${(await response.text()).slice(0, 500)}`);
    }
    console.log(`[Codespaces] Demo-Admin ${secrets.adminEmployeeNumber} wurde lokal eingerichtet.`);
  } finally {
    await stopManagedServer(record, "Wechsel in den Servermodus");
  }
  if (!hasConfiguredAdmin(ctx)) {
    throw new Error("Die lokale Admin-Einrichtung wurde nicht dauerhaft in der Testdatenbank gespeichert.");
  }
}

function managedServerMatches(ctx, pid) {
  if (process.platform !== "linux" || !processIsAlive(pid)) return false;
  try {
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    const environment = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    return command.includes(SERVER_ENTRY)
      && environment.includes(`GRABENPLANER_DATA_DIR=${ctx.runtimeRoot}`);
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await delay(250);
  }
  return !processIsAlive(pid);
}

async function stopOrphanedServer(ctx) {
  if (!fs.existsSync(ctx.serverPidPath)) return;
  let pid = 0;
  try { pid = Number(readJsonFile(ctx.serverPidPath).pid); } catch {}
  if (!processIsAlive(pid)) {
    fs.rmSync(ctx.serverPidPath, { force: true });
    return;
  }
  if (!managedServerMatches(ctx, pid)) {
    console.warn(`[Codespaces] Ignoriere fremden Prozess ${pid} aus einer veralteten Server-PID-Datei.`);
    fs.rmSync(ctx.serverPidPath, { force: true });
    return;
  }
  console.warn(`[Codespaces] Beende verwaisten Grabenplaner-Prozess ${pid}.`);
  try { process.kill(pid, "SIGTERM"); } catch {}
  if (!await waitForProcessExit(pid, SHUTDOWN_GRACE_MS)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
    await waitForProcessExit(pid, 5_000);
  }
  fs.rmSync(ctx.serverPidPath, { force: true });
}

function writeReadyState(ctx, record) {
  writePrivateJson(ctx.readyPath, {
    ready: true,
    warning: "Nur Demo- und Testdaten verwenden.",
    url: ctx.publicUrl,
    port: PORT,
    visibility: "private",
    runnerPid: process.pid,
    serverPid: record.pid,
    readyAt: new Date().toISOString(),
  });
}

function describeExit(result) {
  if (result?.error) return result.error.message;
  if (result?.signal) return `Signal ${result.signal}`;
  return `Exit-Code ${result?.code ?? "unbekannt"}`;
}

async function superviseServer(ctx, secrets) {
  let shortFailureCount = 0;
  while (!shutdownRequested) {
    fs.rmSync(ctx.readyPath, { force: true });
    const record = spawnManagedServer(ctx, "Phase 2", serverEnvironment(ctx, secrets));
    let becameReady = false;
    try {
      const status = await waitForPortalStatus(record, PORT, { forwardedHttps: true });
      if (status.adminSetupState !== "configured"
        || status.portalEnabled !== true
        || status.publicUrl !== ctx.publicUrl
        || status.httpsRequired !== true
        || status.listenHost !== "127.0.0.1"
        || status.trustProxy !== "loopback"
        || status.deploymentKind !== "codespaces-test") {
        throw new Error("Der Servermodus meldet nicht die erwartete Codespaces-Konfiguration.");
      }
      becameReady = true;
      writeReadyState(ctx, record);
      console.warn("\n======================================================================");
      console.warn("ACHTUNG: Diese Codespaces-Instanz ist ausschließlich für Demo-/Testdaten.");
      console.warn("Keine echten Personal-, Gesundheits- oder Produktivdaten verwenden.");
      console.warn(`Privater Codespaces-Zugriff: ${ctx.publicUrl}`);
      console.warn(`Zugangsdaten: ${ctx.secretsPath}`);
      console.warn("======================================================================\n");
      const result = await record.exit;
      if (!shutdownRequested) console.error(`[Codespaces] Server beendet (${describeExit(result)}).`);
    } catch (error) {
      if (!(error instanceof ShutdownRequestedError) && !shutdownRequested) {
        console.error(`[Codespaces] Serverstart fehlgeschlagen: ${error.message}`);
      }
      await stopManagedServer(record, shutdownRequested ? "Runner wird beendet" : "fehlgeschlagener Start");
    } finally {
      fs.rmSync(ctx.readyPath, { force: true });
    }

    if (shutdownRequested) return;
    const uptimeMs = Date.now() - record.startedAt;
    shortFailureCount = becameReady && uptimeMs >= 60_000 ? 0 : Math.min(shortFailureCount + 1, 6);
    const restartDelayMs = Math.min(30_000, 1_000 * (2 ** Math.max(0, shortFailureCount - 1)));
    console.error(`[Codespaces] Neustart in ${Math.round(restartDelayMs / 1_000)} Sekunde(n).`);
    try {
      await delay(restartDelayMs, undefined, { signal: shutdownController.signal });
    } catch (error) {
      if (error?.name !== "AbortError") throw error;
    }
  }
}

function requestShutdown(signal) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  console.log(`[Codespaces] ${signal} empfangen; Runner wird beendet.`);
  shutdownController.abort();
  if (context) fs.rmSync(context.readyPath, { force: true });
  void stopManagedServer(currentProcess, signal).catch((error) => {
    console.error(`[Codespaces] Fehler beim Beenden: ${error.message}`);
  });
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

async function main() {
  context = buildContext();
  ensurePrivateDirectory(STATE_BASE);
  ensurePrivateDirectory(context.stateRoot);
  ensurePrivateDirectory(context.runtimeRoot);
  ensurePrivateDirectory(path.dirname(context.databasePath));
  ensurePrivateDirectory(context.backupRoot);
  acquireRunnerPidFile(context);
  fs.rmSync(context.readyPath, { force: true });

  try {
    await stopOrphanedServer(context);
    if (shutdownRequested) return;
    const adminAlreadyConfigured = hasConfiguredAdmin(context);
    if (adminAlreadyConfigured && !fs.existsSync(context.secretsPath)) {
      throw new Error("Die Testdatenbank enthält bereits einen Admin, aber secrets.json fehlt. Die Zugangsdaten werden nicht unsicher ersetzt.");
    }
    const secrets = loadOrCreateSecrets(context);
    if (!adminAlreadyConfigured) await initialiseAdmin(context, secrets);
    if (shutdownRequested) return;
    console.log(`[Codespaces] Phase 2: Servermodus mit ${context.publicUrl}.`);
    await superviseServer(context, secrets);
  } finally {
    fs.rmSync(context.readyPath, { force: true });
    await stopManagedServer(currentProcess, "Runner-Ende");
    removeRunnerPidFile(context);
  }
}

main().catch((error) => {
  console.error(`[Codespaces] Runner abgebrochen: ${error.stack || error.message}`);
  process.exitCode = 1;
});

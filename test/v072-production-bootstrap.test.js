"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { once } = require("node:events");
const { Worker } = require("node:worker_threads");

function openFixtureDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  // HTTP liveness does not imply that startup/background writes have finished.
  // Match the application's bounded SQLite writer coordination for this second
  // connection; the existing server/test deadlines remain unchanged.
  database.exec("PRAGMA busy_timeout = 5000");
  return database;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server vorzeitig beendet (Exit ${child.exitCode}).`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Zeitueberschreitung beim Serverstart.");
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", resolve));
}

test("bootstrap fixture waits for an existing SQLite writer to release its lock", { timeout: 10_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-bootstrap-lock-"));
  const databasePath = path.join(root, "fixture.db");
  const setup = new DatabaseSync(databasePath);
  setup.exec("PRAGMA journal_mode = WAL; CREATE TABLE fixture (active INTEGER); INSERT INTO fixture VALUES (1)");
  setup.close();
  const holder = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(workerData);
    database.exec("BEGIN IMMEDIATE");
    parentPort.postMessage("locked");
    parentPort.once("message", () => setTimeout(() => {
      database.exec("COMMIT");
      database.close();
      parentPort.postMessage("released");
      parentPort.close();
    }, 50));
  `, { eval: true, workerData: databasePath });
  let database;
  try {
    assert.deepEqual(await once(holder, "message"), ["locked"]);
    const uncoordinated = new DatabaseSync(databasePath);
    try {
      assert.throws(() => uncoordinated.prepare("UPDATE fixture SET active = 0").run(),
        error => error.code === "ERR_SQLITE_ERROR" && error.errcode === 5);
    } finally { uncoordinated.close(); }
    database = openFixtureDatabase(databasePath);
    assert.equal(database.prepare("PRAGMA busy_timeout").get().timeout, 5000);
    const released = once(holder, "message");
    holder.postMessage("release");
    assert.equal(database.prepare("UPDATE fixture SET active = 0").run().changes, 1);
    assert.deepEqual(await released, ["released"]);
    assert.equal(database.prepare("SELECT active FROM fixture").get().active, 0);
  } finally {
    database?.close();
    await holder.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("v0.72 browser bootstrap keeps the one-time key local and sends it only on mutations", () => {
  const application = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const portalAccessCatalog = fs.readFileSync(
    path.join(__dirname, "..", "lib", "persistence", "sqlite", "portal-access-catalog.js"),
    "utf8",
  );

  assert.match(application, /parameters\.delete\("bootstrap"\)/);
  assert.match(application, /window\.history\.replaceState/);
  assert.match(application, /target\.origin !== window\.location\.origin/);
  assert.match(application, /\["GET", "HEAD", "OPTIONS"\]\.includes\(method\)/);
  assert.match(application, /X-Grabenplaner-Bootstrap-Token/);
  assert.match(portalAccessCatalog, /role IN \('developer','it_admin','admin'\)/);
  assert.match(server, /configuredAdminSnapshot = Boolean\(await portalAccessRepository\.getConfiguredAdmin\(\{\}\)\)/);
  assert.match(server, /if \(\(serverModeActive && !productionBootstrapActive\) \|\| !isLoopbackRequest\(request\)\)/);
});

test("v0.72 production bootstrap enforces the server password minimum on loopback", { timeout: 40_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v072-bootstrap-"));
  const databasePath = path.join(root, "data", "dienstplan.db");
  const port = await freePort();
  const bootstrapToken = "bootstrap-test-token-0123456789abcdef";
  const environment = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DB_PATH: databasePath,
    BACKUP_DIR: path.join(root, "backups"),
    GRABENPLANER_DATA_DIR: root,
    GRABENPLANER_HOST: "127.0.0.1",
    GRABENPLANER_OPERATION_MODE: "server",
    GRABENPLANER_DEPLOYMENT_KIND: "production",
    GRABENPLANER_BOOTSTRAP_MODE: "1",
    GRABENPLANER_PUBLIC_URL: "https://plan.example.test",
    GRABENPLANER_TRUST_PROXY: "loopback",
    GRABENPLANER_SERVICE_CONTROL_TOKEN: "service-control-test-token-0123456789abcdef",
    GRABENPLANER_BOOTSTRAP_TOKEN: bootstrapToken,
    GRABENPLANER_AMU_KEY_ID: "server-test-v1",
    GRABENPLANER_AMU_KEY: Buffer.alloc(32, 17).toString("base64"),
  };
  for (const key of ["GRABENPLANER_SEED_DEMO", "GRABENPLANER_DEMO_PROFILE", "GRABENPLANER_FORCE_PORTAL"]){
    delete environment[key];
  }

  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const origin = `http://127.0.0.1:${port}`;

  try {
    await waitForServer(`${origin}/api/health/live`, child);
    const statusResponse = await fetch(`${origin}/api/portal/v1/status`);
    assert.equal(statusResponse.status, 200, await statusResponse.clone().text());
    assert.equal((await statusResponse.json()).passwordMinLength, 10);

    const database = openFixtureDatabase(databasePath);
    try {
      const insertEmployee = database.prepare(`
        INSERT INTO employees (personnel_number, full_name, nickname, color, contracted_hours, active)
        VALUES (?, ?, ?, '#26755c', 40, 1)
      `);
      insertEmployee.run("900", "Server Admin", "Admin");
      insertEmployee.run("901", "Zweites Teammitglied", "Team");
    } finally {
      database.close();
    }

    const setupResponse = await fetch(`${origin}/api/portal/v1/setup/admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "900", password: "123456" }),
    });
    assert.equal(setupResponse.status, 403, await setupResponse.clone().text());
    assert.equal((await setupResponse.json()).code, "BOOTSTRAP_TOKEN_REQUIRED");

    const authorizedSetupResponse = await fetch(`${origin}/api/portal/v1/setup/admin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Grabenplaner-Bootstrap-Token": bootstrapToken,
      },
      body: JSON.stringify({ employeeNumber: "900", password: "123456" }),
    });
    assert.equal(authorizedSetupResponse.status, 400, await authorizedSetupResponse.clone().text());
    assert.match((await authorizedSetupResponse.json()).error, /mindestens 10 Zeichen/i);

    const wrongOriginResponse = await fetch(`${origin}/api/portal/v1/setup/admin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${port + 1}`,
        "X-Grabenplaner-Bootstrap-Token": bootstrapToken,
      },
      body: JSON.stringify({ employeeNumber: "900", password: "ServerPasswort123!" }),
    });
    assert.equal(wrongOriginResponse.status, 403, await wrongOriginResponse.clone().text());
    assert.equal((await wrongOriginResponse.json()).code, "ORIGIN_NOT_ALLOWED");

    const completedSetupResponse = await fetch(`${origin}/api/portal/v1/setup/admin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Grabenplaner-Bootstrap-Token": bootstrapToken,
      },
      body: JSON.stringify({ employeeNumber: "900", password: "ServerPasswort123!" }),
    });
    assert.equal(completedSetupResponse.status, 201, await completedSetupResponse.clone().text());

    child.kill();
    await waitForExit(child);

    const serverPort = await freePort();
    const serverChild = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...environment,
        PORT: String(serverPort),
        GRABENPLANER_OPERATION_MODE: "server",
        GRABENPLANER_BOOTSTRAP_MODE: "",
        GRABENPLANER_PUBLIC_URL: "https://plan.example.test",
        GRABENPLANER_TRUST_PROXY: "loopback",
        GRABENPLANER_SERVICE_CONTROL_TOKEN: "service-control-test-token-0123456789abcdef",
      },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let serverStderr = "";
    serverChild.stderr.on("data", (chunk) => { serverStderr += chunk.toString(); });
    const serverOrigin = `http://127.0.0.1:${serverPort}`;
    try {
      try {
        await waitForServer(`${serverOrigin}/api/health/live`, serverChild);
      } catch (error) {
        throw new Error(`${error.message}\n${serverStderr}`);
      }
      const serverDatabase = openFixtureDatabase(databasePath);
      try {
        serverDatabase.prepare("UPDATE portal_users SET active = 0 WHERE employee_number = '900'").run();
      } finally {
        serverDatabase.close();
      }
      const publicSetupResponse = await fetch(`${serverOrigin}/api/portal/v1/setup/admin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-Proto": "https",
        },
        body: JSON.stringify({ employeeNumber: "901", password: "AngreiferPasswort123!" }),
      });
      assert.equal(publicSetupResponse.status, 403, await publicSetupResponse.clone().text());
      assert.match((await publicSetupResponse.json()).error, /lokalen Einrichtungsmodus/i);
    } finally {
      if (serverChild.exitCode === null) serverChild.kill();
      await waitForExit(serverChild);
      assert.doesNotMatch(serverStderr, /SERVER_RUNTIME_CONFIGURATION_INVALID/);
    }
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

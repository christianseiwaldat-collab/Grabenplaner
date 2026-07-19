"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

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

test("v0.72 browser bootstrap keeps the one-time key local and sends it only on mutations", () => {
  const application = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

  assert.match(application, /parameters\.delete\("bootstrap"\)/);
  assert.match(application, /window\.history\.replaceState/);
  assert.match(application, /target\.origin !== window\.location\.origin/);
  assert.match(application, /\["GET", "HEAD", "OPTIONS"\]\.includes\(method\)/);
  assert.match(application, /X-Grabenplaner-Bootstrap-Token/);
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
    GRABENPLANER_OPERATION_MODE: "local",
    GRABENPLANER_DEPLOYMENT_KIND: "production",
    GRABENPLANER_BOOTSTRAP_TOKEN: bootstrapToken,
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

    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(`
        INSERT INTO employees (personnel_number, full_name, nickname, color, contracted_hours, active)
        VALUES ('900', 'Server Admin', 'Admin', '#26755c', 40, 1)
      `).run();
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
        "X-Grabenplaner-Bootstrap-Token": bootstrapToken,
      },
      body: JSON.stringify({ employeeNumber: "900", password: "123456" }),
    });
    assert.equal(authorizedSetupResponse.status, 400, await authorizedSetupResponse.clone().text());
    assert.match((await authorizedSetupResponse.json()).error, /mindestens 10 Zeichen/i);

    const exitResponse = await fetch(`${origin}/api/system/exit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Grabenplaner-Bootstrap-Token": bootstrapToken,
      },
      body: "{}",
    });
    assert.equal(exitResponse.status, 200, await exitResponse.clone().text());
    assert.equal(await waitForExit(child), 0, stderr);
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

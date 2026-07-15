const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const repositoryRoot = path.join(__dirname, "..");

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(url, child, headers = {}, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server vorzeitig beendet: ${child.exitCode}`);
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Server nicht erreichbar: ${url}`);
}

async function waitForExit(child, timeoutMs = 12_000) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server wurde nicht rechtzeitig beendet.")), timeoutMs);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
}

async function rawHttpRequest(url, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: responseBody,
      }));
    });
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function spawnServer(environment) {
  return spawn(process.execPath, [path.join(repositoryRoot, "server.js")], {
    cwd: repositoryRoot,
    windowsHide: true,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("v0.57: Codespaces nutzt die Sporthandel-Demo und vertraut nur dem gleichurspruenglichen GitHub-Proxy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v057-codespaces-"));
  const databasePath = path.join(root, "dienstplan.db");
  const common = {
    DB_PATH: databasePath,
    BACKUP_DIR: path.join(root, "backups"),
    GRABENPLANER_DATA_DIR: path.join(root, "runtime"),
    GRABENPLANER_HOST: "127.0.0.1",
    GRABENPLANER_AMU_KEY_ID: "codespaces-demo-test-v1",
    GRABENPLANER_AMU_KEY: Buffer.alloc(32, 11).toString("base64"),
    GRABENPLANER_WIFI_WEBHOOK_SECRET: "codespaces-demo-wifi-secret-0123456789abcdef",
    GRABENPLANER_SERVICE_CONTROL_TOKEN: "codespaces-demo-control-token-0123456789abcdef",
    GRABENPLANER_TEST_AMU_SCANNER: "clean",
    NODE_ENV: "test",
  };

  const setupPort = await freePort();
  const setup = spawnServer({
    ...common,
    PORT: String(setupPort),
    GRABENPLANER_OPERATION_MODE: "local",
    GRABENPLANER_FORCE_PORTAL: "1",
    GRABENPLANER_SEED_DEMO: "1",
    GRABENPLANER_DEMO_PROFILE: "sporthandel",
  });
  let setupError = "";
  setup.stderr.on("data", (chunk) => { setupError += chunk.toString(); });
  try {
    await waitFor(`http://127.0.0.1:${setupPort}/api/portal/v1/status`, setup);
    const configured = await fetch(`http://127.0.0.1:${setupPort}/api/portal/v1/setup/admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "101", password: "DemoPasswort123!" }),
    });
    assert.equal(configured.status, 201, await configured.clone().text());
    setup.kill("SIGTERM");
    await waitForExit(setup);
    assert.doesNotMatch(setupError, /Error:|Datenbank-Integritaetspruefung fehlgeschlagen/);
  } finally {
    if (setup.exitCode === null) setup.kill();
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM locations").get().count, 6);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM departments").get().count, 15);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM employees").get().count, 33);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM employees WHERE position_id = 'verkaufsmitarbeiter'").get().count, 31);
    assert.equal(database.prepare("SELECT value FROM settings WHERE key = 'branding_company_name'").get().value, "Berg & Ball Sporthandel");
  } finally {
    database.close();
  }

  const port = await freePort();
  const configuredOrigin = "https://alte-adresse-3000.app.github.dev";
  const actualOrigin = "https://aktuelle-adresse-3000.app.github.dev";
  const forwardedHeaders = {
    "X-Forwarded-Proto": "https",
    // Der echte Codespaces-Proxy kann hier den internen Host weiterreichen.
    // Der öffentliche Browser-Host steht dann im normalen Host-Header.
    "X-Forwarded-Host": "127.0.0.1:3000",
    Host: "aktuelle-adresse-3000.app.github.dev",
    Origin: actualOrigin,
  };
  const server = spawnServer({
    ...common,
    PORT: String(port),
    GRABENPLANER_OPERATION_MODE: "server",
    GRABENPLANER_DEPLOYMENT_KIND: "codespaces-test",
    GRABENPLANER_PUBLIC_URL: configuredOrigin,
    GRABENPLANER_TRUST_PROXY: "loopback",
    GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
  });
  let serverError = "";
  server.stderr.on("data", (chunk) => { serverError += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitFor(`${url}/api/portal/v1/status`, server, { "X-Forwarded-Proto": "https" });
    const login = await rawHttpRequest(`${url}/api/portal/v1/auth/login`, {
      method: "POST",
      headers: { ...forwardedHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "101", password: "DemoPasswort123!" }),
    });
    assert.equal(login.status, 200, login.body);
    const cookies = login.headers["set-cookie"] || [];
    const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
    const csrfCookie = cookies.map((value) => value.split(";", 1)[0]).find((value) => value.startsWith("grabenplaner_csrf="));
    const csrf = decodeURIComponent(csrfCookie.split("=").slice(1).join("="));

    const foreign = await rawHttpRequest(`${url}/api/portal/v1/auth/logout`, {
      method: "POST",
      headers: {
        ...forwardedHeaders,
        Origin: "https://fremde-adresse-3000.app.github.dev",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
      },
    });
    assert.equal(foreign.status, 403);

    const spoofedForwardedHost = await rawHttpRequest(`${url}/api/portal/v1/auth/logout`, {
      method: "POST",
      headers: {
        ...forwardedHeaders,
        "X-Forwarded-Host": "fremde-adresse-3000.app.github.dev, aktuelle-adresse-3000.app.github.dev",
        Origin: "https://fremde-adresse-3000.app.github.dev",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
      },
    });
    assert.equal(spoofedForwardedHost.status, 403);

    const stopped = await rawHttpRequest(`${url}/api/system/exit`, {
      method: "POST",
      headers: { ...forwardedHeaders, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
      body: "{}",
    });
    assert.equal(stopped.status, 200, stopped.body);
    assert.equal(await waitForExit(server), 0, serverError);
  } finally {
    if (server.exitCode === null) server.kill();
  }
});

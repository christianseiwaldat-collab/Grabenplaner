"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");

function resolveConsumerPackageRoot(root) {
  const modules = fs.realpathSync(path.join(root, "node_modules"));
  let consumer = createRequire(path.join(root, "package.json"));
  function resolve(name) {
    const file = fs.realpathSync(consumer.resolve(name));
    const relative = path.relative(modules, file);
    assert(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative),
      "MSAL consumer dependency resolved outside the tested GP node_modules: " + name);
    return file;
  }
  for (const name of ["tedious", "@azure/identity"]) consumer = createRequire(resolve(name));
  return path.dirname(resolve("@azure/msal-node/package.json"));
}

const packageRoot = process.env.GP_MSAL_TEST_PACKAGE_ROOT
  ? path.resolve(process.env.GP_MSAL_TEST_PACKAGE_ROOT)
  : resolveConsumerPackageRoot(path.resolve(__dirname, ".."));
const packageRequire = createRequire(path.join(packageRoot, "package.json"));
const tenant = "11111111-1111-4111-8111-111111111111";
const host = "login.microsoftonline.com";
const authority = `https://${host}/${tenant}`;

function verifyIsolatedConsumerResolution(t) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "gp-msal-consumer-resolution-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  function project(name) {
    const root = path.join(fixture, name); fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"private":true}\n');
    return root;
  }
  function dependency(parent, name) {
    const root = path.join(parent, "node_modules", name); fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, main: "index.cjs" }) + "\n");
    fs.writeFileSync(path.join(root, "index.cjs"), "throw new Error('resolution fixtures must never execute');\n");
    return root;
  }
  function isolatedChain(root) {
    return dependency(dependency(dependency(root, "tedious"), "@azure/identity"), "@azure/msal-node");
  }
  const isolated = project("isolated"), expected = isolatedChain(isolated);
  const decoy = dependency(isolated, "@azure/msal-node");
  assert.equal(createRequire(path.join(isolated, "package.json")).resolve("@azure/msal-node/package.json"), path.join(decoy, "package.json"));
  assert.equal(resolveConsumerPackageRoot(isolated), expected, "test the MSAL actually consumed by Tedious, rather than the directly visible decoy");
  for (const missing of ["tedious", "@azure/identity"]) {
    const broken = project(missing === "tedious" ? "missing-tedious" : "missing-identity");
    dependency(broken, "@azure/msal-node");
    if (missing === "@azure/identity") dependency(broken, "tedious");
    assert.throws(() => resolveConsumerPackageRoot(broken), error => error.code === "MODULE_NOT_FOUND" && error.message.includes(missing));
  }
  // A separate process initializes Node's actual NODE_PATH lookup. Prove the
  // globally reachable decoy exists, then require our resolver to reject it.
  const app = project("global-decoy-app"), global = project("global-decoy");
  dependency(app, "@azure/msal-node"); isolatedChain(global);
  const child = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
    const { createRequire } = require('node:module');
    ${resolveConsumerPackageRoot.toString()}
    const app = ${JSON.stringify(app)};
    assert.equal(createRequire(path.join(app, 'package.json')).resolve('tedious'), ${JSON.stringify(path.join(global, "node_modules/tedious/index.cjs"))});
    assert.throws(() => resolveConsumerPackageRoot(app), /outside the tested GP node_modules: tedious/);
  `], { cwd: app, env: { ...process.env, NODE_PATH: path.join(global, "node_modules"), NODE_OPTIONS: "" }, timeout: 10000, encoding: "utf8", windowsHide: true });
  assert.ifError(child.error); assert.equal(child.status, 0, child.stdout + child.stderr);
}

function configuration(networkClient = {
  async sendGetRequestAsync() { throw new Error("unexpected synthetic network call"); },
  async sendPostRequestAsync() { throw new Error("unexpected synthetic network call"); },
}) {
  return {
    auth: {
      clientId: "22222222-2222-4222-8222-222222222222", authority, clientSecret: "synthetic-client-secret",
      authorityMetadata: JSON.stringify({
        authorization_endpoint: `${authority}/oauth2/v2.0/authorize`, token_endpoint: `${authority}/oauth2/v2.0/token`,
        issuer: `${authority}/v2.0`, jwks_uri: `${authority}/discovery/v2.0/keys`, end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
      }),
      cloudDiscoveryMetadata: JSON.stringify({
        tenant_discovery_endpoint: `${authority}/.well-known/openid-configuration`,
        metadata: [{ preferred_network: host, preferred_cache: host, aliases: [host] }],
      }),
    },
    system: { networkClient, loggerOptions: { loggerCallback() {} } },
  };
}

function tokenRequest(overrides = {}) {
  return { code: "trusted-request-code", nonce: "trusted-request-nonce", state: "expected-state", scopes: ["https://graph.microsoft.com/.default"], redirectUri: "https://application.example.test/callback", ...overrides };
}

for (const format of ["CommonJS", "ESM"]) {
  async function library() {
    return format === "CommonJS" ? packageRequire("./lib/msal-node.cjs") : import(pathToFileURL(path.join(packageRoot, "dist/index.mjs")).href);
  }

  test(`MSAL backport (${format}): untrusted response cannot override routing, code or expected nonce`, async t => {
    if (format === "CommonJS") verifyIsolatedConsumerResolution(t);
    const { ConfidentialClientApplication } = await library();
    const base = Object.getPrototypeOf(ConfidentialClientApplication.prototype);
    const original = base.acquireTokenByCode;
    const request = Object.freeze(tokenRequest());
    const payload = Object.freeze({ code: "attacker-code", nonce: "attacker-nonce", state: "returned-state",
      cloud_instance_host_name: "attacker.example.test", cloud_instance_name: "attacker-cloud",
      cloud_graph_host_name: "attacker-graph.example.test", msgraph_host: "attacker-msgraph.example.test", client_info: "attacker-info" });
    let captured;
    base.acquireTokenByCode = async (...args) => { captured = args; return { synthetic: true }; };
    try {
      assert.deepEqual(await new ConfidentialClientApplication(configuration()).acquireTokenByCode(request, payload), { synthetic: true });
      assert.equal(captured[0], request);
      assert.deepEqual(captured[1], { code: "trusted-request-code", state: "returned-state", nonce: "trusted-request-nonce" });
      assert.equal(payload.code, "attacker-code");
    } finally { base.acquireTokenByCode = original; }
  });

  test(`MSAL backport (${format}): ordinary one-argument code flow is unchanged`, async () => {
    const { ConfidentialClientApplication } = await library();
    const base = Object.getPrototypeOf(ConfidentialClientApplication.prototype);
    const original = base.acquireTokenByCode;
    let captured;
    base.acquireTokenByCode = async (...args) => { captured = args; return { synthetic: true }; };
    try {
      const request = tokenRequest();
      await new ConfidentialClientApplication(configuration()).acquireTokenByCode(request);
      assert.equal(captured[0], request);
      assert.equal(captured[1], undefined);
    } finally { base.acquireTokenByCode = original; }
  });

  test(`MSAL backport (${format}): unsupported instance-aware CCA configuration is rejected`, async () => {
    const { ConfidentialClientApplication } = await library();
    const invalid = configuration(); invalid.auth.instanceAware = true;
    assert.throws(() => new ConfidentialClientApplication(invalid), (error) => error.errorCode === "unsupported_cca_instance_aware");
    const valid = configuration(); valid.auth.instanceAware = false;
    assert.ok(new ConfidentialClientApplication(valid));
  });

  test(`MSAL backport (${format}): every explicit instance_aware authorization parameter is rejected before delegation`, async () => {
    const { ConfidentialClientApplication } = await library();
    const base = Object.getPrototypeOf(ConfidentialClientApplication.prototype);
    const original = base.getAuthCodeUrl;
    let calls = 0;
    base.getAuthCodeUrl = async () => { calls += 1; return "synthetic"; };
    try {
      const client = new ConfidentialClientApplication(configuration());
      for (const value of ["true", "false", "", undefined]) {
        await assert.rejects(client.getAuthCodeUrl({ ...tokenRequest(), extraQueryParameters: { instance_aware: value } }),
          (error) => error.errorCode === "unsupported_cca_instance_aware");
      }
      assert.equal(calls, 0);
      assert.equal(await client.getAuthCodeUrl(tokenRequest()), "synthetic");
      assert.equal(calls, 1);
    } finally { base.getAuthCodeUrl = original; }
  });

  test(`MSAL backport (${format}): mismatched returned state still fails before any network action`, async () => {
    const { ConfidentialClientApplication } = await library();
    let calls = 0;
    const networkClient = { async sendGetRequestAsync() { calls += 1; throw new Error("forbidden"); }, async sendPostRequestAsync() { calls += 1; throw new Error("forbidden"); } };
    const client = new ConfidentialClientApplication(configuration(networkClient));
    await assert.rejects(client.acquireTokenByCode(tokenRequest(), { code: "attacker-code", state: "mismatched-state" }),
      (error) => error.errorCode === "state_mismatch");
    assert.equal(calls, 0);
  });

  test(`MSAL backport (${format}): real redemption path never forwards attacker routing metadata`, async () => {
    const { ConfidentialClientApplication } = await library();
    const calls = [];
    // Record synthetic adapter calls and stop them locally. No DNS or HTTP
    // implementation is provided, including for the legitimate authority.
    const networkClient = {
      async sendGetRequestAsync(url) { calls.push({ method: "GET", url }); throw new Error("SYNTHETIC_NETWORK_CAPTURE"); },
      async sendPostRequestAsync(url, options) { calls.push({ method: "POST", url, body: options.body }); throw new Error("SYNTHETIC_NETWORK_CAPTURE"); },
    };
    const client = new ConfidentialClientApplication(configuration(networkClient));
    await assert.rejects(client.acquireTokenByCode(tokenRequest(), {
      code: "attacker-code", state: "expected-state", nonce: "attacker-nonce", cloud_instance_host_name: "attacker.example.test",
    }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(new URL(calls[0].url).hostname, host);
    assert.equal(JSON.stringify(calls).includes("attacker"), false);
    const form = new URLSearchParams(calls[0].body);
    assert.equal(form.get("code"), "trusted-request-code");
    assert.equal(form.get("client_secret"), "synthetic-client-secret");
  });

  test(`MSAL backport (${format}): ordinary client-credential token acquisition remains compatible`, async () => {
    const { ConfidentialClientApplication } = await library();
    const calls = [];
    const networkClient = {
      async sendGetRequestAsync() { throw new Error("unexpected synthetic GET"); },
      async sendPostRequestAsync(url, options) {
        calls.push({ url, body: options.body });
        return { status: 200, headers: {}, body: { access_token: "synthetic-access-token", token_type: "Bearer", expires_in: 3600, ext_expires_in: 3600 } };
      },
    };
    const result = await new ConfidentialClientApplication(configuration(networkClient)).acquireTokenByClientCredential({ scopes: ["https://graph.microsoft.com/.default"] });
    assert.equal(result.accessToken, "synthetic-access-token");
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).hostname, host);
    assert.equal(new URLSearchParams(calls[0].body).get("grant_type"), "client_credentials");
  });
}

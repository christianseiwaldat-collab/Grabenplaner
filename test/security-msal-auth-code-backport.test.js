"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");

const packageRoot = process.env.GP_MSAL_TEST_PACKAGE_ROOT
  ? path.resolve(process.env.GP_MSAL_TEST_PACKAGE_ROOT)
  : path.dirname(require.resolve("@azure/msal-node/package.json"));
const packageRequire = createRequire(path.join(packageRoot, "package.json"));
const tenant = "11111111-1111-4111-8111-111111111111";
const host = "login.microsoftonline.com";
const authority = `https://${host}/${tenant}`;

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

  test(`MSAL backport (${format}): untrusted response cannot override routing, code or expected nonce`, async () => {
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

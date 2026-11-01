"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), path = require("node:path");
const express = require("express"), P = require("../lib/passkey-protocol");

test("Real browser FIDO assertions verify with the maintained server library; UV, RP, origin, challenge and replay failures are rejected", {
  skip: process.env.GP_WINDOW_BROWSER_TEST !== "1", timeout: 60000,
}, async t => {
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, chromiumSandbox: process.platform === "linux", ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const subject = { id: crypto.randomUUID(), principalKind: "employee", principalId: "SYNTHETIC-PASSKEY",
    userHandle: crypto.randomBytes(32).toString("base64url"), authRevision: 1 };
  const challenges = new Map(), credentials = new Map(), bindingHash = P.hash("browser"), authorityHash = P.hash("account"), sessionHash = P.hash("session");
  const repository = { available: async () => true, listCredentials: async () => [...credentials.values()],
    purgeChallenges: async ({ now }) => { for (const [id, value] of challenges) if (value.expiresAt <= now) challenges.delete(id); },
    subjectById: async id => id === subject.id ? subject : null, credential: async id => credentials.get(id) || null,
    issueChallenge: async input => { challenges.set(input.id, structuredClone(input)); return input; },
    consumeChallenge: async input => {
      const row = challenges.get(input.id);
      if (!row || row.consumedAt || row.purpose !== input.purpose || row.bindingHash !== input.bindingHash || row.expiresAt <= input.now) return null;
      row.consumedAt = input.now; return structuredClone(row);
    } };
  const protocol = P.createPasskeyProtocol({ repository, config: P.configuration("https://login.example.invalid") });
  const app = express(); app.use(express.json({ limit: "70kb" }));
  app.post("/register/options", async (_req, res) => res.json(await protocol.registrationOptions({ subject, name: "Testgerät", loginName: "EX-USER", bindingHash, authorityHash, sessionHash })));
  app.post("/register/verify", async (req, res) => {
    const proof = await protocol.verifyRegistration({ ...req.body, bindingHash, authorityHash, sessionHash });
    credentials.set(proof.credential.credentialId, { ...proof.credential, id: crypto.randomUUID(), revision: 1, authRevision: 1, revokedAt: null });
    res.json({ verified: true });
  });
  app.post("/authenticate/options", async (_req, res) => res.json(await protocol.authenticationOptions({ bindingHash })));
  app.post("/reauthenticate/options", async (_req, res) => res.json(await protocol.authenticationOptions({ purpose: "reauthenticate", subject, bindingHash, sessionHash, authorityHash })));
  app.post("/reauthenticate/verify", async (req, res) => {
    await protocol.verifyAuthentication({ ...req.body, purpose: "reauthenticate", bindingHash, sessionHash, authorityHash });
    res.json({ verified: true });
  });
  app.post("/authenticate/verify", async (req, res) => {
    const proof = await protocol.verifyAuthentication({ ...req.body, bindingHash });
    const saved = credentials.get(proof.credential.credentialId); saved.counter = proof.newCounter;
    res.json({ verified: true, counter: proof.newCounter, backedUp: proof.backedUp });
  });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code || "UNEXPECTED" }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://login.example.invalid/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><html lang=de><title>Passkey-Test mit Beispieldaten</title><h1>Passkey-Protokolltest</h1></html>" });
    const result = await fetch(`http://127.0.0.1:${server.address().port}${url.pathname}`, {
      method: route.request().method(), headers: { "Content-Type": "application/json" }, body: route.request().postData(),
    });
    await route.fulfill({ status: result.status, contentType: "application/json", body: await result.text() });
  });
  await page.goto("https://login.example.invalid/");
  await page.addScriptTag({ path: path.join(__dirname, "../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js") });
  const cdp = await page.context().newCDPSession(page); await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true, defaultBackupEligibility: true, defaultBackupState: true,
  } });
  const registration = await page.evaluate(async () => {
    const options = await (await fetch("/register/options", { method: "POST" })).json();
    const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options.options });
    const result = await fetch("/register/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challengeId: options.challengeId, response }) });
    return { status: result.status, result: await result.json(), userHandle: options.options.user.id };
  });
  assert.equal(registration.status, 200, JSON.stringify(registration));
  assert.equal(registration.userHandle, subject.userHandle); assert.equal(credentials.size, 1);
  const virtual = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials[0];
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(virtual.privateKey, "base64"), format: "der", type: "pkcs8" });
  async function assertion() {
    return page.evaluate(async () => {
      const options = await (await fetch("/authenticate/options", { method: "POST" })).json();
      return { challengeId: options.challengeId, response: await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options.options }) };
    });
  }
  function signed(input, mutate) {
    const response = structuredClone(input.response), data = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url"));
    const auth = Buffer.from(response.response.authenticatorData, "base64url"); mutate(data, auth);
    const client = Buffer.from(JSON.stringify(data)); response.response.clientDataJSON = client.toString("base64url");
    response.response.authenticatorData = auth.toString("base64url");
    response.response.signature = crypto.sign("sha256", Buffer.concat([auth, crypto.createHash("sha256").update(client).digest()]), privateKey).toString("base64url");
    return { ...input, response };
  }
  async function verify(input) {
    return page.evaluate(async input => { const result = await fetch("/authenticate/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      return { status: result.status, payload: await result.json() }; }, input);
  }
  for (const mutate of [data => { data.origin = "https://attacker.example.invalid"; },
    data => { data.challenge = crypto.randomBytes(32).toString("base64url"); },
    data => { data.crossOrigin = true; delete data.topOrigin; },
    data => { data.crossOrigin = "false"; }, data => { data.topOrigin = data.origin; },
    (_data, auth) => { auth[32] &= ~(8 | 16); },
    (_data, auth) => { auth[0] ^= 1; }, (_data, auth) => { auth[32] &= ~4; }]) {
    const bad = signed(await assertion(), mutate); const result = await verify(bad);
    assert.equal(result.status, 401, JSON.stringify(result));
    assert.equal((await verify(bad)).payload.code, "PASSKEY_CHALLENGE_EXPIRED");
  }
  for (const userHandle of [null, crypto.randomBytes(32).toString("base64url")]) {
    const bad = await assertion(); bad.response.response.userHandle = userHandle;
    assert.equal((await verify(bad)).status, 401);
  }
  const known = await page.evaluate(async () => {
    const options = await (await fetch("/reauthenticate/options", { method: "POST" })).json();
    const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options.options });
    response.response.userHandle = null;
    return { challengeId: options.challengeId, response };
  });
  const knownResult = await page.evaluate(async body => {
    const result = await fetch("/reauthenticate/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: result.status, body: await result.json() };
  }, known);
  assert.equal(knownResult.status, 200, JSON.stringify(knownResult));
  const changedBackupState = await verify(signed(await assertion(), (_data, auth) => { auth[32] &= ~16; }));
  assert.equal(changedBackupState.status, 200, JSON.stringify(changedBackupState));
  assert.equal(changedBackupState.payload.backedUp, false);
  const zero = signed(await assertion(), (_data, auth) => { auth.writeUInt32BE(0, auth.length - 4); });
  // Model a synced authenticator whose stored and signed counters are both zero.
  // The assertion still carries a real signature from the registered key.
  [...credentials.values()][0].counter = 0;
  assert.equal([...credentials.values()][0].counter, 0);
  const accepted = await verify(zero); assert.equal(accepted.status, 200, JSON.stringify(accepted)); assert.equal(accepted.payload.counter, 0);
  assert.equal((await verify(zero)).status, 401);
  const normal = await verify(await assertion()); assert.equal(normal.status, 200, JSON.stringify(normal)); assert(normal.payload.counter > 0);
  assert.deepEqual(errors, []);
});

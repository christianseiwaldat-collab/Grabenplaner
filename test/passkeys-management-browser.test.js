"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const root = path.resolve(__dirname, ".."), enabled = process.env.GP_WINDOW_BROWSER_TEST === "1";
const ORIGIN = "https://login.example.invalid", BASE = "/api/portal/v1/passkeys";
const { functionSource } = require("../test-support/learning-workspace-ui");
let browser;
test.before(async () => {
  if (!enabled) return;
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, chromiumSandbox: process.platform === "linux", ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
});
test.after(async () => { await browser?.close(); });

test("Branch managers reach only the currently authorized selected account; loading, empty targets and scope changes remove the link", { skip: !enabled }, async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await context.newPage();
  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  const dialog = html.match(/<dialog\b[^>]*id="branchAccountPasswordDialog"[\s\S]*?<\/dialog>/)?.[0]; assert(dialog);
  await page.setContent(dialog);
  await page.evaluate(() => {
    const accountId = "11111111-2222-4333-8444-555555555555";
    window.state = { portalStatus: { portalEnabled: true }, portalSession: { authenticated: true, user: {
      employeeNumber: "SYNTHETIC-MANAGER", role: "manager", permissions: ["organization_accounts:password:manage"], scopes: [{ locationId: "SYN-11" }],
    } }, branchAccountPasswordTargets: [{ id: accountId, loginName: "SYNTHETIC-BRANCH", displayName: "Filiale Beispiel" }] };
    window.elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
    window.escapeHtml = text => String(text);
  });
  await page.addScriptTag({ content: ["canManageBranchAccountPasswords", "branchAccountPasswordAuthorityKey", "syncBranchAccountPasskeyLink",
    "renderBranchAccountPasswordTargets", "loadBranchAccountPasswordTargets"].map(name => functionSource(name, "app.js")).join("\n") });
  const link = page.locator("#branchAccountPasskeysLink");
  await page.evaluate(() => { state.branchAccountPasswordAuthorityKey = branchAccountPasswordAuthorityKey(); renderBranchAccountPasswordTargets(); });
  assert.equal(await link.getAttribute("href"), "/passkeys.html?accountId=11111111-2222-4333-8444-555555555555");
  assert.equal(await link.evaluate(node => node.hidden), false);
  for (const change of ["loading", "empty", "foreign", "malformed", "scope", "rights", "actor"]) {
    await page.evaluate(change => {
      state.branchAccountPasswordLoading = false;
      state.portalSession.user.employeeNumber = "SYNTHETIC-MANAGER";
      state.portalSession.user.permissions = ["organization_accounts:password:manage"];
      state.portalSession.user.scopes = [{ locationId: "SYN-11" }];
      state.branchAccountPasswordAuthorityKey = branchAccountPasswordAuthorityKey();
      state.branchAccountPasswordTargets = [{ id: "11111111-2222-4333-8444-555555555555", loginName: "Synthetic", displayName: "Beispiel" }];
      renderBranchAccountPasswordTargets();
      if (change === "loading") state.branchAccountPasswordLoading = true;
      if (change === "empty") state.branchAccountPasswordTargets = [];
      if (["foreign", "malformed"].includes(change)) {
        const option = document.createElement("option"); option.value = change === "foreign" ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" : "not-a-uuid";
        elements.branchAccountPasswordAccount.append(option); elements.branchAccountPasswordAccount.value = option.value;
        if (change === "malformed") state.branchAccountPasswordTargets.push({ id: option.value });
      }
      if (change === "scope") state.portalSession.user.scopes = [{ locationId: "SYN-OTHER" }];
      if (change === "rights") state.portalSession.user.permissions = [];
      if (change === "actor") state.portalSession.user.employeeNumber = "SYNTHETIC-OTHER";
      syncBranchAccountPasskeyLink();
    }, change);
    assert.equal(await link.evaluate(node => node.hidden), true, change); assert.equal(await link.getAttribute("href"), null, change);
  }
  await page.evaluate(() => {
    state.portalSession.user.employeeNumber = "SYNTHETIC-MANAGER";
    window.api = () => new Promise(resolve => { window.finishTargets = resolve; });
    window.targetsPending = loadBranchAccountPasswordTargets();
  });
  assert.equal(await link.getAttribute("href"), null);
  await page.evaluate(async () => {
    state.portalSession.user.scopes = [{ locationId: "SYN-CHANGED-DURING-LOAD" }];
    finishTargets({ accounts: [{ id: "11111111-2222-4333-8444-555555555555" }] }); await targetsPending;
  });
  assert.equal(await link.getAttribute("href"), null); assert.equal(await page.evaluate(() => state.branchAccountPasswordTargets.length), 0);
});

async function fixture(t, { accountId = null, organizationSession = false, available = true, supported = true, enrollmentAllowed = true, viewport = { width: 1280, height: 950 } } = {}) {
  const context = await browser.newContext({ viewport }); t.after(() => context.close());
  await context.addCookies([{ name: "grabenplaner_csrf", value: "a".repeat(64), domain: "login.example.invalid", path: "/", secure: true, sameSite: "Strict" }]);
  if (!supported) await context.addInitScript(() => { Object.defineProperty(window, "PublicKeyCredential", { value: undefined }); });
  const page = await context.newPage(), errors = [], consoleErrors = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  const first = { id: crypto.randomUUID(), label: '<img src=x onerror="window.injected=true">', revision: 1,
    createdAt: "2026-10-25T12:00:00.000Z", lastUsedAt: null, deviceType: "multiDevice", backedUp: true };
  const state = { accountId, available, calls: [], credentials: [first], authenticated: true, organizationSession, errorOnVerify: null,
    credentialError: null, delayCredentials: null, csrf: "a".repeat(64), label: null, response: null };
  const body = (route, status, payload, rotate = false) => {
    if (rotate) state.csrf = state.csrf[0] === "a" ? "b".repeat(64) : "c".repeat(64);
    return route.fulfill({ status, contentType: "application/json", headers: rotate ? {
      "X-GP-Session-Changed": "1", "Set-Cookie": `grabenplaner_csrf=${state.csrf}; Path=/; Secure; SameSite=Strict`,
    } : {}, body: JSON.stringify(payload) });
  };
  await context.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname.startsWith("/api/")) {
      const data = route.request().postDataJSON();
      state.calls.push({ pathname: url.pathname, search: url.search, method, data, csrf: route.request().headers()["x-csrf-token"] });
      if (url.pathname === `${BASE}/status`) return body(route, 200, { available: state.available, origin: ORIGIN });
      if (url.pathname === "/api/portal/v1/session") return body(route, 200, { authenticated: state.authenticated, user: { employeeNumber: "SYNTHETIC-101", role: "admin",
        sessionKind: state.organizationSession ? "organization" : "employee", isEmployee: !state.organizationSession } });
      if (url.pathname === `${BASE}/credentials`) {
        const snapshot = structuredClone(state.credentials);
        if (state.delayCredentials) { const delay = state.delayCredentials; state.delayCredentials = null; await delay; }
        if (state.credentialError) return body(route, state.credentialError, { error: "Die Zuständigkeit ist nicht mehr freigegeben." });
        return body(route, 200, { available: state.available, credentials: snapshot,
          target: { kind: accountId ? "organization" : "employee", displayName: accountId ? "Filiale Beispiel" : "Alex Beispiel", enrollmentAllowed } });
      }
      assert.equal(route.request().headers()["x-csrf-token"], state.csrf, "management mutation must use the current rotated CSRF cookie");
      if (url.pathname === `${BASE}/register/options`) {
        assert.equal(data.currentPassword, "SYNTHETIC-password-ONLY"); state.label = data.label;
        const { generateRegistrationOptions } = await import("@simplewebauthn/server");
        return body(route, 200, { challengeId: crypto.randomUUID(), options: await generateRegistrationOptions({ rpName: "GP Beispieldaten", rpID: "login.example.invalid",
          userID: crypto.randomBytes(32), userName: "SYNTHETIC", attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" } }) });
      }
      if (url.pathname === `${BASE}/register/verify`) {
        state.response = data.response;
        if (state.errorOnVerify) { state.authenticated = false; return body(route, state.errorOnVerify, { error: "Die Sitzung ist abgelaufen." }, true); }
        state.credentials.push({ ...first, id: crypto.randomUUID(), label: state.label });
        return body(route, 200, { ok: true, sessionChanged: true }, true);
      }
      if (/\/credentials\/[a-f0-9-]+\/revoke$/.test(url.pathname)) {
        assert.equal(data.currentPassword, "SYNTHETIC-password-ONLY");
        const id = url.pathname.split("/").at(-2); state.credentials = state.credentials.filter(item => item.id !== id);
        return body(route, 200, { ok: true, sessionChanged: true }, true);
      }
      throw new Error(`Unexpected API request: ${method} ${url.pathname}`);
    }
    const files = { "/passkeys.html": ["public/passkeys.html", "text/html"], "/passkeys.js": ["public/passkeys.js", "text/javascript"],
      "/passkeys.css": ["public/passkeys.css", "text/css"], "/session-lifecycle.js": ["public/session-lifecycle.js", "text/javascript"],
      "/vendor/simplewebauthn-browser-v14/index.umd.min.js": ["node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js", "text/javascript"],
      "/assets/grabenplaner-logo.svg": ["public/assets/grabenplaner-logo.svg", "image/svg+xml"], "/assets/webicon.svg": ["public/assets/webicon.svg", "image/svg+xml"] };
    const file = files[url.pathname];
    if (!file) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ contentType: file[1], body: fs.readFileSync(path.join(root, file[0])) });
  });
  const cdp = await context.newCDPSession(page); await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(`${ORIGIN}/passkeys.html${accountId === null ? "" : `?accountId=${encodeURIComponent(accountId)}`}`);
  return { page, context, cdp, authenticatorId, state, errors, consoleErrors };
}
async function ready(page) { await page.locator("#passkeysCredentialsSection").waitFor({ state: "visible" }); }
async function register(page, name = "Mein Beispielgerät") {
  await page.getByLabel("Name des Passkeys", { exact: true }).fill(name);
  await page.locator("#passkeysRegisterPassword").fill("SYNTHETIC-password-ONLY");
  await page.getByRole("button", { name: "Passkey hinzufügen", exact: true }).click();
}

test("Passkey management uses real browser registration, safe text, rotated CSRF and an explicit revoke confirmation", { skip: !enabled }, async t => {
  const f = await fixture(t); await ready(f.page);
  if (process.env.GP_PASSKEYS_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.GP_PASSKEYS_SCREENSHOT_DIR, { recursive: true });
    await f.page.screenshot({ path: path.join(process.env.GP_PASSKEYS_SCREENSHOT_DIR, "passkeys-management-desktop.png"), fullPage: true });
  }
  assert.equal(await f.page.locator("#passkeysCredentials img").count(), 0);
  assert.equal(await f.page.evaluate(() => window.injected), undefined);
  assert.match(await f.page.locator("#passkeysCredentials").innerText(), /<img src=x/);
  await register(f.page);
  await f.page.getByText("Der Passkey wurde hinzugefügt.", { exact: true }).waitFor();
  assert.equal(f.state.response.type, "public-key"); assert(f.state.response.response.attestationObject);
  assert.equal(await f.page.locator("#passkeysRegisterPassword").inputValue(), "");
  assert.equal(await f.page.locator("#passkeysLabel").inputValue(), "");
  await f.page.getByRole("button", { name: "Passkey „Mein Beispielgerät“ widerrufen", exact: true }).click();
  assert.equal(f.state.calls.filter(call => call.pathname.endsWith("/revoke")).length, 0, "opening the confirmation must not revoke");
  const confirmation = await f.page.locator("#passkeysRevokeDialog").innerText();
  assert.match(confirmation, /Dieser Passkey kann danach nicht mehr zur Anmeldung verwendet werden/);
  assert.match(confirmation, /Bereits angemeldete Sitzungen bleiben bestehen/);
  assert.match(confirmation, /Bei Verlust oder Fremdnutzung eines Geräts bitte die zuständige Administration kontaktieren/);
  assert.match(confirmation, /bestehende Sitzungen zu beenden oder das Kennwort zurückzusetzen/);
  await f.page.getByRole("button", { name: "Abbrechen", exact: true }).click();
  assert.equal(f.state.credentials.length, 2);
  await f.page.getByRole("button", { name: "Passkey „Mein Beispielgerät“ widerrufen", exact: true }).click();
  await f.page.locator("#passkeysRevokePassword").fill("SYNTHETIC-password-ONLY");
  await f.page.getByRole("button", { name: "Passkey widerrufen", exact: true }).click();
  await f.page.getByText("Der Passkey wurde widerrufen.", { exact: true }).waitFor();
  assert.equal(f.state.credentials.length, 1);
  const mutations = f.state.calls.filter(call => call.method === "POST");
  assert.deepEqual(mutations.map(call => call.csrf), ["a".repeat(64), "a".repeat(64), "b".repeat(64)]);
  assert.equal(await f.page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes("SYNTHETIC-password-ONLY")), false);
  assert.deepEqual(f.errors, []); assert.deepEqual(f.consoleErrors, []);
});

test("Managed organization target stays fixed in requests and uses the personal actor password on a narrow mobile page", { skip: !enabled }, async t => {
  const accountId = crypto.randomUUID(), f = await fixture(t, { accountId, viewport: { width: 390, height: 850 } }); await ready(f.page);
  if (process.env.GP_PASSKEYS_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.GP_PASSKEYS_SCREENSHOT_DIR, { recursive: true });
    await f.page.screenshot({ path: path.join(process.env.GP_PASSKEYS_SCREENSHOT_DIR, "passkeys-management-mobile.png"), fullPage: true });
  }
  assert.match(await f.page.locator("#passkeysTarget").innerText(), /Filiale Beispiel/);
  assert.equal(await f.page.locator("#passkeysOrganizationNote").isVisible(), true);
  assert.match(await f.page.locator("#passkeysRegisterForm").innerText(), /Dein persönliches Passwort/);
  await register(f.page, "Firmenschlüssel Beispiel"); await f.page.getByText("Der Passkey wurde hinzugefügt.", { exact: true }).waitFor();
  for (const call of f.state.calls.filter(call => call.method === "POST")) assert.equal(call.data.accountId, accountId);
  assert(f.state.calls.filter(call => call.pathname === `${BASE}/credentials`).every(call => new URLSearchParams(call.search).get("accountId") === accountId));
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(f.errors, []);
});

test("Unavailable setup, invalid target and a shared organization session never expose registration controls", { skip: !enabled }, async t => {
  const unavailable = await fixture(t, { available: false });
  await unavailable.page.getByText(/Passkeys sind unter dieser GP-Adresse derzeit nicht verfügbar/).waitFor();
  assert.equal(await unavailable.page.locator("#passkeysRegistrationSection").isVisible(), false);
  const invalid = await fixture(t, { accountId: "not-a-target" });
  await invalid.page.getByText(/Der Link enthält keine gültige Kontozuordnung/).waitFor(); assert.equal(invalid.state.calls.length, 0);
  const organization = await fixture(t, { organizationSession: true });
  await organization.page.getByText(/Passkeys für Filial- und Terminalkonten werden/).waitFor();
  assert.equal(organization.state.calls.some(call => call.pathname === `${BASE}/credentials`), false);
  assert.equal(await organization.page.locator("#passkeysRegistrationSection").isVisible(), false);
});

test("A browser without WebAuthn retains credential viewing and password-authorized revocation without attempting registration", { skip: !enabled }, async t => {
  const f = await fixture(t, { supported: false }); await ready(f.page);
  await f.page.getByText(/Dieser Browser kann keinen Passkey einrichten/).waitFor();
  assert.equal(await f.page.getByRole("button", { name: "Passkey hinzufügen", exact: true }).isEnabled(), false);
  await f.page.getByRole("button", { name: /Passkey .* widerrufen/ }).click();
  await f.page.locator("#passkeysRevokePassword").fill("SYNTHETIC-password-ONLY");
  await f.page.getByRole("button", { name: "Passkey widerrufen", exact: true }).click();
  await f.page.getByText("Der Passkey wurde widerrufen.", { exact: true }).waitFor();
  assert.equal(f.state.credentials.length, 0); assert.equal(f.state.calls.some(call => call.pathname.includes("/register/")), false);
});

test("Inactive or locked organization targets remain reachable for revocation while new enrollment is disabled", { skip: !enabled }, async t => {
  const accountId = crypto.randomUUID(), f = await fixture(t, { accountId, enrollmentAllowed: false }); await ready(f.page);
  await f.page.getByText(/Für diesen Zugang kann derzeit kein weiterer Passkey eingerichtet werden/).waitFor();
  assert.equal(await f.page.getByRole("button", { name: "Passkey hinzufügen", exact: true }).isEnabled(), false);
  await f.page.getByRole("button", { name: /Passkey .* widerrufen/ }).click();
  await f.page.locator("#passkeysRevokePassword").fill("SYNTHETIC-password-ONLY");
  await f.page.getByRole("button", { name: "Passkey widerrufen", exact: true }).click();
  await f.page.getByText("Der Passkey wurde widerrufen.", { exact: true }).waitFor();
  assert.equal(f.state.credentials.length, 0);
  assert.equal(f.state.calls.some(call => call.pathname.includes("/register/")), false);
  const appSource = fs.readFileSync(path.join(root, "public/app.js"), "utf8"), start = appSource.indexOf("function renderOrganizationAccounts()"), end = appSource.indexOf("\n}", start);
  await f.page.evaluate(id => {
    window.state = { locations: [], organizationAccounts: [{ id, loginName: "example", displayName: "Beispielkonto", active: false, locked: true }] };
    window.elements = { organizationAccountList: document.createElement("div") };
    window.escapeHtml = window.escapeHtmlAttribute = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }, accountId);
  await f.page.addScriptTag({ content: appSource.slice(start, end + 2) });
  const target = await f.page.evaluate(() => { renderOrganizationAccounts(); return elements.organizationAccountList.querySelector('a[href*="passkeys.html"]').getAttribute("href"); });
  assert.equal(target, `/passkeys.html?accountId=${accountId}`);
  assert.deepEqual(f.errors, []);
});

test("Cancelled WebAuthn does not invoke registration verification or silently start a password login", { skip: !enabled }, async t => {
  const f = await fixture(t); await ready(f.page);
  await f.cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId: f.authenticatorId, enabled: false });
  await register(f.page);
  await f.page.waitForFunction(() => document.querySelector("#passkeysRegisterForm").getAttribute("aria-busy") === "true");
  await f.page.waitForFunction(() => navigator.locks.query().then(value => value.held.some(lock => lock.name === "grabenplaner-credentials-v1")));
  await f.page.waitForFunction(() => Boolean(SimpleWebAuthnBrowser.WebAuthnAbortService.controller));
  await f.page.evaluate(() => SimpleWebAuthnBrowser.WebAuthnAbortService.cancelCeremony());
  await f.page.getByText(/Die Passkey-Einrichtung wurde abgebrochen/).waitFor();
  assert.equal(f.state.calls.some(call => call.pathname === `${BASE}/register/verify` || call.pathname.endsWith("/auth/login")), false);
  assert.equal(await f.page.locator("#passkeysRegisterPassword").inputValue(), "");
  assert.deepEqual(f.errors, []);
});

test("Session expiry after a credential transition clears old credentials and secrets instead of retaining management rights", { skip: !enabled }, async t => {
  const f = await fixture(t); await ready(f.page); f.state.errorOnVerify = 401;
  await register(f.page);
  await f.page.getByText("Bitte zuerst mit deinem persönlichen GP-Zugang anmelden.", { exact: true }).waitFor();
  assert.equal(await f.page.locator("#passkeysCredentials li").count(), 0);
  assert.equal(await f.page.locator("#passkeysRegistrationSection").isVisible(), false);
  assert.equal(await f.page.locator("#passkeysRegisterPassword").inputValue(), "");
  assert.equal(await f.page.locator("#passkeysLoginLink").isVisible(), true);
  assert.doesNotMatch(await f.page.locator("#passkeysTarget").innerText(), /Alex Beispiel/);
  assert.equal(f.state.calls.filter(call => call.pathname === `${BASE}/register/verify`).length, 1, "no automatic mutation retry");
  assert.deepEqual(f.errors, []);
});

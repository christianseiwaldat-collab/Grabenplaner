"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto");
const root = path.resolve(__dirname, ".."), enabled = process.env.GP_WINDOW_BROWSER_TEST === "1", ORIGIN = "https://login.example.invalid";
const source = name => fs.readFileSync(path.join(root, name), "utf8");
function functionSource(name, file) {
  const text = source(`public/${file}`), start = text.search(new RegExp(`^(?:async )?function ${name}\\(`, "m")), end = text.indexOf("\n}", start);
  assert(start >= 0 && end > start, name); return text.slice(start, end + 2);
}
let browser;
test.before(async () => {
  if (!enabled) return;
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, chromiumSandbox: process.platform === "linux", ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
});
test.after(async () => { await browser?.close(); });
const operations = ["database-download", "offsite-folder-create", "offsite-folder-activate", "vps-reboot", "password-change"];

test("every new credential-changing endpoint requires the existing cross-tab credential lock", async () => {
  const context = vm.createContext({ URL, AbortController, AbortSignal, location: { href: `${ORIGIN}/` }, document: { cookie: "grabenplaner_csrf=synthetic" },
    navigator: { locks: { request: async (_name, _options, work) => work() } } });
  vm.runInContext(source("public/session-lifecycle.js"), context);
  const lifecycle = context.GrabenplanerSessionLifecycle;
  const paths = ["/api/portal/v1/auth/passkeys/verify", "/api/portal/v1/passkeys/register/verify", `/api/portal/v1/passkeys/credentials/${crypto.randomUUID()}/revoke`];
  for (const url of paths) {
    assert.throws(() => lifecycle.credentialOptions(url, { method: "POST" }), { code: "PORTAL_CREDENTIAL_COORDINATION_UNAVAILABLE" });
    await lifecycle.credentials(async () => assert(lifecycle.credentialOptions(url, { method: "POST" }).signal));
  }
  assert.equal(lifecycle.credentialOptions("/api/portal/v1/auth/passkeys/options", { method: "POST" }).signal, undefined);
});

async function fixture(t, { portal = false, available = true, coordination = "web-locks", actualApi = false,
  loginFailure = null, rotationHeader = false, rotateCookie = false, passwordResponse = null, replacementActor = "SYNTHETIC-101" } = {}) {
  const context = await browser.newContext(); t.after(() => context.close());
  if (coordination === "indexeddb") await context.addInitScript(() => { Object.defineProperty(navigator, "locks", { value: undefined }); });
  await context.addCookies([{ name: "grabenplaner_csrf", value: "synthetic-old", domain: "login.example.invalid", path: "/", secure: true, sameSite: "Strict" }]);
  const page = await context.newPage(), errors = [], state = { calls: [] };
  page.on("pageerror", error => errors.push(error.message));
  await context.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname.startsWith("/api/")) {
      const body = route.request().postDataJSON(); state.calls.push({ path: url.pathname, method, body });
      let response;
      if (url.pathname === "/api/portal/v1/me/password" && passwordResponse) {
        return route.fulfill({ status: passwordResponse === "original-error" || passwordResponse === "no-rotation-error" ? 503 : 200,
          contentType: "application/json", headers: {
            ...(rotationHeader ? { "X-GP-Session-Changed": "1" } : {}),
            ...(rotateCookie ? { "Set-Cookie": "grabenplaner_csrf=synthetic-new; Path=/; Secure; SameSite=Strict" } : {}),
          }, body: passwordResponse === "body-lost" ? "{ deliberately truncated password-change JSON"
            : JSON.stringify(passwordResponse.endsWith("error") ? { error: "Synthetic original password-change failure", code: "SYNTHETIC_ORIGINAL" }
              : { ok: true, sessionChanged: true }) });
      }
      if (url.pathname === "/api/portal/v1/session" && passwordResponse && replacementActor === "UNAVAILABLE") return route.fulfill({ status: 503,
        contentType: "application/json", body: JSON.stringify({ error: "Synthetic projection unavailable", code: "SYNTHETIC_PROJECTION" }) });
      if (url.pathname === "/api/portal/v1/session" && passwordResponse) response = { authenticated: true,
        user: { employeeNumber: replacementActor, isEmployee: true, sessionKind: "employee", role: "employee", mustChangePassword: false }, replacement: true };
      else if (url.pathname === "/api/portal/v1/passkeys/status") response = { available, origin: ORIGIN };
      else if (url.pathname.endsWith("/options")) {
        if (loginFailure === "before-rotation") return route.fulfill({ status: 503, contentType: "application/json",
          body: JSON.stringify({ error: "Synthetic pre-rotation failure", code: "SYNTHETIC_PRE_ROTATION" }) });
        const { generateAuthenticationOptions } = await import("@simplewebauthn/server");
        response = { challengeId: crypto.randomUUID(), options: await generateAuthenticationOptions({ rpID: "login.example.invalid", userVerification: "required" }) };
      } else if (url.pathname.endsWith("/verify") || url.pathname === "/api/portal/v1/auth/login") {
        if (loginFailure === "verify-body") return route.fulfill({ contentType: "application/json", headers: {
          ...(rotationHeader ? { "X-GP-Session-Changed": "1" } : {}),
          ...(rotateCookie ? { "Set-Cookie": "grabenplaner_csrf=synthetic-new; Path=/; Secure; SameSite=Strict" } : {}),
        }, body: "{ deliberately truncated JSON" });
        response = { authenticated: true, user: { employeeNumber: portal ? null : "SYNTHETIC-101", accountId: portal ? "SYNTHETIC-ORG" : undefined,
          isEmployee: !portal, sessionKind: portal ? "organization" : "employee", role: portal ? "organization_account" : "admin", mustChangePassword: false } };
      } else if (url.pathname === "/api/backup/database-download") response = { ok: true };
      else throw new Error(`Unexpected API path ${url.pathname}`);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(response) });
    }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="de"><title>GP Passkey Auth Beispieldaten</title><form id="login"><input id="identity" value="EX-USER" required><input id="password" type="password" value="SYNTHETIC-ONLY-PASSWORD" required><button type="submit">Mit Passwort anmelden</button><button type="button" data-gp-passkey-login hidden>Mit Passkey anmelden</button></form><div id="result"></div>${operations.map((operation, index) => `<label><input id="pw${index}" type="password" required>Aktuelles Passwort ${index}</label><label data-gp-passkey-choice hidden><input type="checkbox" data-gp-passkey-operation="${operation}" data-gp-passkey-password="pw${index}">Passkey ${operation}</label>`).join("")}</html>` });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: source("public/session-lifecycle.js") });
  await page.addScriptTag({ path: path.join(root, "node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js") });
  const cdp = await context.newCDPSession(page); await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const { generateRegistrationOptions } = await import("@simplewebauthn/server");
  const options = await generateRegistrationOptions({ rpID: "login.example.invalid", rpName: "GP Test", userID: crypto.randomBytes(32), userName: "SYNTHETIC-ONLY",
    supportedAlgorithmIDs: [-7, -257], attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" } });
  await page.evaluate(optionsJSON => SimpleWebAuthnBrowser.startRegistration({ optionsJSON }), options);
  await page.addScriptTag({ path: path.join(root, "public/passkey-auth.js") }); await page.evaluate(() => GPPasskeyAuth.readiness);
  await page.evaluate(portal => {
    window.events = []; window.loginErrors = []; window.portalState = { session: null }; window.state = { portalSession: null };
    window.elements = { adminLoginPersonnelNumber: document.getElementById("identity"), adminLoginPassword: document.getElementById("password") };
    window.el = { loginPersonnelNumber: elements.adminLoginPersonnelNumber, loginPassword: elements.adminLoginPassword };
    window.api = async (url, input = {}) => {
      input = GrabenplanerSessionLifecycle.credentialOptions(url, input);
      const response = await fetch(url, { credentials: "same-origin", ...input, headers: { "Content-Type": "application/json" } });
      GrabenplanerSessionLifecycle.observeCredentialResponse(response); return response.json();
    };
    window.csrf = () => document.cookie.split(";").map(value => value.trim()).find(value => value.startsWith("grabenplaner_csrf="))?.split("=").slice(1).join("=");
    window.redirectAdministrationToCandidateEvaluation = window.redirectToPendingCandidateEvaluation = async () => false;
    window.showPortal = result => { portalState.session = result; document.getElementById("result").textContent = result.user.sessionKind; events.push("showPortal"); };
    window.hideLoginGate = () => { document.getElementById("result").textContent = "employee"; events.push("hideLoginGate"); };
    window.showLoginGate = text => { document.getElementById("result").textContent = text; };
    window.message = (_element, text) => { document.getElementById("result").textContent = text; };
    for (const name of ["applyShellBranding", "applyRoleVisibility", "loadUiPreferences", "loadAll", "loadManagementBrandingPreference", "loadSystemInfo", "loadMobileLayout", "chooseInitialPortalTab", "loadPortalData", "refreshBirthdayPresentationTheme", "claimBirthdayPresentation"]) window[name] = async () => { events.push(name); };
    window.grabenplanerNavigation = { start() { events.push("navigation"); } };
    window.isPortalTest = portal;
  }, portal);
  if (actualApi) await page.addScriptTag({ content: functionSource("api", portal ? "portal.js" : "app.js") });
  await page.addScriptTag({ content: portal
    ? functionSource("completePortalLogin", "portal.js") + "\n" + functionSource("login", "portal.js")
    : functionSource("completeAdministrationLogin", "app.js") + "\n" + functionSource("loginToAdministration", "app.js") });
  await page.evaluate(() => {
    const complete = isPortalTest ? completePortalLogin : completeAdministrationLogin;
    GPPasskeyAuth.bindLogin(document.querySelector("[data-gp-passkey-login]"), { api, complete, error: error => {
      loginErrors.push({ code: error.code, message: error.message }); document.getElementById("result").textContent = error.message;
    } });
    document.getElementById("login").addEventListener("submit", isPortalTest ? login : loginToAdministration);
  });
  return { page, context, state, cdp, authenticatorId, errors };
}

async function observeOtherTab(f) {
  const other = await f.context.newPage(); await other.goto(`${ORIGIN}/`);
  await other.addScriptTag({ content: source("public/session-lifecycle.js") });
  await other.evaluate(() => {
    window.refreshes = 0; window.broadcasts = [];
    GrabenplanerSessionLifecycle.listen(() => { refreshes++; document.getElementById("result").textContent = "INVALIDATED"; });
    window.observer = new BroadcastChannel("grabenplaner-session-lifecycle-v1"); observer.onmessage = event => broadcasts.push(event.data);
  });
  await f.page.evaluate(() => {
    const NativeChannel = BroadcastChannel; window.publishLockStates = [];
    window.BroadcastChannel = class extends NativeChannel {
      postMessage(value) {
        let held = false;
        try { held = Boolean(GrabenplanerSessionLifecycle.credentialOptions("/api/portal/v1/auth/passkeys/verify", { method: "POST" }).signal); } catch {}
        publishLockStates.push(held); return super.postMessage(value);
      }
    };
  });
  await f.page.bringToFront(); return other;
}

async function passwordFixture(t, options) {
  const f = await fixture(t, { ...options, portal: true, available: false, actualApi: true });
  await f.page.evaluate(newerActorRace => {
    const old = { authenticated: true, user: { employeeNumber: "SYNTHETIC-101", sessionKind: "employee", isEmployee: true, role: "employee" } };
    portalState.session = old; window.originalPasswordSession = old; window.apiErrors = []; window.operationErrors = []; window.credentialErrors = [];
    for (const name of ["newPassword", "repeatPassword"]) {
      const input = document.createElement("input"); input.value = "SYNTHETIC-NEW-PASSWORD"; document.body.append(input); el[name] = input;
    }
    el.currentPassword = document.getElementById("pw4"); el.currentPassword.value = "SYNTHETIC-OLD-PASSWORD";
    el.passwordMessage = document.getElementById("result");
    window.closePasswordChangeDialog = () => events.push("closePassword");
    window.showPortal = replacement => { portalState.session = replacement; GrabenplanerSessionLifecycle.advance(); events.push("adoptPassword"); };
    window.showLogin = () => { portalState.session = null; GrabenplanerSessionLifecycle.advance(); events.push("invalidatePassword"); };
    const nativeApi = api; window.api = async (...args) => {
      try {
        const result = await nativeApi(...args);
        if (newerActorRace && args[0] === "/api/portal/v1/session") {
          portalState.session = { authenticated: true, user: { employeeNumber: "SYNTHETIC-NEWER-ACTOR", sessionKind: "employee", isEmployee: true } };
          GrabenplanerSessionLifecycle.advance();
        }
        return result;
      } catch (error) { apiErrors.push(error); throw error; }
    };
    const nativeLifecycle = GrabenplanerSessionLifecycle, observedLifecycle = Object.create(nativeLifecycle);
    Object.defineProperty(observedLifecycle, "credentials", { value: async (...args) => {
      const [operation, ...rest] = args;
      try { return await nativeLifecycle.credentials(async () => {
        try { return await operation(); } catch (error) { operationErrors.push(error); throw error; }
      }, ...rest); } catch (error) { credentialErrors.push(error); throw error; }
    } });
    window.GrabenplanerSessionLifecycle = observedLifecycle;
  }, options.newerActorRace === true);
  await f.page.addScriptTag({ content: "let passwordChangeRequest = null;\n" + functionSource("changePassword", "portal.js") });
  return f;
}

test("personal password changes settle committed response failures under both tab locks, keep the original error and publish once", { skip: !enabled }, async t => {
  const cases = [
    { passwordResponse: "body-lost", rotationHeader: true, rotateCookie: false },
    { passwordResponse: "body-lost", rotationHeader: false, rotateCookie: true },
    { passwordResponse: "original-error", rotationHeader: true, rotateCookie: true },
    { passwordResponse: "original-error", rotationHeader: true, rotateCookie: true, replacementActor: "UNAVAILABLE" },
    { passwordResponse: "success", rotationHeader: true, rotateCookie: true },
    { passwordResponse: "success", rotationHeader: true, rotateCookie: true, replacementActor: "SYNTHETIC-OTHER" },
    { passwordResponse: "success", rotationHeader: true, rotateCookie: true, newerActorRace: true },
  ];
  for (const coordination of ["web-locks", "indexeddb"]) for (const scenario of cases) {
    const f = await passwordFixture(t, { coordination, ...scenario }), other = await observeOtherTab(f);
    await f.page.evaluate(() => changePassword({ preventDefault() {} }));
    await other.waitForFunction(() => refreshes === 1 && broadcasts.length === 1); await other.waitForTimeout(50);
    assert.deepEqual(await other.evaluate(() => broadcasts), [{ type: "session-changed" }]);
    assert.deepEqual(await f.page.evaluate(() => publishLockStates), [true]);
    assert.equal(f.state.calls.filter(call => call.path === "/api/portal/v1/me/password").length, 1);
    assert.equal(f.state.calls.filter(call => call.path === "/api/portal/v1/session").length, 1);
    const observed = await f.page.evaluate(() => ({ actor: portalState.session?.user?.employeeNumber || null,
      adopted: events.includes("adoptPassword"), invalidated: events.includes("invalidatePassword"),
      originalError: operationErrors.length ? operationErrors[0] === apiErrors[0] : null,
      outerOriginalError: credentialErrors.length ? credentialErrors[0] === apiErrors[0] : null,
      errorCode: credentialErrors[0]?.code, originalSessionRetained: portalState.session === originalPasswordSession }));
    const invalid = scenario.replacementActor === "UNAVAILABLE" || scenario.replacementActor === "SYNTHETIC-OTHER";
    assert.equal(observed.actor, scenario.newerActorRace ? "SYNTHETIC-NEWER-ACTOR" : invalid ? null : "SYNTHETIC-101");
    assert.equal(observed.adopted, !invalid && !scenario.newerActorRace); assert.equal(observed.invalidated, invalid);
    assert.equal(observed.originalSessionRetained, false);
    if (scenario.passwordResponse !== "success") assert.equal(observed.originalError, true);
    if (scenario.passwordResponse === "original-error") { assert.equal(observed.errorCode, "SYNTHETIC_ORIGINAL"); assert.equal(observed.outerOriginalError, true); }
    assert.deepEqual(f.errors, []); await f.context.close();
  }
});

test("a rejected password change before rotation neither adopts nor broadcasts or retries", { skip: !enabled }, async t => {
  for (const coordination of ["web-locks", "indexeddb"]) {
    const f = await passwordFixture(t, { coordination, passwordResponse: "no-rotation-error" }), other = await observeOtherTab(f);
    await f.page.evaluate(() => changePassword({ preventDefault() {} })); await other.waitForTimeout(80);
    assert.deepEqual(await other.evaluate(() => broadcasts), []); assert.equal(await other.evaluate(() => refreshes), 0);
    assert.deepEqual(await f.page.evaluate(() => ({ retained: portalState.session === originalPasswordSession,
      originalError: credentialErrors[0] === apiErrors[0], code: credentialErrors[0]?.code })),
    { retained: true, originalError: true, code: "SYNTHETIC_ORIGINAL" });
    assert.equal(f.state.calls.filter(call => call.path === "/api/portal/v1/me/password").length, 1);
    assert.equal(f.state.calls.some(call => call.path === "/api/portal/v1/session"), false); assert.deepEqual(f.errors, []); await f.context.close();
  }
});

test("committed login with a failed JSON body invalidates other tabs exactly once before unlocking, for both coordinators and both product APIs", { skip: !enabled }, async t => {
  for (const coordination of ["web-locks", "indexeddb"]) for (const portal of [false, true]) {
    for (const [rotationHeader, rotateCookie] of [[true, false], [false, true], [true, true]]) {
      const f = await fixture(t, { portal, coordination, actualApi: true, loginFailure: "verify-body", rotationHeader, rotateCookie });
      const other = await observeOtherTab(f);
      await f.page.getByRole("button", { name: "Mit Passkey anmelden", exact: true }).click();
      await f.page.waitForFunction(() => loginErrors.length === 1);
      await other.waitForFunction(() => refreshes === 1 && broadcasts.length === 1);
      await other.waitForTimeout(80);
      assert.deepEqual(await other.evaluate(() => broadcasts), [{ type: "session-changed" }]);
      assert.deepEqual(await f.page.evaluate(() => publishLockStates), [true]);
      assert.equal(await other.evaluate(() => refreshes), 1);
      assert.equal(await f.page.evaluate(() => GrabenplanerSessionLifecycle.credentialChanged), rotationHeader);
      assert.equal((await other.evaluate(() => document.cookie)).includes("synthetic-new"), rotateCookie);
      assert.equal(f.state.calls.filter(call => call.path.endsWith("/passkeys/verify")).length, 1);
      assert.equal(f.state.calls.some(call => call.path === "/api/portal/v1/auth/login"), false);
      assert.equal(await f.page.evaluate(() => events.includes("showPortal") || events.includes("hideLoginGate")), false);
      assert.deepEqual(f.errors, []);
    }
  }
});

test("login errors before a credential transition do not invalidate tabs or retry authentication", { skip: !enabled }, async t => {
  for (const coordination of ["web-locks", "indexeddb"]) for (const portal of [false, true]) {
    const f = await fixture(t, { portal, coordination, actualApi: true, loginFailure: "before-rotation" }), other = await observeOtherTab(f);
    await f.page.getByRole("button", { name: "Mit Passkey anmelden", exact: true }).click();
    await f.page.waitForFunction(() => loginErrors.length === 1); await other.waitForTimeout(100);
    assert.equal(await other.evaluate(() => refreshes), 0); assert.deepEqual(await other.evaluate(() => broadcasts), []);
    assert.equal((await other.evaluate(() => document.cookie)).includes("synthetic-old"), true);
    assert.equal(f.state.calls.filter(call => call.path.endsWith("/auth/passkeys/options")).length, 1);
    assert.equal(f.state.calls.some(call => call.path.endsWith("/verify") || call.path === "/api/portal/v1/auth/login"), false);
  }
});

for (const portal of [false, true]) test(`Passkey and explicit password login reuse the actual ${portal ? "portal/organization" : "administration"} completion callback`, { skip: !enabled }, async t => {
  const f = await fixture(t, { portal });
  await f.page.getByRole("button", { name: "Mit Passkey anmelden", exact: true }).click();
  await f.page.getByText(portal ? "organization" : "employee", { exact: true }).waitFor();
  const calls = f.state.calls.filter(call => call.path.includes("/auth/"));
  assert.deepEqual(calls.map(call => call.path), ["/api/portal/v1/auth/passkeys/options", "/api/portal/v1/auth/passkeys/verify"]);
  assert.deepEqual(calls[0].body, {}); assert.equal(calls[1].body.response.type, "public-key");
  assert(calls[1].body.response.response.signature); assert.equal(calls[1].body.password, undefined);
  assert.equal(await f.page.locator("#password").inputValue(), "");
  await f.page.locator("#password").fill("SYNTHETIC-ONLY-PASSWORD");
  await f.page.getByRole("button", { name: "Mit Passwort anmelden", exact: true }).click();
  await f.page.waitForFunction(() => document.getElementById("password").value === "");
  assert.equal(f.state.calls.filter(call => call.path === "/api/portal/v1/auth/login").length, 1);
  assert.deepEqual(f.errors, []);
});

test("actual administration and portal CSS preserve passkey availability and hide only the selected password alternative", { skip: !enabled }, async t => {
  for (const portal of [false, true]) for (const available of [false, true]) {
    const f = await fixture(t, { portal, available });
    await f.page.evaluate(() => {
      document.querySelector("[data-gp-passkey-login]").className = "secondary-button";
      for (const choice of document.querySelectorAll("[data-gp-passkey-choice]")) choice.className = "checkbox-line";
      for (const field of document.querySelectorAll("[data-gp-passkey-password-field]")) field.className = "field";
      const branchLink = document.createElement("a"); branchLink.id = "branchAccountPasskeysLink";
      branchLink.hidden = true; branchLink.className = "secondary-button"; branchLink.textContent = "Passkeys verwalten"; document.body.append(branchLink);
    });
    await f.page.addStyleTag({ path: path.join(root, "public", portal ? "portal.css" : "styles.css") });
    await f.page.addStyleTag({ path: path.join(root, "public/passkey-auth.css") });
    assert.equal(await f.page.locator("[data-gp-passkey-login]").isVisible(), available);
    assert.equal(await f.page.locator("[data-gp-passkey-choice]").first().isVisible(), available);
    assert.equal(await f.page.locator("#branchAccountPasskeysLink").isVisible(), false);
    assert.equal(await f.page.locator("#pw0").isVisible(), true);
    if (available) {
      const toggle = f.page.locator('[data-gp-passkey-operation="database-download"]');
      await toggle.check(); assert.equal(await f.page.locator("#pw0").isVisible(), false);
      assert.equal(await f.page.locator("#pw0").evaluate(input => input.required), false);
      assert.equal(await f.page.locator("#pw1").isVisible(), true);
      await toggle.uncheck(); assert.equal(await f.page.locator("#pw0").isVisible(), true);
      assert.equal(await f.page.locator("#pw0").evaluate(input => input.required), true);
    }
    const productHtml = source(portal ? "public/portal.html" : "public/index.html");
    assert.match(productHtml, /<link rel="stylesheet" href="\/passkey-auth\.css"/);
    assert.deepEqual(f.errors, []);
  }
});

test("operation-bound reauthentication sends a genuine assertion on the original protected request, never a second verify endpoint", { skip: !enabled }, async t => {
  const f = await fixture(t);
  for (const operation of operations) {
    const checkbox = f.page.locator(`[data-gp-passkey-operation="${operation}"]`); await checkbox.check();
    const result = await f.page.evaluate(async operation => GrabenplanerSessionLifecycle.credentials(async () => {
      const authentication = await GPPasskeyAuth.authorization(api, operation);
      await api("/api/backup/database-download", { method: "POST", body: JSON.stringify({ confirmation: "SYNTHETIC-ONLY", ...authentication }) });
      return { keys: Object.keys(authentication), type: authentication.passkey.response.type };
    }), operation);
    assert.deepEqual(result.keys, ["passkey"]); assert.equal(result.type, "public-key");
    const request = f.state.calls.at(-1); assert.equal(request.path, "/api/backup/database-download");
    assert.equal(request.body.currentPassword, undefined); assert(request.body.passkey.challengeId);
    assert.equal(f.state.calls.at(-2).body.operation, operation);
    assert.equal(await f.page.locator(`#${await checkbox.getAttribute("data-gp-passkey-password")}`).evaluate(input => input.required), false);
  }
  assert.equal(f.state.calls.some(call => call.path === "/api/portal/v1/passkeys/reauthenticate/verify"), false);
  assert.deepEqual(f.errors, []);
});

test("cancelling the browser prompt neither submits the protected action nor falls back to password login", { skip: !enabled }, async t => {
  for (const coordination of ["web-locks", "indexeddb"]) {
    const f = await fixture(t, { coordination, actualApi: true }), other = await observeOtherTab(f);
    await f.cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId: f.authenticatorId, enabled: false });
    await f.page.evaluate(() => { window.previousCeremonyController = SimpleWebAuthnBrowser.WebAuthnAbortService.controller; });
    await f.page.getByRole("button", { name: "Mit Passkey anmelden", exact: true }).click();
    await f.page.waitForFunction(() => SimpleWebAuthnBrowser.WebAuthnAbortService.controller
      && SimpleWebAuthnBrowser.WebAuthnAbortService.controller !== window.previousCeremonyController);
    await f.page.evaluate(() => SimpleWebAuthnBrowser.WebAuthnAbortService.cancelCeremony());
    await f.page.getByText(/Die Passkey-Bestätigung wurde abgebrochen/).waitFor(); await other.waitForTimeout(100);
    assert.equal(f.state.calls.some(call => call.path.endsWith("/verify") || call.path === "/api/portal/v1/auth/login"), false);
    assert.deepEqual(await f.page.evaluate(() => publishLockStates), []);
    assert.equal(await other.evaluate(() => refreshes), 0); assert.deepEqual(await other.evaluate(() => broadcasts), []);
    assert.equal((await other.evaluate(() => document.cookie)).includes("synthetic-old"), true);
    assert.deepEqual(f.errors, []);
  }
});

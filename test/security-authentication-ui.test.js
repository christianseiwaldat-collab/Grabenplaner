"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { functionSource } = require("../test-support/learning-workspace-ui");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, "public", file), "utf8");
const input = (html, id) => html.match(new RegExp('<input\\b[^>]*id="' + id + '"[^>]*>'))?.[0];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("GP password forms separate existing credentials from the codepoint policy, including optional USB/admin drafts", () => {
  const admin = read("index.html"), portal = read("portal.html");
  for (const [html, ids] of [[admin, ["organizationAccountPassword", "usbDraftPassword", "adminSetupPassword", "adminSetupPasswordRepeat", "branchAccountPasswordNew", "branchAccountPasswordRepeat"]],
    [portal, ["passwordResetNewPassword", "passwordResetRepeatPassword", "newPassword", "repeatPassword"]]]) {
    for (const id of ids) {
      assert.match(input(html, id), /data-gp-new-password/);
      assert.doesNotMatch(input(html, id), /\b(?:minlength|maxlength)=/);
    }
  }
  for (const [html, ids] of [[admin, ["adminLoginPassword", "usbCreatorPassword", "databaseDownloadCurrentPassword"]], [portal, ["loginPassword", "currentPassword"]]]) {
    for (const id of ids) assert.doesNotMatch(input(html, id), /data-gp-new-password|\bminlength=/);
  }
  for (const id of ["integrationCredentialPassword", "integrationCredentialToken", "integrationCredentialApiKey", "integrationCredentialBasicPassword", "salesArticleImportDatabasePassword"]) {
    assert.doesNotMatch(input(admin, id), /data-gp-new-password/);
  }
  for (const [html, script] of [[admin, "app.js"], [portal, "portal.js"]]) {
    for (const helper of ["password-policy.js", "session-lifecycle.js"]) assert.ok(html.indexOf(`src="/${helper}"`) < html.indexOf(`src="/${script}"`));
  }
});

test("new-password validation counts codepoints, preserves raw input and never truncates a long password", () => {
  const context = vm.createContext({}); vm.runInContext(read("password-policy.js"), context);
  const policy = context.GrabenplanerPasswordPolicy;
  assert.match(policy.errorFor("x".repeat(14)), /mindestens 15/);
  assert.match(policy.errorFor("😀".repeat(14)), /mindestens 15/);
  for (const value of ["x".repeat(15), "😀".repeat(15), "😀".repeat(256), " ".repeat(15), "a\u0308".repeat(8)]) assert.equal(policy.errorFor(value), "");
  assert.match(policy.errorFor("😀".repeat(257)), /höchstens 256/);
  assert.match(policy.errorFor("\ud800" + "x".repeat(15)), /Unicode/);
  policy.configure({ passwordPolicy: { minCodePoints: 18, maxCodePoints: 80 } });
  assert.match(policy.errorFor("x".repeat(17)), /mindestens 18/);
  assert.match(policy.errorFor("x".repeat(81)), /höchstens 80/);
});

for (const [file, method, stateKey] of [["portal.js", "api", "session"], ["app.js", "api", "portalSession"], ["app.js", "rawApi", "portalSession"]]) {
  test(`${file} ${method}: old successful responses cannot return data after an account/session-generation change`, async () => {
    const body = deferred(), reply = deferred();
    const state = { [stateKey]: { authenticated: true, user: { employeeNumber: "SYNTHETIC-A" } } };
    const lifecycle = { generation: 1 };
    const context = vm.createContext({ state, portalState: state, document: { cookie: "" }, csrf: () => "", csrfHeader: () => ({}),
      window: { GrabenplanerSessionLifecycle: lifecycle }, location: { hostname: "127.0.0.1" }, FormData: class {}, fetch: () => reply.promise });
    vm.runInContext(functionSource(method, file), context);
    const pending = context[method]("/api/example");
    if (method === "rawApi") {
      lifecycle.generation++; reply.resolve({ ok: true, status: 200 });
    } else {
      reply.resolve({ ok: true, status: 200, json: () => body.promise });
      await new Promise(setImmediate);
      state[stateKey] = { authenticated: true, user: { employeeNumber: "SYNTHETIC-B" } };
      lifecycle.generation++; body.resolve({ private: "old actor response" });
    }
    await assert.rejects(pending, error => error.code === "PORTAL_SESSION_CHANGED");
  });
  test(`${file} ${method}: credential coordination rejects before fetch and a prior 401 cannot disturb a new credential transition`, async () => {
    const body=deferred(),state={ [stateKey]:{authenticated:true,user:{employeeNumber:'SYNTHETIC'}} },lifecycle={generation:1};
    let calls=0,coordinated=0,loginChanges=0;
    const context=vm.createContext({state,portalState:state,document:{cookie:''},csrf:()=>'',csrfHeader:()=>({}),FormData:class{},
      location:{hostname:'127.0.0.1'},elements:{loginGate:{}},showLogin:()=>loginChanges++,showLoginGate:()=>loginChanges++,
      window:{GrabenplanerSessionLifecycle:lifecycle},fetch:async()=>{calls++;return{ok:false,status:401,json:()=>body.promise};}});
    vm.runInContext(functionSource(method,file),context);
    lifecycle.credentialOptions=()=>{coordinated++;throw Object.assign(new Error('synthetic coordination unavailable'),{code:'PORTAL_CREDENTIAL_COORDINATION_UNAVAILABLE'});};
    await assert.rejects(context[method]('/api/portal/v1/auth/login',{method:'POST'}),error=>error.code==='PORTAL_CREDENTIAL_COORDINATION_UNAVAILABLE');
    assert.equal(coordinated,1);assert.equal(calls,0);
    lifecycle.credentialOptions=(_url,options)=>options;
    const pending=context[method]('/api/old-read');await new Promise(setImmediate);lifecycle.generation++;
    body.resolve({error:'Old session expired'});await assert.rejects(pending,error=>error.code==='PORTAL_SESSION_CHANGED');
    assert.equal(loginChanges,0);assert.equal(state[stateKey].user.employeeNumber,'SYNTHETIC');
    let fail;context.fetch=()=>new Promise((_resolve,reject)=>{fail=reject;});
    const network=context[method]('/api/old-network');lifecycle.generation++;fail(new TypeError('synthetic network loss'));
    await assert.rejects(network,error=>error.code==='PORTAL_SESSION_CHANGED');assert.equal(loginChanges,0);
  });
}

function changeFixture() {
  const old = { authenticated: true, user: { employeeNumber: "SYNTHETIC", mustChangePassword: true } };
  const replacement = { authenticated: true, user: { employeeNumber: "SYNTHETIC", mustChangePassword: false, permissions: ["own_schedule:read"] } };
  const state = { session: old }, changed = deferred(), calls = [], effects = [];
  const context = vm.createContext({ portalState: state, el: { currentPassword: { value: "old-six" }, newPassword: { value: "New synthetic phrase" }, repeatPassword: { value: "New synthetic phrase" } },
    window: { GrabenplanerSessionLifecycle: { publish: () => effects.push("publish"), credentials: operation => operation() } },
    api: async (url, options) => { calls.push({ url, options }); return url.endsWith("/password") ? changed.promise : replacement; },
    showPortal: session => { state.session = session; effects.push("replace"); }, showLogin: () => effects.push("login"),
    message: () => effects.push("message"), closePasswordChangeDialog: () => effects.push("close"),
    redirectToPendingCandidateEvaluation: async () => false, loadMobileLayout: async () => {}, chooseInitialPortalTab() {},
    loadPortalData: async () => effects.push("load"), refreshBirthdayPresentationTheme: async () => {}, claimBirthdayPresentation: async () => {},
  });
  vm.runInContext("let passwordChangeRequest = null;\n" + functionSource("changePassword", "portal.js"), context);
  return { context, state, old, replacement, changed, calls, effects };
}

test("password change replaces the complete session projection and suppresses duplicate submissions", async () => {
  const f = changeFixture(), pending = f.context.changePassword({ preventDefault() {} });
  await f.context.changePassword({ preventDefault() {} });
  assert.equal(f.calls.length, 1);
  f.changed.resolve({ ok: true, sessionChanged: true }); await pending;
  assert.equal(f.state.session, f.replacement); assert.equal(f.old.user.mustChangePassword, true);
  assert.deepEqual(f.effects, ["close", "replace", "publish", "load"]);
  assert.equal(f.calls[1].url, "/api/portal/v1/session");
});

test("password change finishing after a replacement login cannot mutate the new actor or close its dialog", async () => {
  const f = changeFixture(), pending = f.context.changePassword({ preventDefault() {} });
  const other = { authenticated: true, user: { employeeNumber: "SYNTHETIC-B" } }; f.state.session = other;
  f.changed.resolve({ ok: true }); await pending;
  assert.equal(f.state.session, other); assert.deepEqual(f.effects, []); assert.equal(f.calls.length, 1);
});

test("pending browser activity expires, stays bound to the current generation and excludes authentication polling", () => {
  let now = 100000;
  const listeners = new Map();
  const context = vm.createContext({ URL, Date: { now: () => now }, location: { href: "https://gp.test/portal.html" },
    addEventListener: (type, callback) => listeners.set(type, callback) });
  vm.runInContext(read("session-lifecycle.js"), context);
  const lifecycle = context.GrabenplanerSessionLifecycle;
  const sent = url => Object.keys(lifecycle.activityHeaders(url, true)).length;
  listeners.get("input")({ isTrusted: false });
  assert.equal(sent("/api/example"), 0);
  listeners.get("input")({ isTrusted: true });
  for (const url of ["/api/portal/v1/session?poll=1", "/api/portal/v1/status", "/api/mobile/v1/bootstrap", "/api/portal/v1/auth/login", "https://other.test/api/example"]) assert.equal(sent(url), 0);
  assert.equal(sent("/api/example"), 1);
  assert.equal(sent("/api/example"), 0);
  listeners.get("keydown")({ isTrusted: true });
  now += 30001;
  assert.equal(sent("/api/example"), 0);
  listeners.get("pointerdown")({ isTrusted: true });
  lifecycle.advance();
  assert.equal(sent("/api/example"), 0);
  listeners.get("input")({ isTrusted: true });
  now -= 1;
  assert.equal(sent("/api/example"), 0);
});

test("real browser: trusted input renews once through every API wrapper; synthetic events and background polling do not", {
  skip: process.env.GP_SECURITY_AUTH_BROWSER_TEST !== "1", timeout: 60000,
}, async () => {
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
  try {
    for (const [file, method] of [["portal.js", "api"], ["app.js", "api"], ["app.js", "rawApi"]]) {
      const context = await browser.newContext(), page = await context.newPage(), requests = [];
      await page.route("**/*", route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === "/") return route.fulfill({ contentType: "text/html", body: '<button id="activity">Aktion</button><input id="typing">' });
        if (!pathname.startsWith("/api/")) return route.abort();
        requests.push({ pathname, activity: route.request().headers()["x-gp-user-activity"] || "" });
        return route.fulfill({ contentType: "application/json", body: "{}" });
      });
      await page.goto("http://gp-auth.test/");
      await page.addScriptTag({ path: path.join(root, "public/session-lifecycle.js") });
      await page.addScriptTag({ content: `
        const state = {portalSession:{authenticated:true}}, portalState={session:{authenticated:true}};
        function csrf(){return '';} function csrfHeader(){return {};}
        ${functionSource(method, file)}
        window.activityApi=${method};
        window.eventTrust=[];
        for(const type of ['pointerdown','keydown','input'])window.addEventListener(type,event=>eventTrust.push([type,event.isTrusted]));
      ` });
      await page.evaluate(() => {
        for (const type of ["pointerdown", "keydown", "input"]) document.querySelector("#typing").dispatchEvent(new Event(type, { bubbles: true }));
        document.querySelector("#activity").click();
        return activityApi("/api/portal/v1/me/notifications");
      });
      assert.equal(requests.at(-1).activity, "", `${file}/${method}: synthetic event`);
      await page.locator("#activity").click();
      await page.evaluate(async () => {
        for (const url of ["/api/portal/v1/session", "/api/portal/v1/status", "/api/mobile/v1/bootstrap"]) await activityApi(url);
        await activityApi("/api/active");
        await activityApi("/api/portal/v1/me/notifications");
      });
      assert.deepEqual(requests.slice(-5).map(row => row.activity), ["", "", "", "1", ""]);
      await page.locator("#typing").fill("trusted input");
      await page.evaluate(() => activityApi("/api/from-input"));
      assert.equal(requests.at(-1).activity, "1");
      await page.locator("#typing").press("ArrowLeft");
      await page.evaluate(() => activityApi("/api/from-keyboard"));
      assert.equal(requests.at(-1).activity, "1");
      const trust = await page.evaluate(() => eventTrust);
      for (const type of ["pointerdown", "keydown", "input"]) {
        assert.ok(trust.some(row => row[0] === type && row[1] === true));
        assert.ok(trust.some(row => row[0] === type && row[1] === false));
      }
      const beforePolls = requests.length;
      await page.evaluate(() => {
        window.pollsFinished = 0;
        const timer = setInterval(async () => {
          await activityApi("/api/portal/v1/me/notifications");
          if (++pollsFinished >= 4) clearInterval(timer);
        }, 25);
      });
      await page.waitForFunction(() => pollsFinished >= 4);
      assert.ok(requests.slice(beforePolls).length >= 4);
      assert.ok(requests.slice(beforePolls).every(row => row.activity === ""));
      await page.locator("#activity").click();
      await page.evaluate(() => { GrabenplanerSessionLifecycle.advance(); return activityApi("/api/new-session"); });
      assert.equal(requests.at(-1).activity, "");
      assert.equal(await page.evaluate(() => localStorage.length), 0);
      await context.close();
    }
  } finally { await browser.close(); }
});

test("real browser: old credentials, Unicode form validity, optional reset fields and cross-tab invalidation", {
  skip: process.env.GP_SECURITY_AUTH_BROWSER_TEST !== "1", timeout: 60000,
}, async () => {
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}), args: ["--no-first-run"] });
  try {
    const context = await browser.newContext(), pages = [await context.newPage(), await context.newPage()];
    const portal = read("portal.html"), admin = read("index.html");
    const markup = '<form id="legacy">' + input(portal, "loginPassword").replace(/\sdisabled/, "") + input(portal, "currentPassword").replace(/\sdisabled/, "") + '<button>Login</button></form>'
      + '<form id="new">' + input(portal, "newPassword").replace(/\sdisabled/, "") + '<button>Speichern</button></form>'
      + '<form id="optional">' + input(admin, "usbDraftPassword") + '<button>Entwurf</button></form>';
    for (const page of pages) {
      page.setDefaultTimeout(8000);
      await page.route("**/*", route => route.request().url() === "http://gp-auth.test/" ? route.fulfill({ contentType: "text/html", body: markup }) : route.abort());
      await page.goto("http://gp-auth.test/");
      for (const helper of ["password-policy.js", "session-lifecycle.js"]) await page.addScriptTag({ path: path.join(root, "public", helper) });
      await page.evaluate(() => {
        window.submitted = []; window.invalidations = 0;
        for (const form of document.forms) form.addEventListener("submit", event => { event.preventDefault(); submitted.push(form.id); });
        GrabenplanerPasswordPolicy.configure({ passwordMinLength: 15, passwordPolicy: { minCodePoints: 15, maxCodePoints: 256 } });
        GrabenplanerSessionLifecycle.listen(() => { invalidations++; });
      });
    }
    const page = pages[0];
    await page.locator("#loginPassword").fill("old-six"); await page.locator("#currentPassword").fill("old-six");
    await page.locator("#legacy button").click(); assert.deepEqual(await page.evaluate(() => submitted), ["legacy"]);
    await page.locator("#newPassword").fill("😀".repeat(14)); await page.locator("#new button").click();
    assert.equal(await page.locator("#newPassword").evaluate(node => node.validity.customError), true);
    await page.locator("#newPassword").fill("😀".repeat(15)); await page.locator("#new button").click();
    assert.deepEqual(await page.evaluate(() => submitted), ["legacy", "new"]);
    await page.locator("#newPassword").fill("😀".repeat(256));
    assert.equal(Array.from(await page.locator("#newPassword").inputValue()).length, 256);
    assert.equal(await page.locator("#newPassword").evaluate(node => node.checkValidity()), true);
    await page.locator("#newPassword").fill("😀".repeat(257)); assert.equal(await page.locator("#newPassword").evaluate(node => node.checkValidity()), false);
    await page.locator("#optional button").click(); assert.deepEqual(await page.evaluate(() => submitted), ["legacy", "new", "optional"]);
    await page.locator("#usbDraftPassword").fill("short"); assert.equal(await page.locator("#usbDraftPassword").evaluate(node => node.checkValidity()), false);
    await page.evaluate(() => document.querySelector("#optional").reset());
    await page.waitForFunction(() => document.querySelector("#usbDraftPassword").validity.valid);
    const before = await page.evaluate(() => GrabenplanerSessionLifecycle.generation);
    await pages[1].evaluate(() => GrabenplanerSessionLifecycle.publish());
    await page.waitForFunction(() => invalidations === 1);
    assert.ok(await page.evaluate(() => GrabenplanerSessionLifecycle.generation) > before);
    assert.equal(await pages[1].evaluate(() => invalidations), 0);
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    await context.close();
  } finally { await browser.close(); }
});

test("real browser: password-change continuation adopts fresh user/CSRF and discards a delayed old-session body", {
  skip: process.env.GP_SECURITY_AUTH_BROWSER_TEST !== "1", timeout: 60000,
}, async () => {
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
  try {
    const context = await browser.newContext(), page = await context.newPage();
    let delayed, mutationCsrf = "", passwordCsrf = "";
    const delayedSeen = deferred();
    const fresh = { authenticated: true, user: { employeeNumber: "SYNTHETIC", mustChangePassword: false, permissions: ["own_schedule:read"] } };
    await context.addCookies([{ name: "grabenplaner_csrf", value: "synthetic-old-csrf", url: "http://gp-auth.test/" }]);
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<form id="passwordForm"><input id="currentPassword" type="password"><input id="newPassword" data-gp-new-password type="password"><input id="repeatPassword" data-gp-new-password type="password"><button>Ändern</button></form>' });
      if (url.pathname === "/api/delayed") { delayed = route; delayedSeen.resolve(); return; }
      if (url.pathname === "/api/portal/v1/me/password") {
        passwordCsrf = route.request().headers()["x-csrf-token"];
        return route.fulfill({ contentType: "application/json", headers: { "set-cookie": "grabenplaner_csrf=synthetic-fresh-csrf; Path=/; SameSite=Strict" }, body: JSON.stringify({ ok: true, sessionChanged: true, user: fresh.user }) });
      }
      if (url.pathname === "/api/portal/v1/session") return route.fulfill({ contentType: "application/json", body: JSON.stringify(fresh) });
      if (url.pathname === "/api/mutate") { mutationCsrf = route.request().headers()["x-csrf-token"]; return route.fulfill({ contentType: "application/json", body: "{}" }); }
      return route.abort();
    });
    await page.goto("http://gp-auth.test/");
    for (const helper of ["password-policy.js", "session-lifecycle.js"]) await page.addScriptTag({ path: path.join(root, "public", helper) });
    await page.addScriptTag({ content: `
      const portalState = { session: { authenticated: true, user: { employeeNumber: 'SYNTHETIC', mustChangePassword: true, permissions: [] } } };
      const el = Object.fromEntries(['passwordForm','currentPassword','newPassword','repeatPassword'].map(id=>[id,document.getElementById(id)]));
      let passwordChangeRequest = null;
      function message() { throw new Error('unexpected password error'); }
      function showLogin() { throw new Error('unexpected logout'); }
      function closePasswordChangeDialog(){el.passwordForm.reset();}
      function showPortal(session){portalState.session=session;GrabenplanerSessionLifecycle.advance();}
      async function redirectToPendingCandidateEvaluation(){return false;}
      async function loadMobileLayout(){} function chooseInitialPortalTab(){}
      async function loadPortalData(){window.loaded=true;}
      async function refreshBirthdayPresentationTheme(){} async function claimBirthdayPresentation(){}
      ${functionSource("csrf", "portal.js")}
      ${functionSource("api", "portal.js")}
      ${functionSource("changePassword", "portal.js")}
      el.passwordForm.addEventListener('submit',changePassword);
      window.oldResponse = api('/api/delayed').then(()=> 'incorrect success',error=>error.code);
    ` });
    await delayedSeen.promise;
    assert.ok(delayed);
    await page.locator("#currentPassword").fill("old-six");
    await page.locator("#newPassword").fill("New synthetic phrase");
    await page.locator("#repeatPassword").fill("New synthetic phrase");
    await page.locator("button").click(); await page.waitForFunction(() => window.loaded);
    assert.equal(passwordCsrf, "synthetic-old-csrf");
    assert.deepEqual(await page.evaluate(() => portalState.session), fresh);
    await delayed.fulfill({ contentType: "application/json", body: '{"private":"previous session"}' });
    assert.equal(await page.evaluate(() => oldResponse), "PORTAL_SESSION_CHANGED");
    await page.evaluate(() => api("/api/mutate", { method: "POST", body: "{}" }));
    assert.equal(mutationCsrf, "synthetic-fresh-csrf");
    assert.equal(await page.locator("#currentPassword").inputValue(), "");
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    await context.close();
  } finally { await browser.close(); }
});

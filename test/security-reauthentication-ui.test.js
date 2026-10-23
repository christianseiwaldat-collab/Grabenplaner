"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const http = require("node:http");
const { functionSource } = require("../test-support/learning-workspace-ui");
const root = path.resolve(__dirname, "..");
const lifecycleSource = fs.readFileSync(path.join(root, "public/session-lifecycle.js"), "utf8");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const routes = [
  ["POST", "/api/backup/database-download", "downloadCompleteDatabase"],
  ["POST", "/api/backup/offsite-folders", "createManagedOffsiteFolder"],
  ["PUT", "/api/backup/offsite-folders/active", "activateManagedOffsiteFolder"],
  ["POST", "/api/portal/v1/server-monitor/vps-reboot", "submitVpsReboot"],
];

test("all four reauthentication paths require credential coordination and bind follow-up reads to its abort signal", async () => {
  const context = vm.createContext({ URL, AbortController, AbortSignal, location: { href: "https://synthetic.test/" },
    document: { cookie: "grabenplaner_csrf=synthetic" }, navigator: { locks: { request: async (_name, _options, run) => run() } } });
  vm.runInContext(lifecycleSource, context);
  const lifecycle = context.GrabenplanerSessionLifecycle;
  for (const [method, url, handler] of routes) {
    assert.throws(() => lifecycle.credentialOptions(url, { method }), error => error.code === "PORTAL_CREDENTIAL_COORDINATION_UNAVAILABLE");
    assert.match(functionSource(handler, "app.js"), /await withAdminReauthentication\(async \(\) =>/);
    await lifecycle.credentials(async () => {
      assert.equal(lifecycle.credentialChanged, false);
      const mutation = lifecycle.credentialOptions(url, { method });
      assert.ok(mutation.signal instanceof AbortSignal);
      assert.equal(lifecycle.credentialOptions("/api/portal/v1/session", {}).signal, mutation.signal);
      lifecycle.observeCredentialResponse({ headers: new Headers({ "X-GP-Session-Changed": "1" }) });
      assert.equal(lifecycle.credentialChanged, true);
    });
  }
  assert.deepEqual(Object.keys(lifecycle.credentialOptions("/api/backup/offsite-folders", { method: "GET" })), ["method"]);
});

function adoptionFixture({ unavailable = false } = {}) {
  const old = { authenticated: true, user: { employeeNumber: "SYNTHETIC-A" } };
  const fresh = { authenticated: true, user: { employeeNumber: "SYNTHETIC-A", expiresAt: "2030-01-01T00:00:00Z" } };
  const state = { portalSession: old }, effects = [];
  const lifecycle = { generation: 0, credentialChanged: false,
    advance() { this.generation++; }, publish() { effects.push("publish"); },
    async credentials(operation) { effects.push("lock"); this.advance(); try { return await operation(); } finally { effects.push("release"); } } };
  const context = vm.createContext({ state, document: { cookie: "grabenplaner_csrf=synthetic-old" }, window: { GrabenplanerSessionLifecycle: lifecycle },
    api: async url => { assert.equal(url, "/api/portal/v1/session"); effects.push("read-session"); if (unavailable) throw new Error("synthetic restart"); return fresh; },
    applyRoleVisibility: () => effects.push("adopt"), showLoginGate: () => { state.portalSession = null; lifecycle.advance(); effects.push("invalidate"); } });
  vm.runInContext(functionSource("withAdminReauthentication", "app.js"), context);
  return { context, state, fresh, old, lifecycle, effects };
}

test("reauthentication keeps download body consumption under lock and adopts before publishing/releasing", async () => {
  const f = adoptionFixture(), body = deferred();
  const pending = f.context.withAdminReauthentication(async () => { f.lifecycle.credentialChanged = true; await body.promise; f.effects.push("body-read"); return "downloaded"; });
  await new Promise(setImmediate);
  assert.deepEqual(f.effects, ["lock"]);
  body.resolve(); assert.equal(await pending, "downloaded");
  assert.equal(f.state.portalSession, f.fresh);
  assert.deepEqual(f.effects, ["lock", "body-read", "read-session", "adopt", "publish", "release"]);
});

test("a committed rotation is adopted after a protected-operation error without losing that error", async () => {
  const f = adoptionFixture(), failure = Object.assign(new Error("synthetic broker unavailable"), { status: 503 });
  await assert.rejects(f.context.withAdminReauthentication(async () => { f.lifecycle.credentialChanged = true; throw failure; }), error => error === failure);
  assert.equal(f.state.portalSession, f.fresh);
  assert.deepEqual(f.effects, ["lock", "read-session", "adopt", "publish", "release"]);
});

test("a changed cookie still triggers adoption if transport failure hides the rotation header", async () => {
  const f = adoptionFixture(), failure = new TypeError("synthetic response transport loss");
  await assert.rejects(f.context.withAdminReauthentication(async () => {
    f.context.document.cookie = "grabenplaner_csrf=synthetic-new"; throw failure;
  }), error => error === failure);
  assert.equal(f.state.portalSession, f.fresh);
  assert.deepEqual(f.effects, ["lock", "read-session", "adopt", "publish", "release"]);
});

test("unreachable session after accepted reboot invalidates locally without changing the accepted result", async () => {
  const f = adoptionFixture({ unavailable: true }), accepted = { accepted: true };
  assert.equal(await f.context.withAdminReauthentication(async () => { f.lifecycle.credentialChanged = true; return accepted; }), accepted);
  assert.equal(f.state.portalSession, null);
  assert.deepEqual(f.effects, ["lock", "read-session", "invalidate", "publish", "release"]);
});

test("a newer actor is never overwritten by reauthentication adoption and an original error remains an error", async () => {
  const f = adoptionFixture(), other = { authenticated: true, user: { employeeNumber: "SYNTHETIC-B" } }, failure = new Error("original failure");
  await assert.rejects(f.context.withAdminReauthentication(async () => {
    f.lifecycle.credentialChanged = true; f.state.portalSession = other; f.lifecycle.advance(); throw failure;
  }), error => error === failure);
  assert.equal(f.state.portalSession, other); assert.ok(!f.effects.includes("adopt")); assert.ok(!f.effects.includes("invalidate"));
});

for (const method of ["api", "rawApi"]) {
  test(`${method} records committed rotation from error responses before returning the operation error`, async () => {
    const state = { portalSession: {} }, observed = [];
    const context = vm.createContext({ state, document: { cookie: "" }, csrfHeader: () => ({}), elements: {}, location: { hostname: "localhost" },
      window: { GrabenplanerSessionLifecycle: { generation: 0, observeCredentialResponse: response => observed.push(response.headers.get("X-GP-Session-Changed")) } },
      fetch: async () => new Response(JSON.stringify({ error: "Synthetic failure", code: "SYNTHETIC_FAILURE" }), { status: 503, headers: { "X-GP-Session-Changed": "1" } }) });
    vm.runInContext(functionSource(method, "app.js"), context);
    await assert.rejects(context[method]("/api/backup/offsite-folders", { method: "POST" }), error => error.status === 503 && error.code === "SYNTHETIC_FAILURE");
    assert.deepEqual(observed, ["1"]);
  });
}

test("real Chrome cookie jar: Web Locks and IndexedDB serialize reauth error/download bodies before another tab logs in", {
  skip: process.env.GP_SECURITY_AUTH_BROWSER_TEST !== "1", timeout: 90000,
}, async () => {
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  const script = `${lifecycleSource}\nvar state={portalSession:{authenticated:true,user:{employeeNumber:'SYNTHETIC-A'}}};var elements={};var effects=[];
    function csrfHeader(){return{};}function applyRoleVisibility(){effects.push('adopt');}
    function showLoginGate(){state.portalSession=null;GrabenplanerSessionLifecycle.advance();effects.push('invalidate');}
    ${functionSource("api", "app.js")}\n${functionSource("rawApi", "app.js")}\n${functionSource("withAdminReauthentication", "app.js")}
    GrabenplanerSessionLifecycle.listen(()=>{});
    window.beginReauth=(download)=>withAdminReauthentication(async()=>{if(download){const response=await rawApi('/api/backup/database-download',{method:'POST'});await response.arrayBuffer();effects.push('body-read');return 'downloaded';}return api('/api/backup/offsite-folders',{method:'POST'});}).then(value=>({ok:true,value}),error=>({ok:false,code:error.code}));
    window.loginB=()=>GrabenplanerSessionLifecycle.credentials(async()=>{const session=await api('/api/portal/v1/auth/login',{method:'POST'});state.portalSession=session;GrabenplanerSessionLifecycle.advance();GrabenplanerSessionLifecycle.publish();return session;},{allowAccountChange:true});`;
  let reached, release, logins = 0, reads = 0, reauthRequests = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>Synthetic credential test</title>"); return; }
    if (request.url === "/api/portal/v1/session") {
      reads++; const actor = (request.headers.cookie || "").includes("synthetic-B") ? "SYNTHETIC-B" : "SYNTHETIC-A";
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ authenticated: true, user: { employeeNumber: actor } })); return;
    }
    if (request.url === "/api/portal/v1/auth/login") {
      logins++; response.setHeader("Set-Cookie", "grabenplaner_csrf=synthetic-B; Path=/; SameSite=Strict");
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ authenticated: true, user: { employeeNumber: "SYNTHETIC-B" } })); return;
    }
    if (!["/api/backup/database-download", "/api/backup/offsite-folders"].includes(request.url)) { response.statusCode = 404; response.end(); return; }
    reauthRequests++;
    response.setHeader("X-GP-Session-Changed", "1");
    response.setHeader("Set-Cookie", "grabenplaner_csrf=synthetic-rotated-A; Path=/; SameSite=Strict");
    if (request.url === "/api/backup/database-download") {
      response.setHeader("Content-Type", "application/octet-stream"); response.write("synthetic-part-one"); reached.resolve(); await release.promise; response.end("synthetic-part-two");
    } else {
      reached.resolve(); await release.promise; response.statusCode = 503; response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: "Synthetic post-commit failure", code: "SYNTHETIC_FAILURE" }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
    for (const mode of ["web-locks", "indexeddb"]) for (const download of [false, true]) {
      const context = await browser.newContext();
      try {
        if (mode === "indexeddb") await context.addInitScript(() => Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }));
        const a = await context.newPage(), b = await context.newPage();
        for (const page of [a, b]) { await page.goto(origin); await page.addScriptTag({ content: script }); }
        assert.equal(await a.evaluate(() => Boolean(navigator.locks?.request)), mode === "web-locks");
        await context.addCookies([{ name: "grabenplaner_csrf", value: "synthetic-A", url: origin }]);
        reached = deferred(); release = deferred(); const before = logins, previousReads = reads;
        const operation = a.evaluate(download => beginReauth(download), download); await reached.promise;
        const login = b.evaluate(() => loginB());
        await b.waitForTimeout(100);
        assert.equal(logins, before, `${mode}: competing login cannot precede reauth headers/body`);
        release.resolve(); const observed = await operation; await login;
        assert.equal(observed.ok, download); if (!download) assert.equal(observed.code, "SYNTHETIC_FAILURE");
        assert.ok(reads > previousReads); assert.equal(logins, before + 1);
        assert.equal((await context.cookies()).find(cookie => cookie.name === "grabenplaner_csrf").value, "synthetic-B");
        assert.equal(await b.evaluate(() => state.portalSession.user.employeeNumber), "SYNTHETIC-B");
        assert.ok((await a.evaluate(() => effects)).includes("adopt"));
      } finally { release?.resolve(); await context.close(); }
    }
    const blocked = await browser.newContext();
    try {
      await blocked.addInitScript(() => { Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }); Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() { throw new DOMException("Synthetic blocked storage", "SecurityError"); } } }); });
      const page = await blocked.newPage(); await page.goto(origin); await page.addScriptTag({ content: script });
      const before = reauthRequests; const denied = await page.evaluate(() => beginReauth(false));
      assert.equal(denied.code, "PORTAL_CREDENTIAL_COORDINATION_UNAVAILABLE"); assert.equal(reauthRequests, before);
    } finally { await blocked.close(); }
  } finally {
    release?.resolve(); await browser?.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});

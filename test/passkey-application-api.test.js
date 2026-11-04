"use strict";

// Explicit, disposable PostgreSQL fixture only. The real application's HTTP,
// authorization, transactions, native repository and WebAuthn verification run
// unchanged. Only offsite/export/host effects are replaced below. Browser FIDO
// devices and all accounts contain synthetic data; no real broker is contacted.
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawn } = require("node:child_process");
const ROOT = path.resolve(__dirname, ".."), ORIGIN = "https://passkey-api.example.test";
const PASSWORD = "Synthetic cedar orbit pelican 2026!", NEW_PASSWORD = "Synthetic quartz meadow eclipse 2026!";
const CHILD = "GP_PASSKEY_APPLICATION_HTTP_CHILD", BASE = "/api/portal/v1/passkeys";
const enabled = Boolean(process.env.GP_CORE_MIGRATOR_URL && process.env.GP_WINDOW_BROWSER_TEST === "1");
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Test-local authority over one detached Linux application-test child group.
// Chromium may create other sessions: this proves only the bound group is empty.
function bindApplicationChildGroup(child) {
  assert.equal(process.platform, "linux");
  const member = pid => {
    try {
      const directory = "/proc/" + pid, fields = fs.readFileSync(directory + "/stat", "utf8").split(") ")[1].trim().split(/\s+/);
      return { pid: Number(pid), uid: fs.statSync(directory).uid, group: Number(fields[2]), session: Number(fields[3]), start: fields[19] };
    } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return null; throw error; }
  };
  const identity = member(child.pid);
  assert(identity && identity.uid === process.getuid() && identity.group === child.pid && identity.session === child.pid);
  assert.equal(fs.realpathSync("/proc/" + child.pid + "/cwd"), fs.realpathSync(ROOT));
  assert.equal(fs.realpathSync("/proc/" + child.pid + "/exe"), fs.realpathSync(process.execPath));
  const members = () => {
    const leader = member(child.pid);
    if (leader) assert.deepEqual(leader, identity, "application test child PID must never be reused");
    const result = fs.readdirSync("/proc").filter(name => /^[0-9]+$/.test(name)).map(member)
      .filter(row => row && row.group === identity.group);
    assert(result.every(row => row.uid === identity.uid && row.session === identity.session && BigInt(row.start) >= BigInt(identity.start)),
      "only this test-created process group may be signalled");
    return result;
  };
  let stopping;
  return { async stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (members().length) {
        try { process.kill(-identity.group, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        const gracefulUntil = performance.now() + 3000;
        while (members().length && performance.now() < gracefulUntil) await delay(100);
      }
      if (members().length) {
        try { process.kill(-identity.group, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        const finalUntil = performance.now() + 5000;
        while (members().length && performance.now() < finalUntil) await delay(100);
      }
      assert.equal(members().length, 0, "the bound application-test process group must end");
      return { boundGroupEmpty: true, coversIndependentBrowserSessions: false };
    })();
    return stopping;
  } };
}

if (!process.env[CHILD]) {
  test("Passkeys: actual PostgreSQL application HTTP and browser FIDO ceremonies", { skip: !enabled, timeout: 540000 }, async t => {
    const env = { ...process.env, [CHILD]: "postgresql" }; delete env.NODE_TEST_CONTEXT;
    // Direct node:test execution removes the otherwise hidden test grandchild.
    const child = spawn(process.execPath, [__filename], {
      cwd: ROOT, env, detached: process.platform === "linux", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", verified = false, group, watchdog, watchdogError, lastPhase = null;
    const append = value => {
      const text = value.toString();
      output = (output + text).slice(-65536);
      verified ||= output.includes("PASSKEY_APPLICATION_HTTP_VERIFIED");
      const phases = output.match(/PASSKEY_PHASE [^\n]+/g); if (phases?.length) lastPhase = phases.at(-1);
      // All accounts are synthetic; keep the actual child diagnostics visible
      // even if the outer deadline interrupts its close/after-success path.
      fs.writeSync(2, text);
    };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    void closed.catch(() => {}); // A spawn error must also reach the spawn await.
    const stop = async () => {
      if (group) return group.stop();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    t.after(async () => {
      clearTimeout(watchdog);
      t.diagnostic(JSON.stringify({ lastPhase, boundedChildTail: output.slice(-16384) }));
      const proof = await stop(); if (proof) t.diagnostic(JSON.stringify(proof));
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    if (process.platform === "linux") group = bindApplicationChildGroup(child);
    watchdog = setTimeout(() => {
      watchdogError = Error("PASSKEY_APPLICATION_CHILD_DEADLINE");
      fs.writeSync(2, "PASSKEY_CHILD_DEADLINE " + JSON.stringify({ lastPhase, tail: output.slice(-16384) }) + "\n");
      void stop().catch(error => { fs.writeSync(2, "PASSKEY_CHILD_CLEANUP_FAILED " + error.message + "\n"); });
    }, 515000);
    const exit = await closed;
    if (watchdogError) throw watchdogError;
    assert.equal(exit.code, 0, output); assert.equal(exit.signal, null); assert(verified, output);
  });

  test("application harness reaps its own stubborn child group without a test grandchild", { skip: process.platform !== "linux", timeout: 20000 }, async () => {
    const code = `const{spawn}=require('node:child_process');process.on('SIGTERM',()=>{});
      const nested=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
      nested.once('spawn',()=>console.log('OWNED_GROUP_READY'));setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", code], { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const group = bindApplicationChildGroup(child);
    try {
      await new Promise((resolve, reject) => { child.stdout.on("data", value => { if (value.toString().includes("OWNED_GROUP_READY")) resolve(); }); child.once("error", reject); });
      assert.deepEqual(await group.stop(), { boundGroupEmpty: true, coversIndependentBrowserSessions: false });
      assert.equal((await closed).signal, "SIGKILL");
    } finally { await group.stop(); }
  });
} else {
  assert.equal(process.env[CHILD], "postgresql"); assert.equal(enabled, true, "both explicit native/browser opt-ins are required");
  const { assertSyntheticEndpoint } = require("../test-support/postgresql-migration/ci-endpoint");
  for (const domain of ["core", "sales"]) for (const purpose of ["app", "reader", "migrator"]) {
    const url = assertSyntheticEndpoint(process.env[`GP_${domain.toUpperCase()}_${purpose.toUpperCase()}_URL`], domain, ["55482", "55483"]);
    assert.equal(url.username, `gp_${domain}_${purpose}`); assert.equal(url.search, ""); assert.equal(url.hash, "");
  }

  test("native application enrollment, typed login, reauthentication, races and reset lifecycle", { timeout: 510000 }, async t => {
    const began = performance.now();
    const mark = (phase, detail) => fs.writeSync(2, "PASSKEY_PHASE " + JSON.stringify({ phase, ...(detail ? { detail } : {}),
      elapsedMilliseconds: Math.round(performance.now() - began), pid: process.pid }) + "\n");
    mark("child-test-start");
    async function scenario(name, work) {
      mark("group-begin", name);
      try { await t.test(name, work); } finally { mark("group-end", name); }
    }
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-passkey-http-")), restorers = [], challengeIds = new Set();
    const configuration = require("../lib/persistence/configuration"), originalConfiguration = configuration.resolvePersistenceConfiguration;
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    const effects = { create: 0, activate: 0, export: 0, reboot: 0 };
    let subject, server, browser, fixture, query, base, groupCount = 0, verifyGate, clientSequence = 1;
    const subtle = crypto.webcrypto.subtle, originalVerify = subtle.verify;
    // Cryptography still runs natively. Holding only delivery of a successful
    // result forces two genuine proofs to observe the same credential revision.
    subtle.verify = async function (...args) {
      const accepted = await originalVerify.apply(this, args), gate = verifyGate;
      if (accepted && gate) { gate.arrivals++; if (gate.arrivals === gate.count) gate.ready(); await gate.releasePromise; }
      return accepted;
    };
    function signatureBarrier(count = 2) {
      assert.equal(verifyGate, undefined);
      let ready, release, fail;
      const pending = new Promise((resolve, reject) => { ready = resolve; fail = reject; });
      const releasePromise = new Promise(resolve => { release = resolve; });
      const gate = { arrivals: 0, count, ready, releasePromise, release }; verifyGate = gate;
      const timer = setTimeout(() => fail(Error(`native signature barrier ${gate.arrivals}/${count}`)), 20000);
      return { pending, release() { clearTimeout(timer); verifyGate = undefined; release(); } };
    }
    function replace(modulePath, replacements) {
      const module = require(modulePath);
      for (const [key, replacement] of Object.entries(replacements)) {
        const previous = module[key]; module[key] = replacement; restorers.push(() => { module[key] = previous; });
      }
    }
    replace("../lib/offsite-target-client", {
      createManagedOffsiteFolder: async label => { effects.create++; return { createdFolder: label, activeFolder: null }; },
      activateManagedOffsiteFolder: async label => { effects.activate++; return { activeFolder: label, migrationMode: "synthetic", recoverySetState: "ready", fallbackPreserved: true }; },
      listManagedOffsiteFolders: async () => ({ folders: [], activeFolder: null }),
    });
    replace("../lib/host-reboot-control-client", {
      readHostBootGeneration: () => "11111111-2222-4333-8444-555555555555", assertSafeSocket: () => true,
      requestHostReboot: async () => { throw Error("Unexpected real host dispatch"); },
    });
    replace("../lib/host-security-status", { readHostSecurityStatus: () => ({ configured: true, statusAvailable: true,
      rebootRequired: true, pendingConfirmation: false, lastErrorCode: null }) });
    replace("../lib/controlled-host-reboot", { prepareControlledHostReboot: async options => {
      await options.recordRequest(); effects.reboot++; return { acceptedAt: new Date().toISOString() };
    } });
    replace("../lib/persistence/postgresql/lifecycle-control", { available: () => true, requestControl: async ({ action }) => {
      assert.equal(action, "vps-reboot"); effects.reboot++; return { acceptedAt: new Date().toISOString() };
    } });
    replace("../lib/persistence/postgresql/operations/application-export", { createApplicationDatabaseExport: async () => {
      effects.export++;
      const directory = fs.mkdtempSync(path.join(temporaryRoot, "export-")), filename = path.join(directory, "synthetic.bin");
      const bytes = Buffer.from("synthetic export operating boundary only\n"); fs.writeFileSync(filename, bytes);
      return { temporaryRoot: directory, path: filename, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        extension: "bin", contentType: "application/octet-stream", releaseWorkspace() {} };
    } });
    Object.assign(process.env, {
      NODE_ENV: "test", TZ: "Europe/Vienna", DB_PROVIDER: "postgresql", DATABASE_URL: "",
      DB_PATH: path.join(temporaryRoot, "fixture.db"), BACKUP_DIR: path.join(temporaryRoot, "backups"),
      GRABENPLANER_DATA_DIR: path.join(temporaryRoot, "data"), GRABENPLANER_HOST: "127.0.0.1",
      GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1", GRABENPLANER_OPERATION_MODE: "server",
      GRABENPLANER_PUBLIC_URL: ORIGIN, GRABENPLANER_TRUST_PROXY: "loopback", GRABENPLANER_DEPLOYMENT_KIND: "codespaces-test",
      GRABENPLANER_AMU_KEY_ID: "synthetic-passkey", GRABENPLANER_AMU_KEY: Buffer.alloc(32, 71).toString("base64"),
      GRABENPLANER_INTEGRATION_KEY_ID: "synthetic-passkey", GRABENPLANER_INTEGRATION_KEY: Buffer.alloc(32, 78).toString("base64"),
      GRABENPLANER_SERVICE_CONTROL_TOKEN: "synthetic-passkey-service-only-2026", GRABENPLANER_TEST_AMU_SCANNER: "clean",
      GRABENPLANER_PRIVATE_WORKSPACE_MODULE: "",
    });
    const hash = value => crypto.createHash("sha256").update(value).digest("hex");
    const salt = Buffer.alloc(16, 87), passwordHash = password => `scrypt-v1$${salt.toString("base64url")}$${crypto.scryptSync(password, salt, 64).toString("base64url")}`;
    function credentials(result, previous = { cookies: {} }) {
      const cookies = { ...previous.cookies };
      for (const raw of result.cookies) {
        const first = raw.split(";")[0], index = first.indexOf("="), name = first.slice(0, index), value = first.slice(index + 1);
        if (!value || /;\s*Max-Age=0(?:;|$)/i.test(raw)) delete cookies[name]; else cookies[name] = value;
      }
      return { cookies, csrf: decodeURIComponent(cookies.grabenplaner_csrf || ""),
        clientAddress: previous.clientAddress || `198.18.0.${++clientSequence}` };
    }
    async function request(route, { method = "GET", auth, body, csrf } = {}) {
      const result = await fetch(base + route, { method, signal: AbortSignal.timeout(45000), headers: {
        "Content-Type": "application/json", Origin: ORIGIN, "X-Forwarded-Proto": "https", "Sec-Fetch-Site": "same-origin",
        // Separate synthetic browser clients retain their own bounded IP budget.
        "X-Forwarded-For": auth?.clientAddress || "198.18.0.1",
        ...(auth ? { Cookie: Object.entries(auth.cookies).map(([key, value]) => `${key}=${value}`).join("; "), "X-CSRF-Token": csrf ?? auth.csrf } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const bytes = Buffer.from(await result.arrayBuffer());
      try {
        const payload = result.headers.get("content-type")?.includes("application/json") ? JSON.parse(bytes.toString("utf8")) : { bytes: bytes.length, sha256: hash(bytes) };
        if (payload.challengeId) challengeIds.add(payload.challengeId);
        return { status: result.status, body: payload, cookies: result.headers.getSetCookie(), changed: result.headers.get("x-gp-session-changed") };
      } finally { bytes.fill(0); }
    }
    const info = auth => request("/api/portal/v1/session", { auth });
    const sessionRows = id => query("SELECT id,token_hash,authenticated_at,absolute_expires_at,expires_at,revoked_at FROM gp.portal_sessions WHERE employee_number=$1 ORDER BY id", [id]);
    const activeSession = async (id, auth) => {
      const rows = await sessionRows(id), tokenHash = hash(decodeURIComponent(auth.cookies.grabenplaner_session || ""));
      return rows.find(row => row.token_hash === tokenHash && !row.revoked_at);
    };
    async function seed(id, role = "developer") {
      const location = (await query("SELECT id FROM gp.locations ORDER BY id LIMIT 1"))[0].id;
      await query("INSERT INTO gp.employees(personnel_number,full_name,nickname,home_location_id,active) VALUES($1,'Synthetic passkey actor','Synthetic',$2,1)", [id, location]);
      await query("INSERT INTO gp.portal_users(employee_number,password_hash,role,active,must_change_password,password_policy_version) VALUES($1,$2,$3,1,0,1)", [id, passwordHash(PASSWORD), role]);
      return loginPassword(id);
    }
    async function loginPassword(id, password = PASSWORD) {
      const entered = await request("/api/portal/v1/auth/login", { method: "POST", body: { employeeNumber: id, password } });
      assert.equal(entered.status, 200, JSON.stringify(entered.body)); return credentials(entered);
    }
    async function device() {
      const context = await browser.newContext(), page = await context.newPage();
      const errors = []; page.on("pageerror", error => errors.push(error.message));
      await page.route(`${ORIGIN}/**`, route => route.fulfill({ contentType: "text/html", body: "<!doctype html><html lang=de><title>Synthetic GP application Passkey API test</title></html>" }));
      await page.goto(ORIGIN + "/");
      await page.addScriptTag({ path: path.join(ROOT, "node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js") });
      const cdp = await context.newCDPSession(page); await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
        defaultBackupEligibility: true, defaultBackupState: true } });
      return { context, page, cdp, authenticatorId, errors };
    }
    async function enroll(auth, fido, { accountId, counterless = false } = {}) {
      const before = (await info(auth)).body.user;
      const options = await request(BASE + "/register/options", { method: "POST", auth,
        body: { label: "Synthetic browser key", currentPassword: PASSWORD, ...(accountId ? { accountId } : {}) } });
      assert.equal(options.status, 200, JSON.stringify(options.body));
      const response = await fido.page.evaluate(optionsJSON => SimpleWebAuthnBrowser.startRegistration({ optionsJSON }), options.body.options);
      if (counterless) {
        // Model a counterless synced authenticator at enrollment, before any
        // immutable native row exists. Attestation "none" has no attestation
        // signature to alter. Keep Chrome's genuine key, ID, flags and handle;
        // later assertions are signed by that key over the zero counter.
        const { isoCBOR } = await import("@simplewebauthn/server/helpers");
        const attestation = isoCBOR.decodeFirst(Buffer.from(response.response.attestationObject, "base64url"));
        assert.equal(attestation.get("fmt"), "none"); assert.equal(attestation.get("attStmt").size, 0);
        const authData = Buffer.from(attestation.get("authData")); assert(authData.length >= 37); authData.writeUInt32BE(0, 33);
        attestation.set("authData", Uint8Array.from(authData));
        response.response.attestationObject = Buffer.from(isoCBOR.encode(attestation)).toString("base64url");
        if (response.response.authenticatorData) response.response.authenticatorData = authData.toString("base64url");
      }
      const proof = { challengeId: options.body.challengeId, response, ...(accountId ? { accountId } : {}) };
      const registered = await request(BASE + "/register/verify", { method: "POST", auth, body: proof });
      assert.equal(registered.status, 200, JSON.stringify(registered.body)); assert.equal(registered.changed, "1");
      const next = credentials(registered, auth);
      assert.equal((await info(auth)).body.authenticated, false); assert.equal((await info(next)).body.authenticated, true);
      assert.notEqual(next.cookies.grabenplaner_session, auth.cookies.grabenplaner_session);
      assert.notEqual(next.csrf, auth.csrf);
      assert.equal((await info(next)).body.user.employeeNumber, before.employeeNumber);
      assert.equal((await request(BASE + "/register/verify", { method: "POST", auth: next, body: proof })).status >= 400, true);
      return { auth: next, options: options.body };
    }
    async function assertion(fido, auth, operation, { zeroCounter = false } = {}) {
      const options = await request(operation ? BASE + "/reauthenticate/options" : "/api/portal/v1/auth/passkeys/options", {
        method: "POST", auth, body: operation ? { operation } : {},
      });
      assert.equal(options.status, 200, JSON.stringify(options.body));
      const response = await fido.page.evaluate(optionsJSON => SimpleWebAuthnBrowser.startAuthentication({ optionsJSON }), options.body.options);
      if (zeroCounter) {
        const virtual = (await fido.cdp.send("WebAuthn.getCredentials", { authenticatorId: fido.authenticatorId })).credentials[0];
        const privateKey = crypto.createPrivateKey({ key: Buffer.from(virtual.privateKey, "base64"), format: "der", type: "pkcs8" });
        const data = Buffer.from(response.response.authenticatorData, "base64url"); data.writeUInt32BE(0, 33);
        response.response.authenticatorData = data.toString("base64url");
        response.response.signature = crypto.sign("sha256", Buffer.concat([data,
          crypto.createHash("sha256").update(Buffer.from(response.response.clientDataJSON, "base64url")).digest()]), privateKey).toString("base64url");
      }
      return { proof: { challengeId: options.body.challengeId, response }, auth: credentials(options, auth) };
    }
    const verifyLogin = ({ proof, auth }) => request("/api/portal/v1/auth/passkeys/verify", { method: "POST", auth, body: proof });
    async function assertRotated(id, auth, before, result, status) {
      assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.changed, "1");
      const next = credentials(result, auth), after = await activeSession(id, next);
      assert(after); assert.notEqual(after.id, before.id); assert.notEqual(next.csrf, auth.csrf);
      assert.equal(after.authenticated_at, before.authenticated_at); assert.equal(after.absolute_expires_at, before.absolute_expires_at);
      assert(Date.parse(after.expires_at) <= Date.parse(before.absolute_expires_at));
      assert.equal((await info(auth)).body.authenticated, false); assert.equal((await info(next)).body.authenticated, true);
      return next;
    }
    async function exercise(activeFixture) {
      mark("fixture-ready");
      fixture = activeFixture;
      // This is fixture setup under its verified migrator identity, before the
      // real app initializes. Runtime request paths never execute schema DDL.
      await fixture.core.migrator.query("RESET ROLE; SET search_path=pg_catalog,gp");
      await require("../lib/persistence/postgresql/core/passkeys").migrate(fixture.core.migrator);
      mark("fixture-passkeys-ready");
      configuration.resolvePersistenceConfiguration = () => Object.freeze({ providerId: "postgresql", databasePath: path.join(temporaryRoot, "core.postgresql"),
        databaseUrlConfigured: true, coreUrl: process.env.GP_CORE_APP_URL, salesUrl: process.env.GP_SALES_APP_URL,
        readers: { coreUrl: process.env.GP_CORE_READER_URL, salesUrl: process.env.GP_SALES_READER_URL }, rehearsal: true, productActivation: false });
      mark("server-require-begin"); subject = require("../server"); mark("server-require-complete");
      await subject.initializeApplicationPersistence({ onProgress: phase => mark("server-initialize", phase) });
      mark("server-initialize-complete");
      await fixture.core.migrator.query("SET ROLE gp_core_owner; SET search_path=pg_catalog,gp");
      query = async (sql, values = []) => (await fixture.core.migrator.query(sql, values)).rows;
      server = await new Promise(resolve => { const listener = subject.app.listen(0, "127.0.0.1", () => resolve(listener)); });
      base = "http://127.0.0.1:" + server.address().port;
      mark("server-listening");
      const lockedBundle = fs.readFileSync(path.join(ROOT, "node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js"));
      const servedBundle = await request("/vendor/simplewebauthn-browser-v14/index.umd.min.js");
      assert.equal(servedBundle.status, 200, "the actual application must serve its locked WebAuthn browser bundle");
      assert.equal(servedBundle.body.bytes, lockedBundle.length); assert.equal(servedBundle.body.sha256, hash(lockedBundle));
      mark("locked-vendor-bundle-verified");
      const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
      browser = await chromium.launch({ headless: true, chromiumSandbox: process.platform === "linux" && process.env.GP_BROWSER_TEST_SANDBOX !== "0",
        ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
      mark("browser-ready");
      let adminAuth = await seed("syn-passkey-admin"), adminDevice = await device();
      await scenario("password confirmation uses atomic failure counting and never enrolls or rotates on failure", async () => {
        const before = await sessionRows("syn-passkey-admin");
        const results = await Promise.all([0, 1].map(() => request(BASE + "/register/options", { method: "POST", auth: adminAuth,
          body: { label: "Synthetic key", currentPassword: PASSWORD + "-wrong" } })));
        assert(results.every(result => result.status === 403 && result.changed === null && !result.cookies.length));
        assert.equal(Number((await query("SELECT failed_login_attempts n FROM gp.portal_users WHERE employee_number='syn-passkey-admin'"))[0].n), 2);
        assert.deepEqual(await sessionRows("syn-passkey-admin"), before);
        assert.equal(Number((await query("SELECT count(*) n FROM gp.passkey_credentials"))[0].n), 0); groupCount++;
      });
      await scenario("genuine registration rotates session and CSRF without extending the absolute deadline", async () => {
        const now = Date.now(), authenticatedAt = new Date(now - 7 * 3600000).toISOString(), absolute = new Date(now + 600000).toISOString();
        await query("UPDATE gp.portal_sessions SET authenticated_at=$1,absolute_expires_at=$2,expires_at=$2 WHERE employee_number='syn-passkey-admin'", [authenticatedAt, absolute]);
        const before = await activeSession("syn-passkey-admin", adminAuth), original = adminAuth;
        const registered = await enroll(adminAuth, adminDevice); adminAuth = registered.auth;
        const after = await activeSession("syn-passkey-admin", adminAuth);
        assert.equal(after.authenticated_at, before.authenticated_at); assert.equal(after.absolute_expires_at, absolute);
        assert.notEqual(after.id, before.id); assert.notEqual(adminAuth.csrf, original.csrf);
        assert.equal(Number((await query("SELECT failed_login_attempts n FROM gp.portal_users WHERE employee_number='syn-passkey-admin'"))[0].n), 0);
        const listed = await request(BASE + "/credentials", { auth: adminAuth }); assert.equal(listed.status, 200);
        assert.equal(listed.body.credentials.length, 1);
        for (const key of ["credentialId", "publicKey", "userHandle", "authorityHash"]) assert(!Object.hasOwn(listed.body.credentials[0], key)); groupCount++;
      });
      await scenario("discoverable login accepts a stale prior session cookie, creates fresh credentials, and burns replay", async () => {
        const stale = adminAuth;
        assert.equal((await request("/api/portal/v1/auth/logout", { method: "POST", auth: stale, body: {} })).status, 200);
        const attempt = await assertion(adminDevice, stale), result = await verifyLogin(attempt);
        assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.user.employeeNumber, "syn-passkey-admin");
        assert.equal(result.changed, "1"); adminAuth = credentials(result, attempt.auth);
        assert.equal((await info(stale)).body.authenticated, false); assert.equal((await info(adminAuth)).body.authenticated, true);
        const replay = await verifyLogin(attempt); assert(replay.status >= 400); assert.equal(replay.changed, null); groupCount++;
      });
      await scenario("account lock, inactive status and password-transition policy cannot be bypassed by a real passkey", async () => {
        for (const [table, key, patch] of [["portal_users", "employee_number", "locked_until='2999-01-01T00:00:00.000Z'"],
          ["portal_users", "employee_number", "active=0"], ["employees", "personnel_number", "active=0"],
          ["portal_users", "employee_number", "must_change_password=1"], ["portal_users", "employee_number", "password_policy_version=0"]]) {
          const attempt = await assertion(adminDevice), sessions = await sessionRows("syn-passkey-admin");
          await query(`UPDATE gp.${table} SET ${patch} WHERE ${key}='syn-passkey-admin'`);
          try { const result = await verifyLogin(attempt); assert(result.status >= 400, patch); assert.equal(result.changed, null); assert(!result.cookies.length); }
          finally {
            await query("UPDATE gp.employees SET active=1 WHERE personnel_number='syn-passkey-admin'");
            await query("UPDATE gp.portal_users SET active=1,must_change_password=0,password_policy_version=1,locked_until=NULL WHERE employee_number='syn-passkey-admin'");
          }
          assert.deepEqual(await sessionRows("syn-passkey-admin"), sessions);
        } groupCount++;
      });
      await scenario("organization and employee principals with the same identifier remain separate and organization self-enrollment is refused", async () => {
        const id = crypto.randomUUID(), personalAuth = await seed(id, "employee"), employeeDevice = await device(), organizationDevice = await device();
        const personal = await enroll(personalAuth, employeeDevice), location = (await query("SELECT id FROM gp.locations ORDER BY id LIMIT 1"))[0].id;
        await query("INSERT INTO gp.portal_organization_accounts(id,login_name,display_name,account_type,password_hash,active,must_change_password,password_policy_version) VALUES($1,'syn-passkey-branch','Synthetic branch','branch',$2,1,0,1)", [id, passwordHash(PASSWORD)]);
        await query("INSERT INTO gp.portal_organization_account_scopes(account_id,location_id) VALUES($1,$2)", [id, location]);
        const managed = await enroll(adminAuth, organizationDevice, { accountId: id }); adminAuth = managed.auth;
        const identities = await query("SELECT id,principal_kind,user_handle FROM gp.passkey_subjects WHERE principal_id=$1 ORDER BY principal_kind", [id]);
        assert.equal(identities.length, 2); assert.notEqual(identities[0].id, identities[1].id); assert(!identities[0].user_handle.equals(identities[1].user_handle));
        const denied = await request(BASE + "/credentials?accountId=" + id, { auth: personal.auth }); assert.equal(denied.status, 403);
        const orgAttempt = await assertion(organizationDevice), logged = await verifyLogin(orgAttempt);
        assert.equal(logged.status, 200, JSON.stringify(logged.body)); assert.equal(logged.body.user.sessionKind, "organization");
        assert.equal(logged.body.user.accountId, id); assert.equal(logged.body.user.isEmployee, false);
        const orgAuth = credentials(logged, orgAttempt.auth);
        const self = await request(BASE + "/register/options", { method: "POST", auth: orgAuth, body: { label: "Disallowed", currentPassword: PASSWORD } });
        assert.equal(self.status, 401); assert.equal(self.changed, null);
        const personalLogin = await verifyLogin(await assertion(employeeDevice, orgAuth)); assert.equal(personalLogin.status, 200);
        assert.equal(personalLogin.body.user.sessionKind, "employee"); assert.equal(personalLogin.body.user.employeeNumber, id);
        assert.equal((await info(orgAuth)).body.authenticated, false, "cross-account login revokes the invoking organizational predecessor");
        assert((await query("SELECT revoked_at FROM gp.portal_organization_sessions WHERE account_id=$1", [id])).every(row => row.revoked_at)); groupCount++;
      });
      await scenario("all four protected operating callers consume operation-bound real assertions and preserve the authentication deadline", async () => {
        const callers = [
          ["offsite-folder-create", "/api/backup/offsite-folders", "POST", { confirmation: "CREATE_MANAGED_OFFSITE_FOLDER", folderLabel: "SyntheticFolder" }, 201, "create"],
          ["offsite-folder-activate", "/api/backup/offsite-folders/active", "PUT", { confirmation: "ACTIVATE_MANAGED_OFFSITE_FOLDER", folderLabel: "SyntheticFolder" }, 200, "activate"],
          ["database-download", "/api/backup/database-download", "POST", { confirmation: "DATABASE_BACKUP_DOWNLOAD" }, 200, "export"],
          ["vps-reboot", "/api/portal/v1/server-monitor/vps-reboot", "POST", { confirmation: "VPS_REBOOT" }, 202, "reboot"],
        ];
        for (const [operation, route, method, body, status, effect] of callers) {
          const before = await activeSession("syn-passkey-admin", adminAuth), attempt = await assertion(adminDevice, adminAuth, operation), count = effects[effect];
          if (operation === "vps-reboot") Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
          try {
            const result = await request(route, { method, auth: adminAuth, body: { ...body, passkey: attempt.proof } });
            adminAuth = await assertRotated("syn-passkey-admin", adminAuth, before, result, status); assert.equal(effects[effect], count + 1);
          } finally { Object.defineProperty(process, "platform", platformDescriptor); }
        } groupCount++;
      });
      await scenario("an assertion for another operation, wrong CSRF or an expired absolute session never dispatches the action", async () => {
        const before = await sessionRows("syn-passkey-admin"), effectsBefore = { ...effects };
        const foreign = await assertion(adminDevice, adminAuth, "database-download");
        const rejected = await request("/api/backup/offsite-folders", { method: "POST", auth: adminAuth,
          body: { confirmation: "CREATE_MANAGED_OFFSITE_FOLDER", folderLabel: "SyntheticFolder", passkey: foreign.proof } });
        assert(rejected.status >= 400); assert.equal(rejected.changed, null);
        const badCsrf = await assertion(adminDevice, adminAuth, "database-download");
        assert.equal((await request("/api/backup/database-download", { method: "POST", auth: adminAuth, csrf: "wrong",
          body: { confirmation: "DATABASE_BACKUP_DOWNLOAD", passkey: badCsrf.proof } })).status, 403);
        const expired = await assertion(adminDevice, adminAuth, "database-download"), active = await activeSession("syn-passkey-admin", adminAuth);
        await query("UPDATE gp.portal_sessions SET absolute_expires_at=$1 WHERE id=$2", [new Date(Date.now() - 1000).toISOString(), active.id]);
        try {
          const response = await request("/api/backup/database-download", { method: "POST", auth: adminAuth,
            body: { confirmation: "DATABASE_BACKUP_DOWNLOAD", passkey: expired.proof } });
          assert(response.status >= 400); assert.equal(response.changed, null);
        } finally { await query("UPDATE gp.portal_sessions SET absolute_expires_at=$1 WHERE id=$2", [active.absolute_expires_at, active.id]); }
        assert.deepEqual(effects, effectsBefore); assert.deepEqual(await sessionRows("syn-passkey-admin"), before); groupCount++;
      });
      await scenario("two genuine simultaneous counterless assertions have exactly one credential/session/audit winner", async () => {
        const id = "syn-passkey-parallel", fido = await device();
        const registered = await enroll(await seed(id, "employee"), fido, { counterless: true });
        const before = (await query("SELECT c.id,c.revision,c.counter FROM gp.passkey_credentials c JOIN gp.passkey_subjects s ON s.id=c.subject_id WHERE s.employee_number=$1", [id]))[0];
        assert.equal(Number(before.counter), 0);
        const first = await assertion(fido, undefined, undefined, { zeroCounter: true });
        const second = await assertion(fido, first.auth, undefined, { zeroCounter: true });
        const barrier = signatureBarrier(), pending = [verifyLogin(first), verifyLogin(second)];
        try {
          await barrier.pending; barrier.release(); const results = await Promise.all(pending);
          assert.equal(results.filter(result => result.status === 200).length, 1, JSON.stringify(results.map(result => ({ status: result.status, body: result.body }))));
          assert(results.filter(result => result.status >= 400).every(result => !result.cookies.length && result.changed === null));
        } finally { barrier.release(); await Promise.allSettled(pending); }
        const after = (await query("SELECT revision,counter FROM gp.passkey_credentials WHERE id=$1", [before.id]))[0];
        assert.equal(Number(after.revision), Number(before.revision) + 1); assert.equal(Number(after.counter), 0);
        assert.equal(Number((await query("SELECT count(*) n FROM gp.portal_sessions WHERE employee_number=$1 AND revoked_at IS NULL", [id]))[0].n), 1);
        assert.equal(Number((await query("SELECT count(*) n FROM gp.audit_log WHERE actor=$1 AND action='passkey.login.accepted'", [id]))[0].n), 1);
        assert.equal((await info(registered.auth)).body.authenticated, false); groupCount++;
      });
      await scenario("passkey-confirmed password change rotates without extending age and preserves the enrolled key", async () => {
        const before = await activeSession("syn-passkey-admin", adminAuth), attempt = await assertion(adminDevice, adminAuth, "password-change");
        const changed = await request("/api/portal/v1/me/password", { method: "PUT", auth: adminAuth, body: { newPassword: NEW_PASSWORD, passkey: attempt.proof } });
        adminAuth = await assertRotated("syn-passkey-admin", adminAuth, before, changed, 200);
        const logged = await verifyLogin(await assertion(adminDevice)); assert.equal(logged.status, 200, JSON.stringify(logged.body));
        adminAuth = credentials(logged); groupCount++;
      });
      await scenario("explicit management revocation is revision-bound and rotates only after its committed native update", async () => {
        const id = "syn-passkey-revoke-target", fido = await device(), enrolled = await enroll(await seed(id, "employee"), fido);
        const listed = await request(BASE + "/credentials", { auth: enrolled.auth });
        assert.equal(listed.status, 200); const key = listed.body.credentials[0], before = await activeSession(id, enrolled.auth);
        const route = `${BASE}/credentials/${key.id}/revoke`;
        const stale = await request(route, { method: "POST", auth: enrolled.auth,
          body: { revision: key.revision + 1, currentPassword: PASSWORD } });
        assert.equal(stale.status, 409); assert.equal(stale.changed, null); assert(!stale.cookies.length);
        const revoked = await request(route, { method: "POST", auth: enrolled.auth,
          body: { revision: key.revision, currentPassword: PASSWORD } });
        const next = await assertRotated(id, enrolled.auth, before, revoked, 200);
        assert.equal((await request(BASE + "/credentials", { auth: next })).body.credentials.length, 0);
        const row = (await query("SELECT revision,revoked_at FROM gp.passkey_credentials WHERE id=$1", [key.id]))[0];
        assert(row.revoked_at); assert.equal(Number(row.revision), key.revision + 1);
        const denied = await verifyLogin(await assertion(fido)); assert(denied.status >= 400); assert.equal(denied.changed, null); groupCount++;
      });
      await scenario("administrative password reset revokes every target key, epoch and pending bound challenge", async () => {
        const id = "syn-passkey-reset-target", fido = await device(), enrolled = await enroll(await seed(id, "employee"), fido);
        const pending = await assertion(fido, enrolled.auth, "password-change");
        const before = (await query("SELECT id,auth_revision FROM gp.passkey_subjects WHERE employee_number=$1", [id]))[0];
        const reset = await request("/api/portal/v1/users/" + id, { method: "PUT", auth: adminAuth,
          body: { role: "employee", password: NEW_PASSWORD, active: true, mustChangePassword: false } });
        assert.equal(reset.status, 200, JSON.stringify(reset.body));
        const after = (await query("SELECT auth_revision FROM gp.passkey_subjects WHERE id=$1", [before.id]))[0]; assert.equal(Number(after.auth_revision), Number(before.auth_revision) + 1);
        assert((await query("SELECT revoked_at FROM gp.passkey_credentials WHERE subject_id=$1", [before.id])).every(row => row.revoked_at));
        assert((await query("SELECT consumed_at FROM gp.passkey_challenges WHERE id=$1", [pending.proof.challengeId]))[0].consumed_at);
        const rejected = await verifyLogin(await assertion(fido)); assert(rejected.status >= 400); assert.equal(rejected.changed, null);
        assert.equal((await info(enrolled.auth)).body.authenticated, false); assert.equal((await info(await loginPassword(id, NEW_PASSWORD))).body.authenticated, true); groupCount++;
      });
      assert.equal(groupCount, 11); assert.deepEqual(adminDevice.errors, []);
      mark("eleven-groups-verified");
      console.log("PASSKEY_APPLICATION_HTTP_VERIFIED " + JSON.stringify({ syntheticOnly: true, provider: "postgresql", groups: groupCount,
        realBrowserFido: true, operatingEffectsStubbed: true, noProductiveOperation: true }));
    }
    try {
      mark("fixture-setup-begin");
      await require("../test-support/postgresql-migration/report-fixture").withReportFixture(async activeFixture => {
        try { await exercise(activeFixture); }
        finally {
          mark("exercise-cleanup-begin");
          if (verifyGate) { verifyGate.release(); verifyGate = undefined; }
          await browser?.close(); browser = null; mark("browser-closed");
          if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); server = null; mark("http-server-closed");
          await subject?.closePersistenceForTests(); subject?.releaseInstanceLockForTests(); subject = null; mark("application-persistence-closed");
          if (query && challengeIds.size) await query("DELETE FROM gp.passkey_challenges WHERE id=ANY($1::text[])", [[...challengeIds]]);
          mark("exercise-cleanup-complete");
        }
      }, { warmWorkers: false });
      mark("fixture-cleanup-complete");
    } finally {
      mark("outer-cleanup-begin");
      subtle.verify = originalVerify; Object.defineProperty(process, "platform", platformDescriptor);
      await browser?.close();
      if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await subject?.closePersistenceForTests(); subject?.releaseInstanceLockForTests();
      configuration.resolvePersistenceConfiguration = originalConfiguration; for (const restore of restorers.reverse()) restore();
      const resolved = fs.realpathSync(temporaryRoot);
      assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert(path.basename(resolved).startsWith("gp-passkey-http-"));
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      mark("outer-cleanup-complete");
    }
  });
}

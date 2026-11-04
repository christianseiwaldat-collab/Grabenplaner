"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { functionSource } = require("../test-support/learning-workspace-ui");
const Draft = require("../public/sales-price-label-working-draft");
const Labels = require("../public/sales-price-labels");

const read = name => fs.readFileSync(path.join(__dirname, "../public", name), "utf8").replace(/\r\n/g, "\n");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const snapshot = () => ({
  schemaVersion: 1, draftId: crypto.randomUUID(), articleNumbers: "107506", priceType: "sales",
  options: Labels.normalizeOptions({}), filenameOptions: { stamp: "none", position: "before", separator: "-", suffix: "" },
  name: "Synthetischer Entwurf", library: { mode: "new", templateId: "", templateVersion: null, title: "Test", visibility: "private", recipients: [] },
  selectedArticleNumber: "107506", paperPage: 0, rawSettings: { labelWidthMm: "" },
});
const response = (data, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => data });

// Execute the actual public functions with only their UI and HTTP edges stubbed.
function runtime(kind, fetchImplementation = async () => response({})) {
  const calls = { auth: 0, logout: 0, messages: [], requests: [] };
  const lock = { active: false, queue: Promise.resolve() };
  const initialSession = { authenticated: true, user: { employeeNumber: "synthetic-a", role: "employee" } };
  const button = { disabled: false, setAttribute() {}, removeAttribute() {} };
  const context = {
    URL, AbortController, AbortSignal, FormData, setTimeout, clearTimeout,
    document: { cookie: "grabenplaner_csrf=synthetic-a" },
    location: { href: "https://synthetic.invalid/", hostname: "synthetic.invalid", reload: () => { calls.logout++; } },
    navigator: { locks: { request: (_name, _options, callback) => {
      const request = lock.queue.then(async () => {
        lock.active = true;
        try { return await callback(); } finally { lock.active = false; }
      });
      lock.queue = request.catch(() => {});
      return request;
    } } },
    state: { portalSession: initialSession }, portalState: { session: initialSession, processTasksOwnerFingerprint: "synthetic-a" },
    elements: {}, el: { logoutButton: button, portalLogoutStatus: {}, loginPassword: { value: "synthetic" }, loginPersonnelNumber: { focus() {} } },
    salesPriceLabelsWorkspace: null, branchPriceLabelsWorkspace: null, sidebarNotepad: null,
    privatePortalWorkspaces: { synchronize() {} }, portalVoiceAssistant: { reset() {} },
    showToast: message => calls.messages.push(message),
    message: (_node, message) => { if (message) calls.messages.push(message); },
    showLogin: () => { calls.logout++; },
    syncPortalWindows() {}, stopBranchOrderAutosave() {}, clearProcessTaskState() {}, clearRememberedPortalTab() {},
    neutralizeBirthdayPresentationTheme() {}, refreshBirthdayPresentationTheme() {},
    clearEmployeeOnboardingStartState() {}, clearPersonnelLifecycleInterfacesState() {},
    clearPersonnelLifecycleAutomationState() {}, clearPersonnelLifecycleEditorState() {},
    fetch: async (url, options) => {
      calls.requests.push({ url, options, lockHeld: lock.active });
      if (url.endsWith("/auth/logout")) { calls.auth++; return response({}); }
      return fetchImplementation(url, options);
    },
  };
  context.window = context;
  context.portalUser = () => context.portalState.session?.user;
  vm.createContext(context);
  vm.runInContext(read("session-lifecycle.js"), context);
  if (kind === "admin") {
    vm.runInContext(`${functionSource("api")}\nlet adminLogoutInProgress = null;\n${functionSource("logoutPortal")}\nthis.runLogout = logoutPortal;`, context);
  } else {
    vm.runInContext(`${functionSource("csrf", "portal.js")}\n${functionSource("api", "portal.js")}\n${functionSource("processTaskActorFingerprint", "portal.js")}\nlet logoutInProgress = null;\n${functionSource("syncPortalLogoutControls", "portal.js")}\n${functionSource("logout", "portal.js")}\nthis.runLogout = logout;`, context);
  }
  return { context, calls, lock, button, initialSession, lifecycle: context.GrabenplanerSessionLifecycle,
    api: context.api, logout: context.runLogout,
    session: () => kind === "admin" ? context.state.portalSession : context.portalState.session,
    replaceSession(session) { context.state.portalSession = session; context.portalState.session = session; },
    attach(workspace) { context.salesPriceLabelsWorkspace = workspace; context.branchPriceLabelsWorkspace = workspace; },
  };
}

// Isolate just the actual public workspace flush/getter, retaining its real
// DraftStore retry/revision implementation instead of reconstructing it here.
function workspace(store, { recordDraft = () => {}, imageUploading = false, timer = setTimeout, clearTimer = clearTimeout, actor = () => "synthetic-a" } = {}) {
  const source = read("sales-price-labels.js"), start = source.indexOf("      async flush(){");
  const end = source.indexOf("      syncPrint()", start);
  assert.ok(start >= 0 && end > start, "Actual workspace flush/getter boundaries exist");
  return vm.runInNewContext(`({${source.slice(start, end)}})`, {
    draftStore: store, recordDraft, imageUploading, setTimeout: timer, clearTimeout: clearTimer,
    owner: actor(), accessKey: actor, workingDraftId: crypto.randomUUID(), destroyed: false,
  });
}

async function storeFor(t, app) {
  const store = Draft.createStore({ api: app.api, key: () => app.session()?.user?.employeeNumber || "", normalizeOptions: Labels.normalizeOptions, delay: 100000 });
  t.after(() => store.invalidate());
  assert.equal(await store.activate(), true);
  return store;
}

test("both logouts preserve the actual in-flight API generation until autosave acknowledges", async t => {
  for (const kind of ["admin", "portal"]) await t.test(kind, async t => {
    const writing = deferred(), entered = deferred();
    const app = runtime(kind, async (_url, options) => {
      if (options.method !== "PUT") return response({ revision: 0, draft: null });
      entered.resolve(); await writing.promise;
      return response({ revision: 1, draft: JSON.parse(options.body).draft });
    });
    const store = await storeFor(t, app);
    store.change(snapshot());
    const autosave = store.flush(); await entered.promise;
    let preparedUnderLock = false;
    app.attach(workspace(store, { recordDraft: () => { preparedUnderLock = app.lock.active; } }));
    const loggingOut = app.logout(); await tick();
    const whileSaving = { generation: app.lifecycle.generation, auth: app.calls.auth, lockHeld: app.lock.active };
    writing.resolve();
    const acknowledged = await autosave; await loggingOut;
    assert.deepEqual(whileSaving, { generation: 0, auth: 0, lockHeld: true });
    assert.equal(preparedUnderLock, true);
    assert.equal(acknowledged, true, "The real API accepts the old save response before the credential generation changes");
    assert.equal(store.error, null); assert.equal(store.hasUnsaved, false);
    assert.equal(app.calls.auth, 1); assert.equal(app.calls.logout, 1);
    assert.equal(app.calls.requests.find(row => row.url.endsWith("/auth/logout")).lockHeld, true);
  });
});

test("preparation cancellation and failure leave the generation unchanged and release the shared lock", async t => {
  for (const behavior of ["cancel", "throw"]) await t.test(behavior, async () => {
    const app = runtime("admin"), waiting = deferred(); let operations = 0, prepared = false, nextEntered = false;
    const first = app.lifecycle.credentials(() => { operations++; }, { prepare: async () => {
      prepared = app.lock.active; await waiting.promise;
      if (behavior === "throw") throw Object.assign(new Error("synthetic save failure"), { code: "SYNTHETIC_DRAFT_FAILURE" });
      return false;
    } });
    const outcome = first.then(value => ({ value }), error => ({ error }));
    await tick();
    const second = app.lifecycle.credentials(() => { operations++; }, { prepare: () => { nextEntered = true; return false; } });
    await tick(); const blocked = !nextEntered;
    waiting.resolve(); const result = await outcome; await second;
    assert.equal(prepared, true); assert.equal(blocked, true);
    assert.equal(operations, 0); assert.equal(app.lifecycle.generation, 0); assert.equal(app.lock.active, false);
    if (behavior === "throw") assert.equal(result.error?.code, "SYNTHETIC_DRAFT_FAILURE");
    else assert.equal(result.value, false);
  });
});

test("cookie, generation or account replacement during preparation cannot log out the new session", async t => {
  for (const kind of ["admin", "portal"]) for (const change of ["cookie", "generation", "account"]) await t.test(`${kind}: ${change}`, async () => {
    const app = runtime(kind), waiting = deferred();
    const pending = { hasUnsaved: true, async flush() { await waiting.promise; this.hasUnsaved = false; } };
    app.attach(pending); const loggingOut = app.logout(); await tick();
    if (change === "cookie") app.context.document.cookie = "grabenplaner_csrf=synthetic-b";
    if (change === "generation") app.lifecycle.advance();
    if (change === "account") app.replaceSession({ authenticated: true, user: { employeeNumber: "synthetic-b" } });
    waiting.resolve(); await loggingOut;
    assert.equal(app.calls.auth, 0); assert.equal(app.calls.logout, 0);
    assert.equal(app.lifecycle.generation, change === "generation" ? 1 : 0);
    assert.equal(app.session().user.employeeNumber, change === "account" ? "synthetic-b" : "synthetic-a");
  });
});

test("logout reconciles an actual lost draft acknowledgement and preserves later edits", async t => {
  for (const kind of ["admin", "portal"]) await t.test(kind, async t => {
    let server = { revision: 0, draft: null, lastMutationId: null }, lose = true;
    const puts = [];
    const app = runtime(kind, async (_url, options) => {
      if (options.method !== "PUT") return response(server);
      const body = JSON.parse(options.body); puts.push(body);
      server = { revision: server.revision + 1, draft: body.draft, lastMutationId: body.mutationId };
      if (lose) { lose = false; throw new Error("Synthetic lost acknowledgement"); }
      return response(server);
    });
    const store = await storeFor(t, app), first = snapshot(); store.change(first);
    assert.equal(await store.flush(), false);
    store.change({ ...first, name: "Spätere Eingabe" });
    app.attach(workspace(store)); await app.logout();
    assert.equal(app.calls.auth, 1); assert.equal(app.calls.logout, 1);
    assert.deepEqual(puts.map(row => row.revision), [0, 1]);
    assert.equal(server.revision, 2); assert.equal(server.draft.name, "Spätere Eingabe");
    assert.equal(store.hasUnsaved, false);
  });
});

test("persistent save errors, conflicting revisions and pending images preserve the account and draft", async t => {
  for (const kind of ["admin", "portal"]) for (const failure of ["network", "conflict", "upload"]) await t.test(`${kind}: ${failure}`, async t => {
    let server = { revision: 0, draft: null }, puts = 0, reads = 0;
    const app = runtime(kind, async (_url, options) => {
      if (options.method !== "PUT") { reads++; return response(server); }
      puts++;
      return failure === "network" ? Promise.reject(new Error("Synthetic offline")) : response({ error: "Synthetic conflict" }, 409);
    });
    const store = await storeFor(t, app), draft = snapshot();
    if (failure !== "upload") store.change(draft);
    if (failure === "conflict") server = { revision: 1, draft: { ...draft, name: "Anderes Fenster" } };
    const editor = workspace(store, { imageUploading: failure === "upload" }); app.attach(editor);
    await app.logout();
    assert.equal(app.calls.auth, 0); assert.equal(app.calls.logout, 0); assert.equal(app.session(), app.initialSession);
    assert.equal(app.lifecycle.generation, 0); assert.equal(editor.hasUnsaved, true);
    assert.equal(app.calls.messages.length, 1);
    assert.match(app.calls.messages[0], failure === "upload" ? /bild/i : /Entwurf|entwurf/);
    assert.equal(puts, failure === "network" ? 2 : failure === "conflict" ? 1 : 0, "Exactly one retry; no conflicting overwrite");
    assert.equal(reads, failure === "upload" ? 1 : 2);
    if (failure !== "upload") assert.deepEqual(store.value, draft);
    if (failure === "conflict") { assert.equal(store.status, "conflict"); assert.equal(server.draft.name, "Anderes Fenster"); }
  });
});

test("a preparation deadline releases logout without aborting a save that can finish later", async t => {
  for (const kind of ["admin", "portal"]) await t.test(kind, async t => {
    const writing = deferred(); let signal, timeout, cleared = 0;
    const app = runtime(kind, async (_url, options) => {
      if (options.method !== "PUT") return response({ revision: 0, draft: null });
      signal = options.signal; await writing.promise;
      return response({ revision: 1, draft: JSON.parse(options.body).draft });
    });
    const store = await storeFor(t, app); store.change(snapshot());
    app.attach(workspace(store, { timer(callback, delay) { assert.equal(delay, 15000); timeout = callback; return 1; }, clearTimer() { cleared++; } }));
    const loggingOut = app.logout(); await tick();
    // Release the pending HTTP fixture even when evaluating an older source.
    if (!timeout) writing.resolve(); else timeout();
    await loggingOut;
    const afterDeadline = { auth: app.calls.auth, generation: app.lifecycle.generation, dirty: store.hasUnsaved, aborted: signal?.aborted, locked: app.lock.active };
    writing.resolve(); await store.flush();
    assert.equal(typeof timeout, "function");
    assert.deepEqual(afterDeadline, { auth: 0, generation: 0, dirty: true, aborted: false, locked: false });
    assert.equal(cleared, 1); assert.equal(store.hasUnsaved, false);
    assert.equal(app.session(), app.initialSession);
    await app.logout(); assert.equal(app.calls.auth, 1); assert.equal(app.calls.logout, 1);
  });
});

test("an old actor's late autosave acknowledgement cannot enter the replacement actor's draft", async t => {
  for (const kind of ["admin", "portal"]) await t.test(kind, async t => {
    const writing = deferred();
    const app = runtime(kind, async (_url, options) => {
      if (options.method !== "PUT") return response({ revision: 0, draft: null });
      await writing.promise; return response({ revision: 1, draft: JSON.parse(options.body).draft });
    });
    const store = await storeFor(t, app); store.change(snapshot()); const saving = store.flush();
    app.attach(workspace(store, { actor: () => app.session()?.user?.employeeNumber || "" })); const loggingOut = app.logout(); await tick();
    const replacement = { authenticated: true, user: { employeeNumber: "synthetic-b" } };
    app.replaceSession(replacement); store.invalidate(); writing.resolve();
    assert.equal(await saving, false); await loggingOut;
    assert.equal(app.calls.auth, 0); assert.equal(app.calls.logout, 0); assert.equal(app.session(), replacement);
    assert.equal(store.value, null); assert.equal(store.ready, false);
  });
});

test("an expired logout preparation cannot retry a PUT that fails after the lock was released", async t => {
  for (const kind of ["admin", "portal"]) await t.test(kind, async t => {
    const writing = deferred(); let timeout, reads = 0, puts = 0;
    const app = runtime(kind, async (_url, options) => {
      if (options.method !== "PUT") { reads++; return response({ revision: 0, draft: null }); }
      puts++; await writing.promise; throw new Error("Synthetic late write failure");
    });
    const store = await storeFor(t, app), draft = snapshot(); store.change(draft);
    const autosave = store.flush();
    app.attach(workspace(store, { timer(callback) { timeout = callback; return 1; }, clearTimer() {} }));
    const loggingOut = app.logout(); await tick(); timeout(); await loggingOut;
    assert.equal(app.lock.active, false); assert.equal(app.calls.auth, 0);
    writing.resolve(); assert.equal(await autosave, false); await tick();
    assert.equal(reads, 1, "Expired preparation must not issue a reconciliation GET after the late failure");
    assert.equal(puts, 1); assert.equal(store.hasUnsaved, true); assert.deepEqual(store.value, draft);
    assert.equal(app.calls.auth, 0); assert.equal(app.lifecycle.generation, 0);
    assert.equal(app.session(), app.initialSession);
  });
});

test("a retry GET finishing after the preparation deadline cannot start a later PUT", async t => {
  for (const kind of ["admin", "portal"]) await t.test(kind, async t => {
    const reading = deferred(); let timeout, reads = 0, puts = 0;
    let server = { revision: 0, draft: null, lastMutationId: null };
    const app = runtime(kind, async (_url, options) => {
      if (options.method !== "PUT") {
        reads++; const observed = server;
        if (reads === 2) await reading.promise;
        return response(observed);
      }
      puts++; const body = JSON.parse(options.body);
      server = { revision: server.revision + 1, draft: body.draft, lastMutationId: body.mutationId };
      if (puts === 1) throw new Error("Synthetic lost acknowledgement");
      return response(server);
    });
    const store = await storeFor(t, app), first = snapshot(); store.change(first);
    assert.equal(await store.flush(), false);
    const later = { ...first, name: "Noch nicht bestätigte spätere Eingabe" }; store.change(later);
    app.attach(workspace(store, { timer(callback) { timeout = callback; return 1; }, clearTimer() {} }));
    const loggingOut = app.logout(); await tick(); assert.equal(reads, 2);
    timeout(); await loggingOut; assert.equal(app.lock.active, false);
    reading.resolve(); await tick();
    assert.equal(puts, 1, "The already-started retry GET cannot continue with a PUT outside the credential lock");
    assert.equal(reads, 2); assert.equal(store.hasUnsaved, true); assert.deepEqual(store.value, later);
    assert.equal(server.draft.name, first.name); assert.equal(app.calls.auth, 0); assert.equal(app.lifecycle.generation, 0);
    await app.logout();
    assert.equal(puts, 2); assert.equal(server.revision, 2); assert.equal(server.draft.name, later.name);
    assert.equal(app.calls.auth, 1); assert.equal(app.calls.logout, 1);
  });
});

test("a joined autosave accepts its late ACK but retains later edits until a fresh explicit logout", async t => {
  for (const kind of ["admin", "portal"]) await t.test(kind, async t => {
    const writing = deferred(); let timeout, reads = 0;
    let server = { revision: 0, draft: null, lastMutationId: null }; const puts = [];
    const app = runtime(kind, async (_url, options) => {
      if (options.method !== "PUT") { reads++; return response(server); }
      const body = JSON.parse(options.body); puts.push(body);
      if (puts.length === 1) await writing.promise;
      server = { revision: server.revision + 1, draft: body.draft, lastMutationId: body.mutationId };
      return response(server);
    });
    const store = await storeFor(t, app), first = snapshot(); store.change(first);
    const autosave = store.flush();
    const later = { ...first, name: "Eingabe während laufendem Autosave" }; store.change(later);
    app.attach(workspace(store, { timer(callback) { timeout = callback; return 1; }, clearTimer() {} }));
    const loggingOut = app.logout(); await tick(); timeout(); await loggingOut;
    assert.equal(app.lock.active, false); writing.resolve(); const completed = await autosave; await tick();
    assert.equal(puts.length, 1, "Joining the existing write must constrain its next loop iteration too");
    assert.equal(completed, false); assert.equal(reads, 1);
    assert.equal(store.revision, 1); assert.equal(store.error, null); assert.equal(store.hasUnsaved, true);
    assert.deepEqual(store.value, later); assert.equal(server.draft.name, first.name);
    assert.equal(app.calls.auth, 0); assert.equal(app.lifecycle.generation, 0);
    await app.logout();
    assert.deepEqual(puts.map(row => row.revision), [0, 1]);
    assert.equal(server.draft.name, later.name); assert.equal(store.hasUnsaved, false);
    assert.equal(app.calls.auth, 1); assert.equal(app.calls.logout, 1);
    assert.equal(app.calls.requests.filter(row => row.options.method === "PUT")[1].lockHeld, true);
  });
});

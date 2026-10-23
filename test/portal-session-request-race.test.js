"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { functionSource } = require("../test-support/learning-workspace-ui");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const session = () => ({ authenticated: true, user: { employeeNumber: "BEISPIEL-1", role: "employee" } });
function apiFixture(fetch) {
  const state = { session: session() }, logins = [];
  const context = vm.createContext({ portalState: state, fetch, FormData: class {}, csrf: () => "",
    window: {}, location: { hostname: "127.0.0.1" },
    showLogin: text => { logins.push(text); state.session = null; },
  });
  vm.runInContext(functionSource("api", "portal.js"), context);
  return { state, logins, api: context.api };
}
test("Portal API: a delayed 401/error-body from the previous same-account session cannot log out its replacement", async () => {
  const detail = deferred(), response = deferred();
  const f = apiFixture(() => response.promise), old = f.state.session;
  const request = f.api("/api/portal/v1/me/process-tasks");
  response.resolve({ ok: false, status: 401, json: () => detail.promise });
  await new Promise(setImmediate);
  const replacement = session(); f.state.session = replacement;
  detail.resolve({ error: "BEISPIEL expired", code: "SESSION_EXPIRED" });
  await assert.rejects(request, error => error.code === "PORTAL_SESSION_CHANGED");
  assert.notEqual(old, replacement);
  assert.equal(f.state.session, replacement);
  assert.deepEqual(f.logins, []);
});
test("Portal API: a current 401 still clears its session and successful response modes remain intact", async () => {
  const f = apiFixture(async () => ({ ok: false, status: 401, json: async () => ({ error: "BEISPIEL expired" }) }));
  await assert.rejects(f.api("/api/portal/v1/me/process-tasks"), error => error.status === 401);
  assert.equal(f.state.session, null); assert.equal(f.logins.length, 1);
  const success = apiFixture(async () => ({ ok: true, status: 204 }));
  assert.equal(await success.api("/api/portal/v1/auth/logout", { method: "POST", body: "{}" }), null);
  assert.equal(success.logins.length, 0);
});
function logoutFixture({ flush = null } = {}) {
  const state = { session: session(), processTasksOwnerFingerprint: "BEISPIEL-1" };
  const reply = deferred(), replies = [reply, deferred()], calls = [], messages = [], effects = [];
  const attributes = new Map(), button = { textContent: "Abmelden", disabled: false,
    setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name) };
  const el = { logoutButton: button, portalLogoutStatus: {}, loginPassword: { value: "BEISPIEL" },
    loginPersonnelNumber: { focus: () => effects.push("focus") } };
  const workspace = flush ? { hasUnsaved: true, flush: () => flush.promise } : null;
  const context = vm.createContext({ portalState: state, el, AbortController, privatePortalWorkspaces: { synchronize: () => effects.push("privateSync") },
    portalVoiceAssistant: { reset: () => effects.push("voiceReset"), synchronize: () => effects.push("voiceSync") },
    window: { setTimeout: () => 1, clearTimeout: () => {}, GrabenplanerSessionLifecycle: { credentials: async (operation, {prepare} = {}) => {
      if (prepare && await prepare() === false) return false;
      return operation();
    }, advance() {}, publish() {} } }, branchPriceLabelsWorkspace: workspace,
    portalUser: () => state.session?.user, processTaskActorFingerprint: user => user?.employeeNumber || "",
    message: (_target, text, error) => messages.push({ text, error: Boolean(error) }),
    api: (url, options) => { calls.push({ url, options }); return replies[calls.length - 1].promise; },
    neutralizeBirthdayPresentationTheme: () => effects.push("neutralize"),
    refreshBirthdayPresentationTheme: () => effects.push("refresh"), syncPortalWindows: () => effects.push("sync"),
    stopBranchOrderAutosave: () => effects.push("stop"), clearProcessTaskState: () => effects.push("clearTasks"),
    clearRememberedPortalTab: () => effects.push("clearTab"),
    showLogin: () => { state.session = null; effects.push("login"); },
  });
  const showPortalSource = functionSource("showPortal", "portal.js");
  const initializer = showPortalSource.slice(0, showPortalSource.indexOf("  syncPortalWindows();")) + "\n}\n";
  const logoutControlsSource = require("node:fs").readFileSync(require.resolve("../public/portal.js"), "utf8").includes("function syncPortalLogoutControls(")
    ? functionSource("syncPortalLogoutControls", "portal.js") : "";
  Object.assign(context, { branchPriceLabelsOwner: () => "", timeOffOwnerKey: () => "", portalPersonalActionsActorKey: () => "BEISPIEL-1",
    birthdayPresentationActor: () => "", resetBranchSalesWorkspaces: () => {}, resetBranchTimeOffState: () => {},
    resetPersonalActionsState: () => {}, neutralizeBirthdayPresentation: () => {} });
  vm.runInContext("let logoutInProgress = null;\n" + logoutControlsSource + "\n" + functionSource("logout", "portal.js") + "\n" + initializer, context);
  function replaceSession() {
    const replacement = session(); state.session = replacement;
    button.textContent = "Neue Sitzung"; button.disabled = true; attributes.set("aria-busy", "new-owner");
    messages.length = 0; effects.length = 0;
    return replacement;
  }
  return { state, reply, replies, calls, messages, effects, button, attributes, logout: context.logout, showPortal: context.showPortal, replaceSession, workspace };
}
for (const reject of [false, true]) test("Portal logout: late " + (reject ? "error" : "success") + " preserves a replacement same-account session and its controls", async () => {
  const f = logoutFixture(), request = f.logout();
  await new Promise(setImmediate);
  assert.equal(f.calls.length, 1);
  const replacement = f.replaceSession();
  if (reject) f.reply.reject(new Error("BEISPIEL disconnected")); else f.reply.resolve(null);
  await request;
  assert.equal(f.state.session, replacement); assert.deepEqual(f.effects, []); assert.deepEqual(f.messages, []);
  assert.equal(f.button.textContent, "Neue Sitzung"); assert.equal(f.button.disabled, true);
  assert.equal(f.attributes.get("aria-busy"), "new-owner");
});
test("Portal logout: delayed draft flush from an old session cannot post logout or show its unsaved warning in a replacement session", async () => {
  const flush = deferred(), f = logoutFixture({ flush }), request = f.logout();
  const replacement = f.replaceSession(); flush.resolve(); await request;
  assert.equal(f.calls.length, 0); assert.equal(f.state.session, replacement);
  assert.deepEqual(f.messages, []); assert.deepEqual(f.effects, []);
  assert.equal(f.button.textContent, "Neue Sitzung"); assert.equal(f.attributes.get("aria-busy"), "new-owner");
});
test("Portal logout: current success clears tasks/tab and current failure keeps the session with useful retry controls", async () => {
  const success = logoutFixture(), successRequest = success.logout(); success.reply.resolve(); await successRequest;
  assert.equal(success.state.session, null);
  assert.deepEqual(success.effects, ["neutralize", "voiceReset", "privateSync", "sync", "stop", "clearTasks", "clearTab", "login", "focus"]);
  assert.equal(success.button.disabled, false); assert.equal(success.button.textContent, "Abmelden");
  const failure = logoutFixture(), actor = failure.state.session, failedRequest = failure.logout();
  failure.reply.reject(new Error("BEISPIEL disconnected")); await failedRequest;
  assert.equal(failure.state.session, actor); assert.match(failure.messages.at(-1).text, /nicht bestätigt.*BEISPIEL disconnected/);
  assert.deepEqual(failure.effects, ["neutralize", "refresh"]);
  assert.equal(failure.button.disabled, false); assert.equal(failure.attributes.has("aria-busy"), false);
});
test("Actual showPortal session initialization frees inherited logout controls; an older finally cannot clear a new pending logout", async () => {
  const f = logoutFixture(), oldRequest = f.logout();
  await new Promise(setImmediate);
  assert.equal(f.button.disabled, true);
  const replacement = session(); f.showPortal(replacement);
  assert.equal(f.state.session, replacement); assert.equal(f.button.disabled, false);
  assert.equal(f.attributes.has("aria-busy"), false); assert.equal(f.button.textContent, "Abmelden");
  const newRequest = f.logout(); await new Promise(setImmediate);
  assert.equal(f.calls.length, 2); assert.equal(f.button.disabled, true);
  f.reply.resolve(); await oldRequest;
  assert.equal(f.state.session, replacement); assert.equal(f.button.disabled, true);
  assert.equal(f.attributes.get("aria-busy"), "true"); assert.equal(f.button.textContent, "Abmelden…");
  await f.logout(); assert.equal(f.calls.length, 2);
  f.replies[1].resolve(); await newRequest;
  assert.equal(f.state.session, null); assert.equal(f.button.disabled, false);
});

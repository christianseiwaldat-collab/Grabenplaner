"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(projectRoot, "public", "portal.html"), "utf8");
const script = fs.readFileSync(path.join(projectRoot, "public", "portal.js"), "utf8");
const styles = fs.readFileSync(path.join(projectRoot, "public", "portal.css"), "utf8");

test("v0.92.5: mobiler Portal-Header nutzt vollständige Symbole und zugängliche Statusausgabe", () => {
  assert.match(html, /id="notificationsButton"[\s\S]*?d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/);
  assert.match(html, /id="portalSettingsShortcut"[^>]*aria-label="Einstellungen öffnen"/);
  assert.match(html, /id="portalLogoutStatus"[^>]*role="alert"/);
});

test("v0.92.5: schmale Header halten zwei 44-Pixel-Iconziele ohne Einstellungslabel", () => {
  const narrow = styles.match(/@media \(max-width:560px\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(narrow, /\.portal-brand \{ flex:1 1 auto; min-width:0; \}/);
  assert.match(narrow, /\.portal-user \{ flex:0 0 auto; gap:5px; flex-wrap:nowrap; \}/);
  assert.match(narrow, /\.notification-button,\.portal-settings-shortcut \{ flex:0 0 44px; width:44px; height:44px; min-height:44px; padding:0; \}/);
  assert.match(narrow, /\.portal-settings-shortcut-label \{ display:none; \}/);
  assert.match(narrow, /#logoutButton \{ white-space:nowrap; \}/);
});

test("v0.92.5: Logout ist doppelklickfest, begrenzt und wechselt nach Bestätigung direkt zum Login", () => {
  const logout = script.slice(script.indexOf("let logoutInProgress = false;"), script.indexOf("function setTab("));
  assert.match(logout, /if \(logoutInProgress\) return;/);
  assert.match(logout, /controller\.abort\(\), 15000/);
  assert.match(logout, /setAttribute\("aria-busy", "true"\)/);
  assert.match(logout, /keepalive: true,[\s\S]*?signal: controller\.signal/);
  assert.match(logout, /clearRememberedPortalTab\(\);[\s\S]*?showLogin\(\);/);
  assert.match(logout, /portalLogoutStatus[\s\S]*?nicht rechtzeitig bestätigt/);
  assert.doesNotMatch(logout, /location\.reload\(|location\.replace\(/);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function createLogoutRuntime(apiImplementation, timerImplementation = setTimeout, workspace = null) {
  const logoutSource = script.slice(script.indexOf("let logoutInProgress = false;"), script.indexOf("function setTab("));
  const actorStart = script.indexOf('function processTaskActorFingerprint(');
  const actorSource = script.slice(actorStart, script.indexOf('\n}', actorStart) + 2);
  const calls = { api: 0, clearTab: 0, showLogin: 0, processClear: 0, autosaveStop: 0, themeNeutralize: 0, themeRefresh: 0, windowSync: 0 };
  const status = {};
  const button = {
    textContent: "Abmelden",
    disabled: false,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
  };
  const context = {
    AbortController,
    branchPriceLabelsWorkspace: workspace,
    syncPortalWindows: () => { calls.windowSync += 1; },
    portalState: { session: { user: { employeeNumber: "252" } }, processTasksOwnerFingerprint: "252" },
    el: {
      logoutButton: button,
      portalLogoutStatus: status,
      loginPassword: { value: "secret" },
      loginPersonnelNumber: { focus() { this.focused = true; } },
    },
    window: { setTimeout: timerImplementation, clearTimeout },
    api: async (...args) => {
      calls.api += 1;
      return apiImplementation(...args);
    },
    message: (node, text, error = false) => Object.assign(node, { text, error }),
    portalUser: () => context.portalState.session?.user,
    stopBranchOrderAutosave: () => { calls.autosaveStop += 1; },
    clearProcessTaskState: () => { calls.processClear += 1; },
    clearRememberedPortalTab: () => { calls.clearTab += 1; },
    showLogin: () => { calls.showLogin += 1; },
    neutralizeBirthdayPresentationTheme: () => { calls.themeNeutralize += 1; },
    refreshBirthdayPresentationTheme: async () => { calls.themeRefresh += 1; },
  };
  vm.createContext(context);
  vm.runInContext(`${actorSource}\n${logoutSource}\nthis.runLogout = logout;`, context);
  return { context, calls, status, button };
}

test("v0.92.5: Logout zeigt sofort Fortschritt, ignoriert Doppelklick und rendert nach Erfolg Login", async () => {
  let finishRequest;
  const runtime = createLogoutRuntime(() => new Promise((resolve) => { finishRequest = resolve; }));
  const first = runtime.context.runLogout();
  const second = runtime.context.runLogout();

  assert.equal(runtime.button.disabled, true);
  assert.equal(runtime.button.attributes.get("aria-busy"), "true");
  assert.equal(runtime.button.textContent, "Abmelden…");
  await tick();
  assert.equal(runtime.calls.api, 1);

  finishRequest({ ok: true });
  await Promise.all([first, second]);

  assert.equal(runtime.calls.showLogin, 1);
  assert.equal(runtime.calls.clearTab, 1);
  assert.equal(runtime.calls.processClear, 1);
  assert.equal(runtime.calls.autosaveStop, 1);
  assert.equal(runtime.calls.themeNeutralize, 1);
  assert.equal(runtime.calls.themeRefresh, 0);
  assert.equal(runtime.calls.windowSync, 1);
  assert.equal(runtime.context.portalState.session, null);
  assert.equal(runtime.context.el.loginPassword.value, "");
  assert.equal(runtime.context.el.loginPersonnelNumber.focused, true);
  assert.equal(runtime.button.disabled, false);
  assert.equal(runtime.button.attributes.has("aria-busy"), false);
  assert.equal(runtime.button.textContent, "Abmelden");
});

test("v0.92.5: Logout-Timeout bestätigt keinen Erfolg und bietet einen erneuten Versuch an", async () => {
  let triggerTimeout;
  const runtime = createLogoutRuntime(
    (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    (callback, delay) => {
      assert.equal(delay, 15000);
      triggerTimeout = callback;
      return 1;
    },
  );

  const pending = runtime.context.runLogout();
  await tick();
  assert.equal(runtime.calls.api, 1);
  triggerTimeout();
  await pending;

  assert.equal(runtime.calls.showLogin, 0);
  assert.notEqual(runtime.context.portalState.session, null);
  assert.match(runtime.status.text, /nicht rechtzeitig bestätigt/i);
  assert.equal(runtime.status.error, true);
  assert.equal(runtime.calls.themeNeutralize, 1);
  assert.equal(runtime.calls.themeRefresh, 1);
  assert.equal(runtime.button.disabled, false);
});

test('Portal logout saves a pending price draft before logout and ignores double clicks throughout the flush', async () => {
  let finishSave,finishLogout,flushes=0;
  const workspace={hasUnsaved:true,flush:()=>{flushes++;return new Promise(resolve=>{finishSave=()=>{workspace.hasUnsaved=false;resolve();};});}};
  const runtime=createLogoutRuntime(()=>new Promise(resolve=>{finishLogout=resolve;}),setTimeout,workspace);
  const first=runtime.context.runLogout(),second=runtime.context.runLogout();
  assert.equal(flushes,1);assert.equal(runtime.calls.api,0);
  assert.equal(runtime.button.disabled,true);assert.equal(runtime.button.attributes.get('aria-busy'),'true');
  finishSave();await tick();assert.equal(runtime.calls.api,1);
  finishLogout({ok:true});await Promise.all([first,second]);
  assert.equal(runtime.calls.showLogin,1);assert.equal(runtime.button.disabled,false);
});

test('Portal logout keeps the account and draft when saving fails or an upload is still pending', async t => {
  for(const failing of [true,false])await t.test(failing?'draft save failed':'image upload pending',async()=>{
    const workspace={hasUnsaved:true,flush:async()=>{if(failing)throw new Error('Synthetic save error');}};
    const runtime=createLogoutRuntime(async()=>({ok:true}),setTimeout,workspace);
    await runtime.context.runLogout();
    assert.equal(runtime.calls.api,0);assert.equal(runtime.calls.showLogin,0);assert.notEqual(runtime.context.portalState.session,null);
    assert.equal(workspace.hasUnsaved,true);assert.equal(runtime.status.error,true);
    assert.match(runtime.status.text,failing?/Entwurf|entwurf/:/Bild|bild/);
    assert.equal(runtime.button.disabled,false);assert.equal(runtime.button.attributes.has('aria-busy'),false);
  });
});

test('Portal logout starts its authentication timeout only after the price draft flush', async () => {
  let finishSave,finishLogout;const timers=[];
  const workspace={hasUnsaved:true,flush:()=>new Promise(resolve=>{finishSave=()=>{workspace.hasUnsaved=false;resolve();};})};
  const runtime=createLogoutRuntime(()=>new Promise(resolve=>{finishLogout=resolve;}),(callback,delay)=>{timers.push({callback,delay});return 1;},workspace);
  const pending=runtime.context.runLogout();await tick();
  assert.equal(timers.length,0);assert.equal(runtime.calls.api,0);assert.equal(runtime.button.disabled,true);
  finishSave();await tick();assert.equal(timers.length,1);assert.equal(timers[0].delay,15000);assert.equal(runtime.calls.api,1);
  finishLogout({ok:true});await pending;
});

test('Portal logout does not send an old-account request after the actor changes during draft flush', async () => {
  let finishSave;const workspace={hasUnsaved:true,flush:()=>new Promise(resolve=>{finishSave=()=>{workspace.hasUnsaved=false;resolve();};})};
  const runtime=createLogoutRuntime(async()=>({ok:true}),setTimeout,workspace),pending=runtime.context.runLogout();
  runtime.context.portalState.session={user:{employeeNumber:'253'}};
  finishSave();await pending;
  assert.equal(runtime.calls.api,0);assert.equal(runtime.calls.showLogin,0);assert.equal(runtime.context.portalState.session.user.employeeNumber,'253');
  assert.equal(runtime.button.disabled,false);
});

test('Portal logout ignores a late old-account acknowledgement after another actor entered', async () => {
  let finishLogout;const runtime=createLogoutRuntime(()=>new Promise(resolve=>{finishLogout=resolve;})),pending=runtime.context.runLogout();await tick();
  assert.equal(runtime.calls.api,1);runtime.context.portalState.session={user:{employeeNumber:'253'}};
  finishLogout({ok:true});await pending;
  assert.equal(runtime.calls.showLogin,0);assert.equal(runtime.calls.windowSync,0);assert.equal(runtime.context.portalState.session.user.employeeNumber,'253');
  assert.equal(runtime.button.disabled,false);
});

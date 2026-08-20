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

function createLogoutRuntime(apiImplementation, timerImplementation = setTimeout) {
  const logoutSource = script.slice(script.indexOf("let logoutInProgress = false;"), script.indexOf("function setTab("));
  const calls = { api: 0, clearTab: 0, showLogin: 0, processClear: 0, autosaveStop: 0, themeNeutralize: 0, themeRefresh: 0 };
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
    portalUser: () => ({ employeeNumber: "252" }),
    processTaskActorFingerprint: () => "252",
    stopBranchOrderAutosave: () => { calls.autosaveStop += 1; },
    clearProcessTaskState: () => { calls.processClear += 1; },
    clearRememberedPortalTab: () => { calls.clearTab += 1; },
    showLogin: () => { calls.showLogin += 1; },
    neutralizeBirthdayPresentationTheme: () => { calls.themeNeutralize += 1; },
    refreshBirthdayPresentationTheme: async () => { calls.themeRefresh += 1; },
  };
  vm.createContext(context);
  vm.runInContext(`${logoutSource}\nthis.runLogout = logout;`, context);
  return { context, calls, status, button };
}

test("v0.92.5: Logout zeigt sofort Fortschritt, ignoriert Doppelklick und rendert nach Erfolg Login", async () => {
  let finishRequest;
  const runtime = createLogoutRuntime(() => new Promise((resolve) => { finishRequest = resolve; }));
  const first = runtime.context.runLogout();
  const second = runtime.context.runLogout();

  assert.equal(runtime.calls.api, 1);
  assert.equal(runtime.button.disabled, true);
  assert.equal(runtime.button.attributes.get("aria-busy"), "true");
  assert.equal(runtime.button.textContent, "Abmelden…");

  finishRequest({ ok: true });
  await Promise.all([first, second]);

  assert.equal(runtime.calls.showLogin, 1);
  assert.equal(runtime.calls.clearTab, 1);
  assert.equal(runtime.calls.processClear, 1);
  assert.equal(runtime.calls.autosaveStop, 1);
  assert.equal(runtime.calls.themeNeutralize, 1);
  assert.equal(runtime.calls.themeRefresh, 0);
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

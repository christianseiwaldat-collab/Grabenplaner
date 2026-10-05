"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

function loadFunction(name, nextName, helpers = {}) {
  const start = script.indexOf(`function ${name}(`);
  const end = script.indexOf(`function ${nextName}(`, start);
  assert.notEqual(start, -1, `${name} fehlt`);
  assert.notEqual(end, -1, `${nextName} fehlt`);
  const context = vm.createContext({ Date, Number, Array, ...helpers });
  vm.runInContext(`${script.slice(start, end)}\nthis.subject = ${name};`, context);
  return context.subject;
}

test("unavailable database sizes never display as zero KB", () => {
  const label = loadFunction("systemCenterByteLabel", "systemCenterUptimeLabel");
  for (const value of [null, undefined, ""]) assert.equal(label(value), "Nicht verfügbar");
  assert.equal(label(1024), "1 KB");
  assert.equal(label(11785956734), "11 GB");
});

test("live size is separated from stored history and negative deltas retain their sign", () => {
  const render = loadFunction("renderSystemCenterSparkline", "renderSystemCenterTrends", {
    escapeHtml: String, escapeHtmlAttribute: loadFunction("escapeHtmlAttribute", "activeLocations"), diagnosticTimestamp: String,
  });
  const points = [{ at: '2026-09-19T00:00:00Z', bytes: 952 }, { at: '2026-09-20T00:00:00Z', bytes: 0 }];
  const original = JSON.stringify(points);
  const html = render(points, { key: 'bytes', label: 'Datenbankgröße', formatter: String,
    colorClass: 'database', currentLabel: '11 GB' });
  assert.match(html, /<strong>11 GB<\/strong>/);
  assert.match(html, /−952/);
  assert.match(html, /gespeicherter Verlauf/);
  assert.equal(JSON.stringify(points), original);
});

test("all checks stay visible; unavailable server-only backup is explained without a repair action", () => {
  const content = { setAttribute() {}, innerHTML: '' };
  const checks = [
    { id: 'backup_external', label: 'Getrennte lokale Sicherung', state: 'not_applicable' },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `test${i}`, label: `Prüfung ${i}`, state: 'pass' })),
    { id: 'publicReady', label: 'Öffentliche HTTPS-Prüfung', state: 'unknown' },
  ];
  const helpers = { elements: { systemCenterContent: content }, escapeHtml: String,
    diagnosticTimestamp: String, systemCenterVisualState: value => value === 'pass' ? 'ok' : 'neutral',
    systemCenterStateCopy: () => ({ icon: '-', label: 'Prüfen' }),
    normalizedSystemCenterFactors: () => [{ id: 'backup', label: 'Backup', state: 'neutral',
      weight: null, earned: null, coverage: null, detail: '', checks }],
    renderSystemCenterOffsiteProvider: () => '', systemCenterResourceCards: () => '',
    renderSystemCenterOperations: () => '', renderSystemCenterTrends: () => '', renderProductReadiness: () => '',
  };
  loadFunction('renderSystemCenter', 'applySystemCenterControls', helpers)({});
  assert.match(content.innerHTML, /Nicht erforderlich im Serverbetrieb/);
  assert.match(content.innerHTML, /Öffentliche HTTPS-Prüfung: Beheben/);
  assert.equal((content.innerHTML.match(/>Beheben<\/a>/g) || []).length, 1);
});

test("v0.78: redigierte oder fehlende Trendwerte bleiben null und werden nicht zu null Byte", () => {
  const normalize = loadFunction("normalizedSystemCenterTrendPoints", "renderSystemCenterSparkline");
  const points = normalize({
    points: [{
      at: "2026-07-22T00:00:00.000Z",
      trustScore: null,
      databaseBytes: null,
      backupDurationSeconds: undefined,
      recoveryDurationSeconds: "",
    }],
  });
  assert.equal(points.length, 1);
  assert.equal(points[0].trustScore, null);
  assert.equal(points[0].databaseBytes, null);
  assert.equal(points[0].backupDurationSeconds, null);
  assert.equal(points[0].recoveryDurationSeconds, null);
});

test("v0.78: echte numerische Nullwerte und positive Messwerte bleiben erhalten", () => {
  const normalize = loadFunction("normalizedSystemCenterTrendPoints", "renderSystemCenterSparkline");
  const points = normalize({
    points: [{
      at: "2026-07-22T00:00:00.000Z",
      trustScore: 0,
      databaseBytes: "4096",
      backupDurationSeconds: 0,
      recoveryDurationSeconds: 12.5,
    }],
  });
  assert.equal(points[0].trustScore, 0);
  assert.equal(points[0].databaseBytes, 4096);
  assert.equal(points[0].backupDurationSeconds, 0);
  assert.equal(points[0].recoveryDurationSeconds, 12.5);
});

test("notification card distinguishes human confirmation and offers only its authorized receipt action", () => {
  const content = {innerHTML: "", setAttribute() {}}, checks = [{id: "notifications_delivery", label: "Reale Testzustellung", state: "unknown"}];
  const helpers = {elements: {systemCenterContent: content}, escapeHtml: String, diagnosticTimestamp: String,
    systemCenterVisualState: value => value === "pass" ? "ok" : "neutral", systemCenterStateCopy: () => ({icon: "-", label: "Prüfen"}),
    normalizedSystemCenterFactors: () => [{id: "notifications", label: "Benachrichtigung", state: "neutral", weight: null, earned: null, coverage: null, detail: "", checks}],
    renderSystemCenterOffsiteProvider: () => "", systemCenterResourceCards: () => "", renderSystemCenterOperations: () => "", renderSystemCenterTrends: () => "", renderProductReadiness: () => ""};
  const render = loadFunction("renderSystemCenter", "applySystemCenterControls", helpers);
  render({notificationReceipt: {state: "unknown", configurationToken: "private-token"}, capabilities: {canConfirmNotificationReceipt: true}});
  assert.match(content.innerHTML, /data-notification-receipt-confirm/);
  assert.doesNotMatch(content.innerHTML, /section=backup|private-token/);
  render({notificationReceipt: {state: "pass", source: "human-receipt-confirmation", checkedAt: "2026-10-05T18:00:00Z"}, capabilities: {canConfirmNotificationReceipt: false}});
  assert.match(content.innerHTML, /Empfang persönlich bestätigt/);
  assert.doesNotMatch(content.innerHTML, /data-notification-receipt-confirm/);
  render({notificationReceipt: {state: "unknown", reason: "configuration_changed"}});
  assert.match(content.innerHTML, /Versandkonfiguration hat sich geändert/);
});

test("receipt click cancellation sends nothing; confirmed click posts only its proof and ignores a later account switch", async () => {
  let approved = false, calls = 0, reloads = 0, finish;
  const state = {portalSession: {user: {employeeNumber: "synthetic"}}, systemCenter: {capabilities: {canConfirmNotificationReceipt: true}, notificationReceipt: {configurationToken: "protected-token"}}};
  const helpers = {state, confirm: () => approved, showToast() {}, loadSystemCenter: async () => {reloads++;},
    api: async (route, options) => {
      calls++; assert.equal(route, "/api/portal/v1/system-center/notifications/email/confirm-receipt");
      assert.deepEqual(JSON.parse(options.body), {confirmed: true, configurationToken: "protected-token"});
      await new Promise(resolve => {finish = resolve;});
    }};
  const start = script.indexOf("async function confirmSystemNotificationReceipt("), end = script.indexOf("function productReadinessEnvironment(", start);
  const action = vm.runInNewContext(`${script.slice(start, end)}; confirmSystemNotificationReceipt`, helpers);
  const button = {disabled: false, isConnected: true};
  await action(button); assert.equal(calls, 0);
  approved = true;
  const pending = action(button); assert.equal(button.disabled, true); assert.equal(calls, 1);
  await action(button); assert.equal(calls, 1);
  state.portalSession = {user: {employeeNumber: "other"}};
  finish(); await pending;
  assert.equal(reloads, 0); assert.equal(button.disabled, false);
  const next = action(button); finish(); await next;
  assert.equal(reloads, 1);
});

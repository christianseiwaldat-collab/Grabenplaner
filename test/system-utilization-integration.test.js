"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
function functionSource(name) {
  const start = source.search(new RegExp("^function " + name + "\\(", "m")), end = source.indexOf("\n}", start);
  assert(start >= 0 && end > start, name); return source.slice(start, end + 2);
}
function renderer() {
  const context = vm.createContext({ Intl, escapeHtml: value => String(value).replaceAll("<", "&lt;"),
    systemCenterUptimeLabel: () => "1 Std.", systemCenterByteLabel: () => "1 GB" });
  vm.runInContext(functionSource("systemCenterResourceCards"), context);
  return resources => context.systemCenterResourceCards(resources);
}
const metric = (html, id) => new RegExp(`<article data-system-utilization-resource="${id}">([\\s\\S]*?)</article>`).exec(html)?.[1] || "";

test("CPU resource card shows actual host utilization, preserves zero and never invents a load-derived percentage", () => {
  const render = renderer();
  for (const [value, expected] of [[0, "0 %"], [42.5, "42,5 %"], [100, "100 %"]]) {
    const resources = { cpu: { usedPercent: value, logicalProcessors: 6, loadAverageOneMinute: .9 } }, copy = JSON.stringify(resources);
    const html = metric(render(resources), "cpu"); assert.match(html, new RegExp(`<strong>${expected}</strong>`));
    assert.match(html, /Gesamter Server · 6 logische Prozessoren/); assert.doesNotMatch(html, /Last|>Aktiv</);
    assert.equal(JSON.stringify(resources), copy);
  }
  for (const value of [undefined, null, "0", false, -1, 101, NaN, Infinity]) {
    const html = metric(render({ cpu: { usedPercent: value, logicalProcessors: 6, loadAverageOneMinute: .9 } }), "cpu");
    assert.match(html, /<strong>Nicht verfügbar<\/strong>/); assert.doesNotMatch(html, /Last|>Aktiv</);
  }
  assert.match(metric(render({ cpu: { usedPercent: null, status: "warming-up" } }), "cpu"), /<strong>Messung läuft<\/strong>/);
});

test("RAM resource card keeps a genuine zero and excludes non-numeric or out-of-range percentages", () => {
  const render = renderer();
  assert.match(metric(render({ memory: { usedPercent: 0 } }), "memory"), /<strong>0 % belegt<\/strong>/);
  assert.match(metric(render({ memory: { usedPercent: 69.25 } }), "memory"), /<strong>69,3 % belegt<\/strong>/);
  for (const value of [null, undefined, "69", -1, 101, false]) assert.match(metric(render({ memory: { usedPercent: value } }), "memory"), /<strong>Nicht verfügbar<\/strong>/);
});

test("technical live data requires an authenticated technical reader, active settings page and selected System-Center", () => {
  let selected = true;
  const context = vm.createContext({ state: { portalStatus: { portalEnabled: true }, portalSession: { authenticated: true,
    user: { permissions: ["system:diagnostics:technical"] } }, currentView: "settings" },
    elements: { systemCenterPanel: { classList: { contains: name => name === "active" && selected } } } });
  vm.runInContext(functionSource("systemUtilizationAllowed") + "\n" + functionSource("systemUtilizationActive"), context);
  assert.equal(context.systemUtilizationActive(), true);
  for (const permissions of [[], ["settings:write"], ["system:diagnostics:read"]]) {
    context.state.portalSession.user.permissions = permissions; assert.equal(context.systemUtilizationAllowed(), false); assert.equal(context.systemUtilizationActive(), false);
  }
  context.state.portalSession.user.permissions = ["system:diagnostics:technical"];
  context.state.portalSession.user.mustChangePassword = true; assert.equal(context.systemUtilizationAllowed(), false);
  context.state.portalSession.user.mustChangePassword = false; selected = false; assert.equal(context.systemUtilizationActive(), false);
  selected = true; context.state.currentView = "schedule"; assert.equal(context.systemUtilizationActive(), false);
  context.state.currentView = "settings"; context.state.portalSession = null; assert.equal(context.systemUtilizationAllowed(), false);
  context.state.portalStatus.portalEnabled = false; assert.equal(context.systemUtilizationAllowed(), true);
});

test("root workspace reattaches the existing instrument, mounts once and invalidates its identity on rights loss or logout", () => {
  const synchronizations = [], mounts = [], attachments = [], host = {};
  const context = vm.createContext({ state: { portalStatus: { portalEnabled: true }, portalSession: { authenticated: true,
    user: { employeeNumber: "BEISPIEL", accountId: "EXAMPLE", sessionKind: "employee", permissions: ["system:diagnostics:technical"], scopes: [] } }, currentView: "settings" },
    elements: { systemCenterUtilization: host, systemCenterPanel: { classList: { contains: () => true } },
      systemCenterContent: { querySelector: () => ({ replaceWith: value => attachments.push(value) }) } },
    api() {}, updateSystemUtilizationSnapshot() {}, systemUtilizationWorkspace: null,
    GpSystemUtilization: { mount(value, options) { mounts.push({ value, options }); return { synchronize: input => synchronizations.push(input) }; } } });
  vm.runInContext(["systemUtilizationAllowed", "systemUtilizationActive", "syncSystemUtilizationWorkspace"].map(functionSource).join("\n"), context);
  context.syncSystemUtilizationWorkspace(); context.syncSystemUtilizationWorkspace();
  assert.equal(mounts.length, 1); assert.equal(mounts[0].value, host); assert.equal(mounts[0].options.isActive(), true);
  assert.equal(synchronizations[0].active, true); assert.equal(synchronizations[0].actorKey, synchronizations[1].actorKey);
  assert.match(synchronizations[0].actorKey, /EXAMPLE/); assert.equal(attachments.every(value => value === host), true);
  context.state.portalSession.user.permissions = ["system:diagnostics:read"]; context.syncSystemUtilizationWorkspace();
  assert.equal(synchronizations.at(-1).active, false); assert.equal(synchronizations.at(-1).actorKey, "");
  context.state.portalSession = null; context.syncSystemUtilizationWorkspace();
  assert.equal(synchronizations.at(-1).active, false); assert.equal(synchronizations.at(-1).actorKey, ""); assert.equal(mounts.length, 1);
});

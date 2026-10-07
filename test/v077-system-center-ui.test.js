const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

function functionSource(name, nextName) {
  const start = script.indexOf(`function ${name}`);
  const end = script.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0, `${name} fehlt`);
  assert.ok(end > start, `${nextName} fehlt nach ${name}`);
  return script.slice(start, end);
}

test("System-Center steht in den Einstellungen rechts neben System & Backups", () => {
  const systemTab = html.indexOf('data-settings-tab="systemCenter"');
  const backupTab = html.indexOf('data-settings-tab="backup"');
  const locationTab = html.indexOf('data-rights-dashboard-mode="locations"');
  const rightsTab = html.indexOf('data-rights-dashboard-mode="rights"');
  const personnelRulesTab = html.indexOf('data-rights-dashboard-mode="personnelRules"');
  const processesTab = html.indexOf('data-rights-dashboard-mode="processes"');
  assert.ok(locationTab >= 0 && locationTab < rightsTab);
  assert.ok(rightsTab < personnelRulesTab);
  assert.ok(personnelRulesTab < processesTab);
  assert.ok(backupTab >= 0 && backupTab < systemTab);
  const tabStripStart = html.search(/<div(?=[^>]*class="settings-tabs")(?=[^>]*role="tablist")[^>]*>/);
  assert.ok(tabStripStart >= 0, "Die Einstellungsreiter bleiben eine eigene Tablist.");
  const settingsTabStrip = html.slice(tabStripStart, html.indexOf('<section id="generalSettings"'));
  assert.equal([...settingsTabStrip.matchAll(/data-settings-tab="([^"]+)"/g)].at(-1)[1], "systemCenter");
  assert.doesNotMatch(html, /data-rights-dashboard-mode="systemCenter"/);
  const startDashboard = html.slice(html.indexOf('<section id="startDashboardView"'), html.indexOf('<section id="filialAdministrationView"'));
  assert.match(startDashboard, /<section[^>]*id="startDashboardVpsCard"[^>]*aria-label="VPS-Übersicht"/);
  const vpsCard = startDashboard.slice(startDashboard.indexOf('id="startDashboardVpsCard"'), startDashboard.indexOf('</section>', startDashboard.indexOf('id="startDashboardVpsCard"')));
  assert.match(vpsCard, /System-Center/);
  assert.match(vpsCard, /data-vps-title>VPS-Übersicht/);
  assert.match(vpsCard, /data-vps-description>Ressourcen, Nachtlauf und Warnungen/);
  assert.match(vpsCard, /data-vps-metrics/);
  assert.match(vpsCard, /data-vps-refresh/);
  assert.doesNotMatch(vpsCard, /startRecoveryAssurance|data-settings-tab/);
  assert.match(startDashboard, /id="startDashboardCenterVisible"/);
  assert.match(startDashboard, /id="startDashboardVpsVisible"/);
  const settingsPanel = html.indexOf('class="settings-section settings-system-center" id="systemCenterPanel"');
  assert.ok(settingsPanel > html.indexOf('<section id="settingsView"'));
  assert.ok(settingsPanel < html.indexOf('<section id="usbProvisioningSettings"'));
  assert.match(html, /data-rights-dashboard-mode="locations" data-dashboard-capability="rights"/);
  assert.match(html, /data-rights-dashboard-mode="processes"[^>]*>Abläufe &amp; Prozesse<\/button>/);
  assert.match(html, /class="location-dashboard-panel" id="rightsDashboardLocationsPanel"/);
  for (const marker of ["systemCenterPanel", "systemCenterUpdated", "refreshSystemCenter", "startRecoveryAssurance", "systemCenterContent"]) {
    assert.match(html, new RegExp(`id="${marker}"`));
  }
  assert.match(html, /id="systemCenterContent"[^>]*aria-live="polite"[^>]*aria-busy="true"/);
  assert.match(script, /function canReadSystemCenter\(\)/);
  assert.match(script, /system:diagnostics:read/);
  assert.match(script, /system:diagnostics:technical/);
  assert.match(script, /rightsDashboardMode: "locations"/);
  assert.match(script, /systemCenter: systemCenterAccess/);
});

test("zusätzliche VPS-Kachel bleibt persönlich, technisch berechtigt und unabhängig vom System-Center-Reiter", () => {
  const state = {portalStatus:{portalEnabled:true, operationMode:'server'}, portalSession:{authenticated:true,
    user:{employeeNumber:'252', sessionKind:'employee', isEmployee:true, active:true, mustChangePassword:false,
      permissions:['system:diagnostics:technical']}}};
  const context = {state}; vm.createContext(context);
  vm.runInContext(functionSource('canReadSystemCenter', 'canReadPersonnelRulesDashboard')
    + functionSource('isLocalStartDashboardWorkspace', 'startDashboardWorkspaceActorKey')
    + functionSource('canReadStartDashboardVps', 'syncStartDashboardControlChoices'), context);
  assert.equal(context.canReadStartDashboardVps(), true);
  const original = structuredClone(state);
  for (const change of [
    value => {value.portalSession.user.permissions=['system:diagnostics:read'];},
    value => {value.portalSession.user.permissions=['settings:write','backup:write'];},
    value => {value.portalSession.authenticated=false;},
    value => {value.portalSession.user.mustChangePassword=true;},
    value => {value.portalSession.user.active=false;},
    value => {value.portalSession.user.sessionKind='organization';value.portalSession.user.isEmployee=false;},
    value => {value.portalStatus.operationMode='local';},
    value => {value.portalStatus.portalEnabled=false;value.portalStatus.localOnly=true;},
  ]) {
    Object.assign(state, structuredClone(original));change(state);
    assert.equal(context.canReadStartDashboardVps(), false);
  }
  const sync = functionSource('syncStartDashboardVps', 'syncGpWindows');
  assert.match(sync, /classList\.toggle\('hidden',!canReadStartDashboardVps\(\)\)/);
  assert.match(sync, /canUse:canReadStartDashboardVps/);
  assert.match(sync, /state\.currentView==='startDashboard'/);
  assert.match(sync, /isVisible\('control:vps'\)!==false/);
  const navigation = functionSource('applyRequestedView', 'currentAdministrationRoute');
  assert.match(navigation, /parameters\.get\("dashboard"\) === "systemCenter"[\s\S]*if \(canReadSystemCenter\(\)\) \{[\s\S]*setView\("settings"\);[\s\S]*setSettingsTab\("systemCenter"\);[\s\S]*else setView\("startDashboard"\);/);
});

test("v0.77: System-Center lädt nur seinen Diagnose-Endpunkt", () => {
  const systemLoader = functionSource("loadSystemCenter", "startRecoveryAssurance");
  const governanceLoader = functionSource("loadGovernanceDashboards", "loadRightsDashboard");
  const router = functionSource("loadRightsDashboard", "saveMobileLeadershipSettings");
  const settingsRouter = functionSource("setSettingsTab", "setPersonnelTab");
  assert.match(systemLoader, /api\("\/api\/portal\/v1\/system-center"\)/);
  assert.doesNotMatch(systemLoader, /rights-dashboard|personnel-field-rights|dashboards\/locations/);
  assert.match(governanceLoader, /if \(!canReadGovernanceDashboards\(\)\) return;/);
  assert.match(governanceLoader, /\/api\/portal\/v1\/rights-dashboard/);
  assert.doesNotMatch(router, /loadSystemCenter/);
  assert.match(settingsRouter, /if \(activeTab === "systemCenter"\) loadSystemCenter\(\);/);
  assert.match(router, /else await loadGovernanceDashboards\(\);/);
});

test("v0.77: Manueller Recovery-Test benötigt Bestätigung und explizites API-Token", () => {
  const start = functionSource("startRecoveryAssurance", "setRightsDashboardMode");
  assert.match(start, /confirm\("Jetzt einen vollständigen Recovery-Assurance-Test starten\?/);
  assert.match(start, /\/api\/portal\/v1\/system-center\/recovery-assurance\/run/);
  assert.match(start, /method: "POST"/);
  assert.match(start, /confirmation: "RECOVERY_ASSURANCE_START"/);
  assert.match(script, /startRecoveryAssurance\?\.addEventListener\("click", startRecoveryAssurance\)/);
  assert.match(script, /refreshSystemCenter\?\.addEventListener\("click", \(\) => loadSystemCenter\(\)\)/);
});

function settingsFixture(permissions) {
  function element(dataset = {}) {
    const classes = new Set();
    const attributes = new Map();
    return { dataset, hidden: false, disabled: false, classList: {
      contains: value => classes.has(value),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value),
    }, setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute: name => attributes.get(name) ?? null, scrollIntoView() {} };
  }
  const tabs = ["general", "backup", "systemCenter"].map(settingsTab => element({ settingsTab }));
  tabs[0].classList.toggle("active", true);
  const calls = [];
  const elements = Object.fromEntries(["generalSettings", "scheduleSettings", "personnelSettings", "dataProtectionSettings", "accessSettings", "rightsSettings", "backupSettings", "systemCenterPanel", "saveSettingsButton"].map(id => [id, element()]));
  elements.generalSettings.classList.toggle("active", true);
  const context = {
    state: { portalStatus: { portalEnabled: true, operationMode: "server" }, portalSession: { user: { permissions } } },
    elements,
    document: { querySelectorAll: () => tabs, querySelector: selector => tabs.find(tab => selector.includes(`"${tab.dataset.settingsTab}"`)) },
    schedulePdfSettingsWritePermission: "schedule:pdf:settings:write",
    loadSystemCenter: () => calls.push("systemCenter"),
    refreshServerDiagnostics: () => calls.push("backup"),
    canManageMaintenanceSchedules: () => false, canManageOffsiteFolders: () => false,
    clearUsbProvisioningPasswords() {}, scheduleAllSettingsPackedGrids() {}, syncRightsWorkspace() {},
  };
  vm.createContext(context);
  vm.runInContext(functionSource("canReadSystemCenter", "canReadPersonnelRulesDashboard")
    + functionSource("visibleManagedTabButtons", "reconcileManagedTabs")
    + functionSource("setSettingsTab", "setPersonnelTab"), context);
  return { context, elements, tabs, calls };
}

test("System-Center settings load only diagnostics, switch panels and hide the unrelated save action", () => {
  for (const permission of ["system:diagnostics:read", "system:diagnostics:technical"]) {
    const { context, elements, calls, tabs } = settingsFixture([permission, "settings:write"]);
    context.setSettingsTab("systemCenter");
    assert.equal(elements.systemCenterPanel.classList.contains("active"), true);
    assert.equal(elements.generalSettings.classList.contains("active"), false);
    assert.equal(elements.saveSettingsButton.classList.contains("hidden"), true);
    assert.equal(tabs[2].getAttribute("aria-selected"), "true");
    assert.equal(tabs[2].tabIndex, 0);
    assert.deepEqual(calls, ["systemCenter"]);
    context.setSettingsTab("backup");
    assert.equal(elements.systemCenterPanel.classList.contains("active"), false);
    assert.equal(elements.backupSettings.classList.contains("active"), true);
    assert.deepEqual(calls, ["systemCenter", "backup"]);
  }
});

test("System-Center cannot be opened with settings or backup rights alone", () => {
  const { context, elements, calls, tabs } = settingsFixture(["settings:write", "backup:write"]);
  context.setSettingsTab("systemCenter");
  assert.equal(elements.systemCenterPanel.classList.contains("active"), false);
  assert.equal(elements.generalSettings.classList.contains("active"), true);
  assert.equal(tabs[0].classList.contains("active"), true);
  assert.deepEqual(calls, []);
});

test("v0.77: Vertrauensindex, Nachweiskarten und signierte Laufhistorie sind vertragstreu", () => {
  assert.match(script, /trustIndex\?\.cards/);
  assert.match(script, /possiblePoints/);
  assert.match(script, /earnedPoints/);
  assert.match(script, /coverage/);
  assert.match(script, /evidenceAt/);
  assert.match(script, /assurance\.recentRuns/);
  assert.match(script, /run\?\.phases/);
  for (const label of ["Bestätigt", "Kritisch", "Prüfen", "Nicht nachgewiesen"]) assert.match(script, new RegExp(label));
  assert.match(script, /aria-label="Technischer Vertrauensindex:/);
  assert.match(script, /system-center-state/);
});

test("System-Center folgt Einstellungen-Darkmode, globaler Schriftgröße und Responsive Layout", () => {
  assert.match(styles, /\.system-center-hero/);
  assert.match(styles, /\.system-center-factor-grid/);
  assert.match(styles, /\.system-center-run-phases/);
  assert.match(styles, /\.system-center-state\.critical/);
  assert.match(styles, /\.system-center-state\.warning/);
  assert.match(styles, /\.system-center-state\.ok/);
  assert.match(styles, /rights-dashboard\[data-dashboard-theme="dark"\][\s\S]*--rd-critical-soft/);
  assert.match(styles, /#settingsView\[data-page-theme="dark"\] \.settings-system-center/);
  assert.match(styles, /--app-font-scale:\s*1;/);
  assert.match(styles, /body \{[^}]*zoom:\s*var\(--app-font-scale\);/);
  assert.doesNotMatch(styles, /data-dashboard-font-size=/);
  assert.match(styles, /@media \(max-width: 1250px\)[\s\S]*system-center-factor-grid/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*system-center-factor-grid/);
});

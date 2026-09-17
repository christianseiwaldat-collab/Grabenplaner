'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { create } = require('../public/navigation-history');

function browser(url = 'https://gp.example/?view=startDashboard') {
  const listeners = new Set(), tasks = [], entries = [{ url, state: null }];
  let index = 0;
  const win = {
    get location() { return new URL(entries[index].url); },
    queueMicrotask: task => tasks.push(task),
    addEventListener: (event, callback) => { if (event === 'popstate') listeners.add(callback); },
    removeEventListener: (event, callback) => listeners.delete(callback),
    history: {
      get state() { return entries[index].state; },
      get length() { return entries.length; },
      replaceState(state, _title, target) { entries[index] = { url: new URL(target, win.location.href).href, state }; },
      pushState(state, _title, target) { const url = new URL(target, win.location.href).href; entries.splice(++index); entries.push({ url, state }); },
      go(delta) {
        if (index + delta < 0 || index + delta >= entries.length) return false;
        index += delta; for (const callback of listeners) callback({ state: entries[index].state }); return true;
      },
    },
    flush() { while (tasks.length) tasks.shift()(); },
  };
  return win;
}

function fixture(url) {
  const win = browser(url), errors = [];
  let route = { view: 'startDashboard' }, authorized = true, restores = 0;
  const nav = create({ window: win, app: 'administration', keys: ['view', 'section'],
    read: () => route, enabled: () => authorized, onError: error => errors.push(error),
    apply: () => { restores++; route = Object.fromEntries(win.location.searchParams); nav.record(); },
  });
  return { win, nav, errors, get route() { return route; }, get restores() { return restores; },
    visit(value) { route = value; nav.record(); }, authorize(value) { authorized = value; } };
}

test('Browser history: initial visit is replaced, main view and subsection form one entry', () => {
  const f = fixture(); f.nav.start();
  assert.equal(f.win.history.length, 1);
  f.visit({ view: 'settings' }); f.visit({ view: 'settings', section: 'rights' }); f.win.flush();
  assert.equal(f.win.history.length, 2);
  assert.equal(f.win.location.search, '?view=settings&section=rights');
  f.visit(f.route); f.win.flush(); assert.equal(f.win.history.length, 2);
  assert.deepEqual(f.win.history.state, { gpNavigation: { version: 1, app: 'administration' } });
});

test('Browser history: back, forward and branching preserve real chronological visits', () => {
  const f = fixture(); f.nav.start();
  for (const section of ['create', 'reports', 'pdf']) { f.visit({ view: 'salesAnalytics', section }); f.win.flush(); }
  f.win.history.go(-1); f.win.flush(); assert.equal(f.route.section, 'reports');
  f.win.history.go(-1); f.win.flush(); assert.equal(f.route.section, 'create');
  f.win.history.go(1); f.win.flush(); assert.equal(f.route.section, 'reports');
  assert.equal(f.win.history.length, 4);
  f.visit({ view: 'articleCatalog' }); f.win.flush();
  assert.equal(f.win.history.go(1), false);
  assert.equal(f.win.history.length, 4); assert.equal(f.restores, 3); assert.deepEqual(f.errors, []);
});

test('Browser history: a pop cancels an uncommitted navigation and never traps Back', () => {
  const f = fixture(); f.nav.start(); f.visit({ view: 'settings' }); f.win.flush();
  f.visit({ view: 'crm' }); f.win.history.go(-1); f.win.flush();
  assert.equal(f.route.view, 'startDashboard'); assert.equal(f.win.history.length, 2);
  assert.equal(f.win.history.go(-1), false);
});

test('Browser history: only approved route identifiers are serialized', () => {
  const f = fixture('https://gp.example/index.html?launch=desktop#help'); f.nav.start();
  f.visit({ view: 'personnel', section: 'employees', password: 'secret', report: { customer: 'private' }, note: 'private' }); f.win.flush();
  assert.equal(f.win.location.pathname, '/index.html'); assert.equal(f.win.location.hash, '#help');
  assert.equal(f.win.location.search, '?launch=desktop&view=personnel&section=employees');
  assert.doesNotMatch(JSON.stringify(f.win.history.state), /private|secret/);
});

test('Browser history: logout disables restoration; re-login does not add artificial entries', () => {
  const f = fixture(); f.nav.start(); f.visit({ view: 'settings' }); f.win.flush();
  f.nav.stop(); f.authorize(false); f.win.history.go(-1);
  assert.equal(f.restores, 0); f.visit({ view: 'personnel' }); f.win.flush();
  assert.equal(f.win.location.search, '?view=startDashboard');
  f.authorize(true); f.visit({ view: 'startDashboard' }); f.nav.start();
  assert.equal(f.win.history.length, 2);
  f.nav.dispose(); f.win.history.go(1); assert.equal(f.restores, 0);
});

test('Browser history: denied destinations are canonicalized without replaying actions', () => {
  const win = browser(); let route = { view: 'startDashboard' }, permitted = true;
  const nav = create({ window: win, app: 'admin', keys: ['view'], read: () => route,
    apply: () => { route = { view: permitted ? win.location.searchParams.get('view') : 'startDashboard' }; } });
  nav.start(); route = { view: 'personnel' }; nav.record(); win.flush();
  route = { view: 'settings' }; nav.record(); win.flush(); permitted = false;
  win.history.go(-1); assert.equal(win.location.searchParams.get('view'), 'startDashboard');
  assert.equal(win.history.length, 3);
});

const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const portalSource = fs.readFileSync(path.join(__dirname, '../public/portal.js'), 'utf8');
function functionSource(source, name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(match, name); return source.slice(match.index, source.indexOf('\n}', match.index) + 2);
}
function element(dataset = {}) {
  const classes = new Set();
  return { dataset, classList: { contains: value => classes.has(value), toggle(value, on) { if (on) classes.add(value); else classes.delete(value); } } };
}

function administration() {
  const settings = ['general', 'rights', 'schedule', 'developer'].map(settingsTab => element({ settingsTab }));
  settings[0].classList.toggle('active', true); settings[3].classList.toggle('hidden', true);
  const win = browser(), calls = [], elements = new Proxy({}, { get(target, key) { return target[key] ||= element(); } });
  win.GrabenplanerTradeInsights = require('../public/trade-insights');
  const ctx = { window: win, URLSearchParams, state: { currentView: 'startDashboard', portalStatus: {}, crm: {},
    salesAnalytics: { tab: 'create' }, personnelAdministrationTab: 'dashboard', personnelTab: 'employees',
    requestKindTab: 'vacation', rightsDashboardMode: 'rights', locationId: '18', departmentId: '',
    locations: [{ id: '18', active: true, departments: [{ id: 1, active: true }] }, { id: '20', active: true, departments: [{ id: 2, active: true }] }] },
    elements, timePresenceRefreshTimer: null, receiptSearchWorkspace: null, tradeInsightsTab: 'purchasing',
    tradeInsightsWorkspace: { activate: tab => calls.push({ insights: tab }), suspend: () => calls.push('suspendInsights') },
    document: { hidden: false, querySelectorAll: selector => selector.includes('data-settings-tab') ? settings : [],
      querySelector: selector => settings.find(item => (!selector.includes('.active') || item.classList.contains('active')) && !item.classList.contains('hidden')) },
    setSettingsTab(tab) { settings.forEach(item => item.classList.toggle('active', item.dataset.settingsTab === tab)); },
    employeeProfileIsOpen: () => false, accessibleDashboardModes: () => ['rights', 'processes'],
    restoreRememberedOverallContext: () => false, loadAll: options => calls.push({ load: options }),
    loadPlanningPeriod: period => calls.push({ period }),
    closeMobileNavigation: () => calls.push('closeNavigation'),
    setPersonnelAdministrationTab: tab => { ctx.state.personnelAdministrationTab = tab; },
    setSalesAnalyticsTab: tab => { ctx.state.salesAnalytics.tab = tab; },
    setPersonnelTab: tab => { ctx.state.personnelTab = tab; },
    setRightsDashboardMode: mode => { ctx.state.rightsDashboardMode = mode; },
  };
  for (const name of ['canReadManagerRequests', 'canReadManagedTimeTracking', 'canOpenPersonnelAdministrationModule', 'canOpenSalesAdministrationModule', 'canAccessSalesAnalytics', 'canAccessSalesArticleCatalog', 'canAccessCrm', 'canAccessTradeInsights', 'canReadLoanManagement', 'canManageBranchOrders']) ctx[name] = () => true;
  for (const name of ['clearUsbProvisioningPasswords', 'clearPersonnelLifecycleEditorState', 'clearPersonnelLifecycleAutomationState', 'renderContextNavigation', 'applyActivePageAppearance', 'loadStartDashboard', 'loadRightsDashboard', 'ensureAccessibleManagerRequestTab', 'loadManagerVacationRequests', 'loadLoanManagement', 'loadBranchOrdersManagement', 'renderSalesArticleCatalogResults', 'syncCrmCustomerWorkspace']) ctx[name] = () => {};
  for (const name of ['loadSalesArticleTablePreferences', 'loadSalesArticleLastImport', 'loadCrmPreferences']) ctx[name] = async () => {};
  vm.createContext(ctx);
  vm.runInContext(['activeLocations', 'departmentsForLocation', 'setDefaultContext', 'pageViewElement', 'functionSearchSettingsTabButton', 'planningContextNeedsReload', 'loadPlanningView', 'setView', 'applyRequestedView', 'currentAdministrationRoute'].map(name => functionSource(appSource, name)).join('\n'), ctx);
  ctx.grabenplanerNavigation = create({ window: win, app: 'admin', keys: ['view', 'section', 'kind', 'dashboard', 'process', 'location', 'department'],
    read: ctx.currentAdministrationRoute, apply: () => ctx.applyRequestedView({ fromHistory: true }) });
  ctx.grabenplanerNavigation.start(); return { ctx, win, calls };
}

test('Administration: all main views include CRM and maintain existing access guards', () => {
  const { ctx, win } = administration();
  ctx.setView('crm'); win.flush(); assert.equal(ctx.state.currentView, 'crm');
  ctx.setView('salesAnalytics'); win.flush(); ctx.canAccessCrm = () => false;
  win.history.go(-1); win.flush();
  assert.equal(ctx.state.currentView, 'startDashboard');
  assert.equal(win.location.searchParams.get('view'), 'startDashboard');
  ctx.setView('invented-view'); assert.equal(ctx.state.currentView, 'startDashboard');
});

test('Administration: sales, settings and personnel subsections survive back/forward', () => {
  const { ctx, win } = administration();
  ctx.state.salesAnalytics.tab = 'reports'; ctx.setView('salesAnalytics'); win.flush();
  ctx.setView('settings'); ctx.setSettingsTab('rights'); win.flush();
  ctx.state.personnelAdministrationTab = 'workflows'; ctx.setView('personnelAdministration'); win.flush();
  win.history.go(-1); assert.equal(ctx.currentAdministrationRoute().section, 'rights');
  win.history.go(-1); assert.equal(ctx.currentAdministrationRoute().section, 'reports');
  win.history.go(2); assert.equal(ctx.currentAdministrationRoute().section, 'workflows');
  win.history.replaceState(null, '', '?view=settings&section=developer'); ctx.applyRequestedView({ fromHistory: true });
  assert.equal(ctx.currentAdministrationRoute().section, 'rights');
});

test('Administration: trade tabs share GP history and honor revoked access', () => {
  const { ctx, win, calls } = administration();
  win.history.replaceState(null, '', '?view=tradeInsights&section=purchasing');
  ctx.applyRequestedView({ fromHistory: true }); win.flush();
  assert.equal(ctx.state.currentView, 'tradeInsights');
  assert.equal(ctx.currentAdministrationRoute().section, 'purchasing');
  ctx.tradeInsightsTab = 'inventory'; ctx.grabenplanerNavigation.record(); win.flush();
  ctx.setView('salesAdministration'); win.flush();
  assert.equal(calls.at(-1), 'suspendInsights');
  win.history.go(-1); win.flush();
  assert.equal(ctx.state.currentView, 'tradeInsights');
  assert.equal(calls.findLast(call => call.insights).insights, 'inventory');
  win.history.go(-1); win.flush();
  assert.equal(ctx.currentAdministrationRoute().section, 'purchasing');
  win.history.go(1); win.flush();
  assert.equal(ctx.currentAdministrationRoute().section, 'inventory');
  ctx.setView('salesAdministration'); win.flush();
  ctx.canAccessTradeInsights = () => false;
  win.history.go(-1); win.flush();
  assert.equal(ctx.state.currentView, 'startDashboard');
  assert.equal(win.location.searchParams.get('view'), 'startDashboard');
});

test('Administration: invalid trade tabs normalize to the supported default', () => {
  const { ctx, win } = administration();
  win.history.replaceState(null, '', '?view=tradeInsights&section=unknown');
  ctx.applyRequestedView(); win.flush();
  assert.equal(ctx.currentAdministrationRoute().section, 'purchasing');
});

test('Administration: Back restores the recorded branch, not the last stored branch', () => {
  const { ctx, win, calls } = administration();
  ctx.setView('planning'); win.flush(); ctx.state.locationId = '20'; ctx.state.departmentId = '2'; ctx.setView('planning'); win.flush();
  ctx.restoreRememberedOverallContext = () => { throw Error('History must use its own branch'); };
  win.history.go(-1); assert.equal(ctx.state.locationId, '18'); assert.equal(ctx.state.departmentId, '');
  win.history.go(1); assert.equal(ctx.state.locationId, '20'); assert.equal(ctx.state.departmentId, '2');
  assert.equal(calls.filter(call => call.period === 'schedule').length, 2);
  win.history.replaceState(null, '', '?view=planning&location=unknown&department=99'); ctx.applyRequestedView({ fromHistory: true });
  assert.equal(ctx.state.locationId, '20'); assert.equal(ctx.state.departmentId, '2');
});

test('Administration: deep linked process survives canonicalization and resets stale category', () => {
  const { ctx, win } = administration();
  win.history.replaceState(null, '', '?view=rightsDashboard&dashboard=processes&process=onboarding');
  ctx.applyRequestedView({ fromHistory: true }); ctx.grabenplanerNavigation.replace();
  assert.equal(ctx.currentAdministrationRoute().process, 'onboarding');
  assert.equal(ctx.state.rightsProcessCategoryId, 'all');
  assert.equal(win.location.searchParams.get('process'), 'onboarding');
});

test('Administration: late context responses cannot replace the most recent branch', async () => {
  const { ctx } = administration(); const pending = [];
  ctx.api = url => new Promise(resolve => pending.push({ url, resolve })); ctx.render = () => {};
  ctx.contextQuery = () => `&location=${ctx.state.locationId}`; ctx.showToast = () => {};
  ctx.state.weekStart = '2026-09-07'; ctx.state.vacationYear = 2026;
  ctx.canReadManagerRequests = ctx.canReadLoanManagement = ctx.canManageBranchOrders = () => false;
  vm.runInContext('let loadAllGeneration = 0; let planningPeriodController = null;\n' + functionSource(appSource, 'loadAll'), ctx);
  function initial() { const rows = pending.splice(0); for (const row of rows) row.resolve(row.url === '/api/locations' ? ctx.state.locations : row.url.endsWith('/status') ? {} : []); }
  function finish(rows, locationId) { for (const row of rows) row.resolve(row.url.startsWith('/api/schedule') ? { weekStart: '2026-09-07', context: { locationId }, settings: {} } : row.url.startsWith('/api/vacations') ? { year: 2026 } : []); }
  const first = ctx.loadAll({ restoreContext: false }); initial(); await new Promise(setImmediate);
  const slow = pending.splice(0); ctx.state.locationId = '20';
  const second = ctx.loadAll({ restoreContext: false }); initial(); await new Promise(setImmediate);
  finish(pending.splice(0), '20'); await second; finish(slow, '18'); await first;
  assert.equal(ctx.state.locationId, '20'); assert.equal(ctx.state.data.context.locationId, '20');
});

test('Portal: route restoration supports learning, approvals and process deep links without stored-tab fallback', () => {
  const win = browser('https://gp.example/portal.html?tab=learningDashboard'); let storedReads = 0;
  const ctx = { location: win.location, URLSearchParams, isLeadershipUser: () => true, defaultPortalTab: () => 'schedule',
    portalState: { activeTab: 'schedule' }, storedPortalTab: () => { storedReads++; return 'amu'; },
    setTab(tab) { ctx.portalState.activeTab = tab; }, };
  vm.createContext(ctx); vm.runInContext(['normalizedPortalTab', 'requestedPortalSettingsSection', 'currentPortalRoute', 'restorePortalRoute'].map(name => functionSource(portalSource, name)).join('\n'), ctx);
  ctx.restorePortalRoute(); assert.equal(ctx.portalState.activeTab, 'learningDashboard');
  ctx.location = new URL('https://gp.example/portal.html?tab=leadershipApprovals&kind=amu'); ctx.restorePortalRoute();
  assert.equal(ctx.currentPortalRoute().kind, 'amu');
  ctx.location = new URL('https://gp.example/portal.html?tab=processTasks&run=run-1&step=step-2'); ctx.restorePortalRoute();
  assert.equal(ctx.currentPortalRoute().run, 'run-1'); assert.equal(ctx.currentPortalRoute().step, 'step-2');
  ctx.location = new URL('https://gp.example/portal.html?tab=unknown'); ctx.restorePortalRoute();
  assert.equal(ctx.portalState.activeTab, 'schedule'); assert.equal(storedReads, 0);
});

test('Both application shells load the same navigation controller before their application script', () => {
  for (const [file, script] of [['index.html', 'app.js'], ['portal.html', 'portal.js']]) {
    const html = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
    assert.ok(html.indexOf('src="/navigation-history.js"') >= 0);
    assert.ok(html.indexOf('src="/navigation-history.js"') < html.indexOf(`src="/${script}"`));
  }
});

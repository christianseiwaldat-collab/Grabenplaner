'use strict';
// Real Start HTML, shared modules and app callbacks with synthetic in-memory preferences.
// No application server, database, productive account or image tool is loaded.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const repository = path.join(__dirname, '..'), publicRoot = path.join(repository, 'public');
const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(publicRoot, 'app.js'), 'utf8');
function appFunction(name) {
  const start = appSource.indexOf('function ' + name + '('), end = appSource.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, name); return appSource.slice(start, end + 2);
}
test('actual Start callbacks migrate legacy hiding and keep new dashboard tabs restorable through dynamic renders',
  {skip:process.env.GP_DASHBOARD_BROWSER_TEST !== '1', timeout:60000}, async () => {
    const {chromium} = require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
    const browser = await chromium.launch({headless:true,
      ...(process.env.GP_BROWSER_EXECUTABLE ? {executablePath:process.env.GP_BROWSER_EXECUTABLE} : {}), args:['--no-first-run']});
    const pageErrors = [];
    try {
      const page = await browser.newPage({viewport:{width:1440, height:1000}});
      page.on('pageerror', error => pageErrors.push(error.message));
      const start = html.indexOf('<section id="startDashboardView"'), end = html.indexOf('<section id="filialAdministrationView"', start);
      assert.ok(start >= 0 && end > start);
      const styles = ['styles.css', 'gp-window.css', 'start-dashboard-workspace.css'].map(file => fs.readFileSync(path.join(publicRoot, file), 'utf8')).join('\n');
      await page.setContent('<style>' + styles + '</style>' + html.slice(start, end));
      for (const file of ['gp-window-preferences.js', 'gp-window.js', 'start-dashboard-workspace-preferences.js',
        'start-dashboard-workspace-geometry.js', 'gp-dashboard-boards.js', 'start-dashboard-workspace.js']) {
        await page.addScriptTag({path:path.join(publicRoot, file)});
      }
      await page.evaluate(() => {
        const root = document.getElementById('startDashboardView'); root.classList.add('active');
        root.querySelectorAll('.hidden').forEach(node => node.classList.remove('hidden'));
        document.getElementById('startDashboardCustomizer').classList.add('hidden');
        window.state = {currentView:'startDashboard', portalStatus:{portalEnabled:true, operationMode:'server'},
          portalSession:{authenticated:true, user:{employeeNumber:'synthetic-start-A', sessionKind:'employee', isEmployee:true,
            role:'developer', permissions:['schedule:read'], scopes:[], mustChangePassword:false}},
          startDashboardPreferences:{version:3, hidden:['loans'], hiddenWidgets:[],
            order:['schedule', 'vacation', 'loans', 'branchOrders', 'personnel', 'sales'], groupSizes:{branch:'standard', personnel:'standard', sales:'standard'}}};
        window.elements = Object.fromEntries(['startDashboardView', 'startDashboardGrid', 'startDashboardCustomizeButton',
          'startDashboardResetButton', 'startDashboardCustomizer', 'startDashboardCustomizerClose',
          'startDashboardBranchGroup', 'startDashboardPersonnelGroup', 'startDashboardSalesGroup'].map(id => [id, document.getElementById(id)]));
        window.startDashboardVps = null; window.apiWrites = []; window.persistedDocument = null; window.toasts = [];
        window.accessibleCards = new Set(['schedule', 'vacation', 'loans', 'branchOrders', 'personnel', 'sales']);
        window.startDashboardCardAccessible = id => accessibleCards.has(id);
        window.accessibleDashboardModes = () => ['control']; window.canReadSystemCenter = () => false;
        window.normalizeStartDashboardPreferences = value => structuredClone(value || state.startDashboardPreferences);
        window.api = async (_url, options = {}) => {
          if (options.method === 'PUT') {const body = JSON.parse(options.body); apiWrites.push(body); persistedDocument = body.startDashboardWorkspace; return {};}
          return {startDashboardWorkspace:persistedDocument || StartDashboardWorkspacePreferences.empty(),
            startDashboardPreferences:{...state.startDashboardPreferences, hidden:['vacation'], hiddenWidgets:['branchAbsences']}};
        };
        window.showToast = (message, error) => toasts.push({message, error});
        for (const name of ['syncGpWindows', 'syncSidebarNotepad', 'renderStartDashboardScopeControls', 'renderStartDashboardBranchWidgets',
          'renderStartDashboardPersonnelWidgets', 'renderStartDashboardOperationalCards', 'renderStartDashboardSalesWidgets', 'renderStartDashboardCustomizer']) window[name] = () => {};
        window.gpWindows = GpWindow.installDocument(document, {actorKey:() => 'synthetic-start-A', canUse:() => true,
          readPreferences:async () => ({version:1, windows:{}}), writePreferences:async () => {}});
      });
      const constantsStart = appSource.indexOf('const START_DASHBOARD_WIDGET_IDS ='), constantsEnd = appSource.indexOf('\nfunction isLocalStartDashboardWorkspace(', constantsStart);
      assert.ok(constantsStart >= 0 && constantsEnd > constantsStart);
      const callbacks = ['isLocalStartDashboardWorkspace', 'canUseStartDashboardWorkspace', 'startDashboardWorkspaceActorKey',
        'startDashboardWorkspaceFieldAllowed', 'migrateStartDashboardWorkspace', 'applyStartDashboardWorkspace',
        'syncStartDashboardWorkspace', 'canReadStartDashboardVps', 'syncStartDashboardControlChoices', 'syncStartDashboardVps',
        'openStartDashboardCustomizer', 'renderStartDashboard'];
      await page.addScriptTag({content:appSource.slice(constantsStart, constantsEnd) + '\n' + callbacks.map(appFunction).join('\n') +
        '\nelements.startDashboardCustomizeButton.addEventListener("click",openStartDashboardCustomizer);renderStartDashboard();'});
      await page.waitForFunction(() => startDashboardWorkspace?.store.ready);
      const vacation = page.locator('[data-start-dashboard-card="vacation"]'), loans = page.locator('[data-start-dashboard-card="loans"]');
      assert.equal(await vacation.isVisible(), false, 'Payload legacy hiding migrates into the first board');
      assert.equal(await page.locator('[data-start-dashboard-widget="branchAbsences"]').isVisible(), false);
      assert.equal(await loans.isVisible(), true, 'State legacy defaults do not override the API migration');
      assert.equal(await page.locator('.gp-dashboard-tabs [role="tab"]').count(), 3);
      assert.equal(await page.locator('#startDashboardVpsCard').isVisible(), false, 'VPS permission guard is still enforced');
      assert.equal(await page.evaluate(() => startDashboardWorkspace.store.value.fields['card:vacation'].hidden), true);
      assert.equal(await page.evaluate(() => apiWrites.length), 0, 'Migration alone does not write preferences');

      await page.locator('#startDashboardCustomizeButton').click();
      const settings = page.locator('.gp-dashboard-settings-dialog').filter({has:page.locator('[data-dashboard-settings-form]')});
      assert.equal(await settings.isVisible(), true);
      assert.equal(await settings.evaluate(node => node.classList.contains('gp-window')), true);
      assert.equal(await page.locator('#startDashboardCustomizer').isVisible(), false, 'Existing button opens the new GP settings window');
      assert.equal(await settings.locator('[data-dashboard-choice="card:vacation"]').isChecked(), false);
      await settings.locator('[data-dashboard-choice="card:vacation"]').check();
      await settings.locator('[data-dashboard-choice="widget:branchAbsences"]').check();
      await settings.locator('input[name="dashboardName"]').fill('Mein Start');
      await settings.locator('[type="submit"]').click();
      await page.waitForFunction(() => persistedDocument?.dashboards[0].name === 'Mein Start' && !startDashboardWorkspace.store.saving);
      assert.equal(await vacation.isVisible(), true); assert.equal(await loans.isVisible(), true);
      assert.equal(await page.locator('[data-dashboard-tab="dashboard-1"]').textContent(), 'Mein Start');

      await page.evaluate(() => renderStartDashboard());
      assert.equal(await vacation.isVisible(), true, 'Later business render cannot re-hide the restored card');
      assert.equal(await loans.isVisible(), true, 'Later legacy .hidden class is corrected from permissions');
      await page.locator('[data-dashboard-field-menu="group:branch"]').click();
      await page.locator('[data-field-menu] [data-field-close]').click();
      await page.waitForFunction(() => persistedDocument?.dashboards[0].fields['group:branch']?.hidden === true && !startDashboardWorkspace.store.saving);
      assert.equal(await page.locator('[data-start-dashboard-group="branch"]').isVisible(), false);
      await page.evaluate(() => renderStartDashboard());
      assert.equal(await page.locator('[data-start-dashboard-group="branch"]').isVisible(), false, 'Closed group stays closed after renderer refresh');

      await page.locator('[data-dashboard-tab="dashboard-2"]').click();
      await page.waitForFunction(() => startDashboardWorkspace.store.document.activeDashboard === 'dashboard-2' && !startDashboardWorkspace.store.saving);
      assert.equal(await vacation.isVisible(), true); assert.equal(await page.locator('[data-start-dashboard-group="branch"]').isVisible(), true);
      await page.locator('[data-dashboard-field-menu="group:sales"]').click();
      await page.locator('[data-field-menu] [data-field-close]').click();
      await page.waitForFunction(() => persistedDocument?.dashboards[1].fields['group:sales']?.hidden === true && !startDashboardWorkspace.store.saving);
      await page.locator('[data-dashboard-tab="dashboard-1"]').click();
      await page.waitForFunction(() => startDashboardWorkspace.store.document.activeDashboard === 'dashboard-1' && !startDashboardWorkspace.store.saving);
      assert.equal(await page.locator('[data-start-dashboard-group="branch"]').isVisible(), false);
      assert.equal(await page.locator('[data-start-dashboard-group="sales"]').isVisible(), true);
      await page.locator('[data-dashboard-tab="dashboard-2"]').click();
      await page.waitForFunction(() => startDashboardWorkspace.store.document.activeDashboard === 'dashboard-2' && !startDashboardWorkspace.store.saving);
      assert.equal(await page.locator('[data-start-dashboard-group="sales"]').isVisible(), false);
      assert.equal(await page.locator('[data-start-dashboard-group="branch"]').isVisible(), true);

      await page.evaluate(() => {accessibleCards.delete('vacation'); renderStartDashboard();});
      assert.equal(await vacation.isVisible(), false);
      await page.locator('#startDashboardCustomizeButton').click();
      assert.equal(await settings.locator('[data-dashboard-choice="card:vacation"]').count(), 0, 'Rights denial cannot be undone in board settings');
      await settings.locator('[data-dashboard-dialog-close]').last().click();
      await page.evaluate(() => {accessibleCards.add('vacation'); renderStartDashboard();});
      assert.equal(await vacation.isVisible(), true, 'Permissions becoming available restore the separate board setting');
      assert.deepEqual(await page.evaluate(() => state.startDashboardPreferences.hidden), ['loans']);
      assert.deepEqual(await page.evaluate(() => toasts.filter(message => message.error)), []);
      assert.deepEqual(pageErrors, []);
      if (process.env.GP_WINDOW_SCREENSHOT_DIR) {
        const target = path.join(process.env.GP_WINDOW_SCREENSHOT_DIR, 'start-dashboard-actual-app-tabs.png');
        fs.mkdirSync(path.dirname(target), {recursive:true}); await page.screenshot({path:target, fullPage:true});
      }
    } finally {await browser.close();}
  });

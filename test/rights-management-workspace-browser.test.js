'use strict';
// Actual GP markup, production window/table modules and rights-editor renderer.
// All accounts, permission payloads and preference storage in this fixture are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const repo = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(repo, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(repo, 'public/app.js'), 'utf8');
const enabled = process.env.GP_WINDOW_BROWSER_TEST === '1';

function elementHtml(id) {
  const marker = html.indexOf(`id="${id}"`);
  assert.ok(marker >= 0, `actual markup contains ${id}`);
  const start = html.lastIndexOf('<', marker);
  const tag = /^<([\w-]+)/.exec(html.slice(start))[1];
  const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'g');
  tags.lastIndex = start;
  let depth = 0;
  for (let match; (match = tags.exec(html));) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (!depth) return html.slice(start, tags.lastIndex);
  }
  assert.fail(`actual ${id} markup is balanced`);
}

function sourceBetween(start, end) {
  const from = app.indexOf(start), to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `actual source contains ${start}`);
  return app.slice(from, to);
}

async function browser() {
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
  return chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}), args: ['--no-first-run'] });
}

async function setup(page, { storage = {}, geometries = {} } = {}) {
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent('<div class="app-shell"><aside class="sidebar" id="mainSidebar"><strong>GP · BEISPIEL</strong><span>Lokale Layoutprüfung</span></aside><main class="main-content"><section class="view active" id="settingsView"><header class="page-header"><span class="eyebrow">BEISPIEL · Einstellungen</span><h1>Rechtemanagement</h1></header><section id="rightsSettings" class="settings-section active">'
    + elementHtml('openRightsManagementButton') + '</section><button id="backgroundButton">Hintergrund bleibt bedienbar</button></section><footer class="system-footer"><span>BEISPIEL · Systemstatus</span></footer></main></div>'
    + elementHtml('rightsManagementWindow') + elementHtml('rightsEditorModal'));
  for (const file of ['styles.css', 'mobile-refinements.css', 'table-layout.css', 'gp-window.css', 'rights-management-workspace.css']) {
    await page.addStyleTag({ path: path.join(repo, 'public', file) });
  }
  for (const file of ['gp-window-preferences.js', 'gp-window.js', 'table-layout.js', 'rights-management-workspace.js']) {
    await page.addScriptTag({ path: path.join(repo, 'public', file) });
  }
  await page.evaluate(({ storage, geometries }) => {
    window.actor = 'BEISPIEL:A:developer';
    window.identity = 'BEISPIEL:A';
    window.allowed = true;
    window.active = true;
    window.preferenceStorage = storage;
    window.geometryStorage = geometries;
    window.geometryWrites = [];
    window.clickedBackground = 0;
    window.toastMessages = [];
    window.storageAdapter = {
      getItem: key => Object.hasOwn(preferenceStorage, key) ? preferenceStorage[key] : null,
      setItem: (key, value) => { preferenceStorage[key] = value; },
      removeItem: key => { delete preferenceStorage[key]; },
    };
    window.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    window.state = { portalStatus: { portalEnabled: true }, portalSession: { authenticated: true, user: { role: 'developer', active: true, isEmployee: true, permissions: ['rights:read'] } }, locations: [{ id: 'example-east', name: 'BEISPIEL Ost', departments: [{ id: 1, name: 'Verkauf' }] }, { id: 'example-west', name: 'BEISPIEL West', departments: [{ id: 2, name: 'Verkauf' }] }], selectedRightsEmployeeNumber: null, rightsEditorReturnFocus: null,
      rightsManagement: { users: [
        { employeeNumber: '17', nickname: 'BEISPIEL Anna', fullName: 'BEISPIEL Anna Muster', role: 'employee', roleName: 'Mitarbeiter', homeLocationId: 'example-east', preferredDepartmentId: 1, manageable: true, configured: true, active: false, rolePermissions: ['loans:self:use'], grantedPermissions: [], deniedPermissions: [], scopes: [] },
        { employeeNumber: '153', nickname: 'BEISPIEL Bernd', fullName: 'BEISPIEL Bernd Muster', role: 'department_manager', roleName: 'Abteilungsleitung', homeLocationId: 'example-west', preferredDepartmentId: 2, manageable: true, configured: true, active: true, rolePermissions: ['schedule:read', 'schedule:write'], grantedPermissions: ['work_rules:planning:read'], deniedPermissions: [], scopes: [{ locationId: 'example-west', departmentId: 2 }] },
        { employeeNumber: '252', nickname: 'BEISPIEL Developer', fullName: 'BEISPIEL Developer Muster', role: 'developer', roleName: 'Developer', homeLocationId: 'example-east', preferredDepartmentId: 1, manageable: false, configured: true, active: true, rolePermissions: ['schedule:read', 'schedule:write', 'loans:self:use'], grantedPermissions: [], deniedPermissions: [], scopes: [] },
        { employeeNumber: '267', nickname: 'BEISPIEL Clara', fullName: 'BEISPIEL Clara Muster', role: 'employee', roleName: 'Mitarbeiter', homeLocationId: 'example-west', preferredDepartmentId: 2, manageable: true, configured: false, active: false, rolePermissions: ['loans:self:use'], grantedPermissions: [], deniedPermissions: ['loans:self:use'], scopes: [] },
      ], catalog: [
        { id: 'schedule:read', label: 'Dienstpläne lesen', group: 'Dienstplanung', editable: true, scopeBehavior: 'organizational', description: 'Dienstpläne im ausgewählten Bereich lesen.' },
        { id: 'schedule:write', label: 'Dienstpläne bearbeiten', group: 'Dienstplanung', editable: true, scopeBehavior: 'organizational', warningLevel: 'high', description: 'Dienstpläne im ausgewählten Bereich bearbeiten.' },
        { id: 'loans:self:use', label: 'Persönliche Leihe verwenden', group: 'Persönliche Funktionen', editable: true, scopeBehavior: 'global', eligibleRoles: ['employee', 'department_manager'] },
        { id: 'work_rules:planning:read', label: 'Arbeitszeit-Hinweise lesen', group: 'Arbeitszeitregeln', editable: true, scopeBehavior: 'organizational', description: 'Hinweise zur aktuellen Planung einsehen.' },
        { id: 'settings:write', label: 'Geschütztes Systemrecht', group: 'System', editable: false, scopeBehavior: 'global', description: 'Im persönlichen Profil nicht veränderbar.' },
      ] } };
    window.elements = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
    window.showToast = (message, error) => toastMessages.push({ message, error });
    window.windowScale = () => parseFloat(getComputedStyle(document.body).zoom) || 1;
    window.windowBounds = () => GpWindow.viewportBounds(visualViewport || { width: innerWidth, height: innerHeight }, windowScale());
    window.preferences = GpWindow.createPreferences({ actorKey: () => actor, canUse: () => allowed,
      read: async () => geometryStorage[identity] || { version: 1, windows: {} },
      write: async value => { geometryStorage[identity] = value; geometryWrites.push({ actor, value }); } });
    window.workspaceOptions = { root: elements.rightsManagementWindow, editor: elements.rightsEditorModal, opener: elements.openRightsManagementButton,
      key: () => actor, identity: () => identity, canUse: () => allowed, active: () => active, windowPreferences: preferences,
      bounds: windowBounds, scale: windowScale, openProfile: number => openRightsEditor(number), storage: storageAdapter };
    window.rightsManagementWorkspace = RightsManagementWorkspace.mount(workspaceOptions);
    window.rightsWorkspace = rightsManagementWorkspace;
    window.rightsSettingsWindows = null;
    window.rightsEditorGeneration = 0;
    window.rightsEditorSnapshot = null;
    window.rightsEditorSaveContext = null;
    window.startDashboardWorkspaceActorKey = () => actor;
    window.closeAnimations = [];
    const nativeAnimate = Element.prototype.animate;
    Element.prototype.animate = function(frames, options) {
      if (this.id === 'rightsManagementWindow' || this.id === 'rightsEditorModal') {
        const target = this.id === 'rightsManagementWindow' ? elements.openRightsManagementButton
          : state.rightsEditorReturnFocus?.isConnected ? state.rightsEditorReturnFocus
            : document.querySelector(`[data-rights-user="${state.selectedRightsEmployeeNumber}"] [data-edit-user-rights]`) || elements.openRightsManagementButton;
        const from = this.getBoundingClientRect(), to = target?.getBoundingClientRect();
        closeAnimations.push({ id: this.id, frames, options, scale: windowScale(), from: { left: from.left, top: from.top }, to: to && { left: to.left, top: to.top } });
      }
      return nativeAnimate.call(this, frames, options);
    };
    document.getElementById('backgroundButton').onclick = () => clickedBackground++;
  }, { storage, geometries });
  const roleFunctions = sourceBetween('function permissionEligibleForRole(', 'const permissionDependencyRules =');
  const dependencies = sourceBetween('const permissionDependencyRules =', '\nfunction ');
  const workspaceGate = sourceBetween('function canUseRightsWorkspace()', 'function syncRightsWorkspace()');
  const renderer = sourceBetween('const rightsEditorOrganizationalPermissionIds =', 'function renderMobileLeadershipSettings(');
  await page.addScriptTag({ content: roleFunctions + dependencies + '\n' + workspaceGate + '\n' + renderer });
  await page.evaluate(() => {
    rightsManagementWorkspace.render({ users: state.rightsManagement.users, locations: state.locations, managerDenialOnly: false });
    elements.rightsEditorPermissions.addEventListener('change', event => { const input = event.target.closest('input[data-rights-permission]'); if (!input) return; updateRightsEditorPermissionStatus(input); enforceRightsEditorPermissionDependencies(input); refreshRightsEditorScope(); });
  });
  return errors;
}

async function screenshot(page, name) {
  if (!process.env.GP_RIGHTS_SCREENSHOT_DIR) return;
  fs.mkdirSync(process.env.GP_RIGHTS_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.GP_RIGHTS_SCREENSHOT_DIR, name), fullPage: false });
}

async function drag(page, locator, dx, dy) {
  const box = await locator.boundingBox();
  assert.ok(box, 'drag handle is visible');
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 5 }); await page.mouse.up();
}

test('explicit minimized entry retains expanded dimensions and sticky profile context through actual scrolling',
  {skip:!enabled,timeout:60000},async t => {
    const instance=await browser();try {
      for (const width of [1400,390]) await t.test('viewport '+width,async () => {
        const page=await instance.newPage({viewport:{width,height:900}}),errors=await setup(page);
        await page.locator('#openRightsManagementButton').click();
        const root=page.locator('#rightsManagementWindow'), expanded=await root.boundingBox();
        await page.evaluate(() => rightsManagementWorkspace.show({minimized:true}));
        assert.equal(await root.locator('[data-rights-window-body]').isVisible(),false);
        assert.ok((await root.boundingBox()).height<65);
        const footer=await page.evaluate(() => {
          const main=document.querySelector('.main-content'),node=document.querySelector('.system-footer');
          return {bottom:node.getBoundingClientRect().bottom,height:innerHeight,padding:parseFloat(getComputedStyle(main).paddingBottom)};
        });
        assert.ok(Math.abs(footer.bottom+footer.padding-footer.height)<2,'Fixed or minimized rights windows keep the system footer at the page bottom');
        await root.locator('[data-rights-window-toggle]').click();
        assert.ok(Math.abs((await root.boundingBox()).width-expanded.width)<2);
        await page.evaluate(() => {
          for (let index=0;index<30;index++) state.rightsManagement.catalog.push({id:'example:'+index,label:'BEISPIEL Prüf-Recht '+index,group:'Prüfung',editable:true,scopeBehavior:'global'});
          openRightsEditor('153');
          rightsManagementWorkspace.showProfile(undefined,{employeeNumber:'153',firstName:'Bernd'});
        });
        await page.waitForFunction(() => document.getElementById('rightsEditorModal').open);
        const positions=() => page.evaluate(() => Object.fromEntries(['#rightsEditorTitle','#rightsEditorSummary','.rights-editor-legend','#rightsEditorPermissions .rights-permission'].map(selector=>[selector,document.querySelector(selector).getBoundingClientRect().top])));
        const before=await positions();
        await page.locator('#rightsEditorForm').evaluate(form => {form.scrollTop=form.scrollHeight;});
        assert.ok(await page.locator('#rightsEditorForm').evaluate(form=>form.scrollTop>100));
        const after=await positions();
        for (const selector of ['#rightsEditorTitle','#rightsEditorSummary','.rights-editor-legend']) assert.ok(Math.abs(after[selector]-before[selector])<2,selector+' remains fixed while permissions scroll');
        assert.ok(after['#rightsEditorPermissions .rights-permission']<before['#rightsEditorPermissions .rights-permission']-100);
        const save=await page.locator('#saveRightsEditorButton').boundingBox(),profile=await page.locator('#rightsEditorModal').boundingBox();
        assert.ok(save.y>=profile.y&&save.y+save.height<=profile.y+profile.height);
        await page.locator('[data-rights-profile-window-toggle]').click();
        assert.equal(await page.locator('.rights-profile-context').isVisible(),false);
        assert.equal(await page.locator('#rightsEditorModal .gp-window-title-text').textContent(), '153 · Bernd');
        const minimizedProfile=await page.locator('#rightsEditorModal').boundingBox();
        assert.ok(Math.abs(minimizedProfile.width-260)<2);assert.ok(Math.abs(minimizedProfile.height-44)<2);
        await page.locator('[data-rights-profile-window-toggle]').click();
        assert.equal(await page.locator('#rightsEditorModal .gp-window-title-text').textContent(), 'Persönliches Rechteprofil');
        assert.deepEqual(errors,[]);await page.close();
      });
    }finally {await instance.close();}
  });

test('rights management uses genuine nonmodal compact windows, sortable personal table layouts and safe profile rendering',
  { skip: !enabled, timeout: 120000 }, async t => {
    const instance = await browser();
    try {
      const page = await instance.newPage({ viewport: { width: 1600, height: 1000 } });
      const errors = await setup(page);
      await page.locator('#openRightsManagementButton').click();
      await page.waitForFunction(() => !document.querySelector('#rightsManagementWindow').hidden);
      await t.test('compact roster keeps every employee in a sortable table and the background remains accessible', async () => {
        assert.equal(await page.locator('#rightsManagementWindow .gp-window-edge').count(), 8);
        assert.equal(await page.locator('#rightsManagementWindow tbody tr').count(), 4);
        assert.equal(await page.locator('dialog:modal').count(), 0);
        await page.locator('#backgroundButton').focus(); await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => clickedBackground), 1);
        const sizes = await page.locator('#rightsManagementWindow tbody td').evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).fontSize)));
        assert.ok(sizes.every(size => size <= 14), 'table typography is compact');
        const rows = await page.locator('#rightsManagementWindow tbody tr').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        assert.ok(rows.every(height => height <= 62), 'compact rows replace the old oversized cards');
        await page.evaluate(() => document.activeElement?.blur());
        await screenshot(page, '01-rechtemanagement-fenster.png');
        await page.locator('[data-rights-user="17"] [data-edit-user-rights]').click();
        await page.waitForFunction(() => document.querySelector('#rightsEditorModal').open);
        assert.equal(await page.locator('#saveRightsEditorButton').isDisabled(), false);
        await page.evaluate(() => { document.querySelector('.rights-management-table-scroll').scrollLeft = 0; document.activeElement?.blur(); });
        await screenshot(page, '02-persoenliches-rechteprofil.png');
        await page.locator('[data-rights-profile-window-close]').click();
        await page.waitForFunction(() => !document.querySelector('#rightsEditorModal').open);
      });
      await t.test('search finds names and locations; text content remains safe', async () => {
        await page.locator('#rightsEmployeeSearch').fill('BEISPIEL West');
        assert.equal(await page.locator('#rightsManagementWindow tbody [data-rights-user]').count(), 2);
        await page.locator('#rightsEmployeeSearch').fill('Anna');
        assert.equal(await page.locator('#rightsManagementWindow tbody tr').getAttribute('data-rights-user'), '17');
        await page.locator('#rightsEmployeeSearch').fill('Anna Muster');
        assert.equal(await page.locator('#rightsManagementWindow tbody tr').getAttribute('data-rights-user'), '17', 'full legal name remains searchable even when a nickname is displayed');
        await page.locator('#rightsEmployeeSearch').fill('');
        await page.evaluate(() => { state.rightsManagement.users[0].nickname = 'BEISPIEL <img src=x onerror=alert(1)>'; rightsManagementWorkspace.render({ users: state.rightsManagement.users, locations: state.locations }); });
        assert.equal(await page.locator('#rightsManagementWindow tbody img').count(), 0);
        assert.ok((await page.locator('#rightsManagementWindow tbody').textContent()).includes('<img src=x onerror=alert(1)>'));
        await page.evaluate(() => { state.rightsManagement.users[0].nickname = 'BEISPIEL Anna'; rightsManagementWorkspace.render({ users: state.rightsManagement.users, locations: state.locations }); });
      });
      await t.test('sort, visible columns, order and keyboard/pointer widths persist per account', async () => {
        await page.locator('[data-rights-sort="added"]').click(); await page.locator('[data-rights-sort="added"]').click();
        assert.equal(await page.evaluate(() => document.activeElement?.dataset.rightsSort), 'added', 'sorting restores keyboard focus to the rebuilt header');
        assert.equal(await page.locator('#rightsManagementWindow tbody tr').first().getAttribute('data-rights-user'), '153');
        assert.equal(await page.locator('th:has([data-rights-sort="added"])').getAttribute('aria-sort'), 'descending');
        await page.locator('[data-rights-columns] summary').click();
        assert.equal(await page.locator('[data-rights-column="employeeNumber"]').isDisabled(), true);
        await page.locator('[data-rights-column="role"]').uncheck();
        assert.equal(await page.evaluate(() => document.activeElement?.dataset.rightsColumn), 'role', 'column visibility preserves keyboard focus');
        await page.locator('[data-rights-column="status"]').uncheck();
        assert.equal(await page.locator('[data-rights-sort="role"]').count(), 0);
        await page.locator('[data-rights-column-move="name"][data-direction="-1"]').click();
        assert.equal(await page.locator('#rightsManagementWindow thead th').first().locator('[data-rights-sort]').getAttribute('data-rights-sort'), 'name');
        await page.locator('[data-rights-columns] summary').click();
        const resizer = page.locator('#rightsManagementWindow [data-gp-column-resize="name"]');
        const before = Number(await resizer.getAttribute('aria-valuenow'));
        await resizer.focus(); await page.keyboard.press('ArrowRight');
        assert.equal(Number(await resizer.getAttribute('aria-valuenow')), before + 10);
        await drag(page, resizer, 45, 0);
        assert.equal(Number(await resizer.getAttribute('aria-valuenow')), before + 55);
        const metadata = await page.evaluate(() => ({ preferences: rightsManagementWorkspace.preferences, serialized: JSON.stringify(preferenceStorage) }));
        assert.deepEqual(metadata.preferences.columns, ['name', 'employeeNumber', 'location', 'added', 'revoked']);
        assert.equal(metadata.preferences.sort, 'added');
        assert.equal(metadata.preferences.direction, 'desc');
        assert.equal(metadata.preferences.columnWidths.name, before + 55);
        assert.ok(!metadata.serialized.includes('BEISPIEL Anna') && !metadata.serialized.includes('schedule:read'), 'metadata storage never stores employee data or rights');
      });
      await t.test('actual rights API loader recovers after a transient error and clears a forbidden profile safely', async () => {
        await page.evaluate(() => {
          window.rightsLoadGeneration = 0; window.rightsLoadController = null;
          window.syncGpWindows = () => rightsManagementWorkspace.sync();
          window.renderMobileLeadershipSettings = () => {};
          window.renderPersonnelFieldRights = () => {};
          window.permissionDefaultsUI = { load: async () => {} };
          state.personnelFieldRightsDirtyRoles = new Set();
          window.fixtureRights = structuredClone(state.rightsManagement);
          window.apiFailureStatus = 500;
          for (const id of ['mobileLeadershipModuleSettings', 'personnelFieldRightsMatrix']) {
            const node = document.createElement('div'); node.id = id; document.body.append(node); elements[id] = node;
          }
          window.api = async url => {
            if (url.endsWith('/rights')) {
              if (apiFailureStatus) throw Object.assign(new Error('BEISPIEL: vorübergehend nicht erreichbar'), { status: apiFailureStatus });
              return structuredClone(fixtureRights);
            }
            return {};
          };
        });
        await page.addScriptTag({ content: sourceBetween('function renderRightsManagement()', 'const rightsEditorOrganizationalPermissionIds =')
          + sourceBetween('async function loadRightsManagement()', 'async function savePersonnelFieldRights()') });
        await page.evaluate(() => loadRightsManagement());
        assert.equal(await page.locator('#rightsUserList table').count(), 1, 'failed requests preserve the module-owned table');
        assert.equal(await page.locator('#rightsUserList [data-rights-user]').count(), 0);
        await page.evaluate(() => { apiFailureStatus = 0; return loadRightsManagement(); });
        assert.equal(await page.locator('#rightsUserList [data-rights-user]').count(), 4, 'a succeeding request restores the roster');
        await page.locator('[data-rights-user="153"] [data-edit-user-rights]').click();
        await page.waitForFunction(() => document.querySelector('#rightsEditorModal').open);
        await page.evaluate(() => { apiFailureStatus = 403; return loadRightsManagement(); });
        assert.equal(await page.locator('#rightsEditorModal').evaluate(node => node.open), false);
        assert.equal(await page.locator('#rightsEditorPermissions input').count(), 0);
        assert.equal(await page.locator('#rightsUserList [data-rights-user]').count(), 0);
        assert.equal(await page.evaluate(() => state.rightsManagement), null);
        await page.evaluate(() => { apiFailureStatus = 0; return loadRightsManagement(); });
        assert.equal(await page.locator('#rightsUserList [data-rights-user]').count(), 4);
      });
      await t.test('minimize is compact, restores its width, moves over the sidebar and uses all eight resize edges', async () => {
        const original = await page.locator('#rightsManagementWindow').boundingBox();
        await page.locator('[data-rights-window-toggle]').click();
        assert.equal(await page.locator('[data-rights-window-body]').isVisible(), false);
        assert.ok((await page.locator('#rightsManagementWindow').boundingBox()).width < original.width / 2);
        await page.evaluate(() => rightsManagementWorkspace.show({ restore: false }));
        assert.equal(await page.locator('[data-rights-window-body]').isVisible(), false, 'automatic settings reactivation preserves a minimized window');
        await page.locator('[data-rights-window-toggle]').click();
        assert.ok(Math.abs((await page.locator('#rightsManagementWindow').boundingBox()).width - original.width) < 2);
        await page.locator('[data-rights-window-title]').focus(); await page.keyboard.press('Home');
        const moved = await page.locator('#rightsManagementWindow').boundingBox();
        assert.ok(Math.abs(moved.x) < 1 && Math.abs(moved.y) < 1, 'internal window reaches the entire GP top-left');
        await drag(page, page.locator('[data-rights-window-title]'), 65, 45);
        const afterDrag = await page.locator('#rightsManagementWindow').boundingBox();
        assert.ok(Math.abs(afterDrag.x - 65) < 1 && Math.abs(afterDrag.y - 45) < 1);
        const east = page.locator('#rightsManagementWindow [data-gp-window-edge="e"]');
        await east.focus(); await page.keyboard.press('ArrowRight');
        assert.ok(Math.abs((await page.locator('#rightsManagementWindow').boundingBox()).width - afterDrag.width - 10) < 2);
        await drag(page, page.locator('#rightsManagementWindow [data-gp-window-edge="s"]'), 0, 25);
        assert.ok(Math.abs((await page.locator('#rightsManagementWindow').boundingBox()).height - afterDrag.height - 25) < 2);
        const handles = await page.locator('#rightsManagementWindow .gp-window-edge').evaluateAll(nodes => nodes.map(node => ({ edge: node.dataset.gpWindowEdge, text: node.textContent, cursor: getComputedStyle(node).cursor })));
        assert.equal(handles.length, 8);
        assert.ok(handles.every(handle => handle.text === '' && handle.cursor.includes('resize')));
      });
      await t.test('actual rights-profile renderer keeps protected accounts read-only and both windows nonmodal', async () => {
        await page.locator('[data-rights-user="252"] [data-edit-user-rights]').click();
        await page.waitForFunction(() => document.querySelector('#rightsEditorModal').open);
        assert.equal(await page.locator('#rightsEditorModal .gp-window-edge').count(), 8);
        assert.equal(await page.locator('#rightsEditorModal').evaluate(node => node.matches(':modal')), false);
        assert.equal(await page.locator('#saveRightsEditorButton').isDisabled(), true);
        assert.ok(await page.locator('#rightsEditorPermissions input').evaluateAll(nodes => nodes.length > 0 && nodes.every(node => node.disabled)));
        assert.equal(await page.locator('#rightsEditorModal [data-rights-profile-window-toggle]').isVisible(), true);
        const typography = await page.locator('#rightsEditorPermissions .rights-permission strong').evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).fontSize)));
        assert.ok(typography.every(size => size <= 14));
        await page.evaluate(() => document.activeElement?.blur());
        const original = await page.locator('#rightsEditorModal').boundingBox();
        await page.locator('[data-rights-profile-window-toggle]').click();
        assert.equal(await page.locator('#rightsEditorForm').isVisible(), false);
        const small = await page.locator('#rightsEditorModal').boundingBox();
        assert.ok(small.height < 80 && small.width < original.width / 2);
        await page.locator('[data-rights-profile-window-toggle]').click();
        assert.ok(Math.abs((await page.locator('#rightsEditorModal').boundingBox()).width - original.width) < 2);
        await page.locator('[data-rights-profile-window-close]').click();
        await page.waitForFunction(() => !document.querySelector('#rightsEditorModal').open);
        await page.locator('[data-rights-user="17"] [data-edit-user-rights]').click();
        await page.waitForFunction(() => document.querySelector('#rightsEditorModal').open);
        await page.locator('[data-rights-profile-window-title]').focus(); await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('#rightsEditorModal').open);
        assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-rights-user]')?.dataset.rightsUser), '17', 'Escape restores focus to the current profile row button');
        await page.locator('[data-rights-user="153"] [data-edit-user-rights]').click();
        await page.waitForFunction(() => document.querySelector('#rightsEditorModal').open);
        assert.equal(await page.locator('#saveRightsEditorButton').isDisabled(), false);
        assert.equal(await page.locator('#rightsEditorPermissions input[value="settings:write"]').isDisabled(), true);
        assert.equal(await page.locator('#rightsEditorPermissions input[value="schedule:write"]').isChecked(), true);
        await page.locator('#rightsEditorPermissions input[value="schedule:read"]').uncheck();
        assert.equal(await page.locator('#rightsEditorPermissions input[value="schedule:write"]').isChecked(), false, 'original rights dependencies remain active');
        await page.evaluate(() => { active = false; rightsManagementWorkspace.sync(); });
        assert.equal(await page.locator('#rightsEditorModal').isVisible(), false);
        assert.equal(await page.locator('#rightsEditorModal').evaluate(node => node.open), true, 'navigation pauses the open profile instead of discarding its draft');
        await page.evaluate(() => { active = true; rightsManagementWorkspace.sync(); });
        assert.equal(await page.locator('#rightsEditorModal').isVisible(), true);
        assert.equal(await page.locator('#rightsEditorPermissions input[value="schedule:write"]').isChecked(), false);
        await page.locator('[data-rights-profile-window-close]').click();
        await page.waitForFunction(() => !document.querySelector('#rightsEditorModal').open);
      });
      await t.test('X closes to its launcher; remount and fresh browser page restore metadata and geometry without crossing accounts', async () => {
        const savedGeometry = await page.evaluate(() => geometryStorage[identity].windows['rights:management']);
        await page.locator('[data-rights-window-close]').click();
        await page.waitForFunction(() => document.querySelector('#rightsManagementWindow').hidden);
        assert.equal(await page.locator('#openRightsManagementButton').getAttribute('aria-expanded'), 'false');
        const animations = await page.evaluate(() => closeAnimations);
        assert.ok(animations.some(entry => entry.id === 'rightsManagementWindow'));
        assert.ok(animations.some(entry => entry.id === 'rightsEditorModal'));
        for (const entry of animations) {
          assert.equal(entry.options.duration, 160);
          assert.equal(entry.frames.at(-1).opacity, 0);
          const [, x, y] = entry.frames.at(-1).transform.match(/^translate\(([-\d.]+)px,([-\d.]+)px\)/);
          assert.ok(Math.abs(Number(x) * entry.scale - (entry.to.left - entry.from.left)) < 1);
          assert.ok(Math.abs(Number(y) * entry.scale - (entry.to.top - entry.from.top)) < 1);
        }
        await page.locator('#openRightsManagementButton').click();
        await page.waitForFunction(() => !document.querySelector('#rightsManagementWindow').hidden);
        assert.equal(await page.locator('[data-rights-sort="role"]').count(), 0);
        const persisted = await page.evaluate(() => ({ storage: preferenceStorage, geometries: geometryStorage }));
        const reload = await instance.newPage({ viewport: { width: 1600, height: 1000 } });
        const reloadErrors = await setup(reload, persisted);
        await reload.locator('#openRightsManagementButton').click();
        await reload.waitForFunction(() => !document.querySelector('#rightsManagementWindow').hidden);
        assert.deepEqual(await reload.evaluate(() => rightsManagementWorkspace.preferences), await page.evaluate(() => rightsManagementWorkspace.preferences));
        assert.equal(await reload.locator('#rightsManagementWindow').evaluate(node => parseInt(node.style.width)), savedGeometry.width);
        await reload.evaluate(async () => { actor = 'BEISPIEL:B:admin'; identity = 'BEISPIEL:B'; preferences.invalidate(); rightsManagementWorkspace.sync(); });
        assert.equal(await reload.locator('#rightsManagementWindow').isVisible(), false);
        assert.equal(await reload.locator('#rightsManagementWindow [data-rights-user]').count(), 0);
        assert.equal(await reload.locator('#rightsEditorPermissions input').count(), 0);
        await reload.evaluate(() => { rightsManagementWorkspace.render({ users: [state.rightsManagement.users[0]], locations: state.locations }); });
        await reload.locator('#openRightsManagementButton').click();
        await reload.waitForFunction(() => !document.querySelector('#rightsManagementWindow').hidden);
        assert.equal(await reload.locator('[data-rights-sort="role"]').count(), 1, 'the second account starts with its own table defaults');
        assert.equal(await reload.evaluate(() => rightsManagementWorkspace.preferences.columnWidths.name), undefined);
        assert.deepEqual(reloadErrors, []);
        await reload.close();
      });
      assert.deepEqual(errors, []);
    } finally { await instance.close(); }
  });

test('rights windows fit mobile, zoom and dark presentation without overflowing the GP viewport',
  { skip: !enabled, timeout: 90000 }, async () => {
    const instance = await browser();
    try {
      const page = await instance.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
      const errors = await setup(page);
      await page.locator('#openRightsManagementButton').click();
      for (const width of [390, 320, 1200]) {
        await page.setViewportSize({ width, height: 844 });
        for (const scale of [1, 1.25]) {
          await page.evaluate(scale => { document.documentElement.style.setProperty('--app-font-scale', String(scale)); document.documentElement.style.setProperty('--app-font-scale-inverse', String(1 / scale)); document.documentElement.dataset.activePageTheme = 'dark'; document.querySelector('#settingsView').dataset.pageTheme = 'dark'; rightsManagementWorkspace.sync(); }, scale);
          await page.waitForTimeout(70);
          const box = await page.locator('#rightsManagementWindow').boundingBox();
          assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= 845, `window fits width ${width}, scale ${scale}`);
          assert.ok(await page.locator('#rightsManagementWindow [data-rights-window-close]').isVisible());
          // Open the genuine rendered profile without requiring the horizontally scrolled action column on mobile.
          await page.evaluate(() => openRightsEditor('153'));
          await page.waitForFunction(() => document.querySelector('#rightsEditorModal').open);
          const profile = await page.locator('#rightsEditorModal').boundingBox();
          assert.ok(profile.x >= -1 && profile.y >= -1 && profile.x + profile.width <= width + 1 && profile.y + profile.height <= 845, `profile fits width ${width}, scale ${scale}`);
          assert.equal(await page.locator('#rightsEditorModal').evaluate(node => node.matches(':modal')), false);
          assert.equal(await page.locator('[data-rights-profile-window-close]').isVisible(), true);
          const close = await page.locator('[data-rights-profile-window-close]').boundingBox();
          assert.ok(close.x >= profile.x && close.x + close.width <= profile.x + profile.width + 1 && close.y + close.height <= profile.y + profile.height, 'profile close button remains inside the visible window');
          const toggle = await page.locator('[data-rights-profile-window-toggle]').boundingBox();
          assert.ok(toggle.x >= profile.x && toggle.x + toggle.width <= profile.x + profile.width + 1, 'profile minimize remains inside the visible window');
          const colors = await page.locator('#rightsManagementWindow').evaluate(node => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
          assert.ok(Number(colors.background.match(/\d+/)[0]) < 80, 'body-sibling management window uses the actual dark theme');
          assert.ok(Number(colors.color.match(/\d+/)[0]) > 160, 'dark window text stays readable');
          await page.locator('[data-rights-profile-window-close]').click();
          await page.waitForFunction(() => !document.querySelector('#rightsEditorModal').open);
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => { document.documentElement.style.setProperty('--app-font-scale', '1'); document.documentElement.style.setProperty('--app-font-scale-inverse', '1'); rightsManagementWorkspace.sync(); document.activeElement?.blur(); });
      await page.waitForTimeout(70);
      await screenshot(page, '03-rechtemanagement-mobil.png');
      await page.evaluate(() => openRightsEditor('153'));
      await page.waitForFunction(() => document.querySelector('#rightsEditorModal').open);
      await page.evaluate(() => document.activeElement?.blur());
      if (process.env.GP_RIGHTS_SCREENSHOT_DIR) {
        fs.writeFileSync(path.join(process.env.GP_RIGHTS_SCREENSHOT_DIR, 'layout-receipt.json'), JSON.stringify(await page.evaluate(() => ({ syntheticOnly: true, productionDataUsed: false, profile: [...document.querySelectorAll('#rightsEditorModal [data-rights-profile-window-title] button')].map(node => { const css = getComputedStyle(node), rect = node.getBoundingClientRect(); return { text: node.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: css.color, font: css.fontSize, visibility: css.visibility, hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML }; }) })), null, 2));
      }
      await screenshot(page, '04-rechteprofil-mobil.png');
      assert.deepEqual(errors, []);
    } finally { await instance.close(); }
  });

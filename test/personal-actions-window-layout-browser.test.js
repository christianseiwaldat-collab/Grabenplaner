'use strict';

// Actual personal-actions markup, app open/close handlers and GP window runtime.
// Only accounts, transport and action rows use local synthetic data.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const repo = path.join(__dirname, '..'), enabled = process.env.GP_WINDOW_BROWSER_TEST === '1';
const html = fs.readFileSync(path.join(repo, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(repo, 'public/app.js'), 'utf8').replace(/\r\n/g, '\n');

function dialogMarkup() {
  const start = html.lastIndexOf('<dialog', html.indexOf('id="personalActionsAdminDialog"'));
  const end = html.indexOf('</dialog>', start);
  assert.ok(start >= 0 && end > start, 'Actual personal-actions dialog exists');
  return html.slice(start, end + '</dialog>'.length);
}
function handler(name) {
  const start = Math.min(...[`function ${name}(`, `async function ${name}(`].map(marker => app.indexOf(marker)).filter(index => index >= 0));
  const end = app.indexOf('\n}', start);
  assert.ok(Number.isFinite(start) && end > start, `Actual ${name} handler exists`);
  return app.slice(start, end + 2);
}
async function setup(page, zoom = 1) {
  const errors = [];page.on('pageerror', error => errors.push(error.message));await page.route('**/*', route => route.abort());
  page.setDefaultTimeout(6000);
  await page.setContent('<div class="app-shell"><aside class="sidebar"><strong>GP · BEISPIEL</strong></aside><main class="main-content"><h1>Lokale Fensterprüfung</h1><button id="personalActionsAdminButton" type="button">Meine Aktionen</button><button id="backgroundButton" type="button">Hintergrund bedienen</button></main></div>' + dialogMarkup());
  for (const file of ['styles.css', 'mobile-refinements.css', 'gp-window.css', 'rights-management-workspace.css']) await page.addStyleTag({content: fs.readFileSync(path.join(repo, 'public', file), 'utf8')});
  for (const file of ['gp-window-preferences.js', 'gp-window.js']) await page.addScriptTag({content: fs.readFileSync(path.join(repo, 'public', file), 'utf8')});
  await page.evaluate(zoom => {
    document.body.style.zoom = String(zoom);
    window.state = {portalSession: {authenticated: true, user: {employeeNumber: 'BEISPIEL-01', isEmployee: true, mustChangePassword: false}}};
    window.elements = {personalActionsAdminDialog: document.getElementById('personalActionsAdminDialog'), personalActionsAdminButton: document.getElementById('personalActionsAdminButton')};
    window.personalActionsOpener = null;window.personalActionsWindow = null;window.fixtureChanges = [];window.fixtureLoads = 0;window.backgroundClicks = 0;
    window.startDashboardWorkspaceActorKey = () => 'BEISPIEL-01';window.syncGpWindows = () => {};
    window.gpWindowManager = {preferences: {activate: async () => {}, value: {windows: {}}, change: (id, geometry) => fixtureChanges.push({id, geometry})}};
    window.salesArticleSearchWindowScale = () => Number(document.body.style.zoom) || 1;
    window.salesArticleSearchWindowBounds = () => GpWindow.viewportBounds(window.visualViewport || {width: innerWidth, height: innerHeight}, salesArticleSearchWindowScale());
    window.loadAdminPersonalActions = async () => {
      fixtureLoads++;
      const list = document.getElementById('personalActionsAdminList');list.replaceChildren();
      for (let number = 1; number <= 24; number++) {
        const row = document.createElement('article');row.className = 'admin-personal-action-row';row.setAttribute('role', 'listitem');
        const copy = document.createElement('div');copy.className = 'admin-personal-action-copy';
        const title = document.createElement('strong');title.textContent = `BEISPIEL ${number} · Änderung gespeichert`;
        const description = document.createElement('p');description.textContent = 'Lokale Beispieldaten für die Prüfung der Fensterdarstellung.';
        copy.append(title, description);const status = document.createElement('span');status.className = 'admin-personal-action-final';status.textContent = 'Keine Gegenaktion verfügbar';row.append(copy, status);list.append(row);
      }
      document.getElementById('personalActionsAdminLoadMore').classList.remove('hidden');
    };
    document.getElementById('backgroundButton').onclick = () => backgroundClicks++;
  }, zoom);
  await page.addScriptTag({content: `${handler('openAdminPersonalActions')}\n${handler('closeAdminPersonalActions')}\ndocument.getElementById('personalActionsAdminButton').addEventListener('click', openAdminPersonalActions);\ndocument.querySelectorAll('[data-close-personal-actions-admin]').forEach(button => button.addEventListener('click', closeAdminPersonalActions));`});
  return errors;
}

test('Personal actions retain a compact one-line title, reachable controls and scrolling through minimize/restore', {skip: !enabled, timeout: 60000}, async t => {
  const {chromium} = require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
  const browser = await chromium.launch({headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? {executablePath: process.env.GP_BROWSER_EXECUTABLE} : {}), args: ['--no-first-run']});
  const results = [];
  try {
    for (const scenario of [{id: 'desktop', width: 1400, height: 900, zoom: 1}, {id: 'mobile', width: 390, height: 844, zoom: 1, touch: true}, {id: 'mobile-zoom', width: 320, height: 740, zoom: 1.25, touch: true}]) {
      await t.test(scenario.id, async () => {
        const page = await browser.newPage({viewport: {width: scenario.width, height: scenario.height}, hasTouch: Boolean(scenario.touch), isMobile: Boolean(scenario.touch)});
        try {
          const errors = await setup(page, scenario.zoom);
          await page.locator('#personalActionsAdminButton').click();
          const dialog = page.locator('#personalActionsAdminDialog'), toggle = dialog.locator('[data-personal-actions-minimize]');await dialog.waitFor();
          const expanded = await dialog.evaluate(node => ({x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, header: node.querySelector('.modal-header').getBoundingClientRect().height,
            bodyOverflow: getComputedStyle(node.querySelector('[data-personal-actions-body]')).overflowY, modal: node.matches(':modal'),
            listOverflow: getComputedStyle(node.querySelector('#personalActionsAdminList')).overflowY, listScroll: node.querySelector('#personalActionsAdminList').scrollHeight > node.querySelector('#personalActionsAdminList').clientHeight}));
          assert.equal(expanded.modal, false);assert.equal(expanded.bodyOverflow, 'auto');assert.equal(expanded.listOverflow, 'auto');assert.equal(expanded.listScroll, true);
          assert.ok(expanded.header <= 44 * scenario.zoom + 1);
          await dialog.locator('#personalActionsAdminList').evaluate(node => {node.scrollTop = node.scrollHeight;});
          assert.ok(await dialog.locator('#personalActionsAdminList').evaluate(node => node.scrollTop > 0));
          await toggle.click();
          const minimized = await dialog.evaluate(node => {
            const box = node.getBoundingClientRect(), header = node.querySelector('.modal-header').getBoundingClientRect(), title = node.querySelector('#personalActionsAdminTitle');
            const controls = [...node.querySelector('.modal-header').querySelectorAll('button')].map(button => {const bounds = button.getBoundingClientRect();return {width: bounds.width, height: bounds.height, inside: bounds.left >= header.left && bounds.right <= header.right + 1 && bounds.top >= header.top && bounds.bottom <= header.bottom + 1};});
            return {x: box.x, y: box.y, height: box.height, width: box.width, titleHeight: title.getBoundingClientRect().height, whiteSpace: getComputedStyle(title).whiteSpace,
              overflow: getComputedStyle(title).textOverflow, bodyHidden: node.querySelector('[data-personal-actions-body]').hidden,
              bodyDisplay: getComputedStyle(node.querySelector('[data-personal-actions-body]')).display, controls, edges: node.querySelectorAll('[data-gp-window-edge]:not([hidden])').length,
              gripCount: node.querySelectorAll('.gp-window-titlebar .gp-window-grip').length, titleFontSize: getComputedStyle(title).fontSize, radius: getComputedStyle(node).borderTopLeftRadius};
          });
          assert.equal(minimized.whiteSpace, 'nowrap');assert.equal(minimized.overflow, 'ellipsis');assert.equal(minimized.bodyHidden, true);assert.equal(minimized.bodyDisplay, 'none');assert.equal(minimized.edges, 0);
          assert.ok(minimized.height <= 46 * scenario.zoom);assert.ok(minimized.titleHeight <= 20 * scenario.zoom + 1);assert.ok(minimized.controls.every(control => control.inside));
          assert.ok(minimized.width <= 260 * scenario.zoom, 'Minimizing also contracts the window width');
          const fit = await page.evaluate(() => {
            const preferred = personalActionsWindow.preferred, bounds = salesArticleSearchWindowBounds();
            return {expanded: GpWindow.fit({...preferred, minimized: false}, bounds), minimized: GpWindow.fit({...preferred, minimized: true}, bounds)};
          });
          if (fit.expanded.x === fit.minimized.x) assert.equal(minimized.x, expanded.x, 'Minimizing keeps x unless viewport fit needs a correction');
          if (fit.expanded.y === fit.minimized.y) assert.equal(minimized.y, expanded.y, 'Minimizing keeps y unless viewport fit needs a correction');
          assert.ok(minimized.controls.every(control => Math.abs(control.width - 38 * scenario.zoom) <= 1 && Math.abs(control.height - 38 * scenario.zoom) <= 1), 'Every title control uses the shared ArticleSearch 38 px target');
          assert.equal(minimized.gripCount, 1);assert.equal(minimized.titleFontSize, '12px');assert.equal(minimized.radius, '12px');
          if (process.env.GP_PERSONAL_ACTIONS_QA_OUTPUT) {fs.mkdirSync(process.env.GP_PERSONAL_ACTIONS_QA_OUTPUT, {recursive: true});await page.screenshot({path: path.join(process.env.GP_PERSONAL_ACTIONS_QA_OUTPUT, `personal-actions-${scenario.id}-minimized.png`)});}
          await toggle.click();assert.equal(await dialog.evaluate(node => node.classList.contains('is-minimized')), false);
          assert.equal(await dialog.locator('[data-personal-actions-body]').isVisible(), true);
          const restored = await dialog.evaluate(node => {const box = node.getBoundingClientRect();return {x: box.x, y: box.y, width: box.width, height: box.height};});
          assert.equal(restored.width, expanded.width, 'Restoring returns the exact expanded width');
          assert.equal(restored.height, expanded.height, 'Restoring returns the exact expanded height');
          assert.equal(restored.x, expanded.x);assert.equal(restored.y, expanded.y);
          if (process.env.GP_PERSONAL_ACTIONS_QA_OUTPUT && scenario.id === 'desktop') await page.screenshot({path: path.join(process.env.GP_PERSONAL_ACTIONS_QA_OUTPUT, 'personal-actions-desktop-expanded.png')});
          await dialog.locator('.modal-header [data-close-personal-actions-admin]').click();await page.waitForFunction(() => !document.getElementById('personalActionsAdminDialog').open);
          await page.locator('#backgroundButton').click();assert.equal(await page.evaluate(() => backgroundClicks), 1);
          assert.deepEqual(errors, []);results.push({...scenario, expanded, minimized, restored, pageErrors: errors});
        } finally {await page.close();}
      });
    }
    if (process.env.GP_PERSONAL_ACTIONS_QA_OUTPUT) fs.writeFileSync(path.join(process.env.GP_PERSONAL_ACTIONS_QA_OUTPUT, 'personal-actions-layout-receipt.json'), JSON.stringify({finishedAt: new Date().toISOString(), fixture: 'Actual markup, styles, app handlers and GP window controller; synthetic data', results}, null, 2));
  } finally {await browser.close();}
});

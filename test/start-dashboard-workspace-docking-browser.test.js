'use strict';
// Real dashboard markup with isolated geometry and synthetic preferences only.
const fs = require('node:fs'), path = require('node:path'), test = require('node:test'), assert = require('node:assert/strict');
const repo = path.join(__dirname, '..'), html = fs.readFileSync(path.join(repo, 'public/index.html'), 'utf8');
const start = html.indexOf('<section id="startDashboardView"'), end = html.indexOf('<section id="filialAdministrationView"', start);
const browserSettings = {skip: process.env.GP_DASHBOARD_BROWSER_TEST !== '1', timeout: 60000};
async function launch() {
  const {chromium} = require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
  return chromium.launch({headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? {executablePath: process.env.GP_BROWSER_EXECUTABLE} : {}), args: ['--no-first-run']});
}
async function setup(page, preferences) {
  await page.setContent('<style>' + ['styles.css', 'gp-window.css', 'start-dashboard-workspace.css'].map(name => fs.readFileSync(path.join(repo, 'public', name), 'utf8')).join('\n') + '</style>' + html.slice(start, end));
  await page.addScriptTag({path: path.join(repo, 'public/gp-window-preferences.js')});
  await page.addScriptTag({path: path.join(repo, 'public/gp-window.js')});
  await page.addScriptTag({path: path.join(repo, 'public/start-dashboard-workspace-geometry.js')});
  await page.evaluate(preferences => {
    const root = document.querySelector('#startDashboardView');
    root.classList.add('active'); root.querySelectorAll('.hidden').forEach(node => node.classList.remove('hidden'));
    document.querySelector('#startDashboardCustomizer').classList.add('hidden');
    window.preferences = preferences; window.writes = []; window.actor = 'A'; window.ready = true;
    window.fields = new Map();
    for (const [type, selector, titleSelector] of [
      ['group', '[data-start-dashboard-group]', ':scope > .start-dashboard-group-link strong'],
      ['card', '[data-start-dashboard-card]', ':scope > .start-dashboard-card-link strong'],
      ['widget', '[data-start-dashboard-widget]', ':scope > span']
    ]) for (const element of root.querySelectorAll(selector)) {
      const id = type + ':' + element.dataset['startDashboard' + type[0].toUpperCase() + type.slice(1)];
      const menu = document.createElement('button'); menu.type = 'button'; menu.className = 'start-dashboard-field-menu-button'; menu.textContent = '⋯';
      element.classList.add('start-dashboard-workspace-field'); element.append(menu);
      fields.set(id, {id, element, title: element.querySelector(titleSelector), menu});
    }
    window.allowed = new Set(fields.keys());
    window.geometry = StartDashboardWorkspaceGeometry.create({root, fields, value: () => structuredClone(window.preferences),
      key: () => actor, ready: () => ready, usable: () => true, allowed: field => allowed.has(field.id),
      change: value => {writes.push(structuredClone(value)); window.preferences = structuredClone(value); geometry.sync(); return Promise.resolve(true);}});
  }, preferences);
}
async function pointerDrag(page, id, destination, cancel = false) {
  const handle = page.locator(`[data-dashboard-field-move="${id}"]`), box = await handle.boundingBox();
  const origin = {x: box.x + Math.min(20, box.width / 2), y: box.y + Math.min(20, box.height / 2)};
  await page.evaluate(({id, origin, destination, cancel}) => {
    const handle = document.querySelector(`[data-dashboard-field-move="${id}"]`);
    handle.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, pointerId: 61, button: 0, isPrimary: true, clientX: origin.x, clientY: origin.y}));
    window.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, pointerId: 61, clientX: destination.x, clientY: destination.y}));
    if (cancel !== 'pending') window.dispatchEvent(new PointerEvent(cancel ? 'pointercancel' : 'pointerup', {bubbles: true, pointerId: 61}));
  }, {id, origin, destination, cancel});
}
async function parentPoint(page, id) {
  return page.evaluate(id => {const box = fields.get(id).element.getBoundingClientRect(); return {x: box.x + box.width / 2, y: box.y + 25};}, id);
}

test('detached dashboard cards return only to their permitted original group and retain content preferences', browserSettings, async () => {
  const browser = await launch(), page = await browser.newPage({viewport: {width: 1600, height: 1000}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const detached = {version: 1, fields: {'card:vacation': {title: 'Meine Urlaube', description: 'Persönlicher Blick', color: 'blue', geometry: {x: 760, y: 80, width: 280, height: 240}}}};
  try {
    await setup(page, detached);
    assert.equal(await page.evaluate(() => geometry.canDock('card:vacation')), true);
    assert.equal(await page.evaluate(() => geometry.canDock('group:branch')), false);
    await pointerDrag(page, 'card:vacation', await parentPoint(page, 'group:branch'), 'pending');
    assert.equal(await page.locator('#startDashboardBranchGroup').evaluate(node => node.classList.contains('start-dashboard-dock-target')), true);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, pointerId: 61})));
    assert.deepEqual(await page.evaluate(() => preferences.fields['card:vacation']), {title: 'Meine Urlaube', description: 'Persönlicher Blick', color: 'blue'});
    assert.equal(await page.locator('[data-dashboard-floating="card:vacation"]').count(), 0);
    assert.equal(await page.locator('#startDashboardBranchGroup [data-start-dashboard-card="vacation"]').count(), 1);
    assert.equal(await page.locator('.start-dashboard-dock-target').count(), 0);

    await setup(page, {version: 1, fields: {}});
    const originalPoint = await parentPoint(page, 'group:branch');
    await pointerDrag(page, 'card:vacation', {x: originalPoint.x + 30, y: originalPoint.y + 90});
    assert.ok(await page.evaluate(() => preferences.fields['card:vacation']?.geometry), 'an initial drag-out stays detached even while the pointer remains over the group');
    assert.equal(await page.locator('.start-dashboard-dock-target').count(), 0);

    await setup(page, {version: 1, fields: {'card:vacation': {geometry: {x: 80, y: 80, width: 250, height: 180}}}});
    const overlapping = await page.locator('[data-dashboard-field-move="card:vacation"]').boundingBox();
    await pointerDrag(page, 'card:vacation', {x: overlapping.x + 40, y: overlapping.y + 30});
    assert.ok(await page.evaluate(() => preferences.fields['card:vacation']?.geometry), 'nudging an overlapping detached card is a normal move');

    await setup(page, detached);
    await pointerDrag(page, 'card:vacation', await parentPoint(page, 'group:sales'));
    assert.ok(await page.evaluate(() => preferences.fields['card:vacation']?.geometry), 'a different group is not an authorized docking target');
    assert.equal(await page.locator('.start-dashboard-dock-target').count(), 0);

    await setup(page, detached);
    await page.evaluate(() => {preferences.fields['group:branch'] = {hidden: true}; geometry.sync();});
    assert.equal(await page.evaluate(() => geometry.canDock('card:vacation')), false);
    assert.equal(await page.evaluate(() => geometry.dock('card:vacation')), false);
    assert.equal(await page.evaluate(() => writes.length), 0);
    await page.evaluate(() => {delete preferences.fields['group:branch']; allowed.delete('group:branch'); geometry.sync();});
    assert.equal(await page.evaluate(() => geometry.canDock('card:vacation')), false);
    await page.evaluate(() => {allowed.add('group:branch'); geometry.sync();});
    await page.evaluate(() => {ready = false; geometry.sync();});
    assert.equal(await page.evaluate(() => geometry.canDock('card:vacation')), false);
    assert.equal(await page.evaluate(() => geometry.dock('card:vacation')), false);
    await page.evaluate(() => {ready = true; geometry.sync();});
    await pointerDrag(page, 'card:vacation', await parentPoint(page, 'group:branch'), true);
    assert.equal(await page.evaluate(() => writes.length), 0);
    assert.deepEqual(await page.evaluate(() => preferences), detached);

    await pointerDrag(page, 'card:vacation', await parentPoint(page, 'group:branch'), 'pending');
    await page.evaluate(() => {actor = 'B'; geometry.sync(); window.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, pointerId: 61}));});
    assert.equal(await page.evaluate(() => writes.length), 0);
    assert.equal(await page.locator('.start-dashboard-dock-target').count(), 0);

    await setup(page, detached);
    await page.setViewportSize({width: 390, height: 844});
    await page.waitForFunction(() => document.querySelectorAll('[data-dashboard-floating]').length === 0);
    assert.equal(await page.locator('[data-dashboard-floating]').count(), 0);
    assert.equal(await page.evaluate(() => geometry.canDock('card:vacation')), true);
    assert.equal(await page.evaluate(() => geometry.dock('card:vacation')), true);
    assert.equal(await page.evaluate(() => preferences.fields['card:vacation'].geometry), undefined);
    assert.equal(await page.evaluate(() => preferences.fields['card:vacation'].color), 'blue');
    assert.deepEqual(errors, []);
  } finally {await browser.close();}
});

test('floating dashboard chrome is separate from scrolled contents and nested child docking survives scaled coordinates', browserSettings, async () => {
  const browser = await launch(), page = await browser.newPage({viewport: {width: 1600, height: 1000}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const initial = {version: 1, fields: {'group:branch': {geometry: {x: 0, y: 0, width: 440, height: 300}}, 'card:vacation': {geometry: {x: 500, y: 40, width: 350, height: 220}}, 'widget:branchAbsences': {title: 'Abwesenheiten', geometry: {x: 1000, y: 350, width: 250, height: 160}}}};
    await setup(page, initial);
    const layout = await page.evaluate(() => {
      const field = fields.get('group:branch'), header = field.element.querySelector(':scope > .start-dashboard-group-link'), body = field.element.querySelector(':scope > .start-dashboard-field-scrollbody');
      const arrow = header.querySelector('b'), menu = field.menu;
      const before = header.getBoundingClientRect(); body.scrollTop = 80;
      const after = header.getBoundingClientRect(), arrowBox = arrow.getBoundingClientRect(), menuBox = menu.getBoundingClientRect(), bodyBox = body.getBoundingClientRect();
      return {headerSteady: before.top === after.top, bodyBelowHeader: bodyBox.top >= after.bottom - 1, bodyScrolls: body.scrollHeight > body.clientHeight,
        chromeGap: menuBox.left - arrowBox.right, menuInside: menuBox.right <= after.right, wrapperCount: field.element.querySelectorAll(':scope > .start-dashboard-field-scrollbody').length};
    });
    assert.equal(layout.headerSteady, true); assert.equal(layout.bodyBelowHeader, true); assert.equal(layout.bodyScrolls, true);
    assert.ok(layout.chromeGap >= 4, 'navigation arrow and field menu have distinct hit areas');
    assert.equal(layout.menuInside, true); assert.equal(layout.wrapperCount, 1);
    if (process.env.GP_DASHBOARD_SCREENSHOT_DIR) await page.locator('[data-dashboard-floating="group:branch"]').screenshot({path: path.join(process.env.GP_DASHBOARD_SCREENSHOT_DIR, 'dashboard-floating-header.png')});
    await page.evaluate(() => {geometry.canvas.style.zoom = '1.2'; geometry.canvas.style.transform = 'scale(.85)'; geometry.canvas.style.transformOrigin = 'top left'; geometry.sync();});
    await pointerDrag(page, 'widget:branchAbsences', await parentPoint(page, 'card:vacation'));
    assert.deepEqual(await page.evaluate(() => preferences.fields['widget:branchAbsences']), {title: 'Abwesenheiten'});
    assert.equal(await page.locator('[data-start-dashboard-card="vacation"] [data-start-dashboard-widget="branchAbsences"]').count(), 1);
    assert.deepEqual(await page.evaluate(() => preferences.fields['card:vacation'].geometry), initial.fields['card:vacation'].geometry);
    assert.equal(await page.locator('[data-dashboard-floating="card:vacation"] > [data-start-dashboard-card] > .start-dashboard-field-scrollbody').count(), 1);
    await page.evaluate(() => {geometry.reset('card:vacation'); geometry.reset('group:branch');});
    assert.equal(await page.locator('.start-dashboard-field-scrollbody').count(), 0);
    assert.equal(await page.locator('#startDashboardBranchGroup > .start-dashboard-card-list > [data-start-dashboard-card="vacation"]').count(), 1);
    await page.evaluate(() => geometry.destroy());
    assert.equal(await page.locator('.start-dashboard-workspace-canvas,.start-dashboard-field-resize,.start-dashboard-dock-target').count(), 0);
    assert.deepEqual(errors, []);
  } finally {await browser.close();}
});

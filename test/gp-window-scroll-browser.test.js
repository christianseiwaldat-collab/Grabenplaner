'use strict';
// Real browser wheel input; synthetic records only, without an application server.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PRIVACY_ORGANIZATION_CATALOG } = require('../lib/privacy-organization');
const root = path.resolve(__dirname, '..');

function browserTest(name, run) {
  test(name, { skip: process.env.GP_WINDOW_BROWSER_TEST !== '1', timeout: 30000 }, async () => {
    const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
    const browser = await chromium.launch({ headless: true,
      ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
      page.setDefaultTimeout(4000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.abort());
      await page.setContent('<main id="privacy"></main><div id="background-space" style="height:2200px"></div>');
      for (const file of ['styles.css', 'privacy-organization.css', 'gp-print-window.css', 'gp-window.css']) {
        await page.addStyleTag({ path: path.join(root, 'public', file) });
      }
      for (const file of ['gp-window-preferences.js', 'gp-window.js', 'privacy-organization.js']) {
        await page.addScriptTag({ path: path.join(root, 'public', file) });
      }
      await page.evaluate(() => {
        window.manager = GpWindow.installDocument(document, {
          actorKey: () => 'SYNTHETIC-SCROLL', canUse: () => true,
          scale: () => parseFloat(getComputedStyle(document.body).zoom) || 1,
          readPreferences: async () => ({ version: 1, windows: {} }), writePreferences: async () => {},
        });
      });
      await run(page);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

async function privacyEditor(page, readOnly = false) {
  await page.evaluate(async ({ catalog, readOnly }) => {
    const user = { employeeNumber: 'SYNTHETIC-SCROLL', role: 'hr', isEmployee: true,
      accountType: 'employee', sessionKind: 'employee', permissions: ['privacy_organization:read', 'privacy_organization:manage'] };
    const values = { title: 'Synthetische Verarbeitung' };
    for (const field of catalog.kinds.find(item => item.id === 'activity').fields) {
      if (field.type === 'textarea') values[field.key] = readOnly ? 'Synthetische Prozessangabe.\n'.repeat(12) : '';
    }
    const record = { id: 'SYNTHETIC-ACTIVITY', kind: 'activity', revision: 1, status: 'draft',
      title: values.title, payload: values, readiness: { ready: false, issues: [] } };
    const payload = { revision: 1, capabilities: { read: true, manage: true }, catalog, records: [record] };
    window.privacy = GrabenplanerPrivacyOrganization.mount(document.getElementById('privacy'), {
      user, api: async (_url, options) => { if (options?.method) throw new Error('No writes in scroll fixture'); return payload; },
    });
    await window.privacy.activate('data-map');
  }, { catalog: PRIVACY_ORGANIZATION_CATALOG, readOnly });
  await page.locator(readOnly ? '[data-po-action="read"]' : '[data-po-action="new"]').first().click();
  await page.waitForFunction(() => document.querySelector('[data-po-editor] > .gp-dialog-body'));
  await page.evaluate(() => {
    const dialog = document.querySelector('[data-po-editor]');
    for (const section of dialog.querySelectorAll('details')) section.open = true;
    GpWindow.prepare(dialog).set({ x: 120, y: 70, width: 760, height: 470, minimized: false });
    dialog.querySelector('.gp-dialog-body').scrollTop = 0;
    window.scrollTo(0, 0);
  });
  const dialog = page.locator('[data-po-editor]');
  assert.equal(await dialog.evaluate(node => node.matches(':modal')), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 500), true);
  return dialog;
}

// Intersect with the actual window viewport; never auto-scroll the locator to
// fabricate the wheel result or accidentally hit a hidden portion of a child.
async function wheel(page, locator, deltaX, deltaY) {
  const point = await locator.evaluate(node => {
    const box = node.getBoundingClientRect();
    const boundary = node.closest('.gp-window')?.getBoundingClientRect();
    const left = Math.max(box.left, boundary?.left || 0, 0);
    const right = Math.min(box.right, boundary?.right || innerWidth, innerWidth);
    const top = Math.max(box.top, (boundary?.top || 0) + 46, 0);
    const bottom = Math.min(box.bottom, boundary?.bottom || innerHeight, innerHeight);
    if (right - left < 4 || bottom - top < 4) throw new Error('Wheel target is not visible');
    const x = (left + right) / 2, y = (top + bottom) / 2;
    if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Wheel target is covered');
    return { x, y };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(deltaX, deltaY);
}

async function moved(locator, axis, before, message, direction = 1) {
  const until = Date.now() + 1800;
  let value = before, previous = before, stableSince = Date.now();
  while (Date.now() < until) {
    value = await locator.evaluate((node, key) => node[key], axis);
    if (value !== previous) { previous = value; stableSince = Date.now(); }
    if ((value - before) * direction > 1 && Date.now() - stableSince >= 180) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail(`${message}; before=${before}, after=${value}; expected settled movement`);
}

browserTest('privacy editor: wheel over a label reaches the outer GP window', async page => {
  const dialog = await privacyEditor(page), body = dialog.locator(':scope > .gp-dialog-body');
  assert.equal(await body.evaluate(node => node.scrollHeight > node.clientHeight), true);
  await wheel(page, dialog.locator('label:has(input[name="title"]) > span').first(), 0, 180);
  const down = await moved(body, 'scrollTop', 0, 'Label wheel must scroll the visible outer window');
  await wheel(page, body, 0, -120);
  await moved(body, 'scrollTop', down, 'Negative wheel must scroll the window upward', -1);
  assert.equal(await page.evaluate(() => scrollY), 0);
});

browserTest('privacy editor: narrow viewport and 125% zoom preserve label wheel scrolling', async page => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.evaluate(() => { document.body.style.zoom = '1.25'; });
  const dialog = await privacyEditor(page), body = dialog.locator(':scope > .gp-dialog-body');
  await wheel(page, dialog.locator('label:has(input[name="title"]) > span').first(), 0, 180);
  await moved(body, 'scrollTop', 0, 'Narrow zoomed window must receive label wheel');
  assert.equal(await page.evaluate(() => scrollY), 0);
});

browserTest('privacy editor: an empty textarea does not swallow the outer window wheel', async page => {
  const dialog = await privacyEditor(page), body = dialog.locator(':scope > .gp-dialog-body');
  const textarea = dialog.locator('textarea[name="purpose"]');
  assert.equal(await textarea.inputValue(), '');
  assert.equal(await textarea.evaluate(node => node.scrollHeight > node.clientHeight + 1), false);
  await wheel(page, textarea, 0, 180);
  await moved(body, 'scrollTop', 0, 'An empty textarea must pass wheel to the GP window');
  assert.equal(await page.evaluate(() => scrollY), 0);
});

browserTest('privacy editor: textarea scrolls first, then passes wheel at its boundary', async page => {
  const dialog = await privacyEditor(page), body = dialog.locator(':scope > .gp-dialog-body');
  const textarea = dialog.locator('textarea[name="purpose"]');
  await textarea.fill('Synthetischer Entwurf.\n'.repeat(50));
  await textarea.evaluate(node => { node.scrollTop = 0; });
  await wheel(page, textarea, 0, 100);
  await moved(textarea, 'scrollTop', 0, 'Long textarea must retain native internal scrolling');
  assert.equal(await body.evaluate(node => node.scrollTop), 0);
  await textarea.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await wheel(page, textarea, 0, 180);
  await moved(body, 'scrollTop', 0, 'Textarea boundary must pass wheel to outer GP window');
  assert.equal(await page.evaluate(() => scrollY), 0);
  assert.equal(await textarea.inputValue(), 'Synthetischer Entwurf.\n'.repeat(50));
});

browserTest('privacy read mode: inner boundary passes wheel outward but the page stays still', async page => {
  const dialog = await privacyEditor(page, true), body = dialog.locator(':scope > .gp-dialog-body');
  const inner = dialog.locator('.privacy-org-editor-body');
  assert.equal(await inner.evaluate(node => node.scrollHeight > node.clientHeight + 1), true);
  assert.equal(await body.evaluate(node => node.scrollHeight > node.clientHeight + 1), true);
  await inner.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await wheel(page, inner, 0, 180);
  await moved(body, 'scrollTop', 0, 'Read-only inner boundary must pass wheel outward');
  await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await wheel(page, inner, 0, 400);
  await page.waitForTimeout(160);
  assert.equal(await page.evaluate(() => scrollY), 0, 'Wheel must stop at the outer window boundary');
});

async function manualWindow(page, overflow) {
  await page.evaluate(overflow => {
    const panel = document.createElement('section');
    panel.id = 'manual'; panel.className = 'gp-print-window';
    panel.innerHTML = '<header data-title><strong>Synthetisches Druckfenster</strong></header><div data-gp-print-body><div class="gp-print-grid"><form><div class="sales-article-table-scroll" style="flex:none"><table style="width:1000px"><tbody><tr><td>Synthetische breite Tabelle</td><td>Letzte Spalte</td></tr></tbody></table></div><div style="height:1100px;flex:none">Lange Fachoptionen</div></form><section>Vorschau</section></div></div>';
    document.body.append(panel);
    const body = panel.querySelector('[data-gp-print-body]'); body.style.overflow = overflow;
    window.manual = GpWindow.attach(panel, { title: panel.querySelector('[data-title]'), body,
      active: true, geometry: { x: 100, y: 60, width: 760, height: 430, minimized: false } });
  }, overflow);
  return page.locator('#manual');
}

for (const overflow of ['hidden', 'auto']) {
  browserTest(`manual attach (${overflow} body): inner table retains horizontal scrolling and outer boundary`, async page => {
    const panel = await manualWindow(page, overflow), form = panel.locator('form'), table = panel.locator('.sales-article-table-scroll');
    assert.equal(await form.evaluate(node => node.scrollHeight > node.clientHeight + 1), true, 'Fixture must contain vertically scrollable options');
    assert.equal(await table.evaluate(node => node.scrollHeight > node.clientHeight + 1), false, 'Fixture table must only overflow horizontally');
    await wheel(page, table, 150, 0);
    await moved(table, 'scrollLeft', 0, 'Horizontal table scrolling must remain native');
    await wheel(page, table, 0, 180);
    await moved(form, 'scrollTop', 0, 'Nonoverflowing table must pass vertical wheel to option form');
    await form.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await wheel(page, form, 0, 400);
    await page.waitForTimeout(160);
    assert.equal(await page.evaluate(() => scrollY), 0, 'Manual window must contain boundary wheel');
  });
}

browserTest('nested attached GP windows keep the inner boundary independent of the outer window', async page => {
  const outer = await manualWindow(page, 'auto');
  await page.evaluate(() => {
    const parent = document.querySelector('#manual [data-gp-print-body]');
    parent.innerHTML = '<div style="height:1400px;flex:none">Langer äußerer Fensterinhalt</div>';
    const nested = document.createElement('section');
    nested.id = 'nested'; nested.className = 'gp-print-window';
    nested.innerHTML = '<header data-title><strong>Inneres Fenster</strong></header><main style="flex:1;min-height:0;overflow:auto"><div style="height:1200px">Synthetischer langer Inhalt</div></main>';
    parent.append(nested);
    window.nestedWindow = GpWindow.attach(nested, { title: nested.querySelector('header'), body: nested.querySelector('main'),
      active: true, geometry: { x: 320, y: 100, width: 480, height: 320, minimized: false } });
  });
  const inner = page.locator('#nested main'), outerBody = outer.locator('[data-gp-print-body]');
  assert.equal(await outerBody.evaluate(node => node.scrollHeight > node.clientHeight + 1), true,
    'Outer body must itself be scrollable so a lost inner boundary would move it');
  assert.equal(await inner.evaluate(node => getComputedStyle(node).overscrollBehaviorY), 'contain');
  await wheel(page, inner, 0, 180);
  await moved(inner, 'scrollTop', 0, 'Inner attached window must remain independently scrollable');
  await inner.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await wheel(page, inner, 0, 500);
  await page.waitForTimeout(160);
  assert.equal(await outerBody.evaluate(node => node.scrollTop), 0);
  assert.equal(await page.evaluate(() => scrollY), 0);
});

browserTest('native confirmation above a workspace receives wheel without moving the workspace or page', async page => {
  const workspace = await privacyEditor(page), underlying = workspace.locator(':scope > .gp-dialog-body');
  await page.evaluate(() => {
    const dialog = document.createElement('dialog'); dialog.id = 'confirmation';
    dialog.innerHTML = '<form><h2>Synthetische Pflichtbestätigung</h2><div style="height:1000px">Langer Pflichttext</div><button>Bestätigen</button></form>';
    document.body.append(dialog); GpWindow.prepare(dialog); dialog.showModal();
  });
  await page.waitForFunction(() => document.querySelector('#confirmation > .gp-dialog-body'));
  await page.evaluate(() => GpWindow.prepare(document.getElementById('confirmation')).set({ x: 160, y: 100, width: 620, height: 360, minimized: false }));
  const dialog = page.locator('#confirmation'), body = dialog.locator(':scope > .gp-dialog-body');
  assert.equal(await dialog.evaluate(node => node.matches(':modal')), true);
  await wheel(page, body, 0, 180);
  await moved(body, 'scrollTop', 0, 'Top native modal must receive wheel');
  await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await wheel(page, body, 0, 500);
  await page.waitForTimeout(160);
  assert.equal(await underlying.evaluate(node => node.scrollTop), 0);
  assert.equal(await page.evaluate(() => scrollY), 0);
});

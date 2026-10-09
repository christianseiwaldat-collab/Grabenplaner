'use strict';
// Real report markup and client code, with an isolated in-memory API and example data.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const repo = path.resolve(__dirname, '..');

test('compact sales workspace preserves report choices, validation and graphic mode', {
  skip:process.env.GP_SALES_ANALYTICS_BROWSER_TEST !== '1', timeout:60000,
}, async () => {
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
  const browser = await chromium.launch({ headless:true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath:process.env.GP_BROWSER_EXECUTABLE } : {}), args:['--no-first-run'] });
  try {
    const page = await browser.newPage({ viewport:{ width:1600, height:1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    const source = fs.readFileSync(path.join(repo, 'public/index.html'), 'utf8');
    const start = source.indexOf('<section id="salesAnalyticsView"'), end = source.indexOf('<section id="personnelView"', start);
    const styles = ['styles.css', 'sales-analytics-workspace.css'].map(file => fs.readFileSync(path.join(repo, 'public', file), 'utf8')).join('\n');
    await page.setContent(`<style>${styles}\n.sidebar h2{font-size:17px;color:white}.synthetic-preview{position:absolute;right:34px;top:14px;font-size:9px;color:var(--muted)}</style><div class="app-shell"><aside class="sidebar"><h2>Grabenplaner</h2><div class="sidebar-session"><div class="sidebar-session-copy"><strong>BEISPIEL · Filialleitung</strong><span>Lokale Designvorschau</span></div></div><nav class="main-nav"><button class="nav-item">Dashboard</button><button class="nav-item">Filialverwaltung</button><button class="nav-item">Personal</button><button class="nav-item active">Verkaufsanalysen</button><button class="nav-item">Artikelstamm</button><button class="nav-item">Einkauf &amp; Bestand</button></nav></aside><main class="main-content"><span class="synthetic-preview">Vorschau · ausschließlich Beispieldaten</span>${source.slice(start, end)}</main></div>`);
    await page.evaluate(() => document.getElementById('salesAnalyticsView').classList.add('active'));
    await page.addScriptTag({ path:path.join(repo, 'public/sales-report-controls.js') });
    await page.addScriptTag({ path:path.join(repo, 'public/sales-report-jobs.js') });
    await page.evaluate(async () => {
      const context = { today:'2026-10-08', projection:{ read:true, sellers:true, margin:true }, marginStatus:'confirmed', source:{ label:'Kassendaten · BEISPIEL' },
        locations:[{ id:'05', label:'05 · Beispiel West' }, { id:'11', label:'11 · Beispiel Mitte' }, { id:'18', label:'18 · Beispiel Ost' }],
        sellers:[{ id:'101', label:'101 · Anna' }, { id:'102', label:'102 · Ben' }, { id:'103', label:'103 · Chris' }],
        merchandiseGroups:[{ id:'101', label:'101 · Digitale Kameras' }, { id:'202', label:'202 · Objektive' }, { id:'301', label:'301 · Ferngläser' }],
        productGroups:[{ id:'30101', label:'30101 · Ferngläser' }, { id:'10101', label:'10101 · Systemkameras' }],
        manufacturers:[{ id:'Example A', label:'Example A' }, { id:'Example B', label:'Example B' }],
        metrics:[{ id:'netRevenue', label:'Umsatz netto' }, { id:'quantity', label:'Stückzahl' }, { id:'receiptCount', label:'Belege' }, { id:'grossMargin', label:'Rohertrag' }, { id:'grossMarginPercent', label:'Rohertrag in %' }, { id:'averageReceipt', label:'Durchschnittsbon' }],
        dimensions:[{ id:'productGroup', label:'Sortimentsgruppe' }, { id:'manufacturer', label:'Hersteller' }, { id:'location', label:'Filiale' }, { id:'seller', label:'MA' }] };
      window.salesRequests = [];
      window.reportApi = async (url, options = {}) => {
        if (options.method === 'POST') { salesRequests.push({ url, body:JSON.parse(options.body) }); return {}; }
        if (url === '/api/sales-report-jobs/context') return context;
        if (url === '/api/sales-report-jobs' || url === '/api/sales-report-templates') return [];
        throw Error('Unexpected mock URL: ' + url);
      };
      window.reportUi = createSalesReportJobUi({ api:reportApi, visible:() => true });
      await reportUi.refresh();
    });
    const screenshot = async name => {
      if (!process.env.GP_SALES_ANALYTICS_SCREENSHOTS) return;
      fs.mkdirSync(process.env.GP_SALES_ANALYTICS_SCREENSHOTS, { recursive:true });
      await page.mouse.move(250, 100);
      await page.waitForTimeout(180);
      await page.screenshot({ path:path.join(process.env.GP_SALES_ANALYTICS_SCREENSHOTS, name), fullPage:true });
    };
    assert.equal(await page.locator('#salesAnalyticsRequestForm > details[open]').count(), 0);
    assert.equal(await page.locator('#salesReportJobSubmit').isVisible(), true);
    assert.equal(await page.locator('#salesReportJobSubmit').isEnabled(), true);
    await screenshot('01-sales-analytics-compact-light.png');
    const initialHeight = (await page.locator('#salesAnalyticsCreatePanel').boundingBox()).height;
    assert.ok(initialHeight < 750, `Initial criteria stay compact (${initialHeight}px)`);
    assert.ok(await page.locator('#salesReportJobFrom').isVisible());
    assert.ok(await page.locator('#salesReportJobLocations').isVisible());
    assert.ok(await page.locator('#salesReportJobMetrics').isVisible());
    await page.locator('#salesAnalyticsRequestQuery').fill('BEISPIEL · Ferngläser Oktober');
    const scope = page.locator('.sales-report-scope-disclosure');
    await scope.locator('> summary').click();
    const manufacturers = page.locator('.sales-report-filter-disclosure').filter({ has:page.locator('#salesReportJobManufacturers') });
    await manufacturers.locator('> summary').click();
    await page.locator('#salesReportJobManufacturers input[type="checkbox"]').first().check();
    await page.getByRole('button', { name:'Hersteller / Marke · Hinzufügen', exact:true }).click();
    await page.waitForFunction(() => document.querySelector('.sales-report-scope-disclosure > summary small').textContent.includes('Hersteller / Marke: 1'));
    await screenshot('02-sales-analytics-filter-detail.png');
    const sellers = page.locator('.sales-report-filter-disclosure').filter({ has:page.locator('#salesReportSellerField') });
    await sellers.locator('> summary').click();
    await page.locator('#salesReportJobSellerExtra').fill('888, 888');
    await page.waitForFunction(() => document.querySelector('.sales-report-scope-disclosure > summary small').textContent.includes('MA (Positionsverkäufer): 1'));
    await sellers.locator('> summary').click();
    await scope.locator('> summary').click();
    await page.locator('#salesReportJobSubmit').click();
    await page.waitForFunction(() => salesRequests.length === 1);
    const report = await page.evaluate(() => salesRequests[0].body);
    assert.deepEqual(report.query.manufacturerIds, ['Example A']);
    assert.deepEqual(report.query.locationIds, ['05', '11', '18']);
    assert.deepEqual(report.query.metrics, ['netRevenue', 'quantity', 'receiptCount']);
    assert.deepEqual(report.query.sellerIds, ['888']);
    assert.equal(report.query.dateFrom, '2026-01-01');
    assert.equal(report.query.comparisonFrom, '2025-01-01');
    assert.equal(report.query.comparisonTo, '2025-10-08');
    // Native validation must expose a missing required field even inside a closed disclosure.
    await page.evaluate(() => { document.querySelector('#salesReportJobComparisonFrom').value = ''; document.querySelector('#salesReportJobComparisonFrom').closest('details').open = false; document.querySelector('#salesAnalyticsRequestForm').reportValidity(); });
    assert.equal(await page.locator('#salesReportJobComparisonFrom').isVisible(), true);
    await page.evaluate(() => { document.querySelector('#salesReportJobComparisonFrom').value = '2025-01-01'; document.querySelector('#salesReportJobComparisonFrom').closest('details').open = false; });
    await page.evaluate(() => { document.documentElement.dataset.activePageTheme = 'dark'; document.getElementById('salesAnalyticsView').dataset.pageTheme = 'dark'; });
    await screenshot('03-sales-analytics-compact-dark.png');
    await page.evaluate(() => {
      document.getElementById('salesAnalyticsCreatePanel').hidden = true;
      document.getElementById('salesAnalyticsGraphicsPanel').hidden = false;
      reportUi.setMode('graphic');
      for (const tab of document.querySelectorAll('[data-sales-analytics-tab]')) { const active = tab.dataset.salesAnalyticsTab === 'graphics'; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); }
    });
    assert.equal(await page.locator('#salesReportJobComparisonFrom').isVisible(), false);
    assert.equal(await page.locator('#salesReportJobComparisonFrom').isDisabled(), true);
    assert.equal(await page.locator('#salesGraphicMetric').isVisible(), true);
    await page.locator('#salesReportJobSubmit').click();
    await page.waitForFunction(() => salesRequests.length === 2);
    assert.equal((await page.evaluate(() => salesRequests[1].body)).query.chartType, 'timeline');
    await page.evaluate(() => { document.documentElement.dataset.activePageTheme = 'light'; document.getElementById('salesAnalyticsView').dataset.pageTheme = 'light'; });
    await screenshot('04-sales-analytics-graphics.png');
    await page.evaluate(() => {
      document.getElementById('salesAnalyticsGraphicsPanel').hidden = true;
      document.getElementById('salesAnalyticsCreatePanel').hidden = false;
      reportUi.setMode('report');
      for (const tab of document.querySelectorAll('[data-sales-analytics-tab]')) { const active = tab.dataset.salesAnalyticsTab === 'create'; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); }
    });
    assert.equal(await page.locator('#salesReportJobComparisonFrom').isDisabled(), false);
    assert.match(await scope.locator('> summary small').textContent(), /Hersteller \/ Marke: 1/);
    // Lower resolution and enlarged app text do not clip native criteria controls.
    await page.setViewportSize({ width:1280, height:900 });
    await page.evaluate(() => document.documentElement.style.setProperty('--app-font-scale', '1.25'));
    const overflow = await page.evaluate(() => [...document.querySelectorAll('#salesAnalyticsRequestForm input, #salesAnalyticsRequestForm select, #salesAnalyticsRequestForm button')].filter(element => {
      const bounds = element.getBoundingClientRect(); return bounds.width && (bounds.right > innerWidth + 1 || bounds.left < -1);
    }).map(element => element.id || element.textContent));
    assert.deepEqual(overflow, []);
    await page.evaluate(() => reportUi.reset());
    await page.waitForFunction(() => [...document.querySelectorAll('.sales-report-filter-disclosure-count')].every(element => element.textContent === 'Alle'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

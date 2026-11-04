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
    const styles = ['styles.css', 'gp-data-quality.css', 'table-layout.css', 'sales-analytics-workspace.css'].map(file => fs.readFileSync(path.join(repo, 'public', file), 'utf8')).join('\n');
    await page.setContent(`<style>${styles}\n.sidebar h2{font-size:17px;color:white}.synthetic-preview{position:absolute;right:34px;top:14px;font-size:9px;color:var(--muted)}</style><div class="app-shell"><aside class="sidebar"><h2>Grabenplaner</h2><div class="sidebar-session"><div class="sidebar-session-copy"><strong>BEISPIEL · Filialleitung</strong><span>Lokale Designvorschau</span></div></div><nav class="main-nav"><button class="nav-item">Dashboard</button><button class="nav-item">Filialverwaltung</button><button class="nav-item">Personal</button><button class="nav-item active">Verkaufsanalysen</button><button class="nav-item">Artikelstamm</button><button class="nav-item">Einkauf &amp; Bestand</button></nav></aside><main class="main-content"><span class="synthetic-preview">Vorschau · ausschließlich Beispieldaten</span>${source.slice(start, end)}</main></div>`);
    await page.evaluate(() => document.getElementById('salesAnalyticsView').classList.add('active'));
    await page.addScriptTag({ path:path.join(repo, 'public/sales-report-controls.js') });
    await page.addScriptTag({ path:path.join(repo, 'public/gp-data-quality.js') });
    await page.addScriptTag({ path:path.join(repo, 'public/table-layout.js') });
    await page.addScriptTag({ path:path.join(repo, 'public/sales-report-library-options.js') });
    await page.addScriptTag({ path:path.join(repo, 'public/sales-report-library.js') });
    await page.addScriptTag({ path:path.join(repo, 'public/sales-graphic-designs.js') });
    await page.addScriptTag({ path:path.join(repo, 'public/sales-report-jobs.js') });
    await page.exposeFunction('editSyntheticLibrary', ({ state, input, keys }) => require('../lib/persistence/repositories/sales-report-library').editLibrary(state, input, new Set(keys)));
    await page.evaluate(async () => {
      const context = { today:'2026-10-08', projection:{ read:true, sellers:true, margin:true }, marginStatus:'confirmed', source:{ label:'Kassendaten · BEISPIEL' }, sourceQuality:{sourceId:'compact-cash',uploadedAt:'2026-09-01T03:00:00Z'},
        locations:[{ id:'05', label:'05 · Beispiel West' }, { id:'11', label:'11 · Beispiel Mitte' }, { id:'18', label:'18 · Beispiel Ost' }],
        sellers:[{ id:'101', label:'101 · Anna' }, { id:'102', label:'102 · Ben' }, { id:'103', label:'103 · Chris' }],
        merchandiseGroups:[{ id:'101', label:'101 · Digitale Kameras' }, { id:'202', label:'202 · Objektive' }, { id:'301', label:'301 · Ferngläser' }],
        productGroups:[{ id:'30101', label:'30101 · Ferngläser' }, { id:'10101', label:'10101 · Systemkameras' }],
        manufacturers:[{ id:'Example A', label:'Example A' }, { id:'Example B', label:'Example B' },
          ...Array.from({ length:2099 }, (_, i) => ({ id:`Synthetic ${i}`, label:`Synthetic brand ${i}` }))],
        metrics:[{ id:'netRevenue', label:'Umsatz netto' }, { id:'quantity', label:'Stückzahl' }, { id:'receiptCount', label:'Belege' }, { id:'grossMargin', label:'Rohertrag' }, { id:'marginRate', label:'Rohertrag in %' }, { id:'revenuePerReceipt', label:'Durchschnittsbon' }],
        dimensions:[{ id:'productGroup', label:'Sortimentsgruppe' }, { id:'manufacturer', label:'Hersteller' }, { id:'location', label:'Filiale' }, { id:'seller', label:'MA' }] };
      window.salesRequests = []; window.syntheticTemplates = []; window.syntheticReports = []; window.syntheticLibrary = { revision:0, folders:[], items:[] };
      window.reportApi = async (url, options = {}) => {
        if (url === '/api/sales-report-library') {
          if (options.method === 'PATCH') syntheticLibrary = await editSyntheticLibrary({ state:syntheticLibrary, input:JSON.parse(options.body), keys:[...syntheticTemplates.map(t=>'template:'+t.id), ...syntheticReports.map(t=>'report:'+t.id)] });
          return syntheticLibrary;
        }
        if (url.startsWith('/api/sales-report-templates/') && !options.method) return syntheticTemplates.find(t=>t.id===url.split('/').at(-1));
        if (options.method === 'DELETE') { syntheticTemplates = syntheticTemplates.filter(t=>t.id!==url.split('/').at(-1)); return {}; }
        if (options.method === 'POST' || options.method === 'PUT') {
          const body = JSON.parse(options.body); salesRequests.push({ url, body });
          if (url.startsWith('/api/sales-report-templates')) { const item = { ...body, kind:body.query.chartType==='timeline'?'graphic':'report', id:options.method==='PUT'?url.split('/').at(-1):'saved-template', revision:(body.revision||0)+1 }; syntheticTemplates=[item]; return item; }
          return { id:'new-report' };
        }
        if (url === '/api/sales-report-jobs/context') {
          if (window.failReportContext) throw Object.assign(Error('Der Bericht konnte nicht verarbeitet werden.'), { code:'IMPORT_REPORT_METADATA_LIMIT' });
          return context;
        }
        if (url === '/api/sales-report-jobs') return syntheticReports;
        if (url === '/api/sales-report-templates') return syntheticTemplates;
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
    const initialHeight = (await page.locator('#salesAnalyticsRequestForm').boundingBox()).height;
    assert.ok(initialHeight < 650, `Initial criteria stay compact independently of the source-quality explanation (${initialHeight}px)`);
    assert.equal(await page.locator('#salesReportDataQuality').isVisible(), true);
    assert.match(await page.locator('#salesReportDataQuality').textContent(), /Hochgeladen am:.*01\.09\.2026/);
    assert.match(await page.locator('#salesReportDataQuality').textContent(), /Vollständigkeit.*nicht nachgewiesen/);
    assert.ok(await page.locator('#salesReportJobFrom').isVisible());
    assert.ok(await page.locator('#salesReportJobLocations').isVisible());
    assert.ok(await page.locator('#salesReportJobMetrics').isVisible());
    await page.locator('#salesAnalyticsRequestQuery').fill('BEISPIEL · Ferngläser Oktober');
    const scope = page.locator('.sales-report-scope-disclosure');
    await scope.locator('> summary').click();
    const manufacturers = page.locator('.sales-report-filter-disclosure').filter({ has:page.locator('#salesReportJobManufacturers') });
    await manufacturers.locator('> summary').click();
    const brandSearch = page.getByRole('searchbox', { name:'Hersteller / Marke durchsuchen', exact:true });
    await brandSearch.fill('Synthetic brand 2098');
    assert.equal(await page.locator('#salesReportJobManufacturers input[type="checkbox"]').count(), 1);
    assert.match(await page.locator('#salesReportJobManufacturers').textContent(), /Synthetic brand 2098/);
    await brandSearch.fill('');
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
    await page.locator('#salesReportJobMetrics input[value="grossMargin"]').check();
    await page.locator('#salesReportJobMetrics input[value="revenuePerReceipt"]').check();
    await page.locator('.sales-report-disclosure').filter({has:page.locator('#salesReportJobChartType')}).locator('> summary').click();
    await page.locator('#salesReportJobChartType').selectOption('none');
    assert.equal(await page.locator('#salesReportJobChartMetric input').first().isDisabled(),true);
    await page.locator('#salesReportJobChartType').selectOption('bars');
    await page.locator('#salesReportJobChartMetric input[value="grossMargin"]').check();
    await page.locator('#salesReportJobChartMetric input[value="revenuePerReceipt"]').check();
    await page.locator('#salesReportJobSubmit').click();
    await page.waitForFunction(() => salesRequests.length===2);
    assert.deepEqual((await page.evaluate(() => salesRequests[1].body)).query.chartMetrics,['netRevenue','grossMargin','revenuePerReceipt']);
    await page.locator('.sales-report-disclosure').filter({has:page.locator('#salesReportJobChartType')}).locator('> summary').click();
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
    await page.waitForFunction(() => salesRequests.length === 3);
    assert.equal((await page.evaluate(() => salesRequests[2].body)).query.chartType, 'timeline');
    await page.evaluate(() => { document.documentElement.dataset.activePageTheme = 'light'; document.getElementById('salesAnalyticsView').dataset.pageTheme = 'light'; });
    await screenshot('04-sales-analytics-graphics.png');
    await page.locator('#salesGraphicMetric input[value="grossMargin"]').check();
    await page.locator('#salesGraphicMetric input[value="revenuePerReceipt"]').check();
    await page.locator('#salesGraphicStyle').selectOption('aurora');
    await page.locator('#salesReportTemplateSave').click();
    await page.waitForFunction(() => syntheticTemplates.length === 1);
    assert.deepEqual(await page.evaluate(() => syntheticTemplates[0].query.chartMetrics), ['netRevenue', 'grossMargin', 'revenuePerReceipt']);
    await page.evaluate(() => { document.getElementById('salesAnalyticsGraphicsPanel').hidden=true; document.getElementById('salesAnalyticsReportsPanel').hidden=false; });
    await page.locator('#salesLibraryNewFolder').click();
    await page.locator('#salesLibraryName').fill('Filiale 18'); await page.locator('#salesLibraryDialogOk').click();
    await page.waitForFunction(() => syntheticLibrary.folders.length===1);
    const templateCard = page.locator('.sales-library-template');
    await templateCard.click({button:'right'});
    await page.getByRole('menuitem',{ name:'Verschieben',exact:true }).click();
    await page.locator('#salesLibraryTarget').selectOption({ label:'Berichte / Filiale 18' }); await page.locator('#salesLibraryDialogOk').click();
    await page.waitForFunction(() => syntheticLibrary.items.length===1);
    assert.equal(await templateCard.count(),0);
    await page.locator('#salesLibraryFolders').getByRole('button',{ name:'Filiale 18',exact:true }).click();
    assert.equal(await templateCard.count(),1);
    await templateCard.click({button:'right'});
    await page.getByRole('menuitem',{ name:'Umbenennen',exact:true }).click();
    await page.locator('#salesLibraryName').fill('Monatsgrafik - Umsatz und Rohertrag'); await page.locator('#salesLibraryDialogOk').click();
    await page.waitForFunction(() => document.querySelector('.sales-library-template .sales-library-icon-name')?.textContent==='Monatsgrafik - Umsatz und Rohertrag');
    await page.locator('#salesLibraryNewFolder').click(); await page.locator('#salesLibraryName').fill('2026'); await page.locator('#salesLibraryDialogOk').click();
    await page.waitForFunction(() => syntheticLibrary.folders.length===2);
    await screenshot('05-sales-report-library.png');
    await page.setViewportSize({width:390,height:844}); await screenshot('06-sales-report-library-mobile.png');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
    await page.setViewportSize({width:1600,height:1100});
    await templateCard.dblclick();
    await page.waitForFunction(() => document.querySelector('#salesAnalyticsRequestQuery').value==='Monatsgrafik - Umsatz und Rohertrag');
    assert.equal(await page.locator('#salesGraphicStyle').inputValue(),'aurora');
    assert.equal(await page.locator('#salesGraphicMetric input:checked').count(),3);
    await page.evaluate(() => { document.getElementById('salesAnalyticsReportsPanel').hidden=true; document.getElementById('salesAnalyticsGraphicsPanel').hidden=false; });
    for (const style of ['studio','aurora','editorial','pulse']) { await page.locator('#salesGraphicStyle').selectOption(style); await screenshot('07-sales-graphic-'+style+'.png'); }
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
    await page.evaluate(async () => {
      syntheticReports.push({id:'finished',title:'Originalbericht',query:salesRequests[1].body.query,status:'completed',format:'pdf',created:'2026-11-01T10:00:00Z',processed:2500,durationSeconds:60});
      document.getElementById('salesAnalyticsCreatePanel').hidden=true;document.getElementById('salesAnalyticsReportsPanel').hidden=false;
      await reportUi.refresh(); document.querySelector('#salesLibraryFolders [data-drop-folder=""]').click();
    });
    const requestCount=await page.evaluate(()=>salesRequests.length);
    for(const view of ['icons','details']) {
      await page.locator('#salesLibraryView').selectOption(view);
      const finished=page.locator('#salesReportJobList [data-library-key="report:finished"]');await finished.click({button:'right'});
      assert.equal(await page.getByRole('menuitem',{name:'PDF herunterladen',exact:true}).count(),1);
      await page.getByRole('menuitem',{name:'Als Vorlage für neuen Bericht verwenden',exact:true}).click();
      assert.equal(await page.locator('#salesAnalyticsRequestQuery').inputValue(),'Originalbericht');
      assert.deepEqual(await page.locator('#salesReportJobChartMetric input:checked').evaluateAll(inputs=>inputs.map(i=>i.value)),await page.evaluate(()=>salesRequests[1].body.query.chartMetrics));
      assert.equal(await page.evaluate(()=>salesRequests.length),requestCount);
    }
    await page.evaluate(() => reportUi.reset());
    await page.waitForFunction(() => [...document.querySelectorAll('.sales-report-filter-disclosure-count')].every(element => element.textContent === 'Alle'));
    assert.equal(await page.locator('#salesReportDataQuality').textContent(),'');
    await page.evaluate(async () => { window.failReportContext = true; await reportUi.refresh(); });
    assert.match(await page.locator('#salesAnalyticsRequestHint').textContent(), /zu viele Stammdatenbezeichnungen/);
    assert.equal(await page.locator('#salesReportJobSubmit').isEnabled(), false);
    await page.evaluate(async () => { window.failReportContext = false; await reportUi.refresh(); });
    assert.equal(await page.locator('#salesReportJobLocations input[type="checkbox"]').count(), 3);
    assert.equal(await page.locator('#salesReportJobSubmit').isEnabled(), true);
    await page.evaluate(() => reportUi.setMode('graphic'));
    assert.equal(await page.locator('#salesReportJobLocations input[type="checkbox"]').count(), 3);
    assert.ok(await page.locator('#salesGraphicMetric input[type=checkbox]').count() > 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

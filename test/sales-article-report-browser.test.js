'use strict';
// Actual GP markup, table/window controllers and PDF renderer. Isolated example API only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const repo = path.resolve(__dirname, '..');
const Model = require('../lib/sales-article-report-model');
const Pdf = require('../lib/sales-article-report-pdf');
const caps = { prices:true, costs:true, margin:true };
const exampleRows = [];
for (let article = 1; article <= 35; article++) for (const locationId of ['05','11','18']) {
  exampleRows.push({ id:`${article}-${locationId}`, articleNumber:String(article).padStart(6,'0'),
    description:article === 1 ? 'BEISPIEL <img src=x onerror="window.reportXss=1"> Fernglas' : `BEISPIEL Fernglas ${String(article).padStart(2,'0')}`,
    assortment:article % 10 ? 'Abverkauf' : 'Auslaufartikel', location:`${locationId} · Beispiel ${locationId}`, locationId,
    quantity:String(article % 9 ? article % 7 + 1 : 0), ordered:String(article % 3), retailGross:String(99 + article * 10),
    internetGross:String(89 + article * 10), averageCost:String(40 + article), marginPercent:String(20 + article % 12), stockValue:String((40 + article) * (article % 7 + 1)) });
}
function rowsFor(filters, owner) {
  let rows = exampleRows.filter(row => (!filters.locations?.length || filters.locations.includes(row.locationId))
    && (filters.stock !== 'positive' || Number(row.quantity) > 0)
    && (!filters.assortment || filters.assortment === 'all' || (filters.assortment === 'sellout' ? row.assortment === 'Abverkauf' : row.assortment === 'Auslaufartikel'))
    && (!filters.query || (row.articleNumber + ' ' + row.description).toLowerCase().includes(filters.query.toLowerCase())));
  rows = rows.map(row => ({ ...row, description:owner === 'B' ? row.description.replace('BEISPIEL', 'BEISPIEL Konto B') : row.description }));
  rows.sort((a,b) => {
    const id = filters.sort || 'articleNumber', column = Model.COLUMNS.find(c => c.id === id);
    const compared = column.type === 'text' ? String(a[id]).localeCompare(String(b[id]),'de',{numeric:true}) : Number(a[id]) - Number(b[id]);
    return (filters.direction === 'desc' ? -compared : compared) || a.articleNumber.localeCompare(b.articleNumber) || a.locationId.localeCompare(b.locationId);
  });
  return rows;
}

test('article report protects account state and renders sortable branch reports and real PDF windows', {
  skip:process.env.GP_ARTICLE_REPORT_BROWSER_TEST !== '1', timeout:90000,
}, async t => {
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
  const browser = await chromium.launch({headless:true, ...(process.env.GP_BROWSER_EXECUTABLE ? {executablePath:process.env.GP_BROWSER_EXECUTABLE} : {}), args:['--no-first-run']});
  const errors = [], pdfSamples = [], assetRequests=[];let localServer;
  try {
    const page = await browser.newPage({viewport:{width:1600,height:1100}, acceptDownloads:true});
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('articleReportQuery', (filters, owner) => {
      const all = rowsFor(filters, owner), offset = Number(filters.offset || 0), limit = Number(filters.limit || 50);
      return {rows:all.slice(offset,offset+limit),total:all.length,hasMore:offset+limit<all.length,sourceAt:'2026-10-08T03:00:00Z'};
    });
    await page.exposeFunction('articleReportPdf', async (options, owner) => {
      const rows = rowsFor(options.filters,owner), spec = Pdf.normalize(options,caps);
      const result = await Pdf.render({spec,report:{available:true,rows,total:rows.length,hasMore:false,sourceAt:'2026-10-08T03:00:00Z'},generatedAt:'2026-10-08T12:00:00Z'});
      pdfSamples.push({...result,options});
      return {base64:result.buffer.toString('base64'),pages:result.pages,rows:result.rows,name:result.name};
    });
    const source = fs.readFileSync(path.join(repo,'public/index.html'),'utf8');
    const start = source.indexOf('<section id="salesArticleReportView"'), end = source.indexOf('<section id="receiptSearchView"',start);
    assert.ok(start >= 0 && end > start,'Real article-report section is mounted');
    const markup = source.slice(start,end).replace('class="view sales-article-report-view"','class="view sales-article-report-view active"');
    const styles = ['styles.css','gp-window.css','gp-print-window.css','table-layout.css','sales-article-report.css'].map(file => fs.readFileSync(path.join(repo,'public',file),'utf8')).join('\n');
    const html=`<!doctype html><meta charset="UTF-8"><style>${styles}\n.sidebar h2{font-size:17px;color:white}.preview-label{font-size:9px;color:var(--muted);margin:0 0 8px}</style><div class="app-shell"><aside class="sidebar"><h2>Grabenplaner</h2><div class="sidebar-session"><div class="sidebar-session-copy"><strong>BEISPIEL · Filialleitung</strong><span>Lokale Designvorschau</span></div></div><nav class="main-nav"><button class="nav-item">Dashboard</button><button class="nav-item">Filialverwaltung</button><button class="nav-item">Personal</button><button class="nav-item">Verkaufsanalysen</button><button class="nav-item">Artikelstamm</button><button class="nav-item active">Artikel-Auswertung</button><button class="nav-item">Einkauf &amp; Bestand</button></nav></aside><main class="main-content">${markup}</main></div>`;
    const pdfjsRoot=path.dirname(require.resolve('pdfjs-dist/package.json'));
    localServer=http.createServer((request,response)=>{
      const url=new URL(request.url,'http://127.0.0.1');
      response.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'"+(url.pathname.startsWith('/vendor/pdfjs-v6.2.108')?" 'wasm-unsafe-eval'":"")+"; worker-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
      response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Cross-Origin-Opener-Policy','same-origin');response.setHeader('Cross-Origin-Resource-Policy','same-origin');
      if(url.pathname==='/'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);return;}
      const prefix='/vendor/pdfjs-v6.2.108/';
      if(url.pathname.startsWith(prefix)){
        const file=path.resolve(pdfjsRoot,decodeURIComponent(url.pathname.slice(prefix.length)));
        if(file.startsWith(pdfjsRoot+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){
          const contentType={'.mjs':'application/javascript','.wasm':'application/wasm','.ttf':'font/ttf'}[path.extname(file)]||'application/octet-stream';
          assetRequests.push(url.pathname);response.writeHead(200,{'Content-Type':contentType});response.end(fs.readFileSync(file));return;
        }
      }
      const publicRoot=path.join(repo,'public'),file=path.resolve(publicRoot,url.pathname.slice(1));
      if(file.startsWith(publicRoot+path.sep)&&path.extname(file)==='.js'&&fs.existsSync(file)){
        response.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});response.end(fs.readFileSync(file));return;
      }
      response.writeHead(404);response.end();
    });
    await new Promise(resolve=>localServer.listen(0,'127.0.0.1',resolve));
    await page.goto('http://127.0.0.1:'+localServer.address().port+'/');
    for (const file of ['gp-window-preferences.js','gp-window.js','table-layout.js','sales-article-report-pdf-preview.js','gp-print-window.js','sales-article-report.js']) await page.addScriptTag({url:'/'+file});
    await page.evaluate(({columns,rows}) => {
      window.actor='A';window.allowed=true;window.pageActive=true;window.reportXss=0;window.apiCalls=[];window.pdfCalls=[];window.openedArticles=[];
      window.holdPreferences=true;window.preferenceReleases=[];window.holdQuery=false;window.queryReleases=[];window.holdPdf=false;window.pdfReleases=[];
      window.fixtureContext={available:true,columns,defaultColumns:['articleNumber','description','assortment','location','quantity','ordered','retailGross','marginPercent'],
        sortiments:[{id:'sellout',label:'Abverkauf'},{id:'discontinued',label:'Auslaufartikel'}],locations:[{id:'05',label:'05 · Beispiel West'},{id:'11',label:'11 · Beispiel Mitte'},{id:'18',label:'18 · Beispiel Ost'}]};
      window.persisted={A:{preferences:{columns:[...fixtureContext.defaultColumns],columnWidths:{description:310},sort:'articleNumber',direction:'asc'},revision:1},
        B:{preferences:{columns:['articleNumber','description','location','quantity'],columnWidths:{description:340},sort:'description',direction:'asc'},revision:4}};
      const copy = value => JSON.parse(JSON.stringify(value));
      window.reportApi=async (url,options={}) => {
        const owner=actor;apiCalls.push({url,owner,method:options.method||'GET',body:options.body&&JSON.parse(options.body),signal:options.signal});
        if(url.endsWith('/context'))return copy(fixtureContext);
        if(url.endsWith('/preferences')) {
          if(options.method==='PUT'){const body=JSON.parse(options.body);if(body.revision!==persisted[owner].revision)throw Error('Revision mismatch');persisted[owner]={preferences:body.preferences,revision:body.revision+1};return copy(persisted[owner]);}
          if(holdPreferences)await new Promise(resolve=>preferenceReleases.push(resolve));
          return copy(persisted[owner]);
        }
        if(url.includes('/query?')) {
          const params=Object.fromEntries(new URL(url,location.href).searchParams), filters={...params,locations:params.locations.split(',')};
          const result=await articleReportQuery(filters,owner);
          if(holdQuery)await new Promise(resolve=>queryReleases.push(resolve));
          return result;
        }
        throw Error('Unexpected API '+url);
      };
      window.reportRawApi=async (url,options) => {
        const owner=actor,body=JSON.parse(options.body);pdfCalls.push({url,owner,body,signal:options.signal});
        const rendered=await articleReportPdf(body,owner);
        if(holdPdf)await new Promise(resolve=>pdfReleases.push(resolve));
        const buffer=Uint8Array.from(atob(rendered.base64),char=>char.charCodeAt(0));
        return new Response(buffer,{headers:{'Content-Type':'application/pdf','X-PDF-Pages':String(rendered.pages),'X-Report-Rows':String(rendered.rows)}});
      };
      window.geometrySaved={};
      window.windowStore=GpWindow.createPreferences({key:()=>actor,canUse:()=>allowed,read:async()=>({version:1,windows:geometrySaved[actor]||{}}),write:async value=>{geometrySaved[actor]=copy(value.windows);}});
      window.mountReport=()=>{window.ui=GrabenplanerArticleReport.mount(document.querySelector('#salesArticleReportWorkspace'),{
        api:reportApi,rawApi:reportRawApi,key:()=>actor,canUse:()=>allowed,active:()=>pageActive,windowPreferences:windowStore,scale:()=>1,openArticle:id=>openedArticles.push(id)});window.activation=ui.activate();};
      mountReport();
    }, {columns:Model.columnsFor(caps),rows:exampleRows});
    const main = page.locator('#salesArticleReportWorkspace'), pdf = page.locator('.gp-print-window');
    const screenshot = async name => {
      if (!process.env.GP_ARTICLE_REPORT_SCREENSHOTS) return;
      fs.mkdirSync(process.env.GP_ARTICLE_REPORT_SCREENSHOTS,{recursive:true});
      await page.mouse.move(240,20);await page.waitForTimeout(200);
      await page.screenshot({path:path.join(process.env.GP_ARTICLE_REPORT_SCREENSHOTS,name),fullPage:true});
    };
    const baseline=(name,fn)=>t.test(name,{skip:process.env.GP_ARTICLE_REPORT_FINAL_CHECKS_ONLY==='1'},fn);
    const prepareAccount=async owner=>{
      await page.evaluate(value=>{holdPreferences=false;while(preferenceReleases.length)preferenceReleases.shift()();fixtureContext.available=true;allowed=true;pageActive=true;actor=value;windowStore.invalidate();ui.sync();},owner);
      await page.waitForFunction(()=>ui.state.preferencesReady);
      await main.locator('[type=submit]').click();await page.waitForFunction(()=>ui.state.total>0);
    };
    const fingerprint=()=>pdf.locator('canvas').evaluate(canvas=>{const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let hash=2166136261;for(let i=0;i<pixels.length;i+=16)hash=Math.imul(hash^pixels[i],16777619);return {width:canvas.width,height:canvas.height,label:canvas.getAttribute('aria-label'),hash:hash>>>0};});
    await baseline('preferences gate writes while loading and saved views restore',async()=>{
      await page.waitForFunction(()=>preferenceReleases.length===1);
      assert.equal(await main.locator('[type=submit]').isDisabled(),true);
      assert.equal(await page.evaluate(()=>apiCalls.some(call=>call.method==='PUT')),false);
      await page.evaluate(()=>{holdPreferences=false;preferenceReleases.shift()();});
      await page.waitForFunction(()=>ui.state.preferencesReady);
      assert.equal(await main.locator('[data-gp-column-resize=description]').getAttribute('aria-valuenow'),'310');
      assert.equal(await main.locator('[name=assortment]').inputValue(),'sellout');
      assert.equal(await page.evaluate(()=>apiCalls.some(call=>call.method==='PUT')),false);
    });
    await baseline('multiple branches, stock/query changes, ordering and paging use applied filters',async()=>{
      await main.locator('[data-report-branches]>summary').click();
      await main.locator('[data-report-branch-options] input[value="11"]').uncheck();
      await main.locator('[data-report-branches]>summary').click();
      await main.locator('[type=submit]').click();
      await page.waitForFunction(()=>ui.state.total>50);
      const count=await page.evaluate(()=>ui.state.total);
      assert.equal(await main.locator('tbody tr').count(),50);
      assert.deepEqual(await page.evaluate(()=>ui.state.filters.locations),['05','18']);
      assert.match(await main.locator('[data-report-selected-branches]').textContent(),/Beispiel West.*Beispiel Ost/);
      await main.locator('[data-report-next]').click();
      await page.waitForFunction(()=>document.querySelector('[data-report-page]').textContent.startsWith('51'));
      assert.equal(await main.locator('tbody tr').count(),count-50);
      await main.locator('[data-report-prev]').click();
      await page.waitForFunction(()=>document.querySelector('[data-report-page]').textContent.startsWith('1–50'));
      await main.locator('[data-report-sort=quantity]').click();
      await page.waitForFunction(()=>ui.state.filters.sort==='quantity');
      assert.equal(await main.locator('[data-report-sort=quantity]').evaluate(node=>node.closest('th').getAttribute('aria-sort')),'ascending');
      await main.locator('[data-report-sort=quantity]').click();
      await page.waitForFunction(()=>ui.state.filters.direction==='desc');
      await main.locator('[name=query]').fill('Fernglas 02');
      assert.equal(await main.locator('[data-report-pdf]').isDisabled(),true);
      await main.locator('[type=submit]').click();
      await page.waitForFunction(()=>ui.state.total===2);
      assert.equal(await main.locator('tbody tr').count(),2);
      await main.locator('[name=query]').fill('');await main.locator('[name=stock]').selectOption('all');
      await main.locator('[type=submit]').click();
      await page.waitForFunction(()=>ui.state.filters.stock==='all');
      assert.ok(await page.evaluate(()=>ui.state.total)>count);
      await main.locator('[name=stock]').selectOption('positive');await main.locator('[data-report-sort=articleNumber]').click();
      await page.waitForFunction(()=>ui.state.filters.sort==='articleNumber'&&ui.state.filters.stock==='positive');
    });
    await baseline('HTML values are rendered as text and columns and widths persist',async()=>{
      assert.equal(await main.locator('tbody img').count(),0);
      assert.equal(await page.evaluate(()=>reportXss),0);
      assert.match(await main.locator('tbody').textContent(),/<img src=x/);
      await main.locator('[data-report-article="000001"]').first().click();
      assert.deepEqual(await page.evaluate(()=>openedArticles),['000001']);
      await main.locator('[data-report-columns]>summary').click();
      assert.equal(await main.locator('[data-report-column=articleNumber]').isDisabled(),true);
      await main.locator('[data-report-column=ordered]').uncheck();
      await page.waitForFunction(()=>!persisted.A.preferences.columns.includes('ordered'));
      await main.locator('[data-report-move=description][data-direction="-1"]').click();
      await page.waitForFunction(()=>persisted.A.preferences.columns[0]==='description');
      await main.locator('[data-report-columns]>summary').click();
      const resize=main.locator('[data-gp-column-resize=description]');await resize.focus();await resize.press('ArrowRight');
      await page.waitForFunction(()=>persisted.A.preferences.columnWidths.description===320);
      assert.equal(await resize.getAttribute('aria-valuenow'),'320');
      // Keep output screenshots readable after the explicit injection-safety assertions.
      for (const row of exampleRows) if (row.articleNumber === '000001') row.description = 'BEISPIEL Fernglas 01';
      await page.evaluate(()=>{ui.destroy();mountReport();});
      await page.waitForFunction(()=>ui.state.preferencesReady);
      assert.equal(await main.locator('thead th').first().textContent(),'Bezeichnung');
      assert.equal(await main.locator('[data-gp-column-resize=description]').getAttribute('aria-valuenow'),'320');
      await main.locator('[type=submit]').click();await page.waitForFunction(()=>ui.state.total>0);
      await screenshot('05-article-report-light.png');
    });
    await baseline('PDF uses complete rows and real renderer; GP window moves, resizes, minimizes and closes',async()=>{
      await main.locator('[data-report-pdf]').click();await page.waitForFunction(()=>!document.querySelector('[data-gp-print-download]').disabled);
      assert.equal(await pdf.locator('.gp-window-grip').count(),1);
      assert.equal(await pdf.locator('[data-gp-window-edge]').count(),8);
      assert.match(await pdf.locator('[data-gp-print-count]').textContent(),/\d+ Seiten · \d+ Zeilen/);
      const last=await page.evaluate(()=>pdfCalls.at(-1).body);
      assert.deepEqual(last.filters.locations,['05','11','18']);
      assert.ok(pdfSamples.at(-1).rows>50,'PDF exports all rows beyond current page');
      assert.ok(pdfSamples.at(-1).pages>1,'Real layout reports a multiple-page count');
      assert.equal(await pdf.locator('[data-preview-page]').textContent(),'Seite 1 / '+pdfSamples.at(-1).pages);
      assert.equal(await pdf.locator('canvas').count(),1);
      assert.ok(assetRequests.some(url=>url.endsWith('/build/pdf.min.mjs')));assert.ok(assetRequests.some(url=>url.endsWith('/build/pdf.worker.min.mjs')),'Real same-origin worker renders under GP CSP');
      assert.ok(await pdf.locator('canvas').evaluate(canvas=>{const bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let ink=0;for(let i=0;i<bytes.length;i+=32)if(bytes[i]<220&&bytes[i+1]<220&&bytes[i+2]<220)ink++;return ink>50;}),'First open renders real PDF text without native-viewer warm-up');
      await screenshot('06-article-report-pdf-window.png');
      const fitted=await pdf.locator('canvas').evaluate(canvas=>canvas.width);
      await pdf.locator('[data-preview-next]').click();await page.waitForFunction(()=>document.querySelector('[data-preview-page]').textContent.startsWith('Seite 2 /'));
      assert.match(await pdf.locator('canvas').getAttribute('aria-label'),/PDF-Seite 2/);
      await pdf.locator('[data-preview-zoom]').selectOption('1');await page.waitForFunction(before=>document.querySelector('[data-gp-print-viewer] canvas').width>before,fitted);
      await pdf.locator('[data-preview-prev]').click();await page.waitForFunction(()=>document.querySelector('[data-preview-page]').textContent.startsWith('Seite 1 /'));
      await pdf.locator('[data-preview-zoom]').selectOption('page');
      const before=await pdf.boundingBox(),title=pdf.locator('[data-gp-print-title]'),titleBox=await title.boundingBox();
      await page.mouse.move(titleBox.x+100,titleBox.y+22);await page.mouse.down();await page.mouse.move(110,45,{steps:5});await page.mouse.up();
      const moved=await pdf.boundingBox();assert.ok(moved.x<240&&moved.y<90,'Window moves over sidebar and top');
      const east=await pdf.locator('[data-gp-window-edge=e]').boundingBox();await page.mouse.move(east.x+east.width/2,east.y+100);await page.mouse.down();await page.mouse.move(east.x+east.width/2+55,east.y+100,{steps:3});await page.mouse.up();
      assert.ok((await pdf.boundingBox()).width>moved.width+35);
      await pdf.locator('[data-gp-print-min]').click();assert.equal(Math.round((await pdf.boundingBox()).width),260);assert.equal(Math.round((await pdf.boundingBox()).height),44);
      assert.equal(await pdf.locator('[data-gp-print-body]').isVisible(),false);
      await pdf.locator('[data-gp-print-min]').click();assert.ok((await pdf.boundingBox()).width>1000);
      await pdf.locator('[data-gp-print-close]').click();await page.waitForFunction(()=>document.querySelector('.gp-print-window').hidden);
      assert.equal(await pdf.locator('[data-gp-print-viewer] canvas').count(),0);
      assert.ok(await page.evaluate(()=>geometrySaved.A['article-report-pdf']));
    });
    await baseline('changing PDF options invalidates download and rejects earlier configuration responses',async()=>{
      await page.evaluate(()=>{holdPdf=true;});await main.locator('[data-report-pdf]').click();await page.waitForFunction(()=>pdfReleases.length===1);
      await pdf.locator('[name=title]').fill('BEISPIEL Aktueller Titel');await pdf.locator('[name=orientation]').selectOption('portrait');
      await page.waitForFunction(()=>pdfReleases.length>=2);
      assert.equal(await pdf.locator('[data-gp-print-download]').isDisabled(),true);
      assert.equal(await page.evaluate(()=>pdfCalls.at(-2).signal.aborted),true);
      await page.evaluate(()=>pdfReleases.pop()());await page.waitForFunction(()=>!document.querySelector('[data-gp-print-download]').disabled);
      const count=await pdf.locator('[data-gp-print-count]').textContent();
      await page.evaluate(()=>{while(pdfReleases.length)pdfReleases.shift()();holdPdf=false;});await page.waitForTimeout(100);
      assert.equal(await pdf.locator('[data-gp-print-count]').textContent(),count);
      const downloadPromise=page.waitForEvent('download',{timeout:3000});await pdf.locator('[data-gp-print-download]').click();const downloaded=await downloadPromise;
      const buffer=fs.readFileSync(await downloaded.path());assert.ok(buffer.subarray(0,5).equals(Buffer.from('%PDF-')));
      assert.match(downloaded.suggestedFilename(),/\.pdf$/);assert.equal(buffer.length,pdfSamples.at(-1).buffer.length);
      if(process.env.GP_ARTICLE_REPORT_SCREENSHOTS)fs.writeFileSync(path.join(process.env.GP_ARTICLE_REPORT_SCREENSHOTS,'article-report-example.pdf'),buffer);
      await pdf.locator('[data-gp-print-close]').click();await page.waitForFunction(()=>document.querySelector('.gp-print-window').hidden);
    });
    await baseline('an in-flight PDF survives page navigation and is restored without losing the report',async()=>{
      const selection=await page.evaluate(()=>ui.state.filters),total=await page.evaluate(()=>ui.state.total);
      await page.evaluate(()=>holdPdf=true);await main.locator('[data-report-pdf]').click();await page.waitForFunction(()=>pdfReleases.length===1);
      await page.evaluate(()=>{pageActive=false;ui.suspend();pdfReleases.shift()();holdPdf=false;});
      await page.waitForFunction(()=>document.querySelector('[data-gp-print-status]').textContent==='Vorschau entspricht der PDF-Datei.');
      assert.equal(await pdf.locator('[data-gp-print-download]').isDisabled(),true,'A suspended print window keeps its preview but cannot download');
      assert.equal(await pdf.isVisible(),false);
      await page.evaluate(()=>{pageActive=true;ui.activate();});await page.waitForFunction(()=>!document.querySelector('.gp-print-window').hidden&&document.querySelector('[data-gp-print-viewer] canvas')?.width>100);
      assert.equal(await pdf.locator('canvas').count(),1);assert.deepEqual(await page.evaluate(()=>ui.state.filters),selection);assert.equal(await page.evaluate(()=>ui.state.total),total);
      await pdf.locator('[data-gp-print-close]').click();await page.waitForFunction(()=>document.querySelector('.gp-print-window').hidden);
    });
    await baseline('light and dark page screenshots and narrow layout remain usable',async()=>{
      await page.evaluate(()=>{document.documentElement.dataset.activePageTheme='dark';document.getElementById('salesArticleReportView').dataset.pageTheme='dark';});
      await screenshot('07-article-report-dark.png');
      await main.locator('[data-report-pdf]').click();await page.waitForFunction(()=>!document.querySelector('[data-gp-print-download]').disabled);
      await screenshot('08-article-report-pdf-dark.png');
      await pdf.locator('[data-gp-print-close]').click();await page.waitForFunction(()=>document.querySelector('.gp-print-window').hidden);
      await page.evaluate(()=>{document.documentElement.dataset.activePageTheme='light';document.getElementById('salesArticleReportView').dataset.pageTheme='light';});
      await page.setViewportSize({width:560,height:900});
      await screenshot('09-article-report-narrow.png');
      const out=await main.locator('form input,form select,form button').evaluateAll(nodes=>nodes.filter(n=>{const r=n.getBoundingClientRect();return r.width&&(r.left<-1||r.right>innerWidth+1);}).map(n=>n.name||n.textContent));
      assert.deepEqual(out,[]);
      await main.locator('[data-report-pdf]').click();await page.waitForFunction(()=>!document.querySelector('[data-gp-print-download]').disabled);
      await pdf.locator('[data-gp-print-form] details>summary').click();await pdf.locator('canvas').scrollIntoViewIfNeeded();
      await screenshot('12-article-report-pdf-narrow.png');
      const pdfOut=await pdf.locator('input,select,button').evaluateAll(nodes=>nodes.filter(n=>{const r=n.getBoundingClientRect();return r.width&&(r.left<-1||r.right>innerWidth+1);}).map(n=>n.name||n.textContent));
      assert.deepEqual(pdfOut,[]);assert.ok((await pdf.boundingBox()).width<=560);
      const windowBox=await pdf.boundingBox(),footerBox=await pdf.locator('.gp-print-footer').boundingBox();
      assert.ok(Math.abs(windowBox.y+windowBox.height-footerBox.y-footerBox.height)<3,'Download footer stays at the lower window edge while preview scrolls');
      await pdf.locator('[data-gp-print-close]').click();await page.waitForFunction(()=>document.querySelector('.gp-print-window').hidden);
      await page.setViewportSize({width:1600,height:1100});
    });
    await baseline('account change rejects late results and permission revocation clears rows and PDF',async()=>{
      await page.evaluate(()=>holdQuery=true);await main.locator('[type=submit]').click();await page.waitForFunction(()=>queryReleases.length===1);
      await page.evaluate(()=>{actor='B';windowStore.invalidate();ui.sync();holdQuery=false;});await page.waitForFunction(()=>ui.state.preferencesReady);
      assert.equal(await page.evaluate(()=>ui.state.rows.length),0);
      assert.equal(await main.locator('[data-gp-column-resize=description]').getAttribute('aria-valuenow'),'340');
      await main.locator('[type=submit]').click();await page.waitForFunction(()=>ui.state.total>0&&ui.state.rows[0].description.includes('Konto B'));
      await page.evaluate(()=>queryReleases.shift()());await page.waitForTimeout(100);
      assert.equal(await main.locator('tbody').textContent().then(text=>text.includes('Konto B')),true);
      await main.locator('[data-report-pdf]').click();await page.waitForFunction(()=>!document.querySelector('[data-gp-print-download]').disabled);
      await page.evaluate(()=>{allowed=false;ui.sync();});
      assert.equal(await main.locator('[data-report-pdf]').isDisabled(),true);
      assert.equal(await pdf.isVisible(),false);assert.equal(await main.locator('tbody img').count(),0);assert.equal(await page.evaluate(()=>ui.state.rows.length),0);
      assert.equal(await main.locator('[data-report-source]').textContent(),'');assert.equal(await main.locator('[data-report-column-options]').textContent(),'');
      assert.equal(await pdf.locator('[data-gp-print-viewer] canvas').count(),0);
      const writes=await page.evaluate(()=>apiCalls.filter(call=>call.method==='PUT').length);
      await main.locator('table').dispatchEvent('click');
      assert.equal(await page.evaluate(()=>apiCalls.filter(call=>call.method==='PUT').length),writes);
    });
    await baseline('a missing stock import stays explicit and cannot be queried',async()=>{
      await page.evaluate(()=>{fixtureContext.available=false;allowed=true;ui.sync();});await page.waitForFunction(()=>ui.state.preferencesReady);
      assert.equal(await main.locator('[type=submit]').isDisabled(),true);
      assert.match(await main.locator('[data-report-status]').textContent(),/kein vollständiger importierter Filialbestand/);
      assert.equal(await main.locator('[data-report-retry]').isVisible(),true);
      await page.evaluate(()=>fixtureContext.available=true);await main.locator('[data-report-retry]').click();await page.waitForFunction(()=>!document.querySelector('[data-report-form] [type=submit]').disabled);
    });
    await t.test('a late account A PDF cannot replace a ready account B canvas or download',async()=>{
      await prepareAccount('A');
      await page.evaluate(()=>holdPdf=true);await main.locator('[data-report-pdf]').click();await page.waitForFunction(()=>pdfReleases.length===1);
      const heldCall=await page.evaluate(()=>pdfCalls.length-1);
      await page.evaluate(()=>holdPdf=false);await prepareAccount('B');
      await main.locator('[data-report-pdf]').click();await page.waitForFunction(()=>!document.querySelector('[data-gp-print-download]').disabled);
      await pdf.locator('[name=title]').fill('BEISPIEL Konto B - aktueller Bericht');await pdf.locator('[name=filename]').fill('Konto-B-Auswertung');
      await page.waitForFunction(()=>!document.querySelector('[data-gp-print-download]').disabled);await page.waitForTimeout(200);
      const before=await fingerprint(),count=await pdf.locator('[data-gp-print-count]').textContent(),renderedB=pdfSamples.at(-1);
      assert.equal(await page.evaluate(index=>pdfCalls[index].signal.aborted,heldCall),true);
      await page.evaluate(()=>pdfReleases.shift()());await page.waitForTimeout(200);
      assert.deepEqual(await fingerprint(),before);assert.equal(await pdf.locator('[data-gp-print-count]').textContent(),count);
      assert.equal(await pdf.locator('[data-gp-print-download]').isDisabled(),false);
      const downloadPromise=page.waitForEvent('download',{timeout:3000});await pdf.locator('[data-gp-print-download]').click();const download=await downloadPromise;
      assert.equal(download.suggestedFilename(),'Konto-B-Auswertung.pdf');assert.ok(fs.readFileSync(await download.path()).equals(renderedB.buffer));
      await pdf.locator('[data-gp-print-close]').click();await page.waitForFunction(()=>document.querySelector('.gp-print-window').hidden);
    });
    await t.test('table column changes preserve independently configured PDF while open and minimized',async()=>{
      await prepareAccount('A');await main.locator('[data-report-pdf]').click();await page.waitForFunction(()=>!document.querySelector('[data-gp-print-download]').disabled);
      await pdf.locator('[data-report-pdf-columns] input[value=quantity]').uncheck();await page.waitForFunction(()=>!document.querySelector('[data-gp-print-download]').disabled);
      const titleBox=await pdf.locator('[data-gp-print-title]').boundingBox();await page.mouse.move(titleBox.x+100,titleBox.y+22);await page.mouse.down();await page.mouse.move(110,45,{steps:4});await page.mouse.up();
      // Keep the separate table's chooser exposed beside the print window.
      const east=await pdf.locator('[data-gp-window-edge=e]').boundingBox();await page.mouse.move(east.x+east.width/2,east.y+100);await page.mouse.down();await page.mouse.move(east.x+east.width/2-220,east.y+100,{steps:4});await page.mouse.up();
      await page.waitForTimeout(200);
      const columns=await pdf.locator('[data-report-pdf-columns] input:checked').evaluateAll(nodes=>nodes.map(n=>n.value)),before=await fingerprint(),count=await pdf.locator('[data-gp-print-count]').textContent(),requests=await page.evaluate(()=>pdfCalls.length),rendered=pdfSamples.at(-1);
      await main.locator('[data-report-columns]>summary').click();const description=main.locator('[data-report-column=description]'),descriptionChecked=await description.isChecked();
      await description.setChecked(!descriptionChecked);await page.waitForFunction(expected=>persisted.A.preferences.columns.includes('description')===expected,!descriptionChecked);
      assert.deepEqual(await pdf.locator('[data-report-pdf-columns] input:checked').evaluateAll(nodes=>nodes.map(n=>n.value)),columns);assert.deepEqual(await fingerprint(),before);
      await pdf.locator('[data-gp-print-min]').click();assert.equal(await pdf.locator('[data-gp-print-body]').isVisible(),false);
      const ordered=main.locator('[data-report-column=ordered]'),orderedChecked=await ordered.isChecked();await ordered.setChecked(!orderedChecked);await page.waitForFunction(expected=>persisted.A.preferences.columns.includes('ordered')===expected,!orderedChecked);
      assert.equal(await pdf.locator('canvas').count(),1);assert.equal(await pdf.locator('[data-gp-print-download]').isDisabled(),false);
      await pdf.locator('[data-gp-print-min]').click();await page.waitForTimeout(250);
      assert.deepEqual(await pdf.locator('[data-report-pdf-columns] input:checked').evaluateAll(nodes=>nodes.map(n=>n.value)),columns);assert.deepEqual(await fingerprint(),before);
      assert.equal(await pdf.locator('[data-gp-print-count]').textContent(),count);assert.equal(await page.evaluate(()=>pdfCalls.length),requests,'Table layout changes do not request a new PDF');
      const downloadPromise=page.waitForEvent('download',{timeout:3000});await pdf.locator('[data-gp-print-download]').click();const download=await downloadPromise;
      assert.ok(fs.readFileSync(await download.path()).equals(rendered.buffer));
      await pdf.locator('[data-gp-print-close]').click();await page.waitForFunction(()=>document.querySelector('.gp-print-window').hidden);
    });
    assert.deepEqual(errors,[]);
  } finally { await browser.close();if(localServer)await new Promise(resolve=>localServer.close(resolve)); }
});

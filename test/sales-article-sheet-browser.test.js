'use strict';
// Synthetic HTTP API, actual article tools/GP print shell and real PDF renderer.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),sharp=require('sharp');
const Sheet=require('../lib/sales-article-sheet-pdf'),Export=require('../public/trade-export-options');
const repo=path.resolve(__dirname,'..');
const initialOptions={stamp:'date-suffix',position:'after',separator:'_',suffix:'Beispiel-West'};
function exampleModel(){
  const number='001234';return {generatedAt:'2026-10-08T12:00:00Z',article:{articleNumber:number,description:'BEISPIEL Fernglas 10 × 42',active:true,currentRevision:3,image:{present:true},
    identifiers:[{identifierType:'ean13',identifierValue:'4000000001234',isPrimary:true}],
    provenance:{originSourceSystem:'example',currentSourceSystem:'example',updatedAt:'2026-10-08T03:00:00Z'},
    prices:{sales:[{priceType:'sales',priceBasis:'gross',usable:true,currency:'EUR',amount:'249.90'}],costs:[]},
    sourceSections:[{id:'master',title:'Stammdaten',fields:[{id:'Marke',label:'Marke',value:'BEISPIEL Optik'},{id:'Sortimentsart',label:'Sortimentsart',value:'Abverkauf'},{id:'ArtikelBezInternet',label:'Internetbezeichnung',value:'BEISPIEL Fernglas 10 × 42'}]},
      {id:'supplier',title:'Lieferant & Bestellung',fields:[{id:'Suchname',label:'Lieferant',value:'BEISPIEL Lieferant'},{id:'Bestellnummer',label:'Bestellnummer',value:'FG-1042'},{id:'Kondition',label:'Kondition',value:'Standard'}]}],
    branchStock:{sourceAt:'2026-10-08T03:00:00Z',rows:[{id:'18',name:'BEISPIEL West',quantity:'4'},{id:'11',name:'BEISPIEL Mitte',quantity:'2'}]},
    priceMatrix:{costsRead:true,vatPercent:20,purchase:[{label:'Ø EK',current:{amount:'129.90'},future:null}],sales:[{label:'EH',gross:{amount:'249.90'},net:{amount:'208.25'},margin:{amount:'78.35'},marginPercent:'37.62',date:'2026-10-08',person:'42'}]},
    notes:{available:true,sourceAt:'2026-10-08T03:00:00Z',items:[{date:'2026-10-08',text:'BEISPIEL: Aktionsware mit Schutzetui.',person:'42'}]}},
    localNotes:{items:[{id:'example-note',text:'BEISPIEL: Vorführung im Verkaufsraum.',createdAt:'2026-10-08T09:00:00Z',author:'42'}]},
    revisions:[{revision:3,articleNumber:number,description:'BEISPIEL aktueller Stand',active:true,createdAt:'2026-10-08T03:00:00Z'}],
    movements:{available:true,durationMs:15,dateFrom:'2026-07-11',dateTo:'2026-10-08',rows:Array.from({length:12},(_,i)=>({date:'2026-10-07',articleNumber:number,quantity:'1',label:`BEISPIEL Umlagerung ${i+1}`,from:'BEISPIEL Mitte',to:'BEISPIEL West',documentRefs:'BEISPIEL LS-'+i}))},
    sales:{available:true,complete:true,durationMs:20,capabilities:{sellers:true,customers:true,margin:true},note:'BEISPIEL Historienstand',rows:Array.from({length:12},(_,i)=>({date:'2026-10-06',locationId:'18',sourceLocationId:'18',personnel:'42',personnelSurname:'Beispiel',articleNumber:number,quantity:'1',description:`BEISPIEL Verkauf ${i+1}`,actualGross:'249.90',actualMargin:'78.35',actualMarginPercent:'37.62',status:'sale',receipt:'BEISPIEL-'+i}))}};
}

test('article sheet opens its shared PDF window with saved options, scoped histories and real preview bytes',{
  skip:process.env.GP_ARTICLE_SHEET_BROWSER_TEST!=='1',timeout:90000,
},async t=>{
  const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');
  const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
  let server;const errors=[],model=exampleModel(),pdfs=[],requests=[],state={holdReads:true,readWaiters:[],holdWrites:false,writeWaiters:[],holdPdfs:false,pdfWaiters:[],saved:{A:{...initialOptions},B:{stamp:'none',position:'before',separator:'-',suffix:''}},rights:{A:{sales:true,movements:true},B:{sales:false,movements:false}}};
  model.imageBuffer=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="420" height="260"><rect width="420" height="260" fill="#edf2ef"/><g fill="#2d5c4e" stroke="#21483d" stroke-width="8"><rect x="96" y="69" width="74" height="111" rx="14"/><rect x="250" y="69" width="74" height="111" rx="14"/><path d="M170 94h80v37h-80z"/><circle cx="133" cy="176" r="48"/><circle cx="287" cy="176" r="48"/></g><g fill="#93b3a9"><circle cx="133" cy="176" r="28"/><circle cx="287" cy="176" r="28"/></g><text x="210" y="242" text-anchor="middle" fill="#496358" font-family="sans-serif" font-size="15">BEISPIEL ARTIKELFOTO</text></svg>')).webp().toBuffer();
  try{
    const page=await browser.newPage({viewport:{width:1600,height:1100},acceptDownloads:true});page.on('pageerror',e=>errors.push(e.message));
    const styles=['styles.css','sales-article-tools.css','gp-window.css','gp-print-window.css','table-layout.css'].map(file=>fs.readFileSync(path.join(repo,'public',file),'utf8')).join('\n');
    const index=fs.readFileSync(path.join(repo,'public/index.html'),'utf8'),start=index.indexOf('<section class="sales-article-detail" id="salesArticleDetail"');
    assert.ok(start>=0,'Real article detail markup exists');
    const detail=index.slice(start,index.indexOf('<section id="crmView"',start)).replace(/<\/div>\s*<\/section>\s*$/,'');
    const html=`<!doctype html><meta charset="utf-8"><style>${styles}\n.sidebar h2{font-size:17px;color:white}.sales-article-detail-tab-panel[hidden]{display:none!important}</style><div class="app-shell"><aside class="sidebar"><h2>Grabenplaner</h2><div class="sidebar-session"><div class="sidebar-session-copy"><strong>BEISPIEL Filialleitung</strong><span>Lokale Designvorschau</span></div></div><nav class="main-nav"><button class="nav-item">Dashboard</button><button class="nav-item">Verkaufsanalysen</button><button class="nav-item active">Artikelstamm</button><button class="nav-item">Artikel-Auswertung</button><button class="nav-item">Einkauf &amp; Bestand</button></nav></aside><main class="main-content"><section id="salesArticleCatalogView" class="view active sales-article-catalog-view"><header class="topbar"><div><span class="eyebrow">Verkaufsverwaltung</span><h1>Artikelstamm</h1><p class="subtitle">Zentrale Artikeldaten schnell und übersichtlich finden.</p></div></header>${detail}</section></main></div>`;
    const vendorRoot=path.dirname(require.resolve('pdfjs-dist/package.json')),publicRoot=path.join(repo,'public');
    const json=(response,value)=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
    server=http.createServer(async(request,response)=>{
      try{
        const url=new URL(request.url,'http://127.0.0.1');response.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'"+(url.pathname.startsWith('/vendor/pdfjs-v6.2.108/')?" 'wasm-unsafe-eval'":"")+"; worker-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
        response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Cross-Origin-Opener-Policy','same-origin');response.setHeader('Cross-Origin-Resource-Policy','same-origin');
        if(url.pathname==='/'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);return;}
        if(url.pathname.startsWith('/api/')){
          const owner=String(request.headers['x-fixture-owner']||'A'),raw=[];for await(const chunk of request)raw.push(chunk);const body=raw.length?JSON.parse(Buffer.concat(raw).toString()):null;
          requests.push({owner,path:url.pathname,method:request.method,body});
          if(url.pathname.endsWith('/tools/context')){json(response,{...state.rights[owner],today:'2026-10-08',sellers:true,salesLocations:[{id:'18',label:'BEISPIEL West'}],movementLocations:[{id:'18',label:'BEISPIEL West'},{id:'11',label:'BEISPIEL Mitte'}]});return;}
          if(url.pathname.endsWith('/tools/pdf-options')){
            if(request.method==='GET'){const value={...state.saved[owner]};if(state.holdReads)await new Promise(resolve=>state.readWaiters.push(resolve));json(response,value);}
            else{if(state.holdWrites)await new Promise(resolve=>state.writeWaiters.push(resolve));state.saved[owner]=body;json(response,body);}return;
          }
          if(url.pathname.endsWith('/sheet.pdf')){
            const result=await Sheet.createSalesArticleSheetPdf(model,{sections:body.sections,includeImage:body.includeImage,title:body.title,orientation:body.orientation});
            const naming=Object.fromEntries(['stamp','position','separator','suffix'].map(key=>[key,body[key]]));
            const filename=Export.filename(body.name,naming,new Date(model.generatedAt));pdfs.push({buffer:result,filename,body,owner});
            if(state.holdPdfs)await new Promise(resolve=>state.pdfWaiters.push(resolve));
            if(!response.destroyed){response.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(filename)});response.end(result);}return;
          }
          if(url.pathname.endsWith('/history/sales')){json(response,{...model.sales,total:model.sales.rows.length,next:null,resultSet:'example',columns:{date:'Datum',locationId:'Filiale',quantity:'Anzahl',actualGross:'VK brutto'}});return;}
          if(url.pathname.endsWith('/article-movements')){json(response,{...model.movements,next:null});return;}
          if(url.pathname.includes('/local-notes')){json(response,{items:model.localNotes.items,revision:1});return;}
          if(url.pathname.includes('/table-options/')){const kind=url.pathname.split('/').at(-1);json(response,{columns:kind==='article-notes'?['date','text','person','origin']:kind==='article-sales'?['date','locationId','quantity','actualGross']:['date','articleNumber','quantity','label','from','to','typeLabel','documentRefs','supplier','issueLabel'],widths:{}});return;}
          throw Error('Unexpected API '+url.pathname);
        }
        const prefix='/vendor/pdfjs-v6.2.108/',vendor=url.pathname.startsWith(prefix),root=vendor?vendorRoot:publicRoot,file=path.resolve(root,decodeURIComponent(url.pathname.slice(vendor?prefix.length:1)));
        if(file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){
          response.writeHead(200,{'Content-Type':{'.mjs':'application/javascript','.js':'application/javascript','.wasm':'application/wasm','.ttf':'font/ttf'}[path.extname(file)]||'application/octet-stream'});response.end(fs.readFileSync(file));return;
        }
        response.writeHead(404);response.end();
      }catch(error){if(!response.destroyed){response.writeHead(500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:error.message}));}}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await page.goto('http://127.0.0.1:'+server.address().port+'/');
    for(const file of ['gp-window-preferences.js','gp-window.js','sales-article-report-pdf-preview.js','gp-print-window.js','table-layout.js','trade-table-layout.js','trade-insight-results.js','trade-export-options.js','sales-article-detail-preferences.js','sales-article-layout.js','sales-article-tools.js'])await page.addScriptTag({url:'/'+file});
    const waitServer=async predicate=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error('Expected fixture server event did not arrive');await new Promise(resolve=>setTimeout(resolve,10));}};
    await page.evaluate(initialArticle=>{
      window.actor='A';window.pageActive=true;window.article=initialArticle;
      window.api=async(url,options={})=>{const response=await fetch(url,{...options,headers:{'Content-Type':'application/json','X-Fixture-Owner':actor,...options.headers}});const value=await response.json();if(!response.ok)throw Error(value.error);return value;};
      window.rawApi=(url,options)=>fetch(url,{...options,headers:{'X-Fixture-Owner':actor,...options.headers}});
      window.mountTools=()=>{
        const root=document.querySelector('#salesArticleDetailBody'),formats={money:(value)=>new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(Number(value)),timestamp:()=> '08.10.26, 05:00'};
        root.innerHTML='<section id="salesArticleOverviewPanel" class="sales-article-detail-tab-panel">'+SalesArticleLayout.overview(article,formats)+'</section><section id="salesArticleNotesSection" class="sales-article-detail-tab-panel" hidden></section><section id="salesArticleMovementsSection" class="sales-article-detail-tab-panel" hidden></section><section id="salesArticleSalesSection" class="sales-article-detail-tab-panel" hidden></section>';
        window.tools=SalesArticleTools.mount(root,{api,rawApi,article,accessKey:()=>actor,active:()=>pageActive,scale:()=>1,trigger:()=>document.querySelector('#salesArticlePdfButton')});
      };
      document.querySelector('#salesArticleDetailTitle').textContent='Artikel '+article.articleNumber;document.querySelector('#salesArticleDetailSubtitle').textContent=article.description;
      document.querySelector('#salesArticleDetailActions').classList.remove('hidden');document.querySelector('#salesArticlePdfButton').classList.remove('hidden');
      document.querySelector('#salesArticlePdfButton').addEventListener('click',()=>void tools.openPdf());mountTools();
    },model.article);
    const shell=page.locator('[data-gp-print-id=article-sheet-pdf]'),button=page.locator('#salesArticlePdfButton'),download=()=>shell.locator('[data-gp-print-download]');
    const waitReady=()=>page.waitForFunction(()=>document.querySelector('[data-gp-print-download]')?.disabled===false);
    const screenshot=async name=>{if(!process.env.GP_ARTICLE_SHEET_SCREENSHOTS)return;fs.mkdirSync(process.env.GP_ARTICLE_SHEET_SCREENSHOTS,{recursive:true});await page.mouse.move(1450,20);await page.waitForTimeout(180);await page.screenshot({path:path.join(process.env.GP_ARTICLE_SHEET_SCREENSHOTS,name),fullPage:true});};
    await t.test('early repeated clicks share one options read and never overwrite saved options before hydration',async()=>{
      for(let i=0;i<4;i++)await button.click();await waitServer(()=>state.readWaiters.length===1);
      assert.equal(await shell.count(),0);assert.equal(requests.filter(r=>r.path.endsWith('/pdf-options')&&r.method==='POST').length,0);assert.equal(pdfs.length,0);
      state.holdReads=false;state.readWaiters.shift()();await waitReady();
      assert.equal(requests.filter(r=>r.path.endsWith('/pdf-options')&&r.method==='GET').length,1);assert.equal(await shell.locator('[name=stamp]').inputValue(),'date-suffix');assert.equal(await shell.locator('[name=suffix]').inputValue(),'Beispiel-West');
      assert.equal(requests.filter(r=>r.path.endsWith('/pdf-options')&&r.method==='POST').length,0);assert.equal(pdfs.at(-1).body.includeImage,true);
      await screenshot('01-article-sheet-window-light.png');
    });
    await t.test('title, orientation, image and sections reach the renderer and the download matches the actual preview bytes',async()=>{
      await shell.locator('[name=title]').fill('BEISPIEL Ferngläser - Stammblatt');await shell.locator('[name=filename]').fill('Beispiel-Fernglaeser');await shell.locator('[name=orientation]').selectOption('portrait');
      await shell.locator('[name=section][value=sales]').check();await shell.locator('[name=section][value=movements]').check();await waitReady();
      const result=pdfs.at(-1);assert.equal(result.body.title,'BEISPIEL Ferngläser - Stammblatt');assert.equal(result.body.orientation,'portrait');assert.equal(result.body.includeImage,true);assert.ok(result.body.sections.includes('sales')&&result.body.sections.includes('movements'));
      assert.deepEqual(result.body.sales,{dateFrom:'2025-10-08',dateTo:'2026-10-08'});assert.deepEqual(result.body.movements,{dateFrom:'2026-07-11',dateTo:'2026-10-08'});
      const pending=page.waitForEvent('download');await download().click();const saved=await pending;assert.ok(fs.readFileSync(await saved.path()).equals(result.buffer));assert.equal(saved.suggestedFilename(),result.filename);
      if(process.env.GP_ARTICLE_SHEET_SCREENSHOTS)fs.writeFileSync(path.join(process.env.GP_ARTICLE_SHEET_SCREENSHOTS,'article-sheet-browser-example.pdf'),result.buffer);
      await page.evaluate(()=>document.documentElement.dataset.activePageTheme='dark');await screenshot('02-article-sheet-window-dark.png');await page.evaluate(()=>document.documentElement.dataset.activePageTheme='light');
    });
    await t.test('queued option writes keep the newest configuration when an older save completes late',async()=>{
      await shell.locator('[data-gp-print-form] details>summary').click();state.holdWrites=true;
      await shell.locator('[name=suffix]').fill('Alter-Stand');await waitServer(()=>state.writeWaiters.length===1);
      const before=requests.filter(r=>r.path.endsWith('/pdf-options')&&r.method==='POST').length;
      await shell.locator('[name=suffix]').fill('Neuer-Stand');await page.waitForTimeout(600);
      assert.equal(requests.filter(r=>r.path.endsWith('/pdf-options')&&r.method==='POST').length,before,'New save waits behind the old in-flight write');assert.equal(await download().isDisabled(),true);
      state.holdWrites=false;state.writeWaiters.shift()();await waitReady();assert.equal(state.saved.A.suffix,'Neuer-Stand');assert.equal(pdfs.at(-1).body.suffix,'Neuer-Stand');
      await shell.locator('[data-gp-print-close]').click();await page.waitForFunction(()=>document.querySelector('[data-gp-print-id=article-sheet-pdf]').hidden);await button.click();await waitReady();assert.equal(await shell.locator('[name=suffix]').inputValue(),'Neuer-Stand');
    });
    await t.test('submitted history filters are exported while unsent edits stay out of the PDF snapshot',async()=>{
      await shell.locator('[data-gp-print-close]').click();await page.waitForFunction(()=>document.querySelector('[data-gp-print-id=article-sheet-pdf]').hidden);
      await page.evaluate(()=>{document.querySelector('#salesArticleSalesSection').hidden=false;tools.activate('salesArticleSalesSection');});
      await page.waitForFunction(()=>document.querySelector('#salesArticleSalesSection [role=status]').textContent.startsWith('12 Treffer'));
      await page.evaluate(()=>{const form=document.querySelector('#salesArticleSalesSection form');form.elements.dateFrom.value='2026-09-01';form.elements.dateTo.value='2026-10-07';});
      await page.locator('#salesArticleSalesSection [name=locationId]').selectOption('18');await page.locator('#salesArticleSalesSection [name=personnel]').fill('42');await page.locator('#salesArticleSalesSection [type=submit]').click();
      await page.waitForFunction(()=>document.querySelector('#salesArticleSalesSection [role=status]').textContent.startsWith('12 Treffer'));
      await page.evaluate(()=>{const panel=document.querySelector('#salesArticleSalesSection');panel.querySelector('form').elements.dateFrom.value='2026-08-01';panel.hidden=true;});
      await button.click();await waitReady();await shell.locator('[name=section][value=sales]').check();await waitReady();
      assert.deepEqual(pdfs.at(-1).body.sales,{dateFrom:'2026-09-01',dateTo:'2026-10-07',locationId:'18',personnel:'42'});
    });
    await t.test('navigation suspends and restores the same in-flight preview and minimized geometry',async()=>{
      await shell.locator('[data-gp-print-close]').click();await page.waitForFunction(()=>document.querySelector('[data-gp-print-id=article-sheet-pdf]').hidden);
      state.holdPdfs=true;await button.click();await waitServer(()=>state.pdfWaiters.length===1);
      await page.evaluate(()=>{pageActive=false;tools.syncPrint();});assert.equal(await shell.isVisible(),false);
      state.holdPdfs=false;state.pdfWaiters.shift()();await page.waitForFunction(()=>document.querySelector('[data-gp-print-status]').textContent==='Vorschau entspricht der PDF-Datei.');
      const count=pdfs.length;await page.evaluate(()=>{pageActive=true;tools.syncPrint();});await waitReady();assert.equal(pdfs.length,count);assert.equal(await shell.locator('canvas').count(),1);
      await shell.locator('[data-gp-print-min]').click();assert.equal(Math.round((await shell.boundingBox()).height),44);await page.evaluate(()=>{pageActive=false;tools.syncPrint();pageActive=true;tools.syncPrint();});assert.equal(Math.round((await shell.boundingBox()).height),44);await shell.locator('[data-gp-print-min]').click();
      await page.setViewportSize({width:560,height:900});await shell.locator('canvas').scrollIntoViewIfNeeded();await screenshot('03-article-sheet-window-narrow.png');await page.setViewportSize({width:1600,height:1100});
    });
    await t.test('account changes destroy the previous window and missing history/image grants disable those choices',async()=>{
      state.holdPdfs=true;await shell.locator('[name=title]').fill('BEISPIEL alter Kontostand');await waitServer(()=>state.pdfWaiters.length===1);
      await page.evaluate(()=>{actor='B';tools.destroy();article={...article,image:{present:false}};mountTools();});assert.equal(await shell.count(),0);
      state.holdPdfs=false;
      await button.click();await waitReady();assert.equal(await shell.locator('[name=section][value=sales]').isDisabled(),true);assert.equal(await shell.locator('[name=section][value=movements]').isDisabled(),true);assert.equal(await shell.locator('[name=image]').isDisabled(),true);
      assert.equal(pdfs.at(-1).owner,'B');assert.equal(pdfs.at(-1).body.includeImage,false);assert.deepEqual(pdfs.at(-1).body.sections,['master','prices','notes']);
      const current=pdfs.at(-1),pageCount=await shell.locator('[data-gp-print-count]').textContent();state.pdfWaiters.shift()();await page.waitForTimeout(180);
      assert.equal(await shell.locator('[data-gp-print-count]').textContent(),pageCount);assert.equal(await shell.locator('[name=title]').inputValue(),'Artikel 001234');assert.equal(await shell.locator('canvas').count(),1);
      const pending=page.waitForEvent('download');await download().click();assert.ok(fs.readFileSync(await(await pending).path()).equals(current.buffer),'A late PDF cannot replace the B download');
      await page.evaluate(()=>tools.destroy());assert.equal(await page.locator('.gp-print-window').count(),0);assert.equal(await page.locator('canvas').count(),0);
    });
    assert.deepEqual(errors,[],'No browser, CSP or worker cleanup exceptions');
  }finally{state.readWaiters.splice(0).forEach(done=>done());state.writeWaiters.splice(0).forEach(done=>done());state.pdfWaiters.splice(0).forEach(done=>done());await browser.close();if(server)await new Promise(resolve=>server.close(resolve));}
});

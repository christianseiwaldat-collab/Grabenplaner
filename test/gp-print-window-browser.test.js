'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const Pdf=require('../lib/sales-article-report-pdf');
const repo=path.resolve(__dirname,'..');

test('standard print window uses real PDF bytes and isolates malformed outputs, owners and independent consumers',{
  skip:process.env.GP_PRINT_WINDOW_BROWSER_TEST!=='1',timeout:60000,
},async t=>{
  const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');
  const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
  let server;const errors=[],documents=[];
  try{
    const page=await browser.newPage({viewport:{width:1450,height:1000},acceptDownloads:true});page.on('pageerror',error=>errors.push(error.message));
    await page.exposeFunction('createExamplePdf',async input=>{
      const spec=Pdf.normalize({filters:{locations:['18'],stock:'positive',assortment:'all'},columns:['articleNumber','description','quantity'],title:input.values.title,name:input.values.filename,orientation:input.values.orientation},{prices:true,costs:true,margin:true});
      const rows=Array.from({length:45},(_,i)=>({articleNumber:String(i+1).padStart(6,'0'),description:`BEISPIEL ${input.actor} Artikel ${i+1}`,quantity:String(i%6+1)}));
      const result=await Pdf.render({spec,report:{available:true,rows,total:rows.length,hasMore:false,sourceAt:'2026-10-08T03:00:00Z'},generatedAt:'2026-10-08T12:00:00Z'});
      documents.push(result);return {base64:result.buffer.toString('base64'),pages:result.pages};
    });
    const styles=['styles.css','gp-window.css','gp-print-window.css'].map(file=>fs.readFileSync(path.join(repo,'public',file),'utf8')).join('\n');
    const html=`<!doctype html><meta charset="utf-8"><style>${styles}</style><main><button id="opener">BEISPIEL PDF öffnen</button></main>`;
    const vendorRoot=path.dirname(require.resolve('pdfjs-dist/package.json')),publicRoot=path.join(repo,'public');
    const appSource=fs.readFileSync(path.join(publicRoot,'app.js'),'utf8');
    const appFunction=name=>{const start=appSource.indexOf('function '+name+'('),end=appSource.indexOf('\n}',start)+2;assert.ok(start>=0&&end>start,name);return appSource.slice(start,end);};
    const usbAppLifecycle=['canUseUsbGuidePrint','syncUsbGuidePrint'].map(appFunction).join('\n');
    const portalSource=fs.readFileSync(path.join(publicRoot,'portal.js'),'utf8');
    const portalFunction=name=>{const start=portalSource.indexOf('function '+name+'('),end=portalSource.indexOf('\n}',start)+2;assert.ok(start>=0&&end>start,name);return portalSource.slice(start,end);};
    const loanPrintLifecycle=['clearLoanConfirmationPrintState','loanConfirmationPrintSignature','portalLoanDocumentPrintBridge'].map(portalFunction).join('\n');
    server=http.createServer((request,response)=>{
      const url=new URL(request.url,'http://127.0.0.1');
      response.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'"+(url.pathname.startsWith('/vendor/pdfjs-v6.2.108/')?" 'wasm-unsafe-eval'":"")+"; worker-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
      response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Cross-Origin-Opener-Policy','same-origin');response.setHeader('Cross-Origin-Resource-Policy','same-origin');
      if(url.pathname==='/'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);return;}
      if(url.pathname==='/usb-app-lifecycle.js'){response.writeHead(200,{'Content-Type':'application/javascript'});response.end(usbAppLifecycle);return;}
      if(url.pathname==='/loan-print-lifecycle.js'){response.writeHead(200,{'Content-Type':'application/javascript'});response.end(loanPrintLifecycle);return;}
      const prefix='/vendor/pdfjs-v6.2.108/',vendor=url.pathname.startsWith(prefix),root=vendor?vendorRoot:publicRoot;
      const file=path.resolve(root,decodeURIComponent(url.pathname.slice(vendor?prefix.length:1)));
      if(file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){
        response.writeHead(200,{'Content-Type':{'.mjs':'application/javascript','.js':'application/javascript','.wasm':'application/wasm','.ttf':'font/ttf'}[path.extname(file)]||'application/octet-stream'});response.end(fs.readFileSync(file));return;
      }
      response.writeHead(404);response.end();
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await page.goto('http://127.0.0.1:'+server.address().port+'/');
    for(const file of ['gp-window-preferences.js','gp-window.js','sales-article-report-pdf-preview.js','gp-print-window.js','gp-existing-pdf-window.js','gp-document-print.js','gp-planning-print.js','gp-usb-guide-print.js','usb-app-lifecycle.js','loan-print-lifecycle.js'])await page.addScriptTag({url:'/'+file});
    await page.evaluate(()=>{
      window.actor='A';window.allowed=true;window.pageActive=true;window.mode='valid';window.hold=false;window.releases=[];window.calls=[];window.urls=[];window.revoked=[];window.cleanups=0;
      const originalCreate=URL.createObjectURL.bind(URL),originalRevoke=URL.revokeObjectURL.bind(URL);
      URL.createObjectURL=blob=>{const url=originalCreate(blob);urls.push(url);return url;};URL.revokeObjectURL=url=>{revoked.push(url);originalRevoke(url);};
      window.config=id=>({document,id,title:'BEISPIEL Standarddruck',key:()=>actor,canUse:()=>allowed,active:()=>pageActive,trigger:()=>document.querySelector('#opener'),defaults:{title:'BEISPIEL Auswertung',filename:'Beispiel-Ausgabe',orientation:'landscape'},debounce:40,
        renderOptions(host,{payload}){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.name='detail';input.checked=true;label.append(input,document.createTextNode(payload?.label||'BEISPIEL Detailzeilen'));host.append(label);return()=>cleanups++;},
        readOptions:host=>({detail:host.querySelector('[name=detail]')?.checked===true}),
        validateOptions:options=>options.detail?'':'Bitte Detailzeilen aktivieren.',
        async createPdf(input){const owner=input.actor,kind=mode;calls.push({id,owner,signal:input.signal,values:input.values,options:input.options,payload:input.payload});const example=await createExamplePdf({actor:owner,values:input.values});if(hold)await new Promise(resolve=>releases.push(resolve));
          const bytes=Uint8Array.from(atob(example.base64),char=>char.charCodeAt(0));return {blob:kind==='mime'?new Blob([bytes],{type:'text/html'}):kind==='header'?new Blob(['WRONG PDF data'],{type:'application/pdf'}):new Blob([bytes],{type:'application/pdf'}),pages:999,filename:'Beispiel-Ausgabe-2026-10-08',summary:'45 Zeilen'};}
      });
      window.print=GpPrintWindow.mount(config('print-a'));print.open({payload:{label:'BEISPIEL Optionen'}});
    });
    const shell=page.locator('[data-gp-print-id=print-a]'),download=shell.locator('[data-gp-print-download]');
    const waitReady=()=>page.waitForFunction(()=>print.state.ready);
    await t.test('actual parsed page count and download match the rendered bytes despite misleading metadata',async()=>{
      await waitReady();assert.equal(await shell.locator('canvas').count(),1);
      assert.equal(await page.evaluate(()=>print.state.pages),documents.at(-1).pages);assert.notEqual(await page.evaluate(()=>print.state.pages),999);
      assert.equal(await shell.locator('[data-gp-print-filename]').textContent(),'Beispiel-Ausgabe-2026-10-08.pdf');
      const pending=page.waitForEvent('download');await download.click();const result=await pending;
      assert.ok(fs.readFileSync(await result.path()).equals(documents.at(-1).buffer));assert.equal(result.suggestedFilename(),'Beispiel-Ausgabe-2026-10-08.pdf');
    });
    await t.test('common and extra validation blocks creation and malformed MIME or PDF headers cannot be downloaded',async()=>{
      const count=await page.evaluate(()=>calls.length);await shell.locator('[name=title]').fill('');await page.waitForFunction(()=>print.state.error.length>0);
      assert.equal(await page.evaluate(()=>calls.length),count);assert.equal(await download.isDisabled(),true);
      await shell.locator('[name=title]').fill('BEISPIEL gültig');await waitReady();
      await shell.locator('[name=detail]').uncheck();await page.waitForFunction(()=>print.state.error.includes('Detailzeilen'));assert.equal(await download.isDisabled(),true);
      await shell.locator('[name=detail]').check();await waitReady();
      for(const kind of ['mime','header']){
        await page.evaluate(value=>{mode=value;void print.refresh();},kind);await page.waitForFunction(()=>print.state.error.includes('ungültig'));
        assert.equal(await download.isDisabled(),true);assert.equal(await shell.locator('canvas').count(),0);
      }
      await page.evaluate(()=>{mode='valid';void print.refresh();});await waitReady();
    });
    await t.test('shared zoom changes the actual canvas scale while keeping PDF bytes, pages and download untouched',async()=>{
      const callsBefore=await page.evaluate(()=>calls.length),pages=await page.evaluate(()=>print.state.pages);
      for(const percentage of [90,80,60,50,100]){
        await shell.locator('[data-preview-zoom]').selectOption(String(percentage/100));
        await page.waitForFunction(({percent})=>Math.abs(parseFloat(document.querySelector('[data-gp-print-id=print-a] canvas')?.style.width||'0')-841.89*percent/100)<2,{percent:percentage});
      }
      await shell.locator('[data-preview-zoom]').selectOption('custom');await shell.locator('[data-preview-percent]').fill('73,5');
      await page.waitForFunction(()=>Math.abs(parseFloat(document.querySelector('[data-gp-print-id=print-a] canvas').style.width)-841.89*.735)<2);
      const width=await shell.locator('canvas').evaluate(canvas=>canvas.style.width);await shell.locator('[data-preview-percent]').fill('0');
      assert.equal(await shell.locator('[data-preview-percent]').getAttribute('aria-invalid'),'true');assert.equal(await shell.locator('canvas').evaluate(canvas=>canvas.style.width),width);
      await shell.locator('[data-preview-percent]').fill('80');await shell.locator('[data-preview-zoom]').selectOption('page');
      assert.equal(await shell.locator('[data-preview-custom]').isVisible(),false);assert.equal(await page.evaluate(()=>calls.length),callsBefore);assert.equal(await page.evaluate(()=>print.state.pages),pages);assert.equal(await download.isDisabled(),false);
    });
    await t.test('invalid custom zoom cannot stall a replacement PDF or a reopened window',async()=>{
      await shell.locator('[data-preview-zoom]').selectOption('custom');await shell.locator('[data-preview-percent]').fill('73,5');
      await page.waitForFunction(()=>Math.abs(parseFloat(document.querySelector('[data-gp-print-id=print-a] canvas').style.width)-841.89*.735)<2);
      await shell.locator('[data-preview-percent]').fill('0');
      await shell.locator('[name=title]').fill('BEISPIEL Erneuerte Ausgabe');await waitReady();
      assert.ok(Math.abs(parseFloat(await shell.locator('canvas').evaluate(canvas=>canvas.style.width))-841.89*.735)<2);
      assert.equal(await page.evaluate(()=>print.state.loading),false);assert.equal(await download.isDisabled(),false);
      await page.evaluate(()=>{print.reset();print.open({payload:{label:'BEISPIEL erneut geöffnet'}});});await waitReady();
      assert.equal(await shell.locator('canvas').count(),1);assert.equal(await download.isDisabled(),false);
      await shell.locator('[data-preview-zoom]').selectOption('page');
    });
    await t.test('two consumers keep independent fields and workers; reset revokes URLs and cancels stale work',async()=>{
      const firstTitle=await shell.locator('[name=title]').inputValue();
      await page.evaluate(()=>{window.second=GpPrintWindow.mount({...config('print-b'),geometry:{x:350,y:180,width:1000,height:700}});second.open({values:{title:'BEISPIEL zweite Ausgabe',filename:'Zweite-Ausgabe',orientation:'portrait'},payload:{label:'BEISPIEL zweite Optionen'}});});
      await page.waitForFunction(()=>second.state.ready);assert.equal(await shell.locator('[name=title]').inputValue(),firstTitle);
      assert.equal(await page.locator('[data-gp-print-id=print-b] [name=title]').inputValue(),'BEISPIEL zweite Ausgabe');assert.equal(await page.locator('canvas').count(),2);
      await page.evaluate(()=>second.destroy());assert.equal(await page.locator('[data-gp-print-id=print-b]').count(),0);assert.equal(await shell.locator('canvas').count(),1);
      await page.evaluate(()=>{hold=true;void print.refresh();});await page.waitForFunction(()=>releases.length===1);
      await page.evaluate(()=>{print.reset();hold=false;releases.shift()();});await page.waitForTimeout(150);
      assert.equal(await page.evaluate(()=>calls.at(-1).signal.aborted),true);assert.equal(await shell.isVisible(),false);assert.equal(await shell.locator('canvas').count(),0);
      assert.equal(await page.evaluate(()=>urls.every(url=>revoked.includes(url))),true,'Reset and destroy release every generated URL');
    });
    await t.test('owner synchronization and permission revocation erase option content and reject reopening',async()=>{
      await page.evaluate(()=>print.open({payload:{label:'BEISPIEL Konto A'}}));await waitReady();
      await page.evaluate(()=>{actor='B';print.sync();});assert.equal(await shell.isVisible(),false);assert.equal(await shell.locator('[data-gp-print-options]').textContent(),'');assert.equal(await shell.locator('canvas').count(),0);
      await page.evaluate(()=>print.open({payload:{label:'BEISPIEL Konto B'}}));await waitReady();assert.equal(await page.evaluate(()=>calls.at(-1).owner),'B');
      await page.evaluate(()=>{allowed=false;print.sync();});assert.equal(await shell.isVisible(),false);assert.equal(await page.evaluate(()=>print.open()),false);
      await page.evaluate(()=>{allowed=true;actor='';print.sync();});assert.equal(await page.evaluate(()=>print.open()),false);
      await page.evaluate(()=>print.destroy());assert.equal(await page.locator('.gp-print-window').count(),0);
    });
    await t.test('schedule sidebar keeps employee choices across design changes and blocks empty selections',async()=>{
      await page.evaluate(()=>{
        actor='A';allowed=true;window.planningRequests=[];
        window.planningContext={page:'planning',query:{week:'2026-10-12',location:'18'},settings:{pdf_title:'BEISPIEL Dienstplan'},designs:[{id:'matrix',label:'Wochenmatrix'},{id:'timeline',label:'Klassisch'}],employees:[{number:'420',name:'Alex Beispiel'},{number:'434',name:'Kim Beispiel'}]};
        window.planning=GpPlanningPrint.mount({document,key:()=>actor,canUse:()=>allowed,kind:'schedule',context:()=>planningContext,debounce:25,
          async rawApi(url){planningRequests.push(url);const result=await createExamplePdf({actor,values:{title:'BEISPIEL Dienstplan',filename:'Beispiel',orientation:'landscape'}});return new Response(Uint8Array.from(atob(result.base64),char=>char.charCodeAt(0)),{headers:{'Content-Type':'application/pdf'}});}});planning.open();
      });
      const plan=page.locator('[data-gp-print-id=schedule-pdf]');await page.waitForFunction(()=>planning.state.ready);
      assert.equal(await plan.locator('[name=title]').isVisible(),false);assert.equal(await plan.locator('[name=printEmployee]').count(),2);
      await plan.locator('[name=printEmployee][value="434"]').uncheck();await page.waitForFunction(()=>planning.state.ready&&planningRequests.at(-1).includes('employees=420'));
      await plan.locator('[name=design]').selectOption('timeline');await page.waitForFunction(()=>planning.state.ready&&planningRequests.at(-1).includes('design=timeline'));
      assert.ok((await page.evaluate(()=>planningRequests.at(-1))).includes('employees=420'));
      await plan.locator('[name=printEmployee][value="420"]').uncheck();await page.waitForFunction(()=>planning.state.error.includes('mindestens eine'));assert.equal(await plan.locator('[data-gp-print-download]').isDisabled(),true);
      await plan.getByRole('button',{name:'Alle auswählen'}).click();await page.waitForFunction(()=>planning.state.ready&&new URL(planningRequests.at(-1),'https://gp.example.test').searchParams.get('employees')==='420,434');
      await page.setViewportSize({width:391,height:850});await page.waitForTimeout(150);
      const overflows=await plan.evaluate(element=>[element,...element.querySelectorAll('.gp-print-grid,.article-report-pdf-viewer-tools')].filter(node=>node.scrollWidth>node.clientWidth+2).map(node=>node.className));assert.deepEqual(overflows,[]);
      await page.evaluate(()=>planning.destroy());
    });
    await t.test('USB application lifecycle restores the window and invalidates changed provisioning inputs',async()=>{
      await page.evaluate(()=>{
        window.state={currentView:'settings',portalStatus:{portalEnabled:true},portalSession:{authenticated:true,user:{role:'developer',permissions:['usb:provision']}}};
        window.usbContext={profile:'staff',firstSteps:{title:'Example'}};window.usbRequests=[];
        window.usbGuidePrint=GpUsbGuidePrint.mount({document,key:()=>actor,canUse:canUseUsbGuidePrint,active:()=>state.currentView==='settings',context:()=>usbContext,
          async rawApi(url,init){usbRequests.push({url,body:init.body});const result=await createExamplePdf({actor,values:{title:'BEISPIEL Erste Schritte',filename:'Erste-Schritte',orientation:'portrait'}});return new Response(Uint8Array.from(atob(result.base64),char=>char.charCodeAt(0)),{headers:{'Content-Type':'application/pdf'}});}});
        usbGuidePrint.open();
      });
      const usb=page.locator('[data-gp-print-id=usb-guide-pdf]');await page.waitForFunction(()=>usbGuidePrint.state.ready);
      await page.evaluate(()=>{state.currentView='sales';syncUsbGuidePrint();});assert.equal(await usb.isVisible(),false);
      await page.evaluate(()=>{state.currentView='settings';syncUsbGuidePrint();});await page.waitForFunction(()=>usbGuidePrint.state.ready);
      assert.equal(await usb.isVisible(),true);assert.equal(await usb.locator('canvas').count(),1);
      const restored=await page.evaluate(()=>usbRequests);assert.equal(restored.length,2);assert.equal(restored[0].body,restored[1].body);
      await page.evaluate(()=>{usbContext.firstSteps.title='Changed input';syncUsbGuidePrint();});
      assert.equal(await usb.isVisible(),false);assert.equal(await usb.locator('canvas').count(),0);assert.equal(await page.evaluate(()=>usbRequests.length),2);
      await page.evaluate(()=>usbGuidePrint.open());await page.waitForFunction(()=>usbGuidePrint.state.ready);
      assert.equal(JSON.parse(await page.evaluate(()=>usbRequests.at(-1).body)).firstSteps.title,'Changed input');
      await page.evaluate(()=>{state.portalSession.user.role='employee';syncUsbGuidePrint();});
      assert.equal(await usb.isVisible(),false);assert.equal(await page.evaluate(()=>usbGuidePrint.open()),false);
      await page.evaluate(()=>usbGuidePrint.destroy());
      assert.match(appSource,/usbProvisioningWizard\?\.addEventListener\(type,syncUsbGuidePrint\)/,'Real provisioning input/change events reach the same lifecycle');
    });
    await t.test('loan photo preview uses shared zoom and identical PDF download in GP and portal, restoring only the current dialog',async()=>{
      await page.setViewportSize({width:1450,height:1000});
      const original=documents[0].buffer;
      for(const surface of ['main','portal']){
        await page.evaluate(({surface,base64})=>{
          actor='A';allowed=true;window.loanPage='loan';window.loanRequests=[];window.loanRelease=null;window.loanHold=false;
          const fixture=document.createElement(surface==='portal'?'dialog':'section');fixture.id='loan-print-fixture';
          fixture.innerHTML='<label>Notiz<textarea id="loan-print-note">BEISPIEL angefangene Notiz</textarea></label><a id="loan-preview" href="/api/portal/v1/loans/photo-attachments/BEISPIEL/preview" target="_blank">Vorschau</a><a id="loan-download" href="/api/portal/v1/loans/photo-attachments/BEISPIEL/download">PDF herunterladen</a>';
          document.body.append(fixture);
          const confirmation={id:'C1',loanId:'L1',status:'pending',expectedRevision:2,expiresAt:new Date(Date.now()+60000).toISOString(),loan:{revision:2},photoAttachments:[{id:'BEISPIEL',revision:1,previewUrl:'/api/portal/v1/loans/photo-attachments/BEISPIEL/preview',downloadUrl:'/api/portal/v1/loans/photo-attachments/BEISPIEL/download'}]};
          window.portalState={activeTab:'loan',activeLoanConfirmation:confirmation,pendingLoanConfirmations:[confirmation]};
          window.el={loanConfirmationDialog:fixture,loanConfirmationNote:fixture.querySelector('textarea'),loanTab:document.querySelector('#opener')};
          window.loanConfirmationPrintBridge=null;window.portalDocumentActorKey=()=>actor;window.loanCapabilityEnabled=()=>allowed;
          if(surface==='portal')fixture.showModal();
          window.loanPrint=GpDocumentPrint.mount({document,id:'loan-photo-pdf',key:()=>actor,page:()=>loanPage,canUse:()=>allowed,context:()=>({scope:'example-branch'}),beforeOpen:surface==='portal'?portalLoanDocumentPrintBridge:null,
            async rawApi(url,init){loanRequests.push({url,signal:init.signal});if(loanHold)await new Promise(resolve=>loanRelease=resolve);return new Response(Uint8Array.from(atob(base64),char=>char.charCodeAt(0)),{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="Fotobeilage-BEISPIEL.pdf"'}});}});
        },{surface,base64:original.toString('base64')});
        const photo=page.locator('[data-gp-print-id=loan-photo-pdf]');
        await page.locator('#loan-preview').click();
        await photo.locator('canvas').waitFor();await page.waitForFunction(()=>!document.querySelector('[data-gp-print-id=loan-photo-pdf] [data-gp-print-download]').disabled);
        assert.equal(page.context().pages().length,1,'Preview was intercepted instead of opening a native PDF tab');
        assert.equal(await page.evaluate(()=>loanRequests.at(-1).url),'/api/portal/v1/loans/photo-attachments/BEISPIEL/preview');
        if(surface==='portal')assert.equal(await page.locator('#loan-print-fixture').evaluate(node=>node.open),false);
        await photo.locator('[data-preview-zoom]').selectOption('0.5');
        await page.waitForFunction(()=>Math.abs(parseFloat(document.querySelector('[data-gp-print-id=loan-photo-pdf] canvas').style.width)-841.89*.5)<2);
        const pending=page.waitForEvent('download');await photo.locator('[data-gp-print-download]').click();const result=await pending;
        assert.ok(fs.readFileSync(await result.path()).equals(original),'Zoom and preview preserve the original photo PDF bytes');
        assert.equal(result.suggestedFilename(),'Fotobeilage-BEISPIEL.pdf');
        await photo.locator('[data-gp-print-close]').click();await photo.waitFor({state:'hidden'});
        if(surface==='portal')assert.equal(await page.locator('#loan-print-fixture').evaluate(node=>node.open),true);
        assert.equal(await page.locator('#loan-print-note').inputValue(),'BEISPIEL angefangene Notiz');
        await page.evaluate(()=>loanHold=true);await page.locator('#loan-download').click();await page.waitForFunction(()=>typeof loanRelease==='function');
        await page.evaluate(()=>{actor='B';loanPrint.sync();loanRelease();});
        await photo.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>loanRequests.at(-1).signal.aborted),true);assert.equal(await photo.locator('canvas').count(),0);
        if(surface==='portal'){assert.equal(await page.locator('#loan-print-fixture').evaluate(node=>node.open),false);assert.equal(await page.locator('#loan-print-note').inputValue(),'');}
        await page.evaluate(()=>{loanPrint.destroy();document.querySelector('#loan-print-fixture').remove();});
      }
    });
    assert.deepEqual(errors,[],'No CSP, worker cleanup or browser exceptions');
  }finally{await browser.close();if(server)await new Promise(resolve=>server.close(resolve));}
});

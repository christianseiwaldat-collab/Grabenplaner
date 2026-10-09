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
    server=http.createServer((request,response)=>{
      const url=new URL(request.url,'http://127.0.0.1');
      response.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'"+(url.pathname.startsWith('/vendor/pdfjs-v6.2.108/')?" 'wasm-unsafe-eval'":"")+"; worker-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
      response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Cross-Origin-Opener-Policy','same-origin');response.setHeader('Cross-Origin-Resource-Policy','same-origin');
      if(url.pathname==='/'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);return;}
      const prefix='/vendor/pdfjs-v6.2.108/',vendor=url.pathname.startsWith(prefix),root=vendor?vendorRoot:publicRoot;
      const file=path.resolve(root,decodeURIComponent(url.pathname.slice(vendor?prefix.length:1)));
      if(file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){
        response.writeHead(200,{'Content-Type':{'.mjs':'application/javascript','.js':'application/javascript','.wasm':'application/wasm','.ttf':'font/ttf'}[path.extname(file)]||'application/octet-stream'});response.end(fs.readFileSync(file));return;
      }
      response.writeHead(404);response.end();
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await page.goto('http://127.0.0.1:'+server.address().port+'/');
    for(const file of ['gp-window-preferences.js','gp-window.js','sales-article-report-pdf-preview.js','gp-print-window.js'])await page.addScriptTag({url:'/'+file});
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
    assert.deepEqual(errors,[],'No CSP, worker cleanup or browser exceptions');
  }finally{await browser.close();if(server)await new Promise(resolve=>server.close(resolve));}
});

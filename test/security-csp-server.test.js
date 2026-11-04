'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawnSync}=require('node:child_process');
const browserEnabled=process.env.GP_CSP_BROWSER_TEST==='1';
function policy(response,framing="'none'") {
  const value=response.headers.get('content-security-policy');assert.ok(value);
  const directives=value.split(';').map(s=>s.trim()).filter(Boolean);
  const names=directives.map(s=>s.split(/\s/)[0].toLowerCase());
  assert.equal(new Set(names).size,names.length);
  for(const required of ["object-src 'none'","base-uri 'none'",'frame-ancestors '+framing])assert.ok(directives.includes(required),value);
  assert.equal(value.includes(','),false);return value;
}
test('server CSP: actual server responses, protected previews and local browser assets', {timeout:120000},async t=>{
  const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'gp-csp-server-'));
  let subject,server,proxy,browser;let publicOrigin='https://csp.example.test';
  try {
    if(browserEnabled) {
      const key=path.join(temporaryRoot,'key.pem'),cert=path.join(temporaryRoot,'cert.pem');
      const generated=spawnSync(process.env.GP_BROWSER_OPENSSL||'openssl',['req','-x509','-newkey','rsa:2048','-nodes','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-days','1','-keyout',key,'-out',cert],{windowsHide:true,stdio:'ignore',timeout:15000});
      assert.equal(generated.status,0,'local OpenSSL is required only for the opt-in browser fixture');
      proxy=require('node:https').createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)});
      await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));publicOrigin='https://127.0.0.1:'+proxy.address().port;
    }
    Object.assign(process.env,{NODE_ENV:'test',DB_PROVIDER:'sqlite',DATABASE_URL:'',DB_PATH:path.join(temporaryRoot,'fixture.db'),
      BACKUP_DIR:path.join(temporaryRoot,'backups'),GRABENPLANER_DATA_DIR:path.join(temporaryRoot,'data'),GRABENPLANER_HOST:'127.0.0.1',
      GRABENPLANER_FORCE_PORTAL:'1',GRABENPLANER_SEED_DEMO:'1',GRABENPLANER_OPERATION_MODE:'server',GRABENPLANER_PUBLIC_URL:publicOrigin,
      GRABENPLANER_TRUST_PROXY:'loopback',GRABENPLANER_DEPLOYMENT_KIND:'codespaces-test',
      GRABENPLANER_AMU_KEY_ID:'synthetic-csp',GRABENPLANER_AMU_KEY:Buffer.alloc(32,71).toString('base64'),
      GRABENPLANER_INTEGRATION_KEY_ID:'synthetic-csp',GRABENPLANER_INTEGRATION_KEY:Buffer.alloc(32,78).toString('base64'),
      GRABENPLANER_SERVICE_CONTROL_TOKEN:'synthetic-csp-service-secret-2026',GRABENPLANER_TEST_AMU_SCANNER:'clean'});
    subject=require('../server');await subject.initializeApplicationPersistence();
    server=await new Promise(resolve=>{const value=subject.app.listen(0,'127.0.0.1',()=>resolve(value));});
    const origin='http://127.0.0.1:'+server.address().port;
    if(proxy)proxy.on('request',(incoming,outgoing)=>{
      const upstream=http.request({hostname:'127.0.0.1',port:server.address().port,path:incoming.url,method:incoming.method,
        headers:{...incoming.headers,'x-forwarded-proto':'https','x-forwarded-for':'198.51.100.170'}},response=>{outgoing.writeHead(response.statusCode,response.headers);response.pipe(outgoing);});
      upstream.on('error',()=>{outgoing.writeHead(502);outgoing.end();});incoming.pipe(upstream);
    });
    const get=(route,cookie='')=>fetch(origin+route,{headers:{'X-Forwarded-Proto':'https',Cookie:cookie},signal:AbortSignal.timeout(15000)});
    await t.test('HTML, JSON, ordinary assets, OCR/PDF workers and errors keep the global minimum',async()=>{
      for(const route of ['/','/portal.html','/api/portal/v1/status','/styles.css','/app.js','/portal.js',
        '/vendor/tesseract-v7/worker.min.js','/vendor/pdfjs-v6.2.108/build/pdf.worker.min.mjs','/synthetic-csp-missing']) {
        const response=await get(route);const csp=policy(response);await response.arrayBuffer();
        if(!route.includes('missing'))assert.equal(response.status,200,route);
        assert.equal(csp.includes("'unsafe-eval'"),false);
        assert.equal(csp.includes("'wasm-unsafe-eval'"),route==='/portal.html'||route.startsWith('/vendor/'),route);
      }
    });
    await t.test('GET and HEAD fallback preserve CSP; the existing error handler still returns structured errors',async()=>{
      for(const method of ['GET','HEAD']) {
        const response=await fetch(origin+'/synthetic-csp-missing?secret=unreflected',{method,headers:{'X-Forwarded-Proto':'https'}});
        assert.equal(response.status,404);policy(response);assert.match(response.headers.get('content-type'),/^text\/plain/);
        assert.equal(await response.text(),method==='HEAD'?'':'Nicht gefunden.');
      }
      const response=await fetch(origin+'/api/portal/v1/auth/login',{method:'POST',headers:{'X-Forwarded-Proto':'https','Content-Type':'application/json',Origin:publicOrigin},body:'{'});
      assert.equal(response.status,400);policy(response);const body=await response.json();assert.equal(typeof body.error,'string');assert.ok(body.requestId);
    });
    const id='syn-csp-owner',password='Synthetic orbit spruce 2026!';
    const passwordHash=await subject.hashPortalPassword(password,{employeeNumber:id});
    subject.db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,active) VALUES(?,?,?,'#123456',40,1)").run(id,'Synthetic CSP Owner','Synthetic');
    subject.db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_policy_version) VALUES(?,?,'developer',1,0,1)").run(id,passwordHash);
    const login=await fetch(origin+'/api/portal/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-Proto':'https',Origin:publicOrigin},body:JSON.stringify({employeeNumber:id,password}),signal:AbortSignal.timeout(15000)});
    assert.equal(login.status,200,await login.clone().text());
    const cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
    await t.test('only the two existing PDF previews retain same-origin framing',async()=>{
      for(const route of ['/api/schedule-preview.pdf?week=2026-10-12','/api/vacations-preview.pdf?year=2026']) {
        const response=await get(route,cookie);assert.equal(response.status,200,await response.clone().text());policy(response,"'self'");
        assert.equal(response.headers.get('x-frame-options'),'SAMEORIGIN');assert.match(response.headers.get('content-type'),/^application\/pdf/);
        assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
      }
    });
    await t.test('real Chrome navigation, base injection, PDF rendering and local OCR retain intended behavior', {skip:!browserEnabled},async()=>{
      const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');
      browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{})});
      const context=await browser.newContext({ignoreHTTPSErrors:true});
      const external=[],responses=[],violations=[];
      await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==publicOrigin){external.push(route.request().url());return route.abort();}return route.continue();});
      const page=await context.newPage();page.on('response',response=>responses.push({url:response.url(),status:response.status()}));
      await page.exposeFunction('recordCspViolation',value=>violations.push(value));
      await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',event=>void window.recordCspViolation({directive:event.effectiveDirective,blocked:event.blockedURI})));
      await page.goto(publicOrigin+'/portal.html',{waitUntil:'networkidle'});
      await page.locator('#loginPersonnelNumber').fill(id);await page.locator('#loginPassword').fill(password);
      const loggedIn=page.waitForResponse(r=>r.url().endsWith('/api/portal/v1/auth/login')&&r.request().method()==='POST');
      await page.locator('#portalLoginForm button[type=submit]').click();assert.equal((await loggedIn).status(),200);
      await page.waitForFunction(async()=>Boolean((await fetch('/api/portal/v1/session').then(r=>r.json())).authenticated));
      const baseCheck=await page.evaluate(()=>{const before=document.baseURI,base=document.createElement('base');base.href='/synthetic-rebase/';document.head.prepend(base);return {before,after:document.baseURI};});
      assert.equal(baseCheck.after,baseCheck.before);assert.equal(baseCheck.after.includes('/synthetic-rebase/'),false);
      await page.waitForFunction(()=>document.querySelector('base')!==null);
      const pdf=await page.evaluate(async()=>{
        const mod=await import('/vendor/pdfjs-v6.2.108/build/pdf.min.mjs');mod.GlobalWorkerOptions.workerSrc='/vendor/pdfjs-v6.2.108/build/pdf.worker.min.mjs';
        const bytes=await fetch('/api/schedule-preview.pdf?week=2026-10-12').then(r=>r.arrayBuffer());
        const task=mod.getDocument({data:new Uint8Array(bytes),standardFontDataUrl:'/vendor/pdfjs-v6.2.108/standard_fonts/',wasmUrl:'/vendor/pdfjs-v6.2.108/wasm/'});
        const doc=await task.promise,first=await doc.getPage(1),viewport=first.getViewport({scale:.5}),canvas=document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;
        await first.render({canvasContext:canvas.getContext('2d'),viewport}).promise;const result={pages:doc.numPages,width:canvas.width,height:canvas.height};await task.destroy();return result;
      });assert.ok(pdf.pages>0&&pdf.width>0&&pdf.height>0);
      const ocr=await page.evaluate(async()=>{
        const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=260;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1200,260);ctx.fillStyle='black';ctx.font='48px Arial';ctx.fillText('Arbeitsunfaehigkeit',30,65);ctx.fillText('von 18.10.2026 bis 21.10.2026',30,140);
        const client=GrabenplanerAmuOcrClient.createAmuOcrClient({idleMs:0});try{return await client.recognize(canvas.toDataURL('image/png'),{referenceDate:'2026-10-18T12:00:00Z'});}finally{await client.dispose();}
      });assert.equal(ocr.dateFrom,'2026-10-18');assert.equal(ocr.dateTo,'2026-10-21');
      assert.ok(responses.some(r=>r.url.includes('/vendor/tesseract-core-v7/')&&r.status===200));
      assert.ok(responses.some(r=>r.url.includes('/vendor/tesseract-data-deu-v1/')&&r.status===200));
      await page.goto(publicOrigin+'/',{waitUntil:'networkidle'});assert.ok(await page.locator('script[src="/app.js"]').count());
      assert.deepEqual(external,[]);assert.ok(violations.some(v=>v.directive==='base-uri'));
      assert.deepEqual(violations.filter(v=>v.directive!=='base-uri'),[]);
      console.log('CSP_LIVE_BROWSER_VERIFIED '+JSON.stringify({pdfPages:pdf.pages,ocrWorker:true,onlyExpectedBaseViolation:true,externalRequests:external.length}));
      await context.close();
    });
  } finally {
    await browser?.close();
    if(proxy)await new Promise(resolve=>{proxy.close(resolve);proxy.closeAllConnections();});
    if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    await subject?.closePersistenceForTests();subject?.releaseInstanceLockForTests();
    assert.equal(path.dirname(fs.realpathSync(temporaryRoot)),fs.realpathSync(os.tmpdir()));
    fs.rmSync(temporaryRoot,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});

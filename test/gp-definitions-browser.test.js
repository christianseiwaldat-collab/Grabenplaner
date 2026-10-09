'use strict';
// Real index markup, definition modules and extracted app navigation functions.
// Other workspaces are inert; no productive API, account or data mutation is used.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const repo=path.resolve(__dirname,'..'),publicRoot=path.join(repo,'public');
function appFunction(source,name){const start=source.indexOf('function '+name+'(');assert.ok(start>=0,name);const end=source.indexOf('\nfunction ',start+1);return source.slice(start,end<0?source.length:end);}

test('Developer definitions navigate, search, survive ordinary navigation and withdraw on access changes',{
  skip:process.env.GP_DEFINITIONS_BROWSER_TEST!=='1',timeout:60000,
},async t=>{
  const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');
  const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
  let server;const errors=[];
  try{
    const source=fs.readFileSync(path.join(publicRoot,'app.js'),'utf8');
    const script=['canUseGpDefinitions','renderGpDefinitionsAccess','activateGpDefinitions','renderSidebarSession','pageViewElement','applyActivePageAppearance','setView','applyRequestedView'].map(name=>appFunction(source,name)).join('\n');
    const listenerStart=source.indexOf("document.getElementById('gpDefinitionsNavButton')?.addEventListener('click'");
    assert.ok(listenerStart>=0);const listener=source.slice(listenerStart,source.indexOf('\ndocument.querySelectorAll(".nav-item")',listenerStart));
    const index=fs.readFileSync(path.join(publicRoot,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'');
    const styles=['styles.css','mobile-refinements.css','gp-definitions.css'].map(file=>fs.readFileSync(path.join(publicRoot,file),'utf8')).join('\n');
    const html=index.replace('</head>',`<style>${styles}</style></head>`);
    server=http.createServer((request,response)=>{
      const url=new URL(request.url,'http://127.0.0.1');
      if(url.pathname==='/'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);return;}
      const file=path.resolve(publicRoot,decodeURIComponent(url.pathname.slice(1)));
      if(file.startsWith(publicRoot+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){
        response.writeHead(200,{'Content-Type':{'.js':'application/javascript','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream'});response.end(fs.readFileSync(file));return;
      }
      response.writeHead(404);response.end();
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const page=await browser.newPage({viewport:{width:1560,height:1060}});page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:'+server.address().port+'/?view=startDashboard');
    for(const file of ['gp-definitions-registry.js','gp-definitions.js'])await page.addScriptTag({url:'/'+file});
    await page.evaluate(()=>{
      window.elements=Object.fromEntries([...document.querySelectorAll('[id]')].map(element=>[element.id,element]));
      window.state={portalSession:{authenticated:true,user:{role:'developer',roleName:'Developer',employeeNumber:'00991',fullName:'BEISPIEL Developer',isEmployee:true,active:true,mustChangePassword:false}},portalStatus:{portalEnabled:true,installationFeatures:{}},currentView:'startDashboard',personnelAdministrationTab:'dashboard',salesArticleCatalog:{priceLabels:null},employeeProfileHost:'team',globalTheme:'light'};
      window.gpDefinitionsWorkspace=null;window.timePresenceRefreshTimer=null;
      for(const name of ['receiptSearchWorkspace','tradeInsightsWorkspace','salesArticleReportWorkspace','salesPriceLabelsWorkspace','salesBwlWorkspace'])window[name]=null;
      for(const name of ['renderContextNavigation','activatePrivacyOrganizationView','syncSalesArticleSearchWindow','syncGpWindows','syncStartDashboardVps','loadStartDashboard','loadPlanningView','closeMobileNavigation'])window[name]=()=>{};
      window.canReadSalesBwl=()=>false;window.employeeProfileIsOpen=()=>false;window.restoreRememberedOverallContext=()=>false;window.planningContextNeedsReload=()=>false;
      // Mark the evidence as an isolated visual preview without live VPS state.
      const badge=document.createElement('p');badge.textContent='Lokale UI-Prüfung · BEISPIEL-Konto · ohne Produktivdaten';badge.style.cssText='margin:18px 0 0;color:var(--muted);font-size:9px';document.getElementById('gpDefinitionsView').append(badge);
    });
    await page.addScriptTag({content:script+'\n'+listener+'\nrenderSidebarSession();'});
    const view=page.locator('#gpDefinitionsView'),workspace=page.locator('#gpDefinitionsWorkspace'),button=page.locator('#gpDefinitionsNavButton');
    const screenshot=async name=>{const output=process.env.GP_DEFINITIONS_SCREENSHOT_DIR;if(output){fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,name),fullPage:true,animations:'disabled'});}};
    await t.test('actual Developer button opens the view with five topics and six window rules',async()=>{
      assert.equal(await button.isVisible(),true);assert.equal(await page.locator('#sidebarSessionRole').isVisible(),false);
      await button.click();assert.equal(await view.isVisible(),true);assert.equal(await workspace.isVisible(),true);
      assert.equal(await button.getAttribute('aria-current'),'page');assert.equal(await page.locator('[data-gp-definition-topic]').count(),6);
      assert.equal(await page.locator('.gp-definition-rule').count(),6);assert.equal(await page.locator('.gp-definition-card h2').textContent(),'Fenster');
      await screenshot('01-gp-definitions-light.png');
    });
    await t.test('search finds PDF byte identity and empty states contain no injected markup',async()=>{
      await page.locator('#gpDefinitionsSearch').fill('PDF Bytes');assert.equal(await page.locator('.gp-definition-card h2').textContent(),'Druck & PDF');
      await page.locator('#gpDefinitionsSearch').fill('<img src=x onerror=alert(1)>');assert.equal(await page.locator('.gp-definition-card').count(),0);assert.equal(await workspace.locator('img').count(),0);assert.equal(await page.locator('.gp-definitions-empty').isVisible(),true);
      await page.locator('.gp-definitions-clear').click();assert.equal(await page.locator('#gpDefinitionsSearch').inputValue(),'');
      await page.locator('[data-gp-definition-topic=print]').click();await screenshot('02-gp-definitions-print-standard.png');
    });
    await t.test('ordinary navigation keeps the selected topic while a Developer account switch resets it',async()=>{
      await page.evaluate(()=>setView('startDashboard'));assert.equal(await workspace.isVisible(),false);
      await button.click();assert.equal(await page.locator('.gp-definition-card h2').textContent(),'Druck & PDF');
      await page.evaluate(()=>{state.portalSession.user.employeeNumber='00992';renderSidebarSession();});assert.equal(await page.locator('.gp-definition-card h2').textContent(),'Fenster');
    });
    await t.test('topics and implementation references work with the keyboard',async()=>{
      await page.locator('[data-gp-definition-topic=tables]').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.gp-definition-card h2').textContent(),'Tabellen');
      await page.locator('.gp-definition-card summary').focus();await page.keyboard.press('Space');assert.equal(await page.locator('.gp-definition-card details').getAttribute('open'),'');
      assert.equal(await page.locator('.gp-definition-card code').count(),3);
      await page.locator('[data-gp-definition-topic=windows]').click();
    });
    await t.test('dark and narrow layouts keep controls and text inside the visible viewport',async()=>{
      await page.evaluate(()=>{state.globalTheme='dark';applyActivePageAppearance();});await screenshot('03-gp-definitions-dark.png');
      await page.evaluate(()=>{state.globalTheme='light';applyActivePageAppearance();});await page.setViewportSize({width:430,height:940});
      await page.locator('#mainSidebar').waitFor({state:'hidden'});
      await screenshot('04-gp-definitions-narrow.png');
      const overflow=await page.evaluate(()=>[...document.querySelectorAll('#gpDefinitionsView button,#gpDefinitionsView input,#gpDefinitionsView h2,#gpDefinitionsView .gp-definition-rule')].filter(element=>{const box=element.getBoundingClientRect();return box.width&&(box.left<-1||box.right>innerWidth+1);}).map(element=>element.id||element.textContent));
      assert.deepEqual(overflow,[]);await page.setViewportSize({width:1560,height:1060});
    });
    await t.test('Developer direct URL is allowed; other roles are rejected by the real setView guard',async()=>{
      await page.evaluate(()=>{history.replaceState(null,'','/?view=gpDefinitions');applyRequestedView({loadContext:false});});assert.equal(await view.isVisible(),true);
      for(const role of ['admin','it_admin','manager','employee']){
        await page.evaluate(value=>{state.portalSession.user.role=value;renderSidebarSession();history.replaceState(null,'','/?view=gpDefinitions');applyRequestedView({loadContext:false});},role);
        assert.equal(await page.evaluate(()=>state.currentView),'startDashboard');assert.equal(await view.isVisible(),false);assert.equal(await button.isVisible(),false);assert.equal(await workspace.locator('.gp-definition-card').count(),0);
      }
    });
    await t.test('role loss while open clears the view, search and Developer entry immediately',async()=>{
      await page.evaluate(()=>{state.portalSession.user.role='developer';renderSidebarSession();setView('gpDefinitions');});
      await page.locator('#gpDefinitionsSearch').fill('Maus');
      await page.evaluate(()=>{state.portalSession.user.role='manager';renderSidebarSession();});
      assert.equal(await page.evaluate(()=>state.currentView),'startDashboard');assert.equal(await button.isVisible(),false);assert.equal(await view.isVisible(),false);assert.equal(await workspace.locator('.gp-definition-card').count(),0);assert.equal(await page.locator('#gpDefinitionsSearch').inputValue(),'');
    });
    await t.test('password obligation, inactive users, branch sessions and logout cannot retain or directly open definitions',async()=>{
      for(const change of [{mustChangePassword:true},{active:false},{isEmployee:false}]){
        await page.evaluate(value=>{Object.assign(state.portalSession.user,{role:'developer',mustChangePassword:false,active:true,isEmployee:true});renderSidebarSession();setView('gpDefinitions');Object.assign(state.portalSession.user,value);renderSidebarSession();setView('gpDefinitions');},change);
        assert.equal(await page.evaluate(()=>state.currentView),'startDashboard');assert.equal(await button.isVisible(),false);assert.equal(await workspace.isVisible(),false);
      }
      await page.evaluate(()=>{state.portalSession={authenticated:false,user:null};renderSidebarSession();setView('gpDefinitions');});assert.equal(await page.evaluate(()=>state.currentView),'startDashboard');assert.equal(await workspace.locator('.gp-definition-card').count(),0);
    });
    assert.deepEqual(errors,[]);
  }finally{await browser.close();if(server)await new Promise(resolve=>server.close(resolve));}
});

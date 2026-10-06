'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
function section(start,end){const from=html.indexOf(start),to=html.indexOf(end,from);assert.ok(from>=0&&to>from);return html.slice(from,to);}
const sidebar=section('<aside class="sidebar"','</aside>')+'</aside>';
const article=section('<section id="salesArticleCatalogView"','<section id="crmView"');

test('article search and recent docks belong to the article workspace; price search and notepad remain in the sidebar',()=>{
  for(const id of ['sidebarArticleSearchButton','sidebarRecentArticlesButton']){
    assert.ok(article.includes(`id="${id}"`));assert.ok(!sidebar.includes(`id="${id}"`));
    assert.equal(html.split(`id="${id}"`).length-1,1);
  }
  assert.match(article,/class="article-window-dock"[^>]*id="salesArticleWindowDock"[^>]*role="group"[^>]*aria-label="Artikelstamm-Fenster"/);
  assert.ok(sidebar.includes('id="sidebarPriceLabelSearchButton"'));assert.ok(!article.includes('id="sidebarPriceLabelSearchButton"'));
  assert.ok(sidebar.includes('id="sidebarNotepad"'));
});

async function setup(page){
  page.setDefaultTimeout(8000);await page.route('**/*',route=>route.abort());
  await page.setContent('<div class="app-shell">'+sidebar+'<main class="main-content">'+article+'<section id="otherView" class="view">Andere Seite</section></main></div>');
  for(const file of ['styles.css','mobile-refinements.css','sidebar-notepad.css','gp-window.css','sales-recent-articles.css','sales-article-search-window.css'])await page.addStyleTag({path:path.join(root,'public',file)});
  for(const file of ['gp-window-preferences.js','gp-window.js','sidebar-layout.js','table-layout.js','sales-recent-articles.js','sales-article-search-window.js'])await page.addScriptTag({path:path.join(root,'public',file)});
  await page.addStyleTag({content:'.sidebar{transition:none !important}'});
  await page.evaluate(()=>{
    document.querySelector('#salesArticleCatalogView').classList.add('active');
    for(const id of ['sidebarArticleSearchButton','sidebarRecentArticlesButton','sidebarPriceLabelSearchButton'])document.getElementById(id).hidden=false;
    const pad=document.getElementById('sidebarNotepad');pad.hidden=false;pad.innerHTML='<div class="sidebar-notepad-toolbar"><button id="syntheticNotepadButton" aria-label="Notizen">▤</button></div>';
    const media=matchMedia('(max-width:820px), (max-width:1100px) and (pointer:coarse)');
    window.sidebarLayout=GrabenplanerSidebarLayout.mount({window,document,sidebar:document.getElementById('mainSidebar'),handle:document.getElementById('sidebarResizeHandle'),mobileMedia:media});
    window.appScale=()=>parseFloat(getComputedStyle(document.body).zoom)||1;
    window.appBounds=()=>GpWindow.viewportBounds(visualViewport||{width:innerWidth,height:innerHeight},appScale());
    window.search=SalesArticleSearchWindow.attach(document.getElementById('salesArticleSearchWindow'),{
      bounds:appBounds,scale:appScale,canUse:()=>true,change:()=>{},closeTarget:()=>document.getElementById('sidebarArticleSearchButton'),
      onFreshSearch:()=>document.getElementById('salesArticleSearchQuery').value=''});
    document.getElementById('sidebarArticleSearchButton').onclick=()=>search.reopenFresh();
    window.recent=SalesRecentArticles.mount({dock:document.getElementById('sidebarRecentArticlesButton'),key:()=> 'synthetic',canUse:()=>true,
      active:()=>document.getElementById('salesArticleCatalogView').classList.contains('active'),bounds:appBounds,scale:appScale,
      columns:()=>[{id:'articleNumber',label:'Artikelnummer'}],openArticle:()=>{},api:async()=>({articles:[],preferences:{columns:['articleNumber'],sort:'recent'}})});
    recent.sync();
    window.closeAnimations=[];const animate=Element.prototype.animate;
    Element.prototype.animate=function(frames,options){if(this.id==='salesArticleSearchWindow'||this.classList.contains('sales-recent-articles')){
      const target=document.getElementById(this.id==='salesArticleSearchWindow'?'sidebarArticleSearchButton':'sidebarRecentArticlesButton');
      const from=this.getBoundingClientRect(),to=target.getBoundingClientRect();closeAnimations.push({frames,scale:appScale(),from:{left:from.left,top:from.top,width:from.width,height:from.height},to:{left:to.left,top:to.top,width:to.width,height:to.height}});
    }return animate.call(this,frames,options);};
  });
}

async function placement(page,{desktop=false}={}){
  const data=await page.evaluate(()=>{
    const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    return {dock:rect('salesArticleWindowDock'),search:rect('sidebarArticleSearchButton'),recent:rect('sidebarRecentArticlesButton'),sidebar:rect('mainSidebar'),
      price:rect('sidebarPriceLabelSearchButton'),scale:appScale(),viewport:{width:innerWidth,height:innerHeight}};
  });
  assert.ok(data.dock.left>=0&&data.dock.right<=data.viewport.width+1,'both article docks stay inside the visible viewport');
  assert.ok(data.dock.bottom<=data.viewport.height+1&&data.dock.top>=0);
  assert.ok(data.recent.left>data.search.right,'recent articles sit directly to the right of article search');
  if(desktop)assert.ok(Math.abs(data.dock.left-data.sidebar.right-14*data.scale)<2,'desktop dock sits beside the current sidebar width');
  if(desktop)assert.ok(Math.abs(data.price.left-58*data.scale)<2,'price-label search remains in its existing sidebar scope');
  return data;
}

test('article workspace docks follow sidebar resizing and zoom, and real close animations end at the correct icons',
 {skip:process.env.GP_WINDOW_BROWSER_TEST!=='1',timeout:60000},async()=>{
  const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');
  const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
  const errors=[];
  try{
    const page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',error=>errors.push(error.message));await setup(page);
    await placement(page,{desktop:true});
    await page.locator('#sidebarResizeHandle').focus();await page.keyboard.press('End');await placement(page,{desktop:true});
    assert.equal(await page.locator('#sidebarResizeHandle').getAttribute('aria-valuenow'),'380');
    await page.keyboard.press('Home');await placement(page,{desktop:true});
    assert.equal(await page.locator('#sidebarResizeHandle').getAttribute('aria-valuenow'),'200');
    for(const scale of [1.25,.8,1]){
      await page.evaluate(scale=>{document.documentElement.style.setProperty('--app-font-scale',String(scale));document.documentElement.style.setProperty('--app-font-scale-inverse',String(1/scale));sidebarLayout.refresh();},scale);
      await placement(page,{desktop:true});
    }
    await page.evaluate(()=>{search.set({version:2,x:700,y:110,width:560,height:500,minimized:false});search.activate();});
    await page.locator('#salesArticleSearchQuery').fill('Synthetic search');await page.locator('[data-article-window-close]').click();await page.waitForFunction(()=>search.docked);
    await page.locator('#sidebarArticleSearchButton').click();assert.equal(await page.locator('#salesArticleSearchQuery').inputValue(),'');await page.evaluate(()=>search.suspend());
    await page.locator('#sidebarRecentArticlesButton').click();await page.waitForFunction(()=>!document.querySelector('.sales-recent-articles').hidden);
    await page.locator('[data-recent-close]').click();await page.waitForFunction(()=>document.querySelector('.sales-recent-articles').hidden);
    const animations=await page.evaluate(()=>closeAnimations);assert.equal(animations.length,2);
    for(const entry of animations){const [,x,y]=entry.frames[1].transform.match(/^translate\(([-\d.]+)px,([-\d.]+)px\)/);
      assert.ok(Math.abs(Number(x)*entry.scale-(entry.to.left-entry.from.left))<1);assert.ok(Math.abs(Number(y)*entry.scale-(entry.to.top-entry.from.top))<1);
    }
    await page.evaluate(()=>{document.getElementById('salesArticleCatalogView').classList.remove('active');document.getElementById('otherView').classList.add('active');recent.sync();});
    assert.equal(await page.locator('#salesArticleWindowDock').isVisible(),false);assert.equal(await page.locator('#syntheticNotepadButton').isVisible(),true);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('mobile article docks begin at the workspace padding and remain reachable beside visible navigation',
 {skip:process.env.GP_WINDOW_BROWSER_TEST!=='1',timeout:60000},async()=>{
  const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');
  const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
  const errors=[];
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await setup(page);
    for(const width of [390,320,1080]){
      await page.setViewportSize({width,height:844});
      for(const scale of [1,1.25]){
        await page.evaluate(scale=>{document.body.classList.remove('mobile-navigation-open');document.documentElement.style.setProperty('--app-font-scale',String(scale));document.documentElement.style.setProperty('--app-font-scale-inverse',String(1/scale));sidebarLayout.refresh();},scale);
        const closed=await placement(page);assert.ok(Math.abs(closed.dock.left-14*scale)<2,'hidden mobile sidebar leaves the dock at workspace padding');
        await page.evaluate(()=>document.body.classList.add('mobile-navigation-open'));await placement(page);
        assert.equal(await page.locator('#mainSidebar').evaluate(node=>getComputedStyle(node).visibility),'visible');
      }
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

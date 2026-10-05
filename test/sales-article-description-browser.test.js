'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {sanitizeArticleDescription}=require('../lib/sales-article-description');
const {projectSalesArticleSourceField}=require('../lib/sales-article-detail-source');
const {vectors,limitVectors,grammarVectors}=require('../test-support/sales-article-description-security-cases');
// Optional browser qualification uses the caller's installed Chromium/Playwright;
// no browser installation, database, application server or remote content is used.
test('Chromium reparses every description safely and field toggles retain live price and note tools',
  {skip:process.env.GP_DESCRIPTION_BROWSER_TEST!=='1',timeout:120000},async t=>{
  const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
  const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),
    args:['--no-first-run','--disable-default-apps','--disable-background-networking']});
  t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'}),page=await context.newPage();
  const requests=[],errors=[];
  await context.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<!doctype html><html lang="de"><body><main id="probe"></main></body></html>');
  await page.evaluate(()=>{globalThis.executed=0;globalThis.bad=globalThis.alert=()=>{globalThis.executed++;};});
  const all=[...vectors,...limitVectors,...grammarVectors()],results=all.map(value=>({name:value.name,html:sanitizeArticleDescription(value.raw).html}));
  for(let offset=0;offset<results.length;offset+=100){
    const failures=await page.evaluate(rows=>{
      const allowed=new Set('p div br ul ol li strong b em i u s h3 h4 blockquote pre code table thead tbody tfoot tr th td a'.split(' '));
      const host=document.getElementById('probe'),failures=[];
      for(const row of rows){
        const node=document.createElement('div');node.innerHTML=row.html;host.replaceChildren(node);
        for(let pass=0;pass<2;pass++){
          for(const element of node.querySelectorAll('*')){
            const name=element.localName;
            if(!allowed.has(name)||element.namespaceURI!=='http://www.w3.org/1999/xhtml'){failures.push(row.name+':unexpected-element');break;}
            for(const attr of element.attributes){
              if(name!=='a'||!['href','target','rel','referrerpolicy'].includes(attr.name)){failures.push(row.name+':unexpected-attribute');break;}
            }
            if(name==='a'){
              const url=new URL(element.getAttribute('href'));
              if(!['http:','https:'].includes(url.protocol)||url.username||url.password||element.target!=='_blank'
                ||element.rel!=='noopener noreferrer'||element.referrerPolicy!=='no-referrer')failures.push(row.name+':unsafe-link');
            }
          }
          const walker=document.createTreeWalker(node,NodeFilter.SHOW_COMMENT);
          if(walker.nextNode())failures.push(row.name+':unexpected-comment');
          node.innerHTML=node.innerHTML;
        }
      }
      host.replaceChildren();return failures;
    },results.slice(offset,offset+100));
    assert.deepEqual(failures,[]);
  }
  assert.equal(await page.evaluate(()=>globalThis.executed),0);
  t.diagnostic(`${browser.version()}: ${results.length} synthetic inputs, two HTML5 parses each`);
  for(const file of ['sales-article-detail-preferences.js','sales-article-layout.js','branch-article-calculation.js','sales-article-price-controls.js','sales-article-tools.js'])
    await page.addScriptTag({path:path.join(__dirname,'../public',file)});
  const descriptions=[projectSalesArticleSourceField('AKurzbeschreibung','Beschreibung','<p>Mit <strong>Format</strong></p>'),
    projectSalesArticleSourceField('ALieferumfang','Lieferumfang','Gerät &amp; Kabel\nHandbuch'),
    projectSalesArticleSourceField('ShopText','Shoptext','<p>Zweites <em>Feld</em></p>'),
    projectSalesArticleSourceField('Meldungstext','Hinweis','<script>bad()</script>')];
  await page.evaluate(descriptions=>{
    const root=document.getElementById('probe');root.dataset.selectedArticle='SYNTHETIC-001';
    const article={articleNumber:'SYNTHETIC-001',description:'Synthetic product',active:true,currentRevision:1,identifiers:[],prices:{sales:null},
      provenance:{updatedAt:'2026-10-05T00:00:00.000Z'},sourceSections:[{id:'description',fields:descriptions}],notes:{items:[]}};
    const matrix={costsRead:true,vatPercent:20,purchase:[{id:'average_purchase',current:{amount:'100',currency:'EUR'}}],
      sales:[{id:'upe',label:'UVP',gross:{amount:'200'}},{id:'internet_5',label:'Versuch',gross:{amount:'150'},net:{amount:'125'}}]};
    const h={money:amount=>String(amount)+' €',timestamp:value=>value,date:value=>value || '–'};
    root.innerHTML=SalesArticleLayout.overview(article,h)+SalesArticleLayout.prices(matrix,h)+'<section id="salesArticleNotesSection"></section>';
    SalesArticlePriceControls.mount(root,matrix,h,{preferenceKey:'synthetic',storage:{getItem:()=>JSON.stringify(['upe','internet_5']),setItem(){}}});
    globalThis.toolCalls=0;
    globalThis.tools=SalesArticleTools.mount(root,{article,write:true,accessKey:()=> 'synthetic',api:async()=>{globalThis.toolCalls++;throw Error('Unexpected API call');}});
    globalThis.retained={root,article,tools,price:root.querySelector('[data-price-trial-input="gross"]'),note:root.querySelector('.article-note-add textarea')};
    SalesArticleLayout.mountDescriptions(root);SalesArticleLayout.mountDescriptions(root);
  },descriptions);
  const fields=page.locator('[data-description-field]'),first=fields.nth(0),other=fields.nth(2);
  assert.equal(await fields.count(),4);assert.equal(await fields.nth(1).locator('button').count(),0);
  assert.equal(await fields.nth(3).innerText(),'Kein darstellbarer Inhalt');
  await page.locator('[data-price-trial-input="gross"]').fill('180,00');
  await page.locator('.article-note-add textarea').fill('Ungespeicherte synthetische Notiz');
  await first.locator('[data-description-mode="text"]').focus();await page.keyboard.press('Space');
  assert.equal(await first.locator('[data-description-view="html"]').isVisible(),false);
  assert.equal(await first.locator('[data-description-view="text"]').innerText(),'Mit Format');
  assert.equal(await other.locator('[data-description-view="html"]').isVisible(),true);
  await first.locator('[data-description-mode="html"]').click();
  const retained=await page.evaluate(()=>({selected:retained.root.dataset.selectedArticle,root:retained.root===document.getElementById('probe'),
    tools:retained.tools===tools,price:retained.price===document.querySelector('[data-price-trial-input="gross"]'),
    note:retained.note===document.querySelector('.article-note-add textarea'),priceValue:retained.price.value,noteValue:retained.note.value,calls:toolCalls}));
  assert.deepEqual(retained,{selected:'SYNTHETIC-001',root:true,tools:true,price:true,note:true,priceValue:'180,00',noteValue:'Ungespeicherte synthetische Notiz',calls:0});
  assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const Pdf = require('../lib/sales-price-labels-pdf'), Fonts = require('../public/sales-price-label-fonts');
const root = path.join(__dirname,'..');
const near = (actual, expected, label) => assert.ok(Math.abs(actual-expected) < .2, `${label}: ${actual} != ${expected}`);

test('Direct price-label editor preserves typography, geometry and lifecycle in Chromium', {
  skip:process.env.GP_SALES_PRICE_LABEL_EDITOR_BROWSER_TEST !== '1',timeout:60000,
}, async t => {
  const {chromium} = require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
  const browser = await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE ? {executablePath:process.env.GP_BROWSER_EXECUTABLE} : {}),args:['--no-first-run']});
  const failures = [];let imageRequests=0;
  try {
    const page = await browser.newPage({viewport:{width:1400,height:1000}}); page.on('pageerror',error => failures.push(error.message));
    await page.route('http://design.test/**',async route => {
      const name = new URL(route.request().url()).pathname;
      if(name.startsWith('/api/sales/price-labels/images/')) {
        imageRequests++;
        return route.fulfill({contentType:'image/png',headers:{'Cache-Control':'private, no-store'},body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lF8AAAAASUVORK5CYII=','base64')});
      }
      if (/^\/fonts\/price-labels\/[a-z-]+\/(?:Regular|Bold)\.ttf$/.test(name)) return route.fulfill({contentType:'font/ttf',body:fs.readFileSync(path.join(root,'public',name))});
      if (name === '/') return route.fulfill({contentType:'text/html',body:'<div class="sales-price-labels"><div id="preview" style="width:600px"></div><div id="toolbar"></div><div id="images"></div><div id="live" aria-live="polite"></div></div>'});
      return route.fulfill({status:404,body:''});
    });
    await page.goto('http://design.test/');
    const css = ['sales-price-labels.css','sales-price-label-editor.css'].map(name => fs.readFileSync(path.join(root,'public',name),'utf8')).join('\n');
    await page.addStyleTag({content:css+'\n'+Fonts.css()});
    for (const name of ['sales-price-label-fonts.js','sales-price-label-design.js','sales-price-label-editor.js']) await page.addScriptTag({path:path.join(root,'public',name)});
    const mount = async ({options={},article={},photo='',logo=null} = {}) => {
      await page.evaluate(({value,article,photo,logo}) => {
        window.editor?.destroy(); window.actor = 'A'; window.allowed = true; window.writes = [];
        window.current = {value,article:{articleNumber:'123',description:'Kamera',brand:'Marke',ean:'456',taxRate:'20.000',...article},photo,logo,price:'129,00',editable:true};
        window.editor = GrabenplanerPriceLabelEditor.mount({preview:document.querySelector('#preview'),toolbar:document.querySelector('#toolbar'),images:document.querySelector('#images'),live:document.querySelector('#live'),
          read:() => current.value,write:value => {writes.push({actor,value:structuredClone(value)});current={...current,value};editor.render(current);},upload:async()=>{throw Error('No upload in this synthetic test');},canEdit:() => allowed,context:() => actor});
        editor.render(current);
      },{value:Pdf.normalizeOptions(options),article,photo,logo});
      await page.evaluate(async () => {await document.fonts.load('700 14px "GP Label Roboto"');await document.fonts.load('400 8px "GP Label Roboto"');await document.fonts.ready;editor.render(current);});
    };
    await t.test('first move retains the automatically fitted point size and keyboard focus',async () => {
      await mount({article:{description:('Kamera mit umfangreicher Ausstattung und langer Artikelbeschreibung ').repeat(3)}});
      const text = page.locator('[data-pl-element="description"]');
      const before = await text.evaluate(node => ({size:parseFloat(node.querySelector('.spl-element-text').style.fontSize)*90/(.352777778*100),lines:node.querySelectorAll('.spl-element-text span').length}));
      assert.ok(before.size < 14); await text.press('ArrowRight');
      const saved = await page.evaluate(() => current.value.textBoxes.description);
      near(saved.fontSizePt,before.size,'retained font points'); assert.equal(saved.xMm,4.5);
      assert.equal(await text.locator('.spl-element-text span').count(),before.lines);
      assert.equal(await text.evaluate(node => document.activeElement === node),true);
      await text.locator('[data-pl-element-resize]').press('ArrowRight');
      near(await page.evaluate(() => current.value.textBoxes.description.fontSizePt),before.size,'resized font points');
      assert.equal(await text.locator('[data-pl-element-resize]').evaluate(node => document.activeElement === node),true);
    });
    await t.test('saved millimeters use the full label frame and photo fit is independent of preview size',async () => {
      const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lF8AAAAASUVORK5CYII=';
      const box = {fontId:'roboto',fontSizePt:8,xMm:5,yMm:5,widthMm:20,heightMm:10};
      for (const design of ['classic','minimal','promo']) {
        await mount({options:{design,textBoxes:{brand:box},showPhoto:true},photo});
        const result = await page.evaluate(() => {
        const label = document.querySelector('.spl-label').getBoundingClientRect(), text = document.querySelector('[data-pl-element="brand"]').getBoundingClientRect(), image = document.querySelector('.spl-direct-photo').getBoundingClientRect();
        const fitted = GrabenplanerPriceLabelDesign.getContentGeometry(current.value,{hasPhoto:true}).photoBox;
        return {label:{x:label.x,y:label.y,width:label.width,height:label.height},text:{x:text.x,y:text.y,width:text.width,height:text.height},image:{x:image.x,y:image.y,width:image.width,height:image.height},fitted,
          vertical:getComputedStyle(document.querySelector('.spl-element-text')).justifyContent,tax:document.querySelector('[data-pl-element="tax"] .spl-element-text').textContent};
        });
        near(result.text.x-result.label.x,result.label.width*box.xMm/90,design+' text X'); near(result.text.y-result.label.y,result.label.height*box.yMm/60,design+' text Y');
        near(result.text.width,result.label.width*box.widthMm/90,design+' text width'); near(result.text.height,result.label.height*box.heightMm/60,design+' text height');
        near(result.image.height,result.label.height*result.fitted.heightMm/60,design+' photo height'); near(result.image.width,result.label.width*result.fitted.widthMm/90,design+' photo width');
        assert.equal(result.vertical,'flex-start'); assert.equal(result.tax,'inkl. 20 % MwSt.');
      }
    });
    await t.test('font completion retains the selected element and permits another keyboard move',async () => {
      await mount(); const text = page.locator('[data-pl-element="description"]'); await text.focus();
      await page.evaluate(() => document.fonts.dispatchEvent(new Event('loadingdone')));
      assert.equal(await text.evaluate(node => document.activeElement === node),true);
      await text.press('ArrowDown'); assert.equal(await page.evaluate(() => current.value.textBoxes.description.yMm),12.56);
    });
    await t.test('photo and independent text layers retain the PDF drawing order when a field overlaps the photo',async () => {
      const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lF8AAAAASUVORK5CYII=';
      await mount({options:{showPhoto:true,textBoxes:{description:{fontId:'roboto',fontSizePt:8,xMm:71.7,yMm:12.06,widthMm:14.3,heightMm:13}}},photo});
      const actual = await page.evaluate(() => [...document.querySelector('.spl-label').children].map(node => node.dataset.plElement || (node.classList.contains('spl-direct-photo') ? 'photo' : '')).filter(Boolean));
      assert.deepEqual(actual,['brand','photo','description','price','tax','articleNumber','ean']);
      const top = await page.evaluate(() => {const rect = document.querySelector('[data-pl-element="description"]').getBoundingClientRect();return document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.closest('[data-pl-element]')?.dataset.plElement;});
      assert.equal(top,'description');
    });
    await t.test('dragging reuses loaded private images while an account change forces a fresh authenticated read',async () => {
      await mount({options:{imageBoxes:[{assetId:'11111111-1111-4111-8111-111111111111',xMm:3,yMm:3,widthMm:20,heightMm:10}]}});
      await page.waitForFunction(()=>document.querySelector('.spl-design-image img')?.complete);
      await page.evaluate(()=>{window.loadedImage=document.querySelector('.spl-design-image img');});
      const before=imageRequests,text=page.locator('[data-pl-element="description"]'),rect=await text.boundingBox();
      await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();
      await page.mouse.move(rect.x+rect.width/2+30,rect.y+rect.height/2+15,{steps:20});await page.mouse.up();
      await page.waitForTimeout(100);
      assert.equal(imageRequests,before);
      assert.equal(await page.evaluate(()=>document.querySelector('.spl-design-image img')===loadedImage),true);
      await page.evaluate(()=>{actor='B';editor.render(current);});
      await page.waitForFunction(()=>document.querySelector('.spl-design-image img')?.complete);
      assert.equal(imageRequests,before+1);
      assert.equal(await page.evaluate(()=>document.querySelector('.spl-design-image img')===loadedImage),false);
    });
    await t.test('a gesture cannot write across a changed account or revoked right',async () => {
      await mount(); const text = page.locator('[data-pl-element="description"]'), rect = await text.boundingBox();
      await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2); await page.mouse.down();
      await page.evaluate(() => {actor='B';current={...current,value:{...current.value,textBoxes:{}}};editor.render(current);});
      await page.mouse.move(rect.x+rect.width/2+30,rect.y+rect.height/2); await page.mouse.up();
      assert.equal(await page.evaluate(() => writes.length),0);
      await text.focus(); await page.evaluate(() => {allowed=false;}); await text.press('ArrowRight');
      assert.equal(await page.evaluate(() => writes.length),0);
    });
    assert.deepEqual(failures,[]);
  } finally {await browser.close();}
});

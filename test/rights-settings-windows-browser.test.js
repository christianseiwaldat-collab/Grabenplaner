'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const repo=path.join(__dirname,'..'), enabled=process.env.GP_WINDOW_BROWSER_TEST==='1';
const html=fs.readFileSync(path.join(repo,'public/index.html'),'utf8');
const areas=[
  {root:'permissionDefaultsWindow',opener:'openPermissionDefaultsWindowButton',id:'rights:defaults'},
  {root:'personnelFieldRightsWindow',opener:'openPersonnelFieldRightsWindowButton',id:'rights:personnel-fields'},
  {root:'mobileLeadershipWindow',opener:'openMobileLeadershipWindowButton',id:'rights:mobile-leadership'},
];
function elementHtml(id){const marker=html.indexOf(`id="${id}"`);assert.ok(marker>=0,`Actual ${id} markup exists`);
  const start=html.lastIndexOf('<',marker),tag=/^<([\w-]+)/.exec(html.slice(start))[1],tokens=new RegExp(`<\\/?${tag}\\b[^>]*>`,'g');tokens.lastIndex=start;let depth=0;
  for(let match;(match=tokens.exec(html));){depth+=match[0].startsWith('</')?-1:1;if(!depth)return html.slice(start,tokens.lastIndex);}assert.fail(`Balanced ${id} markup`);}
async function browser(){const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');return chromium.launch({headless:true,
  ...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});}
async function setup(page,{storage={},role='developer',deferredPreferences=false}={}){
  page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort());
  await page.setContent('<div class="app-shell"><aside class="sidebar" id="mainSidebar">GP · BEISPIEL</aside><main class="main-content"><section id="settingsView" class="view active"><section id="rightsSettings" class="settings-section active">'
    +areas.map(area=>elementHtml(area.opener)).join('')+'</section><button id="backgroundButton">Hintergrund bedienen</button></section></main></div>'+areas.map(area=>elementHtml(area.root)).join(''));
  for(const file of ['styles.css','mobile-refinements.css','table-layout.css','gp-window.css','rights-management-workspace.css'])await page.addStyleTag({path:path.join(repo,'public',file)});
  for(const file of ['gp-window-preferences.js','gp-window.js','rights-settings-windows.js'])await page.addScriptTag({path:path.join(repo,'public',file)});
  await page.evaluate(({areas,storage,role,deferredPreferences})=>{
    window.fixtureActor='BEISPIEL:A';window.fixtureRole=role;window.fixtureActive=true;window.fixtureAllowed=true;window.fixtureStorage=storage;window.backgroundClicks=0;
    window.geometryWrites=[];window.closeAnimations=[];
    const scale=()=>parseFloat(getComputedStyle(document.body).zoom)||1;
    window.fixturePreferences=GpWindow.createPreferences({actorKey:()=>fixtureActor,canUse:()=>fixtureAllowed,
      read:async()=>deferredPreferences?await new Promise(resolve=>{window.fixtureResolvePreferences=()=>resolve(fixtureStorage[fixtureActor]||{version:1,windows:{}});}):fixtureStorage[fixtureActor]||{version:1,windows:{}},write:async value=>{fixtureStorage[fixtureActor]=value;geometryWrites.push(structuredClone(value));}});
    window.fixtureWindows=RightsSettingsWindows.mount({windows:areas.map(area=>({root:document.getElementById(area.root),opener:document.getElementById(area.opener),id:area.id,
      canUse:()=>fixtureAllowed&&(area.root!=='permissionDefaultsWindow'||fixtureRole==='developer')})),key:()=>fixtureActor,active:()=>fixtureActive,
      windowPreferences:fixturePreferences,bounds:()=>GpWindow.viewportBounds(visualViewport||{width:innerWidth,height:innerHeight},scale()),scale});
    const originalAnimate=Element.prototype.animate;
    Element.prototype.animate=function(frames,options){if(areas.some(area=>area.root===this.id))closeAnimations.push({id:this.id,frames,options});return originalAnimate.call(this,frames,options);};
    document.getElementById('backgroundButton').onclick=()=>backgroundClicks++;
  },{areas,storage,role,deferredPreferences});
  return errors;
}
const toggle=root=>root.locator('[data-rights-settings-window-toggle]');
const close=root=>root.locator('[data-rights-settings-window-close]');

test('explicit minimized entry overrides prior expanded state without losing saved size or pending intent',
  {skip:!enabled,timeout:60000},async()=>{
    const instance=await browser();try {
      const storage={'BEISPIEL:A':{version:1,windows:Object.fromEntries(areas.map(area=>[area.id,{x:50,y:140,width:760,height:580,minimized:false}]))}};
      for (const deferredPreferences of [false,true]) {
        const page=await instance.newPage({viewport:{width:1400,height:900}}),errors=await setup(page,{storage,deferredPreferences});
        const showing=page.evaluate(()=>Promise.all(['rights:defaults','rights:personnel-fields','rights:mobile-leadership'].map(id=>fixtureWindows.show(id,{minimized:true}))));
        if (deferredPreferences) {
          await page.waitForFunction(()=>typeof fixtureResolvePreferences==='function');
          await page.evaluate(()=>{fixtureActive=false;fixtureWindows.sync();fixtureResolvePreferences();});
        }
        await showing;
        if (deferredPreferences) await page.evaluate(()=>{fixtureActive=true;fixtureWindows.sync();});
        for (const area of areas) {
          const root=page.locator('#'+area.root);await root.waitFor();
          assert.equal(await root.evaluate(node=>node.classList.contains('is-minimized')),true);
          await toggle(root).evaluate(button=>button.click());const restored=await root.boundingBox();
          assert.equal(Math.round(restored.width),760);assert.equal(Math.round(restored.height),580);
          await close(root).evaluate(button=>button.click());await page.waitForFunction(id=>document.getElementById(id).hidden,area.root);
        }
        assert.deepEqual(errors,[]);await page.close();
      }
    }finally{await instance.close();}
  });

test('first open resumes after deferred geometry resolves during navigation',
  {skip:!enabled,timeout:60000},async t=>{
    const instance=await browser();try{
      for(const area of areas)await t.test(area.root,async()=>{
        const page=await instance.newPage({viewport:{width:1400,height:900}}),errors=await setup(page,{deferredPreferences:true});
        await page.locator('#'+area.opener).click();
        await page.waitForFunction(()=>typeof fixtureResolvePreferences==='function');
        await page.evaluate(()=>{fixtureActive=false;fixtureWindows.sync();fixtureResolvePreferences();});
        await page.waitForTimeout(30);assert.equal(await page.locator('#'+area.root).isVisible(),false);
        await page.evaluate(()=>{fixtureActive=true;fixtureWindows.sync();});await page.locator('#'+area.root).waitFor();
        assert.equal(await page.locator('#'+area.root+' [data-gp-window-edge]').count(),8);
        assert.equal(await page.locator('#'+area.opener).getAttribute('aria-expanded'),'true');assert.deepEqual(errors,[]);await page.close();
      });
    }finally{await instance.close();}
  });

test('synchronizing while a close animation runs retains the explicit close intent',
  {skip:!enabled,timeout:60000},async t=>{
    const instance=await browser();try{
      const page=await instance.newPage({viewport:{width:1400,height:900}}),errors=await setup(page);
      for(const area of areas)await t.test(area.root,async()=>{
        await page.locator('#'+area.opener).click();const root=page.locator('#'+area.root);await root.waitFor();
        await root.locator('[data-rights-settings-window-close]').evaluate(button=>{button.click();fixtureWindows.sync();});
        await page.waitForFunction(id=>document.getElementById(id).hidden,area.root);
        await page.evaluate(()=>fixtureWindows.sync());assert.equal(await root.isVisible(),false);
        assert.equal(await page.locator('#'+area.opener).getAttribute('aria-expanded'),'false');assert.deepEqual(errors,[]);
      });
    }finally{await instance.close();}
  });

test('three additional rights areas use actual nonmodal GP windows with independent safe lifecycle',
  {skip:!enabled,timeout:90000},async t=>{
    const instance=await browser();try{
      const page=await instance.newPage({viewport:{width:1600,height:1000}}),errors=await setup(page);
      for(const area of areas)await t.test(area.root+' supports close, compact minimize, eight edges and whole-viewport movement',async()=>{
        await page.locator('#'+area.opener).click();const root=page.locator('#'+area.root);await root.waitFor();
        assert.equal(await root.locator('[data-gp-window-edge]').count(),8);assert.equal(await page.locator('dialog:modal').count(),0);
        await page.locator('#backgroundButton').focus();await page.keyboard.press('Enter');
        const before=await root.boundingBox();await toggle(root).click();const compact=await root.boundingBox();assert.ok(compact.width<=300&&compact.height<80);
        await toggle(root).click();assert.ok(Math.abs((await root.boundingBox()).width-before.width)<2);
        await root.locator('[data-rights-settings-window-title]').press('Home');const moved=await root.boundingBox();assert.ok(moved.x<2&&moved.y<2);
        await root.locator('[data-gp-window-edge="e"]').press('ArrowRight');assert.ok((await root.boundingBox()).width>moved.width);
        const edges=await root.locator('[data-gp-window-edge]').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent,cursor:getComputedStyle(node).cursor})));
        assert.ok(edges.every(edge=>!edge.text&&edge.cursor.includes('resize')));
        await close(root).click();await page.waitForFunction(id=>document.getElementById(id).hidden,area.root);
        assert.equal(await page.locator('#'+area.opener).getAttribute('aria-expanded'),'false');
        await page.locator('#'+area.opener).click();await root.waitFor();await close(root).click();await page.waitForFunction(id=>document.getElementById(id).hidden,area.root);
      });
      await t.test('navigation pauses all open windows and restores each unsaved local input and minimized state',async()=>{
        for(const [index,area]of areas.entries()){await page.locator('#'+area.opener).click();const root=page.locator('#'+area.root);await root.waitFor();
          await root.evaluate(node=>{const field=node.ownerDocument.createElement('input');field.dataset.syntheticDraft='';field.value='BEISPIEL: Entwurf';node.querySelector('[data-rights-settings-window-body]').append(field);});
          await toggle(root).click();await root.locator('[data-rights-settings-window-title]').press('Home');
          for(let step=0;step<index*32;step++)await root.locator('[data-rights-settings-window-title]').press('ArrowRight');}
        await page.evaluate(()=>{fixtureActive=false;fixtureWindows.sync();});
        for(const area of areas)assert.equal(await page.locator('#'+area.root).isVisible(),false);
        await page.evaluate(()=>{fixtureActive=true;fixtureWindows.sync();});
        for(const area of areas){const root=page.locator('#'+area.root);assert.equal(await root.isVisible(),true);assert.equal(await root.evaluate(node=>node.classList.contains('is-minimized')),true);
          await root.locator('[data-rights-settings-window-title]').focus();
          assert.equal(await root.evaluate(node=>node.classList.contains('is-active-window')),true,'Keyboard activation raises a covered window before restoring it');
          await toggle(root).click();assert.equal(await root.locator('[data-synthetic-draft]').inputValue(),'BEISPIEL: Entwurf');}
      });
      await t.test('new account and permission change hide stale windows and use separate geometry',async()=>{
        await page.evaluate(()=>{fixtureActor='BEISPIEL:B';fixtureRole='admin';fixturePreferences.invalidate();fixtureWindows.sync();});
        for(const area of areas)assert.equal(await page.locator('#'+area.root).isVisible(),false);
        await page.locator('#openPermissionDefaultsWindowButton').evaluate(button=>button.click());assert.equal(await page.locator('#permissionDefaultsWindow').isVisible(),false,'Only developer opens defaults');
        await page.locator('#openPersonnelFieldRightsWindowButton').click();await page.locator('#personnelFieldRightsWindow').waitFor();
        const box=await page.locator('#personnelFieldRightsWindow').boundingBox();assert.ok(box.x>20,'Second actor starts with its own centered geometry');
        await page.evaluate(()=>{fixtureAllowed=false;fixtureWindows.sync();});for(const area of areas)assert.equal(await page.locator('#'+area.root).isVisible(),false);
      });
      assert.equal(await page.evaluate(()=>backgroundClicks),3);assert.deepEqual(errors,[]);
    }finally{await instance.close();}
  });

test('all additional rights windows fit dark coarse-touch mobile and preserve saved geometry on remount',
  {skip:!enabled,timeout:60000},async()=>{
    const instance=await browser();try{
      const page=await instance.newPage({viewport:{width:390,height:844},hasTouch:true}),errors=await setup(page);
      await page.evaluate(()=>{document.documentElement.dataset.activePageTheme='dark';document.getElementById('settingsView').dataset.pageTheme='dark';});
      for(const area of areas){await page.locator('#'+area.opener).tap();const root=page.locator('#'+area.root);await root.waitFor();const box=await root.boundingBox();
        assert.ok(box.x>=-1&&box.y>=-1&&box.x+box.width<=391&&box.y+box.height<=845);
        const color=await root.evaluate(node=>getComputedStyle(node).backgroundColor);assert.ok(Number(color.match(/\d+/)[0])<80,'Body-sibling window owns its dark palette');
        await toggle(root).tap();assert.equal(await root.evaluate(node=>node.classList.contains('is-minimized')),true);await toggle(root).tap();
        await close(root).tap();await page.waitForFunction(id=>document.getElementById(id).hidden,area.root);}
      await page.setViewportSize({width:1400,height:900});await page.locator('#openPersonnelFieldRightsWindowButton').click();const root=page.locator('#personnelFieldRightsWindow');
      await root.locator('[data-rights-settings-window-title]').press('Home');await root.locator('[data-gp-window-edge="e"]').press('ArrowLeft');
      await page.waitForFunction(()=>geometryWrites.length>0);const persisted=await page.evaluate(()=>structuredClone(fixtureStorage));
      const restored=await instance.newPage({viewport:{width:1400,height:900}}),restoredErrors=await setup(restored,{storage:persisted});
      await restored.locator('#openPersonnelFieldRightsWindowButton').click();
      const restoredBox=await restored.locator('#personnelFieldRightsWindow').boundingBox();assert.ok(restoredBox.x<2&&restoredBox.y<2);
      assert.ok(Math.abs(restoredBox.width-persisted['BEISPIEL:A'].windows['rights:personnel-fields'].width)<2);
      assert.deepEqual(errors,[]);assert.deepEqual(restoredErrors,[]);
    }finally{await instance.close();}
  });

test('all additional already-open windows refit when the GP font scale changes without a browser resize',
  {skip:!enabled,timeout:60000},async t=>{
    const instance=await browser();try{
      const page=await instance.newPage({viewport:{width:390,height:844},hasTouch:true}),errors=await setup(page);
      for(const area of areas)await t.test(area.root,async()=>{
        await page.locator('#'+area.opener).evaluate(button=>button.click());const root=page.locator('#'+area.root);await root.waitFor();
        for(const scale of [1.25,1]){
          await page.evaluate(scale=>{document.documentElement.style.setProperty('--app-font-scale',String(scale));document.documentElement.style.setProperty('--app-font-scale-inverse',String(1/scale));fixtureWindows.sync();},scale);
          const box=await root.boundingBox();assert.ok(box.x>=-1&&box.y>=-1&&box.x+box.width<=391&&box.y+box.height<=845,'Changing only CSS font scale must keep the whole window on screen');
        }
        await close(root).click();await page.waitForFunction(id=>document.getElementById(id).hidden,area.root);
      });
      assert.deepEqual(errors,[]);
    }finally{await instance.close();}
  });

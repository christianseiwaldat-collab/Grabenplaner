'use strict';
// Existing dashboard HTML and synthetic in-memory accounts; no application server or database.
// This does not start Grabenplaner or access any application database.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const test=require('node:test');
const repo=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(repo,'public/index.html'),'utf8');
const start=html.indexOf('<section id="startDashboardView"'),end=html.indexOf('<section id="filialAdministrationView"',start);
const results={syntheticOnly:true,repositoryModified:false,checks:[],pageErrors:[]};
test('dashboard menus preserve defaults, focus, account isolation and safe remounts', {skip:process.env.GP_DASHBOARD_BROWSER_TEST!=='1',timeout:60000},async()=>{
 const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
 const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
 try {
  const page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',error=>results.pageErrors.push(error.message));
  await page.setContent('<style>'+fs.readFileSync(path.join(repo,'public/styles.css'),'utf8')+'\n'+fs.readFileSync(path.join(repo,'public','gp-window.css'),'utf8')+'\n'+fs.readFileSync(path.join(repo,'public','start-dashboard-workspace.css'),'utf8')+'</style>'+html.slice(start,end));
  await page.addScriptTag({path:path.join(repo,'public','gp-window-preferences.js')});
  await page.addScriptTag({path:path.join(repo,'public','gp-window.js')});
  await page.addScriptTag({path:path.join(repo,'public','start-dashboard-workspace-preferences.js')});
  await page.addScriptTag({path:path.join(repo,'public','start-dashboard-workspace-geometry.js')});
  await page.addScriptTag({path:path.join(repo,'public','start-dashboard-workspace.js')});
  await page.addScriptTag({path:path.join(repo,'public','start-dashboard-vps.js')});
  await page.evaluate(()=>{
   window.actor='A';window.allowedIds=new Set(StartDashboardWorkspacePreferences.IDS);window.persisted={};window.requests=[];
   const root=document.querySelector('#startDashboardView');
   root.querySelectorAll('.hidden').forEach(element=>element.classList.remove('hidden'));
   document.querySelector('#startDashboardCustomizer').classList.add('hidden');
   window.options={root,key:()=>actor,canUse:()=>actor!=='anonymous',allowed:id=>allowedIds.has(id),localOnly:()=>false,error:error=>{throw error;},
    api:async(url,options={})=>{requests.push({url,options,actor});if(options.method==='PUT'){persisted[actor]=JSON.parse(options.body).startDashboardWorkspace;return {};}
     return {startDashboardWorkspace:persisted[actor] || StartDashboardWorkspacePreferences.empty()};}};
   window.controller=StartDashboardWorkspace.create(options);
  });
  async function check(name,fn){await fn();results.checks.push(name);process.stdout.write('PASS '+name+'\n');}
  await check('seventeen_anchored_menus_open_separate_compact_editor',async()=>{
   assert.equal(await page.locator('[data-dashboard-field-menu]').count(),17);
   assert.equal(await page.locator('[data-dashboard-field-edge]').count(),17*8);
   assert.equal(await page.locator('[data-dashboard-field-edge]').evaluateAll(nodes=>nodes.every(node=>node.textContent==='')),true);
   await page.locator('[data-dashboard-field-menu="card:schedule"]').click();
   assert.equal(await page.locator('[data-field-menu]').isVisible(),true);
   assert.equal(await page.locator('[data-field-hide]').isVisible(),false);
   assert.equal(await page.locator('.start-dashboard-field-dialog').evaluate(dialog=>dialog.open),false);
   assert.equal(await page.locator('[data-dashboard-field-menu="card:schedule"]').getAttribute('aria-expanded'),'true');
   await page.locator('[data-field-edit]').click();
   assert.equal(await page.locator('[data-field-menu]').evaluate(element=>getComputedStyle(element).display),'none');
   assert.equal(await page.locator('.start-dashboard-field-dialog').evaluate(dialog=>dialog.open),true);
   assert.equal(await page.locator('[data-field-editor]').isVisible(),true);
  });
  await check('custom_labels_are_text_and_persist_only_for_current_synthetic_account',async()=>{
   await page.locator('[data-field-editor] input').fill('<img src=x onerror=alert(1)>');
   await page.locator('[data-field-editor] textarea').fill('Synthetic description');
   await page.locator('[data-field-editor] button[type=submit]').click();
   assert.equal(await page.locator('[data-start-dashboard-card="schedule"] .start-dashboard-card-link strong').textContent(),'<img src=x onerror=alert(1)>');
   assert.equal(await page.locator('[data-start-dashboard-card="schedule"] .start-dashboard-card-link img').count(),0);
   await page.waitForFunction(()=>persisted.A?.fields['card:schedule']);
   await page.evaluate(()=>{actor='B';controller.sync();});
   await page.waitForFunction(()=>document.querySelector('[data-start-dashboard-card="schedule"] strong').textContent==='Dienstplanung');
   assert.equal(await page.evaluate(()=>persisted.B),undefined);
   await page.evaluate(()=>{actor='A';controller.sync();});
   await page.waitForFunction(()=>document.querySelector('[data-start-dashboard-card="schedule"] strong').textContent.startsWith('<img'));
  });
  await check('denied_menu_hidden_and_open_dialog_closed_on_access_change',async()=>{
   await page.locator('[data-dashboard-field-menu="card:schedule"]').click();
   await page.evaluate(()=>{allowedIds.delete('card:schedule');controller.sync();});
   assert.equal(await page.locator('.start-dashboard-field-dialog').evaluate(dialog=>dialog.open),false);
   assert.equal(await page.locator('[data-field-menu]').isVisible(),false);
   assert.equal(await page.locator('[data-dashboard-field-menu="card:schedule"]').evaluate(button=>getComputedStyle(button).display),'none');
   await page.evaluate(()=>{allowedIds.add('card:schedule');controller.sync();});
  });
  await check('fresh_dynamic_description_survives_account_change_and_default_restore',async()=>{
   await page.evaluate(()=>{document.querySelector('#startDashboardSchedulePeriod').textContent='Fresh business period 42';actor='B';controller.sync();});
   await page.waitForFunction(()=>document.querySelector('#startDashboardSchedulePeriod').textContent==='Fresh business period 42');
  });
  await check('all_field_title_bars_move_without_extra_buttons_and_native_navigation_survives_clicks',async()=>{
   assert.equal(await page.locator('[data-dashboard-field-move]').count(),17);
   assert.equal(await page.locator('.start-dashboard-field-move').count(),0);
   assert.equal(await page.locator('[data-dashboard-field-move="group:branch"]').evaluate(node=>node.matches('.start-dashboard-group-link')),true);
   assert.equal(await page.locator('[data-dashboard-field-move="card:loans"]').evaluate(node=>node.matches('.start-dashboard-card-link')),true);
   assert.equal(await page.locator('[data-dashboard-field-move="widget:branchOnDuty"]').evaluate(node=>node.tagName),'SPAN');
   assert.equal(await page.locator('[data-dashboard-field-move="control:vps"]').evaluate(node=>node.tagName),'HEADER');
   await page.evaluate(()=>{
    window.navigationClicks=[];
    document.querySelector('#startDashboardView').addEventListener('click',event=>{
     const button=event.target.closest('[data-start-dashboard-view],[data-start-dashboard-card-view],#startDashboardControlCenterButton');
     if(button)navigationClicks.push(button.dataset.dashboardFieldMove);
    });
   });
   const title=page.locator('[data-dashboard-field-move="group:branch"]');
   await title.click();await title.press('Enter');
   const box=await title.boundingBox();
   await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
   await page.mouse.move(box.x+box.width/2+3,box.y+box.height/2+2);await page.mouse.up();
   assert.deepEqual(await page.evaluate(()=>navigationClicks),['group:branch','group:branch','group:branch']);
   assert.equal(await page.locator('[data-dashboard-floating]').count(),0);
   assert.equal(await page.evaluate(()=>persisted.B?.fields['group:branch']?.geometry),undefined);
  });
  await check('dragging_native_title_suppresses_only_its_drag_click_and_child_controls_keep_working',async()=>{
   const title=page.locator('[data-dashboard-field-move="group:branch"]');
   const box=await title.boundingBox();await page.mouse.move(box.x+150,box.y+30);await page.mouse.down();
   await page.mouse.move(box.x+190,box.y+60,{steps:4});await page.mouse.up();
   await page.waitForFunction(()=>persisted.B?.fields['group:branch']?.geometry);
   assert.equal(await page.evaluate(()=>navigationClicks.length),3,'a drag cannot activate the destination');
   await title.click();assert.equal(await page.evaluate(()=>navigationClicks.length),4,'the next normal click still navigates');
   await page.evaluate(()=>{
    const next=controller.store.value;delete next.fields['group:branch'];void controller.store.change(next);
    const select=document.querySelector('#startDashboardSalesMetric');select.innerHTML='<option value="net">Netto</option><option value="gross">Brutto</option>';
   });
   await page.locator('#startDashboardSalesMetric').selectOption('gross');
   await page.locator('#startDashboardNextSalesMetric').click();
   assert.equal(await page.locator('[data-dashboard-floating]').count(),0);
   assert.equal(await page.locator('#startDashboardSalesMetric').inputValue(),'gross');
  });
  await check('widget_and_vps_title_drags_move_their_own_field_and_pending_drags_cannot_cross_accounts',async()=>{
   for(const id of ['widget:branchOnDuty','control:vps']) {
    await page.locator(`[data-dashboard-field-move="${id}"]`).evaluate(handle=>{
     const rect=handle.getBoundingClientRect(),x=rect.x+12,y=rect.y+12;
     handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:51,button:0,isPrimary:true,clientX:x,clientY:y}));
     window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:51,clientX:x+40,clientY:y+20}));
     window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:51}));
    });
    await page.waitForFunction(id=>persisted.B?.fields[id]?.geometry,id);
    assert.deepEqual(await page.locator('[data-dashboard-floating]').evaluateAll(nodes=>nodes.map(node=>node.dataset.dashboardFloating)),[id]);
    await page.evaluate(id=>{const next=controller.store.value;delete next.fields[id];return controller.store.change(next);},id);
   }
   await page.evaluate(()=>{
    const handle=document.querySelector('[data-dashboard-field-move="card:loans"]'),rect=handle.getBoundingClientRect();
    handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:52,button:0,isPrimary:true,clientX:rect.x+12,clientY:rect.y+12}));
    actor='C';controller.sync();
    window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:52,clientX:rect.x+60,clientY:rect.y+30}));
    window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:52}));
   });
   await page.waitForFunction(()=>controller.store.ready);
   assert.equal(await page.locator('[data-dashboard-floating]').count(),0);
   assert.equal(await page.evaluate(()=>persisted.C),undefined);
   await page.evaluate(()=>{actor='B';controller.sync();});await page.waitForFunction(()=>controller.store.ready);
   assert.equal(await page.evaluate(()=>persisted.B?.fields['card:loans']?.geometry),undefined);
  });
  await check('widget_and_vps_title_bars_move_by_keyboard_without_moving_parent_fields',async()=>{
   for(const id of ['widget:branchOnDuty','control:vps']) {
    const title=page.locator(`[data-dashboard-field-move="${id}"]`);
    assert.equal(await title.getAttribute('tabindex'),'0');await title.focus();await title.press('ArrowDown');
    await page.waitForFunction(id=>persisted.B?.fields[id]?.geometry,id);
    assert.deepEqual(await page.locator('[data-dashboard-floating]').evaluateAll(nodes=>nodes.map(node=>node.dataset.dashboardFloating)),[id]);
    await page.evaluate(id=>{const next=controller.store.value;delete next.fields[id];return controller.store.change(next);},id);
   }
  });
  await check('destroy_restores_original_control_anchor_and_remount_never_nests_wrappers',async()=>{
   for(let i=0;i<3;i++) {
    await page.evaluate(()=>controller.destroy());
    assert.equal(await page.locator('.start-dashboard-control-workspace').count(),0);
    assert.equal(await page.locator('[data-dashboard-field-menu]').count(),0);
    assert.equal(await page.locator('[data-dashboard-field-move]').count(),0);
    assert.equal(await page.locator('[data-start-dashboard-widget="branchOnDuty"] > span').getAttribute('tabindex'),null);
    assert.deepEqual(await page.locator('#startDashboardControlCenterButton').evaluate(element=>({parent:element.parentElement.id,next:element.nextElementSibling.id})),{parent:'startDashboardView',next:'startDashboardCustomizer'});
    await page.evaluate(()=>{controller=StartDashboardWorkspace.create(options);});
    assert.equal(await page.locator('.start-dashboard-control-workspace').count(),1);
    assert.equal(await page.locator('[data-dashboard-field-menu]').count(),17);
   }
  });
  await check('escape_returns_keyboard_focus_to_originating_field_menu',async()=>{
   await page.locator('[data-dashboard-field-menu="card:schedule"]').click();await page.keyboard.press('Escape');
   await page.waitForFunction(()=>document.activeElement?.dataset.dashboardFieldMenu==='card:schedule');
  });
  await check('menu_keyboard_navigation_outside_click_and_scroll_reanchor_without_saving',async()=>{
   const origin=page.locator('[data-dashboard-field-menu="card:schedule"]');
   const before=await page.evaluate(()=>requests.filter(request=>request.options.method==='PUT').length);
   await origin.focus();await origin.press('ArrowDown');
   assert.equal(await page.evaluate(()=>document.activeElement?.hasAttribute('data-field-edit')),true);
   await page.keyboard.press('End');
   assert.equal(await page.evaluate(()=>document.activeElement?.hasAttribute('data-field-close')),true);
   await page.keyboard.press('ArrowDown');
   assert.equal(await page.evaluate(()=>document.activeElement?.hasAttribute('data-field-edit')),true);
   await page.keyboard.press('Tab');
   assert.equal(await page.locator('[data-field-menu]').isVisible(),false);
   assert.equal(await origin.getAttribute('aria-expanded'),'false');
   await origin.click();await page.locator('#startDashboardTitle').click();
   assert.equal(await page.locator('[data-field-menu]').isVisible(),false);
   await origin.click();await page.locator('#startDashboardView').dispatchEvent('scroll');
   assert.equal(await page.locator('[data-field-menu]').isVisible(),true);
   await page.locator('#startDashboardView').dispatchEvent('wheel');
   assert.equal(await page.locator('[data-field-menu]').isVisible(),false);
   assert.equal(await page.evaluate(()=>requests.filter(request=>request.options.method==='PUT').length),before);
  });
  await check('each_of_the_seventeen_fields_edits_independently_and_restores_its_default',async()=>{
   const ids=await page.evaluate(()=>StartDashboardWorkspacePreferences.IDS);
   for(const id of ids) {
    const button=page.locator(`[data-dashboard-field-menu="${id}"]`);
    const before=await page.evaluate(id=>controller.fields.get(id).title.textContent,id);
    await button.click();await page.locator('[data-field-edit]').click();
    await page.locator('[data-field-editor] input').fill('Eigenes Feld '+id);
    await page.locator('[data-field-editor] textarea').fill('Eigene Beschreibung '+id);
    await page.locator('[data-field-editor] button[type=submit]').click();
    assert.equal(await page.evaluate(id=>controller.fields.get(id).title.textContent,id),'Eigenes Feld '+id);
    await page.waitForFunction(id=>persisted.B?.fields[id]?.description==='Eigene Beschreibung '+id,id);
    await button.click();await page.locator('[data-field-default]').click();
    assert.equal(await page.evaluate(id=>controller.fields.get(id).title.textContent,id),before);
    await page.waitForFunction(id=>!persisted.B?.fields[id],id);
   }
  });
  await check('geometry_pointer_resize_and_keyboard_use_css_coordinates_under_zoom_and_transform',async()=>{
   await page.evaluate(async()=>{
    document.body.style.zoom='0.8';document.querySelector('#startDashboardView').style.transform='scale(.9)';
    document.querySelector('#startDashboardView').style.transformOrigin='top left';
    await controller.store.change({version:1,fields:{'card:loans':{title:'Retained title',geometry:{x:120,y:40,width:350,height:160}}}});
   });
   const move=page.locator('[data-dashboard-field-move="card:loans"]');
   let box=await move.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
   await page.mouse.move(box.x+box.width/2+72,box.y+box.height/2+72,{steps:5});await page.mouse.up();
   await page.waitForFunction(()=>persisted.B.fields['card:loans'].geometry.x===220);
   assert.equal(await page.evaluate(()=>persisted.B.fields['card:loans'].geometry.y),140);
   const resize=page.locator('[data-dashboard-field-resize="card:loans"]');box=await resize.boundingBox();
   await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+72,box.y+box.height/2+36,{steps:4});await page.mouse.up();
   await page.waitForFunction(()=>persisted.B.fields['card:loans'].geometry.width===450);
   assert.equal(await page.evaluate(()=>persisted.B.fields['card:loans'].geometry.height),210);
   await move.focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('Shift+ArrowDown');
   await page.waitForFunction(()=>persisted.B.fields['card:loans'].geometry.x===230 && persisted.B.fields['card:loans'].geometry.y===141);
   await resize.focus();await page.keyboard.press('ArrowDown');
   await page.waitForFunction(()=>persisted.B.fields['card:loans'].geometry.height===220);
  });
  await check('all_eight_invisible_resize_edges_preserve_the_opposite_anchor',async()=>{
   const previous=await page.evaluate(()=>controller.store.value);
   const cases={n:{x:300,y:310,width:300,height:170},ne:{x:300,y:310,width:310,height:170},e:{x:300,y:300,width:310,height:180},se:{x:300,y:300,width:310,height:190},s:{x:300,y:300,width:300,height:190},sw:{x:310,y:300,width:290,height:190},w:{x:310,y:300,width:290,height:180},nw:{x:310,y:310,width:290,height:170}};
   for(const [edge,expected]of Object.entries(cases)){
    await page.evaluate(async()=>{const value=controller.store.value;value.fields['card:loans']={geometry:{x:300,y:300,width:300,height:180}};await controller.store.change(value);});
    const handle=page.locator(`[data-dashboard-field-edge="card:loans"][data-gp-window-edge="${edge}"]`);
    await handle.press('ArrowRight');await handle.press('ArrowDown');
    await page.waitForFunction(expected=>JSON.stringify(persisted.B.fields['card:loans'].geometry)===JSON.stringify(expected),expected);
    assert.deepEqual(await page.evaluate(()=>persisted.B.fields['card:loans'].geometry),expected);
   }
   await page.evaluate(value=>controller.store.change(value),previous);
  });
  await check('pointer_cancel_preserves_saved_geometry_and_mobile_fallback_never_rewrites_it',async()=>{
   const saved=await page.evaluate(()=>structuredClone(persisted.B.fields['card:loans']));
   const move=page.locator('[data-dashboard-field-move="card:loans"]'),box=await move.boundingBox();
   await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+50,box.y+50);await page.keyboard.press('Escape');await page.mouse.up();
   assert.deepEqual(await page.evaluate(()=>persisted.B.fields['card:loans']),saved);
   await page.setViewportSize({width:390,height:844});
   await page.waitForFunction(()=>document.querySelectorAll('[data-dashboard-floating]').length===0);
   assert.equal(await move.isVisible(),true);
   assert.equal(await move.getAttribute('data-dashboard-drag-enabled'),'false');
   assert.equal(await page.locator('[data-start-dashboard-card="loans"]').evaluate(node=>node.parentElement.classList.contains('start-dashboard-card-list')),true);
   assert.deepEqual(await page.evaluate(()=>persisted.B.fields['card:loans']),saved);
   await page.setViewportSize({width:1600,height:1000});
   await page.waitForFunction(()=>document.querySelector('[data-dashboard-floating="card:loans"]'));
   assert.deepEqual(await page.evaluate(()=>persisted.B.fields['card:loans']),saved);
  });
  await check('touch_pointer_commit_then_remount_restores_geometry_without_cloning_business_nodes',async()=>{
   await page.evaluate(()=>{window.retainedLoan=document.querySelector('#startDashboardLoanSummary');});
   await page.locator('[data-dashboard-field-move="card:loans"]').evaluate(handle=>{
    const rect=handle.getBoundingClientRect(),x=rect.x+10,y=rect.y+10;
    handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:47,pointerType:'touch',button:0,isPrimary:true,clientX:x,clientY:y}));
    window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:47,pointerType:'touch',clientX:x+72,clientY:y}));
    window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:47,pointerType:'touch'}));
   });
   await page.waitForFunction(()=>persisted.B.fields['card:loans'].geometry.x===330);
   await page.evaluate(()=>{controller.destroy();controller=StartDashboardWorkspace.create(options);});
   await page.waitForFunction(()=>controller.store.ready && document.querySelector('[data-dashboard-floating="card:loans"]'));
   assert.equal(await page.evaluate(()=>retainedLoan===document.querySelector('#startDashboardLoanSummary')),true);
   assert.equal(await page.locator('[data-dashboard-floating="card:loans"]').evaluate(node=>node.style.left),'330px');
  });
  await check('rights_hide_floating_fields_but_unusable_workspace_restores_standard_read_only_layout',async()=>{
   await page.evaluate(()=>{allowedIds.delete('card:loans');controller.sync();});
   assert.equal(await page.locator('[data-dashboard-floating="card:loans"]').count(),0);
   assert.equal(await page.locator('[data-start-dashboard-card="loans"]').isVisible(),false);
   await page.evaluate(()=>{actor='anonymous';controller.sync();});
   assert.equal(await page.locator('[data-dashboard-floating]').count(),0);
   assert.equal(await page.locator('[data-start-dashboard-card="loans"]').isVisible(),true);
   assert.equal(await page.locator('[data-dashboard-field-move="card:loans"]').isVisible(),true);
   assert.equal(await page.locator('[data-dashboard-field-move="card:loans"]').getAttribute('data-dashboard-drag-enabled'),'false');
   await page.evaluate(()=>{allowedIds.add('card:loans');actor='B';controller.sync();});
   await page.waitForFunction(()=>controller.store.ready && document.querySelector('[data-dashboard-floating="card:loans"]'));
  });
  await check('single_geometry_reset_retains_labels_and_global_reset_restores_all_nodes',async()=>{
   await page.locator('[data-dashboard-field-menu="card:loans"]').click();await page.locator('[data-field-geometry-default]').click();
   await page.waitForFunction(()=>!persisted.B.fields['card:loans'].geometry);
   assert.equal(await page.locator('[data-dashboard-floating]').count(),0);
   assert.equal(await page.evaluate(()=>persisted.B.fields['card:loans'].title),'Retained title');
   await page.evaluate(async()=>{await controller.store.change({version:1,fields:{'group:branch':{geometry:{x:0,y:0,width:500,height:250}},'widget:branchOnDuty':{geometry:{x:600,y:250,width:350,height:150}}}});});
   assert.equal(await page.locator('[data-dashboard-floating]').count(),2);
   await page.evaluate(()=>controller.resetAll());
   await page.waitForFunction(()=>Object.keys(persisted.B.fields).length===0);
   assert.equal(await page.locator('[data-dashboard-floating]').count(),0);
   assert.equal(await page.locator('[data-start-dashboard-widget="branchOnDuty"]').evaluate(node=>node.parentElement.dataset.startDashboardCard),'schedule');
  });
  await check('both_control_cards_hide_independently_persist_and_can_be_restored_without_changing_business_scope',async()=>{
   await page.locator('[data-dashboard-field-menu="control:center"]').click();await page.locator('[data-field-hide]').click();
   await page.waitForFunction(()=>persisted.B?.fields['control:center']?.hidden===true);
   assert.equal(await page.locator('#startDashboardControlCenterButton').isVisible(),false);assert.equal(await page.locator('#startDashboardVpsCard').isVisible(),true);
   await page.locator('[data-dashboard-field-menu="control:vps"]').click();await page.locator('[data-field-hide]').click();
   await page.waitForFunction(()=>persisted.B.fields['control:vps'].hidden===true);assert.equal(await page.locator('#startDashboardVpsCard').isVisible(),false);
   await page.evaluate(()=>{controller.destroy();controller=StartDashboardWorkspace.create(options);});await page.waitForFunction(()=>controller.store.ready);
   assert.equal(await page.locator('#startDashboardControlCenterButton').isVisible(),false);assert.equal(await page.locator('#startDashboardVpsCard').isVisible(),false);
   await page.evaluate(()=>controller.setVisible('control:vps',true));assert.equal(await page.locator('#startDashboardVpsCard').isVisible(),true);assert.equal(await page.locator('#startDashboardControlCenterButton').isVisible(),false);
   await page.evaluate(()=>controller.resetAll());assert.equal(await page.locator('#startDashboardControlCenterButton').isVisible(),true);assert.equal(await page.locator('#startDashboardVpsCard').isVisible(),true);
  });
  await check('vps_values_use_read_only_native_resources_and_refresh_without_replacing_editor_buttons',async()=>{
   await page.evaluate(()=>{window.vpsClock=Date.now();window.vpsAllowed=true;window.vpsReads=[];window.vps=StartDashboardVps.mount(document.querySelector('#startDashboardVpsCard'),{
    key:()=>actor,canUse:()=>vpsAllowed,active:()=>controller.isVisible('control:vps'),now:()=>vpsClock,api:async(url,options)=>{vpsReads.push({url,method:options.method||'GET'});return {generatedAt:new Date(vpsClock).toISOString(),capabilities:{technicalDiagnostics:true},resources:{uptimeSeconds:3600,cpu:{loadAverageOneMinute:.5,logicalProcessors:4},memory:{usedPercent:40,availableBytes:1024,totalBytes:4096},storage:{freeBytes:8192,databaseBytes:2048}},status:{checkedAt:new Date(vpsClock).toISOString(),alerts:[]},recoveryAssurance:{integrityVerified:true,statusAvailable:true,recentRuns:[{trigger:'scheduled-nightly',status:'passed',startedAt:new Date(vpsClock-3600000).toISOString(),completedAt:new Date(vpsClock-1800000).toISOString(),phases:Array.from({length:5},()=>({status:'passed'}))}]}};}});});
   await page.waitForFunction(()=>document.querySelector('[data-vps-metric="nightly"] dd').textContent.includes('Erfolgreich'));
   assert.match(await page.locator('[data-vps-metric="warnings"]').textContent(),/Keine gemeldet/);assert.equal(await page.locator('[data-dashboard-field-menu="control:vps"]').count(),1);
   await page.locator('[data-vps-refresh]').click();assert.equal(await page.evaluate(()=>vpsReads.length),1);
   await page.evaluate(()=>{vpsClock+=60000;});await page.locator('[data-vps-refresh]').click();await page.waitForFunction(()=>vpsReads.length===2);
   assert.equal(await page.evaluate(()=>vpsReads.every(r=>r.url==='/api/portal/v1/system-center'&&r.method==='GET')),true);
   await page.evaluate(()=>{vpsAllowed=false;vps.sync();});assert.equal(await page.locator('[data-vps-metric]').count(),0);await page.evaluate(()=>vps.destroy());
  });
  await check('narrow_desktop_move_and_vertical_resize_preserve_preferred_width',async()=>{
   await page.evaluate(async()=>{
    controller.geometry.canvas.style.width='800px';
    await controller.store.change({version:1,fields:{'card:loans':{geometry:{x:100,y:20,width:1000,height:300}}}});
   });
   assert.equal(await page.locator('[data-dashboard-floating="card:loans"]').evaluate(node=>node.style.width),'800px');
   await page.locator('[data-dashboard-field-move="card:loans"]').focus();await page.keyboard.press('ArrowDown');
   await page.locator('[data-dashboard-field-resize="card:loans"]').focus();await page.keyboard.press('ArrowDown');
   await page.waitForFunction(()=>persisted.B.fields['card:loans'].geometry.height===310);
   assert.equal(await page.evaluate(()=>persisted.B.fields['card:loans'].geometry.width),1000);
   await page.evaluate(()=>{controller.geometry.canvas.style.width='';controller.sync();});
   assert.equal(await page.locator('[data-dashboard-floating="card:loans"]').evaluate(node=>node.style.width),'1000px');
  });
  await check('synchronous_menu_close_preserves_new_resize_focus_after_geometry_reset',async()=>{
   const resize=page.locator('[data-dashboard-field-resize="group:personnel"]');
   await resize.focus();await page.keyboard.press('ArrowRight');
   await page.waitForFunction(()=>persisted.B.fields['group:personnel']?.geometry);
   await page.locator('[data-dashboard-field-menu="group:personnel"]').click();
   const focus=await page.evaluate(async()=>{
    const handle=document.querySelector('[data-dashboard-field-resize="group:personnel"]');
    // The anchored menu closes synchronously. Nothing queued may steal a later
    // focus change from the field's resize edge.
    document.querySelector('[data-field-geometry-default]').click();handle.focus();
    const immediate=document.activeElement===handle;
    await Promise.resolve();
    return {immediate,afterClose:document.activeElement===handle,open:!controller.menu.hidden};
   });
   assert.deepEqual(focus,{immediate:true,afterClose:true,open:false});
   await page.keyboard.press('ArrowRight');
   await page.waitForFunction(()=>persisted.B.fields['group:personnel']?.geometry);
   assert.equal(await page.locator('[data-dashboard-floating="group:personnel"]').count(),1);
   await page.evaluate(async()=>{const next=controller.store.value;delete next.fields['group:personnel'];await controller.store.change(next);});
  });
  await check('queued_old_close_preserves_the_selection_of_an_immediately_reopened_dialog',async()=>{
   const previous=await page.evaluate(()=>controller.store.value);
   await page.locator('[data-dashboard-field-menu="card:loans"]').click();
   await page.locator('[data-field-edit]').click();
   const state=await page.evaluate(async()=>{
    const closed=new Promise(resolve=>controller.dialog.addEventListener('close',resolve,{once:true}));
    controller.dialog.close();
    document.querySelector('[data-dashboard-field-menu="group:personnel"]').click();
    await closed;
    document.querySelector('[data-field-edit]').click();
    return {open:controller.dialog.open,editing:!document.querySelector('[data-field-editor]').hidden,
     title:document.querySelector('[data-field-editor] input').value};
   });
   assert.equal(state.open,true);assert.equal(state.editing,true);
   assert.equal(state.title,await page.locator('[data-start-dashboard-group="personnel"] > .start-dashboard-group-link strong').textContent());
   await page.locator('[data-field-editor] input').fill('Reopened personnel field');
   await page.locator('[data-field-editor] button[type=submit]').click();
   await page.waitForFunction(()=>persisted.B.fields['group:personnel']?.title==='Reopened personnel field');
   const expected={...previous,fields:{...previous.fields,'group:personnel':{title:'Reopened personnel field',description:await page.evaluate(()=>controller.fields.get('group:personnel').description?.textContent || '')}}};
   assert.deepEqual(await page.evaluate(()=>persisted.B),expected,'the late close cannot redirect the edit into the previously selected field');
   await page.evaluate(value=>controller.store.change(value),previous);
  });
  await check('keyboard_move_and_resize_from_standard_layout_survive_focus_reparenting_and_single_reset',async()=>{
   const menu=page.locator('[data-dashboard-field-menu="group:personnel"]');
   const resize=page.locator('[data-dashboard-field-resize="group:personnel"]');
   const move=page.locator('[data-dashboard-field-move="group:personnel"]');
   assert.equal(await page.locator('[data-dashboard-floating="group:personnel"]').count(),0);
   await resize.focus();await page.keyboard.press('ArrowRight');
   await page.waitForFunction(()=>persisted.B.fields['group:personnel']?.geometry);
   assert.equal(await page.locator('[data-dashboard-floating="group:personnel"]').count(),1);
   await menu.click();await page.locator('[data-field-geometry-default]').click();
   await page.waitForFunction(()=>!persisted.B.fields['group:personnel']);
   assert.equal(await page.locator('[data-dashboard-floating="group:personnel"]').count(),0);
   await resize.focus();await page.keyboard.press('ArrowRight');
   await page.waitForFunction(()=>persisted.B.fields['group:personnel']?.geometry);
   await menu.click();await page.locator('[data-field-geometry-default]').click();
   await page.waitForFunction(()=>!persisted.B.fields['group:personnel']);
   await move.focus();await page.keyboard.press('ArrowDown');
   await page.waitForFunction(()=>persisted.B.fields['group:personnel']?.geometry);
   assert.equal(await page.locator('[data-dashboard-floating="group:personnel"]').count(),1);
   await menu.click();await page.locator('[data-field-geometry-default]').click();
   await page.waitForFunction(()=>!persisted.B.fields['group:personnel']);
   await move.focus();await page.keyboard.press('ArrowRight');
   await page.waitForFunction(()=>persisted.B.fields['group:personnel']?.geometry);
   assert.deepEqual(results.pageErrors,[]);
  });
  await check('all_seventeen_fields_float_independently_and_hidden_view_measurements_never_persist',async()=>{
   await page.evaluate(async()=>{
    const fields=Object.fromEntries(StartDashboardWorkspacePreferences.IDS.map((id,index)=>[id,{geometry:{x:(index%4)*260,y:Math.floor(index/4)*170,width:250,height:150}}]));
    await controller.store.change({version:1,fields});window.beforeHidden=JSON.stringify(persisted.B);
   });
   assert.equal(await page.locator('[data-dashboard-floating]').count(),17);
   await page.evaluate(()=>{document.getElementById('startDashboardView').classList.remove('active');controller.sync();});
   assert.equal(await page.locator('[data-dashboard-floating]').count(),0);
   assert.equal(await page.evaluate(()=>JSON.stringify(persisted.B)===beforeHidden),true);
   await page.evaluate(()=>{document.getElementById('startDashboardView').classList.add('active');controller.sync();});
   assert.equal(await page.locator('[data-dashboard-floating]').count(),17);
   await page.evaluate(()=>controller.resetAll());
   assert.equal(await page.locator('[data-dashboard-floating]').count(),0);
   assert.equal(await page.locator('[data-dashboard-field-menu]').count(),17);
   assert.equal(await page.evaluate(()=>retainedLoan===document.querySelector('#startDashboardLoanSummary')),true);
  });
  await check('slow_initial_read_and_read_error_gate_all_edit_actions_until_retry_preserves_baseline',async()=>{
   await page.evaluate(()=>{
    controller.destroy();window.originalApi=options.api;window.readErrors=[];actor='Slow';window.slowWrites=[];
    options.error=error=>readErrors.push(error.message);
    options.api=(url,o={})=>o.method==='PUT'?(slowWrites.push(JSON.parse(o.body)),Promise.resolve({})):new Promise(resolve=>window.resolveInitial=resolve);
    controller=StartDashboardWorkspace.create(options);
   });
   assert.equal(await page.locator('[data-dashboard-field-menu="card:loans"]').isDisabled(),true);
   assert.equal(await page.locator('[data-dashboard-field-move="card:loans"]').isDisabled(),false);
   assert.equal(await page.locator('[data-dashboard-field-move="card:loans"]').getAttribute('data-dashboard-drag-enabled'),'false');
   await page.locator('[data-dashboard-field-move="card:loans"]').evaluate(handle=>{
    handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:65,button:0,isPrimary:true,clientX:20,clientY:20}));
    window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:65,clientX:100,clientY:80}));
    window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:65}));
   });
   assert.equal(await page.locator('[data-dashboard-floating]').count(),0);
   await page.evaluate(()=>controller.resetAll());assert.equal(await page.evaluate(()=>slowWrites.length),0);
   await page.evaluate(()=>resolveInitial({startDashboardWorkspace:{version:1,fields:{'card:sales':{title:'Existing sales'}}}}));
   await page.waitForFunction(()=>controller.store.ready);
   await page.locator('[data-dashboard-field-menu="card:loans"]').click();await page.locator('[data-field-edit]').click();
   await page.locator('[data-field-editor] input').fill('New loans');await page.locator('[data-field-editor] button[type=submit]').click();
   await page.waitForFunction(()=>slowWrites.length===1);
   assert.equal(await page.evaluate(()=>slowWrites[0].startDashboardWorkspace.fields['card:sales'].title),'Existing sales');
   await page.evaluate(()=>{
    controller.destroy();actor='Failed';window.initialReadAttempts=0;
    options.api=async(url,o={})=>{if(o.method==='PUT')throw Error('Unexpected PUT');if(++initialReadAttempts===1)throw Error('initial read failed');return {startDashboardWorkspace:{version:1,fields:{'card:sales':{title:'Existing sales'}}}};};
    controller=StartDashboardWorkspace.create(options);
   });
   await page.waitForFunction(()=>controller.store.failed);
   await page.locator('[data-dashboard-field-menu="card:loans"]').click();
   assert.equal(await page.locator('[data-field-edit]').isDisabled(),true);
   assert.equal(await page.locator('[data-field-default]').isDisabled(),true);
   assert.equal(await page.locator('[data-field-geometry-default]').isDisabled(),true);
   assert.equal(await page.locator('[data-field-color]').evaluateAll(buttons=>buttons.every(button=>button.disabled)),true);
   assert.equal(await page.locator('[data-field-retry]').textContent(),'Erneut laden');
   await page.locator('[data-field-retry]').click();await page.waitForFunction(()=>controller.store.ready);
   assert.equal(await page.evaluate(()=>controller.store.value.fields['card:sales'].title),'Existing sales');
   assert.equal(await page.evaluate(()=>initialReadAttempts),2);
   assert.deepEqual(await page.evaluate(()=>readErrors),['initial read failed']);
  });
  await check('compact_editor_and_popup_are_excluded_from_generic_window_adapter',async()=>{
   assert.equal(await page.locator('#startDashboardCenterVisible').evaluate(node=>getComputedStyle(node).width),'16px');
   await page.evaluate(()=>{window.dialogPrefs=GpWindowPreferences.empty();window.dialogManager=GpWindow.installDocument(document,{actorKey:()=>actor,canUse:()=>true,readPreferences:async()=>({gpWindows:dialogPrefs}),writePreferences:async value=>{dialogPrefs=value;}});});
   await page.locator('[data-dashboard-field-menu="card:loans"]').click();
   assert.equal(await page.locator('[data-field-menu]').evaluate(node=>node.classList.contains('gp-window')),false);
   await page.locator('[data-field-edit]').click();
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await page.locator('.start-dashboard-field-dialog').evaluate(node=>node.classList.contains('gp-window')),false);
   assert.equal(await page.locator('.start-dashboard-field-dialog .gp-dialog-window-title').count(),0);
   const box=await page.locator('.start-dashboard-field-dialog').boundingBox();assert.ok(box.width<=401&&box.x>=0&&box.y>=0&&box.x+box.width<=1601&&box.y+box.height<=1001);
   await page.locator('[data-field-editor] input').fill('Adapter-Test');await page.locator('[data-field-editor] button[type=submit]').click();
   await page.waitForFunction(()=>controller.dialog.open===false);
   assert.equal(await page.evaluate(()=>document.activeElement?.dataset.dashboardFieldMenu),'card:loans');await page.evaluate(()=>dialogManager.destroy());
  });
  await check('popup_and_rename_editor_fit_a_small_viewport_at_large_application_zoom',async()=>{
   await page.locator('.start-dashboard-topbar').evaluate(header=>{header.style.display='none';});
   for(const {zoom,width,height} of [{zoom:1.5,width:640,height:480},{zoom:2,width:640,height:480},{zoom:2,width:800,height:600}]) {
    await page.setViewportSize({width,height});
    await page.evaluate(({zoom,width,height})=>{
     document.body.style.zoom=String(zoom);
     const button=document.querySelector('[data-dashboard-field-menu="card:loans"]');
     button.style.position='fixed';button.style.left=(width/zoom-40)+'px';button.style.top=(height/zoom-40)+'px';button.style.right='auto';
    },{zoom,width,height});
    await page.locator('[data-dashboard-field-menu="card:loans"]').click();
    const popup=await page.locator('[data-field-menu]').boundingBox();
    assert.ok(popup.x>=0&&popup.y>=0&&popup.x+popup.width<=width+1&&popup.y+popup.height<=height+1,JSON.stringify({zoom,popup}));
    await page.locator('[data-field-edit]').click();
    const editor=await page.locator('.start-dashboard-field-dialog').boundingBox();
    assert.ok(editor.x>=0&&editor.y>=0&&editor.x+editor.width<=width+1&&editor.y+editor.height<=height+1,JSON.stringify({zoom,editor}));
    await page.keyboard.press('Escape');
   }
   await page.evaluate(()=>{document.body.style.zoom='';document.querySelector('[data-dashboard-field-menu="card:loans"]').style.cssText='';document.querySelector('.start-dashboard-topbar').style.display='';});
   await page.setViewportSize({width:1600,height:1000});
  });
  await check('pastel_colors_save_per_field_without_tinting_uncolored_children_and_restore_independently',async()=>{
   // End the preceding failure fixture before exercising real mock persistence.
   await page.evaluate(()=>{controller.destroy();options.api=originalApi;options.error=error=>{throw error;};actor='B';controller=StartDashboardWorkspace.create(options);});
   await page.waitForFunction(()=>controller.store.ready);
   const previous=await page.evaluate(()=>controller.store.value);
   const childBackground=await page.locator('[data-start-dashboard-card="schedule"]').evaluate(node=>getComputedStyle(node).backgroundColor);
   const palette=await page.evaluate(()=>StartDashboardWorkspacePreferences.COLORS);
   const branchMenu=page.locator('[data-dashboard-field-menu="group:branch"]');
   for(const color of palette) {
    await branchMenu.click();await page.locator(`[data-field-color="${color}"]`).click();
    await page.waitForFunction(color=>persisted.B.fields['group:branch']?.color===color,color);
    assert.equal(await page.locator('[data-start-dashboard-group="branch"]').getAttribute('data-dashboard-color'),color);
    assert.equal(await page.locator('[data-start-dashboard-card="schedule"]').getAttribute('data-dashboard-color'),null);
    assert.equal(await page.locator('[data-start-dashboard-card="schedule"]').evaluate(node=>getComputedStyle(node).backgroundColor),childBackground);
    const expected=structuredClone(previous);expected.fields['group:branch']={...expected.fields['group:branch'],color};
    assert.deepEqual(await page.evaluate(()=>controller.store.value),expected);
    await branchMenu.click();assert.equal(await page.locator(`[data-field-color="${color}"]`).getAttribute('aria-checked'),'true');await page.keyboard.press('Escape');
   }
   await branchMenu.click();await page.locator('[data-field-color=""]').click();
   await page.waitForFunction(()=>!persisted.B.fields['group:branch']?.color);
   assert.deepEqual(await page.evaluate(()=>controller.store.value),previous);
   for(const [id,color] of [['group:branch','sage'],['card:schedule','blue'],['widget:salesKpis','rose'],['control:vps','lavender']]) {
    await page.locator(`[data-dashboard-field-menu="${id}"]`).click();await page.locator(`[data-field-color="${color}"]`).click();
    await page.waitForFunction(({id,color})=>persisted.B.fields[id]?.color===color,{id,color});
   }
   const saved=await page.evaluate(()=>controller.store.value);
   await page.evaluate(()=>{controller.destroy();controller=StartDashboardWorkspace.create(options);});
   await page.waitForFunction(()=>controller.store.ready);
   assert.deepEqual(await page.evaluate(()=>controller.store.value),saved);
   assert.equal(await page.locator('[data-start-dashboard-widget="salesKpis"]').getAttribute('data-dashboard-color'),'rose');
   await page.evaluate(()=>{actor='ColorOther';controller.sync();});await page.waitForFunction(()=>controller.store.ready);
   assert.equal(await page.locator('[data-dashboard-color]').count(),0);
   await page.evaluate(()=>{actor='B';controller.sync();});await page.waitForFunction(()=>controller.store.ready);
   assert.deepEqual(await page.evaluate(()=>controller.store.value),saved);
   await page.locator('[data-dashboard-field-menu="group:branch"]').click();await page.locator('[data-field-default]').click();
   assert.equal(await page.locator('[data-start-dashboard-group="branch"]').getAttribute('data-dashboard-color'),'sage');
   await page.evaluate(()=>controller.resetAll());assert.equal(await page.locator('[data-dashboard-color]').count(),0);
   await page.evaluate(value=>controller.store.change(value),previous);
  });
  await check('color_palette_has_keyboard_selection_and_honors_permission_gates',async()=>{
   const previous=await page.evaluate(()=>controller.store.value),origin=page.locator('[data-dashboard-field-menu="group:branch"]');
   const writes=await page.evaluate(()=>requests.filter(request=>request.options.method==='PUT').length);
   await origin.click();await page.keyboard.press('ArrowDown');
   assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-field-color')),'');
   await page.keyboard.press('ArrowRight');
   assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-field-color')),'sage');
   assert.equal(await page.evaluate(()=>requests.filter(request=>request.options.method==='PUT').length),writes);
   await page.keyboard.press('Enter');await page.waitForFunction(()=>persisted.B.fields['group:branch']?.color==='sage');
   await origin.click();await page.evaluate(()=>{allowedIds.delete('group:branch');controller.sync();document.querySelector('[data-field-color="blue"]').click();});
   assert.equal(await page.locator('[data-field-menu]').isVisible(),false);
   assert.equal(await page.evaluate(()=>controller.store.value.fields['group:branch'].color),'sage');
   await page.evaluate(()=>{allowedIds.add('group:branch');controller.sync();});
   await page.evaluate(value=>controller.store.change(value),previous);
  });
  assert.deepEqual(results.pageErrors,[]);
 } finally {await browser.close();}
});

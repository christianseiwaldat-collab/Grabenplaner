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
  await page.setContent('<style>'+fs.readFileSync(path.join(repo,'public/styles.css'),'utf8')+'\n'+fs.readFileSync(path.join(repo,'public','start-dashboard-workspace.css'),'utf8')+'</style>'+html.slice(start,end));
  await page.addScriptTag({path:path.join(repo,'public','start-dashboard-workspace-preferences.js')});
  await page.addScriptTag({path:path.join(repo,'public','start-dashboard-workspace-geometry.js')});
  await page.addScriptTag({path:path.join(repo,'public','start-dashboard-workspace.js')});
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
  await check('sixteen_menus_and_native_dialog_editor_hides_menu',async()=>{
   assert.equal(await page.locator('[data-dashboard-field-menu]').count(),16);
   await page.locator('[data-dashboard-field-menu="card:schedule"]').click();
   assert.equal(await page.locator('.start-dashboard-field-dialog').evaluate(dialog=>dialog.open),true);
   await page.locator('[data-field-edit]').click();
   assert.equal(await page.locator('[data-field-menu]').evaluate(element=>getComputedStyle(element).display),'none');
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
   assert.equal(await page.locator('[data-dashboard-field-menu="card:schedule"]').evaluate(button=>getComputedStyle(button).display),'none');
   await page.evaluate(()=>{allowedIds.add('card:schedule');controller.sync();});
  });
  await check('fresh_dynamic_description_survives_account_change_and_default_restore',async()=>{
   await page.evaluate(()=>{document.querySelector('#startDashboardSchedulePeriod').textContent='Fresh business period 42';actor='B';controller.sync();});
   await page.waitForFunction(()=>document.querySelector('#startDashboardSchedulePeriod').textContent==='Fresh business period 42');
  });
  await check('destroy_restores_original_control_anchor_and_remount_never_nests_wrappers',async()=>{
   for(let i=0;i<3;i++) {
    await page.evaluate(()=>controller.destroy());
    assert.equal(await page.locator('.start-dashboard-control-workspace').count(),0);
    assert.equal(await page.locator('[data-dashboard-field-menu]').count(),0);
    assert.deepEqual(await page.locator('#startDashboardControlCenterButton').evaluate(element=>({parent:element.parentElement.id,next:element.nextElementSibling.id})),{parent:'startDashboardView',next:'startDashboardCustomizer'});
    await page.evaluate(()=>{controller=StartDashboardWorkspace.create(options);});
    assert.equal(await page.locator('.start-dashboard-control-workspace').count(),1);
    assert.equal(await page.locator('[data-dashboard-field-menu]').count(),16);
   }
  });
  await check('escape_returns_keyboard_focus_to_originating_field_menu',async()=>{
   await page.locator('[data-dashboard-field-menu="card:schedule"]').click();await page.keyboard.press('Escape');
   await page.waitForFunction(()=>document.activeElement?.dataset.dashboardFieldMenu==='card:schedule');
  });
  await check('each_of_the_sixteen_fields_edits_independently_and_restores_its_default',async()=>{
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
  await check('pointer_cancel_preserves_saved_geometry_and_mobile_fallback_never_rewrites_it',async()=>{
   const saved=await page.evaluate(()=>structuredClone(persisted.B.fields['card:loans']));
   const move=page.locator('[data-dashboard-field-move="card:loans"]'),box=await move.boundingBox();
   await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+50,box.y+50);await page.keyboard.press('Escape');await page.mouse.up();
   assert.deepEqual(await page.evaluate(()=>persisted.B.fields['card:loans']),saved);
   await page.setViewportSize({width:390,height:844});
   await page.waitForFunction(()=>document.querySelectorAll('[data-dashboard-floating]').length===0);
   assert.equal(await move.isVisible(),false);
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
   assert.equal(await page.locator('[data-dashboard-field-move="card:loans"]').isVisible(),false);
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
  await check('queued_dialog_close_preserves_new_resize_focus_after_geometry_reset',async()=>{
   const resize=page.locator('[data-dashboard-field-resize="group:personnel"]');
   await resize.focus();await page.keyboard.press('ArrowRight');
   await page.waitForFunction(()=>persisted.B.fields['group:personnel']?.geometry);
   await page.locator('[data-dashboard-field-menu="group:personnel"]').click();
   const focus=await page.evaluate(async()=>{
    const handle=document.querySelector('[data-dashboard-field-resize="group:personnel"]');
    const closed=new Promise(resolve=>controller.dialog.addEventListener('close',resolve,{once:true}));
    // Keep reset and the user's next focus change in one task, before the
    // browser dispatches the native queued close event. No timing delay needed.
    document.querySelector('[data-field-geometry-default]').click();handle.focus();
    const immediate=document.activeElement===handle;
    await closed;
    return {immediate,afterClose:document.activeElement===handle,open:controller.dialog.open};
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
  await check('all_sixteen_fields_float_independently_and_hidden_view_measurements_never_persist',async()=>{
   await page.evaluate(async()=>{
    const fields=Object.fromEntries(StartDashboardWorkspacePreferences.IDS.map((id,index)=>[id,{geometry:{x:(index%4)*260,y:Math.floor(index/4)*170,width:250,height:150}}]));
    await controller.store.change({version:1,fields});window.beforeHidden=JSON.stringify(persisted.B);
   });
   assert.equal(await page.locator('[data-dashboard-floating]').count(),16);
   await page.evaluate(()=>{document.getElementById('startDashboardView').classList.remove('active');controller.sync();});
   assert.equal(await page.locator('[data-dashboard-floating]').count(),0);
   assert.equal(await page.evaluate(()=>JSON.stringify(persisted.B)===beforeHidden),true);
   await page.evaluate(()=>{document.getElementById('startDashboardView').classList.add('active');controller.sync();});
   assert.equal(await page.locator('[data-dashboard-floating]').count(),16);
   await page.evaluate(()=>controller.resetAll());
   assert.equal(await page.locator('[data-dashboard-floating]').count(),0);
   assert.equal(await page.locator('[data-dashboard-field-menu]').count(),16);
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
   assert.equal(await page.locator('[data-dashboard-field-move="card:loans"]').isDisabled(),true);
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
   assert.equal(await page.locator('[data-field-retry]').textContent(),'Erneut laden');
   await page.locator('[data-field-retry]').click();await page.waitForFunction(()=>controller.store.ready);
   assert.equal(await page.evaluate(()=>controller.store.value.fields['card:sales'].title),'Existing sales');
   assert.equal(await page.evaluate(()=>initialReadAttempts),2);
   assert.deepEqual(await page.evaluate(()=>readErrors),['initial read failed']);
  });
  assert.deepEqual(results.pageErrors,[]);
 } finally {await browser.close();}
});

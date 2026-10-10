'use strict';
// Real DOM lifecycle checks with synthetic data only; no GP server or database.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.join(__dirname,'..');
test('Learning and Trade retain interaction drafts while revalidating data, scope and revisions',
 {skip:process.env.GP_PAGE_STATE_BROWSER_TEST!=='1',timeout:60000},async()=>{
 const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright');
 const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
 const errors=[],checks=[];
 try{
  const page=await browser.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort());
  await page.setContent('<div id="team"></div><div id="trade"></div>');
  for(const file of ['learning-team.js','trade-insight-results.js','trade-movements.js','trade-stocktakes.js','trade-suggestions.js','trade-period.js','gp-data-quality.js'])await page.addScriptTag({path:path.join(root,'public',file)});
  await page.evaluate(()=>{
   window.learningOptions={locations:[{id:'18',name:'Filiale 18'}],positions:[{id:'sales',name:'Verkauf'}],roles:[{id:'employee',name:'Mitarbeiter'}],rules:[],canManage:true,
    scopes:[{type:'organization',label:'Organisation'},{type:'location',locationId:'18',label:'Filiale 18'}],modules:[{id:'skill',title:'Kassa',version:1,type:'skill',scope:{type:'organization'}}]};
   window.learningReads=[];window.learningWrites=[];window.failOptions=false;
   window.team=GrabenplanerLearningTeam.mount(document.querySelector('#team'),{api:async(url,options={})=>{
    if(url.endsWith('/team/options')){if(failOptions)throw Error('offline');return structuredClone(learningOptions);}
    if(options.method){learningWrites.push(JSON.parse(options.body));return {};}
    const params=new URL(url,'https://synthetic.invalid').searchParams;learningReads.push(Object.fromEntries(params));
    return {summary:{percent:learningReads.length,fulfilled:0,required:0,open:0,dueSoon:0},people:[{fullName:'Beispiel',employeeNumber:'SYNTHETIC',locationName:'Filiale 18',positionName:'Verkauf',cells:[]}],rules:[],offset:Number(params.get('offset')),pageSize:Number(params.get('pageSize')),total:200};
   }});
  });
  await page.evaluate(()=>team.load());
  await page.locator('#team [name="search"]').fill('Entwurf');await page.locator('#team [name="locationId"]').selectOption('18');
  await page.locator('#team [name="pageSize"]').selectOption('10');await page.locator('#team form[data-filters] button').click();
  await page.locator('#team [data-next]').click();await page.evaluate(()=>team.load());
  assert.equal(await page.locator('#team [name="search"]').inputValue(),'Entwurf');assert.equal(await page.locator('#team [name="locationId"]').inputValue(),'18');
  assert.equal(await page.evaluate(()=>learningReads.at(-1).offset),'10');assert.equal(await page.evaluate(()=>learningReads.at(-1).pageSize),'10');
  checks.push('learning_filter_page_preserved_with_fresh_results');
  await page.locator('#team .learning-team-requirements summary').click();await page.locator('#team [data-new]').click();await page.locator('.learning-team-dialog [name="title"]').fill('Unfertige Anforderung');
  await page.evaluate(()=>{learningOptions.scopes.reverse();return team.load();});
  assert.equal(await page.locator('.learning-team-dialog [name="title"]').inputValue(),'Unfertige Anforderung');
  await page.locator('.learning-team-dialog [type="submit"]').click();await page.waitForFunction(()=>learningWrites.length===1);
  assert.equal(await page.evaluate(()=>learningWrites[0].scope.type),'organization');checks.push('learning_draft_scope_not_rebased_by_options_reorder');
  await page.evaluate(()=>{failOptions=true;return team.load();});assert.equal(await page.locator('#team [name="search"]').inputValue(),'Entwurf');assert.equal(await page.locator('#team [data-error]').textContent(),'offline');
  await page.evaluate(()=>{failOptions=false;learningOptions.locations=[];return team.load();});
  assert.equal(await page.locator('#team [name="locationId"]').inputValue(),'');assert.equal(await page.evaluate(()=>learningReads.at(-1).offset),'0');
  await page.locator('#team [data-new]').click();await page.evaluate(()=>{learningOptions.canManage=false;return team.load();});
  assert.equal(await page.locator('.learning-team-dialog[open]').count(),0);assert.equal(await page.locator('#team [data-new]').count(),0);
  await page.evaluate(()=>team.clear());assert.equal(await page.locator('#team').textContent(),'');checks.push('learning_failed_refresh_retains_input_revocation_clears_access');

  await page.evaluate(()=>{
   window.GrabenplanerTradeTables={mount:()=>({attach(){},clear(){},activate(){},suspend(){},destroy(){}})};
   window.GrabenplanerTradeExport={mount:()=>({close(){},destroy(){}})};
   window.tradeContext={projection:{inventory:true,purchasing:true,customers:true,repairs:true,repairWrite:true,classify:true},locations:[{id:'18',label:'Filiale 18'}],purchasingLocations:[{id:'18',label:'Lieferstelle 18'}],today:'2026-10-06'};
   window.contextReads=0;window.tradeWrites=[];window.repairRevision=1;window.classRevision=1;window.reportNote='Erster Stand';
   window.tradeApi=async(url,options={})=>{
    const endpoint=url.replace('/api/trade-insights/',''),body=options.body?JSON.parse(options.body):null;
    if(endpoint==='context'){contextReads++;return structuredClone(tradeContext);}
    if(endpoint==='jobs'&&!body)return [{id:'saved',kind:'movements',status:'completed',accessible:true,title:'Gespeichert',created:'2026-10-01T09:00:00Z',count:0}];
    if(endpoint==='jobs/saved')return {id:'saved',kind:'movements',title:'Gespeichert',created:'2026-10-01T09:00:00Z',completedAt:'2026-10-01T09:01:00Z',processed:0,query:{query:'Serverfilter'},result:{rows:[],note:reportNote,sourceDate:'2026-10-01'}};
    if(endpoint.endsWith('-metadata')){const value={groups:[{id:'g',label:'Gruppe'}],wgr:[{id:'w',label:'Warengruppe'}],stockLocations:[{id:'18',label:'Filiale 18'}],cashPeriod:{dateTo:'2026-10-06'}};if(window.holdMetadata)return new Promise(resolve=>{window.releaseMetadata=()=>resolve(value);});return value;}
    if(endpoint==='repair-detail')return {id:body.id,revision:repairRevision,documentNumber:'RE-SYNTHETIC',gpStatus:'unassigned',sourceDate:'2026-10-06',note:'Aktueller Stand '+repairRevision};
    if(endpoint==='classification')return {level:body.level,key:body.key,label:'Aktuelle Einstufung',revision:classRevision,value:{kind:'goods'}};
    if(endpoint==='repair-save'||endpoint==='classification-save'){tradeWrites.push({endpoint,body});throw Error('Version inzwischen geändert');}
    if(endpoint==='jobs'&&body)return {id:'queued',status:'queued'};
    throw Error('Unexpected synthetic endpoint '+endpoint);
   };
  });
  await page.addScriptTag({path:path.join(root,'public/trade-insights.js')});
  await page.evaluate(async()=>{window.trade=GrabenplanerTradeInsights.mount(document.querySelector('#trade'),{api:tradeApi});await trade.activate('repairs');});
  await page.locator('#trade [name="query"]').fill('Reparaturfilter');
  await page.evaluate(()=>{const button=document.createElement('button');button.dataset.repair='repair-one';button.textContent='Reparatur öffnen';document.querySelector('[data-ti="results"]').append(button);});
  await page.locator('[data-repair]').click();await page.locator('[data-ti="repair-status-form"] [name="state"]').selectOption('collected');
  await page.evaluate(async()=>{trade.setArea('logistics');await trade.activate('purchasing');});
  await page.locator('#trade [name="query"]').fill('Logistikfilter');
  await page.evaluate(async()=>{repairRevision=2;trade.setArea('stock');await trade.activate('repairs');});
  assert.equal(await page.locator('#trade [name="query"]').inputValue(),'Reparaturfilter');assert.equal(await page.locator('[data-ti="repair-dialog"]').getAttribute('open'),'');
  assert.equal(await page.locator('[data-ti="repair-status-form"] [name="state"]').inputValue(),'collected');assert.match(await page.locator('[data-ti="repair-content"]').textContent(),/Aktueller Stand 2/);
  assert.match(await page.locator('[data-ti="repair-status"]').textContent(),/inzwischen geändert/);
  await page.locator('[data-ti="repair-status-form"] button').click();assert.equal(await page.evaluate(()=>tradeWrites.at(-1).body.expectedRevision),1);
  await page.evaluate(async()=>{trade.setArea('logistics');await trade.activate('purchasing');});assert.equal(await page.locator('#trade [name="query"]').inputValue(),'Logistikfilter');
  assert.equal(await page.evaluate(()=>contextReads),4);checks.push('trade_area_filters_and_repair_draft_preserved_fresh_revision_conflicts');

  await page.evaluate(async()=>{trade.setArea('stock');await trade.activate('movements');});
  await page.locator('[data-job-open="saved"]').click();await page.waitForFunction(()=>document.querySelector('[data-ti="snapshot"]').hidden===false);
  await page.locator('#trade [name="query"]').evaluate(element=>{element.value='Unfertiger neuer Filter';});
  await page.locator('[data-ti="snapshot"] [name="title"]').fill('Unfertiger Titel');
  await page.locator('[data-ti="results"] [data-sort="date"]').click();
  await page.evaluate(async()=>{trade.suspend();reportNote='Frisch geprüft';await trade.activate('movements');});
  assert.equal(await page.locator('#trade [name="query"]').inputValue(),'Unfertiger neuer Filter');assert.equal(await page.locator('[data-ti="snapshot"] [name="title"]').inputValue(),'Unfertiger Titel');
  assert.match(await page.locator('[data-ti="note"]').textContent(),/Frisch geprüft/);assert.match(await page.locator('[data-ti="pdf"]').getAttribute('href'),/direction=asc/);
  checks.push('trade_saved_result_revalidated_sort_filter_and_title_retained');
  await page.evaluate(()=>trade.activate('inventory'));await page.locator('[data-ti="classification"] summary').click();await page.locator('[data-ti="class-form"] [name="groupKey"]').selectOption('w');await page.locator('[data-ti="class-form"] button').click();
  await page.locator('[data-ti="class-save"] [name="kind"]').selectOption('service');
  await page.evaluate(async()=>{trade.suspend();classRevision=2;await trade.activate('inventory');});
  assert.equal(await page.locator('[data-ti="class-save"] [name="kind"]').inputValue(),'service');assert.match(await page.locator('[data-ti="class-status"]').textContent(),/inzwischen geändert/);
  await page.locator('[data-ti="class-save"] button').click();assert.equal(await page.evaluate(()=>tradeWrites.at(-1).body.expectedRevision),1);
  await page.evaluate(()=>{trade.suspend();window.holdMetadata=true;window.resuming=trade.activate('inventory');});await page.waitForFunction(()=>typeof releaseMetadata==='function');
  await page.locator('#trade [name="query"]').fill('Während Laden ergänzt');
  await page.evaluate(async()=>{holdMetadata=false;releaseMetadata();await resuming;});assert.equal(await page.locator('#trade [name="query"]').inputValue(),'Während Laden ergänzt');
  checks.push('trade_late_metadata_preserves_inputs_added_during_refresh');
  await page.evaluate(async()=>{trade.suspend();tradeContext.projection={customers:true};await trade.activate('inventory');});
  assert.equal(await page.evaluate(()=>trade.getTab()),'customer-history');assert.equal(await page.locator('[data-ti="classification"]').isVisible(),false);assert.equal(await page.locator('[data-ti="repair-dialog"]').isVisible(),false);
  await page.evaluate(()=>trade.destroy());assert.equal(await page.locator('#trade').textContent(),'');checks.push('trade_classification_draft_cas_and_permission_revocation');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({syntheticOnly:true,checks,passed:checks.length,pageErrors:errors}));
 }finally{await browser.close();}
});

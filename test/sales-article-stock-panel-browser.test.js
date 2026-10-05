'use strict';
// Synthetic in-memory accounts only; no application server or database.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.join(__dirname,'..');
test('Chromium stock preferences wait for the account baseline, retry failed loads and isolate account changes',
  {skip:process.env.GP_STOCK_PANEL_BROWSER_TEST!=='1',timeout:60000},async()=>{
  const {chromium}=require(process.env.GP_BROWSER_TEST_MODULE || 'playwright');
  const browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{}),args:['--no-first-run']});
  const errors=[],checks=[];
  try {
    const page=await browser.newPage({viewport:{width:1200,height:800}});page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.abort());
    async function fixture() {
      await page.setContent('<div id="stock"></div><input id="priceTrial" value="123.45">');
      for(const file of ['table-layout.js','sales-article-detail-preferences.js','sales-article-layout.js','sales-article-stock-panel.js']) {
        await page.addScriptTag({path:path.join(root,'public',file)});
      }
      await page.evaluate(()=>{
        window.actor='A';window.requests=[];window.writes=[];window.loadErrors=[];
        window.baseline={...SalesArticleDetailPreferences.defaults(),hiddenBranchIds:['18'],columns:['branch','quantity'],columnWidths:{branch:230},sort:'quantity',direction:'desc'};
        window.store=SalesArticleDetailPreferences.createStore({key:()=>actor,canUse:()=>true,error:error=>loadErrors.push(error.message),
          api:async(url,options={})=>{
            if(options.method==='PUT') {writes.push({actor,value:JSON.parse(options.body)});return {};}
            return new Promise((resolve,reject)=>requests.push({actor,options,resolve,reject}));
          }});
        window.mount=()=>{
          const key=actor;
          return SalesArticleStockPanel.mount(document.querySelector('#stock'),{store,
            stock:{rows:[{id:'18',name:'A',quantity:1,ordered:null,orders:{state:'restricted'}},{id:'19',name:'B',quantity:2,ordered:null,orders:{state:'restricted'}}]},
            formats:{timestamp:value=>value || '–'},layout:SalesArticleLayout,tableLayout:GrabenplanerTableLayout,
            columns:SalesArticleDetailPreferences.COLUMNS,canUse:()=>actor===key});
        };
        window.pending=store.activate();window.panel=mount();window.priceTrial=document.querySelector('#priceTrial');
      });
    }
    async function disabled() {
      for(const selector of ['[data-stock-branch="19"]','[data-stock-column="branch"]','[data-stock-sort="quantity"]','[data-stock-all]','[data-gp-column-resize="branch"]']) {
        assert.equal(await page.locator(selector).isDisabled(),true,selector);
      }
    }
    await fixture();await page.locator('[data-stock-settings] summary').click();await disabled();
    assert.equal(await page.evaluate(async()=>{const changed=store.change({...store.value,hiddenBranchIds:['19']});return changed===false && await store.save()===false;}),true);
    assert.equal(await page.evaluate(()=>requests[0].options.signal.aborted),false);assert.equal(await page.evaluate(()=>writes.length),0);
    await page.evaluate(async()=>{requests[0].resolve({...baseline,configured:true});await pending;});
    assert.equal(await page.locator('[data-stock-branch="19"]').isEnabled(),true);
    await page.locator('[data-stock-branch="19"]').uncheck();await page.waitForFunction(()=>writes.length===1);
    assert.deepEqual(await page.evaluate(()=>writes[0].value),await page.evaluate(()=>({...baseline,hiddenBranchIds:['18','19']})));
    assert.equal(await page.evaluate(()=>priceTrial===document.querySelector('#priceTrial') && priceTrial.value==='123.45'),true);
    checks.push('delayed_baseline_blocks_all_writes_and_preserves_saved_preferences');

    await fixture();await page.evaluate(async()=>{requests[0].reject(Error('offline'));await pending;});
    assert.equal(await page.getByRole('alert').isVisible(),true);await disabled();
    await page.evaluate(()=>store.activate());assert.equal(await page.evaluate(()=>requests.length),1);
    const retry=page.getByRole('button',{name:'Einstellungen erneut laden'});await retry.focus();await page.keyboard.press('Enter');
    await page.waitForFunction(()=>requests.length===2);await disabled();assert.equal(await page.evaluate(()=>writes.length),0);
    await page.evaluate(()=>requests[1].resolve({...baseline,configured:true}));await page.waitForFunction(()=>store.ready);
    assert.equal(await page.getByRole('alert').count(),0);assert.equal(await retry.count(),0);
    assert.equal(await page.evaluate(()=>document.activeElement?.matches('[data-stock-settings] > summary')),true);
    await page.locator('[data-stock-settings] summary').click();await page.locator('[data-stock-branch="19"]').uncheck();
    await page.waitForFunction(()=>writes.length===1);assert.deepEqual(await page.evaluate(()=>writes[0].value.columnWidths),{branch:230});
    checks.push('failed_load_retries_by_keyboard_without_a_default_snapshot_put');

    await fixture();await page.evaluate(()=>{panel.destroy();actor='B';store.invalidate();pending=store.activate();panel=mount();});
    await disabled();assert.equal(await page.evaluate(()=>requests[0].options.signal.aborted),true);
    await page.evaluate(()=>requests[0].resolve({...baseline,configured:true}));
    assert.equal(await page.evaluate(()=>store.ready),false);assert.equal(await page.evaluate(()=>writes.length),0);
    await page.evaluate(()=>requests[1].resolve({...SalesArticleDetailPreferences.defaults(),hiddenBranchIds:['20'],columnWidths:{quantity:150},configured:true}));
    await page.waitForFunction(()=>store.ready);assert.deepEqual(await page.evaluate(()=>store.value.hiddenBranchIds),['20']);
    assert.deepEqual(await page.evaluate(()=>store.value.columnWidths),{quantity:150});assert.equal(await page.evaluate(()=>writes.length),0);
    checks.push('account_switch_rejects_the_old_baseline_and_waits_for_the_new_one');
    assert.deepEqual(errors,[]);console.log(JSON.stringify({syntheticOnly:true,checks,passed:checks.length,pageErrors:errors}));
  } finally {await browser.close();}
});

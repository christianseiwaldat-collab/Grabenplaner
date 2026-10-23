'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const repo=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(repo,'public/index.html'),'utf8');
function markup(id){const match=html.match(new RegExp('<dialog\\b[^>]*\\bid="'+id+'"[^>]*>'));assert.ok(match,id);return html.slice(match.index,html.indexOf('</dialog>',match.index)+9);}
test('actual main workspaces keep chosen import files and drafts while security actions stay modal',{skip:process.env.GP_WINDOW_BROWSER_TEST!=='1',timeout:60000},async()=>{
 const{chromium}=require(process.env.GP_BROWSER_TEST_MODULE||'playwright'),browser=await chromium.launch({headless:true,...(process.env.GP_BROWSER_EXECUTABLE?{executablePath:process.env.GP_BROWSER_EXECUTABLE}:{})});
 try{
  const ids=['crmColumnsDialog','salesArticleImageDialog','salesArticleEditorDialog','salesArticleImportDialog','vacationAccountsModal','monthlyTimeRecordsModal','loanOverviewColumnsDialog','payrollHandoffProtocolModal'];
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort());
  await page.setContent('<button id="background">BEISPIEL Hintergrund</button>'+[...ids,'serverRestartModal','vpsRebootModal','resetWeekModal','integrationConnectionModal'].map(markup).join(''));
  for(const f of ['styles.css','gp-window.css'])await page.addStyleTag({path:path.join(repo,'public',f)});
  for(const f of ['gp-window-preferences.js','gp-window.js'])await page.addScriptTag({path:path.join(repo,'public',f)});
  await page.evaluate(()=>{window.clicked=0;background.onclick=()=>clicked++;window.manager=GpWindow.installDocument(document,{actorKey:()=> 'BEISPIEL',canUse:()=>true,readPreferences:async()=>({version:1,windows:{}}),writePreferences:async()=>{}});});
  for(const id of ids){
   await page.evaluate(id=>document.getElementById(id).showModal(),id);assert.equal(await page.locator('#'+id).evaluate(d=>d.matches(':modal')),false,id);
   const fields=page.locator('#'+id+' input:not([type="hidden"]):not([type="number"]):not([type="month"]):not([type="checkbox"]):not([type="file"]),#'+id+' textarea');
   let input,value;if(await fields.count()){input=fields.first();if(await input.isVisible()&&await input.isEditable()){await input.fill('BEISPIEL-Draft');value=await input.inputValue();}}
   const file=page.locator('#'+id+' input[type="file"]').first();if(await file.count())await file.setInputFiles({name:'BEISPIEL.csv',mimeType:'text/csv',buffer:Buffer.from('number,label\nSYN-1,BEISPIEL\n')});
   await page.locator('#'+id+' [data-gp-window-toggle]').click();await page.locator('#background').click();await page.locator('#'+id+' [data-gp-window-toggle]').click();
   if(value)assert.equal(await input.inputValue(),value,id);if(await file.count())assert.equal(await file.evaluate(n=>n.files[0].name),'BEISPIEL.csv',id);
   if(id==='salesArticleImportDialog'){const directory=path.resolve(repo,'../output/gp-22-blocks-20261011');await page.screenshot({path:path.join(directory,'block06-import-desktop.png')});}
   await page.evaluate(id=>document.getElementById(id).close(),id);
  }
  assert.equal(await page.evaluate(()=>clicked),ids.length);
  for(const id of ['serverRestartModal','vpsRebootModal','resetWeekModal','integrationConnectionModal']){await page.evaluate(id=>document.getElementById(id).showModal(),id);await page.waitForFunction(id=>document.getElementById(id).querySelector('.gp-dialog-window-title'),id);assert.equal(await page.locator('#'+id).evaluate(d=>d.matches(':modal')),true,id);assert.equal(await page.locator('#'+id+' [data-gp-window-toggle]').count(),0,id);await page.evaluate(id=>document.getElementById(id).close(),id);}
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>salesArticleImportDialog.showModal());assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.resolve(repo,'../output/gp-22-blocks-20261011/block06-import-mobile.png')});
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

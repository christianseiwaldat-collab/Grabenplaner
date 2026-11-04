"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {fixtureHtml,holidayFixtureHtml,mhtml}=require('../test-support/xoffi-mhtml');
const {inspectXoffiMhtmlBuffer}=require('../lib/xoffi-mhtml-import');
const {createReviewedXoffiSnapshot}=require('../lib/xoffi-week-reconciliation');
const {buildComparison,combineComparisons,thresholds}=require('../lib/xoffi-plan-comparison');
const presentation=require('../public/gp-xoffi-import');
const {functionSource,harness}=require('../test-support/xoffi-import-ui');
function preview(partial=false){const result=inspectXoffiMhtmlBuffer(mhtml(holidayFixtureHtml({name:'Mara Beispiel'})+(partial?fixtureHtml({name:'Alina Beispiel'}).replace('Gesamt: 8.50','missing'):'')),{employees:[{personnel_number:'E1',full_name:'Mara Beispiel'}]});return{...result,previewId:'synthetic-preview',calendarWeek:37,context:{locationId:'18',locationName:'BEISPIEL-Filiale',departmentId:7},candidates:[{employeeNumber:'E1',fullName:'Mara Beispiel'}]};}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const applied=()=>({schedule:{weekStart:'2026-09-07',context:{locationId:'18',departmentId:7},syntheticSaved:true}});

test('compact preview separates source and review, retains escaped warnings, and offers invalid rows only explicit exclusion',()=>{
 const source=preview(true);source.warnings=['Unsicher <img src=x onerror=alert(1)> https://example.invalid/session'];source.employees[0].warnings=['OCR-Hinweis <script>bad()</script>'];
 const html=presentation.render(source);
 assert.match(html,/33 h Tagesbewertung \+ 8 h Feiertagsstunden = 41 h Woche/);assert.match(html,/Teilzeitraum/);
 assert.match(html,/Mein Review · Woche/);assert.match(html,/Tageswerte prüfen · 7 Tage/);assert.match(html,/Mo · 07\.09\.2026/);
 assert.match(html,/&lt;img/);assert.match(html,/OCR-Hinweis &lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img|example\.invalid/);
 const invalid=html.slice(html.indexOf('data-xoffi-row="1"'));
 assert.doesNotMatch(invalid,/data-xoffi-week|data-xoffi-day|value="E1"/);assert.match(invalid,/value="__skip__"/);
 const h=harness();h.open();h.load(source);assert.equal(h.elements.xoffiApplyButton.disabled,true);
 const row=h.elements.xoffiImportPreview.rows[1];row.fields.employee.value='E1';assert.match(h.context.xoffiMappingIssue(),/ungeklärte Quellzeile/);
 row.fields.employee.value='__skip__';h.context.updateXoffiApplyAvailability();assert.equal(h.elements.xoffiApplyButton.disabled,false);
 const collected=h.context.collectXoffiReviewedRows();assert.equal(collected.length,2);assert.deepEqual(JSON.parse(JSON.stringify(collected[1])),{sourceName:'Alina Beispiel',employeeNumber:'',excluded:true});
});
test('inspection response and JSON parsing cannot restore a closed, superseded, actor, rights or context-changed preview',async()=>{
 for(const change of [h=>h.context.closeXoffiImport(),h=>{h.state.weekStart='2026-09-14';h.context.syncXoffiImport();},
  h=>{h.state.locationId='19';h.context.syncXoffiImport();},h=>{h.state.departmentId='8';h.context.syncXoffiImport();},
  h=>{h.state.portalSession={...h.state.portalSession,user:{...h.state.portalSession.user,employeeNumber:'E2'}};h.context.syncXoffiImport();},
  h=>{h.state.portalSession.user.permissions=[];h.context.syncXoffiImport();},h=>{h.state.portalSession=null;h.context.syncXoffiImport();}]){
  const h=harness(),response=deferred();h.open();h.setRaw(()=>Promise.resolve({json:()=>response.promise}));
  const task=h.context.inspectXoffiImportFile();await Promise.resolve();change(h);response.resolve(preview());await task;
  assert.equal(h.state.xoffiImportPreview,null);assert.equal(h.elements.xoffiImportPreview.innerHTML,'');assert.equal(h.toasts.filter(row=>row.error).length,0);
 }
 const h=harness(),old=deferred(),fresh=deferred();h.open();let count=0;h.setRaw(()=>++count===1?old.promise:fresh.promise);
 const first=h.context.inspectXoffiImportFile();h.context.changeXoffiImportFile();const second=h.context.inspectXoffiImportFile();
 fresh.resolve({json:async()=>({...preview(),previewId:'fresh'})});await second;old.resolve({json:async()=>({...preview(),previewId:'old'})});await first;
 assert.equal(h.state.xoffiImportPreview.previewId,'fresh');assert.equal(h.calls[0].options.signal.aborted,true);assert.equal(h.elements.xoffiInspectButton.disabled,false);
});
test('successful apply restores editable controls on reopening and posts no client source snapshot',async()=>{
 const h=harness();h.open();h.load(preview());h.setApi(async()=>applied());await h.context.applyXoffiImport({preventDefault(){}});
 assert.equal(h.state.data.syntheticSaved,true);assert.equal(h.elements.xoffiImportDialog.open,false);
 const payload=JSON.parse(h.calls.find(call=>call.kind==='apply').options.body);
 assert.equal(payload.employees[0].days.length,7);assert.equal(Object.hasOwn(payload.employees[0],'snapshot'),false);
 h.open();assert.ok(h.controls().every(field=>field.disabled===false));assert.equal(h.elements.xoffiApplyButton.disabled,true);
 h.load(preview());assert.equal(h.elements.xoffiApplyButton.disabled,false);
});
test('closing or changing week during an apply leaves the backend request running and preserves the current view after completion',async()=>{
 for(const change of [h=>h.context.closeXoffiImport(),h=>{h.state.weekStart='2026-09-14';h.context.syncXoffiImport();}]){
  const h=harness(),response=deferred();h.open();h.load(preview());h.setApi(()=>response.promise);
  const pending=h.context.applyXoffiImport({preventDefault(){}});h.context.updateXoffiApplyAvailability();assert.equal(h.elements.xoffiApplyButton.disabled,true);
  await h.context.applyXoffiImport({preventDefault(){}});assert.equal(h.calls.filter(call=>call.kind==='apply').length,1);
  change(h);h.state.data={currentViewSentinel:true};h.open();assert.equal(h.elements.xoffiImportConfirmed.disabled,true);
  response.resolve(applied());await pending;
  assert.equal(h.state.data.currentViewSentinel,true);assert.equal(h.calls.filter(call=>call.kind==='render').length,0);
  assert.ok(h.toasts.some(row=>/abgeschlossen/.test(row.message)));assert.equal(h.elements.xoffiImportConfirmed.disabled,false);
  h.context.closeXoffiImport();h.open();assert.ok(h.controls().every(field=>field.disabled===false));
 }
});
test('foreign-account apply completion never renders or announces another actor result; a current failure remains visible and retryable',async()=>{
 const h=harness(),response=deferred();h.open();h.load(preview());h.setApi(()=>response.promise);const pending=h.context.applyXoffiImport({preventDefault(){}});
 h.state.portalSession={...h.state.portalSession,user:{...h.state.portalSession.user,employeeNumber:'E2'}};h.context.syncXoffiImport();h.state.data={otherActor:true};response.resolve(applied());await pending;
 assert.equal(h.state.data.otherActor,true);assert.equal(h.toasts.length,0);
 const retry=harness();retry.open();retry.load(preview());retry.setApi(async()=>{throw new Error('Vollständige Bereichsdatei erforderlich.');});await retry.context.applyXoffiImport({preventDefault(){}});
 assert.equal(retry.elements.xoffiImportStatus.textContent,'Vollständige Bereichsdatei erforderlich.');assert.equal(retry.elements.xoffiApplyButton.disabled,false);
 assert.equal(retry.elements.xoffiImportConfirmed.disabled,false);
});
test('Plan-Ist names the exact valuation gap, counts only complete comparisons and explains separate weekly evidence in expanded days',()=>{
 const source=preview().employees[0],dates=source.days.map(day=>day.workDate),limits=thresholds();
 const input={dates,limits,departmentId:7,employees:[{personnel_number:'E1',full_name:'Mara Beispiel'}],shifts:[],
  imports:[{employee_number:'E1',department_id:7,import_id:'exact',week_start:dates[0],week_end:dates[6],weekly_actual_minutes:1500,weekly_valued_minutes:2460,weekly_surcharge_minutes:0}],
  importDays:source.days.map(day=>({employee_number:'E1',import_id:'exact',work_date:day.workDate,actual_minutes:day.actualMinutes,valued_minutes:day.valuedMinutes,surcharge_minutes:day.surchargeMinutes})),
  importSnapshots:[{employeeNumber:'E1',importId:'exact',weekStart:dates[0],snapshot:createReviewedXoffiSnapshot(source.snapshot,source)}]};
 const full=buildComparison(input)[0],partial=combineComparisons([[full]],dates.slice(0,5),limits)[0];
 const context=vm.createContext({xoffiComparisonMode:'valued',window:{GpXoffiImport:presentation},elements:{xoffiComparisonList:{innerHTML:'',querySelectorAll:()=>[]},xoffiComparisonGreen:{},xoffiComparisonYellow:{},xoffiComparisonSave:{},xoffiComparisonStatus:{}},
  updateXoffiComparisonControls(){},formatHours:value=>(value/60).toFixed(2),formatDate:value=>value,formatTimeDifference:value=>String(value),escapeHtml:String,escapeHtmlAttribute:String});
 vm.runInContext(['xoffiDisplayComparison','xoffiDifference','xoffiComparisonCells','xoffiComparisonLabel','renderXoffiPersonDays','renderXoffiComparison'].map(functionSource).join('\n'),context);
 const shown=context.xoffiDisplayComparison(partial);assert.equal(shown.actualMinutes,1980);assert.equal(shown.comparisonComplete,false);
 assert.equal(context.xoffiComparisonLabel(shown),'Wochenposten nicht im Zeitraum zuordenbar');
 context.renderXoffiComparison({employees:[partial],limits,dateFrom:dates[0],dateTo:dates[4]});
 assert.match(context.elements.xoffiComparisonList.innerHTML,/Vergleich vollständig<\/span><strong>0/);assert.doesNotMatch(context.elements.xoffiComparisonList.innerHTML,/Nicht importiert/);
 const content={innerHTML:''},details={open:true,dataset:{xoffiPerson:'E1'},querySelector:()=>content};context.renderXoffiPersonDays(details);
 assert.match(content.innerHTML,/8 h belegte Feiertagsstunden/);assert.match(content.innerHTML,/Gesicherte Tagesbewertungen im Zeitraum: 33 h/);
 input.importSnapshots=[];const missing=buildComparison(input)[0];assert.equal(context.xoffiComparisonLabel(context.xoffiDisplayComparison(missing)),'Bewertung ohne bestätigten Wochennachweis');
 context.xoffiComparisonMode='presence';assert.equal(context.xoffiDisplayComparison(partial).comparisonComplete,true);
});
test('real import dialog declares a named workspace and scope-changing shell paths invalidate pending work',()=>{
 const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8');assert.match(html,/<dialog[^>]*id="xoffiImportDialog"[^>]*data-gp-window-mode="workspace"[^>]*aria-labelledby="xoffiImportTitle"/);
 for(const name of ['showLoginGate','loadAll','loadPlanningPeriod','render','syncGpWindows'])assert.match(functionSource(name),/syncXoffiImport\(\)/);
});

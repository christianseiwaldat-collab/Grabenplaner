'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {inspectXoffiMhtmlBuffer,matchEmployee}=require('../lib/xoffi-mhtml-import');
const {fixtureHtml,holidayFixtureHtml,mhtml}=require('../test-support/xoffi-mhtml');
const {createReviewedXoffiSnapshot,XoffiWeekReconciliationError}=require('../lib/xoffi-week-reconciliation');
function extract(file,name){const source=fs.readFileSync(require.resolve(file),'utf8').replace(/\r\n/g,'\n');const start=source.indexOf('function '+name+'('),end=source.indexOf('\n}\n',start);assert.ok(start>=0&&end>start);return source.slice(start,end+3);}
function validation(){const context=vm.createContext({createReviewedXoffiSnapshot,XoffiWeekReconciliationError,httpError:(status,message,code)=>Object.assign(new Error(message),{status,code}),addDays:(date,count)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+count);return d.toISOString().slice(0,10);}});vm.runInContext(['xoffiInteger','validateXoffiReviewedRows'].map(name=>extract('../server.js',name)).join('\n'),context);return context.validateXoffiReviewedRows;}
function preview(){const employees=[{personnel_number:'1',full_name:'Mara Beispiel'}];const result=inspectXoffiMhtmlBuffer(mhtml(fixtureHtml({name:'Mara Beispiel'})+fixtureHtml({name:'Nicht im Team'})),{fileName:'review.mhtml',employees});result.candidates=[{employeeNumber:'1'}];return result;}
test('additional given name suggests only one complete GP name, exact matches win and ambiguous names remain unassigned',()=>{
 const employees=[{personnel_number:'1',full_name:'Mara Beispiel'}];
 assert.equal(matchEmployee('Beispiel Mara Anna',employees),'1');
 assert.equal(matchEmployee('Beispiel Anna',employees),'');
 assert.equal(matchEmployee('Mara',employees),'');
 assert.equal(matchEmployee('Beispiel Mara Anna',[...employees,{personnel_number:'2',full_name:'Mara Anna Beispiel'}]),'2');
 assert.equal(matchEmployee('Beispiel Mara Anna',[...employees,{personnel_number:'2',full_name:'Anna Beispiel'}]),'');
});
test('unmatched import rows require an explicit exclusion, never a silent omission',()=>{
 const value=preview(),validate=validation();
 assert.throws(()=>validate(value.employees,value),{code:'XOFFI_EMPLOYEE_MAPPING_INVALID'});
 const rows=[value.employees[0],{sourceName:value.employees[1].sourceName,employeeNumber:'',excluded:true}];
 const accepted=validate(rows,value);assert.equal(accepted.length,1);assert.equal(accepted[0].employeeNumber,'1');assert.equal(accepted[0].snapshot.kind,'mhtml');
 assert.throws(()=>validate([value.employees[0]],value),{code:'XOFFI_REVIEW_INVALID'});
 assert.throws(()=>validate(rows.map(row=>({sourceName:row.sourceName,excluded:true})),value),{code:'XOFFI_REVIEW_INVALID'});
 assert.throws(()=>validate([rows[0],{...rows[1],sourceName:'changed'}],value),{code:'XOFFI_EMPLOYEE_MAPPING_INVALID'});
});
test('invalid source rows cannot be repaired by client values or silently omitted, only explicitly excluded',()=>{
 const value=inspectXoffiMhtmlBuffer(mhtml(fixtureHtml({name:'Mara Beispiel'})+fixtureHtml({name:'Andere Beispiel'}).replace('Gesamt: 8.50','missing')));
 value.candidates=[{employeeNumber:'1'},{employeeNumber:'2'}];
 const rows=structuredClone(value.employees);rows[0].employeeNumber='1';rows[1]={...rows[0],sourceName:value.employees[1].sourceName,employeeNumber:'2',reviewStatus:'valid'};
 const validate=validation();
 assert.throws(()=>validate(rows,value),{code:'XOFFI_SOURCE_ROW_INVALID'});
 assert.throws(()=>validate(rows.slice(0,1),value),{code:'XOFFI_REVIEW_INVALID'});
 rows[1]={sourceName:value.employees[1].sourceName,employeeNumber:'',excluded:true};
 const accepted=validate(rows,value);assert.equal(accepted.length,1);assert.equal(accepted[0].employeeNumber,'1');
 assert.throws(()=>validate(rows.map(row=>({sourceName:row.sourceName,employeeNumber:'',excluded:true})),value),{code:'XOFFI_REVIEW_INVALID'});
});
test('review reconciliation retains immutable source facts, rejects client holiday changes, and recomputes after daily corrections',()=>{
 const value=inspectXoffiMhtmlBuffer(mhtml(holidayFixtureHtml({name:'Mara Beispiel'})),{employees:[{personnel_number:'1',full_name:'Mara Beispiel'}]});
 value.candidates=[{employeeNumber:'1'}];const original=structuredClone(value.employees[0].snapshot),validate=validation();
 const rows=structuredClone(value.employees);rows[0].snapshot.weeklyHolidayMinutes=900;rows[0].weeklyHolidayMinutes=900;
 const accepted=validate(rows,value)[0];
 assert.equal(accepted.snapshot.weeklyHolidayMinutes,480);assert.equal(accepted.snapshot.reviewedWeek.valuationReconciliation.unallocatedHolidayMinutes,480);
 for(const key of Object.keys(original))assert.deepEqual(accepted.snapshot[key],original[key]);
 assert.deepEqual(value.employees[0].snapshot,original);
 rows[0].days[5].valuedMinutes=480;
 const corrected=validate(rows,value)[0];assert.equal(corrected.snapshot.reviewedWeek.valuationReconciliation.unallocatedHolidayMinutes,0);
 assert.equal(corrected.snapshot.valuationReconciliation.unallocatedHolidayMinutes,480);
 rows[0].weeklyValuedMinutes+=60;assert.throws(()=>validate(rows,value),{code:'XOFFI_REVIEW_INVALID'});
 const embedded=inspectXoffiMhtmlBuffer(mhtml(holidayFixtureHtml({name:'Mara Beispiel',dailyHolidayHours:'8.00'})),{employees:[{personnel_number:'1',full_name:'Mara Beispiel'}]});
 embedded.candidates=value.candidates;const increased=structuredClone(embedded.employees);increased[0].weeklyValuedMinutes+=480;
 assert.throws(()=>validate(increased,embedded),{code:'XOFFI_REVIEW_INVALID'});
 const legacy=preview();delete legacy.employees[0].snapshot.valuationReconciliation;delete legacy.employees[0].snapshot.weeklyHolidayMinutes;
 const legacyRows=[legacy.employees[0],{sourceName:legacy.employees[1].sourceName,excluded:true}];
 assert.equal(validate(legacyRows,legacy)[0].snapshot.reviewedWeek.valuationReconciliation.unallocatedHolidayMinutes,0);
});
test('the import UI identifies missing, duplicate, and explicitly excluded mappings before submission',()=>{
 const rows=['1',''].map((value,index)=>({dataset:{sourceName:'Person '+index},input:{value,setAttribute(name,value){this[name]=value;}},querySelector(){return this.input;}}));
 const context=vm.createContext({elements:{xoffiImportPreview:{querySelectorAll:()=>rows}}});vm.runInContext(extract('../public/app.js','xoffiMappingIssue'),context);
 const missing=context.xoffiMappingIssue();assert.match(missing,/Import noch nicht möglich/);assert.match(missing,/Diese Zeile nicht übernehmen/);assert.match(missing,/Person 1/);assert.equal(rows[1].input['aria-invalid'],'true');
 rows[1].input.value='1';assert.match(context.xoffiMappingIssue(),/mehrfach/);
 rows[1].input.value='__skip__';assert.equal(context.xoffiMappingIssue(),'');
 rows[0].input.value='__skip__';assert.match(context.xoffiMappingIssue(),/mindestens ein/);
});
test('the accessible blocker follows current mappings, explicit exclusions and renewed mapping errors',()=>{
 const source=fs.readFileSync(require.resolve('../public/gp-xoffi-import.js'),'utf8');
 assert.match(source,/class="xoffi-import-blocker" role="alert" aria-atomic="true" data-xoffi-mapping-blocker hidden/);
 const rows=['1',''].map((value,index)=>({dataset:{sourceName:'Person '+index},input:{value,setAttribute(name,value){this[name]=value;}},querySelector(){return this.input;}}));
 const message={textContent:''},blocker={hidden:true,querySelector:()=>message};
 const elements={xoffiApplyButton:{disabled:true},xoffiImportConfirmed:{checked:true},xoffiImportStatus:{textContent:''},
  xoffiImportPreview:{querySelectorAll:()=>rows,querySelector:()=>blocker}};
 const context=vm.createContext({elements,state:{xoffiImportPreview:{}},xoffiPendingApply:null,xoffiInspectTicket:null,xoffiWeekConfirmationRequired:()=>false});
 vm.runInContext(['xoffiMappingIssue','updateXoffiApplyAvailability'].map(name=>extract('../public/app.js',name)).join('\n'),context);
 context.updateXoffiApplyAvailability();
 assert.equal(blocker.hidden,false);assert.equal(elements.xoffiApplyButton.disabled,true);
 assert.match(message.textContent,/Person 1/);assert.match(message.textContent,/Diese Zeile nicht übernehmen/);
 rows[1].input.value='2';context.updateXoffiApplyAvailability();
 assert.equal(blocker.hidden,true);assert.equal(message.textContent,'');assert.equal(elements.xoffiApplyButton.disabled,false);
 assert.equal(rows[1].input['aria-invalid'],'false');
 rows[1].input.value='';context.updateXoffiApplyAvailability();
 assert.equal(blocker.hidden,false);assert.match(message.textContent,/Person 1/);assert.equal(elements.xoffiApplyButton.disabled,true);
 rows[1].input.value='__skip__';context.updateXoffiApplyAvailability();
 assert.equal(blocker.hidden,true);assert.equal(message.textContent,'');assert.equal(elements.xoffiApplyButton.disabled,false);
 rows[0].input.value='';context.updateXoffiApplyAvailability();
 assert.equal(blocker.hidden,false);assert.match(message.textContent,/Person 0/);assert.doesNotMatch(message.textContent,/Person 1/);
 assert.equal(rows[0].input['aria-invalid'],'true');assert.equal(elements.xoffiApplyButton.disabled,true);
 rows[0].input.value='1';rows[1].input.value='1';context.updateXoffiApplyAvailability();
 assert.equal(blocker.hidden,false);assert.match(message.textContent,/mehrfach/);assert.equal(elements.xoffiApplyButton.disabled,true);
});

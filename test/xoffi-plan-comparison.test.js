"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { thresholds, deviation, buildComparison, combineComparisons, selectImports } = require('../lib/xoffi-plan-comparison');
const { inspectXoffiMhtmlBuffer } = require('../lib/xoffi-mhtml-import');
const { createReviewedXoffiSnapshot } = require('../lib/xoffi-week-reconciliation');
const { holidayFixtureHtml, mhtml } = require('../test-support/xoffi-mhtml');
const limits = thresholds();

test('signed deviation uses net plan as denominator and inclusive 5/15 boundaries', () => {
  assert.deepEqual(deviation(1000,1230,limits), {differenceMinutes:230,percent:23,severity:'red'});
  assert.deepEqual(deviation(1000,770,limits), {differenceMinutes:-230,percent:-23,severity:'red'});
  assert.equal(deviation(1000,1050,limits).severity,'green');
  assert.equal(deviation(1000,1150,limits).severity,'yellow');
  assert.equal(deviation(1000,1151,limits).severity,'red');
  assert.equal(deviation(1000,1230,{greenMax:25,yellowMax:30}).severity,'green');
});

test('zero plans and missing imports are distinct and never fabricate infinite percentages', () => {
  assert.deepEqual(deviation(0,60,limits),{differenceMinutes:60,percent:null,severity:'unplanned'});
  assert.equal(deviation(0,0,limits).severity,'green');
  assert.equal(deviation(60,null,limits).severity,'missing');
});

test('invalid thresholds cannot be saved', () => {
  for (const value of [{greenMax:-1,yellowMax:15},{greenMax:15,yellowMax:5},
    {greenMax:5,yellowMax:5},{greenMax:5,yellowMax:Infinity},{greenMax:'5',yellowMax:15},null]) {
    assert.throws(()=>thresholds(value));
  }
});

function fixture() {
  const dates = Array.from({length:7},(_,i)=>`2026-09-${14+i}`);
  return { dates, limits, departmentId:7, employees:[{personnel_number:'412',full_name:'Testperson'}],
    shifts:[{employee_number:'412',shift_date:dates[0],raw_minutes:1030,break_minutes:30}],
    imports:[{employee_number:'412',department_id:7,import_id:'new',use_as_actual:1}],
    importDays:dates.map((date,i)=>({employee_number:'412',import_id:'new',work_date:date,
      actual_minutes:i===0?1230:0,valued_minutes:i===0?1300:0,intervals_json:'[]'})) };
}

test('weekly and daily comparison exclude pauses and xoffi valuation bonuses', () => {
  const row = buildComparison(fixture())[0];
  assert.equal(row.plannedMinutes,1000); assert.equal(row.actualMinutes,1230);
  assert.equal(row.valuedMinutes,1300);assert.equal(row.percent,23);assert.equal(row.severity,'red');
  assert.equal(row.days[0].percent,23);assert.equal(row.days[1].percent,0);
});

test('partial week remains incomplete, superseded rows are ignored', () => {
  const input = fixture(); input.importDays.pop();
  input.importDays.push({employee_number:'412',import_id:'old',work_date:input.dates[6],actual_minutes:500});
  const row = buildComparison(input)[0];
  assert.equal(row.importState,'incomplete');assert.equal(row.actualMinutes,null);assert.equal(row.percent,null);
});

test('historical imports stay visible, unrelated branch people do not leak into department', () => {
  const input=fixture();input.imports.push({employee_number:'999',source_name:'Other department',department_id:null,import_id:'hidden'});
  input.imports.push({employee_number:'413',source_name:'Former team member',department_id:7,import_id:'historic'});
  const rows=buildComparison(input);assert.deepEqual(rows.map(r=>r.employeeNumber),['412','413']);
});

test('incompatible import scopes remain visible without misleading red or green percentages', () => {
  const input=fixture();input.imports[0].department_id=null;
  const row=buildComparison(input)[0];assert.equal(row.actualMinutes,1230);assert.equal(row.percent,null);assert.equal(row.severity,'scope');
});

function holidayComparison(weeklyValuedHours = '41.00') {
  const original=inspectXoffiMhtmlBuffer(mhtml(holidayFixtureHtml({weeklyValuedHours}))).employees[0];
  const input=fixture();input.dates=original.days.map(day=>day.workDate);input.shifts=[];
  input.imports=[{...input.imports[0],week_start:input.dates[0],week_end:input.dates[6],
    weekly_actual_minutes:original.weeklyActualMinutes,weekly_valued_minutes:original.weeklyValuedMinutes,weekly_surcharge_minutes:original.weeklySurchargeMinutes}];
  input.importDays=original.days.map(day=>({employee_number:'412',import_id:'new',work_date:day.workDate,
    actual_minutes:day.actualMinutes,valued_minutes:day.valuedMinutes,surcharge_minutes:day.surchargeMinutes,absence_code:day.absence,intervals_json:JSON.stringify(day.intervals)}));
  input.importSnapshots=[{employeeNumber:'412',importId:'new',weekStart:input.dates[0],snapshot:createReviewedXoffiSnapshot(original.snapshot,original)}];
  return input;
}
test('verified holiday credits affect the whole week only, never attendance or a fabricated day',()=>{
  const input=holidayComparison(),row=buildComparison(input)[0];
  assert.equal(row.actualMinutes,1500);assert.equal(row.valuedMinutes,2460);assert.equal(row.knownDailyValuedMinutes,1980);
  assert.equal(row.unallocatedHolidayMinutes,480);assert.equal(row.valuationAllocationIncomplete,false);
  assert.equal(row.days[5].valuedMinutes,0);assert.equal(row.days[5].actualMinutes,0);assert.deepEqual(row.days[5].intervals,[]);
  assert.equal(row.days[3].absence,'vacation');assert.equal(row.weeklyCredits[0].status,'verified');
  const combined=combineComparisons([[row],[row]],input.dates,limits)[0];
  assert.equal(combined.valuedMinutes,2460);assert.equal(combined.unallocatedHolidayMinutes,480);assert.equal(combined.weeklyCredits.length,1);
  const partial=combineComparisons([[row]],input.dates.slice(0,5),limits)[0];
  assert.equal(partial.actualMinutes,1500);assert.equal(partial.knownDailyValuedMinutes,1980);assert.equal(partial.valuedMinutes,null);
  assert.equal(partial.valuationAllocationIncomplete,true);assert.equal(partial.valuedComparison.percent,null);assert.equal(partial.valuedComparison.severity,'missing');
  const next=combineComparisons([[row]],['2026-09-14'],limits)[0];assert.equal(next.weeklyCredits.length,0);assert.equal(next.unallocatedHolidayMinutes,0);
});
test('unbound, missing or stale weekly proofs never leak a credit or silently produce a complete daily-only sum',()=>{
  for(const mutate of [input=>{input.importSnapshots=[];},input=>{input.importSnapshots[0].importId='foreign';},
    input=>{input.importSnapshots[0].employeeNumber='999';},input=>{input.importSnapshots[0].weekStart='2026-08-31';},
    input=>{input.importSnapshots[0].snapshot.balanceDate='2026-08-30';},
    input=>{delete input.importSnapshots[0].snapshot.reviewedWeek;},
    input=>{input.importSnapshots[0].snapshot.reviewedWeek.weeklyValuedMinutes+=1;},
    input=>{input.importDays[0].valued_minutes+=60;},
    input=>{input.importSnapshots[0].snapshot.weeklyHolidayMinutes=900;},]){
    const input=holidayComparison();mutate(input);const row=buildComparison(input)[0];
    assert.equal(row.valuedMinutes,null);assert.equal(row.unallocatedHolidayMinutes,0);assert.equal(row.valuationAllocationIncomplete,true);
    assert.equal(row.valuedComparison.percent,null);assert.equal(row.weeklyCredits[0].minutes,null);assert.equal(row.weeklyCredits[0].status,'unknown');
  }
  const legacy=holidayComparison();legacy.importSnapshots=[];legacy.imports[0].weekly_valued_minutes=1980;
  assert.equal(buildComparison(legacy)[0].valuedMinutes,1980);
});
test('reviewed rounding is carried once at week level while a scoped mismatch suppresses every percentage',()=>{
  const input=holidayComparison('41.12'),row=buildComparison(input)[0];
  assert.equal(row.valuedMinutes,2467);assert.equal(row.unallocatedHolidayMinutes,480);assert.equal(row.knownDailyValuedMinutes,1980);
  assert.equal(row.weeklyCredits[0].roundingDifferenceMinutes,7);
  input.imports[0].department_id=null;
  const scoped=buildComparison(input)[0];assert.equal(scoped.valuedMinutes,2467);
  for(const value of [scoped,scoped.valuedComparison,scoped.presenceComparison]){assert.equal(value.percent,null);assert.equal(value.severity,'scope');}
  assert.equal(scoped.days[0].valuedComparison.severity,'scope');
});
test('snapshot selection uses exactly the ordered applicable import and excludes unrelated branch-wide people',()=>{
  const input=fixture();input.imports.push({...input.imports[0],import_id:'old'},
    {employee_number:'999',department_id:null,import_id:'private-other'},
    {employee_number:'413',department_id:7,import_id:'former'});
  assert.deepEqual(selectImports(input).map(row=>row.import_id),['new','former']);
});


test('new comparison and settings endpoints retain the installation feature gate', () => {
  const fs=require('node:fs'), vm=require('node:vm');
  const source=fs.readFileSync(require.resolve('../server.js'),'utf8').replace(/\r\n/g,'\n');
  const start=source.indexOf('function installationFeaturesForApiPath('), end=source.indexOf('\n}\n',start)+3;
  const context=vm.createContext({});vm.runInContext(source.slice(start,end),context);
  assert.ok(context.installationFeaturesForApiPath('/portal/v1/xoffi-plan-comparison').includes('timeTracking'));
  assert.ok(context.installationFeaturesForApiPath('/portal/v1/xoffi-plan-comparison/settings').includes('timeTracking'));
});

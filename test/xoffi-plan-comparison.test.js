"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { thresholds, deviation, buildComparison } = require('../lib/xoffi-plan-comparison');
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


test('new comparison and settings endpoints retain the installation feature gate', () => {
  const fs=require('node:fs'), vm=require('node:vm');
  const source=fs.readFileSync(require.resolve('../server.js'),'utf8').replace(/\r\n/g,'\n');
  const start=source.indexOf('function installationFeaturesForApiPath('), end=source.indexOf('\n}\n',start)+3;
  const context=vm.createContext({});vm.runInContext(source.slice(start,end),context);
  assert.ok(context.installationFeaturesForApiPath('/portal/v1/xoffi-plan-comparison').includes('timeTracking'));
  assert.ok(context.installationFeaturesForApiPath('/portal/v1/xoffi-plan-comparison/settings').includes('timeTracking'));
});

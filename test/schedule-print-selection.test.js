'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {selectSchedulePrintEmployees}=require('../lib/schedule-print-selection');
const {zoomPercent,ZOOM_PERCENTAGES}=require('../public/sales-article-report-pdf-preview');

test('print selection only narrows the authorized snapshot, including related shifts, absences and counts',()=>{
 const employees=[{personnel_number:'420',nickname:'Example A'},{personnel_number:'434',nickname:'Example B'}];
 const schedule={employees,shifts:[{employee_number:'420'},{employee_number:'434'}],weekOptions:[{employee_number:'434'}],staffAssignments:[{employee_number:'434'}],pdfStaffAssignmentShifts:[{employee_number:'434'}],sicknessCredits:[{employeeNumber:'434'}],totals:{420:20,434:32}};
 const before=JSON.stringify(schedule),selected=selectSchedulePrintEmployees(schedule,'420,999999,420');
 assert.deepEqual(selected.employees,[employees[0]]);assert.deepEqual(selected.shifts,[schedule.shifts[0]]);
 for(const key of ['weekOptions','staffAssignments','pdfStaffAssignmentShifts','sicknessCredits'])assert.deepEqual(selected[key],[]);
 assert.deepEqual(selected.totals,{420:20});assert.equal(JSON.stringify(schedule),before,'Printing never changes active status or planning data');
 assert.equal(selectSchedulePrintEmployees(schedule,undefined),schedule,'Absent selection preserves existing exports');
 for(const value of ['',',','999999','420,',[],{number:'420'},'x'.repeat(16001)])assert.throws(()=>selectSchedulePrintEmployees(schedule,value),{status:400,code:'SCHEDULE_PRINT_EMPLOYEES_INVALID'});
});

test('shared PDF zoom supports requested presets and decimal custom percentages with explicit bounds',()=>{
 for(const percent of [50,60,80,90,100,150])assert.ok(ZOOM_PERCENTAGES.includes(percent));
 for(const [input,result] of [['10',10],['400',400],['73.5',73.5],['73,5',73.5],[' 90 ',90]])assert.equal(zoomPercent(input),result);
 for(const value of ['',null,undefined,'9','401','Infinity','1e2','-50','70%','99.999'])assert.equal(zoomPercent(value),null);
});

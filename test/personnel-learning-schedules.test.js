"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {normalizeSchedule,addMonths,reminder,receipt,projection}=require("../lib/personnel-learning-schedules");
test("schedule rejects impossible dates and clamps month-end recurrence",()=>{
  assert.throws(()=>normalizeSchedule({dueDate:"2026-02-29"}));
  assert.throws(()=>normalizeSchedule({repeatEveryMonths:2}));
  assert.throws(()=>normalizeSchedule({remindDaysBefore:61}));
  assert.equal(addMonths("2024-02-29",12),"2025-02-28");
  assert.equal(addMonths("2026-01-31",1),"2026-02-28");
  assert.equal(addMonths("2026-12-31",3),"2027-03-31");
});
test("internal reminders distinguish outstanding training from a future repeat",()=>{
  const schedule=normalizeSchedule({dueDate:"2026-09-20",repeatEveryMonths:12,remindDaysBefore:7});
  assert.equal(reminder(schedule,{today:"2026-09-12"}),null);
  assert.equal(reminder(schedule,{today:"2026-09-15"}).status,"soon");
  assert.equal(reminder(schedule,{today:"2026-09-20"}).status,"due");
  assert.equal(reminder(schedule,{today:"2026-09-21"}).status,"overdue");
  assert.equal(reminder(schedule,{today:"2026-09-21",completed:true}),null);
  assert.deepEqual(reminder(schedule,{today:"2027-09-21",completed:true}),{kind:"repeat",dueDate:"2027-09-20",daysRemaining:-1,status:"overdue"});
  assert.equal(reminder(schedule,{today:"2027-09-21",completed:true,hasSuccessor:true}),null);
  assert.equal(reminder(schedule,{today:"2027-09-21",active:false}),null);
});
test("schedule receipt detects changes to due date and run linkage",()=>{
  const row={assignmentId:"run:1",revisionNumber:1,payload:{...normalizeSchedule({dueDate:"2026-09-20"}),runNumber:2,previousAssignmentId:"run:0"},previousReceiptSha256:"",changedBy:"test",changedAt:"2026-09-15T12:00:00Z"};row.receiptSha256=receipt(row);
  assert.equal(projection(row).runNumber,2);
  assert.throws(()=>projection({...row,payload:{...row.payload,dueDate:"2026-09-21"}}));
});

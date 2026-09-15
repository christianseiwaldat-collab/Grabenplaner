"use strict";
const {canonicalSha256}=require("./work-rules/receipt");
function invalid(message) { throw Object.assign(new Error(message),{status:400,code:"PERSONNEL_LEARNING_SCHEDULE_INVALID"}); }
function date(value) {
  if(value===""||value===null||value===undefined)return "";
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<"2000-01-01"||value>"2200-12-31")invalid("Bitte ein gültiges Fälligkeitsdatum wählen.");
  const parsed=new Date(value+"T12:00:00Z");
  if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)invalid("Das Fälligkeitsdatum existiert nicht.");
  return value;
}
function normalizeSchedule(value={}) {
  if(!value||typeof value!=="object"||Array.isArray(value))invalid("Bitte eine gültige Schulungsplanung übermitteln.");
  const dueDate=date(value.dueDate),repeatEveryMonths=Number(value.repeatEveryMonths||0),remindDaysBefore=Number(value.remindDaysBefore??7);
  if(![0,1,3,6,12,24].includes(repeatEveryMonths)||!Number.isInteger(remindDaysBefore)||remindDaysBefore<0||remindDaysBefore>60)invalid("Wiederholung und Erinnerung liegen außerhalb des zulässigen Bereichs.");
  return {dueDate,repeatEveryMonths,remindDaysBefore};
}
function addMonths(value,months) {
  const [year,month,day]=date(value).split("-").map(Number);
  const first=new Date(Date.UTC(year,month-1+months,1,12));
  const last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0,12)).getUTCDate();
  first.setUTCDate(Math.min(day,last));return first.toISOString().slice(0,10);
}
function todayVienna() { return new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Vienna",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()); }
function reminder(schedule,{today=todayVienna(),completed=false,completedAt="",hasSuccessor=false,active=true}={}) {
  if(!schedule||!active)return null;
  let due= schedule.dueDate,kind="training";
  if(completed) {
    if(!schedule.repeatEveryMonths||hasSuccessor)return null;
    const anchor=due||String(completedAt).slice(0,10);if(!anchor)return null;
    due=addMonths(anchor,schedule.repeatEveryMonths);kind="repeat";
  }
  if(!due)return null;
  const days=Math.round((new Date(due+"T12:00:00Z")-new Date(date(today)+"T12:00:00Z"))/86400000);
  if(days>schedule.remindDaysBefore)return null;
  return {kind,dueDate:due,daysRemaining:days,status:days<0?"overdue":days===0?"due":"soon"};
}
function receipt(row) { return canonicalSha256({assignmentId:row.assignmentId,revisionNumber:row.revisionNumber,payload:row.payload,previousReceiptSha256:row.previousReceiptSha256,changedBy:row.changedBy,changedAt:row.changedAt}); }
function projection(row) {
  if(!row)return null;
  if(row.receiptSha256!==receipt(row))throw Object.assign(new Error("Die Schulungsplanung ist nicht vollständig überprüfbar."),{status:503,code:"PERSONNEL_LEARNING_SCHEDULE_HISTORY_INVALID"});
  return {...normalizeSchedule(row.payload),runNumber:Number(row.payload.runNumber||1),previousAssignmentId:String(row.payload.previousAssignmentId||""),revisionNumber:row.revisionNumber,receiptSha256:row.receiptSha256};
}
function publicSchedule(schedule) {
  return schedule ? {dueDate:schedule.dueDate,repeatEveryMonths:schedule.repeatEveryMonths,remindDaysBefore:schedule.remindDaysBefore} : null;
}
module.exports={normalizeSchedule,date,addMonths,todayVienna,reminder,receipt,projection,publicSchedule};

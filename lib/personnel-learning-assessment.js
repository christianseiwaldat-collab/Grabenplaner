"use strict";
const crypto = require("node:crypto");
const {stableJsonStringify} = require("./personnel-learning-catalog");
function fail(message, status=400) { throw Object.assign(new Error(message), {status,code:"PERSONNEL_LEARNING_ASSESSMENT_INVALID"}); }
function text(value,min,max) { if(typeof value!=="string" || value.trim().length<min || value.length>max || value.includes("\0")) fail("Prüfungstext oder Kennung ungültig."); return value.trim(); }
function normalizeAssessment(value) {
  if(value==null)return null;
  if(!value || typeof value!=="object" || Array.isArray(value))fail("Ungültige Prüfungsdefinition.");
  const questions=value.questions || [], passingPercent=Number(value.passingPercent??80), maxAttempts=Number(value.maxAttempts??3);
  if(!Array.isArray(questions)||questions.length>30 || !Number.isInteger(passingPercent)||passingPercent<1||passingPercent>100 || !Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>10)fail("Höchstens 30 Fragen, 1–10 Versuche und 1–100 Prozent Bestehensgrenze sind möglich.");
  const ids=new Set();
  const normalized=questions.map(q=>{
    const id=text(q.id,1,80),prompt=text(q.prompt,3,1000),points=Number(q.points??1);
    if(ids.has(id)||!Number.isInteger(points)||points<1||points>10||!Array.isArray(q.options)||q.options.length<2||q.options.length>6)fail("Frage, Punkte oder Antwortauswahl ungültig.");
    ids.add(id);const options=q.options.map(o=>({id:text(o.id,1,80),text:text(o.text,1,500)}));
    if(new Set(options.map(o=>o.id)).size!==options.length||!options.some(o=>o.id===q.correctOptionId))fail("Jede Frage benötigt genau eine richtige Antwort.");
    return {id,prompt,points,options,correctOptionId:q.correctOptionId};
  });
  if(!normalized.length&&!value.requireEvidence)return null;
  return {questions:normalized,passingPercent,maxAttempts,requireEvidence:value.requireEvidence===true};
}
function publicAssessment(value) { return value ? {...value,questions:value.questions.map(({correctOptionId,...q})=>q)} : null; }
function grade(assessment,answers) {
  if(!assessment?.questions.length || !answers || typeof answers!=="object" || Array.isArray(answers))fail("Bitte alle Prüfungsfragen beantworten.");
  if(Object.keys(answers).length!==assessment.questions.length)fail("Die Antworten passen nicht zu dieser Prüfung.");
  let points=0,total=0;
  for(const q of assessment.questions){const answer=answers[q.id];if(!q.options.some(o=>o.id===answer))fail("Bitte jede Frage mit einer gültigen Antwort beantworten.");total+=q.points;if(answer===q.correctOptionId)points+=q.points;}
  return {points,total,percent:Math.round(10000*points/total)/100,passed:points*100>=total*assessment.passingPercent};
}
const hash=value=>crypto.createHash("sha256").update(typeof value==="string"?value:stableJsonStringify(value)).digest("hex");
function receipt(row) { return hash({id:row.id,assignmentId:row.assignmentId,sequenceNumber:row.sequenceNumber,kind:row.kind,payload:row.payload,previousReceipt:row.previousReceipt,changedBy:row.changedBy,changedAt:row.changedAt}); }
function state(records,processReceipt) {
  let previous="",sequence=0,attempts=[],evidence=[];
  for(const row of records){if(row.sequenceNumber!==++sequence||row.previousReceipt!==previous||receipt(row)!==row.receiptSha256)fail("Die Prüfungshistorie ist nicht vollständig überprüfbar.",503);previous=row.receiptSha256;
    if(row.payload.processReceipt!==processReceipt)continue;
    if(row.kind==="exam_reset")attempts=[];
    if(row.kind==="exam_attempt")attempts.push(row);
    if(row.kind==="evidence")evidence.push(row);
    if(row.kind==="evidence_withdrawn")evidence=evidence.filter(e=>e.id!==row.payload.evidenceId);
  }
  return {attempts,evidence,lastSequence:sequence,lastReceipt:previous,passed:attempts.at(-1)?.payload.passed===true};
}
function assertCompletion(assessment,result,records,processReceipt) {
  if(!assessment || result!=="passed")return;
  const current=state(records,processReceipt);
  if(assessment.questions.length&&!current.passed)fail("Vor einem erfolgreichen Abschluss muss der Wissenstest bestanden sein.",409);
  if(assessment.requireEvidence&&!current.evidence.length)fail("Für den Abschluss fehlt der erforderliche Dateinachweis.",409);
}
module.exports={normalizeAssessment,publicAssessment,grade,hash,receipt,state,assertCompletion,fail};

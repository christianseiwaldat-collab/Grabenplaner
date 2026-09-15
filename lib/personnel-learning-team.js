"use strict";
const {normalizePersonnelLearningTemplateInput}=require("./personnel-learning-catalog");
const {hash}=require("./personnel-learning-assessment");
const {date,addMonths,todayVienna}=require("./personnel-learning-schedules");
function fail(message,status=400){throw Object.assign(new Error(message),{status,code:"PERSONNEL_LEARNING_REQUIREMENT_INVALID"});}
function normalize(value){
 if(!value||typeof value!=="object"||Array.isArray(value))fail("Ungültige Schulungsanforderung.");
 const title=String(value.title||"").trim(),type=String(value.type),moduleId=String(value.moduleId||""),minLevel=Number(value.minLevel??1),validMonths=Number(value.validMonths||0);
 if(title.length<3||title.length>160||!["skill","training"].includes(type)||!moduleId||moduleId.length>180||!Number.isInteger(minLevel)||minLevel<1||minLevel>10||!Number.isInteger(validMonths)||validMonths<0||validMonths>120)fail("Titel, Lernziel oder Gültigkeitsdauer ungültig.");
 const scope=normalizePersonnelLearningTemplateInput({moduleCode:"scope.validation",moduleType:"training",title:"Geltungsbereich",objective:"Geltungsbereich prüfen",estimatedMinutes:5,verificationMode:"trainer_confirmation",steps:[{stepId:"check",title:"Prüfen",instruction:"Geltungsbereich prüfen",completionCriteria:"Geprüft",required:true}],scope:value.scope}).scope;
 const positionId=String(value.positionId||""),roleId=String(value.roleId||"");if(positionId.length>100||roleId.length>100)fail("Ungültige Zielgruppe.");
 return {title,type,moduleId,minLevel:type==="skill"?minLevel:1,validMonths,positionId,roleId,scope,active:value.active!==false};
}
function receipt(row){return hash({id:row.id,revision:row.revision,payload:row.payload,previousReceipt:row.previousReceipt,changedBy:row.changedBy,changedAt:row.changedAt});}
function rules(rows){const latest=new Map();for(const row of rows){const prev=latest.get(row.id);if(row.revision!==(prev?.revision||0)+1||row.previousReceipt!==(prev?.receiptSha256||"")||receipt(row)!==row.receiptSha256)fail("Anforderungshistorie nicht vollständig überprüfbar.",503);latest.set(row.id,row);}return [...latest.values()];}
function applies(rule,person){const p=rule.payload,s=p.scope;return p.active&&(!p.positionId||p.positionId===person.positionId)&&(!p.roleId||p.roleId===person.roleId)&&(s.type==="organization"||s.locationId===person.locationId&&(s.type!=="department"||Number(s.departmentId)===Number(person.departmentId)));}
function validity(changedAt,months,today){if(!months)return {status:"fulfilled",until:""};const until=addMonths(String(changedAt).slice(0,10),months),days=Math.round((Date.parse(until+"T12:00:00Z")-Date.parse(today+"T12:00:00Z"))/86400000);return {status:days<0?"expired":days<=30?"dueSoon":"fulfilled",until};}
function cell(rule,person,{competencies=[],trainings=[],today=todayVienna()}={}){
 if(!applies(rule,person))return {status:"notApplicable",actual:null};
 const target=rule.payload;date(today);
 if(target.type==="skill"){
  const found=competencies.find(c=>c.employeeNumber===person.employeeNumber&&c.moduleId===target.moduleId&&c.active);
  if(!found)return {status:"missing",actual:null};
  if(found.version!==target.moduleVersionNumber)return {status:"otherVersion",actual:found.level};
  if(found.level<target.minLevel)return {status:"lowerLevel",actual:found.level};
  return {...validity(found.changedAt,target.validMonths,today),actual:found.level};
 }
 const matching=trainings.filter(t=>t.employeeNumber===person.employeeNumber&&t.moduleId===target.moduleId&&t.version===target.moduleVersionNumber&&t.active).sort((a,b)=>b.changedAt.localeCompare(a.changedAt));
 const passed=matching.find(t=>t.result==="passed");if(passed)return validity(passed.changedAt,target.validMonths,today);
 return {status:matching.some(t=>["not_passed","follow_up_required"].includes(t.result))?"notPassed":matching.length?"inProgress":"missing"};
}
const labels={fulfilled:"Erfüllt",dueSoon:"Bald fällig",expired:"Abgelaufen",missing:"Fehlt",lowerLevel:"Stufe fehlt",otherVersion:"Andere Fassung",notPassed:"Nachschulung",inProgress:"In Durchführung",notApplicable:"Nicht erforderlich"};
function summarize(rows){const result={required:0,fulfilled:0,open:0,dueSoon:0};for(const row of rows)for(const c of row.cells){if(c.status==="notApplicable")continue;result.required++;if(["fulfilled","dueSoon"].includes(c.status))result.fulfilled++;else result.open++;if(c.status==="dueSoon")result.dueSoon++;}result.percent=result.required?Math.round(100*result.fulfilled/result.required):null;return result;}
function csv(payload){const quote=value=>'"'+String(value??"").replace(/^[\s\u0000-\u001f]*[=+@-]/,"'$&").replace(/"/g,'""')+'"';const lines=[["Personalnummer","Name","Filiale","Position","Rolle",...payload.rules.map(r=>r.payload.title)]];for(const p of payload.people)lines.push([p.employeeNumber,p.fullName,p.locationName,p.positionName,p.roleName,...p.cells.map(c=>labels[c.status]+(c.actual!=null?` (Ist ${c.actual})`:"")+(c.until?` bis ${c.until}`:""))]);return "\uFEFF"+lines.map(row=>row.map(quote).join(';')).join('\r\n');}
module.exports={normalize,receipt,rules,applies,cell,summarize,csv,labels};

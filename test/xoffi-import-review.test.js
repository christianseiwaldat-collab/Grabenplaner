'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {inspectXoffiMhtmlBuffer,matchEmployee}=require('../lib/xoffi-mhtml-import');
const {fixtureHtml,mhtml}=require('../test-support/xoffi-mhtml');
function extract(file,name){const source=fs.readFileSync(require.resolve(file),'utf8').replace(/\r\n/g,'\n');const start=source.indexOf('function '+name+'('),end=source.indexOf('\n}\n',start);assert.ok(start>=0&&end>start);return source.slice(start,end+3);}
function validation(){const context=vm.createContext({httpError:(status,message,code)=>Object.assign(new Error(message),{status,code}),addDays:(date,count)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+count);return d.toISOString().slice(0,10);}});vm.runInContext(['xoffiInteger','validateXoffiReviewedRows'].map(name=>extract('../server.js',name)).join('\n'),context);return context.validateXoffiReviewedRows;}
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
test('the import UI identifies missing, duplicate, and explicitly excluded mappings before submission',()=>{
 const rows=['1',''].map((value,index)=>({dataset:{sourceName:'Person '+index},input:{value,setAttribute(name,value){this[name]=value;}},querySelector(){return this.input;}}));
 const context=vm.createContext({elements:{xoffiImportPreview:{querySelectorAll:()=>rows}}});vm.runInContext(extract('../public/app.js','xoffiMappingIssue'),context);
 assert.match(context.xoffiMappingIssue(),/Person 1/);assert.equal(rows[1].input['aria-invalid'],'true');
 rows[1].input.value='1';assert.match(context.xoffiMappingIssue(),/mehrfach/);
 rows[1].input.value='__skip__';assert.equal(context.xoffiMappingIssue(),'');
 rows[0].input.value='__skip__';assert.match(context.xoffiMappingIssue(),/mindestens ein/);
});

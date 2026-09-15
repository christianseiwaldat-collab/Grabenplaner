"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),A=require("../lib/personnel-learning-assessment");
test("assessment grading rejects omitted or injected answers and uses exact pass threshold",()=>{
 const quiz=A.normalizeAssessment({passingPercent:67,questions:[1,2,3].map(i=>({id:String(i),prompt:"Eine Frage",points:1,options:[{id:"a",text:"Ja"},{id:"b",text:"Nein"}],correctOptionId:"a"}))});
 assert.equal(A.grade(quiz,{1:"a",2:"a",3:"b"}).passed,false);
 assert.equal(A.grade(quiz,{1:"a",2:"a",3:"a"}).passed,true);
 assert.throws(()=>A.grade(quiz,{1:"a",2:"a"}));assert.throws(()=>A.grade(quiz,{1:"a",2:"a",3:"hacker"}));
 assert.equal(JSON.stringify(A.publicAssessment(quiz)).includes("correctOptionId"),false);
 assert.throws(()=>A.normalizeAssessment({...quiz,questions:[quiz.questions[0],quiz.questions[0]]}));
});

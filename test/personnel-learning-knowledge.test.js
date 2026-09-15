"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {normalizeKnowledgeArticle}=require("../lib/personnel-learning-knowledge");
const {normalizePersonnelLearningTemplateInput}=require("../lib/personnel-learning-catalog");
const {drafts}=require("../public/learning-library");
test("knowledge materials retain literal text and validate bounds, category and type",()=>{
  assert.deepEqual(normalizeKnowledgeArticle({category:" Kassa ",body:"<script>literal</script>\r\nText"}),{category:"Kassa",body:"<script>literal</script>\nText"});
  for(const article of [{category:"",body:"Ausreichend lang"},{category:"Kassa",body:"x"},{category:"Kassa",body:"x".repeat(20001)}])assert.throws(()=>normalizeKnowledgeArticle(article));
  const training=require("../public/personnel-learning-presets").training;
  assert.throws(()=>normalizePersonnelLearningTemplateInput({...training,scope:{type:"organization"},article:{category:"Kassa",body:"Ein Wissenstext"}}),{code:"PERSONNEL_LEARNING_KNOWLEDGE_INVALID"});
});
test("three initial knowledge drafts consist of confirmed cash business rules",()=>{
  assert.equal(drafts.length,3);
  for(const draft of drafts)assert.doesNotThrow(()=>normalizeKnowledgeArticle(draft));
  assert.match(drafts[0].body,/Anzahlungsartikels 98/);
  assert.match(drafts[1].body,/RohertragDM/);
  assert.match(drafts[2].body,/75 Euro/);
});

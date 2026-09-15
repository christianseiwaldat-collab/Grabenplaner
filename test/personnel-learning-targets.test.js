"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { normalizePersonnelLearningTemplateInput } = require("../lib/personnel-learning-catalog");
const { normalizePersonnelLearningSkillInput } = require("../lib/personnel-learning-skills");
const { normalizeLearningTarget, assertTargetTrainerBindings } = require("../lib/personnel-learning-targets");
const presets = require("../public/personnel-learning-presets");
const target = {skillModuleId:"skill:kassa",skillVersionNumber:1,targetLevel:4,minimumTrainerLevel:8};
test("Kassa pilot provides complete editable training and ten assessable skill levels", () => {
  const scope = {type:"organization"};
  const training = normalizePersonnelLearningTemplateInput({...presets.training, scope, learningTarget:target});
  const skill = normalizePersonnelLearningSkillInput({...presets.skill, scope});
  assert.equal(skill.content.levelDefinitions.length, 10);
  assert.equal(training.content.steps.length, 7);
  assert.deepEqual(training.content.learningTarget, target);
  assert.throws(() => normalizePersonnelLearningTemplateInput({...presets.training,scope,learningTarget:target,verificationMode:"self_confirmation"}), {code:"PERSONNEL_LEARNING_TARGET_INVALID"});
  assert.equal(Object.hasOwn(normalizePersonnelLearningTemplateInput({...presets.training,scope}).content,"learningTarget"), false, "Historical content remains byte compatible");
});
test("target validates explicit level and exact trainer qualification version", () => {
  assert.throws(()=>normalizeLearningTarget({...target,minimumTrainerLevel:3}));
  const binding={skillModuleId:target.skillModuleId,skillVersionNumber:1,competencyLevel:8};
  assert.doesNotThrow(()=>assertTargetTrainerBindings(target,[binding]));
  for(const bindings of [[],[{...binding,skillModuleId:"other"}],[{...binding,skillVersionNumber:2}],[{...binding,competencyLevel:7}]]) assert.throws(()=>assertTargetTrainerBindings(target,bindings));
});

"use strict";
function targetError(message) {
  return Object.assign(new Error(message), { code: "PERSONNEL_LEARNING_TARGET_INVALID", status: 400 });
}
function normalizeLearningTarget(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw targetError("Bitte eine gültige Zielkompetenz auswählen.");
  const skillModuleId = String(value.skillModuleId || "").trim();
  const skillVersionNumber = Number(value.skillVersionNumber);
  const targetLevel = Number(value.targetLevel), minimumTrainerLevel = Number(value.minimumTrainerLevel);
  if (!skillModuleId || skillModuleId.length > 180 || skillModuleId.includes("\0")
    || !Number.isSafeInteger(skillVersionNumber) || skillVersionNumber < 1
    || !Number.isInteger(targetLevel) || targetLevel < 1 || targetLevel > 10
    || !Number.isInteger(minimumTrainerLevel) || minimumTrainerLevel < targetLevel || minimumTrainerLevel > 10) {
    throw targetError("Zielstufe und Trainer-Mindeststufe müssen zwischen 1 und 10 liegen; die Trainerstufe darf nicht unter der Zielstufe liegen.");
  }
  return Object.freeze({ skillModuleId, skillVersionNumber, targetLevel, minimumTrainerLevel });
}
function assertTargetTrainerBindings(target, bindings) {
  if (!target) return;
  if (!bindings.length || bindings.some(b => b.skillModuleId !== target.skillModuleId
    || b.skillVersionNumber !== target.skillVersionNumber || b.competencyLevel < target.minimumTrainerLevel)) {
    throw targetError("Alle zugewiesenen Trainer benötigen die freigegebene Fähigkeit in der gebundenen Fassung und mindestens die festgelegte Trainerstufe.");
  }
}
module.exports = { normalizeLearningTarget, assertTargetTrainerBindings };

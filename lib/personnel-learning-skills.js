"use strict";

const {
  PersonnelLearningCatalogError,
  buildPersonnelLearningModuleState,
  normalizePersonnelLearningScope,
  normalizePersonnelLearningTags,
  normalizePersonnelLearningText,
  normalizedModuleCode,
} = require("./personnel-learning-catalog");

const PERSONNEL_LEARNING_SKILL_ENTITY = "skill";
const PERSONNEL_LEARNING_SKILL_LEVEL_COUNT = 10;

function invalid(code, message) {
  throw new PersonnelLearningCatalogError(code, message);
}

function plainRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedLevelDefinitions(value) {
  if (!Array.isArray(value) || value.length !== PERSONNEL_LEARNING_SKILL_LEVEL_COUNT) {
    invalid(
      "PERSONNEL_LEARNING_SKILL_LEVELS_INVALID",
      "Eine Fähigkeit benötigt genau zehn vollständig definierte Stufen.",
    );
  }
  return Object.freeze(value.map((entry, index) => {
    const expectedLevel = index + 1;
    if (!plainRecord(entry) || Number(entry.level) !== expectedLevel) {
      invalid(
        "PERSONNEL_LEARNING_SKILL_LEVELS_INVALID",
        `Die Fähigkeitsstufe ${expectedLevel} fehlt oder ist nicht korrekt gereiht.`,
      );
    }
    return Object.freeze({
      level: expectedLevel,
      label: normalizePersonnelLearningText(entry.label, {
        label: `Die Bezeichnung von Fähigkeitsstufe ${expectedLevel}`,
        min: 2,
        max: 80,
      }),
      description: normalizePersonnelLearningText(entry.description, {
        label: `Die Beschreibung von Fähigkeitsstufe ${expectedLevel}`,
        min: 3,
        max: 600,
        preserveWhitespace: true,
      }),
    });
  }));
}

function normalizePersonnelLearningSkillInput(value, { skillCode = null } = {}) {
  if (!plainRecord(value)) {
    invalid("PERSONNEL_LEARNING_SKILL_INVALID", "Bitte eine gültige Fähigkeit übermitteln.");
  }
  const content = Object.freeze({
    schemaVersion: 1,
    catalogEntity: PERSONNEL_LEARNING_SKILL_ENTITY,
    category: normalizePersonnelLearningText(value.category, {
      label: "Die Fähigkeitskategorie",
      min: 2,
      max: 80,
    }),
    summary: normalizePersonnelLearningText(String(value.summary ?? ""), {
      label: "Die Kurzbeschreibung",
      min: 0,
      max: 600,
      preserveWhitespace: true,
    }),
    tags: normalizePersonnelLearningTags(value.tags),
    levelDefinitions: normalizedLevelDefinitions(
      value.levelDefinitions ?? value.levels,
    ),
    versionNote: normalizePersonnelLearningText(String(value.versionNote ?? ""), {
      label: "Der Versionshinweis",
      min: 0,
      max: 300,
      preserveWhitespace: true,
    }),
  });
  return Object.freeze({
    moduleCode: normalizedModuleCode(skillCode ?? value.skillCode),
    // Das bestehende immutable Learning-Modulregister speichert Fähigkeiten
    // intern als Wissenseintrag; catalogEntity trennt beide API-Verträge strikt.
    moduleType: "knowledge",
    title: normalizePersonnelLearningText(value.title, {
      label: "Der Fähigkeitstitel",
      min: 3,
      max: 200,
    }),
    content,
    scope: normalizePersonnelLearningScope(value.scope),
  });
}

function isPersonnelLearningSkillContent(value) {
  return plainRecord(value)
    && value.catalogEntity === PERSONNEL_LEARNING_SKILL_ENTITY;
}

function buildPersonnelLearningSkillState({ module, versions, events } = {}) {
  const state = buildPersonnelLearningModuleState({ module, versions, events });
  if (String(module.moduleType ?? module.module_type ?? "") !== "knowledge"
    || state.versions.some((version) => !isPersonnelLearningSkillContent(version.content))) {
    invalid(
      "PERSONNEL_LEARNING_HISTORY_INVALID",
      "Die versionierte Fähigkeitshistorie ist nicht eindeutig typisiert.",
    );
  }
  return state;
}

module.exports = {
  PERSONNEL_LEARNING_SKILL_ENTITY,
  PERSONNEL_LEARNING_SKILL_LEVEL_COUNT,
  buildPersonnelLearningSkillState,
  isPersonnelLearningSkillContent,
  normalizePersonnelLearningSkillInput,
  normalizedLevelDefinitions,
};

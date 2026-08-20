"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PersonnelLearningCatalogError,
} = require("../lib/personnel-learning-catalog");
const {
  PERSONNEL_LEARNING_SKILL_LEVEL_COUNT,
  buildPersonnelLearningSkillState,
  isPersonnelLearningSkillContent,
  normalizePersonnelLearningSkillInput,
} = require("../lib/personnel-learning-skills");

function levels() {
  return Array.from({ length: PERSONNEL_LEARNING_SKILL_LEVEL_COUNT }, (_entry, index) => ({
    level: index + 1,
    label: `Stufe ${index + 1}`,
    description: `Beherrscht den klar abgegrenzten Umfang der Stufe ${index + 1}.`,
  }));
}

function skill(overrides = {}) {
  return {
    skillCode: "drohne.praxis",
    title: "Drohnen inklusive Praxis",
    category: "Foto und Video",
    summary: "Fachgerechter und sicherer Einsatz von Drohnen.",
    tags: ["Drohne", "Praxis", "drohne"],
    levelDefinitions: levels(),
    versionNote: "Erstfassung",
    scope: { type: "location", locationId: "18" },
    ...overrides,
  };
}

test("Fähigkeitskatalog normalisiert genau zehn geordnete, definierbare Stufen", () => {
  const normalized = normalizePersonnelLearningSkillInput(skill());
  assert.equal(normalized.moduleCode, "drohne.praxis");
  assert.equal(normalized.moduleType, "knowledge");
  assert.equal(normalized.content.catalogEntity, "skill");
  assert.equal(normalized.content.levelDefinitions.length, 10);
  assert.deepEqual(normalized.content.levelDefinitions.map((entry) => entry.level),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(normalized.content.tags, ["Drohne", "Praxis"]);
  assert.equal(isPersonnelLearningSkillContent(normalized.content), true);
  assert.equal(Object.isFrozen(normalized.content.levelDefinitions[0]), true);
});

test("Fähigkeitskatalog lehnt fehlende, vertauschte oder unvollständige Stufen fail-closed ab", () => {
  const reordered = levels();
  [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
  const blankDescription = levels();
  blankDescription[4] = { level: 5, label: "Stufe 5", description: "" };
  for (const invalid of [
    skill({ levelDefinitions: levels().slice(0, 9) }),
    skill({ levelDefinitions: reordered }),
    skill({ levelDefinitions: blankDescription }),
    skill({ category: "" }),
    skill({ skillCode: "Ungültiger Code" }),
  ]) {
    assert.throws(
      () => normalizePersonnelLearningSkillInput(invalid),
      (error) => error instanceof PersonnelLearningCatalogError,
    );
  }
});

test("Fähigkeitshistorie akzeptiert ausschließlich durchgehend typisierte Skill-Versionen", () => {
  const content = normalizePersonnelLearningSkillInput(skill()).content;
  const base = {
    module: { id: "learning-skill:test", moduleType: "knowledge" },
    versions: [{ versionNumber: 1, receiptSha256: "version-1", content }],
    events: [
      { sequenceNumber: 1, eventType: "created", receiptSha256: "event-1" },
      {
        sequenceNumber: 2,
        eventType: "version_added",
        moduleVersionNumber: 1,
        receiptSha256: "event-2",
      },
    ],
  };
  assert.equal(buildPersonnelLearningSkillState(base).status, "draft");
  assert.throws(
    () => buildPersonnelLearningSkillState({
      ...base,
      versions: [{ ...base.versions[0], content: { schemaVersion: 1 } }],
    }),
    (error) => error instanceof PersonnelLearningCatalogError
      && error.code === "PERSONNEL_LEARNING_HISTORY_INVALID",
  );
});

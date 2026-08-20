"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildPersonnelLearningCompetencyState,
  competencyReceiptSha256,
  competencyRevisionReceiptSha256,
  levelDefinitionForSkillVersion,
  normalizedCompetencyMutation,
} = require("../lib/personnel-learning-competencies");

function identity() {
  const row = {
    id: "competency:test:1",
    employeeNumber: "252",
    skillModuleId: "skill:test:tradefoto",
    createdBy: "FL-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  };
  return { ...row, receiptSha256: competencyReceiptSha256(row) };
}

function revision(overrides = {}) {
  const row = {
    competencyId: "competency:test:1",
    revisionNumber: 1,
    skillModuleId: "skill:test:tradefoto",
    skillVersionNumber: 1,
    competencyLevel: 4,
    trainerAuthorized: false,
    active: true,
    changeType: "assigned",
    previousReceiptSha256: "",
    changedBy: "FL-1",
    changedAt: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
  return { ...row, receiptSha256: competencyRevisionReceiptSha256(row) };
}

function skillVersion() {
  return {
    content: {
      catalogEntity: "skill",
      category: "Foto",
      summary: "Test",
      tags: [],
      versionNote: "Test",
      levelDefinitions: Array.from({ length: 10 }, (_entry, index) => ({
        level: index + 1,
        label: `Stufe ${index + 1}`,
        description: `Definition ${index + 1}`,
      })),
    },
  };
}

test("Kompetenzprofil normalisiert Stufe 1 bis 10 und eine ausdrückliche Trainerfreigabe", () => {
  assert.deepEqual(normalizedCompetencyMutation({
    level: 7,
    trainerAuthorized: true,
  }), {
    active: true,
    competencyLevel: 7,
    trainerAuthorized: true,
  });
  assert.deepEqual(normalizedCompetencyMutation({
    active: false,
  }, { current: { competencyLevel: 7 } }), {
    active: false,
    competencyLevel: 7,
    trainerAuthorized: false,
  });
  for (const invalid of [
    { level: 0, trainerAuthorized: false },
    { level: 11, trainerAuthorized: false },
    { level: 4.5, trainerAuthorized: false },
    { level: 4 },
  ]) {
    assert.throws(() => normalizedCompetencyMutation(invalid), /Kompetenz|Trainerfreigabe|Fähigkeitsstufe/);
  }
});

test("Kompetenzhistorie erlaubt ausschließlich die geordnete Zuweisung, Änderung, Entziehung und Wiederherstellung", () => {
  const first = revision();
  const second = revision({
    revisionNumber: 2,
    competencyLevel: 6,
    trainerAuthorized: true,
    changeType: "updated",
    previousReceiptSha256: first.receiptSha256,
    changedAt: "2026-08-18T11:00:00.000Z",
  });
  const third = revision({
    revisionNumber: 3,
    skillVersionNumber: 2,
    competencyLevel: 6,
    trainerAuthorized: false,
    active: false,
    changeType: "withdrawn",
    previousReceiptSha256: second.receiptSha256,
    changedAt: "2026-08-18T12:00:00.000Z",
  });
  const fourth = revision({
    revisionNumber: 4,
    skillVersionNumber: 3,
    competencyLevel: 8,
    trainerAuthorized: true,
    changeType: "restored",
    previousReceiptSha256: third.receiptSha256,
    changedAt: "2026-08-18T13:00:00.000Z",
  });
  const state = buildPersonnelLearningCompetencyState({
    competency: identity(),
    revisions: [fourth, second, first, third],
  });
  assert.equal(state.revisionNumber, 4);
  assert.equal(state.competencyLevel, 8);
  assert.equal(state.trainerAuthorized, true);
  assert.equal(state.active, true);
  assert.equal(state.currentReceipt, fourth.receiptSha256);

  assert.throws(() => buildPersonnelLearningCompetencyState({
    competency: identity(),
    revisions: [first, { ...second, previousReceiptSha256: "0".repeat(64) }],
  }), /widersprüchlichen Revisionsverlauf/);
  assert.throws(() => buildPersonnelLearningCompetencyState({
    competency: identity(),
    revisions: [first, revision({
      revisionNumber: 2,
      active: false,
      trainerAuthorized: true,
      changeType: "withdrawn",
      previousReceiptSha256: first.receiptSha256,
    })],
  }), /widersprüchlichen Revisionsverlauf/);
});

test("Kompetenzstufe wird ausschließlich aus einer vollständigen versionierten 10er-Leiter aufgelöst", () => {
  assert.deepEqual(levelDefinitionForSkillVersion(skillVersion(), 6), {
    level: 6,
    label: "Stufe 6",
    description: "Definition 6",
  });
  const incomplete = skillVersion();
  incomplete.content.levelDefinitions.pop();
  assert.throws(() => levelDefinitionForSkillVersion(incomplete, 6), /vollständige Stufendefinition/);
  assert.throws(() => levelDefinitionForSkillVersion(skillVersion(), 11), /ausgewählte Stufe/);
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PersonnelLearningCatalogError,
  buildPersonnelLearningModuleState,
  normalizePersonnelLearningTemplateInput,
  personnelLearningScopeAccess,
  stableJsonStringify,
} = require("../lib/personnel-learning-catalog");

function template(overrides = {}) {
  return {
    moduleCode: "kassa.grundlagen",
    moduleType: "training",
    title: "Kassasystem sicher bedienen",
    summary: "Grundlagen für den sicheren Betrieb.",
    objective: "Alle wesentlichen Kassenabläufe sicher durchführen.",
    estimatedMinutes: 45,
    verificationMode: "practical_check",
    tags: ["Kassa", "Sicherheit", "kassa"],
    versionNote: "Erstfassung",
    scope: { type: "department", locationId: "F18", departmentId: 18 },
    steps: [{
      stepId: "start",
      title: "Kassa öffnen",
      instruction: "Anmeldung und Startbestand prüfen.",
      completionCriteria: "Startbestand ist bestätigt.",
      required: true,
    }],
    ...overrides,
  };
}

test("Learning-Katalog normalisiert eine vollständige versionierbare Prozessvorlage", () => {
  const normalized = normalizePersonnelLearningTemplateInput(template());
  assert.equal(normalized.moduleCode, "kassa.grundlagen");
  assert.equal(normalized.moduleType, "training");
  assert.deepEqual(normalized.content.tags, ["Kassa", "Sicherheit"]);
  assert.equal(normalized.content.steps[0].stepId, "start");
  assert.deepEqual(normalized.scope, {
    type: "department",
    locationId: "F18",
    departmentId: 18,
  });
  assert.equal(Object.isFrozen(normalized.content), true);
});

test("Learning-Katalog lehnt unvollständige, doppelte oder übergroße Vorlagen fail-closed ab", () => {
  for (const invalid of [
    template({ moduleCode: "Ungültig Leer" }),
    template({ estimatedMinutes: 1 }),
    template({ verificationMode: "beliebig" }),
    template({ steps: [] }),
    template({ steps: [
      { stepId: "doppelt", title: "Erster Schritt" },
      { stepId: "doppelt", title: "Zweiter Schritt" },
    ] }),
    template({ scope: { type: "department", locationId: "F18" } }),
  ]) {
    assert.throws(
      () => normalizePersonnelLearningTemplateInput(invalid),
      (error) => error instanceof PersonnelLearningCatalogError,
    );
  }
});

test("Learning-Geltungsbereiche unterscheiden PL+, FL und AL beim Lesen und Bearbeiten", () => {
  const location = { type: "location", locationId: "F18", departmentId: null };
  const department = { type: "department", locationId: "F18", departmentId: 18 };
  const otherDepartment = { type: "department", locationId: "F18", departmentId: 19 };
  const organization = { type: "organization", locationId: null, departmentId: null };
  const manager = { role: "manager", organizationScope: { locationId: "F18", departmentId: null } };
  const departmentManager = {
    role: "department_manager",
    organizationScope: { locationId: "F18", departmentId: 18 },
  };

  assert.equal(personnelLearningScopeAccess({ plPlus: true }, organization, { manage: true }), true);
  assert.equal(personnelLearningScopeAccess(manager, location, { manage: true }), true);
  assert.equal(personnelLearningScopeAccess(manager, department, { manage: true }), true);
  assert.equal(personnelLearningScopeAccess(manager, organization, { manage: true }), false);
  assert.equal(personnelLearningScopeAccess(departmentManager, location), true);
  assert.equal(personnelLearningScopeAccess(departmentManager, location, { manage: true }), false);
  assert.equal(personnelLearningScopeAccess(departmentManager, department, { manage: true }), true);
  assert.equal(personnelLearningScopeAccess(departmentManager, otherDepartment, { manage: true }), false);
});

test("Learning-Modulzustand trennt Entwurf, Veröffentlichung und Archivierung", () => {
  const module = { id: "module-1" };
  const versions = [
    { versionNumber: 1, receiptSha256: "v1" },
    { versionNumber: 2, receiptSha256: "v2" },
  ];
  const baseEvents = [
    { sequenceNumber: 1, eventType: "created", receiptSha256: "e1" },
    { sequenceNumber: 2, eventType: "version_added", moduleVersionNumber: 1, receiptSha256: "e2" },
    { sequenceNumber: 3, eventType: "published", moduleVersionNumber: 1, receiptSha256: "e3" },
    { sequenceNumber: 4, eventType: "version_added", moduleVersionNumber: 2, receiptSha256: "e4" },
  ];
  assert.equal(buildPersonnelLearningModuleState({ module, versions, events: baseEvents }).status,
    "published_with_draft");
  assert.equal(buildPersonnelLearningModuleState({
    module,
    versions,
    events: [...baseEvents, {
      sequenceNumber: 5,
      eventType: "archived",
      receiptSha256: "e5",
    }],
  }).status, "archived");
});

test("Stabile JSON-Ausgabe ist unabhängig von der Objektschlüssel-Reihenfolge", () => {
  assert.equal(
    stableJsonStringify({ z: 1, a: { c: 3, b: 2 } }),
    stableJsonStringify({ a: { b: 2, c: 3 }, z: 1 }),
  );
});

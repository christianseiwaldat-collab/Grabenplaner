"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  FUNCTION_SEARCH_CATALOG,
  validateFunctionSearchCatalog,
} = require("../public/function-search-catalog");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const html = read("public/index.html");
const app = read("public/app.js");
const styles = read("public/styles.css");

test("Learning-Katalog ist als eigener berechtigungsgebundener Personalbereich verdrahtet", () => {
  for (const id of [
    "personnelLearningNavButton",
    "personnelLearningTab",
    "personnelLearningSection",
    "personnelLearningList",
    "personnelLearningModal",
    "personnelLearningForm",
    "personnelLearningSteps",
  ]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
    assert.match(app, new RegExp(`"${id}"`), id);
  }
  assert.match(html, /data-personnel-administration-route="learning"/);
  assert.match(html, /data-personnel-administration-tab="learning"/);
  assert.match(app, /function canReadPersonnelLearningCatalog\(\)/);
  assert.match(app, /hasGovernancePermission\("personnel:learning:catalog:read"\)/);
  assert.match(app, /elements\.personnelLearningNavButton\?\.classList\.toggle\("hidden", !personnelLearningAccess\)/);
  assert.match(app, /elements\.personnelLearningSection\?\.classList\.toggle\("active", normalized === "learning"\)/);
});

test("Learning-Editor legt Versionen an und überschreibt keine veröffentlichte Vorlage", () => {
  assert.match(html, /Änderungen an bestehenden Prozessen werden als neue, unveränderliche Version gespeichert/);
  assert.match(app, /\/api\/portal\/v1\/personnel-learning\/modules\/\$\{encodeURIComponent\(moduleId\)\}\/versions/);
  assert.match(app, /expectedEventReceipt: module\.currentEventReceipt/);
  assert.match(app, /data-personnel-learning-action="archive"/);
  assert.match(app, /Alle Versionen und Prüfbelege bleiben erhalten/);
  assert.doesNotMatch(app, /personnel-learning\/modules\/\$\{[^\n]+\}["'`],\s*\{\s*method:\s*"DELETE"/);
});

test("Learning-Katalog bleibt responsiv und nutzt den bestehenden Theme-Vertrag", () => {
  assert.match(styles, /\.personnel-learning-summary\s*\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.personnel-learning-toolbar\s*\{[^}]*grid-template-columns:/);
  assert.match(styles, /@media \(max-width:700px\)[\s\S]*\.personnel-learning-form-grid[^{]*\{ grid-template-columns:1fr; \}/);
  assert.match(styles, /\.personnel-learning-card[^}]*background:var\(--surface\)/);
  assert.match(styles, /\.personnel-learning-objective[^}]*var\(--green\)/);
});

test("Funktionssuche kennt Schulung, Wissen und präzise Zielnavigation", () => {
  assert.deepEqual(validateFunctionSearchCatalog(FUNCTION_SEARCH_CATALOG), {
    valid: true,
    errors: [],
  });
  const entry = FUNCTION_SEARCH_CATALOG.find((item) => item.id === "personnel.learning");
  assert.ok(entry);
  assert.deepEqual(entry.access.gateIds, ["personnelLearningNavButton"]);
  assert.deepEqual(entry.target, {
    kind: "navigation",
    view: "personnelAdministration",
    personnelAdministrationTab: "learning",
    focusId: "personnelLearningDashboardPanel",
  });
  for (const synonym of ["schulung", "wissen", "einschulung", "lernprozess", "wissenskontrolle"]) {
    assert.equal(entry.synonyms.includes(synonym), true, synonym);
  }
});

test("Block 3 verdrahtet Fähigkeitskatalog und festen Stufeneditor ohne Mitarbeiterzuordnung", () => {
  for (const id of [
    "personnelLearningSkillsPanel",
    "personnelLearningSkillList",
    "addPersonnelLearningSkillButton",
    "personnelLearningSkillModal",
    "personnelLearningSkillForm",
    "personnelLearningSkillLevels",
  ]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
    assert.match(app, new RegExp(`"${id}"`), id);
  }
  assert.match(html, /Fähigkeitsstufen 1–10/);
  assert.match(html, /Keine Stufe kann ausgelassen, entfernt oder vertauscht werden/);
  assert.match(app, /function defaultPersonnelLearningSkillLevels\(\)/);
  assert.match(app, /Array\.isArray\(content\.levelDefinitions\)/);
  assert.match(app, /\/api\/portal\/v1\/personnel-learning\/skills/);
  assert.match(app, /data-personnel-learning-skill-action="publish"/);
  assert.doesNotMatch(html, /personnelLearningSkillEmployee|personnelLearningSkillTrainer/);
  assert.doesNotMatch(app, /personnel-learning\/skills[^\n]+employee|personnel-learning\/skills[^\n]+trainer/);
});

test("Funktionssuche navigiert Fähigkeiten präzise zum sichtbaren Katalog", () => {
  const entry = FUNCTION_SEARCH_CATALOG.find((item) => item.id === "personnel.learning-skills");
  assert.ok(entry);
  assert.deepEqual(entry.access.gateIds, [
    "personnelLearningNavButton",
    "personnelLearningSkillsPanel",
  ]);
  assert.deepEqual(entry.target, {
    kind: "navigation",
    view: "personnelAdministration",
    personnelAdministrationTab: "learning",
    focusId: "personnelLearningSkillsPanel",
  });
  for (const synonym of ["fähigkeit", "kompetenz", "skill", "fähigkeitsstufe", "level"]) {
    assert.equal(entry.synonyms.includes(synonym), true, synonym);
  }
});

test("Block 4 verdrahtet mehrere Mitarbeiterkompetenzen und fachbezogene Trainerfreigaben", () => {
  for (const id of [
    "personnelLearningCompetenciesPanel",
    "personnelLearningCompetencyList",
    "personnelLearningCompetencyEmployee",
    "addPersonnelLearningCompetencyButton",
    "personnelLearningCompetencyModal",
    "personnelLearningCompetencySkill",
    "personnelLearningCompetencyLevel",
    "personnelLearningCompetencyTrainer",
  ]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
    assert.match(app, new RegExp(`"${id}"`), id);
  }
  assert.match(html, /Kompetenzprofile &amp; Trainerfreigaben/);
  assert.match(html, /Als Trainerin oder Trainer für diese Fähigkeit freigeben/);
  assert.match(app, /hasGovernancePermission\("personnel:learning:assignments:write"\)/);
  assert.match(app, /\/api\/portal\/v1\/personnel-learning\/competencies/);
  assert.match(app, /expectedRevisionReceipt/);
  assert.match(app, /data-personnel-learning-competency-action="withdraw"/);
  assert.match(app, /Array\.from\(\{ length: 10 \}/);
  assert.doesNotMatch(html, /Schulungsfortschritt eintragen|Nachweis hochladen/);

  const entry = FUNCTION_SEARCH_CATALOG.find((item) => (
    item.id === "personnel.learning-competencies"
  ));
  assert.ok(entry);
  assert.deepEqual(entry.access.gateIds, [
    "personnelLearningNavButton",
    "personnelLearningCompetenciesPanel",
  ]);
  assert.equal(entry.target.focusId, "personnelLearningCompetenciesPanel");
  for (const synonym of ["kompetenzprofil", "trainerfreigabe", "drohnen trainer"]) {
    assert.equal(entry.synonyms.includes(synonym), true, synonym);
  }
});

test("Block 5 verdrahtet revisionsgebundene und filialübergreifende Schulungszuweisungen", () => {
  for (const id of [
    "personnelLearningAssignmentsPanel",
    "personnelLearningAssignmentList",
    "addPersonnelLearningAssignmentButton",
    "personnelLearningAssignmentModal",
    "personnelLearningAssignmentProcess",
    "personnelLearningAssignmentLearner",
    "personnelLearningAssignmentTrainerList",
    "personnelLearningAssignmentExpectedReceipt",
  ]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
    assert.match(app, new RegExp(`"${id}"`), id);
  }
  assert.match(html, /Schulungen zuordnen &amp; durchführen/);
  assert.match(html, /Mehrere Fähigkeiten und mehrere Trainerpersonen sind möglich/);
  assert.match(app, /\/api\/portal\/v1\/personnel-learning\/assignments/);
  assert.match(app, /trainerCompetencyIds/);
  assert.match(app, /expectedRevisionReceipt/);
  assert.match(app, /data-personnel-learning-assignment-action="cancel"/);
  assert.match(app, /currentEligible/);
  assert.doesNotMatch(html, /Nachweis hochladen/);

  const entry = FUNCTION_SEARCH_CATALOG.find((item) => (
    item.id === "personnel.learning-assignments"
  ));
  assert.ok(entry);
  assert.deepEqual(entry.access.gateIds, [
    "personnelLearningNavButton",
    "personnelLearningAssignmentsPanel",
  ]);
  assert.equal(entry.target.focusId, "personnelLearningAssignmentsPanel");
  for (const synonym of ["schulung zuweisen", "trainer zuordnen", "filialübergreifende schulung"]) {
    assert.equal(entry.synonyms.includes(synonym), true, synonym);
  }
});

test("Block 6 verdrahtet abgeleiteten Fortschritt, Abschlussbewertung und Korrekturrevision", () => {
  for (const id of [
    "personnelLearningProgressModal",
    "personnelLearningProgressForm",
    "personnelLearningProgressAssignmentId",
    "personnelLearningProgressAssignmentReceipt",
    "personnelLearningProgressExpectedReceipt",
    "personnelLearningProgressStepList",
    "personnelLearningProgressFinalized",
    "personnelLearningProgressResult",
    "personnelLearningProgressAssessmentNote",
    "personnelLearningProgressCorrectionReason",
    "personnelLearningProgressHistory",
    "savePersonnelLearningProgressButton",
  ]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
    assert.match(app, new RegExp(`"${id}"`), id);
  }
  assert.match(html, /ausschließlich aus den erledigten Schritten/);
  assert.match(html, /Schulungsprozess abschließen und bewerten/);
  assert.match(html, /Korrekturbegründung/);
  assert.match(app, /data-personnel-learning-assignment-action="progress"/);
  assert.match(app, /completedStepIds/);
  assert.match(app, /expectedAssignmentRevisionReceipt/);
  assert.match(app, /expectedProgressRevisionReceipt/);
  assert.match(app, /\/progress`/);
  assert.match(app, /Math\.round\(\(completed \/ total\) \* 100\)/);
  assert.doesNotMatch(html, /input[^>]+id="[^"]*ProgressPercent/);
  assert.doesNotMatch(html, /Nachweis hochladen/);

  const entry = FUNCTION_SEARCH_CATALOG.find((item) => (
    item.id === "personnel.learning-assignments"
  ));
  for (const synonym of [
    "schulungsfortschritt",
    "abschluss bewerten",
    "nachschulung",
    "bewertung korrigieren",
  ]) {
    assert.equal(entry.synonyms.includes(synonym), true, synonym);
  }
});

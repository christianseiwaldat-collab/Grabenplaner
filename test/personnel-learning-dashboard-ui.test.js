"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const adminHtml = read("public/index.html");
const adminScript = read("public/app.js");
const adminStyles = read("public/styles.css");
const portalHtml = read("public/portal.html");
const portalScript = read("public/portal.js");
const portalStyles = read("public/portal.css");
const server = read("server.js");

function assertSingleId(source, id) {
  assert.equal((source.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
}

test("Block 7: Verwaltung zeigt Schulungsstände und den professionellen Fähigkeitsbaum", () => {
  for (const id of [
    "personnelLearningDashboardPanel",
    "refreshPersonnelLearningDashboardButton",
    "personnelLearningDashboardSummary",
    "personnelLearningDashboardAssignments",
    "personnelLearningDashboardEmployee",
    "personnelLearningSkillTree",
  ]) {
    assertSingleId(adminHtml, id);
    assert.match(adminScript, new RegExp(`"${id}"`));
  }
  assert.match(adminHtml, /Schulungsdashboard &amp; Fähigkeitsbaum/);
  assert.match(adminHtml, /Dashboard und Fähigkeitsbaum sind datensparsame Ansichten derselben Belege/);
  assert.match(adminHtml, /Dateinachweise bleiben außerhalb dieses Blocks/);
  assert.match(adminScript, /\/api\/portal\/v1\/personnel-learning\/dashboard/);
  assert.match(adminScript, /data-personnel-learning-dashboard-progress/);
  assert.match(adminScript, /levelDefinitions\.map/);
  assert.match(adminStyles, /\.personnel-learning-skill-level-rail\s*\{[^}]*grid-template-columns:repeat\(10,minmax\(22px,1fr\)\)/);
  assert.match(adminStyles, /@media \(max-width:700px\)[\s\S]*\.personnel-learning-skill-level-rail\s*\{ grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(adminHtml, /Nachweis hochladen|Datei auswählen[^<]*Schulung/);
});

test("Block 7: persönliches Portal und Filialkonto bedienen denselben revisionsgebundenen Fortschritt", () => {
  for (const id of [
    "personnelLearningDashboardTab",
    "personnelLearningDashboardView",
    "portalLearningDashboardSummary",
    "portalLearningDashboardAssignments",
    "portalLearningDashboardEmployee",
    "portalLearningSkillTree",
    "portalLearningProgressDialog",
    "portalLearningProgressForm",
    "portalLearningProgressSteps",
    "savePortalLearningProgress",
  ]) assertSingleId(portalHtml, id);
  assert.match(portalHtml, /Im Filialkonto sind Schritte erfassbar; Abschlüsse und Korrekturen bleiben persönlichen berechtigten Konten vorbehalten/);
  assert.match(portalScript, /async function loadPersonnelLearningDashboard/);
  assert.match(portalScript, /async function savePortalLearningProgress/);
  assert.match(portalScript, /expectedAssignmentRevisionReceipt/);
  assert.match(portalScript, /expectedProgressRevisionReceipt/);
  assert.match(portalScript, /completedStepIds/);
  assert.match(portalScript, /Vor dem Abschluss müssen alle Pflichtschritte erledigt sein/);
  assert.match(portalScript, /data-portal-learning-progress/);
  assert.match(portalStyles, /\.portal-learning-level-rail\s*\{[^}]*grid-template-columns:repeat\(10,minmax\(0,1fr\)\)/);
  assert.match(portalStyles, /@media \(max-width:720px\)[\s\S]*\.portal-learning-level-rail\s*\{ grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(portalHtml, /Nachweis hochladen|type="file"[^>]*learning/i);
});

test("Block 7: mobile Navigation und Filialkonto-Rechte bleiben explizit und fail-closed", () => {
  assert.match(portalScript, /\{ id: "learning", tab: "learningDashboard", label: "Schulungen"/);
  assert.match(portalScript, /learning:\s*\[55, 118, 93\]/);
  assert.match(server, /\{ id: "learning", label: "Schulungen" \}/);
  assert.match(server, /"personnel_learning:location:dashboard"/);
  assert.match(server, /branchDashboard[\s\S]*activeScopes\.length === 1/);
  assert.match(server, /branchAccount[\s\S]*canFinalize:\s*active && finalizer/);
  assert.match(server, /!progressState\?\.hasFinalizedRevision \|\| canCorrect/);
  assert.match(adminHtml, /id="organizationAccountLearningDashboard"[^>]*checked/);
  assert.match(adminScript, /organizationAccountLearningDashboard/);
  assert.doesNotMatch(
    server,
    /PERSONNEL_LEARNING_BRANCH_DASHBOARD_PERMISSION[\s\S]{0,300}canReadAudit:\s*true/,
  );
});

test("Block 8: Sicherheits-, Rechte-, Mobil- und Integrationsvertrag bleibt fail-closed", () => {
  assert.match(server, /repository\.getOrganizationAccount\(String\(session\.accountId\)\)/);
  assert.match(server, /const branchDashboard = accountType === "branch"[\s\S]*permissions\.includes\(PERSONNEL_LEARNING_BRANCH_DASHBOARD_PERMISSION\)[\s\S]*activeScopes\.length === 1/);
  assert.doesNotMatch(
    server,
    /const branchDashboard = session\?\.accountType[\s\S]{0,240}session\?\.permissions/,
  );
  assert.match(
    server,
    /\/api\/portal\/v1\/personnel-learning\/assignments\/:assignmentId\/progress[\s\S]{0,280}\{ csrf: true \}/,
  );
  assert.match(
    portalScript,
    /tab === "learningDashboard"[\s\S]*personnelLearningDashboardAvailable === true[\s\S]*personnel_learning:location:dashboard/,
  );
  assert.match(portalScript, /esc\(assignment\.learner\?\.fullName/);
  assert.match(portalScript, /esc\(assignment\.process\?\.title/);
  assert.match(portalScript, /esc\(current\.description \|\| competency\.skillSummary/);
  assert.match(adminScript, /escapeHtml\(competency\.skillTitle\)/);
  assert.match(adminScript, /escapeHtml\(assignment\.process\?\.title/);
  assert.match(portalStyles, /\.portal-learning-grid\s*>\s*\.portal-card\s*\{[^}]*min-width:0/);
  assert.match(portalStyles, /\.portal-learning-progress-step\s*>\s*span\s*\{[^}]*min-width:0/);
  assert.match(portalStyles, /@media \(max-width:720px\)[\s\S]*\.portal-learning-assignment\s*>\s*header\s*\{ flex-direction:column/);
  assert.match(portalStyles, /@media \(max-width:720px\)[\s\S]*\.portal-learning-assignment button\s*\{ width:100%; min-height:44px/);
  assert.match(portalStyles, /@media \(max-width:720px\)[\s\S]*\.portal-learning-progress-step\s*\{ grid-template-columns:22px minmax\(0,1fr\)/);
  assert.match(adminStyles, /@media \(max-width:1100px\)[\s\S]*\.personnel-learning-dashboard-grid\s*\{ grid-template-columns:1fr/);
  assert.match(portalStyles, /@media \(max-width:720px\)[\s\S]*\.portal-learning-level-rail\s*\{ grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");


function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Personalmodul-Fundament: neue Einstiege bleiben Teil der bestehenden Personalverwaltung", () => {
  const navigation = between(
    html,
    '<div class="nav-module-children hidden" id="personnelAdministrationNavChildren">',
    "</section>",
  );
  for (const [id, route] of [
    ["candidatePreboardingNavButton", "applications"],
    ["workflowCenterNavButton", "workflows"],
    ["personnelTasksNavButton", "tasks"],
  ]) {
    assert.match(navigation, new RegExp(`id="${id}"`));
    assert.match(navigation, new RegExp(`data-personnel-administration-route="${route}"`));
  }

  for (const [titleId, sectionId] of [
    ["candidatePreboardingTitle", "candidatePreboardingSection"],
    ["workflowCenterTitle", "workflowCenterSection"],
    ["personnelTasksTitle", "personnelTasksSection"],
  ]) {
    assert.match(html, new RegExp(`id="${titleId}"`));
    assert.match(html, new RegExp(`id="${sectionId}"[^>]*role="region"[^>]*aria-labelledby="${titleId}"`));
  }

  assert.doesNotMatch(html, /data-view="(?:applications|workflows|personnelTasks)"/);
});

test("Personalmodul-Fundament: Feature und eigene Fachrechte sperren Navigation und Routen fail-closed", () => {
  const featureBoundary = between(
    app,
    "function personnelLifecycleFoundationEnabled()",
    "function canOpenEmployeeProfileFoundation()",
  );
  const access = between(
    app,
    "function canReadCandidatePreboarding()",
    "function canReadWorkflowStudioCatalog()",
  );
  assert.match(featureBoundary, /installationFeatures\?\.personnelLifecycle === true/);
  assert.match(access, /hasGovernancePermission\("personnel:candidates:read"\)/);
  assert.match(access, /hasGovernancePermission\("personnel:workflows:read"\)/);
  assert.match(access, /personnelWorkflowInstanceCapabilities\.canRead !== false/);
  assert.doesNotMatch(access, /canReadCentralPersonnel\(\)|personnel:central:read|processes:write/);

  for (const element of [
    "candidatePreboardingNavButton",
    "workflowCenterNavButton",
    "personnelTasksNavButton",
  ]) assert.match(app, new RegExp(`elements\\.${element}\\?\\.classList\\.toggle\\("hidden", !`));

  assert.match(server, /id: "personnelLifecycle",[\s\S]*?defaultEnabled: false,[\s\S]*?provisionable: false/);
  assert.match(server, /\^\\\/portal\\\/v1\\\/personnel-lifecycle/);
  assert.match(server, /featureCatalog: installationFeatureCatalog\.filter\(\(feature\) => feature\.provisionable !== false\)/);
});

test("Personalmodul-Fundament: M5- und O8-Ansichten kommunizieren ihre Wirkungsgrenzen und bleiben responsiv", () => {
  const workflowSection = between(
    html,
    'id="workflowCenterSection"',
    '<section class="personnel-administration-section personnel-lifecycle-foundation personnel-workflow-tasks"',
  );
  assert.match(workflowSection, /Jede gestartete Instanz bleibt an ihre veröffentlichte Version gebunden/);
  assert.match(workflowSection, /Personalprozesse · freigegebene Instanzen/);
  assert.match(workflowSection, /personnelLifecycleEditorSection/);
  assert.match(workflowSection, /Diese Skizze wird weder gespeichert noch veröffentlicht/);
  assert.match(workflowSection, /personnelWorkflowInstanceWorkspace/);
  assert.match(workflowSection, /personnelWorkflowInstanceList/);
  const taskSection = between(html, 'id="personnelTasksSection"', "</section>");
  assert.match(taskSection, /Dein freigegebener Bereich/);
  assert.match(taskSection, /aria-label="Aufgaben im freigegebenen Bereich"/);
  assert.match(taskSection, /personnelWorkflowTaskList/);
  assert.doesNotMatch(`${workflowSection}\n${taskSection}`, /Prozess starten|Workflow starten|Aufgabe abschließen/);
  const candidateSection = between(html, 'id="candidatePreboardingSection"', "</section>");
  assert.match(candidateSection, /Bewerbungsübersicht/);
  assert.match(candidateSection, /personnelCandidateList/);
  assert.match(styles, /\.personnel-lifecycle-foundation-grid \{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media \(max-width:1180px\) \{[\s\S]*?\.personnel-lifecycle-foundation-grid \{ grid-template-columns:1fr; \}/);
});



test("Personalmodul-Fundament: Bewerber-API bleibt zentral, sensibel und ohne unsicheren Dokumentpfad", () => {
  const api = between(
    server,
    "function requirePersonnelLifecycleAccess(",
    'app.get("/api/portal/v1/personnel-records/:employeeNumber"',
  );
  assert.match(api, /personnel:central:read/);
  assert.match(api, /personnel:central:write/);
  assert.match(api, /personnel:sensitive:read/);
  assert.match(api, /personnel:sensitive:write/);
  assert.match(api, /\{ csrf: definition\.write \}/);
  for (const route of [
    "/api/portal/v1/personnel-lifecycle/document-categories",
    "/api/portal/v1/personnel-lifecycle/candidates",
    "/api/portal/v1/personnel-lifecycle/candidates/:candidateId",
    "/api/portal/v1/personnel-lifecycle/candidates/:candidateId/applications",
    "/api/portal/v1/personnel-lifecycle/candidates/:candidateId/applications/:applicationId",
    "/api/portal/v1/personnel-lifecycle/candidates/:candidateId/applications/:applicationId/status",
    "/api/portal/v1/personnel-lifecycle/candidates/:candidateId/applications/:applicationId/convert",
  ]) assert.match(api, new RegExp(route.replaceAll("/", "\\/")));
  assert.doesNotMatch(api, /candidate-documents|documents\/:documentId/);
});

test("Historischer Personalimport: Altsicherungen bleiben für alle Bewerberdaten fail-closed", () => {
  const historicalServer = fs.readFileSync(require("../test-support/legacy-baseline").legacyPath("server.js"), "utf8");
  assert.match(historicalServer, /currentCandidateDocuments[\s\S]*?AMU_FULL_RESTORE_REQUIRED/);
  assert.match(historicalServer, /importedCandidateDocuments[\s\S]*?AMU_FULL_RESTORE_REQUIRED/);
  const importedProtection = between(
    historicalServer,
    "const candidateProtectedGroups = [",
    "for (const report of protectedRows.amuReports",
  );
  for (const contextFactory of [
    "candidateProtectionContext",
    "candidateApplicationProtectionContext",
    "candidateDocumentProtectionContext",
    "candidateDocumentVersionProtectionContext",
    "candidateEventProtectionContext",
    "candidateConversionProtectionContext",
  ]) assert.match(importedProtection, new RegExp(contextFactory));
});

test("Personalmodul-Fundament: Dokumentregeln sind vor der PostgreSQL-Anwendungsinitialisierung definiert", () => {
  const startupMigrationIndex = server.indexOf("function initializeApplicationPersistence(");
  const categoriesIndex = server.indexOf("const PERSONNEL_DOCUMENT_CATEGORIES = new Set(");
  const visibilityIndex = server.indexOf(
    'const PERSONNEL_DOCUMENT_VISIBILITY = "hr_confidential";',
  );

  assert.notEqual(startupMigrationIndex, -1);
  assert.notEqual(categoriesIndex, -1);
  assert.notEqual(visibilityIndex, -1);
  assert.ok(categoriesIndex < startupMigrationIndex);
  assert.ok(visibilityIndex < startupMigrationIndex);
  assert.doesNotMatch(server, /runSqliteStartupSchemaMigrations\(/);
});

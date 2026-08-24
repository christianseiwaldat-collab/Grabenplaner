"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
function readSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const html = readSource(path.join("public", "index.html"));
const app = readSource(path.join("public", "app.js"));
const styles = readSource(path.join("public", "styles.css"));

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Bewerbernavigation hängt ausschließlich am neuen Leserecht und dem Feature", () => {
  const access = between(
    app,
    "function canReadCandidatePreboarding()",
    "function canOpenWorkflowCenter()",
  );
  assert.match(access, /personnelLifecycleFoundationEnabled\(\)/);
  assert.match(access, /hasGovernancePermission\("personnel:candidates:read"\)/);
  assert.doesNotMatch(access, /canReadCentralPersonnel|\.role|role\s*[=!]/);
});

test("Bewerberseite besitzt eine reale datensparsame Liste und Detailansicht", () => {
  const section = between(
    html,
    '<section class="personnel-administration-section personnel-candidates" id="candidatePreboardingSection"',
    "</section>\n\n          <section",
  );
  for (const id of [
    "personnelCandidateScopeBadge",
    "personnelCandidateSearch",
    "personnelCandidateStatusFilter",
    "addPersonnelCandidateButton",
    "refreshPersonnelCandidatesButton",
    "personnelCandidateStatus",
    "personnelCandidateList",
    "personnelCandidateDetail",
  ]) assert.match(section, new RegExp(`id="${id}"`));
  assert.doesNotMatch(section, /Noch keine Bewerberdaten/);
  assert.doesNotMatch(section, /Bereich ändern|Dokument hochladen|Umwandeln|data-convert-candidate/i);
});

test("Bewerberanlage ist capability-gebunden und verlangt die hervorgehobene EDV-Bestätigung", () => {
  const modal = between(
    html,
    '<dialog class="modal wide-modal personnel-candidate-create-modal"',
    "</dialog>",
  );
  for (const id of [
    "personnelCandidateCreateForm",
    "personnelCandidateCreateLocation",
    "personnelCandidateCreateDepartment",
    "personnelCandidateAuthorizationCheck",
    "personnelCandidateAuthorizationConfirmed",
    "personnelCandidateAuthorizationState",
    "personnelCandidateCreateMessage",
    "personnelCandidateCreateSubmit",
  ]) assert.match(modal, new RegExp(`id="${id}"`));
  assert.match(modal, /id="personnelCandidateCreateForm" autocomplete="off"/);
  assert.match(modal, /name="email" type="email" maxlength="254" autocomplete="off"/);
  assert.match(modal, /id="personnelCandidateCreateSourceField"/);
  assert.match(modal, /name="dataProcessingAuthorizationConfirmed" type="checkbox" required/);
  assert.doesNotMatch(modal, /(?:checked|aria-checked="true")/);
  assert.match(modal, /EDV-Erlaubnis bestätigen/);
  assert.match(modal, /Erlaubnis zur EDV-gestützten Verarbeitung dieser Bewerberdaten im Grabenplaner vorliegt/);

  const rendering = between(
    app,
    "function renderPersonnelCandidateOverview()",
    "function setPersonnelCandidateCreateMessage(",
  );
  assert.match(rendering, /classList\.toggle\("hidden", !capabilities\.canCreateCandidates\)/);
  assert.match(rendering, /if \(!capabilities\.canCreateCandidates\) \{[\s\S]*?createModal\.close\(\)[\s\S]*?createForm\?\.reset\(\)/);
  assert.match(rendering, /!capabilities\.canWriteApplications[\s\S]*?desiredRoleTitle[\s\S]*?availableFrom[\s\S]*?source/);
  assert.match(rendering, /canWriteSource = capabilities\.canWriteApplications && capabilities\.canWriteConfidential/);
  assert.match(rendering, /sourceField\?\.classList\.toggle\("hidden", !canWriteSource\)/);
  assert.doesNotMatch(rendering, /\.role|role\s*[=!]/);

  const creation = between(
    app,
    "function setPersonnelCandidateCreateMessage(",
    "async function loadPersonnelCandidates(",
  );
  assert.match(creation, /dataProcessingAuthorizationConfirmed: true/);
  assert.match(creation, /!state\.personnelCandidateCapabilities\.canCreateCandidates/);
  assert.match(creation, /requiresApplicationOnCreate === true/);
  assert.match(creation, /createScope\?\.locationIds/);
  assert.match(creation, /Bitte einen für Bewerbungen freigegebenen eigenen Standort auswählen/);
  assert.match(creation, /!elements\.personnelCandidateAuthorizationConfirmed\?\.checked/);
  assert.match(creation, /personnelCandidateCreateSubmit\.disabled/);
  assert.match(creation, /personnelCandidateCreateForm\.reset\(\)/);
  assert.match(creation, /state\.personnelCandidateCapabilities\.canWriteConfidential[\s\S]*?form\.elements\.source/);
  assert.match(creation, /method: "POST"/);
});

test("Bewerberdialog bleibt auch im Darkmode kontrastreich", () => {
  const darkModal = between(
    styles,
    'html[data-active-page-theme="dark"] .personnel-candidate-create-modal {',
    'html[data-active-page-theme="dark"] .personnel-candidate-create-application',
  );
  for (const variable of [
    "--surface",
    "--surface-soft",
    "--ink",
    "--muted",
    "--line",
    "--warning-surface",
    "--warning-ink",
    "--success-surface",
    "--success-ink",
    "--danger-ink",
  ]) assert.match(darkModal, new RegExp(variable));
  assert.match(styles, /personnel-candidate-create-modal :is\(\.field > span,\.personnel-candidate-create-application legend\)/);
});

test("Bewerberliste und Detail werden ausschließlich über die vorhandene API geladen", () => {
  assert.match(app, /api\("\/api\/portal\/v1\/personnel-lifecycle\/candidates\?limit=50&offset=0"\)/);
  assert.match(app, /api\(`\/api\/portal\/v1\/personnel-lifecycle\/candidates\/\$\{encodeURIComponent\(id\)\}`\)/);
  assert.doesNotMatch(app, /api\([^\n]*personnel-lifecycle[^\n]*\/convert/);
});

test("Serverfähigkeiten werden vollständig und fail-closed ausgewertet", () => {
  const capabilities = between(
    app,
    "function defaultPersonnelCandidateCapabilities()",
    "function personnelCandidateScopeLabel(",
  );
  for (const key of [
    "scope",
    "canReadCandidates",
    "canCreateCandidates",
    "createScope",
    "requiresApplicationOnCreate",
    "canWriteCandidates",
    "canWriteApplications",
    "canReadConfidential",
    "canWriteConfidential",
    "canConvert",
  ]) assert.match(capabilities, new RegExp(key));
  assert.match(capabilities, /canReadCandidates: submitted\.canReadCandidates === true/);
  assert.match(app, /if \(!capabilities\.canReadCandidates\) \{[\s\S]*?clearPersonnelLifecycleCandidateState/);
});

test("Statuswechsel bleibt capability- und revisionsgebunden", () => {
  const form = between(
    app,
    "function renderPersonnelCandidateStatusForm(",
    "function renderPersonnelCandidateApplication(",
  );
  assert.match(form, /!state\.personnelCandidateCapabilities\.canWriteApplications/);
  const mutation = between(
    app,
    "async function savePersonnelCandidateApplicationStatus(",
    "function renderPersonnelAdministration()",
  );
  assert.match(mutation, /!state\.personnelCandidateCapabilities\.canWriteApplications/);
  assert.match(mutation, /\/applications\/\$\{encodeURIComponent\(applicationId\)\}\/status/);
  assert.match(mutation, /revision: application\.revision/);
  assert.match(mutation, /method: "POST"/);
  assert.doesNotMatch(mutation, /\/convert/);
});

test("Rechteeditor behandelt lokale Personalmodul-Rechte als Bereichsrechte und erzwingt Abhängigkeiten", () => {
  const organizational = between(
    app,
    "const rightsEditorOrganizationalPermissionIds",
    "function selectedRightsEditorUser()",
  );
  assert.match(organizational, /"personnel:candidates:read"/);
  assert.match(organizational, /"personnel:applications:write"/);
  assert.match(organizational, /"personnel:candidates:create"/);
  assert.match(organizational, /"personnel:workflows:read"/);
  assert.match(organizational, /"personnel:workflows:draft:write"/);
  assert.match(organizational, /"personnel:workflows:publish"/);
  assert.match(organizational, /"personnel:workflows:local:supplement"/);
  const createDependencies = between(
    app,
    "const permissionDependencyRules = Object.freeze([",
    "function rightsEditorEffectivePermissionSet(",
  );
  assert.match(createDependencies, /permissionId: "personnel:candidates:create"[\s\S]*?requiredPermissionId: "personnel:candidates:read"/);
  assert.match(createDependencies, /permissionId: "personnel:candidates:create"[\s\S]*?requiredPermissionId: "personnel:applications:write"/);
  assert.match(createDependencies, /permissionId: "personnel:candidates:create"[\s\S]*?requiredPermissionId: "personnel:candidates:write"[\s\S]*?applicableRoles:/);
  assert.match(app, /dormantCreateRight[\s\S]*?ohne erforderliche Basisrechte nicht wirksam/);

  const dependencies = between(
    app,
    "const permissionDependencyRules",
    "async function loadPortalUsers()",
  );
  for (const [permission, required] of [
    ["personnel:candidates:convert", "personnel:candidates:write"],
    ["personnel:candidates:convert", "personnel:candidates:confidential:write"],
    ["personnel:candidates:confidential:write", "personnel:candidates:confidential:read"],
    ["personnel:candidates:confidential:write", "personnel:applications:write"],
    ["personnel:candidates:write", "personnel:candidates:read"],
    ["personnel:candidates:confidential:read", "personnel:candidates:read"],
    ["personnel:applications:write", "personnel:candidates:read"],
    ["personnel:workflows:draft:write", "personnel:workflows:read"],
    ["personnel:workflows:review", "personnel:workflows:read"],
    ["personnel:workflows:publish", "personnel:workflows:draft:write"],
    ["personnel:workflows:local:supplement", "personnel:workflows:draft:write"],
    ["personnel:workflows:confidential:read", "personnel:workflows:read"],
    ["personnel:workflows:confidential:write", "personnel:workflows:confidential:read"],
    ["personnel:workflows:confidential:write", "personnel:workflows:draft:write"],
    ["personnel:workflows:delegate", "personnel:workflows:read"],
  ]) {
    assert.match(dependencies, new RegExp(`permissionId: "${permission}"[\\s\\S]*?requiredPermissionId: "${required}"`));
  }
  const enforcement = between(
    app,
    "function enforceRightsEditorPermissionDependencies(",
    "function openRightsEditor(",
  );
  assert.match(enforcement, /while \(changed\)/);
  assert.match(enforcement, /removedPermissions\.add\(dependency\.permissionId\)/);

  const employeeProfileNormalization = between(
    app,
    "function normalizeEmployeeAccessDraftForRole(",
    "function renderEmployeeAccessProfile(",
  );
  assert.match(employeeProfileNormalization, /if \(dependency\.deferredRoleDefault\) continue;/);
  assert.match(employeeProfileNormalization, /dependency\.applicableRoles[\s\S]*?!dependency\.applicableRoles\.includes\(roleId\)/);
});

test("IT-Admin kann die HR-Rolle weder zuweisen noch bestehende HR-Zugänge verwalten", () => {
  const roleAssignment = between(
    app,
    "function portalRoleAssignableInUi(",
    "function portalUserManageableInUi(",
  );
  assert.match(roleAssignment, /actorRole === "it_admin"/);
  assert.match(roleAssignment, /\["employee", "location_planner", "manager", "department_manager"\]/);
  assert.doesNotMatch(roleAssignment, /actorRole === "it_admin"[^\n]*"hr"/);

  const userManagement = between(
    app,
    "function portalUserManageableInUi(",
    "function permissionEligibleForRole(",
  );
  assert.match(userManagement, /actorRole === "it_admin"/);
  assert.match(userManagement, /\["employee", "location_planner", "manager", "department_manager"\]/);
  assert.doesNotMatch(userManagement, /actorRole === "it_admin"[^\n]*"hr"/);

  const personnelProfile = between(
    app,
    "function canEditEmployeeAccessProfile(",
    "function permissionDisplayLabel(",
  );
  assert.match(personnelProfile, /actorRole !== "it_admin" \|\| employee\?\.portal_access\?\.role !== "hr"/);
  assert.match(personnelProfile, /actorRole === "it_admin" && \["employee", "location_planner", "department_manager", "manager"\]\.includes\(roleId\)/);
  assert.doesNotMatch(personnelProfile, /\["employee", "location_planner", "department_manager", "manager", "hr"\]/);
});

test("Detailrenderer arbeitet mit einer Positivliste ohne vertrauliche Felder", () => {
  const rendering = between(
    app,
    "function personnelCandidateProfile(",
    "function renderPersonnelCandidateOverview(",
  );
  for (const forbidden of [
    "internalNotes",
    "communicationNotes",
    "internalRating",
    "preferredLanguage",
    "documents",
    "history",
    "conversion",
  ]) assert.doesNotMatch(rendering, new RegExp(forbidden));
  assert.match(rendering, /profile\.firstName/);
  assert.match(rendering, /profile\.email/);
  assert.match(rendering, /application\.desiredRoleTitle/);
});

test("Rechteverlust entfernt geladene Bewerberdaten und 403-Zustände bleiben nicht stale", () => {
  assert.match(app, /if \(!candidatePreboardingAccess && \([\s\S]*?clearPersonnelLifecycleCandidateState\("Bewerberdaten wurden wegen geänderter Rechte/);
  assert.match(app, /if \(\[401, 403\]\.includes\(error\.status\)\) \{[\s\S]*?clearPersonnelLifecycleCandidateState/);
  const clear = between(
    app,
    "function clearPersonnelLifecycleCandidateState(",
    "function renderPersonnelCandidateList(",
  );
  assert.match(clear, /state\.personnelCandidates = \[\]/);
  assert.match(clear, /state\.selectedPersonnelCandidate = null/);
  assert.match(clear, /defaultPersonnelCandidateCapabilities\(\)/);
});

test("Bewerberansicht bleibt bis 320 Pixel ohne horizontale Tabellenachse", () => {
  const candidateStyles = between(
    styles,
    ".personnel-candidates {",
    ".personnel-dashboard-heading {",
  );
  assert.match(candidateStyles, /\.personnel-candidate-workspace \{[^}]*grid-template-columns:minmax\(0,/);
  assert.match(candidateStyles, /min-width:0/);
  assert.doesNotMatch(candidateStyles, /overflow-x\s*:/);
  assert.match(styles, /@media \(max-width:900px\) \{[\s\S]*?\.personnel-candidate-workspace \{ grid-template-columns:1fr; \}/);
  assert.match(styles, /@media \(max-width:700px\) \{[\s\S]*?\.personnel-candidate-toolbar,.personnel-candidate-status-form(?:,[^{]+)? \{ grid-template-columns:1fr; \}/);
  assert.match(styles, /@media \(max-width:420px\) \{[\s\S]*?\.personnel-candidate-facts \{ grid-template-columns:1fr; \}/);
  assert.match(candidateStyles, /\.personnel-candidate-authorization-check \{[^}]*grid-template-columns:26px minmax\(0,1fr\) auto/);
  assert.match(styles, /@media \(max-width:420px\) \{[\s\S]*?\.personnel-candidate-authorization-check \{ grid-template-columns:24px minmax\(0,1fr\);/);
});

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

test("Bewerberkontakte bleiben einzeln optional und werden gemeinsam validiert", () => {
  const modal = between(
    html,
    '<dialog class="modal wide-modal personnel-candidate-create-modal"',
    "</dialog>",
  );
  const emailInput = modal.match(/<input name="email"[^>]*>/)?.[0] || "";
  const phoneInput = modal.match(/<input name="phone"[^>]*>/)?.[0] || "";
  assert.match(emailInput, /type="email"/);
  assert.match(phoneInput, /type="tel"/);
  assert.doesNotMatch(emailInput, /\brequired\b/);
  assert.doesNotMatch(phoneInput, /\brequired\b/);
  assert.match(modal, /E-Mail <small class="personnel-candidate-optional-marker">\* optional<\/small>/);
  assert.match(modal, /Telefon <small class="personnel-candidate-optional-marker">\* optional<\/small>/);
  for (const name of ["birthDate", "postalCode", "city", "citizenships"]) {
    assert.match(modal, new RegExp(`name="${name}"`));
  }

  const creation = between(
    app,
    "async function savePersonnelCandidate(event)",
    "async function loadPersonnelCandidates(",
  );
  assert.match(creation, /const email = String\(form\.elements\.email/);
  assert.match(creation, /const phone = String\(form\.elements\.phone/);
  assert.match(creation, /setCustomValidity\(email \|\| phone/);
  assert.match(creation, /Bitte E-Mail-Adresse oder Telefonnummer angeben/);
  assert.match(creation, /birthDate:[\s\S]*?address:[\s\S]*?postalCode:[\s\S]*?city:[\s\S]*?citizenships:/);
  assert.match(app, /profile\.address && typeof profile\.address === "object"[\s\S]*?profile\.residence/);
});

test("Zielbereiche, Schnuppertermine und Kompetenzratings sind dynamisch und barrierearm editierbar", () => {
  const modal = between(
    html,
    '<dialog class="modal wide-modal personnel-candidate-create-modal"',
    "</dialog>",
  );
  for (const id of [
    "personnelCandidateCreateTargetAreas",
    "personnelCandidateCreateAddTargetArea",
    "personnelCandidateCreateTrialAppointments",
    "personnelCandidateCreateAddTrialAppointment",
    "personnelCandidateCreateCompetencyRatings",
    "personnelCandidateCreateAddCompetencyRating",
  ]) assert.match(modal, new RegExp(`id="${id}"`));
  for (const id of [
    "personnelCandidateTrialDateRangeDialog",
    "personnelCandidateTrialDateRangeGrid",
    "personnelCandidateTrialDateRangeApply",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(modal, /<details class="personnel-candidate-create-details/);
  assert.match(app, /PERSONNEL_CANDIDATE_DEFAULT_COMPETENCIES/);
  for (const label of [
    "Fachliche Eignung",
    "Zusammenarbeit / Auftreten",
    "Branchenerfahrung",
    "Ausbildung / Qualifikation",
    "Berufserfahrung",
    "Sprachkenntnisse",
  ]) assert.ok(app.includes(label), `Standardkompetenz fehlt: ${label}`);
  assert.match(app, /role="radiogroup" aria-label="Bewertung von 1 bis 5"/);
  assert.match(app, /Object\.entries\(PERSONNEL_CANDIDATE_RATING_LABELS\)/);
  assert.match(app, /personnelCandidateCreateAddTargetArea\?\.addEventListener\("click"/);
  assert.match(app, /personnelCandidateCreateAddTrialAppointment\?\.addEventListener\("click"/);
  assert.match(app, /personnelCandidateCreateAddCompetencyRating\?\.addEventListener\("click"/);
  assert.match(app, /data-candidate-trial-range-button/);
  assert.match(app, /function initializePersonnelCandidateTrialDateRangeCalendar\(\)/);
  assert.match(app, /personnelCandidateTrialDateRangeCalendar\.open\(\{/);
  assert.match(app, /Bitte einen gültigen Zeitraum für den Schnuppertermin auswählen/);
  assert.doesNotMatch(app, /data-candidate-trial-from type="date"/);
  assert.match(app, /targetAreas,[\s\S]*?trialAppointments,[\s\S]*?competencyRatings,/);
  assert.match(app, /String\(scope\?\.type \|\| ""\)\.toLowerCase\(\) === "department"/);
  assert.match(app, /scope\?\.departmentIds/);
  assert.match(app, /departmentScope\.has\(String\(department\.id\)\)[\s\S]*?String\(department\.id\) === selectedId/);
  assert.match(app, /function canWritePersonnelCandidateStructuredScope\(entry\)/);
  assert.match(app, /data-candidate-readonly-scope="true"/);
  assert.match(app, /data-candidate-readonly-payload=/);
  assert.match(app, /function personnelCandidateReadOnlyStructuredPayload\(row\)/);
  assert.match(app, /const readOnly = personnelCandidateReadOnlyStructuredPayload\(row\);[\s\S]*?if \(readOnly\) return readOnly/);
  assert.match(app, /readOnly: !canWritePersonnelCandidateStructuredScope\(area\)/);
  assert.match(app, /readOnly: !canWritePersonnelCandidateStructuredScope\(appointment\)/);
  assert.match(app, /Bereiche außerhalb der eigenen Freigabe bleiben sichtbar und unverändert erhalten/);
  assert.match(styles, /\.personnel-candidate-readonly-scope/);
  assert.match(styles, /\.personnel-candidate-rating-score\.score-1[^}]*background:#f4d6d1/);
  assert.match(styles, /\.personnel-candidate-rating-score\.score-5[^}]*background:#c9e8dc/);
  assert.match(styles, /\.personnel-candidate-rating-score:focus-within/);
  const ratingDisplay = between(
    app,
    "function renderPersonnelCandidateRatingDisplay(",
    "function personnelCandidateTargetAreas(",
  );
  assert.ok(
    ratingDisplay.indexOf("<strong>${value}/5 · ${escapeHtml(label)}</strong>")
      < ratingDisplay.indexOf("Array.from({ length: 5 }"),
    "Ergebnistext muss vor der rechtsbündigen 1-bis-5-Skala stehen",
  );
  assert.match(styles, /\.personnel-candidate-rating-summary article > header \{ display:grid; grid-template-columns:minmax\(0,1fr\) auto;/);
  assert.match(styles, /\.personnel-candidate-rating-display \{ display:grid; grid-template-columns:max-content repeat\(5,20px\);[^}]*justify-content:end/);
  assert.match(styles, /\.personnel-candidate-rating-display > strong \{[^}]*white-space:nowrap/);
});

test("Schnuppertermine lassen sich direkt absagen und mit einem eigenständigen Ersatztermin verknüpfen", () => {
  const trialEditor = between(
    app,
    "function renderPersonnelCandidateTrialEditorRow(",
    "function updatePersonnelCandidateTrialRangeText(",
  );
  for (const marker of [
    "data-candidate-trial-cancellation-reason",
    "data-candidate-trial-replacement-id",
    "data-candidate-trial-replaces-id",
    "data-candidate-add-replacement-trial",
    "data-candidate-save-trial",
  ]) assert.match(trialEditor, new RegExp(marker));
  assert.match(trialEditor, /Absagegrund/);
  assert.match(trialEditor, /Ersatztermin eintragen/);
  assert.match(trialEditor, /const cancellationLocked = persisted && status === "cancelled"/);
  assert.match(trialEditor, /data-candidate-trial-cancelled-at/);
  assert.match(trialEditor, /data-candidate-trial-cancelled-by/);
  assert.match(trialEditor, /Absage protokolliert/);
  assert.match(trialEditor, /type="submit" formnovalidate data-candidate-save-trial/);
  assert.match(trialEditor, /Ende <small class="personnel-candidate-optional-marker">\* optional<\/small>/);

  const trialSummary = between(
    app,
    "function renderPersonnelCandidateTrialAppointments(",
    "function renderPersonnelCandidateCompetencyRatings(",
  );
  assert.match(trialSummary, /data-candidate-edit-trial/);
  assert.match(trialSummary, /canWritePersonnelCandidateApplication\(application\)/);
  assert.match(trialSummary, /canWritePersonnelCandidateStructuredScope\(appointment\)/);
  assert.match(trialSummary, /appointment\.cancellationReason/);
  assert.match(trialSummary, /replacementAppointmentId/);
  assert.match(trialSummary, /replacesAppointmentId/);

  const replacementAction = between(
    app,
    "function addPersonnelCandidateReplacementTrial(",
    "function handlePersonnelCandidateDynamicClick(",
  );
  assert.match(replacementAction, /personnelCandidateClientId\("trial"\)/);
  assert.match(replacementAction, /status: "planned"/);
  assert.match(replacementAction, /replacesAppointmentId: appointmentId/);
  assert.match(replacementAction, /replacementInput\.value = replacementAppointmentId/);
  assert.match(app, /persisted: true/);
  const directSave = between(
    app,
    "async function savePersonnelCandidateTrialAppointment(",
    "async function savePersonnelCandidateApplication(",
  );
  assert.match(directSave, /\/trial-appointments\/\$\{encodeURIComponent\(appointment\.id\)\}/);
  assert.match(directSave, /method: "PUT"/);
  assert.match(directSave, /revision: application\.revision/);
  assert.match(directSave, /replacement: \{/);
  assert.doesNotMatch(directSave, /trialAppointments:/);
  assert.match(directSave, /validatePersonnelCandidateTrialRow\(row, \{ reportInvalid: true \}\)/);
  assert.ok(
    directSave.indexOf("validatePersonnelCandidateTrialRow(row, { reportInvalid: true })")
      < directSave.indexOf("canWritePersonnelCandidateStructuredScope(appointment)"),
    "Die konkrete Terminzeile muss vor der Scope-Prüfung sichtbar validiert werden.",
  );
  assert.match(directSave, /Schnuppertermine dürfen nur im freigegebenen eigenen Bereich gespeichert werden/);
  assert.match(app, /event\.submitter\?\.closest\("\[data-candidate-save-trial\]"\)/);
  assert.match(app, /savePersonnelCandidateTrialAppointment\(applicationForm, trialSubmit\)/);
  assert.match(app, /personnelCandidatePendingDirectTrialRow\(form\)/);

  assert.match(styles, /\.personnel-candidate-trial-cancellation-summary/);
  assert.match(styles, /\.personnel-candidate-trial-cancelled-meta/);
  assert.match(styles, /\.personnel-candidate-trial-link/);
  assert.match(styles, /\.personnel-candidate-trial-row\.is-direct-edit/);
  assert.match(styles, /\.personnel-candidate-trial-row-actions \{[^}]*flex-wrap:wrap/);
  assert.match(styles, /\.personnel-candidate-trial-cancellation,.personnel-candidate-trial-cancelled-meta,.personnel-candidate-trial-relation,.personnel-candidate-trial-row-actions \{ grid-column:1; \}/);
});

test("Foto, Teamfeedback und Bearbeitung bleiben capability- und revisionsgebunden", () => {
  const photoUpload = between(
    app,
    "async function uploadPersonnelCandidatePhoto(",
    "function syncPersonnelCandidateAuthorizationState(",
  );
  assert.match(photoUpload, /new FormData\(\)/);
  assert.match(photoUpload, /formData\.append\("document", file/);
  assert.match(photoUpload, /\/personnel-lifecycle\/candidates\/\$\{encodeURIComponent\(candidateId\)\}\/photo/);
  assert.match(photoUpload, /rawApi\(/);

  const profileEditor = between(
    app,
    "function renderPersonnelCandidateProfileEditor(",
    "function renderPersonnelCandidateStatusForm(",
  );
  assert.match(profileEditor, /!state\.personnelCandidateCapabilities\.canWriteCandidates/);
  assert.match(profileEditor, /!canWritePersonnelCandidatePhoto\(candidate\)/);
  assert.match(profileEditor, /data-personnel-candidate-photo-form/);
  const feedback = between(
    app,
    "async function savePersonnelCandidateTeamFeedback(",
    "function handlePersonnelCandidateDetailSubmit(",
  );
  assert.match(feedback, /!canWritePersonnelCandidateApplication\(application\)/);
  assert.match(feedback, /\/applications\/\$\{encodeURIComponent\(application\.id\)\}\/team-feedback/);
  assert.match(feedback, /method: "POST"/);
  for (const field of ["employeeNumber", "trialAppointmentId", "rating", "comment", "revision: application.revision"]) {
    assert.match(feedback, new RegExp(field.replaceAll(".", "\\.")));
  }
  const applicationEditor = between(
    app,
    "function renderPersonnelCandidateApplication(",
    "function renderPersonnelCandidateDetail(",
  );
  assert.match(applicationEditor, /const canWrite = canWritePersonnelCandidateApplication\(application\)/);
  assert.match(applicationEditor, /\$\{canWrite \? `<details/);
  assert.match(app, /function canWritePersonnelCandidateApplication\(application\)[\s\S]*?application\?\.canWrite === true/);
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
    "applicationWriteScope",
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
  assert.match(capabilities, /applicationWriteScope: submitted\.applicationWriteScope/);
  assert.match(app, /if \(!capabilities\.canReadCandidates\) \{[\s\S]*?clearPersonnelLifecycleCandidateState/);
});

test("schreibende Bewerberauswahlen verwenden ausschließlich den serverprojizierten Schreibbereich", () => {
  const locationOptions = between(
    app,
    "function personnelCandidateLocationOptions(",
    "function personnelCandidateDepartmentOptions(",
  );
  const departmentOptions = between(
    app,
    "function personnelCandidateDepartmentOptions(",
    "function renderPersonnelCandidateTargetAreaEditorRow(",
  );
  const teamOptions = between(
    app,
    "function personnelCandidateTeamEmployeeOptions(",
    "function renderPersonnelCandidateTeamFeedback(",
  );
  const createLocations = between(
    app,
    "function populatePersonnelCandidateCreateLocations()",
    "function updatePersonnelCandidateCreateDepartments()",
  );
  assert.match(locationOptions, /scopeMode === "create"[\s\S]*?createScope[\s\S]*?applicationWriteScope/);
  assert.match(departmentOptions, /scopeMode === "create"[\s\S]*?createScope[\s\S]*?applicationWriteScope/);
  assert.match(teamOptions, /const applicationWriteScope = state\.personnelCandidateCapabilities\.applicationWriteScope/);
  assert.match(teamOptions, /writableLocationIds\.has\(employee\.locationId\)/);
  assert.doesNotMatch(teamOptions, /personnelCandidateCapabilities\.scope/);
  assert.match(createLocations, /capabilities\.createScope\?\.locationIds/);
  assert.doesNotMatch(createLocations, /applicationWriteScope/);
});

test("Statuswechsel bleibt capability- und revisionsgebunden", () => {
  const form = between(
    app,
    "function renderPersonnelCandidateStatusForm(",
    "function renderPersonnelCandidateApplication(",
  );
  assert.match(form, /!canWritePersonnelCandidateApplication\(application\)/);
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
  assert.match(styles, /@media \(max-width:420px\) \{[\s\S]*?\.personnel-candidate-rating-summary article > header \{ grid-template-columns:minmax\(0,1fr\); \}/);
  assert.match(styles, /@media \(max-width:420px\) \{[\s\S]*?\.personnel-candidate-rating-summary \.personnel-candidate-rating-display \{ justify-self:end; max-width:100%; \}/);
});

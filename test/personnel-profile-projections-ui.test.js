"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const html = read("public/index.html");
const app = read("public/app.js");
const styles = read("public/styles.css");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("M7-Profilregister verwenden eine feste GET-Positivliste und laden ausschließlich lazy", () => {
  const contract = between(app, "const EMPLOYEE_PROFILE_TABS", "const EMPLOYEE_PROFILE_MASTER_DATA_FIELDS");
  assert.match(contract, /id: "overview", endpointTab: "overview", capability: "canReadOverview"/);
  assert.match(contract, /id: "masterData", endpointTab: "master_org", capability: "canReadMasterOrg"/);
  assert.match(contract, /id: "documents", endpointTab: "documents", capability: "canReadDocuments"/);
  for (const locked of ["onboarding", "training", "offboarding", "history"]) {
    assert.match(contract, new RegExp(`id: "${locked}", label:`));
    assert.doesNotMatch(contract, new RegExp(`id: "${locked}", endpointTab:`));
  }

  const loader = between(app, "async function loadEmployeeProfileTab", "function loadEmployeeProfileOverview");
  assert.match(loader, /profile\?tab=\$\{definition\.endpointTab\}/);
  assert.match(loader, /!definition\?\.endpointTab/);
  assert.match(loader, /state\.employeeProfileTabAvailability\[tabId\] !== true/);
  assert.match(loader, /employeeProfileTabHasData\(tabId\)/);
  assert.doesNotMatch(loader, /method\s*:|\bPOST\b|\bPUT\b|\bPATCH\b|\bDELETE\b/);

  const opener = between(app, "function openEmployeeProfile", "function closeEmployeeProfile");
  assert.match(opener, /loadEmployeeProfileOverview\(normalizedEmployeeNumber\)/);
  assert.doesNotMatch(opener, /master_org|tab=documents/);
});

test("M7-Stammdaten- und Dokumentnormalisierung kopiert nur harte Positivlisten", () => {
  const normalizers = between(app, "function normalizeEmployeeProfileHeader", "function employeeProfileInitials");
  assert.match(normalizers, /EMPLOYEE_PROFILE_MASTER_DATA_FIELDS\.flatMap/);
  assert.match(normalizers, /employeeProfileProjectedPath\(source, definition\.key\)/);
  assert.doesNotMatch(normalizers, /Object\.entries\(source\)|\.\.\.source/);
  assert.match(normalizers, /visibility !== "hr_confidential"/);
  for (const allowed of [
    "id", "status", "category", "visibility", "title", "documentDate", "description",
    "originalFilename", "detectedMime", "byteSize", "currentVersion", "revision",
    "archivedAt", "createdAt", "updatedAt",
  ]) assert.match(normalizers, new RegExp(`\\b${allowed}\\b`), allowed);
  for (const forbidden of ["storageKey", "storage_key", "sha256", "receiptSha256", "actorEmployeeNumber", "protectedPayload", "protected_payload", "content"]) {
    assert.doesNotMatch(normalizers, new RegExp(`\\b${forbidden}\\b`, "i"), forbidden);
  }
});

test("M7-Renderer bleiben read-only und geben keine Dokumentinhalte oder technischen Nachweise aus", () => {
  const renderers = between(app, "function renderEmployeeProfileMasterData", "function renderEmployeeProfile()");
  assert.match(renderers, /renderEmployeeProfileDocuments/);
  assert.match(renderers, /ausschließlich freigegebene Metadaten und Versionsstände/);
  assert.match(renderers, /Dateiinhalte, Speicherpfade und technische Prüfnachweise werden nicht geladen/);
  assert.doesNotMatch(renderers, /<form\b|<input\b|<textarea\b|<select\b|<a\b|href=|type="submit"|data-(?:save|delete|archive|upload)-/i);
  assert.doesNotMatch(renderers, /storageKey|storage_key|sha256|receipt|protectedPayload|protected_payload/i);
});

test("M7 löscht vertrauliche Tabdaten bei Wechsel, Zugriffsfehler, Profilwechsel und Verlassen", () => {
  const lifecycle = between(app, "function syncEmployeeProfileWorkspace", "function renderCostCenterTypes");
  assert.match(lifecycle, /function clearEmployeeProfileSensitiveTabs/);
  assert.match(lifecycle, /state\.employeeProfileTabData\[tabId\] = null/);
  assert.match(lifecycle, /if \(state\.employeeProfileTab !== definition\.id\) clearEmployeeProfileSensitiveTabs/);
  assert.match(lifecycle, /\[401, 403, 404\]\.includes\(error\.status\)/);
  assert.match(lifecycle, /invalidateEmployeeProfileData/);
  assert.match(lifecycle, /resetEmployeeProfileData\(\{ accessPending: true \}\)/);
  assert.match(lifecycle, /resetEmployeeProfileData\(\)/);
  assert.match(lifecycle, /renderEmployeeProfile\(\);[\s\S]*syncEmployeeProfileWorkspace\(\)/);

  const viewSwitch = between(app, "function setView(view)", "function applyRequestedView");
  assert.match(viewSwitch, /employeeProfileIsOpen\(\) && view !== profileView/);
  assert.match(viewSwitch, /closeEmployeeProfile\(\{ restoreFocus: false \}\)/);
  const loginGate = between(app, "function showLoginGate", "function hideLoginGate");
  assert.match(loginGate, /employeeProfileIsOpen\(\).*closeEmployeeProfile/);
});

test("M7 berechnet Profilzugriff bei Feature-, Rechte- und Bereichswechsel neu", () => {
  const accessFunctions = [
    between(app, "const EMPLOYEE_PROFILE_MASTER_DATA_FIELDS", "const EMPLOYEE_PROFILE_DOCUMENT_STATUSES"),
    between(app, "function employeeProfileMasterDataFieldFingerprint", "function employeeProfileIsOpen"),
    between(app, "function canOpenEmployeeProfileFoundation", "function canReadCandidatePreboarding"),
  ].join("\n");
  const feature = { enabled: true };
  const state = {
    portalStatus: { portalEnabled: true },
    employeeProfileHost: "administration",
    employeeProfileEmployeeNumber: "M7-001",
    allEmployees: [{
      personnel_number: "M7-001",
      personnel_profile_access: { available: true },
    }],
    portalSession: {
      user: {
        role: "hr",
        permissions: [
          "personnel:central:read",
          "personnel:profiles:read",
          "personnel:profiles:master:read",
          "personnel:profiles:documents:read",
          "personnel:sensitive:read",
        ],
        personnelRecordAccess: {
          fieldAccess: { "identity.firstName": "read", phone: "read", documents: "read" },
          canReadDocuments: true,
        },
      },
    },
  };
  const sandbox = {
    state,
    personnelLifecycleFoundationEnabled: () => feature.enabled,
    canReadCentralPersonnel: () => (
      state.portalSession.user.permissions.includes("personnel:central:read")
    ),
    hasGovernancePermission: (permission) => (
      state.portalSession.user.permissions.includes(permission)
    ),
    result: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(accessFunctions, sandbox);
  const calculate = () => {
    vm.runInContext("result = currentEmployeeProfileAccess();", sandbox);
    return sandbox.result;
  };

  let result = calculate();
  assert.equal(result.read, true);
  assert.equal(result.masterData, true);
  assert.equal(result.documents, true);
  const completeFieldFingerprint = result.masterDataFieldFingerprint;

  delete state.portalSession.user.personnelRecordAccess.fieldAccess.phone;
  result = calculate();
  assert.equal(result.masterData, true);
  assert.notEqual(result.masterDataFieldFingerprint, completeFieldFingerprint);
  state.portalSession.user.personnelRecordAccess.fieldAccess.phone = "read";

  state.portalSession.user.permissions = state.portalSession.user.permissions
    .filter((permission) => permission !== "personnel:sensitive:read");
  result = calculate();
  assert.equal(result.read, true);
  assert.equal(result.masterData, false);
  assert.equal(result.documents, false);

  state.portalSession.user.permissions = state.portalSession.user.permissions
    .filter((permission) => permission !== "personnel:profiles:read");
  result = calculate();
  assert.equal(result.read, false);
  assert.equal(result.masterData, false);
  assert.equal(result.documents, false);

  feature.enabled = false;
  result = calculate();
  assert.equal(result.read, false);
  feature.enabled = true;

  state.employeeProfileHost = "team";
  state.portalSession.user.role = "manager";
  state.portalSession.user.permissions = [
    "personnel:profiles:read",
    "personnel:profiles:master:read",
  ];
  result = calculate();
  assert.equal(result.read, true);
  assert.equal(result.masterData, true);
  assert.equal(result.documents, false);

  state.allEmployees[0].personnel_profile_access.available = false;
  result = calculate();
  assert.equal(result.read, false);
  assert.equal(result.masterData, false);
});

test("M7 verwirft geladene vertrauliche Daten und laufende Antworten bei Rechteentzug", () => {
  const lifecycle = between(
    app,
    "function employeeProfileSensitiveAccessWasExposed",
    "function renderCostCenterTypes",
  );
  const createState = ({ documentsExposed = true } = {}) => ({
    employeeProfile: { employeeNumber: "M7-001" },
    employeeProfileOpen: true,
    employeeProfileEmployeeNumber: "M7-001",
    employeeProfileTab: documentsExposed ? "documents" : "overview",
    employeeProfileHost: "administration",
    employeeProfileTabData: {
      masterData: { fields: [
        { key: "identity.firstName", value: "Mara" },
        { key: "phone", value: "+43 512 555" },
      ] },
      documents: documentsExposed ? [{ id: "doc-sensitive" }] : null,
    },
    employeeProfileTabAvailability: {
      overview: true,
      masterData: true,
      documents: documentsExposed,
    },
    employeeProfileLoadingTabs: new Set(documentsExposed ? ["documents"] : []),
    employeeProfileTabErrors: {},
    employeeProfileTabRequestTokens: documentsExposed ? { documents: Symbol("old-document-request") } : {},
    employeeProfileTabAccessFingerprints: {
      masterData: "identity.firstName\0phone",
    },
    employeeProfileLoading: documentsExposed,
    employeeProfileLoadError: "",
    employeeProfileRequestToken: Symbol("old-profile-request"),
    employeeProfileReturnFocus: null,
  });
  const runReconciliation = (state, access) => {
    const oldProfileToken = state.employeeProfileRequestToken;
    let renderedWithSensitiveData = null;
    let workspaceSyncs = 0;
    const sandbox = {
      state,
      access,
      employeeProfileIsOpen: () => state.employeeProfileOpen === true,
      renderEmployeeProfile: () => {
        renderedWithSensitiveData = Boolean(
          state.employeeProfileTabData.masterData || state.employeeProfileTabData.documents,
        );
      },
      syncEmployeeProfileWorkspace: () => { workspaceSyncs += 1; },
      result: null,
    };
    vm.runInNewContext(`${lifecycle}\nresult = reconcileOpenEmployeeProfileAccess(access);`, sandbox);
    return { ...sandbox, oldProfileToken, renderedWithSensitiveData, workspaceSyncs };
  };

  const revokedState = createState();
  const revoked = runReconciliation(revokedState, {
    read: true,
    masterData: true,
    documents: false,
    masterDataFieldFingerprint: "identity.firstName\0phone",
  });
  assert.equal(revoked.result, false);
  assert.equal(revokedState.employeeProfileOpen, false);
  assert.equal(revokedState.employeeProfileEmployeeNumber, "");
  assert.equal(JSON.stringify(revokedState.employeeProfileTabData), JSON.stringify({ masterData: null, documents: null }));
  assert.equal(Object.keys(revokedState.employeeProfileTabRequestTokens).length, 0);
  assert.equal(Object.keys(revokedState.employeeProfileTabAccessFingerprints).length, 0);
  assert.equal(revokedState.employeeProfileLoadingTabs.size, 0);
  assert.notEqual(revokedState.employeeProfileRequestToken, revoked.oldProfileToken);
  assert.equal(revoked.renderedWithSensitiveData, false);
  assert.equal(revoked.workspaceSyncs, 1);

  const unavailableByDesignState = createState({ documentsExposed: false });
  const unchanged = runReconciliation(unavailableByDesignState, {
    read: true,
    masterData: true,
    documents: false,
    masterDataFieldFingerprint: "identity.firstName\0phone",
  });
  assert.equal(unchanged.result, true);
  assert.equal(unavailableByDesignState.employeeProfileOpen, true);
  assert.equal(unchanged.workspaceSyncs, 0);

  const fieldRevokedState = createState({ documentsExposed: false });
  const fieldRevoked = runReconciliation(fieldRevokedState, {
    read: true,
    masterData: true,
    documents: false,
    masterDataFieldFingerprint: "identity.firstName",
  });
  assert.equal(fieldRevoked.result, false);
  assert.equal(fieldRevokedState.employeeProfileOpen, false);
  assert.equal(fieldRevoked.renderedWithSensitiveData, false);

  const readRevokedState = createState({ documentsExposed: false });
  const readRevoked = runReconciliation(readRevokedState, {
    read: false,
    masterData: false,
    documents: false,
    masterDataFieldFingerprint: "",
  });
  assert.equal(readRevoked.result, false);
  assert.equal(readRevokedState.employeeProfileOpen, false);
  assert.equal(readRevoked.renderedWithSensitiveData, false);
});

test("M7-Teamzugang hängt fail-closed an der serverseitigen Subject-Capability", () => {
  const renderer = between(app, "function renderEmployees()", "function renderLocations()");
  assert.match(renderer, /employee\.personnel_profile_access\?\.available === true/);
  assert.match(renderer, /data-team-employee-profile-access="true"/);
  const capabilityGate = between(renderer, "const canOpenProfile", "return `<tr>");
  assert.doesNotMatch(capabilityGate, /manager|department_manager|role|permissions|scope/i);

  const eventHandler = between(
    app,
    'elements.employeeTableBody.addEventListener("click"',
    "elements.locationList.addEventListener",
  );
  assert.match(eventHandler, /data-team-employee-profile-access=\\"true\\"/);
  assert.match(eventHandler, /openEmployeeProfile\(profileButton\.dataset\.teamEmployeeProfile, profileButton\)/);
  assert.match(html, /id="employeeProfileAdministrationMount"/);
  assert.match(html, /id="employeeProfileTeamMount"/);
  assert.equal((html.match(/id="employeeProfileWorkspace"/g) || []).length, 1);
});

test("M7-Tabs sind tastaturbedienbar und bleiben mobil ohne Seitenüberlauf", () => {
  const handlers = between(
    app,
    "elements.employeeProfileBackButton?.addEventListener",
    "elements.costCenterList?.addEventListener",
  );
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) assert.match(handlers, new RegExp(key));
  assert.match(handlers, /event\.preventDefault\(\)/);
  assert.match(handlers, /setEmployeeProfileTab\([\s\S]*\{ focus: true \}/);
  assert.match(html, /role="tablist"[^>]*aria-orientation="horizontal"/);
  assert.match(html, /id="employeeProfileContent"[^>]*role="tabpanel"[^>]*tabindex="0"/);
  assert.match(styles, /\.employee-profile-tab:focus-visible/);
  assert.match(styles, /\.employee-profile-content \{[^}]*min-width:0;[^}]*overflow-x:hidden;/);
  assert.match(styles, /\.employee-profile-data-grid \{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.employee-profile-document-meta \{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media \(max-width: 600px\) \{[\s\S]*?\.employee-profile-data-grid,\.employee-profile-document-meta \{ grid-template-columns:1fr; \}/);
});

test("M7-Profilrechte behalten die clientseitigen Leserechts-Abhängigkeiten", () => {
  const dependencies = between(app, "const permissionDependencyRules", "async function loadPortalUsers");
  for (const permissionId of [
    "personnel:profiles:master:read",
    "personnel:profiles:documents:read",
    "personnel:profiles:delegate",
  ]) {
    const offset = dependencies.indexOf(`permissionId: "${permissionId}"`);
    assert.notEqual(offset, -1, permissionId);
    assert.match(dependencies.slice(offset, offset + 180), /requiredPermissionId: "personnel:profiles:read"/);
  }
  const scopeDecision = between(app, "function rightsEditorPermissionIsOrganizational", "function rightsEditorAnnounce");
  assert.match(scopeDecision, /permission\?\.scopeBehavior === "organizational"/);
  assert.doesNotMatch(scopeDecision, /personnel:profiles:/);
});

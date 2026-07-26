"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-block7-personnel-rules-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db, releaseInstanceLockForTests } = subject;
const {
  addCollectiveAgreementVersion,
  createBusinessUnit,
  createCollectiveAgreement,
  prepareCollectiveAgreementAssignment,
} = require("../lib/collective-agreements");
const {
  addCustomWorkRuleDraftRevision,
  createCustomWorkRuleDraft,
  publishCustomWorkRuleDraft,
} = require("../lib/work-rules/custom-rules");

const HR = "block7-hr";
const HR_NO_AUDIT = "block7-hr-no-audit";
const MANAGER = "block7-manager";
const DEPARTMENT_MANAGER = "block7-department-manager";
const REVIEW_MANAGER = "block7-review-manager";
const EMPLOYEE = "block7-employee";
const LOCAL_EMPLOYEE = "block7-local-employee";
const SIBLING_EMPLOYEE = "block7-sibling-employee";
const FOREIGN_EMPLOYEE = "block7-foreign-employee";
const BUILTIN_VERSION_ID = "at-retail-adult-monitor@2026.1";

let httpServer;
let baseUrl;
let hrSession;
let hrNoAuditSession;
let managerSession;
let departmentManagerSession;
let reviewManagerSession;
let employeeSession;
let localLocationId;
let foreignLocationId;
let localDepartmentId;
let siblingDepartmentId;
let foreignDepartmentId;
let ownDepartmentKvFixture;
let historicalKvFixture;
let historicalRuleProfileFixture;

function createSession(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return {
    cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

async function request(route, { session = hrSession, method = "GET", body = null } = {}) {
  const mutation = !["GET", "HEAD"].includes(method);
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Accept: "application/json",
      Cookie: session.cookie,
      ...(mutation ? {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
      } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

function insertEmployee(personnelNumber, name, locationId, departmentId = null) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id,
       preferred_department_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, 1)
  `).run(personnelNumber, name, name.split(" ")[0], locationId, departmentId);
}

function insertAssignment(id, scopeType, scopeKey, profileVersionId = BUILTIN_VERSION_ID) {
  db.prepare(`
    INSERT INTO work_rule_assignments
      (id, profile_version_id, scope_type, scope_key, valid_from, valid_to,
       enforcement_mode, applicability_confirmed, confirmed_by, confirmed_at,
       active, created_by)
    VALUES (?, ?, ?, ?, '2026-01-01', NULL, 'monitor', 1,
      'block7-confirmed-by-secret', CURRENT_TIMESTAMP, 1, 'block7-created-by-secret')
  `).run(id, profileVersionId, scopeType, String(scopeKey || ""));
}

function collectiveAgreementVersion(marker) {
  return {
    versionLabel: "2026",
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    externalPublishedOn: "2025-12-15",
    sourceTitle: `${marker} official source`,
    sourceUrl: `https://example.invalid/${marker.toLowerCase()}.pdf`,
    sourceRetrievedOn: "2026-07-26",
    sourceSha256: crypto.createHash("sha256").update(marker).digest("hex"),
    sourceNote: "Documented source; no full text is stored.",
    contractingParties: ["Employer side", "Employee side"],
    territorialScope: "Austria",
    functionalScope: marker,
    personalScope: "Scope must remain organizationally bound.",
    employeeGroups: ["Employees"],
    workTimeParametersNote: "Derived parameters require a cited source.",
    classificationNote: "Classification remains a separate review.",
    apprenticeRelevance: "no",
    apprenticeNote: "",
  };
}

function createKvFixture(code, marker, scopeType, scopeKey) {
  const agreement = createCollectiveAgreement(db, {
    code,
    title: `${marker} collective agreement`,
    shortTitle: marker,
    jurisdiction: "AT",
    note: `${marker} register entry`,
    version: collectiveAgreementVersion(marker),
  }, `kv-secret-${marker.toLowerCase()}`);
  const businessUnit = createBusinessUnit(db, {
    code: `BU-${code}`,
    name: `${marker} business unit`,
    legalEntityName: "Block 7 Test GmbH",
    description: `${marker} organizational scope`,
    scopes: [{ scopeType, scopeKey: String(scopeKey) }],
  }, `business-unit-secret-${marker.toLowerCase()}`);
  const assignment = prepareCollectiveAgreementAssignment(db, {
    agreementVersionId: agreement.currentVersionId,
    businessUnitId: businessUnit.id,
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    rationale: `${marker} assignment rationale`,
    referenceNote: `${marker} assignment reference`,
    reviewState: "review_pending",
  }, `assignment-secret-${marker.toLowerCase()}`);
  return { agreement, businessUnit, assignment };
}

function createHistoricalKvFixture(code, marker, businessUnit) {
  const original = createCollectiveAgreement(db, {
    code,
    title: `${marker} collective agreement`,
    shortTitle: marker,
    jurisdiction: "AT",
    note: `${marker} register entry`,
    version: collectiveAgreementVersion(`${marker}-HISTORICAL`),
  }, `kv-secret-${marker.toLowerCase()}-historical`);
  const assignedVersionId = original.currentVersionId;
  const agreement = addCollectiveAgreementVersion(db, original.id, {
    ...collectiveAgreementVersion(`${marker}-CURRENT`),
    versionLabel: "2027",
    validFrom: "2027-01-01",
    validTo: "2027-12-31",
    externalPublishedOn: "2026-06-15",
  }, `kv-secret-${marker.toLowerCase()}-current`);
  const assignment = prepareCollectiveAgreementAssignment(db, {
    agreementVersionId: assignedVersionId,
    businessUnitId: businessUnit.id,
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    rationale: `${marker} historical assignment rationale`,
    referenceNote: `${marker} historical assignment reference`,
    reviewState: "review_pending",
  }, `assignment-secret-${marker.toLowerCase()}`);
  return { agreement, assignedVersionId, businessUnit, assignment };
}

function scopedHistoryRulePayload(title, validFrom, validTo) {
  return {
    code: "BLOCK7-SCOPED-HISTORY",
    title,
    description: "Versioned internal rule used to verify a historical scoped profile response.",
    ruleType: "company_rule",
    topic: "working_time",
    scopeType: "department",
    scopeKey: String(localDepartmentId),
    validFrom,
    validTo,
    metric: "maximum_planned_daily_minutes",
    threshold: 480,
    severity: "warning",
    reaction: "advisory",
    message: "The scoped historical profile fixture threshold was exceeded.",
    responsibleUnit: "Personalleitung",
    sourceTitle: `${title} source`,
    sourceReference: "BLOCK7-SCOPED-HISTORY-2026",
    sourceUrl: "https://example.invalid/block7-scoped-history",
    sourceNote: "Internal regression fixture without legal assessment.",
    testCases: {
      positiveValue: 480,
      negativeValue: 481,
    },
    status: "draft",
    enforcementMode: "monitor",
  };
}

function assertNoGovernanceAuditFields(value, label = "governance payload") {
  const forbidden = new Set([
    "actoremployeenumber",
    "actorrole",
    "confirmedby",
    "createdby",
    "permissionused",
    "publishedby",
    "subjectauthor",
    "submittedby",
    "submittedpermission",
    "submittedrole",
    "updatedby",
  ]);
  const visit = (entry, path = label) => {
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!entry || typeof entry !== "object") return;
    for (const [key, item] of Object.entries(entry)) {
      const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
      assert.equal(
        normalizedKey.includes("receipt") || forbidden.has(normalizedKey),
        false,
        `${path}.${key}`,
      );
      if (normalizedKey === "decisions" || normalizedKey === "events") {
        assert.deepEqual(item, [], `${path}.${key}`);
      }
      visit(item, `${path}.${key}`);
    }
  };
  visit(value);
}

function ids(entries) {
  return entries.map((entry) => entry.id).sort();
}

function codes(entries) {
  return entries.map((entry) => entry.code).sort();
}

test.before(async () => {
  const localLocation = db.prepare(`
    SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1
  `).get();
  localLocationId = String(localLocation.id);
  foreignLocationId = String(
    Array.from({ length: 30 }, (_, index) => 140 + index)
      .find((id) => !db.prepare("SELECT 1 FROM locations WHERE id = ?").get(String(id))),
  );
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, day_settings_json, active)
    VALUES (?, 'Block 7 Foreign Location', 1, '', 1)
  `).run(foreignLocationId);
  localDepartmentId = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active)
    VALUES (?, 'Block 7 Own Department', 0, 1)
    RETURNING id
  `).get(localLocationId).id);
  siblingDepartmentId = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active)
    VALUES (?, 'Block 7 Sibling Department', 0, 1)
    RETURNING id
  `).get(localLocationId).id);
  foreignDepartmentId = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active)
    VALUES (?, 'Block 7 Foreign Department', 0, 1)
    RETURNING id
  `).get(foreignLocationId).id);

  insertEmployee(HR, "Helena Global", localLocationId, localDepartmentId);
  insertEmployee(HR_NO_AUDIT, "Hanna No Audit", localLocationId, localDepartmentId);
  insertEmployee(MANAGER, "Mara Location", localLocationId, localDepartmentId);
  insertEmployee(DEPARTMENT_MANAGER, "Dora Department", localLocationId, localDepartmentId);
  insertEmployee(REVIEW_MANAGER, "Rita Scoped Review", localLocationId, localDepartmentId);
  insertEmployee(EMPLOYEE, "Emil No Rights", localLocationId, localDepartmentId);
  insertEmployee(LOCAL_EMPLOYEE, "Lena Own Team", localLocationId, localDepartmentId);
  insertEmployee(SIBLING_EMPLOYEE, "Sina Sibling Team", localLocationId, siblingDepartmentId);
  insertEmployee(FOREIGN_EMPLOYEE, "Franz Foreign Team", foreignLocationId, foreignDepartmentId);

  hrSession = createSession(HR, "hr");
  hrNoAuditSession = createSession(HR_NO_AUDIT, "hr");
  managerSession = createSession(MANAGER, "manager");
  departmentManagerSession = createSession(DEPARTMENT_MANAGER, "department_manager");
  reviewManagerSession = createSession(REVIEW_MANAGER, "department_manager");
  employeeSession = createSession(EMPLOYEE, "employee");
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, 'block7-test')
  `).run(MANAGER, localLocationId);
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, ?, 'block7-test')
  `).run(DEPARTMENT_MANAGER, localLocationId, localDepartmentId);
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, ?, 'block7-test')
  `).run(REVIEW_MANAGER, localLocationId, localDepartmentId);
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'work_rules:review', ?)
  `).run(REVIEW_MANAGER, HR);
  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, 'work_rules:audit', ?)
  `).run(HR_NO_AUDIT, HR);

  insertAssignment("block7-installation", "installation", "");
  insertAssignment("block7-location", "location", localLocationId);
  insertAssignment("block7-own-department", "department", localDepartmentId);
  insertAssignment("block7-sibling-department", "department", siblingDepartmentId);
  insertAssignment("block7-foreign-department", "department", foreignDepartmentId);
  insertAssignment("block7-own-employee", "employee", LOCAL_EMPLOYEE);
  insertAssignment("block7-sibling-employee", "employee", SIBLING_EMPLOYEE);
  insertAssignment("block7-foreign-employee", "employee", FOREIGN_EMPLOYEE);
  db.prepare(`
    INSERT INTO work_rule_profiles
      (id, name, description, jurisdiction, sector, builtin, status,
       current_version_id, created_by, updated_by)
    VALUES ('custom:block7-private-unassigned', 'FOREIGN-PRIVATE-PROFILE-MARKER',
      'Unassigned internal draft', 'AT', 'internal', 0, 'draft', NULL,
      'foreign-profile-secret', 'foreign-profile-secret')
  `).run();

  createKvFixture("B7-LOCATION", "LOCATION-MARKER", "location", localLocationId);
  ownDepartmentKvFixture = createKvFixture(
    "B7-OWN-DEPT",
    "OWN-DEPARTMENT-MARKER",
    "department",
    localDepartmentId,
  );
  createKvFixture("B7-SIBLING", "SIBLING-DEPARTMENT-MARKER", "department", siblingDepartmentId);
  createKvFixture("B7-FOREIGN", "FOREIGN-ONLY-MARKER", "location", foreignLocationId);
  historicalKvFixture = createHistoricalKvFixture(
    "B7-HISTORICAL",
    "HISTORICAL-MARKER",
    ownDepartmentKvFixture.businessUnit,
  );
  const historicalDraft = createCustomWorkRuleDraft(
    db,
    scopedHistoryRulePayload(
      "VISIBLE-HISTORICAL-PROFILE-MARKER",
      "2026-01-01",
      "2026-12-31",
    ),
    HR,
  );
  const historicalRelease = publishCustomWorkRuleDraft(
    db,
    historicalDraft.currentVersionId,
    HR,
  );
  const currentDraft = addCustomWorkRuleDraftRevision(
    db,
    historicalRelease.profileId,
    scopedHistoryRulePayload(
      "HIDDEN-CURRENT-PROFILE-MARKER",
      "2027-01-01",
      "2027-12-31",
    ),
    HR,
  );
  const currentRelease = publishCustomWorkRuleDraft(
    db,
    currentDraft.currentVersionId,
    HR,
  );
  historicalRuleProfileFixture = {
    profileId: historicalRelease.profileId,
    historicalVersionId: historicalRelease.releasedVersionId,
    currentVersionId: currentRelease.releasedVersionId,
  };
  insertAssignment(
    "block7-historical-custom-profile",
    "department",
    localDepartmentId,
    historicalRuleProfileFixture.historicalVersionId,
  );

  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Block 7/7: Filialleitung reads installation and own-location rule assignments only", async () => {
  const dashboard = await request("/api/work-rules/dashboard", { session: managerSession });
  assert.equal(dashboard.response.status, 200, JSON.stringify(dashboard.payload));
  assert.equal(dashboard.payload.scopeLabel, "Eigene zugewiesene Bereiche");
  assert.equal(dashboard.payload.locations.length, 1);
  assert.equal(dashboard.payload.locations[0].canSimulateWholeLocation, true);
  const dashboardIds = ids(dashboard.payload.assignments);
  for (const expected of [
    "builtin:at-retail-adult-monitor:installation",
    "block7-installation",
    "block7-location",
    "block7-own-department",
    "block7-sibling-department",
    "block7-own-employee",
    "block7-sibling-employee",
  ]) assert.ok(dashboardIds.includes(expected), expected);
  for (const forbidden of ["block7-foreign-department", "block7-foreign-employee"]) {
    assert.equal(dashboardIds.includes(forbidden), false, forbidden);
  }

  const assignments = await request("/api/work-rules/assignments?includeInactive=1", {
    session: managerSession,
  });
  assert.equal(assignments.response.status, 200, JSON.stringify(assignments.payload));
  const serialized = JSON.stringify(assignments.payload);
  assert.equal(serialized.includes("block7-foreign-department"), false);
  assert.equal(serialized.includes("block7-foreign-employee"), false);
  assert.equal(serialized.includes("block7-confirmed-by-secret"), false);
  assert.equal(serialized.includes("block7-created-by-secret"), false);
});

test("Block 7/7: Abteilungsleitung reads location-wide and own-department data, never sibling or foreign people", async () => {
  const dashboard = await request("/api/work-rules/dashboard", {
    session: departmentManagerSession,
  });
  assert.equal(dashboard.response.status, 200, JSON.stringify(dashboard.payload));
  assert.equal(dashboard.payload.locations.length, 1);
  assert.equal(dashboard.payload.locations[0].canSimulateWholeLocation, false);
  assert.deepEqual(
    dashboard.payload.locations[0].departments.map((department) => department.id),
    [localDepartmentId],
  );
  const dashboardIds = ids(dashboard.payload.assignments);
  for (const expected of [
    "builtin:at-retail-adult-monitor:installation",
    "block7-installation",
    "block7-location",
    "block7-own-department",
    "block7-own-employee",
  ]) assert.ok(dashboardIds.includes(expected), expected);
  for (const forbidden of [
    "block7-sibling-department",
    "block7-sibling-employee",
    "block7-foreign-department",
    "block7-foreign-employee",
  ]) assert.equal(dashboardIds.includes(forbidden), false, forbidden);

  const assignments = await request("/api/work-rules/assignments?includeInactive=1", {
    session: departmentManagerSession,
  });
  assert.equal(assignments.response.status, 200, JSON.stringify(assignments.payload));
  const serialized = JSON.stringify(assignments.payload);
  assert.equal(serialized.includes(SIBLING_EMPLOYEE), false);
  assert.equal(serialized.includes(FOREIGN_EMPLOYEE), false);
  assert.equal(serialized.includes("block7-confirmed-by-secret"), false);
  assert.equal(serialized.includes("block7-created-by-secret"), false);

  const wholeLocationPreview = await request("/api/work-rules/evaluate", {
    session: departmentManagerSession,
    method: "POST",
    body: {
      targetType: "planned_schedule",
      preview: true,
      weekStart: "2026-07-20",
      locationId: localLocationId,
      departmentId: "",
    },
  });
  assert.equal(wholeLocationPreview.response.status, 403, JSON.stringify(wholeLocationPreview.payload));
  assert.equal(wholeLocationPreview.payload.code, "PORTAL_SCOPE_DENIED");

  const ownDepartmentPreview = await request("/api/work-rules/evaluate", {
    session: departmentManagerSession,
    method: "POST",
    body: {
      targetType: "planned_schedule",
      preview: true,
      weekStart: "2026-07-20",
      locationId: localLocationId,
      departmentId: localDepartmentId,
    },
  });
  assert.equal(ownDepartmentPreview.response.status, 200, JSON.stringify(ownDepartmentPreview.payload));
});

test("Block 7/7: KV register exposes only agreements and organizational scopes relevant to each leadership scope", async () => {
  const manager = await request("/api/collective-agreements/registry", {
    session: managerSession,
  });
  assert.equal(manager.response.status, 200, JSON.stringify(manager.payload));
  assert.deepEqual(codes(manager.payload.agreements), [
    "B7-HISTORICAL",
    "B7-LOCATION",
    "B7-OWN-DEPT",
    "B7-SIBLING",
  ]);
  assert.deepEqual(
    [...new Set(manager.payload.assignments.map((entry) => entry.agreementCode))].sort(),
    ["B7-HISTORICAL", "B7-LOCATION", "B7-OWN-DEPT", "B7-SIBLING"],
  );
  const managerSerialized = JSON.stringify(manager.payload);
  assert.equal(managerSerialized.includes("FOREIGN-ONLY-MARKER"), false);
  assert.equal(managerSerialized.includes("kv-secret-"), false);
  assert.equal(managerSerialized.includes("business-unit-secret-"), false);
  assert.equal(managerSerialized.includes("assignment-secret-"), false);

  const department = await request("/api/collective-agreements/registry", {
    session: departmentManagerSession,
  });
  assert.equal(department.response.status, 200, JSON.stringify(department.payload));
  assert.deepEqual(codes(department.payload.agreements), [
    "B7-HISTORICAL",
    "B7-LOCATION",
    "B7-OWN-DEPT",
  ]);
  const departmentSerialized = JSON.stringify(department.payload);
  assert.equal(departmentSerialized.includes("SIBLING-DEPARTMENT-MARKER"), false);
  assert.equal(departmentSerialized.includes("FOREIGN-ONLY-MARKER"), false);
  assert.equal(departmentSerialized.includes("kv-secret-"), false);
});

test("Block 7/7: scoped KV history never impersonates a hidden current register version", async () => {
  const scoped = await request("/api/collective-agreements/registry", {
    session: departmentManagerSession,
  });
  assert.equal(scoped.response.status, 200, JSON.stringify(scoped.payload));
  const scopedAgreement = scoped.payload.agreements.find((entry) => entry.code === "B7-HISTORICAL");
  assert.ok(scopedAgreement, JSON.stringify(scoped.payload.agreements));
  assert.equal(scopedAgreement.currentVersionId, null);
  assert.deepEqual(
    scopedAgreement.versions.map((entry) => entry.id),
    [historicalKvFixture.assignedVersionId],
  );

  const global = await request("/api/collective-agreements/registry", { session: hrSession });
  assert.equal(global.response.status, 200, JSON.stringify(global.payload));
  const globalAgreement = global.payload.agreements.find((entry) => entry.code === "B7-HISTORICAL");
  assert.ok(globalAgreement, JSON.stringify(global.payload.agreements));
  assert.equal(globalAgreement.currentVersionId, historicalKvFixture.agreement.currentVersionId);
  assert.notEqual(globalAgreement.currentVersionId, historicalKvFixture.assignedVersionId);
  assert.equal(globalAgreement.versions.length, 2);
});

test("Block 7/7: unassigned private profiles stay global while effective installation profiles remain readable", async () => {
  const managerProfiles = await request("/api/work-rules/profiles", {
    session: managerSession,
  });
  assert.equal(managerProfiles.response.status, 200, JSON.stringify(managerProfiles.payload));
  assert.equal(
    managerProfiles.payload.profiles.some((entry) => entry.id === "custom:block7-private-unassigned"),
    false,
  );
  const managerHistorical = managerProfiles.payload.profiles.find((entry) => (
    entry.id === historicalRuleProfileFixture.profileId
  ));
  assert.ok(managerHistorical, JSON.stringify(managerProfiles.payload));
  assert.equal(managerHistorical.currentVersionId, null);
  assert.equal(managerHistorical.visibleVersionId, historicalRuleProfileFixture.historicalVersionId);
  assert.deepEqual(
    managerHistorical.visibleVersions.map((entry) => entry.id),
    [historicalRuleProfileFixture.historicalVersionId],
  );
  assert.equal(
    JSON.stringify(managerHistorical).includes("HIDDEN-CURRENT-PROFILE-MARKER"),
    false,
  );

  const departmentProfiles = await request("/api/work-rules/profiles", {
    session: departmentManagerSession,
  });
  assert.equal(departmentProfiles.response.status, 200, JSON.stringify(departmentProfiles.payload));
  assert.equal(
    departmentProfiles.payload.profiles.some((entry) => entry.id === "custom:block7-private-unassigned"),
    false,
  );
  const departmentHistorical = departmentProfiles.payload.profiles.find((entry) => (
    entry.id === historicalRuleProfileFixture.profileId
  ));
  assert.ok(departmentHistorical, JSON.stringify(departmentProfiles.payload));
  assert.equal(departmentHistorical.currentVersionId, null);
  assert.equal(departmentHistorical.visibleVersionId, historicalRuleProfileFixture.historicalVersionId);
  assert.equal(
    JSON.stringify(departmentHistorical).includes("HIDDEN-CURRENT-PROFILE-MARKER"),
    false,
  );

  const globalProfiles = await request("/api/work-rules/profiles", { session: hrSession });
  assert.equal(globalProfiles.response.status, 200, JSON.stringify(globalProfiles.payload));
  assert.equal(
    globalProfiles.payload.profiles.some((entry) => entry.id === "custom:block7-private-unassigned"),
    true,
  );
  const globalHistorical = globalProfiles.payload.profiles.find((entry) => (
    entry.id === historicalRuleProfileFixture.profileId
  ));
  assert.ok(globalHistorical, JSON.stringify(globalProfiles.payload));
  assert.equal(globalHistorical.currentVersionId, historicalRuleProfileFixture.currentVersionId);
  assert.equal(
    JSON.stringify(globalHistorical).includes("HIDDEN-CURRENT-PROFILE-MARKER"),
    true,
  );
});

test("Block 7/7: employee access is denied and sensitive governance or audit data remains global", async () => {
  for (const session of [managerSession, departmentManagerSession, employeeSession]) {
    for (const route of ["/api/work-rules/governance", "/api/work-rules/evaluations"]) {
      const denied = await request(route, { session });
      assert.equal(denied.response.status, 403, `${route}: ${JSON.stringify(denied.payload)}`);
      assert.equal(denied.payload.code, "PORTAL_PERMISSION_DENIED");
    }
  }
  for (const route of [
    "/api/work-rules/dashboard",
    "/api/work-rules/profiles",
    "/api/collective-agreements/registry",
  ]) {
    const denied = await request(route, { session: employeeSession });
    assert.equal(denied.response.status, 403, `${route}: ${JSON.stringify(denied.payload)}`);
    assert.equal(denied.payload.code, "PORTAL_PERMISSION_DENIED");
  }

  const governance = await request("/api/work-rules/governance", { session: hrSession });
  assert.equal(governance.response.status, 200, JSON.stringify(governance.payload));
  assert.equal(governance.payload.capabilities.canAudit, true);
  const evaluations = await request("/api/work-rules/evaluations", { session: hrSession });
  assert.equal(evaluations.response.status, 200, JSON.stringify(evaluations.payload));
  const dashboard = await request("/api/work-rules/dashboard", { session: hrSession });
  assert.equal(dashboard.response.status, 200, JSON.stringify(dashboard.payload));
  assert.equal(dashboard.payload.scopeLabel, "Unternehmensweite Lesesicht");
  assert.ok(ids(dashboard.payload.assignments).includes("block7-foreign-employee"));
  const assignments = await request("/api/work-rules/assignments?includeInactive=1", {
    session: hrSession,
  });
  assert.equal(assignments.response.status, 200, JSON.stringify(assignments.payload));
  assert.equal(JSON.stringify(assignments.payload).includes("block7-created-by-secret"), true);
  const registry = await request("/api/collective-agreements/registry", { session: hrSession });
  assert.equal(registry.response.status, 200, JSON.stringify(registry.payload));
  assert.deepEqual(codes(registry.payload.agreements), [
    "B7-FOREIGN",
    "B7-HISTORICAL",
    "B7-LOCATION",
    "B7-OWN-DEPT",
    "B7-SIBLING",
  ]);
  assert.equal(JSON.stringify(registry.payload).includes("kv-secret-foreign-only-marker"), true);
});

test("Block 7/7: delegated reviewers see only drafts and catalogs from their assigned scope", async () => {
  const localDraft = await request("/api/work-rules/drafts", {
    session: hrSession,
    method: "POST",
    body: {
      ...scopedHistoryRulePayload(
        "VISIBLE-LOCAL-DRAFT",
        "2031-01-01",
        "2031-12-31",
      ),
      code: "BLOCK7-VISIBLE-LOCAL-DRAFT",
    },
  });
  assert.equal(localDraft.response.status, 201, JSON.stringify(localDraft.payload));
  const foreignDraft = await request("/api/work-rules/drafts", {
    session: hrSession,
    method: "POST",
    body: {
      ...scopedHistoryRulePayload(
        "FOREIGN-SCOPE-SECRET-DRAFT",
        "2031-01-01",
        "2031-12-31",
      ),
      code: "BLOCK7-FOREIGN-DRAFT",
      scopeType: "department",
      scopeKey: String(foreignDepartmentId),
    },
  });
  assert.equal(foreignDraft.response.status, 201, JSON.stringify(foreignDraft.payload));

  const registry = await request("/api/work-rules/drafts", {
    session: reviewManagerSession,
  });
  assert.equal(registry.response.status, 200, JSON.stringify(registry.payload));
  const titles = registry.payload.drafts.map((draft) => draft.title);
  assert.ok(titles.includes("VISIBLE-LOCAL-DRAFT"), JSON.stringify(titles));
  assert.equal(titles.includes("FOREIGN-SCOPE-SECRET-DRAFT"), false);
  assert.equal(JSON.stringify(registry.payload).includes("FOREIGN-SCOPE-SECRET-DRAFT"), false);
  assert.equal(registry.payload.summary.drafts, registry.payload.drafts.length);
  assert.deepEqual(
    registry.payload.organizationalScopes.locations.map((location) => location.id),
    [localLocationId],
  );
  assert.deepEqual(
    registry.payload.organizationalScopes.locations[0].departments.map((department) => department.id),
    [String(localDepartmentId)],
  );
  assert.equal(
    registry.payload.organizationalScopes.businessUnits.some((unit) => unit.code === "BU-B7-FOREIGN"),
    false,
  );
});

test("Block 7/7: a scoped reviewer sees only current Scope-B metadata after a foreign Scope-A release", async () => {
  const hiddenScopeATitle = "FOREIGN-SCOPE-A-TITLE-SECRET";
  const hiddenScopeADescription = "Foreign Scope A description must never leave its organizational scope.";
  const visibleScopeBTitle = "VISIBLE-SCOPE-B-TITLE";
  const visibleScopeBDescription = "Visible Scope B description for the delegated local reviewer.";
  const scopeAActor = "foreign-scope-a-actor-secret";
  const scopeAPublisher = "foreign-scope-a-publisher-secret";

  const scopeADraft = createCustomWorkRuleDraft(
    db,
    {
      ...scopedHistoryRulePayload(hiddenScopeATitle, "2033-01-01", "2033-12-31"),
      code: "BLOCK7-SCOPE-METADATA-ISOLATION",
      description: hiddenScopeADescription,
      scopeType: "department",
      scopeKey: String(foreignDepartmentId),
    },
    scopeAActor,
  );
  const scopeARelease = publishCustomWorkRuleDraft(
    db,
    scopeADraft.currentVersionId,
    scopeAPublisher,
  );
  const scopeBRevision = addCustomWorkRuleDraftRevision(
    db,
    scopeARelease.profileId,
    {
      ...scopedHistoryRulePayload(visibleScopeBTitle, "2034-01-01", "2034-12-31"),
      code: "BLOCK7-SCOPE-METADATA-ISOLATION",
      description: visibleScopeBDescription,
      scopeType: "department",
      scopeKey: String(localDepartmentId),
    },
    "visible-scope-b-actor-secret",
  );

  const registry = await request("/api/work-rules/drafts", {
    session: reviewManagerSession,
  });
  assert.equal(registry.response.status, 200, JSON.stringify(registry.payload));
  const scopedDraft = registry.payload.drafts.find((draft) => draft.id === scopeARelease.profileId);
  assert.ok(scopedDraft, JSON.stringify(registry.payload.drafts));
  assert.equal(scopedDraft.title, visibleScopeBTitle);
  assert.equal(scopedDraft.description, visibleScopeBDescription);
  assert.equal(scopedDraft.currentVersionId, scopeBRevision.currentVersionId);
  assert.equal(scopedDraft.currentVersion.id, scopeBRevision.currentVersionId);
  assert.equal(scopedDraft.currentVersion.definition.scopeKey, String(localDepartmentId));
  assert.deepEqual(
    scopedDraft.versions.map((version) => version.id),
    [scopeBRevision.currentVersionId],
  );
  assert.equal(scopedDraft.publishedVersion, null);
  assert.equal(scopedDraft.effectiveVersionId, null);

  const serialized = JSON.stringify(scopedDraft);
  for (const secret of [
    hiddenScopeATitle,
    hiddenScopeADescription,
    scopeAActor,
    scopeAPublisher,
    scopeARelease.releasedVersionId,
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assertNoGovernanceAuditFields(scopedDraft, "registry.scopeBScopedDraft");
});

test("Block 7/7: delegated scoped reviewers receive decisions without audit identities or receipts", async () => {
  const validFrom = "2032-01-01";
  const draft = await request("/api/work-rules/drafts", {
    session: hrNoAuditSession,
    method: "POST",
    body: {
      code: "BLOCK7-SCOPED-REVIEW",
      title: "Block 7 scoped reviewer redaction",
      description: "Versioned internal rule used only to verify scoped governance redaction.",
      ruleType: "company_rule",
      topic: "working_time",
      scopeType: "location",
      scopeKey: localLocationId,
      validFrom,
      validTo: null,
      metric: "maximum_planned_daily_minutes",
      threshold: 480,
      severity: "warning",
      reaction: "advisory",
      message: "The scoped reviewer fixture threshold was exceeded.",
      responsibleUnit: "Personalleitung",
      sourceTitle: "Block 7 scoped reviewer fixture",
      sourceReference: "BLOCK7-SCOPED-REVIEW-2026",
      sourceUrl: "https://example.invalid/block7-scoped-review",
      sourceNote: "Internal regression fixture without legal assessment.",
      testCases: {
        positiveValue: 480,
        negativeValue: 481,
      },
      status: "draft",
      enforcementMode: "monitor",
    },
  });
  assert.equal(draft.response.status, 201, JSON.stringify(draft.payload));

  const input = {
    operation: "publish_rule",
    subjectType: "work_rule_profile_version",
    subjectId: draft.payload.draft.currentVersionId,
    payload: { effectiveOn: validFrom },
  };
  const preview = await request("/api/work-rules/governance/preview", {
    session: hrNoAuditSession,
    method: "POST",
    body: input,
  });
  assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
  assert.equal(preview.payload.preview.outcome, "pass");
  assertNoGovernanceAuditFields(preview.payload.preview.conflictRun, "preview.conflictRun");

  const submitted = await request("/api/work-rules/governance/requests", {
    session: hrNoAuditSession,
    method: "POST",
    body: {
      ...input,
      clientRequestId: crypto.randomUUID(),
      basisSha256: preview.payload.preview.basisSha256,
      conflictRunId: preview.payload.preview.conflictRunId,
      reason: "Scoped reviewer regression request for immutable KV assignment evidence.",
      sourceReference: "BLOCK7-SCOPED-REVIEW-2026",
    },
  });
  assert.equal(submitted.response.status, 201, JSON.stringify(submitted.payload));
  assert.equal(submitted.payload.governance.capabilities.canAudit, false);
  assert.equal(submitted.payload.request.submittedByCurrentActor, true);
  assert.deepEqual(submitted.payload.request.decisions, []);
  assertNoGovernanceAuditFields(submitted.payload.request, "submitted.request");

  const decision = await request(
    `/api/work-rules/governance/requests/${encodeURIComponent(submitted.payload.request.id)}/decisions`,
    {
      session: reviewManagerSession,
      method: "POST",
      body: {
        decision: "approve",
        reason: "The scoped professional review is complete.",
      },
    },
  );
  assert.equal(decision.response.status, 200, JSON.stringify(decision.payload));
  assert.equal(decision.payload.governance.capabilities.canReview, true);
  assert.equal(decision.payload.governance.capabilities.canAudit, false);
  assert.equal(decision.payload.request.approvalCount, 1);
  assert.equal(decision.payload.request.currentActorDecisionRecorded, true);
  assert.equal(decision.payload.request.submittedByCurrentActor, false);
  assert.deepEqual(decision.payload.request.decisions, []);
  assertNoGovernanceAuditFields(decision.payload.request, "decision.request");

  const governance = await request("/api/work-rules/governance", {
    session: reviewManagerSession,
  });
  assert.equal(governance.response.status, 200, JSON.stringify(governance.payload));
  const visibleRequest = governance.payload.requests.find((entry) => (
    entry.id === submitted.payload.request.id
  ));
  assert.ok(visibleRequest, JSON.stringify(governance.payload.requests));
  assert.equal(visibleRequest.approvalCount, 1);
  assert.equal(visibleRequest.currentActorDecisionRecorded, true);
  assert.deepEqual(visibleRequest.decisions, []);
  for (const key of [
    "requests",
    "conflictRuns",
    "publications",
    "assignmentRevisions",
    "assignments",
    "collectiveAgreementAssignments",
    "events",
  ]) assertNoGovernanceAuditFields(governance.payload[key], `governance.${key}`);

  const globalWithoutAudit = await request("/api/work-rules/governance", {
    session: hrNoAuditSession,
  });
  assert.equal(globalWithoutAudit.response.status, 200, JSON.stringify(globalWithoutAudit.payload));
  assert.equal(globalWithoutAudit.payload.capabilities.canAudit, false);
  assert.equal(globalWithoutAudit.payload.requests.length >= governance.payload.requests.length, true);
  for (const key of [
    "requests",
    "conflictRuns",
    "publications",
    "assignmentRevisions",
    "assignments",
    "collectiveAgreementAssignments",
    "events",
  ]) assertNoGovernanceAuditFields(globalWithoutAudit.payload[key], `globalWithoutAudit.${key}`);
});

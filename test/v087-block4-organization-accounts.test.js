"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v087-block4-organization-accounts-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.NODE_ENV = "test";

const {
  app,
  db,
  releaseInstanceLockForTests,
} = require("../server");

const HOME_LOCATION = "93";
const OTHER_LOCATION = "94";
const HR_EMPLOYEE = "v087b4hr";
const NORMAL_EMPLOYEE = "v087b4employee";
const BORROWER_EMPLOYEE = "v087b4borrower";
const OTHER_EMPLOYEE = "v087b4other";
const COLLISION_EMPLOYEE = "collision4";
const ORGANIZATION_LOGIN = "fil18";
const START_PASSWORD = "Filialkonto-Start-2027!";
const ACTIVE_PASSWORD = "Filialkonto-Aktiv-2027!";
const LOAN_ID = "v087-block4-organization-loan";
const ALLOWED_PERMISSIONS = [
  "loans:overview:read",
  "schedule:location:view",
  "personnel_learning:location:dashboard",
  "branch_orders:submit",
  "branch_articles:read",
  "branch_receipts:read",
];

let baseUrl;
let httpServer;
let hrSession;
let employeeSession;
let organizationSession;
let organizationAccountId;

function ensureLocation(id, name) {
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, day_settings_json, active)
    VALUES (?, ?, 0, '{}', 1)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = 1
  `).run(id, name);
  db.prepare(`
    INSERT INTO loan_location_settings
      (location_id, enabled, article_lookup_enabled, article_lookup_provider,
       created_by, updated_by, updated_at)
    VALUES (?, 1, 0, 'none', 'test', 'test', CURRENT_TIMESTAMP)
    ON CONFLICT(location_id) DO UPDATE SET
      enabled = 1,
      article_lookup_enabled = 0,
      article_lookup_provider = 'none',
      updated_by = 'test',
      updated_at = CURRENT_TIMESTAMP
  `).run(id);
}

function ensureEmployee(employeeNumber, name, locationId, role = "employee") {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      active = 1
  `).run(employeeNumber, name, name.split(" ")[0], locationId);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only',
      role = excluded.role,
      active = 1,
      must_change_password = 0,
      password_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
}

function createEmployeeSession(employeeNumber) {
  const id = crypto.randomUUID();
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    id,
    employeeNumber,
    crypto.createHash("sha256").update(rawToken).digest("hex"),
  );
  return {
    cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

function insertScheduleFixtures() {
  db.prepare(`
    INSERT INTO shifts
      (employee_number, location_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, '2031-01-07', '09:00', '18:00', 'Verkauf', 'Interne Hauptfilialnotiz')
  `).run(BORROWER_EMPLOYEE, HOME_LOCATION);
  db.prepare(`
    INSERT INTO shifts
      (employee_number, location_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, '2031-01-08', '10:00', '17:00', 'Service', 'Interne Fremdfilialnotiz')
  `).run(OTHER_EMPLOYEE, OTHER_LOCATION);
}

function insertCentralArticle(articleNumber, description) {
  const productId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const digest = (label) => crypto.createHash("sha256")
    .update(`${label}\0${articleNumber}\0${productId}`)
    .digest("hex");
  const snapshotId = digest("snapshot");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO sales_article_import_snapshots (
        id, idempotency_key, source_system, source_profile_version,
        source_schema_sha256, source_file_sha256, content_sha256,
        snapshot_at, article_count, identifier_count, price_count,
        imported_by, imported_at
      ) VALUES (?, ?, 'manual.loan', 'test-v1', ?, ?, ?, ?, 1, 0, 0, 'test', ?)
    `).run(
      snapshotId,
      digest("idempotency"),
      digest("schema"),
      digest("file"),
      digest("content"),
      timestamp,
      timestamp,
    );
    db.prepare(`
      INSERT INTO sales_articles (
        product_id, article_number, source_system, source_article_key,
        current_revision, created_by, created_at, updated_by, updated_at
      ) VALUES (?, ?, 'manual.loan', ?, 1, 'test', ?, 'test', ?)
    `).run(productId, articleNumber, articleNumber, timestamp, timestamp);
    db.prepare(`
      INSERT INTO sales_article_revisions (
        product_id, revision, article_number, description, active,
        source_snapshot_id, created_by, created_at
      ) VALUES (?, 1, ?, ?, 1, ?, 'test', ?)
    `).run(productId, articleNumber, description, snapshotId, timestamp);
    db.prepare(`
      INSERT INTO sales_article_source_links (
        product_id, source_system, source_article_key, source_snapshot_id,
        match_method, match_confidence, linked_by, linked_at
      ) VALUES (?, 'manual.loan', ?, ?, 'source_import', 'authoritative', 'test', ?)
    `).run(productId, articleNumber, snapshotId, timestamp);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return { productId, revision: 1 };
}

function insertLoanFixture() {
  const article = insertCentralArticle("987401", "Block-4-Testkamera");
  db.prepare(`
    INSERT INTO loans
      (id, location_id, borrower_employee_number, created_by_employee_number,
       due_date, status, notes, issued_at, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, '2031-02-01', 'issued', 'Interne Leihnotiz',
            '2031-01-02T08:00:00.000Z', 1,
            '2031-01-02T08:00:00.000Z', '2031-01-02T08:00:00.000Z')
  `).run(LOAN_ID, HOME_LOCATION, BORROWER_EMPLOYEE, BORROWER_EMPLOYEE);
  db.prepare(`
    INSERT INTO loan_items
      (id, loan_id, position, product_id, product_revision_snapshot,
       article_number_snapshot, description_snapshot, serial_number,
       quantity, condition_out, item_note)
    VALUES (?, ?, 1, ?, ?, '987401', 'Block-4-Testkamera',
            'BLOCK4-SECRET-SERIAL', 1, 'good', 'Interne Artikelnotiz')
  `).run(crypto.randomUUID(), LOAN_ID, article.productId, article.revision);
}

function responseSession(response) {
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
  const csrfCookie = setCookies
    .map((value) => value.split(";", 1)[0])
    .find((value) => value.startsWith("grabenplaner_csrf="));
  assert.ok(cookie.includes("grabenplaner_session="), "Session-Cookie fehlt");
  assert.ok(csrfCookie, "CSRF-Cookie fehlt");
  return {
    cookie,
    csrf: decodeURIComponent(csrfCookie.split("=").slice(1).join("=")),
  };
}

async function requestJson(route, {
  method = "GET",
  session = null,
  body,
} = {}) {
  const headers = { Accept: "application/json" };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && session?.csrf) {
    headers["X-CSRF-Token"] = session.csrf;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { response, payload };
}

function organizationAccountInput(overrides = {}) {
  return {
    loginName: ORGANIZATION_LOGIN,
    displayName: "Filiale 18",
    accountType: "branch",
    password: START_PASSWORD,
    active: true,
    permissions: ALLOWED_PERMISSIONS,
    scopes: [{ locationId: HOME_LOCATION }],
    ...overrides,
  };
}

test.before(() => {
  ensureLocation(HOME_LOCATION, "Block 4 Hauptfiliale");
  ensureLocation(OTHER_LOCATION, "Block 4 Fremdfiliale");
  ensureEmployee(HR_EMPLOYEE, "Helena Personalleitung", HOME_LOCATION, "hr");
  ensureEmployee(NORMAL_EMPLOYEE, "Emil Mitarbeiter", HOME_LOCATION);
  ensureEmployee(BORROWER_EMPLOYEE, "Berta Ausleihe", HOME_LOCATION);
  ensureEmployee(OTHER_EMPLOYEE, "Olivia Fremdfiliale", OTHER_LOCATION);
  ensureEmployee(COLLISION_EMPLOYEE, "Klara Kollision", HOME_LOCATION);
  insertScheduleFixtures();
  insertLoanFixture();

  hrSession = createEmployeeSession(HR_EMPLOYEE);
  employeeSession = createEmployeeSession(NORMAL_EMPLOYEE);

  return new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Block 4: Filial- und Terminalkonten bleiben getrennte, standortgebundene Nur-Lese-Zugänge", async (t) => {
  await t.test("getrennte Tabellen verweisen nicht auf einen künstlichen Mitarbeiter", () => {
    for (const table of [
      "portal_organization_accounts",
      "portal_organization_sessions",
      "portal_organization_account_permissions",
      "portal_organization_account_scopes",
    ]) {
      assert.ok(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        `${table} fehlt`,
      );
    }

    const accountForeignKeys = db.prepare("PRAGMA foreign_key_list('portal_organization_accounts')").all();
    assert.equal(accountForeignKeys.some((foreignKey) => foreignKey.table === "employees"), false);
    assert.equal(accountForeignKeys.some((foreignKey) => foreignKey.table === "portal_users"), false);

    for (const table of [
      "portal_organization_sessions",
      "portal_organization_account_permissions",
      "portal_organization_account_scopes",
    ]) {
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list('${table}')`).all();
      assert.equal(
        foreignKeys.some((foreignKey) => foreignKey.table === "portal_organization_accounts"),
        true,
        `${table} ist nicht an die getrennte Kontodomäne gebunden`,
      );
      assert.equal(
        foreignKeys.some((foreignKey) => foreignKey.table === "employees"),
        false,
        `${table} darf keinen Mitarbeiter-Fremdschlüssel besitzen`,
      );
    }
  });

  await t.test("normale Mitarbeitende dürfen keine Organisationskonten anlegen", async () => {
    const denied = await requestJson("/api/portal/v1/organization-accounts", {
      method: "POST",
      session: employeeSession,
      body: organizationAccountInput({ loginName: "employee-denied4" }),
    });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(
      db.prepare("SELECT 1 FROM portal_organization_accounts WHERE login_name = 'employee-denied4'").get(),
      undefined,
    );
  });

  await t.test("Personalleitung sieht nur die feste Funktions-Allowlist", async () => {
    const catalog = await requestJson("/api/portal/v1/organization-accounts", {
      session: hrSession,
    });
    assert.equal(catalog.response.status, 200, JSON.stringify(catalog.payload));
    assert.deepEqual(
      new Set(catalog.payload.permissionCatalog.map((permission) => permission.id)),
      new Set([...ALLOWED_PERMISSIONS, "branch_time_off:submit"]),
    );
    assert.deepEqual(
      new Set(catalog.payload.accountTypes.map((accountType) => accountType.id)),
      new Set(["branch", "terminal"]),
    );

    const invalid = await requestJson("/api/portal/v1/organization-accounts", {
      method: "POST",
      session: hrSession,
      body: organizationAccountInput({
        loginName: "invalid-rights4",
        permissions: [...ALLOWED_PERMISSIONS, "loans:self:create"],
      }),
    });
    assert.equal(invalid.response.status, 403, JSON.stringify(invalid.payload));
    assert.equal(invalid.payload.code, "PORTAL_ORGANIZATION_PERMISSION_DENIED");
    assert.equal(
      db.prepare("SELECT 1 FROM portal_organization_accounts WHERE login_name = 'invalid-rights4'").get(),
      undefined,
    );
  });

  await t.test("Pflichtscope und domainübergreifende Login-Kollision werden abgewiesen", async () => {
    const missingScope = await requestJson("/api/portal/v1/organization-accounts", {
      method: "POST",
      session: hrSession,
      body: organizationAccountInput({
        loginName: "missing-scope4",
        scopes: [],
      }),
    });
    assert.equal(missingScope.response.status, 400, JSON.stringify(missingScope.payload));
    assert.equal(missingScope.payload.code, "PORTAL_ORGANIZATION_SCOPE_REQUIRED");

    const collision = await requestJson("/api/portal/v1/organization-accounts", {
      method: "POST",
      session: hrSession,
      body: organizationAccountInput({ loginName: COLLISION_EMPLOYEE.toUpperCase() }),
    });
    assert.equal(collision.response.status, 409, JSON.stringify(collision.payload));
    assert.equal(collision.payload.code, "PORTAL_ORGANIZATION_LOGIN_CONFLICT");
    assert.equal(
      db.prepare("SELECT 1 FROM portal_organization_accounts WHERE login_name = ? COLLATE NOCASE")
        .get(COLLISION_EMPLOYEE),
      undefined,
    );
  });

  await t.test("Personalleitung legt fil18 generisch ohne employees- oder portal_users-Zeile an", async () => {
    const created = await requestJson("/api/portal/v1/organization-accounts", {
      method: "POST",
      session: hrSession,
      body: organizationAccountInput(),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    organizationAccountId = created.payload.account.id;
    assert.ok(organizationAccountId);
    assert.equal(created.payload.account.loginName, ORGANIZATION_LOGIN);
    assert.equal(created.payload.account.accountType, "branch");
    assert.equal(created.payload.account.active, true);
    assert.deepEqual(new Set(created.payload.account.permissions), new Set(ALLOWED_PERMISSIONS));
    assert.deepEqual(created.payload.account.scopes, [{
      locationId: HOME_LOCATION,
      departmentId: null,
    }]);

    assert.equal(
      db.prepare("SELECT 1 FROM employees WHERE personnel_number = ? COLLATE NOCASE")
        .get(ORGANIZATION_LOGIN),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT 1 FROM portal_users WHERE employee_number = ? COLLATE NOCASE")
        .get(ORGANIZATION_LOGIN),
      undefined,
    );
    assert.ok(
      db.prepare("SELECT 1 FROM portal_organization_accounts WHERE id = ?")
        .get(organizationAccountId),
    );
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  });

  await t.test("fil18 kann später weder Mitarbeiter noch Personal- oder Rücknahmeauswahl werden", async () => {
    const template = db.prepare(`
      SELECT position_id, cost_center_id
      FROM employees
      WHERE personnel_number = ?
    `).get(NORMAL_EMPLOYEE);
    assert.ok(template?.position_id);
    assert.ok(template?.cost_center_id);

    const collision = await requestJson("/api/employees", {
      method: "POST",
      session: hrSession,
      body: {
        personnelNumber: ORGANIZATION_LOGIN.toUpperCase(),
        fullName: "Unzulässige Filialperson",
        nickname: "Filialperson",
        color: "#26785f",
        contractedHours: 38.5,
        targetWorkdaysPerWeek: 5,
        preferredDayOff: "",
        fixedWorkdays: [],
        positionId: template.position_id,
        preferredDepartmentId: "",
        costCenterId: template.cost_center_id,
        active: true,
      },
    });
    assert.equal(collision.response.status, 409, JSON.stringify(collision.payload));
    assert.equal(collision.payload.code, "PORTAL_PRINCIPAL_LOGIN_CONFLICT");
    assert.equal(
      db.prepare("SELECT 1 FROM employees WHERE personnel_number = ? COLLATE NOCASE")
        .get(ORGANIZATION_LOGIN),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT 1 FROM portal_users WHERE employee_number = ? COLLATE NOCASE")
        .get(ORGANIZATION_LOGIN),
      undefined,
    );

    const [employees, portalUsers, rights, teamMembers] = await Promise.all([
      requestJson("/api/employees", { session: hrSession }),
      requestJson("/api/portal/v1/users", { session: hrSession }),
      requestJson("/api/portal/v1/rights", { session: hrSession }),
      requestJson(
        `/api/portal/v1/loans/team-members?locationId=${encodeURIComponent(HOME_LOCATION)}`,
        { session: hrSession },
      ),
    ]);
    for (const result of [employees, portalUsers, rights, teamMembers]) {
      assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    }
    const matchesOrganizationLogin = (value) =>
      String(value || "").toLocaleLowerCase("de-AT") === ORGANIZATION_LOGIN;
    assert.equal(
      employees.payload.some((employee) => matchesOrganizationLogin(employee.personnel_number)),
      false,
    );
    assert.equal(
      portalUsers.payload.users.some((user) => matchesOrganizationLogin(user.employeeNumber)),
      false,
    );
    assert.equal(
      rights.payload.users.some((user) => matchesOrganizationLogin(user.employeeNumber)),
      false,
    );
    assert.equal(
      teamMembers.payload.members.some((member) => matchesOrganizationLogin(member.employeeNumber)),
      false,
    );
  });

  await t.test("Weblogin liefert einen Nicht-Mitarbeiter-Principal und filtert manipulierte Grants", async () => {
    db.prepare(`
      INSERT INTO portal_organization_account_permissions
        (account_id, permission, granted_by, updated_at)
      VALUES (?, 'loans:self:create', 'manipulated-test', CURRENT_TIMESTAMP)
    `).run(organizationAccountId);

    const login = await requestJson("/api/portal/v1/auth/login", {
      method: "POST",
      body: {
        loginName: ORGANIZATION_LOGIN.toUpperCase(),
        password: START_PASSWORD,
      },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    assert.equal(login.payload.authenticated, true);
    assert.equal(login.payload.user.isEmployee, false);
    assert.equal(login.payload.user.employeeNumber, null);
    assert.equal(login.payload.user.accountId, organizationAccountId);
    assert.equal(login.payload.user.loginName, ORGANIZATION_LOGIN);
    assert.equal(login.payload.user.accountType, "branch");
    assert.equal(login.payload.user.homeLocationId, HOME_LOCATION);
    assert.deepEqual(new Set(login.payload.user.permissions), new Set(ALLOWED_PERMISSIONS));
    assert.equal(login.payload.user.permissions.includes("loans:self:create"), false);
    organizationSession = responseSession(login.response);

    const changedPassword = await requestJson("/api/portal/v1/me/password", {
      method: "PUT",
      session: organizationSession,
      body: {
        currentPassword: START_PASSWORD,
        newPassword: ACTIVE_PASSWORD,
      },
    });
    assert.equal(changedPassword.response.status, 403, JSON.stringify(changedPassword.payload));
    assert.equal(changedPassword.payload.code, "PORTAL_ORGANIZATION_PASSWORD_MANAGED");

    const resetByAdministration = await requestJson(
      `/api/portal/v1/organization-accounts/${encodeURIComponent(organizationAccountId)}`,
      {
        method: "PUT",
        session: hrSession,
        body: organizationAccountInput({ password: ACTIVE_PASSWORD }),
      },
    );
    assert.equal(resetByAdministration.response.status, 200, JSON.stringify(resetByAdministration.payload));
    const activeLogin = await requestJson("/api/portal/v1/auth/login", {
      method: "POST",
      body: { loginName: ORGANIZATION_LOGIN, password: ACTIVE_PASSWORD },
    });
    assert.equal(activeLogin.response.status, 200, JSON.stringify(activeLogin.payload));
    organizationSession = responseSession(activeLogin.response);
    assert.equal(
      db.prepare("SELECT must_change_password FROM portal_organization_accounts WHERE id = ?")
        .get(organizationAccountId).must_change_password,
      0,
    );
  });

  await t.test("reduzierter Dienstplan bleibt auf den Pflichtstandort und minimale Felder begrenzt", async () => {
    const homeSchedule = await requestJson(
      "/api/portal/v1/location-dashboard/schedule?week=2031-01-06",
      { session: organizationSession },
    );
    assert.equal(homeSchedule.response.status, 200, JSON.stringify(homeSchedule.payload));
    assert.deepEqual(Object.keys(homeSchedule.payload).sort(), [
      "calendarWeek",
      "displaySettings",
      "location",
      "shifts",
      "weekEnd",
      "weekStart",
    ]);
    assert.deepEqual(Object.keys(homeSchedule.payload.displaySettings).sort(), [
      "mobileHideElapsedDays",
      "orderAutosaveEnabled",
      "orderAutosaveMinutes",
      "scheduleDisplayMode",
      "updatedAt",
    ]);
    assert.deepEqual(homeSchedule.payload.location, {
      id: HOME_LOCATION,
      name: "Block 4 Hauptfiliale",
    });
    assert.equal(homeSchedule.payload.weekStart, "2031-01-06");
    assert.equal(homeSchedule.payload.weekEnd, "2031-01-12");
    assert.equal(homeSchedule.payload.shifts.length, 1);
    assert.deepEqual(Object.keys(homeSchedule.payload.shifts[0]).sort(), [
      "area",
      "date",
      "departmentName",
      "employeeColor",
      "employeeName",
      "endTime",
      "startTime",
    ]);
    assert.equal(homeSchedule.payload.shifts[0].employeeName, "Berta");
    assert.match(homeSchedule.payload.shifts[0].employeeColor, /^#[0-9a-f]{6}$/i);
    assert.equal(homeSchedule.payload.shifts[0].area, "Verkauf");

    const serialized = JSON.stringify(homeSchedule.payload);
    assert.equal(serialized.includes(BORROWER_EMPLOYEE), false);
    assert.equal(serialized.includes(OTHER_EMPLOYEE), false);
    assert.equal(serialized.includes("Interne Hauptfilialnotiz"), false);
    assert.equal(serialized.includes("Interne Fremdfilialnotiz"), false);

    const foreignSchedule = await requestJson(
      `/api/portal/v1/location-dashboard/schedule?week=2031-01-06&locationId=${encodeURIComponent(OTHER_LOCATION)}`,
      { session: organizationSession },
    );
    assert.equal(foreignSchedule.response.status, 403, JSON.stringify(foreignSchedule.payload));

    const foreignLoans = await requestJson(
      `/api/portal/v1/loans/open-overview?locationId=${encodeURIComponent(OTHER_LOCATION)}`,
      { session: organizationSession },
    );
    assert.equal(foreignLoans.response.status, 403, JSON.stringify(foreignLoans.payload));
  });

  await t.test("Mitarbeiter-Startseite, Aufgaben, Benachrichtigungen und Verwaltungspräferenzen bleiben gesperrt", async () => {
    const employeeOnlyRequests = [
      { method: "GET", route: "/api/portal/v1/me/home" },
      { method: "POST", route: "/api/portal/v1/me/process-tasks/test-run/test-step/complete", body: {} },
      { method: "GET", route: "/api/portal/v1/me/notifications" },
      { method: "PUT", route: "/api/portal/v1/me/notifications/read-all", body: {} },
      { method: "GET", route: "/api/portal/v1/me/email-settings" },
      {
        method: "PUT",
        route: "/api/portal/v1/me/email-settings/address",
        body: { email: "organization-account@example.at" },
      },
      { method: "DELETE", route: "/api/portal/v1/me/email-settings/address" },
      { method: "POST", route: "/api/portal/v1/me/email-settings/verification", body: {} },
      {
        method: "POST",
        route: "/api/portal/v1/me/email-settings/verification/confirm",
        body: { code: "123456" },
      },
      {
        method: "PUT",
        route: "/api/portal/v1/me/email-settings/categories",
        body: { schedule_changes: true },
      },
      { method: "GET", route: "/api/portal/v1/ui-preferences" },
      {
        method: "PUT",
        route: "/api/portal/v1/ui-preferences",
        body: { workRuleAssessmentExpanded: true },
      },
    ];
    for (const entry of employeeOnlyRequests) {
      const result = await requestJson(entry.route, {
        method: entry.method,
        session: organizationSession,
        body: entry.body,
      });
      assert.equal(
        result.response.status,
        403,
        `${entry.method} ${entry.route}: ${JSON.stringify(result.payload)}`,
      );
      assert.equal(result.payload.code, "PORTAL_EMPLOYEE_ACCOUNT_REQUIRED");
    }
  });

  await t.test("Ausgabe, Rücknahme, Bestätigung und Leitungs-Mutationen bleiben immer 403", async () => {
    const mutations = [
      {
        method: "POST",
        route: "/api/portal/v1/loans",
        body: {
          locationId: HOME_LOCATION,
          borrowerEmployeeNumber: BORROWER_EMPLOYEE,
          items: [{ articleNumber: "987401", serialNumber: "NEU" }],
        },
      },
      {
        method: "POST",
        route: `/api/portal/v1/loans/${encodeURIComponent(LOAN_ID)}/return`,
        body: { expectedRevision: 1, witnessEmployeeNumber: NORMAL_EMPLOYEE, items: [] },
      },
      {
        method: "PUT",
        route: `/api/portal/v1/loans/${encodeURIComponent(LOAN_ID)}/management`,
        body: { expectedRevision: 1, items: [] },
      },
      {
        method: "POST",
        route: `/api/portal/v1/loans/${encodeURIComponent(LOAN_ID)}/management/close`,
        body: { expectedRevision: 1, items: [] },
      },
      {
        method: "POST",
        route: `/api/portal/v1/loans/${encodeURIComponent(LOAN_ID)}/management/reopen`,
        body: { expectedRevision: 1 },
      },
      {
        method: "POST",
        route: "/api/portal/v1/loans/return-confirmations/not-a-confirmation/respond",
        body: { decision: "confirm" },
      },
    ];

    for (const mutation of mutations) {
      const result = await requestJson(mutation.route, {
        method: mutation.method,
        session: organizationSession,
        body: mutation.body,
      });
      assert.equal(
        result.response.status,
        403,
        `${mutation.method} ${mutation.route}: ${JSON.stringify(result.payload)}`,
      );
      assert.equal(result.payload.code, "PORTAL_PERMISSION_DENIED");
    }

    const unchanged = db.prepare(`
      SELECT status, revision, notes, return_recorded_by_employee_number
      FROM loans
      WHERE id = ?
    `).get(LOAN_ID);
    assert.deepEqual({ ...unchanged }, {
      status: "issued",
      revision: 1,
      notes: "Interne Leihnotiz",
      return_recorded_by_employee_number: null,
    });
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM loan_return_confirmations WHERE loan_id = ?")
        .get(LOAN_ID).count,
      0,
    );
  });

  await t.test("Deaktivierung widerruft die Organisationssession und verhindert eine Neuanmeldung", async () => {
    const activeSession = db.prepare(`
      SELECT id, revoked_at
      FROM portal_organization_sessions
      WHERE account_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(organizationAccountId);
    assert.ok(activeSession);
    assert.equal(activeSession.revoked_at, null);

    const deactivated = await requestJson(
      `/api/portal/v1/organization-accounts/${encodeURIComponent(organizationAccountId)}`,
      {
        method: "PUT",
        session: hrSession,
        body: organizationAccountInput({
          password: undefined,
          active: false,
        }),
      },
    );
    assert.equal(deactivated.response.status, 200, JSON.stringify(deactivated.payload));
    assert.equal(deactivated.payload.account.active, false);
    assert.ok(
      db.prepare(`
        SELECT 1
        FROM portal_organization_sessions
        WHERE id = ? AND revoked_at IS NOT NULL
      `).get(activeSession.id),
    );

    const oldSession = await requestJson("/api/portal/v1/session", {
      session: organizationSession,
    });
    assert.equal(oldSession.response.status, 200, JSON.stringify(oldSession.payload));
    assert.equal(oldSession.payload.authenticated, false);
    assert.equal(oldSession.payload.user, null);

    const scheduleAfterDeactivation = await requestJson(
      "/api/portal/v1/location-dashboard/schedule?week=2031-01-06",
      { session: organizationSession },
    );
    assert.equal(
      scheduleAfterDeactivation.response.status,
      401,
      JSON.stringify(scheduleAfterDeactivation.payload),
    );

    const relogin = await requestJson("/api/portal/v1/auth/login", {
      method: "POST",
      body: {
        loginName: ORGANIZATION_LOGIN,
        password: ACTIVE_PASSWORD,
      },
    });
    assert.equal(relogin.response.status, 401, JSON.stringify(relogin.payload));
    assert.equal(relogin.payload.code, "PORTAL_LOGIN_FAILED");
  });
});

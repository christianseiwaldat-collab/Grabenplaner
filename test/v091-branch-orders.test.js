"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sentMails = [];
let failNextMail = false;
const nodemailer = require("nodemailer");
nodemailer.createTransport = () => ({
  async sendMail(message) {
    if (failNextMail) {
      failNextMail = false;
      throw new Error("test delivery failure");
    }
    sentMails.push(message);
    return { accepted: [message.to] };
  },
  close() {},
});

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v091-branch-orders-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_TODAY = "2031-03-11";
process.env.GRABENPLANER_SMTP_HOST = "smtp.test.invalid";
process.env.GRABENPLANER_SMTP_FROM = "noreply@grabenplaner.eu";
process.env.GRABENPLANER_SMTP_USER = "test-user";
process.env.GRABENPLANER_SMTP_PASSWORD = "test-password";
process.env.GRABENPLANER_EMAIL_DISPATCH_ENABLED = "1";
process.env.GRABENPLANER_EMAIL_SENDER_APPROVED = "1";
process.env.GRABENPLANER_EMAIL_ALLOWED_EVENTS = "branch_order";
process.env.NODE_ENV = "test";

const {
  app,
  db,
  releaseInstanceLockForTests,
} = require("../server");

const LOCATION = "18";
const OTHER_LOCATION = "19";
const LEGACY_LOCATION = "20";
const HR = "v091hr";
const MANAGER = "252";
const EMPLOYEE = "275";
const OTHER_MANAGER = "v091other";
const IT_ADMIN = "v091-it-admin";
const ORGANIZATION_LOGIN = "fil18";
const INITIAL_PASSWORD = "Filialkonto-v091!";
const ACTIVE_PASSWORD = "Filialkonto-aktiv-v091!";

let baseUrl;
let httpServer;
let hrSession;
let managerSession;
let itAdminSession;
let organizationSession;

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
    ON CONFLICT(location_id) DO UPDATE SET enabled = 1, updated_at = CURRENT_TIMESTAMP
  `).run(id);
}

function ensureEmployee(employeeNumber, name, locationId, role) {
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
      password_hash = 'test-only', role = excluded.role, active = 1,
      must_change_password = 0, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  if (role === "manager") {
    db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(employeeNumber);
    db.prepare(`
      INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, 0, 'v091-test')
    `).run(employeeNumber, locationId);
  }
}

function createEmployeeSession(employeeNumber) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(rawToken).digest("hex"),
  );
  return { cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`, csrf };
}

function responseSession(response) {
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const cookies = setCookies.map((value) => value.split(";", 1)[0]);
  const csrfCookie = cookies.find((value) => value.startsWith("grabenplaner_csrf="));
  assert.ok(csrfCookie, "CSRF-Cookie fehlt");
  return {
    cookie: cookies.join("; "),
    csrf: decodeURIComponent(csrfCookie.split("=").slice(1).join("=")),
  };
}

async function requestJson(route, { method = "GET", session = null, body } = {}) {
  const headers = { Accept: "application/json" };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && session?.csrf) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) payload = JSON.parse(text);
  return { response, payload };
}

async function requestBinary(route, { method = "GET", session = null } = {}) {
  const headers = {};
  if (session?.cookie) headers.Cookie = session.cookie;
  if (![
    "GET", "HEAD", "OPTIONS",
  ].includes(method) && session?.csrf) headers["X-CSRF-Token"] = session.csrf;
  const response = await fetch(`${baseUrl}${route}`, { method, headers });
  return { response, content: Buffer.from(await response.arrayBuffer()) };
}

function insertReadOnlyFixtures() {
  for (const date of ["2031-03-03", "2031-03-10", "2031-03-17"]) {
    db.prepare(`
      INSERT INTO shifts (employee_number, location_id, shift_date, start_time, end_time, area, note)
      VALUES (?, ?, ?, '09:00', '18:00', 'Verkauf', 'nicht für Filialkonto')
    `).run(EMPLOYEE, LOCATION, date);
  }
  db.prepare(`
    INSERT INTO week_options
      (employee_number, group_id, week_start, date_from, date_to, option_type, note, all_day)
    VALUES (?, 'v091-vacation', '2031-03-10', '2031-03-10', '2031-03-14', 'vacation', 'nicht für Filialkonto', 1)
  `).run(EMPLOYEE);
  db.prepare(`
    INSERT INTO articles (article_number, description, source_provider, active, created_by, updated_by)
    VALUES ('910018', 'V091 Testkamera', 'manual', 1, 'test', 'test')
  `).run();
  db.prepare(`
    INSERT INTO loans
      (id, location_id, borrower_employee_number, created_by_employee_number,
       due_date, status, notes, issued_at, revision, created_at, updated_at)
    VALUES ('v091-loan', ?, ?, ?, '2031-03-20', 'issued', 'intern',
            '2031-03-10T08:00:00.000Z', 1,
            '2031-03-10T08:00:00.000Z', '2031-03-10T08:00:00.000Z')
  `).run(LOCATION, EMPLOYEE, EMPLOYEE);
  db.prepare(`
    INSERT INTO loan_items
      (id, loan_id, position, article_number, description_snapshot, serial_number, quantity, condition_out, item_note)
    VALUES (?, 'v091-loan', 1, '910018', 'V091 Testkamera', 'V091-SERIAL', 1, 'good', 'intern')
  `).run(crypto.randomUUID());
}

test.before(() => {
  ensureLocation(LOCATION, "Filiale 18");
  ensureLocation(OTHER_LOCATION, "Andere Filiale");
  ensureLocation(LEGACY_LOCATION, "Legacy-Katalog");
  ensureEmployee(HR, "Herta Personal", LOCATION, "hr");
  ensureEmployee(MANAGER, "Mara Filialleitung", LOCATION, "manager");
  ensureEmployee(EMPLOYEE, "Marie-Theres", LOCATION, "employee");
  ensureEmployee(OTHER_MANAGER, "Olaf Andere", OTHER_LOCATION, "manager");
  ensureEmployee(IT_ADMIN, "Ines Technik", LOCATION, "it_admin");
  insertReadOnlyFixtures();
  hrSession = createEmployeeSession(HR);
  managerSession = createEmployeeSession(MANAGER);
  itAdminSession = createEmployeeSession(IT_ADMIN);
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

test("v0.91: Filialkonto sieht Leihen und Wochen, PL+ verwaltet Bestellungen", async (t) => {
  let accountId;
  let catalog;
  let organizationOrderDraft;

  await t.test("Filialkonto erhält die zwei Basisansichten; Filialbestellung wird durch PL+ einzeln aktiviert", async () => {
    const created = await requestJson("/api/portal/v1/organization-accounts", {
      method: "POST",
      session: hrSession,
      body: {
        loginName: ORGANIZATION_LOGIN,
        displayName: "Filiale 18",
        accountType: "branch",
        password: INITIAL_PASSWORD,
        active: true,
        permissions: [],
        scopes: [{ locationId: LOCATION }],
      },
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    accountId = created.payload.account.id;
    assert.deepEqual(new Set(created.payload.account.permissions), new Set([
      "loans:overview:read",
      "schedule:location:view",
    ]));

    db.prepare("DELETE FROM portal_organization_account_permissions WHERE account_id = ?").run(accountId);
    const login = await requestJson("/api/portal/v1/auth/login", {
      method: "POST",
      body: { loginName: ORGANIZATION_LOGIN, password: INITIAL_PASSWORD },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    assert.deepEqual(new Set(login.payload.user.permissions), new Set([
      "loans:overview:read",
      "schedule:location:view",
    ]));
    organizationSession = responseSession(login.response);
    const selfChangeDenied = await requestJson("/api/portal/v1/me/password", {
      method: "PUT",
      session: organizationSession,
      body: { currentPassword: INITIAL_PASSWORD, newPassword: ACTIVE_PASSWORD },
    });
    assert.equal(selfChangeDenied.response.status, 403, JSON.stringify(selfChangeDenied.payload));
    assert.equal(selfChangeDenied.payload.code, "PORTAL_ORGANIZATION_PASSWORD_MANAGED");

    const passwordTargets = await requestJson("/api/portal/v1/branch-accounts/passwords", {
      session: managerSession,
    });
    assert.equal(passwordTargets.response.status, 200, JSON.stringify(passwordTargets.payload));
    assert.deepEqual(passwordTargets.payload.accounts.map((account) => account.loginName), [ORGANIZATION_LOGIN]);
    const reset = await requestJson(`/api/portal/v1/branch-accounts/${encodeURIComponent(accountId)}/password`, {
      method: "PUT",
      session: managerSession,
      body: { password: ACTIVE_PASSWORD },
    });
    assert.equal(reset.response.status, 200, JSON.stringify(reset.payload));
    assert.equal(reset.payload.account.loginName, ORGANIZATION_LOGIN);
    const revoked = await requestJson("/api/portal/v1/session", { session: organizationSession });
    assert.equal(revoked.response.status, 200, JSON.stringify(revoked.payload));
    assert.equal(revoked.payload.authenticated, false);

    const activeLogin = await requestJson("/api/portal/v1/auth/login", {
      method: "POST",
      body: { loginName: ORGANIZATION_LOGIN, password: ACTIVE_PASSWORD },
    });
    assert.equal(activeLogin.response.status, 200, JSON.stringify(activeLogin.payload));
    assert.deepEqual(new Set(activeLogin.payload.user.permissions), new Set([
      "loans:overview:read",
      "schedule:location:view",
    ]));

    const activated = await requestJson(`/api/portal/v1/organization-accounts/${encodeURIComponent(accountId)}`, {
      method: "PUT",
      session: hrSession,
      body: {
        loginName: ORGANIZATION_LOGIN,
        displayName: "Filiale 18",
        accountType: "branch",
        active: true,
        permissions: ["branch_orders:submit"],
        scopes: [{ locationId: LOCATION }],
      },
    });
    assert.equal(activated.response.status, 200, JSON.stringify(activated.payload));
    assert.deepEqual(new Set(activated.payload.account.permissions), new Set([
      "loans:overview:read",
      "schedule:location:view",
      "branch_orders:submit",
    ]));

    const activatedLogin = await requestJson("/api/portal/v1/auth/login", {
      method: "POST",
      body: { loginName: ORGANIZATION_LOGIN, password: ACTIVE_PASSWORD },
    });
    assert.equal(activatedLogin.response.status, 200, JSON.stringify(activatedLogin.payload));
    organizationSession = responseSession(activatedLogin.response);
  });

  await t.test("vergangene, aktuelle und kommende KW bleiben lesbar; Leih- und Urlaubsansicht bleiben datensparsam", async () => {
    for (const week of ["2031-03-03", "2031-03-10", "2031-03-17"]) {
      const result = await requestJson(`/api/portal/v1/location-dashboard/schedule?week=${week}`, {
        session: organizationSession,
      });
      assert.equal(result.response.status, 200, JSON.stringify(result.payload));
      assert.equal(result.payload.weekStart, week);
      assert.equal(result.payload.shifts[0]?.employeeColor, "#26785f");
      assert.equal(JSON.stringify(result.payload).includes("nicht für Filialkonto"), false);
    }
    const vacations = await requestJson("/api/portal/v1/location-dashboard/vacations?week=2031-03-10", {
      session: organizationSession,
    });
    assert.equal(vacations.response.status, 200, JSON.stringify(vacations.payload));
    assert.deepEqual(vacations.payload.vacations, [{
      employeeName: "Marie-Theres",
      dateFrom: "2031-03-10",
      dateTo: "2031-03-14",
    }]);
    assert.equal(JSON.stringify(vacations.payload).includes("nicht für Filialkonto"), false);
    assert.equal(JSON.stringify(vacations.payload).includes(EMPLOYEE), false);
    const wrongLocation = await requestJson("/api/portal/v1/location-dashboard/vacations?week=2031-03-10&locationId=19", {
      session: organizationSession,
    });
    assert.equal(wrongLocation.response.status, 403, JSON.stringify(wrongLocation.payload));
    const employeeSession = createEmployeeSession(EMPLOYEE);
    const employeeDenied = await requestJson("/api/portal/v1/location-dashboard/vacations?week=2031-03-10", {
      session: employeeSession,
    });
    assert.equal(employeeDenied.response.status, 403, JSON.stringify(employeeDenied.payload));
    const scheduleEditDenied = await requestJson("/api/schedule-note", {
      method: "PUT",
      session: organizationSession,
      body: { locationId: LOCATION, weekStart: "2031-03-10", note: "nicht erlaubt" },
    });
    assert.equal(scheduleEditDenied.response.status, 403, JSON.stringify(scheduleEditDenied.payload));
    const loans = await requestJson("/api/portal/v1/loans/open-overview", { session: organizationSession });
    assert.equal(loans.response.status, 200, JSON.stringify(loans.payload));
    assert.equal(loans.payload.items.length, 1);
    assert.deepEqual(loans.payload.columns, ["borrowerName", "description", "articleNumber", "serialNumber", "dueDate"]);
    assert.equal(loans.payload.items[0].borrowerName, "Marie-Theres");
    assert.equal(Object.hasOwn(loans.payload.items[0], "employeeNumber"), false);
    assert.equal(JSON.stringify(loans.payload).includes("intern"), false);
  });

  await t.test("Filialbestellung liefert nur Standortteam und Positionen, nie Zieladressen", async () => {
    const result = await requestJson("/api/portal/v1/branch-orders/catalog", { session: organizationSession });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    catalog = result.payload;
    assert.equal(catalog.location.id, LOCATION);
    assert.equal(catalog.senderEmail, "fil18-noreply@grabenplaner.eu");
    assert.ok(catalog.employees.some((employee) => employee.employeeNumber === EMPLOYEE));
    assert.equal(JSON.stringify(catalog).includes("lager@lamprechter.com"), false);
    const instantPrint = catalog.groups.find((group) => group.title === "Fotowelt – Sofortdruck");
    assert.ok(instantPrint);
    assert.deepEqual(
      new Set(instantPrint.items.filter((item) => item.title.includes("Mediaset")).map((item) => item.title)),
      new Set(["Fotodrucker: Mediaset DS40", "Fotodrucker: Mediaset DS80", "Fotodrucker: Mediaset DS620"]),
    );
    assert.equal(catalog.groups.some((group) => ["Lager", "Marketing"].includes(group.title)), false);
    const plotterHutpapier = catalog.groups.find((group) => group.title === "Fotowelt – Plotter")
      .items.find((item) => item.title === "Hutpapier");
    const packagingHutpapier = catalog.groups.find((group) => group.title === "Fotowelt – Verpackung & Versand")
      .items.find((item) => item.title === "Hutpapier");
    assert.ok(plotterHutpapier);
    assert.equal(plotterHutpapier.id, packagingHutpapier.id);
  });

  await t.test("nur PL+ konfiguriert Einheiten, Antwortadresse und Vorlagen", async () => {
    const managerDenied = await requestJson("/api/portal/v1/branch-orders/settings", { session: managerSession });
    assert.equal(managerDenied.response.status, 403, JSON.stringify(managerDenied.payload));
    const itAdminSessionInfo = await requestJson("/api/portal/v1/session", { session: itAdminSession });
    assert.equal(itAdminSessionInfo.response.status, 200, JSON.stringify(itAdminSessionInfo.payload));
    assert.equal(itAdminSessionInfo.payload.user.permissions.includes("branch_orders:manage"), false);
    const itAdminDenied = await requestJson("/api/portal/v1/branch-orders/settings", { session: itAdminSession });
    assert.equal(itAdminDenied.response.status, 403, JSON.stringify(itAdminDenied.payload));
    db.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES (?, 'branch_orders:manage', 'v091-legacy-test')
    `).run(IT_ADMIN);
    const legacyGrantDenied = await requestJson("/api/portal/v1/branch-orders/settings", {
      session: createEmployeeSession(IT_ADMIN),
    });
    assert.equal(legacyGrantDenied.response.status, 403, JSON.stringify(legacyGrantDenied.payload));
    db.prepare(`
      DELETE FROM portal_permission_grants
      WHERE employee_number = ? AND permission = 'branch_orders:manage'
    `).run(IT_ADMIN);
    const settings = await requestJson("/api/portal/v1/branch-orders/settings", { session: hrSession });
    assert.equal(settings.response.status, 200, JSON.stringify(settings.payload));
    assert.equal(settings.payload.locationId, LOCATION);
    const configuration = settings.payload.configuration;
    const recipient = configuration.recipients[0];
    assert.ok(recipient);
    assert.equal(recipient.replyToEmail, recipient.email);
    const originalRecipientEmail = recipient.email;
    const ds40Before = configuration.items.find((item) => item.title === "Fotodrucker: Mediaset DS40");
    assert.ok(ds40Before);
    recipient.email = "test-filialbestellung@example.test";
    recipient.subjectTemplate = "Filialbestellung {{employeeNickname}} · KW {{calendarWeek}}";
    recipient.bodyTemplate = `${recipient.bodyTemplate}\n\nDienstplanname: {{employeeNickname}}`;
    for (const recipient of configuration.recipients) recipient.replyToEmail = "antworten@grabenplaner.eu";
    configuration.items.find((item) => item.title === "Fotodrucker: Mediaset DS40").unitId = configuration.units.find((unit) => unit.title === "Karton").id;
    const saved = await requestJson("/api/portal/v1/branch-orders/settings", {
      method: "PUT",
      session: hrSession,
      body: { locationId: LOCATION, configuration },
    });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
    assert.equal(saved.payload.configuration.items
      .find((item) => item.title === "Fotodrucker: Mediaset DS40").unit, "Karton");
    assert.equal(
      saved.payload.configuration.items.find((item) => item.title === "Fotodrucker: Mediaset DS40").id,
      ds40Before.id,
    );
    assert.ok(saved.payload.configuration.recipients
      .some((entry) => entry.email === "test-filialbestellung@example.test"));
    const recipientToRestore = saved.payload.configuration.recipients
      .find((entry) => entry.email === "test-filialbestellung@example.test");
    assert.ok(recipientToRestore);
    recipientToRestore.email = originalRecipientEmail;
    const restored = await requestJson("/api/portal/v1/branch-orders/settings", {
      method: "PUT",
      session: hrSession,
      body: { locationId: LOCATION, configuration: saved.payload.configuration },
    });
    assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));

    const otherManager = createEmployeeSession(OTHER_MANAGER);
    const denied = await requestJson(`/api/portal/v1/branch-orders/settings?locationId=${LOCATION}`, { session: otherManager });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    const accountDenied = await requestJson("/api/portal/v1/branch-orders/settings", { session: organizationSession });
    assert.equal(accountDenied.response.status, 403, JSON.stringify(accountDenied.payload));

    const loanColumns = await requestJson("/api/portal/v1/loans/branch-overview-settings", { session: managerSession });
    assert.equal(loanColumns.response.status, 200, JSON.stringify(loanColumns.payload));
    assert.deepEqual(loanColumns.payload.columns, ["borrowerName", "description", "articleNumber", "serialNumber", "dueDate"]);
    const savedLoanColumns = await requestJson("/api/portal/v1/loans/branch-overview-settings", {
      method: "PUT",
      session: managerSession,
      body: { locationId: LOCATION, columns: ["employeeNumber", "description", "dueDate"] },
    });
    assert.equal(savedLoanColumns.response.status, 200, JSON.stringify(savedLoanColumns.payload));
    assert.deepEqual(savedLoanColumns.payload.columns, ["borrowerName", "employeeNumber", "description", "dueDate"]);
    const configuredOverview = await requestJson("/api/portal/v1/loans/open-overview", { session: organizationSession });
    assert.equal(configuredOverview.response.status, 200, JSON.stringify(configuredOverview.payload));
    assert.deepEqual(configuredOverview.payload.columns, ["borrowerName", "employeeNumber", "description", "dueDate"]);
    assert.equal(configuredOverview.payload.items[0].borrowerName, "Marie-Theres");
    assert.equal(configuredOverview.payload.items[0].employeeNumber, EMPLOYEE);
    assert.equal(Object.hasOwn(configuredOverview.payload.items[0], "serialNumber"), false);

    const personalOverview = await requestJson("/api/portal/v1/loans/open-overview", {
      session: createEmployeeSession(EMPLOYEE),
    });
    assert.equal(personalOverview.response.status, 200, JSON.stringify(personalOverview.payload));
    assert.equal(Object.hasOwn(personalOverview.payload.items[0], "borrowerName"), false);
    assert.equal(Object.hasOwn(personalOverview.payload.items[0], "employeeNumber"), false);

    const passwordResetDenied = await requestJson(`/api/portal/v1/branch-accounts/${encodeURIComponent(accountId)}/password`, {
      method: "PUT",
      session: otherManager,
      body: { password: "NichtErlaubt-v091!" },
    });
    assert.equal(passwordResetDenied.response.status, 403, JSON.stringify(passwordResetDenied.payload));
  });

  await t.test("PL+ kann zentrale Positionen mehreren Gruppen zuordnen und Maßeinheiten pflegen", async () => {
    const before = await requestJson("/api/portal/v1/branch-orders/settings", { session: hrSession });
    assert.equal(before.response.status, 200, JSON.stringify(before.payload));
    const original = structuredClone(before.payload.configuration);
    const configuration = structuredClone(original);
    const unitId = "unit-test-v093";
    const itemId = "item-test-v093";
    configuration.units.unshift({ id: unitId, title: "Bogen" });
    configuration.items.unshift({
      id: itemId,
      title: "Testposition für Mehrfachgruppe",
      unitId,
      recipientId: configuration.recipients[0].id,
    });
    const plotter = configuration.groups.find((group) => group.title === "Fotowelt – Plotter");
    const packaging = configuration.groups.find((group) => group.title === "Fotowelt – Verpackung & Versand");
    plotter.itemIds.unshift(itemId);
    packaging.itemIds.unshift(itemId);
    const saved = await requestJson("/api/portal/v1/branch-orders/settings", {
      method: "PUT",
      session: hrSession,
      body: { locationId: LOCATION, configuration },
    });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
    assert.equal(saved.payload.configuration.units[0].title, "Bogen");
    assert.equal(saved.payload.configuration.groups.find((group) => group.title === "Fotowelt – Plotter").itemIds[0], saved.payload.configuration.groups.find((group) => group.title === "Fotowelt – Verpackung & Versand").itemIds[0]);
    const invalid = structuredClone(saved.payload.configuration);
    invalid.units = invalid.units.filter((unit) => unit.title !== "Bogen");
    const invalidDelete = await requestJson("/api/portal/v1/branch-orders/settings", {
      method: "PUT",
      session: hrSession,
      body: { locationId: LOCATION, configuration: invalid },
    });
    assert.equal(invalidDelete.response.status, 400, JSON.stringify(invalidDelete.payload));
    const duplicateUnit = structuredClone(saved.payload.configuration);
    duplicateUnit.units.push({ id: "unit-duplicate-v093", title: duplicateUnit.units[0].title });
    const duplicateUnitDenied = await requestJson("/api/portal/v1/branch-orders/settings", {
      method: "PUT",
      session: hrSession,
      body: { locationId: LOCATION, configuration: duplicateUnit },
    });
    assert.equal(duplicateUnitDenied.response.status, 400, JSON.stringify(duplicateUnitDenied.payload));
    const restored = await requestJson("/api/portal/v1/branch-orders/settings", {
      method: "PUT",
      session: hrSession,
      body: { locationId: LOCATION, configuration: original },
    });
    assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  });

  await t.test("alte Standardgruppen werden ohne Positionsverlust in Anzeigegruppen überführt", async () => {
    const now = "2031-03-11T08:00:00.000Z";
    db.prepare(`
      INSERT INTO branch_order_location_settings (location_id, initialized_at, initialized_by, updated_at, updated_by)
      VALUES (?, ?, 'v091-test', ?, 'v091-test')
    `).run(LEGACY_LOCATION, now, now);
    db.prepare(`
      INSERT INTO branch_order_recipients
        (id, location_id, email, reply_to_email, subject_template, body_template, created_at, created_by, updated_at, updated_by)
      VALUES ('v091-legacy-recipient', ?, 'legacy@example.test', 'legacy@example.test', 'Bestellung {{locationName}}', '{{items}}', ?, 'v091-test', ?, 'v091-test')
    `).run(LEGACY_LOCATION, now, now);
    const groupRows = [
      ["v091-legacy-lager", "Lager"],
      ["v091-legacy-marketing", "Marketing"],
      ["v091-legacy-other", "Sonstiges"],
    ];
    for (const [id, title] of groupRows) {
      db.prepare(`
        INSERT INTO branch_order_groups
          (id, location_id, recipient_id, title, hint, active, sort_order, created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, 'v091-legacy-recipient', ?, '', 1, 1, ?, 'v091-test', ?, 'v091-test')
      `).run(id, LEGACY_LOCATION, title, now, now);
    }
    const itemRows = [
      ["v091-legacy-custom-lager", "v091-legacy-lager", "Eigene Plotterfolie", "Rolle"],
      ["v091-legacy-custom-marketing", "v091-legacy-marketing", "Eigener Marketingartikel", "Packung"],
      ["v091-legacy-custom-other", "v091-legacy-other", "Eigene Zusatzposition", "Stück"],
    ];
    for (const [id, groupId, title, unit] of itemRows) {
      db.prepare(`
        INSERT INTO branch_order_items
          (id, group_id, title, unit, active, sort_order, created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, 1, 1, ?, 'v091-test', ?, 'v091-test')
      `).run(id, groupId, title, unit, now, now);
    }
    const migrated = await requestJson(`/api/portal/v1/branch-orders/settings?locationId=${LEGACY_LOCATION}`, { session: hrSession });
    assert.equal(migrated.response.status, 200, JSON.stringify(migrated.payload));
    const titles = migrated.payload.configuration.groups.map((group) => group.title);
    assert.equal(titles.includes("Lager"), false);
    assert.equal(titles.includes("Marketing"), false);
    assert.equal(titles.includes("Sonstiges"), false);
    assert.ok(titles.includes("Fotowelt – Plotter"));
    const catalogTitles = migrated.payload.configuration.items.map((item) => item.title);
    assert.ok(catalogTitles.includes("Eigene Plotterfolie"));
    assert.ok(catalogTitles.includes("Eigener Marketingartikel"));
    assert.ok(catalogTitles.includes("Eigene Zusatzposition"));
    const otherGroup = migrated.payload.configuration.groups.find((group) => group.title === "Fotowelt – Weitere Positionen");
    const catalogById = new Map(migrated.payload.configuration.items.map((item) => [item.id, item.title]));
    assert.ok(otherGroup.itemIds.some((id) => catalogById.get(id) === "Eigene Plotterfolie"));
  });

  await t.test("Filialkonto-Anzeige ist ausschließlich persönlich für FL+ oder berechtigte AL konfigurierbar", async () => {
    const managerRead = await requestJson("/api/portal/v1/branch-portal-settings", { session: managerSession });
    assert.equal(managerRead.response.status, 200, JSON.stringify(managerRead.payload));
    assert.equal(managerRead.payload.settings.scheduleDisplayMode, "classic");
    const invalid = await requestJson("/api/portal/v1/branch-portal-settings", {
      method: "PUT",
      session: managerSession,
      body: { settings: { scheduleDisplayMode: "colored", mobileHideElapsedDays: true, orderAutosaveEnabled: true, orderAutosaveMinutes: 0 } },
    });
    assert.equal(invalid.response.status, 400, JSON.stringify(invalid.payload));
    const saved = await requestJson("/api/portal/v1/branch-portal-settings", {
      method: "PUT",
      session: managerSession,
      body: { settings: { scheduleDisplayMode: "colored", mobileHideElapsedDays: true, orderAutosaveEnabled: true, orderAutosaveMinutes: 17 } },
    });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
    assert.deepEqual(saved.payload.settings, {
      scheduleDisplayMode: "colored",
      mobileHideElapsedDays: true,
      orderAutosaveEnabled: true,
      orderAutosaveMinutes: 17,
      updatedAt: saved.payload.settings.updatedAt,
    });
    db.prepare(`
      INSERT INTO portal_organization_account_permissions (account_id, permission)
      VALUES (?, 'branch_portal:display:manage')
    `).run(accountId);
    const organizationDenied = await requestJson("/api/portal/v1/branch-portal-settings", {
      session: organizationSession,
    });
    assert.equal(organizationDenied.response.status, 403, JSON.stringify(organizationDenied.payload));
    db.prepare(`
      DELETE FROM portal_organization_account_permissions
      WHERE account_id = ? AND permission = 'branch_portal:display:manage'
    `).run(accountId);
    const schedule = await requestJson("/api/portal/v1/location-dashboard/schedule?week=2031-03-10", {
      session: organizationSession,
    });
    assert.equal(schedule.response.status, 200, JSON.stringify(schedule.payload));
    assert.equal(schedule.payload.displaySettings.orderAutosaveMinutes, 17);
    assert.equal(schedule.payload.displaySettings.scheduleDisplayMode, "colored");
    const catalogSettings = await requestJson("/api/portal/v1/branch-orders/catalog", { session: organizationSession });
    assert.equal(catalogSettings.response.status, 200, JSON.stringify(catalogSettings.payload));
    assert.equal(catalogSettings.payload.portalSettings.orderAutosaveEnabled, true);
    const employeeDenied = await requestJson("/api/portal/v1/branch-portal-settings", {
      session: createEmployeeSession(EMPLOYEE),
    });
    assert.equal(employeeDenied.response.status, 403, JSON.stringify(employeeDenied.payload));
    db.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES (?, 'branch_portal:display:manage', 'v091-legacy-test')
    `).run(IT_ADMIN);
    const itAdminDenied = await requestJson("/api/portal/v1/branch-portal-settings", {
      session: createEmployeeSession(IT_ADMIN),
    });
    assert.equal(itAdminDenied.response.status, 403, JSON.stringify(itAdminDenied.payload));
    db.prepare(`
      DELETE FROM portal_permission_grants
      WHERE employee_number = ? AND permission = 'branch_portal:display:manage'
    `).run(IT_ADMIN);
  });

  await t.test("Filialkonto speichert und lädt einen revisionsgeschützten Entwurf ohne Empfängerdaten", async () => {
    const refreshedCatalog = await requestJson("/api/portal/v1/branch-orders/catalog", { session: organizationSession });
    assert.equal(refreshedCatalog.response.status, 200, JSON.stringify(refreshedCatalog.payload));
    catalog = refreshedCatalog.payload;
    const instantPrint = catalog.groups.find((group) => group.title === "Fotowelt – Sofortdruck");
    const ds40 = instantPrint.items.find((item) => item.title === "Fotodrucker: Mediaset DS40");
    const ds620 = instantPrint.items.find((item) => item.title === "Fotodrucker: Mediaset DS620");

    const empty = await requestJson(`/api/portal/v1/branch-orders/draft?employeeNumber=${EMPLOYEE}`, {
      session: organizationSession,
    });
    assert.equal(empty.response.status, 200, JSON.stringify(empty.payload));
    assert.equal(empty.payload.draft, null);

    const saved = await requestJson("/api/portal/v1/branch-orders/draft", {
      method: "PUT",
      session: organizationSession,
      body: {
        employeeNumber: EMPLOYEE,
        expectedRevision: 0,
        items: [
          { itemId: ds40.id, quantity: 2 },
          { itemId: ds620.id, quantity: 3, note: "Später fertigstellen" },
        ],
      },
    });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
    assert.equal(saved.payload.draft.revision, 1);
    assert.equal(saved.payload.draft.selectedEmployeeNumber, EMPLOYEE);
    assert.equal(saved.payload.draft.items.length, 2);
    assert.equal(JSON.stringify(saved.payload).includes("lager@lamprechter.com"), false);
    assert.equal(JSON.stringify(saved.payload).includes("antworten@grabenplaner.eu"), false);

    const staleWrite = await requestJson("/api/portal/v1/branch-orders/draft", {
      method: "PUT",
      session: organizationSession,
      body: {
        employeeNumber: EMPLOYEE,
        expectedRevision: 0,
        items: [{ itemId: ds40.id, quantity: 9 }],
      },
    });
    assert.equal(staleWrite.response.status, 409, JSON.stringify(staleWrite.payload));
    assert.equal(staleWrite.payload.code, "BRANCH_ORDER_DRAFT_REVISION_CONFLICT");

    const updated = await requestJson("/api/portal/v1/branch-orders/draft", {
      method: "PUT",
      session: organizationSession,
      body: {
        employeeNumber: EMPLOYEE,
        expectedRevision: 1,
        items: [
          { itemId: ds40.id, quantity: 2 },
          { itemId: ds620.id, quantity: 3, note: "Dringend" },
        ],
      },
    });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
    assert.equal(updated.payload.draft.revision, 2);
    organizationOrderDraft = updated.payload.draft;

    const managerDenied = await requestJson(`/api/portal/v1/branch-orders/draft?employeeNumber=${EMPLOYEE}`, {
      session: managerSession,
    });
    assert.equal(managerDenied.response.status, 403, JSON.stringify(managerDenied.payload));
  });

  await t.test("Bestellung ignoriert eine übermittelte KW, speichert Momentaufnahmen und versendet über den freigegebenen Absender", async () => {
    db.prepare("UPDATE employees SET nickname = 'Mitzi' WHERE personnel_number = ?").run(EMPLOYEE);
    const refreshedCatalog = await requestJson("/api/portal/v1/branch-orders/catalog", { session: organizationSession });
    assert.equal(refreshedCatalog.response.status, 200, JSON.stringify(refreshedCatalog.payload));
    catalog = refreshedCatalog.payload;
    const instantPrint = catalog.groups.find((group) => group.title === "Fotowelt – Sofortdruck");
    const ds40 = instantPrint.items.find((item) => item.title === "Fotodrucker: Mediaset DS40");
    const ds620 = instantPrint.items.find((item) => item.title === "Fotodrucker: Mediaset DS620");
    const missingRevision = await requestJson("/api/portal/v1/branch-orders", {
      method: "POST",
      session: organizationSession,
      body: { employeeNumber: EMPLOYEE, items: [{ itemId: ds40.id, quantity: 2 }] },
    });
    assert.equal(missingRevision.response.status, 409, JSON.stringify(missingRevision.payload));
    assert.equal(missingRevision.payload.code, "BRANCH_ORDER_DRAFT_REVISION_CONFLICT");
    const decimal = await requestJson("/api/portal/v1/branch-orders", {
      method: "POST",
      session: organizationSession,
      body: {
        employeeNumber: EMPLOYEE,
        draftRevision: organizationOrderDraft.revision,
        items: [{ itemId: ds620.id, quantity: 1.5 }],
      },
    });
    assert.equal(decimal.response.status, 400, JSON.stringify(decimal.payload));
    assert.equal(decimal.payload.code, "BRANCH_ORDER_QUANTITY_INVALID");
    const draftAfterValidationFailure = await requestJson(`/api/portal/v1/branch-orders/draft?employeeNumber=${EMPLOYEE}`, {
      session: organizationSession,
    });
    assert.equal(draftAfterValidationFailure.response.status, 200, JSON.stringify(draftAfterValidationFailure.payload));
    assert.equal(draftAfterValidationFailure.payload.draft.revision, organizationOrderDraft.revision);
    const order = await requestJson("/api/portal/v1/branch-orders", {
      method: "POST",
      session: organizationSession,
      body: {
        employeeNumber: EMPLOYEE,
        calendarWeek: 1,
        draftRevision: organizationOrderDraft.revision,
        items: [
          { itemId: ds40.id, quantity: 2 },
          { itemId: ds620.id, quantity: 3, note: "Dringend" },
        ],
      },
    });
    assert.equal(order.response.status, 201, JSON.stringify(order.payload));
    assert.equal(order.payload.order.calendarWeek, catalog.calendarWeek);
    assert.equal(order.payload.order.status, "sent");
    assert.equal(order.payload.order.draftConsumed, true);
    assert.match(order.payload.order.pdf.filename, /^Filialbestellung-18-KW\d{2}-.+\.pdf$/);
    assert.match(order.payload.order.pdf.sha256, /^[a-f0-9]{64}$/);
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].from, "fil18-noreply@grabenplaner.eu");
    assert.equal(sentMails[0].to, "lager@lamprechter.com");
    assert.equal(sentMails[0].replyTo, "antworten@grabenplaner.eu");
    assert.match(sentMails[0].subject, /Filialbestellung Mitzi/);
    assert.match(sentMails[0].text, /Dienstplanname: Mitzi/);
    assert.match(sentMails[0].text, /Fotodrucker: Mediaset DS40: 2 Karton/);
    assert.match(sentMails[0].text, /Bitte antworten Sie an antworten@grabenplaner\.eu\./);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM branch_order_lines WHERE order_id = ?").get(order.payload.order.id).count,
      2,
    );
    const snapshot = db.prepare(`
      SELECT line.item_title, line.unit, delivery.sender_email
      FROM branch_order_lines line
      JOIN branch_order_deliveries delivery ON delivery.order_id = line.order_id
      WHERE line.order_id = ? AND line.item_title = 'Fotodrucker: Mediaset DS40'
    `).get(order.payload.order.id);
    assert.deepEqual({ ...snapshot }, {
      item_title: "Fotodrucker: Mediaset DS40",
      unit: "Karton",
      sender_email: "fil18-noreply@grabenplaner.eu",
    });

    const history = await requestJson("/api/portal/v1/branch-orders/history?limit=10", { session: hrSession });
    assert.equal(history.response.status, 200, JSON.stringify(history.payload));
    assert.equal(history.payload.orders[0].status, "sent");
    assert.equal(history.payload.orders[0].selectedEmployeeNumber, EMPLOYEE);
    assert.equal(history.payload.orders[0].lines.length, 2);
    assert.equal(history.payload.orders[0].pdfAvailable, true);

    const branchHistory = await requestJson("/api/portal/v1/branch-orders/history?limit=10", { session: organizationSession });
    assert.equal(branchHistory.response.status, 200, JSON.stringify(branchHistory.payload));
    assert.equal(branchHistory.payload.orders[0].deliveries, undefined);
    assert.equal(JSON.stringify(branchHistory.payload).includes("lager@lamprechter.com"), false);

    const pdf = await requestBinary(`/api/portal/v1/branch-orders/${encodeURIComponent(order.payload.order.id)}/pdf`, {
      session: organizationSession,
    });
    assert.equal(pdf.response.status, 200);
    assert.match(pdf.response.headers.get("content-type") || "", /^application\/pdf/);
    assert.match(pdf.response.headers.get("content-disposition") || "", /^inline;/);
    assert.equal(pdf.content.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.ok(pdf.content.length > 1000 && pdf.content.length <= 512 * 1024);
    const storedPdf = db.prepare(`
      SELECT pdf_content AS content, pdf_sha256 AS sha256, pdf_filename AS filename
      FROM branch_orders WHERE id = ?
    `).get(order.payload.order.id);
    assert.equal(Buffer.compare(Buffer.from(storedPdf.content), pdf.content), 0);
    assert.equal(storedPdf.sha256, order.payload.order.pdf.sha256);
    assert.equal(storedPdf.filename, order.payload.order.pdf.filename);
    const consumedDraft = await requestJson(`/api/portal/v1/branch-orders/draft?employeeNumber=${EMPLOYEE}`, {
      session: organizationSession,
    });
    assert.equal(consumedDraft.response.status, 200, JSON.stringify(consumedDraft.payload));
    assert.equal(consumedDraft.payload.draft, null);
  });

  await t.test("PL+ kann Marie-Theres (275) für persönliche Filialbestellungen freischalten", async () => {
    const beforeGrant = await requestJson("/api/portal/v1/branch-orders/catalog", {
      session: createEmployeeSession(EMPLOYEE),
    });
    assert.equal(beforeGrant.response.status, 403, JSON.stringify(beforeGrant.payload));

    const granted = await requestJson(`/api/portal/v1/rights/${encodeURIComponent(EMPLOYEE)}`, {
      method: "PUT",
      session: hrSession,
      body: {
        grantedPermissions: ["branch_orders:submit"],
        deniedPermissions: [],
        scopes: [],
      },
    });
    assert.equal(granted.response.status, 200, JSON.stringify(granted.payload));
    assert.ok(granted.payload.users
      .find((user) => user.employeeNumber === EMPLOYEE)?.effectivePermissions
      .includes("branch_orders:submit"));

    const personalSession = createEmployeeSession(EMPLOYEE);
    const personalCatalog = await requestJson("/api/portal/v1/branch-orders/catalog", { session: personalSession });
    assert.equal(personalCatalog.response.status, 200, JSON.stringify(personalCatalog.payload));
    assert.equal(personalCatalog.payload.submissionMode, "self");
    assert.equal(personalCatalog.payload.senderEmail, "fil18-noreply@grabenplaner.eu");
    assert.deepEqual(personalCatalog.payload.employees, [{
      employeeNumber: EMPLOYEE,
      fullName: "Marie-Theres",
    }]);
    const personalSettings = await requestJson("/api/portal/v1/branch-orders/settings", { session: personalSession });
    assert.equal(personalSettings.response.status, 403, JSON.stringify(personalSettings.payload));

    const instantPrint = personalCatalog.payload.groups.find((group) => group.title === "Fotowelt – Sofortdruck");
    const ds80 = instantPrint.items.find((item) => item.title === "Fotodrucker: Mediaset DS80");
    const personalDraft = await requestJson("/api/portal/v1/branch-orders/draft", {
      method: "PUT",
      session: personalSession,
      body: {
        employeeNumber: OTHER_MANAGER,
        expectedRevision: 0,
        items: [{ itemId: ds80.id, quantity: 1, note: "Persönlicher Entwurf" }],
      },
    });
    assert.equal(personalDraft.response.status, 200, JSON.stringify(personalDraft.payload));
    assert.equal(personalDraft.payload.draft.selectedEmployeeNumber, EMPLOYEE);
    assert.equal(personalDraft.payload.draft.revision, 1);
    const branchCannotSeePersonalDraft = await requestJson(`/api/portal/v1/branch-orders/draft?employeeNumber=${EMPLOYEE}`, {
      session: organizationSession,
    });
    assert.equal(branchCannotSeePersonalDraft.response.status, 200, JSON.stringify(branchCannotSeePersonalDraft.payload));
    assert.equal(branchCannotSeePersonalDraft.payload.draft, null);
    const personalOrder = await requestJson("/api/portal/v1/branch-orders", {
      method: "POST",
      session: personalSession,
      body: {
        employeeNumber: OTHER_MANAGER,
        draftRevision: personalDraft.payload.draft.revision,
        items: [{ itemId: ds80.id, quantity: 1 }],
      },
    });
    assert.equal(personalOrder.response.status, 201, JSON.stringify(personalOrder.payload));
    assert.equal(personalOrder.payload.order.selectedEmployeeNumber, EMPLOYEE);
    assert.equal(personalOrder.payload.order.senderEmail, "fil18-noreply@grabenplaner.eu");
    assert.equal(personalOrder.payload.order.draftConsumed, true);

    const personalHistory = await requestJson("/api/portal/v1/branch-orders/history?limit=10", { session: personalSession });
    assert.equal(personalHistory.response.status, 200, JSON.stringify(personalHistory.payload));
    assert.ok(personalHistory.payload.orders.length >= 1);
    assert.ok(personalHistory.payload.orders.every((order) => order.selectedEmployeeNumber === EMPLOYEE));
    assert.equal(JSON.stringify(personalHistory.payload).includes("lager@lamprechter.com"), false);
    const personalPdf = await requestBinary(`/api/portal/v1/branch-orders/${encodeURIComponent(personalOrder.payload.order.id)}/pdf?download=1`, {
      session: personalSession,
    });
    assert.equal(personalPdf.response.status, 200);
    assert.match(personalPdf.response.headers.get("content-disposition") || "", /^attachment;/);
    assert.equal(personalPdf.content.subarray(0, 5).toString("ascii"), "%PDF-");

    const discardCandidate = await requestJson("/api/portal/v1/branch-orders/draft", {
      method: "PUT",
      session: personalSession,
      body: {
        expectedRevision: 0,
        items: [{ itemId: ds80.id, quantity: 2 }],
      },
    });
    assert.equal(discardCandidate.response.status, 200, JSON.stringify(discardCandidate.payload));
    const discarded = await requestJson("/api/portal/v1/branch-orders/draft", {
      method: "DELETE",
      session: personalSession,
      body: { expectedRevision: discardCandidate.payload.draft.revision },
    });
    assert.equal(discarded.response.status, 200, JSON.stringify(discarded.payload));
    assert.equal(discarded.payload.deleted, true);
  });

  await t.test("ein Versandfehler verliert die Bestellung nicht und wird im Verlauf markiert", async () => {
    const instantPrint = catalog.groups.find((group) => group.title === "Fotowelt – Sofortdruck");
    const ds80 = instantPrint.items.find((item) => item.title === "Fotodrucker: Mediaset DS80");
    failNextMail = true;
    const failed = await requestJson("/api/portal/v1/branch-orders", {
      method: "POST",
      session: organizationSession,
      body: { employeeNumber: EMPLOYEE, items: [{ itemId: ds80.id, quantity: 1 }] },
    });
    assert.equal(failed.response.status, 202, JSON.stringify(failed.payload));
    assert.equal(failed.payload.order.status, "failed");
    assert.equal(
      db.prepare("SELECT status FROM branch_orders WHERE id = ?").get(failed.payload.order.id).status,
      "failed",
    );
    assert.equal(
      db.prepare("SELECT status FROM branch_order_deliveries WHERE order_id = ?").get(failed.payload.order.id).status,
      "failed",
    );
    const confirmed = await requestJson(
      `/api/portal/v1/branch-orders/${encodeURIComponent(failed.payload.order.id)}/delivery-confirmation`,
      {
        method: "POST",
        session: hrSession,
        body: { locationId: LOCATION },
      },
    );
    assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.payload));
    assert.equal(confirmed.payload.delivery.status, "sent");
    assert.equal(confirmed.payload.delivery.changed, 1);
    assert.equal(
      db.prepare("SELECT status FROM branch_orders WHERE id = ?").get(failed.payload.order.id).status,
      "sent",
    );
    assert.equal(
      db.prepare("SELECT status FROM branch_order_deliveries WHERE order_id = ?").get(failed.payload.order.id).status,
      "sent",
    );
    const audit = db.prepare(`
      SELECT action, entity_type, entity_id
      FROM audit_log
      WHERE action = 'branch-order.delivery.confirm' AND entity_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(failed.payload.order.id);
    assert.deepEqual({ ...audit }, {
      action: "branch-order.delivery.confirm",
      entity_type: "branch_order",
      entity_id: failed.payload.order.id,
    });
  });
});

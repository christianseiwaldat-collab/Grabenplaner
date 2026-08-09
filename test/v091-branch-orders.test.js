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
const HR = "v091hr";
const MANAGER = "252";
const EMPLOYEE = "v091ma";
const OTHER_MANAGER = "v091other";
const ORGANIZATION_LOGIN = "fil18";
const INITIAL_PASSWORD = "Filialkonto-v091!";
const ACTIVE_PASSWORD = "Filialkonto-aktiv-v091!";

let baseUrl;
let httpServer;
let hrSession;
let managerSession;
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
  ensureEmployee(HR, "Herta Personal", LOCATION, "hr");
  ensureEmployee(MANAGER, "Mara Filialleitung", LOCATION, "manager");
  ensureEmployee(EMPLOYEE, "Max Mitarbeiter", LOCATION, "employee");
  ensureEmployee(OTHER_MANAGER, "Olaf Andere", OTHER_LOCATION, "manager");
  insertReadOnlyFixtures();
  hrSession = createEmployeeSession(HR);
  managerSession = createEmployeeSession(MANAGER);
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

test("v0.91: Filialkonto sieht Leihen und Wochen, Filialleitung verwaltet Bestellungen", async (t) => {
  let accountId;
  let catalog;

  await t.test("Filialkonto erhält die drei Basisansichten auch aus einem alten leeren Grant-Satz", async () => {
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
      "branch_orders:submit",
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
      "branch_orders:submit",
    ]));
    organizationSession = responseSession(login.response);
    const changed = await requestJson("/api/portal/v1/me/password", {
      method: "PUT",
      session: organizationSession,
      body: { currentPassword: INITIAL_PASSWORD, newPassword: ACTIVE_PASSWORD },
    });
    assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  });

  await t.test("vergangene, aktuelle und kommende KW bleiben lesbar; Leih- und Urlaubsansicht bleiben datensparsam", async () => {
    for (const week of ["2031-03-03", "2031-03-10", "2031-03-17"]) {
      const result = await requestJson(`/api/portal/v1/location-dashboard/schedule?week=${week}`, {
        session: organizationSession,
      });
      assert.equal(result.response.status, 200, JSON.stringify(result.payload));
      assert.equal(result.payload.weekStart, week);
      assert.equal(JSON.stringify(result.payload).includes("nicht für Filialkonto"), false);
    }
    const vacations = await requestJson("/api/portal/v1/location-dashboard/vacations?week=2031-03-10", {
      session: organizationSession,
    });
    assert.equal(vacations.response.status, 200, JSON.stringify(vacations.payload));
    assert.deepEqual(vacations.payload.vacations, [{
      employeeName: "Max",
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
    const warehouse = catalog.groups.find((group) => group.title === "Lager");
    assert.ok(warehouse);
    assert.deepEqual(
      new Set(warehouse.items.filter((item) => item.title.includes("Mediaset")).map((item) => item.title)),
      new Set(["Fotodrucker: Mediaset DS40", "Fotodrucker: Mediaset DS80", "Fotodrucker: Mediaset DS620"]),
    );
  });

  await t.test("die Filialleitung 252 konfiguriert Einheiten, Antwortadresse und Vorlagen nur im eigenen Standort", async () => {
    const settings = await requestJson("/api/portal/v1/branch-orders/settings", { session: managerSession });
    assert.equal(settings.response.status, 200, JSON.stringify(settings.payload));
    assert.equal(settings.payload.locationId, LOCATION);
    const configuration = settings.payload.configuration;
    for (const recipient of configuration.recipients) recipient.replyToEmail = "antworten@grabenplaner.eu";
    const warehouse = configuration.groups.find((group) => group.title === "Lager");
    warehouse.items.find((item) => item.title === "Fotodrucker: Mediaset DS40").unit = "Karton";
    const saved = await requestJson("/api/portal/v1/branch-orders/settings", {
      method: "PUT",
      session: managerSession,
      body: { locationId: LOCATION, configuration },
    });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
    assert.equal(saved.payload.configuration.groups
      .find((group) => group.title === "Lager").items
      .find((item) => item.title === "Fotodrucker: Mediaset DS40").unit, "Karton");

    const otherManager = createEmployeeSession(OTHER_MANAGER);
    const denied = await requestJson(`/api/portal/v1/branch-orders/settings?locationId=${LOCATION}`, { session: otherManager });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    const accountDenied = await requestJson("/api/portal/v1/branch-orders/settings", { session: organizationSession });
    assert.equal(accountDenied.response.status, 403, JSON.stringify(accountDenied.payload));
  });

  await t.test("Bestellung ignoriert eine übermittelte KW, speichert Momentaufnahmen und versendet über den freigegebenen Absender", async () => {
    const refreshedCatalog = await requestJson("/api/portal/v1/branch-orders/catalog", { session: organizationSession });
    assert.equal(refreshedCatalog.response.status, 200, JSON.stringify(refreshedCatalog.payload));
    catalog = refreshedCatalog.payload;
    const warehouse = catalog.groups.find((group) => group.title === "Lager");
    const ds40 = warehouse.items.find((item) => item.title === "Fotodrucker: Mediaset DS40");
    const ds620 = warehouse.items.find((item) => item.title === "Fotodrucker: Mediaset DS620");
    const order = await requestJson("/api/portal/v1/branch-orders", {
      method: "POST",
      session: organizationSession,
      body: {
        employeeNumber: EMPLOYEE,
        calendarWeek: 1,
        items: [
          { itemId: ds40.id, quantity: 2 },
          { itemId: ds620.id, quantity: 1.5, note: "Dringend" },
        ],
      },
    });
    assert.equal(order.response.status, 201, JSON.stringify(order.payload));
    assert.equal(order.payload.order.calendarWeek, catalog.calendarWeek);
    assert.equal(order.payload.order.status, "sent");
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].from, "fil18-noreply@grabenplaner.eu");
    assert.equal(sentMails[0].to, "lager@lamprechter.com");
    assert.equal(sentMails[0].replyTo, "antworten@grabenplaner.eu");
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

    const history = await requestJson("/api/portal/v1/branch-orders/history?limit=10", { session: managerSession });
    assert.equal(history.response.status, 200, JSON.stringify(history.payload));
    assert.equal(history.payload.orders[0].status, "sent");
    assert.equal(history.payload.orders[0].selectedEmployeeNumber, EMPLOYEE);
    assert.equal(history.payload.orders[0].lines.length, 2);
  });

  await t.test("ein Versandfehler verliert die Bestellung nicht und wird im Verlauf markiert", async () => {
    const warehouse = catalog.groups.find((group) => group.title === "Lager");
    const ds80 = warehouse.items.find((item) => item.title === "Fotodrucker: Mediaset DS80");
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
  });
});

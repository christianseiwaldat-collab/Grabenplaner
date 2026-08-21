const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v071-page-appearance-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db } = subject;
let httpServer;
let baseUrl;

function ensureEmployee(employeeNumber, fullName, locationId) {
  db.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname, home_location_id, active)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      active = 1
  `).run(employeeNumber, fullName, fullName.split(" ")[0], locationId);
}

function createPortalSession(employeeNumber, role) {
  const token = `v071-${employeeNumber}-${crypto.randomBytes(24).toString("hex")}`;
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only', role = excluded.role, active = 1,
      must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return {
    cookie: `grabenplaner_session=${encodeURIComponent(token)}; grabenplaner_csrf=${encodeURIComponent(csrf)}`,
    csrf,
  };
}

async function requestJson(route, { method = "GET", session = null, body } = {}) {
  const headers = { Accept: "application/json" };
  if (session) headers.Cookie = session.cookie;
  if (session && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

function resetFixture() {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM portal_sessions WHERE employee_number LIKE 'v071-%'").run();
    db.prepare("DELETE FROM portal_user_preferences WHERE employee_number LIKE 'v071-%'").run();
    db.prepare("DELETE FROM portal_users WHERE employee_number LIKE 'v071-%'").run();
    db.prepare("DELETE FROM employees WHERE personnel_number LIKE 'v071-%'").run();
    const locationId = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id;
    ensureEmployee("v071-admin", "Ada Ansicht", locationId);
    ensureEmployee("v071-manager", "Mara Ansicht", locationId);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function seedSalesAnalyticsPdfFixture(locationId) {
  const reportId = crypto.createHash("sha256").update(`v071-sales-pdf-${crypto.randomUUID()}`).digest("hex");
  const sourceHash = crypto.createHash("sha256").update(`${reportId}-source`).digest("hex");
  db.prepare(`
    INSERT INTO sales_aggregate_reports (
      id, source_system, source_file_sha256, parser_version, extraction, review_method,
      report_kind, external_branch_id, location_id, currency, period_start, period_end,
      comparison_start, comparison_end, year_to_date_start, year_to_date_comparison_start,
      generated_on, page_count, product_group_count, issue_count, reconciliation_status,
      imported_by, imported_at
    ) VALUES (
      ?, 'tradefoto_report', ?, 2, 'pdf_text_coordinates', 'source_text_confirmed',
      'product_group_net', '18', ?, 'EUR', '2026-07-01', '2026-07-31',
      '2025-07-01', '2025-07-31', '2026-01-01', '2025-01-01', '2026-08-03',
      1, 3, 0, 'match', 'v071-admin', '2026-08-21T10:00:00.000Z'
    )
  `).run(reportId, sourceHash, locationId);
  const insertGroup = db.prepare(`
    INSERT INTO sales_report_product_group_metrics (
      report_id, horizon, external_product_group_id, product_group_label,
      current_quantity, comparison_quantity, current_net_revenue, comparison_net_revenue,
      current_gross_margin, comparison_gross_margin, current_customer_count,
      comparison_customer_count, current_revenue_per_customer,
      comparison_revenue_per_customer, source_page, source_ordinate
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  const groups = [
    ["101", "Kameras", 12, 10, 1200, 1000, 320, 270, 11, 9, 109.09, 111.11],
    ["202", "Objektive", 8, 11, 880, 1210, 250, 350, 7, 10, 125.71, 121],
    ["303", "Zubehör", 30, 24, 750, 600, 210, 165, 25, 20, 30, 30],
  ];
  for (const horizon of ["period", "year_to_date"]) {
    groups.forEach((group, index) => insertGroup.run(
      reportId,
      horizon,
      group[0],
      group[1],
      ...group.slice(2).map((value) => Number(value).toFixed(4)),
      String(100 + index),
    ));
    db.prepare(`
      INSERT INTO sales_report_total_metrics (
        report_id, horizon, current_quantity, comparison_quantity,
        current_net_revenue, comparison_net_revenue, current_gross_margin,
        comparison_gross_margin, current_customer_count, comparison_customer_count,
        current_revenue_per_customer, comparison_revenue_per_customer, source_page
      ) VALUES (?, ?, '50.0000', '45.0000', '2830.0000', '2810.0000',
        '780.0000', '785.0000', '43.0000', '39.0000', '65.8100', '72.0500', 1)
    `).run(reportId, horizon);
  }
  return reportId;
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.beforeEach(resetFixture);

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.71: Jede Hauptseite bietet eine eigene gespeicherte Darstellung", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.equal((html.match(/class="page-theme-switch/g) || []).length, 10);
  assert.match(script, /personnelAdministration:\s*"light"/);
  assert.match(script, /loans:\s*"light"/);
  assert.match(script, /branchOrders:\s*"light"/);
  const decreaseFontScale = html.indexOf('id="decreaseAppFontScale"');
  const fontScalePercent = html.indexOf('id="appFontScalePercent"');
  const increaseFontScale = html.indexOf('id="increaseAppFontScale"');
  assert.ok(decreaseFontScale >= 0 && decreaseFontScale < fontScalePercent);
  assert.ok(fontScalePercent < increaseFontScale);
  assert.match(html, /id="appFontScalePercent" type="number" min="75" max="150" step="5" value="100"/);
  assert.match(html, /class="app-font-scale-value"[\s\S]*?<span[^>]*>%<\/span>/);
  assert.doesNotMatch(html, /id="dashboardFontSize"/);
  assert.match(script, /loadUiPreferences/);
  assert.match(script, /function applyAppFontScalePercent\(value\)/);
  assert.match(script, /document\.documentElement\.style\.setProperty\("--app-font-scale"/);
  assert.match(script, /formatAmuPeriod/);
  assert.doesNotMatch(script, /formatDate\(report\.incapacity_to\)/);
  assert.match(styles, /data-active-page-theme="dark"[^\n]*\.system-footer/);
  assert.match(styles, /data-active-page-theme="dark"[^\n]*#planningView \.day-body/);
  assert.match(styles, /data-active-page-theme="dark"\] \.view\.active:not\(\.rights-dashboard\) :is\([\s\S]{0,900}\.integration-contract-row/);
  assert.match(styles, /data-active-page-theme="dark"\] \.view\.active:not\(\.rights-dashboard\) :is\([\s\S]{0,900}\.wifi-location-mapping-row/);
  assert.match(styles, /data-active-page-theme="dark"\] \.view\.active:not\(\.rights-dashboard\) :is\([\s\S]{0,900}\.pilot-checklist/);
  assert.match(styles, /data-active-page-theme="dark"\] :is\(\.settings-tabs,\.timeline-scroll/);
  assert.match(script, /--employee-contrast:\$\{contrastColor\(employee\.color\)\}/);
  assert.match(styles, /--app-font-scale:\s*1;/);
  assert.match(styles, /body \{[^}]*zoom:\s*var\(--app-font-scale\);/);
  assert.doesNotMatch(styles, /data-dashboard-font-size=/);
});

test("v0.92.6: Antragssperren nutzen unter dem Urlaubskalender einen einklappbaren Zeitraumkalender", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const calendarPosition = html.indexOf('id="vacationCalendar"');
  const blackoutPosition = html.indexOf('id="requestBlackoutPanel"');
  assert.ok(calendarPosition >= 0 && blackoutPosition > calendarPosition);
  assert.match(html, /<details class="vacation-panel request-blackout-panel" id="requestBlackoutPanel">/);
  assert.match(html, /id="requestBlackoutDateFrom" type="hidden"/);
  assert.match(html, /id="requestBlackoutDateTo" type="hidden"/);
  assert.match(html, /id="requestBlackoutDateRangeButton"[^>]+aria-controls="requestBlackoutDateRangeDialog"/);
  assert.ok(html.indexOf('/date-range-calendar.js') < html.indexOf('/app.js'));
  assert.match(script, /initializeRequestBlackoutDateRangeCalendar/);
  assert.match(script, /vacation-calendar-view-v1/);
  assert.match(script, /vacationCalendarView:\s*submitted/);
});

test("v0.71: Seitendarstellungen und Grabenplaner-Schriftgröße sind benutzerbezogen", async () => {
  const admin = createPortalSession("v071-admin", "admin");
  const manager = createPortalSession("v071-manager", "manager");

  const defaults = await requestJson("/api/portal/v1/ui-preferences", { session: admin });
  assert.equal(defaults.response.status, 200, JSON.stringify(defaults.payload));
  assert.equal(defaults.payload.pageThemes.startDashboard, "light");
  assert.equal(defaults.payload.pageThemes.filialAdministration, "light");
  assert.equal(defaults.payload.pageThemes.planning, "light");
  assert.equal(defaults.payload.pageThemes.personnelAdministration, "light");
  assert.equal(defaults.payload.pageThemes.rightsDashboard, "light");
  assert.equal(defaults.payload.appFontScalePercent, 100);
  assert.equal(defaults.payload.dashboardFontSize, undefined);
  assert.ok(defaults.payload.employeeDisplayColumns.includes("name"));
  assert.deepEqual(defaults.payload.employeeDisplaySort, { key: "personnel_number", direction: "asc" });
  assert.equal(defaults.payload.vacationCalendarView.version, 1);
  assert.equal(defaults.payload.vacationCalendarView.view, "year");
  assert.deepEqual(defaults.payload.personnelDashboardLayout, {
    version: 1,
    order: ["employees", "applications", "workflows", "tasks", "requests", "timeTracking", "costCenters", "ruleDrafts", "collectiveAgreements", "vacations", "dataRequests"],
    hidden: [],
  });
  assert.deepEqual(defaults.payload.startDashboardPreferences, {
    version: 1,
    hidden: [],
    locationId: "",
    departmentId: "",
    salesLocationId: "",
  });

  const personnelDashboardLayout = {
    version: 1,
    order: ["requests", "employees", "applications", "workflows", "tasks", "costCenters", "timeTracking", "vacations", "ruleDrafts", "collectiveAgreements", "dataRequests"],
    hidden: ["collectiveAgreements"],
  };
  const vacationCalendarView = {
    version: 1,
    year: 2034,
    view: "quarter",
    quarter: 3,
    month: 8,
  };
  const startDashboardPreferences = {
    version: 1,
    hidden: ["branchAbsences", "salesTopGroups"],
    locationId: "18",
    departmentId: "7",
    salesLocationId: "5",
  };
  const changed = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: admin,
    body: {
      pageThemes: {
        startDashboard: "dark",
        filialAdministration: "dark",
        planning: "dark",
        requests: "dark",
        timeTracking: "dark",
        vacations: "dark",
        personnelAdministration: "dark",
        personnel: "dark",
        salesAdministration: "dark",
        salesAnalytics: "dark",
        loans: "dark",
        branchOrders: "dark",
        rightsDashboard: "dark",
        settings: "dark",
      },
      appFontScalePercent: 115,
      employeeDisplayColumns: ["name", "phone", "assignment"],
      employeeDisplaySort: { key: "name", direction: "desc" },
      vacationCalendarView,
      personnelDashboardLayout,
      startDashboardPreferences,
    },
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.equal(changed.payload.pageThemes.filialAdministration, "dark");
  assert.equal(changed.payload.pageThemes.startDashboard, "dark");
  assert.equal(changed.payload.pageThemes.planning, "dark");
  assert.equal(changed.payload.pageThemes.personnelAdministration, "dark");
  assert.equal(changed.payload.pageThemes.rightsDashboard, "dark");
  assert.equal(changed.payload.appFontScalePercent, 115);
  assert.deepEqual(changed.payload.employeeDisplayColumns, ["name", "phone", "assignment"]);
  assert.deepEqual(changed.payload.employeeDisplaySort, { key: "name", direction: "desc" });
  assert.deepEqual(changed.payload.vacationCalendarView, vacationCalendarView);
  assert.deepEqual(changed.payload.personnelDashboardLayout, personnelDashboardLayout);
  assert.deepEqual(changed.payload.startDashboardPreferences, startDashboardPreferences);

  const refreshed = await requestJson("/api/portal/v1/ui-preferences", { session: admin });
  assert.equal(refreshed.payload.pageThemes.filialAdministration, "dark");
  assert.equal(refreshed.payload.pageThemes.startDashboard, "dark");
  assert.equal(refreshed.payload.pageThemes.planning, "dark");
  assert.equal(refreshed.payload.pageThemes.personnelAdministration, "dark");
  assert.equal(refreshed.payload.appFontScalePercent, 115);
  assert.deepEqual(refreshed.payload.employeeDisplayColumns, ["name", "phone", "assignment"]);
  assert.deepEqual(refreshed.payload.employeeDisplaySort, { key: "name", direction: "desc" });
  assert.deepEqual(refreshed.payload.vacationCalendarView, vacationCalendarView);
  assert.deepEqual(refreshed.payload.personnelDashboardLayout, personnelDashboardLayout);
  assert.deepEqual(refreshed.payload.startDashboardPreferences, startDashboardPreferences);

  const managerDefaults = await requestJson("/api/portal/v1/ui-preferences", { session: manager });
  assert.equal(managerDefaults.response.status, 200, JSON.stringify(managerDefaults.payload));
  assert.equal(managerDefaults.payload.pageThemes.planning, "light");
  assert.equal(managerDefaults.payload.pageThemes.personnelAdministration, "light");
  assert.equal(managerDefaults.payload.appFontScalePercent, 100);
  assert.ok(managerDefaults.payload.employeeDisplayColumns.includes("name"));
  assert.equal(managerDefaults.payload.vacationCalendarView.view, "year");
  assert.deepEqual(managerDefaults.payload.personnelDashboardLayout.hidden, []);
  assert.deepEqual(managerDefaults.payload.startDashboardPreferences.hidden, []);

  for (const appFontScalePercent of [75, 150]) {
    const boundary = await requestJson("/api/portal/v1/ui-preferences", {
      method: "PUT",
      session: admin,
      body: { appFontScalePercent },
    });
    assert.equal(boundary.response.status, 200, JSON.stringify(boundary.payload));
    assert.equal(boundary.payload.appFontScalePercent, appFontScalePercent);
    assert.deepEqual(boundary.payload.personnelDashboardLayout, personnelDashboardLayout);
  }
});

test("v0.71: Ungültige Darstellungswerte und anonyme Zugriffe werden abgewiesen", async () => {
  const admin = createPortalSession("v071-admin", "admin");
  const invalidView = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: admin,
    body: { pageThemes: { unknown: "dark" } },
  });
  assert.equal(invalidView.response.status, 400, JSON.stringify(invalidView.payload));
  for (const appFontScalePercent of [70, 155, 103, "110"]) {
    const invalidSize = await requestJson("/api/portal/v1/ui-preferences", {
      method: "PUT",
      session: admin,
      body: { appFontScalePercent },
    });
    assert.equal(invalidSize.response.status, 400, JSON.stringify(invalidSize.payload));
  }
  const invalidColumns = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: admin,
    body: { employeeDisplayColumns: ["name", "social_security_number"] },
  });
  assert.equal(invalidColumns.response.status, 400, JSON.stringify(invalidColumns.payload));
  const invalidSort = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: admin,
    body: { employeeDisplaySort: { key: "name", direction: "sideways" } },
  });
  assert.equal(invalidSort.response.status, 400, JSON.stringify(invalidSort.payload));
  for (const vacationCalendarView of [
    null,
    { version: 2, year: 2034, view: "quarter", quarter: 3, month: 8 },
    { version: 1, year: 1999, view: "quarter", quarter: 3, month: 8 },
    { version: 1, year: 2034, view: "week", quarter: 3, month: 8 },
    { version: 1, year: 2034, view: "quarter", quarter: 5, month: 8 },
    { version: 1, year: 2034, view: "quarter", quarter: 3, month: 13 },
  ]) {
    const invalidVacationView = await requestJson("/api/portal/v1/ui-preferences", {
      method: "PUT",
      session: admin,
      body: { vacationCalendarView },
    });
    assert.equal(invalidVacationView.response.status, 400, JSON.stringify(invalidVacationView.payload));
  }
  for (const personnelDashboardLayout of [
    null,
    { version: 2, order: [], hidden: [] },
    { version: 1, order: ["employees", "employees"], hidden: [] },
    { version: 1, order: ["unknown"], hidden: [] },
    { version: 1, order: [], hidden: ["unknown"] },
  ]) {
    const invalidLayout = await requestJson("/api/portal/v1/ui-preferences", {
      method: "PUT",
      session: admin,
      body: { personnelDashboardLayout },
    });
    assert.equal(invalidLayout.response.status, 400, JSON.stringify(invalidLayout.payload));
  }
  for (const startDashboardPreferences of [
    null,
    { version: 2, hidden: [], locationId: "", departmentId: "", salesLocationId: "" },
    { version: 1, hidden: ["unknown"], locationId: "", departmentId: "", salesLocationId: "" },
    { version: 1, hidden: [], locationId: "18!", departmentId: "", salesLocationId: "" },
    { version: 1, hidden: [], locationId: "18", departmentId: "A", salesLocationId: "" },
  ]) {
    const invalidPreferences = await requestJson("/api/portal/v1/ui-preferences", {
      method: "PUT",
      session: admin,
      body: { startDashboardPreferences },
    });
    assert.equal(invalidPreferences.response.status, 400, JSON.stringify(invalidPreferences.payload));
  }
  const anonymous = await requestJson("/api/portal/v1/ui-preferences");
  assert.equal(anonymous.response.status, 401, JSON.stringify(anonymous.payload));
});

test("Verkaufsanalyse: Grafikexport erzeugt aus der Rechteprojektion eine dreiseitige PDF", async () => {
  const session = createPortalSession("v071-admin", "admin");
  for (const permission of ["sales:analytics:access", "sales:analytics:company:read"]) {
    db.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES ('v071-admin', ?, 'v071-admin')
    `).run(permission);
  }
  const locationId = String(db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id);
  const reportId = seedSalesAnalyticsPdfFixture(locationId);
  const response = await fetch(`${baseUrl}/api/sales-analytics/charts.pdf`, {
    method: "POST",
    headers: {
      Accept: "application/pdf",
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrf,
    },
    body: JSON.stringify({ reportId, horizon: "period", metric: "netRevenue" }),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, buffer.toString("utf8", 0, 400));
  assert.match(response.headers.get("content-type") || "", /^application\/pdf/);
  assert.match(response.headers.get("cache-control") || "", /private/);
  assert.match(response.headers.get("content-disposition") || "", /Grabenplaner-Verkaufsanalyse/);
  assert.equal(buffer.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(buffer.length > 5000);
  const qaOutput = String(process.env.SALES_CHART_PDF_QA_OUTPUT || "").trim();
  if (qaOutput) fs.writeFileSync(qaOutput, buffer);

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true });
  try {
    const document = await loadingTask.promise;
    assert.equal(document.numPages, 3);
    const text = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      text.push(content.items.map((item) => item.str).join(" "));
      page.cleanup();
    }
    assert.match(text[0], /Aktuell und Vergleich/);
    assert.match(text[1], /relative Abweichungen/);
    assert.match(text[2], /Anteile nach Warengruppe/);
  } finally {
    await loadingTask.destroy();
  }
  const audit = db.prepare(`
    SELECT action, detail FROM audit_log
    WHERE actor = 'v071-admin' AND action = 'sales.report.charts.export'
    ORDER BY id DESC LIMIT 1
  `).get();
  assert.equal(audit.action, "sales.report.charts.export");
  assert.equal(JSON.parse(audit.detail).metric, "netRevenue");
});

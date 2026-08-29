"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v09210-team-meeting-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const { app, db, releaseInstanceLockForTests } = require("../server");

const LOCATION = "98";
const DEVELOPER = "9890";
const MEMBER_SICK_WITH_SHIFT = "9891";
const MEMBER_LATER_SICK = "9892";
const WEEK_START = "2035-03-12";
const MEETING_DATE = "2035-03-15";

let httpServer;
let baseUrl;
let departmentId;
const matrixPositionName = "Matrix-PDF-Testposition";

function ensureEmployee(personnelNumber, positionId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, position_id, home_location_id,
       preferred_department_id, active)
    VALUES (?, ?, ?, '#3c806a', 38.5, 5, ?, ?, ?, 1)
  `).run(
    personnelNumber,
    `Teamsitzung ${personnelNumber}`,
    `TS${personnelNumber.slice(-1)}`,
    positionId,
    LOCATION,
    departmentId,
  );
}

function session(employeeNumber, role = "developer") {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only', role = excluded.role, role_locked = 1,
      active = 1, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
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

async function request(route, { method = "GET", auth = null, body, binary = false } = {}) {
  const headers = { Accept: binary ? "application/pdf" : "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (binary) return { response, payload: Buffer.from(await response.arrayBuffer()) };
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload, text };
}

async function pdfTextDetails(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: Uint8Array.from(buffer),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  try {
    const pages = [];
    const items = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageItems = content.items.filter((item) => typeof item.str === "string");
      pages.push(pageItems.map((item) => item.str).join(" "));
      items.push(...pageItems.map((item) => ({ ...item, pageNumber })));
      page.cleanup();
    }
    return {
      pageCount: document.numPages,
      pages,
      text: pages.join("\n"),
      items,
    };
  } finally {
    await loadingTask.destroy();
  }
}

test.before(async () => {
  const positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get().id;
  db.prepare("UPDATE positions SET name = ? WHERE id = ?").run(matrixPositionName, positionId);
  const daySettings = db.prepare("SELECT day_settings_json FROM locations ORDER BY id LIMIT 1").get()?.day_settings_json || "{}";
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, day_settings_json, active)
    VALUES (?, 'Teamsitzungs-Testfiliale', 2, ?, 1)
  `).run(LOCATION, daySettings);
  departmentId = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Testteam', 2, 1, 1)
  `).run(LOCATION).lastInsertRowid);
  ensureEmployee(DEVELOPER, positionId);
  ensureEmployee(MEMBER_SICK_WITH_SHIFT, positionId);
  ensureEmployee(MEMBER_LATER_SICK, positionId);
  db.prepare(`
    INSERT INTO week_options
      (employee_number, week_start, date_from, date_to, option_type, note, all_day)
    VALUES (?, ?, ?, ?, 'sick', 'Krank vor Teamsitzung', 1)
  `).run(MEMBER_SICK_WITH_SHIFT, WEEK_START, MEETING_DATE, MEETING_DATE);
  db.prepare(`
    INSERT INTO shifts
      (employee_number, location_id, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, '17:00', '20:00', 'Testteam', 'Bestehender Dienst trotz Krankmeldung')
  `).run(MEMBER_SICK_WITH_SHIFT, LOCATION, departmentId, MEETING_DATE);
  db.prepare(`
    INSERT INTO shifts
      (employee_number, location_id, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, '09:00', '12:00', 'Testteam', 'Regulärer Dienst für Matrix-PDF')
  `).run(DEVELOPER, LOCATION, departmentId, WEEK_START);
  db.prepare(`
    INSERT INTO shifts
      (employee_number, location_id, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, '09:00', '18:00', 'Testteam', 'Regulärer Dienst vor Teamsitzung')
  `).run(DEVELOPER, LOCATION, departmentId, MEETING_DATE);
  db.prepare(`
    INSERT INTO week_options
      (employee_number, week_start, date_from, date_to, option_type, note, all_day)
    VALUES (?, ?, '2035-03-13', '2035-03-13', 'vacation', 'Urlaub für Matrix-PDF', 1)
  `).run(DEVELOPER, WEEK_START);
  db.prepare(`
    INSERT INTO week_options
      (employee_number, week_start, date_from, date_to, option_type, note, all_day)
    VALUES (?, ?, '2035-03-14', '2035-03-14', 'time_off', 'ZA für Matrix-PDF', 1)
  `).run(DEVELOPER, WEEK_START);
  for (const [employeeNumber, date, optionType, note] of [
    [MEMBER_LATER_SICK, "2035-03-12", "vocational_school", "Berufsschule für Matrix-PDF"],
    [MEMBER_LATER_SICK, "2035-03-13", "school", "Schulung für Matrix-PDF"],
    [MEMBER_LATER_SICK, "2035-03-14", "branch", "Andere Filiale für Matrix-PDF"],
  ]) {
    db.prepare(`
      INSERT INTO week_options
        (employee_number, week_start, date_from, date_to, option_type, note, all_day)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(employeeNumber, WEEK_START, date, date, optionType, note);
  }

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

test("v0.92.10: teamweite Teamsitzung ist atomar, krankheitsverträglich und bis 20 Uhr planbar", async () => {
  const auth = session(DEVELOPER);
  const body = {
    teamWide: true,
    locationId: LOCATION,
    departmentId,
    weekStart: WEEK_START,
    dateFrom: MEETING_DATE,
    dateTo: MEETING_DATE,
    optionType: "team_meeting",
    allDay: false,
    startTime: "18:00",
    endTime: "20:00",
    note: "Quartals-TS",
  };
  const created = await request("/api/week-options", { method: "POST", auth, body });
  assert.equal(created.response.status, 201, created.text);
  assert.equal(created.payload.teamWide, true);
  assert.equal(created.payload.employeeCount, 3);
  assert.match(created.payload.groupId, /^team-meeting:/);

  const stored = db.prepare(`
    SELECT id, employee_number, start_time, end_time, note
    FROM week_options WHERE group_id = ? ORDER BY employee_number
  `).all(created.payload.groupId);
  assert.equal(stored.length, 3);
  assert.deepEqual(new Set(stored.map((row) => row.employee_number)), new Set([
    DEVELOPER,
    MEMBER_SICK_WITH_SHIFT,
    MEMBER_LATER_SICK,
  ]));
  assert.ok(stored.every((row) => row.start_time === "18:00" && row.end_time === "20:00"));

  const laterSickness = await request("/api/week-options", {
    method: "POST",
    auth,
    body: {
      employeeNumber: MEMBER_LATER_SICK,
      weekStart: WEEK_START,
      dateFrom: MEETING_DATE,
      dateTo: MEETING_DATE,
      optionType: "sick",
      allDay: true,
      note: "Krank nach Teamsitzungsplanung",
    },
  });
  assert.equal(laterSickness.response.status, 201, laterSickness.text);

  const schedule = await request(`/api/schedule?week=${WEEK_START}&locationId=${LOCATION}&departmentId=${departmentId}`, { auth });
  assert.equal(schedule.response.status, 200, schedule.text);
  const meetingRows = schedule.payload.weekOptions.filter((option) => option.group_id === created.payload.groupId);
  assert.equal(meetingRows.length, 3);
  assert.equal(meetingRows.find((option) => option.employee_number === DEVELOPER).credited_minutes, 120);
  assert.equal(meetingRows.find((option) => option.employee_number === MEMBER_SICK_WITH_SHIFT).credited_minutes, 0);
  assert.equal(meetingRows.find((option) => option.employee_number === MEMBER_LATER_SICK).credited_minutes, 0);

  const updated = await request(`/api/week-options/${created.payload.id}`, {
    method: "PUT",
    auth,
    body: { ...body, startTime: "18:30", endTime: "20:00", note: "Quartals-TS aktualisiert" },
  });
  assert.equal(updated.response.status, 200, updated.text);
  assert.equal(updated.payload.employeeCount, 3);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM week_options
    WHERE group_id = ? AND start_time = '18:30' AND end_time = '20:00'
      AND note = 'Quartals-TS aktualisiert'
  `).get(created.payload.groupId).count, 3);

  const pdfSettings = await request("/api/settings", {
    method: "PUT",
    auth,
    body: {
      locationId: LOCATION,
      departmentId,
      pdfTitle: "Dienstplan PDF-Test",
      pdfFilenamePrefix: "Dienstplan PDF-Test",
      schedulePdfDesignIds: ["timeline", "matrix"],
      schedulePdfDesignNames: {
        timeline: "Klare Zeitachse",
        matrix: "Kompakte Wochenmatrix",
      },
      vacationPdfTitle: "Urlaubsplanung PDF-Test",
      vacationPdfFilenamePrefix: "Urlaubsplanung PDF-Test",
      externalBackupEnabled: false,
      backupDirectory: "",
      backupIntervalHours: 2,
      breakAfterMinutes: 360,
      breakDurationMinutes: 30,
      saturdayBonusFrom: "13:00",
      saturdayBonusFactor: 1.5,
      showSunday: true,
    },
  });
  assert.equal(pdfSettings.response.status, 200, pdfSettings.text);
  const persistedPdfSettings = await request(`/api/settings?locationId=${LOCATION}&departmentId=${departmentId}`, { auth });
  assert.equal(persistedPdfSettings.response.status, 200, persistedPdfSettings.text);
  assert.deepEqual(persistedPdfSettings.payload.pdf_schedule_design_ids, ["timeline", "matrix"]);
  assert.deepEqual(
    persistedPdfSettings.payload.schedule_pdf_design_catalog.map(({ id, label }) => ({ id, label })),
    [
      { id: "timeline", label: "Klare Zeitachse" },
      { id: "matrix", label: "Kompakte Wochenmatrix" },
    ],
  );
  const invalidPdfDesignNames = await request("/api/settings", {
    method: "PUT",
    auth,
    body: {
      locationId: LOCATION,
      departmentId,
      schedulePdfDesignIds: ["timeline", "matrix"],
      schedulePdfDesignNames: {
        timeline: "Doppelter Name",
        matrix: "doppelter name",
      },
    },
  });
  assert.equal(invalidPdfDesignNames.response.status, 400, invalidPdfDesignNames.text);
  assert.equal(invalidPdfDesignNames.payload?.code, "INVALID_SCHEDULE_PDF_DESIGN_NAMES");

  const managerAuth = session(MEMBER_LATER_SICK, "manager");
  const managerDenied = await request(`/api/portal/v1/schedule-pdf-settings?locationId=${LOCATION}`, {
    auth: managerAuth,
  });
  assert.equal(managerDenied.response.status, 403, managerDenied.text);
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'schedule:pdf:settings:write', ?)
  `).run(MEMBER_LATER_SICK, DEVELOPER);
  const managerScopedUpdate = await request("/api/portal/v1/schedule-pdf-settings", {
    method: "PUT",
    auth: managerAuth,
    body: { locationId: LOCATION, scheduleMatrixHeaderText: "FL-Matrix im eigenen Bereich" },
  });
  assert.equal(managerScopedUpdate.response.status, 200, managerScopedUpdate.text);
  assert.equal(
    managerScopedUpdate.payload.settings.pdf_schedule_matrix_header_text,
    "FL-Matrix im eigenen Bereich",
  );
  const foreignLocationId = String(db.prepare("SELECT id FROM locations WHERE id <> ? ORDER BY id LIMIT 1").get(LOCATION).id);
  const managerForeignScope = await request("/api/portal/v1/schedule-pdf-settings", {
    method: "PUT",
    auth: managerAuth,
    body: { locationId: foreignLocationId, scheduleMatrixHeaderText: "Nicht erlaubt" },
  });
  assert.equal(managerForeignScope.response.status, 403, managerForeignScope.text);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE actor = ? AND action = 'schedule.pdf.settings.update'
  `).get(MEMBER_LATER_SICK).count, 1);

  const maximumHeaderText = "M".repeat(200);
  const matrixSettings = await request("/api/portal/v1/schedule-pdf-settings", {
    method: "PUT",
    auth,
    body: {
      locationId: LOCATION,
      schedulePdfDesignIds: ["timeline", "matrix"],
      scheduleMatrixTimeFontSize: "18",
      scheduleMatrixDetailFontSize: "9.5",
      scheduleMatrixTimeFontBold: true,
      scheduleMatrixTimeEmployeeColor: true,
      scheduleMatrixShowPosition: false,
      scheduleMatrixHeaderText: maximumHeaderText,
    },
  });
  assert.equal(matrixSettings.response.status, 200, matrixSettings.text);
  assert.equal(matrixSettings.payload.settings.pdf_schedule_matrix_time_font_size, "18");
  assert.equal(matrixSettings.payload.settings.pdf_schedule_matrix_detail_font_size, "9.5");
  assert.equal(matrixSettings.payload.settings.pdf_schedule_matrix_time_font_bold, "1");
  assert.equal(matrixSettings.payload.settings.pdf_schedule_matrix_time_employee_color, "1");
  assert.equal(matrixSettings.payload.settings.pdf_schedule_matrix_show_position, "0");
  assert.equal(matrixSettings.payload.settings.pdf_schedule_matrix_header_text, maximumHeaderText);

  const persistedMatrixSettings = await request(`/api/portal/v1/schedule-pdf-settings?locationId=${LOCATION}`, { auth });
  assert.equal(persistedMatrixSettings.response.status, 200, persistedMatrixSettings.text);
  assert.equal(persistedMatrixSettings.payload.context.locationId, LOCATION);
  assert.equal(persistedMatrixSettings.payload.context.departmentId, null);
  assert.equal(persistedMatrixSettings.payload.settings.pdf_schedule_matrix_header_text.length, 200);
  assert.equal(persistedMatrixSettings.payload.settings.pdf_schedule_matrix_show_position, "0");

  const oversizedHeader = await request("/api/portal/v1/schedule-pdf-settings", {
    method: "PUT",
    auth,
    body: { locationId: LOCATION, scheduleMatrixHeaderText: "X".repeat(201) },
  });
  assert.equal(oversizedHeader.response.status, 400, oversizedHeader.text);
  assert.equal(oversizedHeader.payload?.code, "SCHEDULE_MATRIX_HEADER_TEXT_INVALID");

  const invalidMatrixFontSize = await request("/api/portal/v1/schedule-pdf-settings", {
    method: "PUT",
    auth,
    body: { locationId: LOCATION, scheduleMatrixTimeFontSize: "19" },
  });
  assert.equal(invalidMatrixFontSize.response.status, 400, invalidMatrixFontSize.text);
  assert.equal(invalidMatrixFontSize.payload?.code, "SCHEDULE_MATRIX_FONT_SIZE_INVALID");

  const invalidMatrixBoolean = await request("/api/portal/v1/schedule-pdf-settings", {
    method: "PUT",
    auth,
    body: { locationId: LOCATION, scheduleMatrixTimeFontBold: "true" },
  });
  assert.equal(invalidMatrixBoolean.response.status, 400, invalidMatrixBoolean.text);
  assert.equal(invalidMatrixBoolean.payload?.code, "SCHEDULE_PDF_BOOLEAN_INVALID");

  const renderMatrixSettings = await request("/api/portal/v1/schedule-pdf-settings", {
    method: "PUT",
    auth,
    body: { locationId: LOCATION, scheduleMatrixHeaderText: "Matrix-Testkopf" },
  });
  assert.equal(renderMatrixSettings.response.status, 200, renderMatrixSettings.text);

  const pdf = await request(`/api/schedule.pdf?week=${WEEK_START}&locationId=${LOCATION}&departmentId=${departmentId}&design=timeline`, {
    auth,
    binary: true,
  });
  assert.equal(pdf.response.status, 200);
  assert.match(pdf.response.headers.get("content-type") || "", /application\/pdf/);
  assert.ok(pdf.payload.length > 3000);

  for (const [optionType, note] of [
    ["vacation", "Überfüllungstest Urlaub"],
    ["time_off", "Überfüllungstest ZA"],
    ["school", "Überfüllungstest Schulung"],
  ]) {
    db.prepare(`
      INSERT INTO week_options
        (employee_number, week_start, date_from, date_to, option_type, note, all_day)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(DEVELOPER, WEEK_START, MEETING_DATE, MEETING_DATE, optionType, note);
  }

  const matrixPdf = await request(`/api/schedule.pdf?week=${WEEK_START}&locationId=${LOCATION}&design=matrix`, {
    auth,
    binary: true,
  });
  assert.equal(matrixPdf.response.status, 200);
  assert.match(matrixPdf.response.headers.get("content-type") || "", /application\/pdf/);
  assert.ok(matrixPdf.payload.length > 3000);
  if (process.env.GRABENPLANER_PDF_QA_OUTPUT) {
    const qaOutputPath = path.resolve(process.env.GRABENPLANER_PDF_QA_OUTPUT);
    fs.mkdirSync(path.dirname(qaOutputPath), { recursive: true });
    fs.writeFileSync(qaOutputPath, matrixPdf.payload);
  }
  const matrixPdfDetails = await pdfTextDetails(matrixPdf.payload);
  assert.equal(matrixPdfDetails.pageCount, 1);
  assert.match(matrixPdfDetails.text, /Matrix-Testkopf/);
  assert.match(matrixPdfDetails.text, /Teamsitzung \(TS\)/);
  assert.match(matrixPdfDetails.text, /18:30-20:00/);
  assert.match(matrixPdfDetails.text, /09:00-12:00/);
  assert.match(matrixPdfDetails.text, /09:00-18:00/);
  assert.match(matrixPdfDetails.text, /Testteam/);
  assert.doesNotMatch(matrixPdfDetails.text, /Matrix-PDF-Testposition/);
  assert.match(matrixPdfDetails.text, /\d+MA/);
  assert.match(matrixPdfDetails.text, /1U/);
  assert.match(matrixPdfDetails.text, /1ZA/);
  assert.match(matrixPdfDetails.text, /2K/);
  assert.match(matrixPdfDetails.text, /1BS/);
  assert.match(matrixPdfDetails.text, /1S/);
  assert.match(matrixPdfDetails.text, /1A/);
  assert.doesNotMatch(matrixPdfDetails.text, /Mitarbeitendenfarbe/);
  const regularShiftTime = matrixPdfDetails.items.find((item) => item.str === "09:00-12:00");
  assert.ok(regularShiftTime, "Der reguläre Dienst muss als eigener PDF-Textlauf vorhanden sein.");
  assert.ok(
    Number(regularShiftTime.height) > 8 && Number(regularShiftTime.height) <= 18.1,
    `Die konfigurierte 18-pt-Uhrzeit muss im 7-Tage-Fall nur passgenau verkleinert werden (ist ${regularShiftTime.height} pt).`,
  );
  const meetingDayShift = matrixPdfDetails.items.find((item) => item.str === "09:00-18:00");
  const meetingCellEntry = matrixPdfDetails.items.find((item) => (
    item.str.includes("TS")
    && item.str.includes("18:30-20:00")
    && meetingDayShift
    && Math.abs(Number(item.transform?.[4]) - Number(meetingDayShift.transform?.[4])) < 8
  ));
  assert.ok(meetingDayShift && meetingCellEntry, "Dienst und TS müssen als getrennte Textläufe in derselben Matrixzelle stehen.");
  assert.ok(
    Number(meetingDayShift.transform[5]) > Number(meetingCellEntry.transform[5]),
    "Die TS muss unter dem regulären Dienst stehen.",
  );
  assert.ok(
    matrixPdfDetails.items.filter((item) => item.str.includes("18:30-20:00")).length >= 2,
    "Die TS-Zeit muss in der Matrixzelle und in der ausgeschriebenen Erklärung vorkommen.",
  );
  assert.match(
    matrixPdfDetails.text,
    /\+2 weitere/,
    "Der Überfüllungsfall muss weitere Einträge kompakt zusammenfassen, ohne Dienst oder TS zu verdrängen.",
  );

  const positionVisibleSettings = await request("/api/portal/v1/schedule-pdf-settings", {
    method: "PUT",
    auth,
    body: { locationId: LOCATION, scheduleMatrixShowPosition: true },
  });
  assert.equal(positionVisibleSettings.response.status, 200, positionVisibleSettings.text);
  assert.equal(positionVisibleSettings.payload.settings.pdf_schedule_matrix_show_position, "1");
  const positionVisiblePdf = await request(`/api/schedule.pdf?week=${WEEK_START}&locationId=${LOCATION}&design=matrix`, {
    auth,
    binary: true,
  });
  const positionVisiblePdfDetails = await pdfTextDetails(positionVisiblePdf.payload);
  assert.match(positionVisiblePdfDetails.text, /Matrix-PDF-Testposition/);

  const unavailablePdf = await request(`/api/schedule.pdf?week=${WEEK_START}&locationId=${LOCATION}&departmentId=${departmentId}&design=unbekannt`, {
    auth,
  });
  assert.equal(unavailablePdf.response.status, 400, unavailablePdf.text);
  assert.equal(unavailablePdf.payload?.code, "INVALID_SCHEDULE_PDF_DESIGNS");

  const deleted = await request(`/api/week-options/${created.payload.id}`, { method: "DELETE", auth });
  assert.equal(deleted.response.status, 204, deleted.text);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM week_options WHERE group_id = ?")
    .get(created.payload.groupId).count, 0);
  const actions = db.prepare(`
    SELECT action FROM audit_log
    WHERE entity_type = 'team_meeting' AND entity_id = ? ORDER BY id
  `).all(created.payload.groupId).map((row) => row.action);
  assert.deepEqual(actions, ["team-meeting.create", "team-meeting.update", "team-meeting.delete"]);
});

test("v0.92.10: UI kennzeichnet Teamsitzung und ordnet Kontakt sowie Darkmode kompakt an", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.match(html, /id="sidebarVersion"[\s\S]*class="sidebar-developer-text"/);
  assert.match(html, /<span class="sidebar-developer-text">Developer-Kontakt · christian\.seiwald\.at@gmail\.com<\/span>/);
  assert.doesNotMatch(html, /sidebar-developer-text[^>]+href=/);
  assert.doesNotMatch(html, /class="sidebar-developer-contact"/);
  assert.match(html, /id="sidebarSessionInfo"[\s\S]*id="sidebarDarkmodeToggle"[\s\S]*role="switch"/);
  assert.match(html, /id="optionTeamWide"[\s\S]*gesamtes Team/);
  assert.match(appSource, /teamMeetingBands[\s\S]*class="team-meeting-band"/);
  assert.match(appSource, /#optionStartTime"\)\.value = "18:00"[\s\S]*#optionEndTime"\)\.value = "20:00"/);
  assert.match(css, /\.team-meeting-band[\s\S]*border:2px solid #68448f/);
  assert.match(css, /\.sidebar-session[\s\S]*grid-template-columns:minmax\(0,1fr\) auto/);
});

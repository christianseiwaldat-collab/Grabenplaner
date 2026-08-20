"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

function occurrenceCount(value, fragment) {
  return value.split(fragment).length - 1;
}

test("Block 2 UI: Fremdansicht besitzt eine eigene, eindeutig adressierbare Nur-Lesen-Oberfläche", () => {
  for (const id of [
    "crossLocationScheduleButton",
    "crossLocationSchedulePanel",
    "crossLocationScheduleLocation",
    "crossLocationScheduleWeeks",
    "crossLocationScheduleStatus",
    "crossLocationScheduleGrid",
  ]) assert.equal(occurrenceCount(html, `id="${id}"`), 1, id);
  assert.match(html, /Nur-Lesen-Ansicht/);
  assert.match(html, /Wochenstunden, Zeitkonten, Regelprüfungen, Warnungen und Abwesenheitsgründe bleiben ausgeblendet/);
  assert.match(html, /id="crossLocationScheduleMode">Rein lesend</);
});

test("Block 2 UI: Sichtbarkeit und Laden sind an das neue persönliche Leserecht gebunden", () => {
  assert.match(app, /user\?\.isEmployee === true/);
  assert.match(app, /user\.permissions\?\.includes\("schedule:cross_location:read"\) === true/);
  assert.match(app, /api\(`\/api\/portal\/v1\/cross-location-schedules/);
  assert.match(app, /state\.crossLocationScheduleOpen/);
  assert.match(app, /data-cross-location-week/);
});

test("Block 2 UI: Fremdplan rendert keine Bearbeitungsziele oder vertraulichen Planungsdetails", () => {
  const start = app.indexOf("function crossLocationScheduleCell");
  const end = app.indexOf("function renderCrossLocationSchedule()", start);
  assert.ok(start >= 0 && end > start);
  const renderer = app.slice(start, end);
  assert.doesNotMatch(renderer, /data-shift-id|data-option|onclick|weeklyHours|workRule|timeBalance|contractedHours/);
  assert.match(renderer, /Keine Einteilung/);
  assert.match(renderer, /Nicht verfügbar/);
  assert.match(css, /#planningView\.cross-location-mode > \.work-rule-assessment/);
  assert.match(css, /#planningView\.cross-location-mode > \.hours-panel/);
  assert.match(css, /#planningView\.cross-location-mode > \.schedule-panel/);
});

test("Block 2 UI: Wochenwahl bleibt sprachlich auf aktuelle und nächste Woche begrenzt", () => {
  assert.match(app, /index === 0 \? "Aktuelle Woche" : "Nächste Woche"/);
  assert.match(app, /keine Bearbeitung und keine Arbeitsregelprüfung/);
  assert.match(css, /grid-template-columns:minmax\(180px,1\.15fr\) repeat\(7,minmax\(120px,1fr\)\)/);
  assert.match(css, /@media \(max-width:560px\)/);
});

test("Block 4 UI: Planklick öffnet den gebundenen Anfragedialog mit Wunsch-Teammitglied", () => {
  for (const id of [
    "staffAssignmentRequestDialog",
    "staffAssignmentRequestForm",
    "staffAssignmentRequestSourceLocationId",
    "staffAssignmentRequestDestinationLocationId",
    "staffAssignmentRequestDepartment",
    "staffAssignmentRequestPreferredEmployee",
    "staffAssignmentRequestDateRangeButton",
    "staffAssignmentRequestReason",
  ]) assert.equal(occurrenceCount(html, `id="${id}"`), 1, id);
  assert.match(app, /data-cross-location-request-date/);
  assert.match(app, /data-cross-location-request-employee/);
  assert.match(app, /openStaffAssignmentRequestDialog/);
  assert.match(app, /teamMember\.requestEligible === true/);
  assert.match(app, /permissions\?\.includes\("staff_assignment_requests:create"\) === true/);
  assert.match(html, /Ein gewünschtes Teammitglied ist noch keine Zusage/);
});

test("Block 4 UI: alle drei Zeitarten verwenden den gemeinsamen Zeitraumkalender", () => {
  for (const value of ["hourly", "full_day", "multi_day"]) {
    assert.match(html, new RegExp(`name="staffAssignmentRequestTimeKind" value="${value}"`));
  }
  for (const id of [
    "staffAssignmentRequestDateRangeDialog",
    "staffAssignmentRequestDateRangeGrid",
    "staffAssignmentRequestDateRangeStartText",
    "staffAssignmentRequestDateRangeEndText",
  ]) assert.equal(occurrenceCount(html, `id="${id}"`), 1, id);
  assert.match(app, /GrabenplanerDateRangeCalendar\?\.createDateRangeCalendar/);
  assert.match(app, /maxEndDays: timeKind === "multi_day" \? 13 : 0/);
  assert.match(app, /function staffAssignmentRequestCalendarBounds/);
  assert.match(app, /payload\?\.weeks\?\.at\(-1\)\?\.weekEnd/);
  assert.match(html, /auch KW-übergreifend/);
});

test("Block 4 UI: Einreichung überträgt keinen frei wählbaren Zielfilialwert", () => {
  const start = app.indexOf("async function submitStaffAssignmentRequestForm");
  const end = app.indexOf("function crossLocationScheduleCell", start);
  assert.ok(start >= 0 && end > start);
  const submitter = app.slice(start, end);
  assert.match(submitter, /\/api\/portal\/v1\/staff-assignment-requests/);
  assert.match(submitter, /destinationDepartmentId/);
  assert.doesNotMatch(submitter, /destinationLocationId:/);
  assert.match(css, /staff-assignment-request-time-kinds/);
  assert.match(css, /staff-assignment-request-context.*grid-template-columns:1fr 1fr/);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*staff-assignment-request-context/);
});

test("Block 6 UI: Prüfansicht erklärt die verbindliche Einsatzbindung", () => {
  for (const id of [
    "staffAssignmentRequestReviewButton",
    "staffAssignmentRequestReviewDialog",
    "staffAssignmentRequestReviewStatus",
    "staffAssignmentRequestReviewRefresh",
    "staffAssignmentRequestReviewList",
  ]) assert.equal(occurrenceCount(html, `id="${id}"`), 1, id);
  assert.match(app, /permissions\s*\?\s*\.includes\("staff_assignment_requests:review"\) === true/);
  assert.match(app, /api\("\/api\/portal\/v1\/staff-assignment-requests"\)/);
  assert.match(app, /method: "PUT"/);
  assert.match(app, /expectedRevision: Number\(card\.dataset\.staffAssignmentReviewRevision\)/);
  assert.match(app, /Bitte das tatsächlich bestätigte Teammitglied auswählen/);
  assert.match(app, /Bitte die Ablehnung nachvollziehbar begründen/);
  assert.match(app, /Der Wunsch ist nur vorausgewählt/);
  assert.match(html, /legt den bestätigten temporären Filialeinsatz verbindlich an/);
  assert.doesNotMatch(html, /Dienstplan-Verfügbarkeit folgt im nächsten Umsetzungsschritt/);
  assert.match(app, /Der temporäre Filialeinsatz ist verbindlich einplanbar/);
});

test("Block 5 UI: Prüfkarten bleiben auf kleinen Bildschirmen bedienbar", () => {
  assert.match(css, /staff-assignment-review-dialog/);
  assert.match(css, /staff-assignment-review-decision-grid.*repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*staff-assignment-review-decision-grid \{ grid-template-columns:1fr; \}/);
  assert.match(css, /staff-assignment-review-actions[\s\S]*grid-template-columns:1fr/);
});

test("Block 7 UI: eigener Dienstplan-Reiter bündelt Rechte, E-Mail und Richtlinien", () => {
  for (const id of [
    "settingsScheduleTab",
    "scheduleSettings",
    "crossLocationScheduleSettingsCard",
    "crossLocationScheduleEnabled",
    "crossLocationScheduleHorizonWeeks",
    "staffAssignmentManagerCreateEnabled",
    "staffAssignmentDepartmentManagerCreateEnabled",
    "staffAssignmentDepartmentManagerReviewEnabled",
    "staffAssignmentNotificationSettingsCard",
    "staffAssignmentEmailSubmittedEnabled",
    "staffAssignmentEmailDecisionEnabled",
    "staffAssignmentChangeSettingsCard",
    "staffAssignmentChangePolicy",
    "staffAssignmentCancellationPolicy",
  ]) assert.equal(occurrenceCount(html, `id="${id}"`), 1, id);
  assert.match(html, /data-settings-tab="schedule">Dienstplan</);
  assert.match(app, /permissions\.includes\("schedule:cross_location:settings:write"\)/);
  assert.match(app, /\/api\/portal\/v1\/cross-location-schedule-settings/);
  assert.match(app, /crossLocationSchedule:\s*\{/);
});

test("Block 7 UI: Bearbeitungssperre wurde ohne ID- oder Wertduplikat verschoben", () => {
  for (const id of [
    "allowPastWeekEditing",
    "currentWeekAutoLock",
    "currentWeekLockSettings",
    "currentWeekLockMode",
    "currentWeekLockDay",
    "currentWeekLockTime",
  ]) assert.equal(occurrenceCount(html, `id="${id}"`), 1, id);
  const generalStart = html.indexOf('id="generalSettings"');
  const scheduleStart = html.indexOf('id="scheduleSettings"');
  const lockStart = html.indexOf('id="scheduleLockSettingsCard"');
  const vacationStart = html.indexOf('id="vacationSettings"');
  assert.ok(generalStart >= 0 && scheduleStart > generalStart);
  assert.ok(lockStart > scheduleStart && lockStart < vacationStart);
  assert.match(app, /elements\.scheduleSettings\?\.classList\.toggle\("active", activeTab === "schedule"\)/);
  assert.match(app, /schedule:\s*settingsAccess \|\| scheduleSettingsAccess/);
  assert.match(app, /scheduleLockSettingsCard\?\.classList\.toggle\("hidden", !settingsAccess\)/);
});

test("Block 7 UI: Laufzeit-Gates berücksichtigen Master-, FL- und AL-Schalter", () => {
  assert.match(app, /cross_location_schedule_enabled !== "0"/);
  assert.match(app, /staff_assignment_requests_manager_create_enabled !== "0"/);
  assert.match(app, /staff_assignment_requests_department_manager_create_enabled === "1"/);
  assert.match(app, /staff_assignment_requests_department_manager_review_enabled === "1"/);
  assert.match(app, /crossLocationScheduleSettingsCard\?\.classList\.toggle\("hidden", !scheduleSettingsAccess\)/);
  assert.match(app, /staffAssignmentNotificationSettingsCard\?\.classList\.toggle\("hidden", !scheduleSettingsAccess\)/);
  assert.match(app, /staffAssignmentChangeSettingsCard\?\.classList\.toggle\("hidden", !scheduleSettingsAccess\)/);
});

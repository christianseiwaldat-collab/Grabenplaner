"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { FUNCTION_SEARCH_CATALOG } = require("../public/function-search-catalog");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const schema = fs.readFileSync(
  path.join(root, "lib", "persistence", "sqlite", "operations", "application-schema.js"),
  "utf8",
);

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Ausschnitt fehlt: ${start}`);
  return source.slice(startIndex, endIndex);
}

test("v0.92.20 manuelle Dienstplansperre ist deutlich, ausgeschrieben und zugänglich bedienbar", () => {
  const control = between(
    html,
    '<section class="manual-schedule-lock-control"',
    '<section class="cross-location-schedule-panel',
  );
  assert.match(control, /id="manualScheduleLockToggle"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(control, /class="manual-schedule-lock-device"/);
  assert.match(control, /id="manualScheduleLockStatus">Dienstplan manuell entsperrt</);
  assert.match(control, /id="manualScheduleLockAction"[^>]*>Jetzt sperren</);
  assert.match(styles, /\.manual-schedule-lock-device \{[^}]*height:52px;[^}]*border:3px solid currentColor;/);
  assert.match(styles, /\.manual-schedule-lock-control\[data-locked="true"\] \{[^}]*border-color:#cf4b38;[^}]*background:linear-gradient/);
  assert.match(styles, /\.manual-schedule-lock-control \{[^}]*border:2px solid #70a990;/);
  assert.match(styles, /\.manual-schedule-lock-control\[data-locked="true"\] \.manual-schedule-lock-switch span \{[^}]*translateX\(18px\)/);
});

test("v0.92.20 manuelle und automatische Sperre bleiben in Status, Raster und Bedienlogik getrennt", () => {
  const lockFunctions = between(app, "function isAutomaticallyWeekLocked()", "function globalBlockForDate");
  assert.match(lockFunctions, /function isManuallyWeekLocked\(\)/);
  assert.match(lockFunctions, /return isAutomaticallyWeekLocked\(\) \|\| isManuallyWeekLocked\(\)/);
  assert.match(lockFunctions, /showToast\(scheduleEditingLockExplanation\(\), true\)/);
  assert.match(lockFunctions, /\/api\/schedule\/manual-lock/);
  assert.match(lockFunctions, /expectedRevision: Number\(lock\.revision \|\| 0\)/);
  assert.match(lockFunctions, /Dienstplan manuell gesperrt/);
  assert.match(lockFunctions, /Dienstplan manuell entsperrt/);

  const header = between(app, "function renderHeader()", "function canReadCrossLocationSchedule");
  assert.match(header, /elements\.weekLockNotice\.classList\.toggle\("hidden", !automaticallyLocked\)/);
  assert.match(header, /renderManualScheduleLockControl\(\)/);
  assert.match(header, /button\.disabled = automaticallyLocked/);

  const timeline = between(app, "function renderTimeline()", "function renderRemarks()");
  assert.match(timeline, /const locked = isAutomaticallyWeekLocked\(\)/);
  assert.doesNotMatch(timeline, /const locked = isWeekLocked\(\)/);
  assert.match(styles, /\.toast \{[^}]*position: fixed;[^}]*right: 23px;[^}]*bottom: 23px;/);
});

test("v0.92.20 Sperre ist persistent, revisionsgeschützt, auditiert und serverseitig erzwungen", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS schedule_manual_locks/);
  assert.match(schema, /PRIMARY KEY \(location_id, week_start\)/);
  assert.match(server, /app\.put\("\/api\/schedule\/manual-lock"/);
  assert.match(server, /SCHEDULE_MANUAL_LOCK_CONFLICT/);
  assert.match(server, /SCHEDULE_MANUAL_LOCKED/);
  assert.match(server, /schedule\.manual-lock\.lock/);
  assert.match(server, /schedule\.manual-lock\.unlock/);
  assert.match(server, /assertScheduleManualLockOpen\(weekStart, locationId, actor\)/);
  assert.match(server, /manualScheduleLock,/);

  const searchEntry = FUNCTION_SEARCH_CATALOG.find((entry) => entry.id === "planning.manual-lock");
  assert.ok(searchEntry);
  assert.deepEqual(searchEntry.path, ["Filialverwaltung", "Dienstplanung", "Manuelle Dienstplansperre"]);
  assert.deepEqual(searchEntry.access.gateIds, ["planningNavButton", "manualScheduleLockControl"]);
  assert.equal(searchEntry.target.focusId, "manualScheduleLockToggle");
});

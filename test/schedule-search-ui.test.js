const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

function occurrenceCount(value, needle) {
  return value.split(needle).length - 1;
}

test("Block 6: Filialverwaltungsdashboard enthält die ausklappbare Dienstsuche mit Zeitraumkalender", () => {
  const panelId = html.indexOf('id="scheduleSearchPanel"');
  const start = html.lastIndexOf("<details", panelId);
  const end = html.indexOf('id="scheduleSearchDateRangeDialog"');
  assert.ok(start > html.indexOf('id="filialAdministrationView"'));
  assert.ok(end > start);
  const section = html.slice(start, end);
  assert.match(section, /<details class="schedule-search-panel"/);
  assert.match(section, /class="schedule-search-chevron"[^>]*>›</);
  assert.match(section, /id="scheduleSearchDateFrom" type="hidden"/);
  assert.match(section, /id="scheduleSearchDateTo" type="hidden"/);
  assert.match(section, /id="scheduleSearchDateRangeButton"[^>]+aria-controls="scheduleSearchDateRangeDialog"/);
  for (const id of [
    "scheduleSearchEmployee", "scheduleSearchEmployeeNumber", "scheduleSearchLocation",
    "scheduleSearchDepartment", "scheduleSearchHomeLocation", "scheduleSearchAssignment",
    "scheduleSearchArea", "scheduleSearchTableBody",
  ]) assert.equal(occurrenceCount(html, `id="${id}"`), 1, id);
  assert.match(app, /initializeScheduleSearchDateRangeCalendar/);
  assert.match(app, /maxEndDays:\s*730/);
  assert.match(app, /allowOpenEnd:\s*false/);
});

test("Block 6: alle fachlichen Ergebnisspalten sind serverseitig sortierbar", () => {
  const expected = [
    "date", "employee", "personnelNumber", "homeLocation", "location",
    "department", "startTime", "duration", "area", "assignment",
  ];
  for (const key of expected) {
    assert.match(html, new RegExp(`data-schedule-search-sort="${key}"`), key);
    assert.match(server, new RegExp(`"${key}"`), key);
  }
  assert.match(app, /scheduleSearchParameters\(submitted\)/);
  assert.match(app, /\/api\/schedule\/search\?\$\{scheduleSearchParameters\(submitted\)\}/);
  assert.match(app, /button\.closest\("th"\)\?\.setAttribute\("aria-sort"/);
});

test("Block 6: Rechteprüfung, genaue Dienstplannavigation und mobile Überlaufbegrenzung bleiben wirksam", () => {
  assert.match(app, /elements\.scheduleSearchPanel\.classList\.toggle\("hidden", !allowed\)/);
  assert.match(app, /const allowed = canReadStartDashboardSchedule\(\)/);
  assert.match(app, /state\.locationId = String\(result\.locationId/);
  assert.match(app, /state\.departmentId = result\.departmentId/);
  assert.match(app, /state\.weekStart = String\(result\.weekStart/);
  assert.match(app, /document\.querySelectorAll\("\[data-shift-id\]"\)/);
  assert.match(styles, /\.schedule-search-table-scroll \{[^}]*max-width:100%;[^}]*overflow:auto;/);
  assert.match(styles, /@media \(max-width:700px\)[\s\S]*?\.schedule-search-form \{ grid-template-columns:1fr; \}/);
  assert.match(html, /tabindex="0" role="region" aria-label="Suchergebnisse/);
});

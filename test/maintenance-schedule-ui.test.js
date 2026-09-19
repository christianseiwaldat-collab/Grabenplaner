"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("System & Backup exposes the protected editable maintenance matrix", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");
  const server = read("server.js");
  const styles = read("public/styles.css");

  assert.match(html, /id="maintenanceScheduleCard"[\s\S]*Wartungs- &amp; Backupzeiten/);
  for (const heading of ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So", "Zeitpunkt", "Aktiv", "Nächster Lauf"]) {
    assert.match(html, new RegExp(`>${heading}<`));
  }
  assert.match(app, /maintenanceScheduleValidationMessage/);
  assert.match(app, /mindestens ein Wochentag ausgewählt/);
  assert.match(app, /api\("\/api\/portal\/v1\/maintenance-schedules"/);
  assert.match(app, /method: "PUT"/);
  assert.match(server, /app\.get\("\/api\/portal\/v1\/maintenance-schedules"/);
  assert.match(server, /app\.put\("\/api\/portal\/v1\/maintenance-schedules"/);
  assert.match(server, /requirePortalAdminOrLocal\(request, "backup:write"\)/);
  assert.match(server, /if \(write\) assertPortalCsrf\(request\)/);
  assert.match(styles, /\.maintenance-schedule-table-wrap[^}]*overflow:auto/);
});

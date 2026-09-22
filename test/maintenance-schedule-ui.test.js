"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("System & Backup exposes the protected editable maintenance matrix", () => {
  const html = read("public/index.html");
  const app = read("public/app.js");
  const server = read("server.js");
  const styles = read("public/styles.css");

  assert.match(html, /id="maintenanceScheduleCard"[\s\S]*Wartungs- &amp; Backupzeiten/);
  assert.match(html, /id="maintenanceScheduleRows"/);
  assert.match(app, /maintenance-schedule-days/);
  assert.match(app, /Täglich um 03:00/);
  assert.match(app, /maintenanceScheduleValidationMessage/);
  assert.match(app, /mindestens ein Wochentag ausgewählt/);
  assert.match(app, /api\("\/api\/portal\/v1\/maintenance-schedules"/);
  assert.match(app, /method: "PUT"/);
  assert.match(server, /app\.get\("\/api\/portal\/v1\/maintenance-schedules"/);
  assert.match(server, /app\.put\("\/api\/portal\/v1\/maintenance-schedules"/);
  assert.match(server, /requirePortalAdminOrLocal\(request, "backup:write"\)/);
  assert.match(server, /if \(write\) assertPortalCsrf\(request\)/);
  assert.match(styles, /\.maintenance-schedule-options[^}]*flex-wrap:wrap/);
});

test("the monitor can switch between nightly weekdays and minute intervals in the matrix", () => {
  const app = read("public/app.js");
  const meta = app.slice(app.indexOf("const maintenanceScheduleTaskMeta ="), app.indexOf("function canManageMaintenanceSchedules"));
  const functions = ["maintenanceScheduleCadenceLabel", "maintenanceScheduleCadenceControl", "maintenanceScheduleValidationMessage", "updateMaintenanceScheduleDraft"]
    .map(name => app.match(new RegExp(`function ${name}\\([^]*?^\\}`, "m"))?.[0]);
  assert.ok(functions.every(Boolean));
  const task = { id: "server-monitor", installed: true, cadence: "weekly", weekdays: ["monday"], time: "03:00", intervalMinutes: null, monthDay: null };
  const context = { state: { maintenanceSchedules: { tasks: [task] } }, escapeHtml: String, renderMaintenanceSchedules() {} };
  vm.createContext(context);
  vm.runInContext(meta + functions.join("\n"), context);
  const select = value => context.updateMaintenanceScheduleDraft({ target: {
    value, closest: () => ({ dataset: { maintenanceTask: "server-monitor" } }), matches: selector => selector === "[data-maintenance-cadence]",
  } });
  assert.match(context.maintenanceScheduleCadenceControl(task, false), /data-maintenance-cadence/);
  select("interval");
  assert.equal(task.intervalMinutes, 5);
  assert.equal(task.time, null);
  assert.equal(task.weekdays.length, 0);
  assert.equal(task.monthDay, null);
  assert.match(context.maintenanceScheduleCadenceControl(task, false), /data-maintenance-interval/);
  select("weekly");
  assert.equal(task.time, "03:00");
  assert.equal(task.weekdays.join(","), "monday");
  assert.equal(task.intervalMinutes, null);
  assert.equal(context.maintenanceScheduleValidationMessage([task]), "");
  assert.doesNotMatch(context.maintenanceScheduleCadenceControl(task, false), /data-maintenance-interval/);
});

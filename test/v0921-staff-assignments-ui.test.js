"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

test("Filialeinsatz-UI verarbeitet camelCase-Antworten der Staff-Assignments-API", () => {
  assert.match(script, /const dateFrom = lending\.date_from \|\| lending\.dateFrom;/);
  assert.match(script, /const dateTo = lending\.date_to \|\| lending\.dateTo;/);
  assert.match(script, /lending\?\.employee_nickname \|\| lending\?\.employeeNickname/);
  assert.match(script, /lending\?\.employee_number \|\| lending\?\.employeeNumber/);
  assert.match(script, /\/api\/portal\/v1\/staff-assignments/);
});

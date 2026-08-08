"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("v0.91 UI: Filialbestellung trennt Erfassung und Filialleitungs-Konfiguration", () => {
  const html = read("public/portal.html");
  const script = read("public/portal.js");
  const admin = read("public/index.html");
  const adminScript = read("public/app.js");

  assert.match(html, /id="branchOrdersTab"/);
  assert.match(html, /id="branchOrdersView"/);
  assert.match(html, /id="branchOrderEmployee"/);
  assert.match(html, /id="branchOrderSettingsCard"/);
  assert.match(html, /id="branchOrderHistoryList"/);
  assert.match(script, /function branchOrderCapabilityEnabled/);
  assert.match(script, /\/api\/portal\/v1\/branch-orders\/catalog/);
  assert.match(script, /catalog\.senderEmail/);
  assert.match(script, /\/api\/portal\/v1\/branch-orders\/settings/);
  assert.match(script, /\/api\/portal\/v1\/branch-orders\/history/);
  assert.match(admin, /id="organizationAccountBranchOrders"/);
  assert.match(adminScript, /"branch_orders:submit"/);
});

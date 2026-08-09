const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Block 4 UI: Filial- und Terminalkonten werden getrennt von Beschäftigten verwaltet", () => {
  const html = read("public/index.html");
  const script = read("public/app.js");

  assert.match(html, /id="organizationAccountsCard"/);
  assert.match(html, /ohne Mitarbeiterdatensatz oder Personalnummer/);
  assert.match(html, /id="organizationAccountLoginName"/);
  assert.match(html, /id="organizationAccountType"/);
  assert.match(html, /id="organizationAccountLocation"/);
  assert.match(html, /id="organizationAccountLoanOverview"/);
  assert.match(html, /id="organizationAccountScheduleView"/);
  assert.match(html, /id="organizationAccountBranchOrders"/);

  assert.match(script, /api\("\/api\/portal\/v1\/organization-accounts"\)/);
  assert.match(script, /"loans:overview:read"/);
  assert.match(script, /"schedule:location:view"/);
  assert.match(script, /"branch_orders:submit"/);
  assert.match(script, /loadOrganizationAccounts\(\)/);
});

test("Block 4 UI: Organisationskonten erhalten nur die reduzierten Portalansichten", () => {
  const html = read("public/portal.html");
  const script = read("public/portal.js");

  assert.match(html, /Personalnummer oder Zugangskennung/);
  assert.match(script, /function isOrganizationAccount/);
  assert.match(script, /session\.user\.loginName/);
  assert.match(script, /\/api\/portal\/v1\/location-dashboard\/schedule/);
  assert.match(script, /\/api\/portal\/v1\/loans\/open-overview/);
  assert.match(script, /!isOrganizationAccount\(\)\) requests\.push\(loadPortalHome\(\), loadNotifications\(\)\)/);
  assert.match(script, /isOrganizationAccount\(session\.user\) \|\| !session\.user\.permissions\.includes\("schedule:read"\)/);
});

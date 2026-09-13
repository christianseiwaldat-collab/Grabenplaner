"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
function harness() {
  const elements = Object.fromEntries([...html.matchAll(/id="(organizationAccount\w+)"/g)].map(([, id]) => [id,
    { value: "", checked: false, disabled: false, textContent: "", classList: { toggle() {}, add() {}, remove() {} }, focus() {}, reset() {} }]));
  const sent = [];
  const context = { elements, state: { locations: [{ id: "93" }], organizationAccounts: [] }, organizationAccountLocationOptions: () => "",
    resetAdminCredentialVisibility() {}, showToast() {}, renderOrganizationAccounts() {},
    api: async (route, options) => { sent.push({ route, options, body: JSON.parse(options.body) }); return { accounts: [] }; } };
  vm.createContext(context);
  vm.runInContext(app.slice(app.indexOf("function syncOrganizationAccountPermissionControls()"), app.indexOf("function renderOrganizationAccounts()"))
    + app.slice(app.indexOf("function editOrganizationAccount(accountId)"), app.indexOf("async function unlockOrganizationAccount(accountId)")), context);
  return { context, elements, sent };
}
test("Neue Filialkonten haben beide Suchschalter aus; Terminalwechsel entfernt die optionalen Haken", () => {
  const f = harness(); f.context.resetOrganizationAccountForm();
  assert.equal(f.elements.organizationAccountArticles.checked, false); assert.equal(f.elements.organizationAccountReceipts.checked, false);
  f.elements.organizationAccountArticles.checked = f.elements.organizationAccountReceipts.checked = true;
  f.elements.organizationAccountType.value = "terminal"; f.context.syncOrganizationAccountPermissionControls();
  assert.equal(f.elements.organizationAccountArticles.checked, false); assert.equal(f.elements.organizationAccountReceipts.checked, false);
  assert.equal(f.elements.organizationAccountArticles.disabled, true); assert.equal(f.elements.organizationAccountReceipts.disabled, true);
  assert.equal(f.elements.organizationAccountLearningDashboard.checked, false);
  assert.equal(f.elements.organizationAccountLearningDashboard.disabled, true);
  assert.equal(f.elements.organizationAccountLoanOverview.disabled, false);
  assert.equal(f.elements.organizationAccountScheduleView.disabled, false);
  for (const id of ["organizationAccountArticles", "organizationAccountReceipts"]) assert.ok(app.includes('"' + id + '"'), "DOM-Element ist registriert");
});
test("Bearbeiten und Speichern erhält jede Kombination der beiden Suchschalter unabhängig", async () => {
  for (const permissions of [[], ["branch_articles:read"], ["branch_receipts:read"], ["branch_articles:read", "branch_receipts:read"]]) {
    const f = harness(); f.context.state.organizationAccounts = [{ id: "account-a", loginName: "demo", displayName: "Demo", accountType: "branch", active: true,
      scopes: [{ locationId: "93" }], permissions }];
    f.context.editOrganizationAccount("account-a");
    assert.equal(f.elements.organizationAccountArticles.checked, permissions.includes("branch_articles:read"));
    assert.equal(f.elements.organizationAccountReceipts.checked, permissions.includes("branch_receipts:read"));
    await f.context.saveOrganizationAccount({ preventDefault() {} });
    assert.equal(f.sent[0].options.method, "PUT");
    assert.deepEqual(f.sent[0].body.permissions.filter(p => p.startsWith("branch_articles:") || p.startsWith("branch_receipts:")), permissions);
  }
});

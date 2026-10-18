"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { root, read, section, functionSource } = require("../test-support/learning-workspace-ui");
const app = read("app.js");
function constant(name) {
  const start = app.indexOf(`const ${name} =`), end = app.indexOf("\n});", start);
  assert.ok(start >= 0 && end > start, name);
  return app.slice(start, end + 4);
}
const functions = ["personnelTaskWorkspaceRecords", "filterPersonnelTaskWorkspaceRecords", "personnelTaskDueDateLabel",
  "closePersonnelTaskWorkspaceDetail", "renderPersonnelTaskWorkspaceDetail", "bindPersonnelTaskWorkspace",
  "renderPersonnelWorkflowTasksImpl", "renderPersonnelLifecycleOnboardingTasksMarkup", "renderPersonnelLifecycleOffboardingTasksMarkup",
  "personnelLifecycleOnboardingTaskKey", "personnelLifecycleOffboardingTaskKey", "personnelWorkflowTimestamp",
  "captureGpContext", "gpContextCurrent", "submitPersonnelLifecycleOnboardingTaskCompletion", "submitPersonnelLifecycleOffboardingTaskCompletion"];
const source = [constant("PERSONNEL_LIFECYCLE_OFFBOARDING_TASK_FIELDS"), constant("PERSONNEL_LIFECYCLE_OFFBOARDING_TASK_FIELD_LABELS"),
  constant("PERSONNEL_LIFECYCLE_AUTOMATION_DUE_STATE_LABELS"), ...functions.map(name => functionSource(name))].join("\n");
const themeSource = [app.match(/const UI_APPEARANCE_VIEWS = Object\.freeze\(\[[\s\S]*?\]\);/)[0],
  ...["pageViewElement", "applyActivePageAppearance", "applyPageTheme", "applyGlobalTheme"].map(name => functionSource(name))].join("\n");
const screenshots = path.resolve(process.env.GP_WINDOW_SCREENSHOT_DIR || path.join(root, "..", "output", "gp-admin-pages-refresh-20261016"));
const options = { skip: process.env.GP_ADMIN_PAGES_BROWSER_TEST !== "1", timeout: 40000 };
function assertTextContrast(foreground, background) {
  const luminance = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
  const a = luminance(foreground), b = luminance(background);
  assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, "Task text contrasts with its real dark surface");
}
async function launch() {
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  return chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
}
async function prepare(page) {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(5000);
  await page.route("**/*", route => route.abort());
  await page.route("http://127.0.0.1:34129/personnel-tasks", route => route.fulfill({ contentType: "text/html", body:
    '<!doctype html><html lang="de"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><main class="synthetic-tasks main-content"><section id="personnelAdministrationView" class="view active">' + section("personnelTasksSection") + '</section></main></body></html>' }));
  await page.goto("http://127.0.0.1:34129/personnel-tasks");
  for (const file of ["styles.css", "personnel-tasks-workspace.css", "gp-window.css"]) await page.addStyleTag({ path: path.join(root, "public", file) });
  await page.addStyleTag({ content: '.synthetic-tasks{max-width:1320px;margin:30px auto;padding:0 24px}#personnelTasksSection{display:block!important}@media(max-width:600px){.synthetic-tasks{margin:18px auto;padding:0 12px}}' });
  for (const file of ["gp-window-preferences.js", "gp-window.js"]) await page.addScriptTag({ path: path.join(root, "public", file) });
  await page.evaluate(source => {
    const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    window.escapeHtml = window.escapeHtmlAttribute = esc;
    window.elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
    window.allowed = true; window.previewAllowed = true; window.actor = "BEISPIEL-PERSONAL";
    window.canReadPersonnelTasks = window.canReadPersonnelWorkflowInstances = window.canReadLifecycleOnboardingTasks = window.canReadLifecycleOffboardingTasks = () => allowed;
    window.canReadLifecycleAutomationPreview = () => allowed && previewAllowed;
    window.startDashboardWorkspaceActorKey = () => actor;
    window.state = {
      portalSession: { user: { employeeNumber: actor } },
      personnelWorkflowInstancesLoaded: true, personnelLifecycleOnboardingTasksLoaded: true, personnelLifecycleOffboardingTasksLoaded: true,
      personnelWorkflowTasks: [{ title: "Einarbeitungsplan abstimmen", workflowTitle: "Start im Verkauf", status: "active" }],
      personnelLifecycleOnboardingTasks: [{ runId: "run-synthetic-on", stepId: "step-synthetic-on", caseId: "not-a-dom-field", workflowCode: "technical-code",
        title: "Sicherheitsunterweisung durchführen", workflowTitle: "Einarbeitung im Team", subject: { displayName: "Alexandra Beispiel", employeeNumber: "BEISPIEL-01" },
        scope: { type: "location", locationId: "18" }, position: 2, activatedAt: "2026-10-15T08:00:00Z" }],
      personnelLifecycleOffboardingTasks: [
        { runId: "run-synthetic-out", stepId: "return", projection: "asset_task", title: "Arbeitsmittel zurücknehmen", assetIdentifier: "Notebook · Beispielgerät", dueAt: "2026-10-16", status: "active" },
        { runId: "run-synthetic-out", stepId: "access", projection: "it_security_task", title: "Zugänge zum Abschluss prüfen", targetSystem: "Beispielsystem", status: "pending" },
      ],
      personnelLifecycleOnboardingTaskCapabilities: { canRead: true, canComplete: true },
      personnelLifecycleOffboardingTaskCapabilities: { canRead: true, canComplete: true },
      personnelLifecycleOnboardingTaskOperations: {}, personnelLifecycleOffboardingTaskOperations: {},
      personnelLifecycleOnboardingTaskPending: "", personnelLifecycleOffboardingTaskPending: "",
      personnelLifecycleAutomationPreviewLoaded: true,
      personnelLifecycleAutomationPreview: { items: [{ source: "offboarding", runId: "run-synthetic-out", stepId: "return", dueAt: "2026-10-16", dueState: "due_today" }] },
    };
    window.manager = GpWindow.installDocument(document, { actorKey: () => actor, canUse: () => allowed,
      readPreferences: async () => ({ version: 1, windows: {} }), writePreferences: async () => {} });
    window.calls = []; window.toasts = []; window.showToast = message => toasts.push(message);
    window.api = async (url, request) => { calls.push({ url, request }); return {}; };
    window.loadPersonnelLifecycleOnboardingTasks = async () => { state.personnelLifecycleOnboardingTasks = []; renderPersonnelWorkflowTasksImpl(); };
    window.loadPersonnelLifecycleOffboardingTasks = async () => { state.personnelLifecycleOffboardingTasks = state.personnelLifecycleOffboardingTasks.filter(task => task.status !== "active"); renderPersonnelWorkflowTasksImpl(); };
    window.renderPersonnelWorkflowInstanceOverview = () => renderPersonnelWorkflowTasksImpl();
    (0, eval)(source);
    renderPersonnelWorkflowTasksImpl();
  }, source);
  return errors;
}

for (const mobile of [false, true]) test(`personal tasks: ${mobile ? "mobile" : "desktop"} genuine dark theme and offboarding action`, options, async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
    const errors = await prepare(page);
    await page.evaluate(themeSource => {
      state.currentView = "personnelAdministration"; state.pageThemes = {};
      (0, eval)(themeSource); applyGlobalTheme("dark");
      state.personnelLifecycleAutomationPreview.items.push({ source: "onboarding", runId: "run-synthetic-on", stepId: "step-synthetic-on", dueAt: "2026-10-15", dueState: "overdue" });
      renderPersonnelWorkflowTasksImpl();
    }, themeSource);
    assert.equal(await page.locator("html").getAttribute("data-active-page-theme"), "dark");
    assert.equal(await page.locator("#personnelAdministrationView").getAttribute("data-page-theme"), "dark");
    const colors = await page.locator(".personnel-task-due").evaluateAll(nodes => nodes.map(node => ({
      className: node.className, foreground: getComputedStyle(node).color, background: getComputedStyle(node.closest(".personnel-task-workspace-card")).backgroundColor,
    })));
    assert.deepEqual(colors.map(row => row.foreground), ["rgb(255, 179, 164)", "rgb(242, 209, 120)"]);
    for (const row of colors) assertTextContrast(row.foreground, row.background);
    const labelColors = await page.locator(".personnel-tasks-filters .field > span").first().evaluate(node => ({ foreground: getComputedStyle(node).color, background: getComputedStyle(node.closest(".personnel-tasks-filters")).backgroundColor }));
    assertTextContrast(labelColors.foreground, labelColors.background);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    fs.mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, `personnel-tasks-dark-${mobile ? "mobile" : "desktop"}.png`), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Details: Arbeitsmittel zurücknehmen" }).click();
    const dialog = page.locator("#personnelTaskDetailDialog");
    assert.equal(await dialog.locator("[data-offboarding-task-confirm]").isChecked(), false);
    await dialog.locator("[data-offboarding-task-confirm]").check();
    await page.evaluate(() => { state.personnelLifecycleOffboardingTaskCapabilities.canComplete = false; renderPersonnelWorkflowTasksImpl(); });
    assert.equal(await dialog.locator("form").count(), 0);
    assert.equal(await page.evaluate(() => calls.length), 0);
    await page.evaluate(() => { state.personnelLifecycleOffboardingTaskCapabilities.canComplete = true; renderPersonnelWorkflowTasksImpl(); });
    assert.equal(await dialog.locator("[data-offboarding-task-confirm]").isChecked(), false);
    assert.equal(await dialog.locator(".gp-dialog-body").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    const buttonColors = await dialog.locator(".primary-button").evaluate(node => ({ foreground: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
    assertTextContrast(buttonColors.foreground, buttonColors.background);
    await page.screenshot({ path: path.join(screenshots, `personnel-task-detail-dark-${mobile ? "mobile" : "desktop"}.png`), animations: "disabled" });
    await dialog.locator("[data-offboarding-task-confirm]").check();
    await dialog.getByRole("button", { name: "Erledigung bestätigen" }).click();
    await page.waitForFunction(() => calls.length === 1 && !document.getElementById("personnelTaskDetailDialog").open);
    const call = await page.evaluate(() => calls[0]);
    assert.match(call.url, /offboarding\/tasks\/run-synthetic-out\/return\/completions$/);
    assert.equal(call.request.method, "POST");
    assert.equal(JSON.parse(call.request.body).action, "complete");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

for (const mobile of [false, true]) test(`personal tasks: ${mobile ? "mobile" : "desktop"} overview, filters and real GP detail window`, options, async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
    const errors = await prepare(page);
    assert.equal(await page.locator(".personnel-task-workspace-card").count(), 4);
    assert.match(await page.locator(".personnel-task-workspace-card").first().textContent(), /Arbeitsmittel zurücknehmen/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator("#personnelTasksSummary article").nth(2).locator("strong").textContent(), "1");
    fs.mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, `personnel-tasks-${mobile ? "mobile" : "desktop"}.png`), fullPage: true, animations: "disabled" });
    await page.getByRole("searchbox", { name: "Aufgabe suchen" }).fill("Alexandra");
    assert.equal(await page.locator(".personnel-task-workspace-card").count(), 1);
    await page.getByRole("button", { name: "Filter zurücksetzen" }).click();
    await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("pending");
    assert.equal(await page.locator(".personnel-task-workspace-card").count(), 1);
    await page.getByRole("button", { name: "Details: Zugänge zum Abschluss prüfen" }).click();
    const dialog = page.locator("#personnelTaskDetailDialog");
    assert.equal(await dialog.evaluate(node => node.open && !node.matches(":modal") && node.classList.contains("gp-window")), true);
    assert.equal(await dialog.locator("form").count(), 0);
    await dialog.locator("[data-gp-window-close]").click();
    await page.waitForFunction(() => !document.getElementById("personnelTaskDetailDialog").open);
    await page.getByRole("button", { name: "Filter zurücksetzen" }).click();
    await page.getByRole("button", { name: "Details: Sicherheitsunterweisung durchführen" }).click();
    await dialog.locator("[data-onboarding-task-confirm]").check();
    await dialog.locator("[data-gp-window-toggle]").click();
    await page.evaluate(() => document.querySelector("#personnelTaskDetailDialog form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(await page.evaluate(() => calls.length), 0);
    await dialog.locator("[data-gp-window-toggle]").click();
    assert.equal(await dialog.locator("[data-onboarding-task-confirm]").isChecked(), true);
    await page.evaluate(() => renderPersonnelWorkflowTasksImpl());
    assert.equal(await dialog.locator("[data-onboarding-task-confirm]").isChecked(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await dialog.locator(".gp-dialog-body").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await dialog.locator("[data-onboarding-task-confirm]").evaluate(node => node.getBoundingClientRect().width <= 20), true);
    await dialog.locator(".gp-dialog-body").evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: path.join(screenshots, `personnel-task-detail-${mobile ? "mobile" : "desktop"}.png`), animations: "disabled" });
    await dialog.getByRole("button", { name: "Erledigung bestätigen" }).click();
    await page.waitForFunction(() => calls.length === 1 && !document.getElementById("personnelTaskDetailDialog").open);
    const call = await page.evaluate(() => calls[0]);
    assert.match(call.url, /onboarding\/tasks\/run-synthetic-on\/step-synthetic-on\/complete$/);
    assert.equal(call.request.method, "POST");
    const body = JSON.parse(call.request.body);
    assert.equal(body.action, "complete"); assert.equal(body.evidenceReference, null);
    assert.match(body.operationId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("personal task details: rights, session, changed task, missing preview and errors fail closed", options, async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    const errors = await prepare(page), dialog = page.locator("#personnelTaskDetailDialog");
    await page.getByRole("button", { name: "Details: Sicherheitsunterweisung durchführen" }).click();
    await dialog.locator("[data-onboarding-task-confirm]").check();
    await page.evaluate(() => { state.personnelLifecycleOnboardingTasks[0].title = "Geänderte Unterweisung"; renderPersonnelWorkflowTasksImpl(); });
    assert.equal(await dialog.locator("[data-onboarding-task-confirm]").isChecked(), false);
    await dialog.getByRole("button", { name: "Erledigung bestätigen" }).click();
    assert.equal(await page.evaluate(() => calls.length), 0);
    await dialog.locator("[data-onboarding-task-confirm]").check();
    await page.evaluate(() => { state.portalSession = { ...state.portalSession }; document.querySelector("#personnelTaskDetailDialog form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    assert.equal(await dialog.evaluate(node => node.open), false);
    assert.equal(await page.evaluate(() => calls.length), 0);
    await page.evaluate(() => { previewAllowed = false; state.personnelLifecycleOffboardingTasks[0].status = "completed"; renderPersonnelWorkflowTasksImpl(); });
    assert.equal(await page.locator("#personnelTasksSummary article").nth(2).locator("strong").textContent(), "–");
    assert.equal(await page.locator(".personnel-task-due").count(), 0);
    await page.getByRole("button", { name: "Details: Arbeitsmittel zurücknehmen" }).click();
    assert.equal(await dialog.locator("form").count(), 0);
    await page.evaluate(() => { allowed = false; renderPersonnelWorkflowTasksImpl(); });
    assert.equal(await dialog.evaluate(node => node.open), false);
    assert.equal(await page.locator("#personnelTaskDetailContent").textContent(), "");
    assert.equal(await page.locator(".personnel-task-workspace-card").count(), 0);
    await page.evaluate(() => { allowed = true; state.personnelWorkflowInstanceLoadError = "Laden fehlgeschlagen"; renderPersonnelWorkflowTasksImpl(); });
    assert.match(await page.locator("#personnelWorkflowTaskList").textContent(), /nicht vollständig geladen/);
    assert.equal(await page.locator("#personnelTasksSummary article").count(), 0);
    await page.evaluate(() => { state.personnelWorkflowInstanceLoadError = ""; state.personnelWorkflowTasks[0].title = '<img src=x onerror="alert(1)">'; renderPersonnelWorkflowTasksImpl(); });
    assert.equal(await page.locator("#personnelWorkflowTaskList img").count(), 0);
    await page.getByRole("searchbox", { name: "Aufgabe suchen" }).fill("kein-passender-treffer");
    assert.match(await page.locator("#personnelWorkflowTaskList").textContent(), /Keine passenden Aufgaben/);
    await page.evaluate(() => { state.personnelWorkflowTasks = []; state.personnelLifecycleOnboardingTasks = []; state.personnelLifecycleOffboardingTasks = []; renderPersonnelWorkflowTasksImpl(); });
    assert.match(await page.locator("#personnelWorkflowTaskList").textContent(), /Aktuell keine Aufgaben/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("personal tasks retain the original completion functions and bounded task projection", () => {
  assert.match(functionSource("bindPersonnelTaskWorkspace"), /gpContextCurrent\(dialog\.personnelTaskContext\)/);
  assert.match(functionSource("personnelTaskWorkspaceRecords"), /task\.status === "active" && state\.personnelLifecycleOffboardingTaskCapabilities\.canComplete === true/);
  assert.doesNotMatch(functionSource("personnelTaskWorkspaceRecords"), /Date\.now|setTimeout|api\(/);
  assert.doesNotMatch(functionSource("renderPersonnelWorkflowTasksImpl"), /caseId|employeeNumber|orderId|receiptSha/);
});

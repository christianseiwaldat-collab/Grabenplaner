"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, ".."), enabled = process.env.GP_WINDOW_BROWSER_TEST === "1";
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const ids = ["planningAssistantEnabled", "planningAssistantAutoCheck", "planningAssistantShowInformational"];
const out = process.env.GP_ASSISTANT_SCREENSHOT_DIR ? path.resolve(process.env.GP_ASSISTANT_SCREENSHOT_DIR) : null;
const evidenceSuffix = process.env.GP_PLANNING_SETTINGS_EVIDENCE_SLUG ? "-" + process.env.GP_PLANNING_SETTINGS_EVIDENCE_SLUG : "";
let browser;
function sourceFunction(name) {
  const start = app.search(new RegExp("^(?:async )?function " + name + "\\(", "m"));
  assert(start >= 0, name); const end = app.indexOf("\n}", start); assert(end > start, name);
  return app.slice(start, end + 2);
}
function elementHtml(id) {
  const marker = html.indexOf(`id="${id}"`); assert(marker >= 0, id);
  const start = html.lastIndexOf("<", marker), tag = /^<([\w-]+)/.exec(html.slice(start))[1];
  const tokens = new RegExp(`<\\/?${tag}\\b[^>]*>`, "g"); tokens.lastIndex = start; let depth = 0;
  for (let match; (match = tokens.exec(html));) { depth += match[0].startsWith("</") ? -1 : 1; if (!depth) return html.slice(start, tokens.lastIndex); }
  assert.fail("Balanced actual settings markup");
}
test.before(async () => {
  if (!enabled) return;
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
});
test.after(async () => { if (browser) await browser.close(); });

async function setup({ viewport = { width: 1440, height: 1000 }, dark = false, settings = {} } = {}) {
  const page = await browser.newPage({ viewport, colorScheme: dark ? "dark" : "light" }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body:
    '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main class="main-content">' + elementHtml("settingsView") + "</main></body></html>" }));
  await page.goto("http://127.0.0.1/planning-settings-fixture");
  for (const file of ["styles.css", "mobile-refinements.css", "table-layout.css", "gp-window.css"]) await page.addStyleTag({ path: path.join(root, "public", file) });
  for (const file of ["form-draft-guard.js", "gp-save-status.js"]) await page.addScriptTag({ path: path.join(root, "public", file) });
  await page.evaluate(({ settings, dark }) => {
    document.getElementById("settingsView").classList.add("active");
    document.querySelectorAll(".settings-section").forEach(node => node.classList.toggle("active", node.id === "scheduleSettings"));
    document.querySelectorAll("[data-settings-tab]").forEach(node => node.classList.toggle("active", node.dataset.settingsTab === "schedule"));
    document.documentElement.dataset.activePageTheme = dark ? "dark" : "light";
    document.getElementById("settingsView").dataset.pageTheme = dark ? "dark" : "light";
    window.elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
    window.state = { portalStatus: { portalEnabled: true }, portalSession: { authenticated: true, user: {
      employeeNumber: "BEISPIEL", accountId: "EXAMPLE", sessionKind: "employee", isEmployee: true, active: true,
      role: "admin", permissions: ["settings:write"], scopes: [],
    } }, locationId: "18", departmentId: "", data: { settings: { pdf_title: "Dienstplan", break_after_minutes: "360", break_duration_minutes: "30", ...settings } },
    appFontScalePercent: 100, schedulePdfDesignSelection: ["classic"], schedulePdfDesignNames: { classic: "Klassisch" }, brandingFormDirty: false,
    scheduleDutyColorsDirty: false, allowPastWeekEditing: false };
    window.savedSettings = structuredClone(state.data.settings); window.calls = []; window.toasts = []; window.holdSave = false;
    window.workspaceCalls = []; window.workspaceRead = new AbortController();
    window.canReadStartDashboardSchedule = () => true;
    window.planningAssistantWorkspace = { synchronize({ data, session, allowed }) {
      workspaceCalls.push({ settings: structuredClone(data.settings), employeeNumber: session.user.employeeNumber, allowed });
      if (data.settings.planning_assistant_enabled === "0") workspaceRead.abort();
    } };
    window.settingsDraftGuard = GrabenplanerFormDraftGuard.create(elements.settingsView);
    Object.assign(window, { settingsSaveStatuses: new Map(), settingsSaveStatusHosts: new Map(), settingsSaveActor: null,
      settingsSavePrimary: null, settingsSaveCandidateSource: null, settingsSaveEpoch: 0, settingsSavePrimaryEpoch: 0,
      settingsConfirmedDraft: null, settingsConfirmedRevision: 0, schedulePdfSettingsWritePermission: "schedule:pdf:settings:write",
      branchSupervisionIntensityPresets: { relaxed: { primaryCoveragePercent: 50, departmentGapMinutes: 240 }, standard: { primaryCoveragePercent: 60, departmentGapMinutes: 180 }, strict: { primaryCoveragePercent: 75, departmentGapMinutes: 120 } },
      planningDayKeys: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"], fixedDayLabels: {},
    });
    window.isLocalStartDashboardWorkspace = () => false;
    window.schedulePdfDesignIdsFromSettings = () => ["classic"];
    window.schedulePdfDesignCatalog = () => [{ id: "classic", label: "Klassisch" }];
    window.schedulePdfDesignNamesForSave = () => ({ classic: "Klassisch" });
    window.applyShellBranding = () => ({ companyName: "BEISPIEL", adminEmail: "", logoUrl: "", iconUrl: "", logoAlt: "" });
    window.hasManagementBrandingAccess = () => false;
    for (const name of ["renderBrandingKits", "renderSchedulePdfDesignSettings", "renderScheduleDutyColorSettings", "applyAppFontScalePercent", "renderMaintenanceSchedules", "applyBranding", "updatePdfPreview", "renderPortalAccessState"]) window[name] = () => {};
    window.canManageScheduleDutyColors = () => false;
    window.rememberContextCacheKey = name => "synthetic-" + name;
    window.showToast = (...args) => toasts.push(args);
    window.api = async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method: options.method || "GET", body });
      if (url === "/api/portal/v1/ui-preferences" && window.failFollowup) throw new Error("BEISPIEL Folgespeicherung fehlgeschlagen");
      if (url !== "/api/settings" || options.method !== "PUT") throw new Error("Unexpected settings request");
      if (holdSave) await new Promise(resolve => { window.resolveSave = resolve; });
      if (window.failSettingsPut) throw new Error("BEISPIEL Einstellungen nicht gespeichert");
      const value = body.planningAssistant;
      savedSettings = { ...savedSettings, planning_assistant_enabled: value.enabled ? "1" : "0",
        planning_assistant_auto_check: value.autoCheck ? "1" : "0", planning_assistant_show_informational: value.showInformational ? "1" : "0" };
      return { ...structuredClone(savedSettings), unrelatedResponseMarker: "BEISPIEL nicht ungeprüft übernehmen" };
    };
    window.loadAll = async () => {
      if (window.failLoad) throw new Error("BEISPIEL Neuladen fehlgeschlagen");
      state.data.settings = structuredClone(savedSettings); renderSettings();
    };
  }, { settings, dark });
  const names = ["planningAssistantSettingsInput", "updatePlanningAssistantSettings", "renderPlanningAssistantSettings", "settingsPdfDraftScope",
    "startDashboardWorkspaceActorKey", "syncSettingsSaveScopes", "settingsSaveKey", "settingsSaveAllowed", "settingsSaveStatus", "settingsWriteGuard",
    "settingsSaveRemaining", "rememberSettingsConfirmation", "settingsConfirmationReadToken", "acknowledgeSettingsRead", "restoreSettingsConfirmation", "restoreSettingsFormDrafts",
    "trackSettingsSaveDraft", "renderSettings", "updateWeekLockSettings", "updateBranchSupervisionSettings", "initializeSettingsCardDisclosures",
    "directSettingsPackedItems", "resetSettingsPackedGrid", "measureSettingsPackedGrid", "saveSettings"];
  await page.addScriptTag({ content: names.map(sourceFunction).join("\n") });
  await page.evaluate(() => {
    window.settingsPackedGridMedia = matchMedia("(min-width: 1100px)");
    window.scheduleSettingsPackedGrid = grid => measureSettingsPackedGrid(grid);
    initializeSettingsCardDisclosures();
    elements.planningAssistantEnabled.addEventListener("change", updatePlanningAssistantSettings);
    elements.planningAssistantAutoCheck.addEventListener("change", updatePlanningAssistantSettings);
    elements.planningAssistantShowInformational.addEventListener("change", updatePlanningAssistantSettings);
    elements.settingsView.addEventListener("input", trackSettingsSaveDraft);
    elements.settingsView.addEventListener("change", trackSettingsSaveDraft);
    elements.saveSettingsButton.addEventListener("click", () => { window.lastSave = saveSettings(true); });
    renderSettings(); measureSettingsPackedGrid(elements.scheduleSettings);
  });
  return { page, errors };
}
const card = page => page.locator("#planningAssistantSettingsCard");
async function open(page) { await card(page).locator(":scope>.settings-field-disclosure-summary").click(); }
async function flags(page) { return page.evaluate(() => planningAssistantSettingsInput()); }

test("actual schedule settings contain the sixth collapsed assistant card with enabled legacy defaults", { skip: !enabled }, async () => {
  const { page, errors } = await setup(); try {
    assert.equal(await page.locator("#scheduleSettings > :nth-child(6)").getAttribute("id"), "planningAssistantSettingsCard");
    assert.equal(await card(page).locator(".settings-field-disclosure-summary").getAttribute("aria-expanded"), "false");
    assert.equal(await card(page).locator(".settings-field-disclosure-body").isVisible(), false);
    assert.deepEqual(await flags(page), { enabled: true, autoCheck: true, showInformational: true });
    await open(page); for (const id of ids) assert.equal(await page.locator("#" + id).isEnabled(), true);
    assert.equal(await page.locator("#planningAssistantSettingsState").textContent(), "Aktiv · Automatisch");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("switching off preserves child choices through real draft restoration and manual status", { skip: !enabled }, async () => {
  const { page, errors } = await setup(); try {
    await open(page); await page.locator("#planningAssistantAutoCheck").uncheck(); await page.locator("#planningAssistantShowInformational").uncheck();
    assert.equal(await page.locator("#planningAssistantSettingsState").textContent(), "Aktiv · Manuell");
    await page.locator("#planningAssistantEnabled").uncheck();
    for (const id of ids.slice(1)) assert.equal(await page.locator("#" + id).isEnabled(), false);
    for (let repeat = 0; repeat < 2; repeat++) await page.evaluate(() => renderSettings());
    assert.deepEqual(await flags(page), { enabled: false, autoCheck: false, showInformational: false });
    assert.equal(await page.evaluate(() => settingsDraftGuard.snapshot().has("planningAssistantAutoCheck")), true);
    await page.locator("#planningAssistantEnabled").check();
    assert.deepEqual(await flags(page), { enabled: true, autoCheck: false, showInformational: false });
    assert.equal(await page.locator("#planningAssistantSettingsState").textContent(), "Aktiv · Manuell"); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("real saveSettings sends an immutable snapshot, retains later edits and reloads saved preferences", { skip: !enabled }, async () => {
  const { page, errors } = await setup(); try {
    await open(page); await page.locator("#planningAssistantAutoCheck").uncheck(); await page.locator("#planningAssistantShowInformational").uncheck();
    await page.evaluate(() => { holdSave = true; }); await page.locator("#saveSettingsButton").click();
    await page.waitForFunction(() => typeof resolveSave === "function");
    await page.locator("#planningAssistantShowInformational").check();
    assert.deepEqual(await page.evaluate(() => calls[0].body.planningAssistant), { enabled: true, autoCheck: false, showInformational: false });
    await page.evaluate(async () => { holdSave = false; resolveSave(); await lastSave; });
    assert.deepEqual(await flags(page), { enabled: true, autoCheck: false, showInformational: true });
    assert.equal(await page.evaluate(() => settingsDraftGuard.snapshot().has("planningAssistantShowInformational")), true);
    await page.locator("#saveSettingsButton").click(); await page.evaluate(() => lastSave);
    assert.equal(await page.evaluate(() => settingsDraftGuard.snapshot().size), 0);
    const persisted = await page.evaluate(() => structuredClone(savedSettings));
    const reloaded = await setup({ settings: persisted });
    try { assert.deepEqual(await flags(reloaded.page), { enabled: true, autoCheck: false, showInformational: true }); assert.deepEqual(reloaded.errors, []); }
    finally { await reloaded.page.close(); }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("removing settings rights disables all switches and prevents an additional settings write", { skip: !enabled }, async () => {
  const { page, errors } = await setup(); try {
    await open(page); await page.locator("#planningAssistantAutoCheck").uncheck();
    await page.evaluate(() => { state.portalSession.user.permissions = []; renderSettings(); });
    for (const id of ids) assert.equal(await page.locator("#" + id).isEnabled(), false);
    assert.equal(await page.evaluate(() => saveSettings(true)), false);
    assert.equal(await page.evaluate(() => calls.length), 0);
    assert.equal(await page.evaluate(() => settingsDraftGuard.snapshot().size), 0); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const failure of ["load", "followup"]) {
  test(`confirmed disabling immediately aborts workspace despite a later ${failure} failure`, { skip: !enabled }, async () => {
    const { page, errors } = await setup(); try {
      await page.evaluate(failure => {
        if (failure === "followup") state.portalSession.user.permissions.push("schedule:write");
        window.failLoad = failure === "load"; window.failFollowup = failure === "followup";
        renderSettings();
      }, failure);
      await open(page); await page.locator("#planningAssistantEnabled").uncheck();
      await page.locator("#saveSettingsButton").click(); await page.evaluate(() => lastSave);
      assert.equal(await page.evaluate(() => workspaceRead.signal.aborted), true);
      assert.equal(await page.evaluate(() => workspaceCalls.length), 1);
      assert.equal(await page.evaluate(() => workspaceCalls[0].settings.planning_assistant_enabled), "0");
      assert.equal(await page.evaluate(() => state.data.settings.planning_assistant_enabled), "0");
      assert.equal(await page.evaluate(() => state.data.settings.pdf_title), "Dienstplan");
      assert.equal(await page.evaluate(() => state.data.settings.unrelatedResponseMarker), undefined);
      assert.equal(await page.evaluate(() => lastSave), failure === "load", "confirmed settings stay successful if only reloading fails; a failed subsequent write remains visible as an incomplete save");
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test("late edits survive a confirmed disabled PUT while only its server values synchronize", { skip: !enabled }, async () => {
  const { page, errors } = await setup(); try {
    await open(page); await page.locator("#planningAssistantEnabled").uncheck();
    await page.evaluate(() => { holdSave = true; failLoad = true; });
    await page.locator("#saveSettingsButton").click(); await page.waitForFunction(() => typeof resolveSave === "function");
    await page.locator("#planningAssistantEnabled").check(); await page.locator("#planningAssistantAutoCheck").uncheck();
    await page.evaluate(async () => { holdSave = false; resolveSave(); await lastSave; });
    assert.deepEqual(await flags(page), { enabled: true, autoCheck: false, showInformational: true });
    assert.deepEqual(await page.evaluate(() => ({ enabled: state.data.settings.planning_assistant_enabled,
      autoCheck: state.data.settings.planning_assistant_auto_check, showInformational: state.data.settings.planning_assistant_show_informational })),
    { enabled: "0", autoCheck: "1", showInformational: "1" });
    assert.equal(await page.evaluate(() => workspaceCalls[0].settings.planning_assistant_enabled), "0");
    assert.equal(await page.evaluate(() => workspaceRead.signal.aborted), true);
    assert.equal(await page.evaluate(() => settingsDraftGuard.snapshot().get("planningAssistantEnabled")), true);
    assert.equal(await page.evaluate(() => settingsDraftGuard.snapshot().get("planningAssistantAutoCheck")), false);
    assert.equal(await page.evaluate(() => state.data.settings.unrelatedResponseMarker), undefined); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("a failed settings PUT never synchronizes an unconfirmed local disable", { skip: !enabled }, async () => {
  const { page, errors } = await setup(); try {
    await open(page); await page.locator("#planningAssistantEnabled").uncheck();
    await page.evaluate(() => { failSettingsPut = true; });
    await page.locator("#saveSettingsButton").click(); assert.equal(await page.evaluate(() => lastSave), false);
    assert.equal(await page.evaluate(() => workspaceRead.signal.aborted), false);
    assert.equal(await page.evaluate(() => workspaceCalls.length), 0);
    assert.equal(await page.evaluate(() => state.data.settings.planning_assistant_enabled), undefined);
    assert.equal(await page.evaluate(() => settingsDraftGuard.snapshot().get("planningAssistantEnabled")), false); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const [name, viewport, dark] of [["desktop", { width: 1440, height: 1000 }, false], ["mobile", { width: 390, height: 844 }, false], ["dark-mobile", { width: 390, height: 844 }, true]]) {
  test(`actual settings fit ${name}`, { skip: !enabled }, async () => {
    const { page, errors } = await setup({ viewport, dark }); try {
      await open(page); await card(page).scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const bounds = await card(page).boundingBox(); assert(bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1);
      for (const id of ids) {
        const box = await page.locator("#" + id).boundingBox(); assert(box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width + 1);
      }
      if (dark) {
        const bg = await card(page).evaluate(node => getComputedStyle(node).backgroundColor);
        assert(Number(bg.match(/\d+/)[0]) < 80, bg);
      }
      if (out) { fs.mkdirSync(out, { recursive: true }); await page.screenshot({ path: path.join(out, `planning-assistant-settings-${name}${evidenceSuffix}.png`), fullPage: true }); }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

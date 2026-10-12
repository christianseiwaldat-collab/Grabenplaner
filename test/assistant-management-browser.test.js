"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, ".."), enabled = process.env.GP_WINDOW_BROWSER_TEST === "1";
let browser;
test.before(async () => { if (!enabled) return; const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright"); browser = await chromium.launch({ headless: true, ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) }); });
test.after(async () => { if (browser) await browser.close(); });
async function setup({ viewport = { width: 1366, height: 900 }, dark = false } = {}) {
  const page = await browser.newPage({ viewport, colorScheme: dark ? "dark" : "light" }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body data-active-page-theme="${dark ? "dark" : "light"}"><main style="padding:16px;max-width:1200px;margin:auto"><div id="developer"></div><section id="planning"></section></main></body></html>` }));
  await page.goto("http://127.0.0.1/assistant-management-fixture");
  for (const file of ["styles.css", "gp-definitions.css", "assistant-management.css"]) await page.addStyleTag({ path: path.join(root, "public", file) });
  for (const file of ["gp-definitions-registry.js", "voice-assistant-settings.js", "gp-definitions.js", "planning-assistant.js"]) await page.addScriptTag({ path: path.join(root, "public", file) });
  await page.evaluate(() => {
    window.session = { authenticated: true, user: { employeeNumber: "example-developer", role: "developer", isEmployee: true } };
    window.calls = []; window.waits = [];
    window.voice = { revision: "revision-1", settings: { enabled: false, maxSessionSeconds: 600, maxConversations: 8, portal: { enabled: true, adminOnly: true } },
      runtime: { enabled: false, apiKeyConfigured: false, environmentDisabled: false, liveModel: "gpt-live-1", backendModel: "gpt-6-luna", timeZone: "Europe/Vienna" } };
    window.planning = { assessment: { period: { from: "2031-04-07", to: "2031-04-13" }, context: { locationId: "97", locationName: "BEISPIEL Filiale", departmentId: null },
      counts: { error: 1, warning: 1, unknown: 1, info: 0 }, findings: [
        { id: "one", severity: "error", title: "Doppelbelegung", date: "2031-04-07", startTime: "10:07", endTime: "10:11", people: [{ id: "A", label: "Alexandra Beispiel" }], message: "Eine Person ist gleichzeitig mehreren Diensten zugeordnet.", suggestion: "Die Einteilung zwischen 10:07 und 10:11 im Dienstplan abgleichen." },
        { id: "two", severity: "warning", title: "Mindestbesetzung", date: "2031-04-07", startTime: "12:00", endTime: "13:00", people: [], message: "Für die Besetzung fehlt eine Person.", suggestion: "Zwischen 12:00 und 13:00 eine geeignete Person zusätzlich einteilen." },
        { id: "three", severity: "unknown", title: "Pausenabdeckung", people: [], message: "Pausenlage noch offen.", suggestion: "Pausen konkret abstimmen." },
      ] }, canConfigure: true, configuration: { revision: "p-1", valid: true, configuration: { weeklyToleranceMinutes: 0, requiredPositions: [], keyPersonNumbers: [] } },
      choices: { positions: [{ id: "sales", name: "Verkauf" }], employees: [{ id: "A", label: "Alexandra Beispiel" }, { id: "B", label: "Max Beispiel" }] } };
    window.api = async (url, options = {}) => {
      calls.push({ url, method: options.method || "GET", body: options.body && JSON.parse(options.body) });
      const value = url.includes("voice-assistants") ? voice : planning;
      if (window.hold) await new Promise(resolve => waits.push(resolve));
      if (window.fail) throw new Error("BEISPIEL Dienst nicht erreichbar");
      if (options.method === "PUT") {
        if (window.conflict) throw Object.assign(new Error("Die Einstellungen wurden inzwischen geändert. Bitte neu laden."), { status: 409 });
        const body = JSON.parse(options.body);
        if (body.settings) { voice.settings = body.settings; voice.revision = "revision-2"; voice.runtime.enabled = body.settings.enabled && body.settings.portal.enabled; return structuredClone(voice); }
        planning.configuration = { revision: "p-2", valid: true, configuration: body.configuration }; return structuredClone(planning.configuration);
      }
      return structuredClone(value);
    };
    window.developer = GpDefinitions.mount(document.getElementById("developer"), { api, canUse: () => GpDefinitionsRegistry.canAccess(session), key: () => session?.user?.employeeNumber || "", loadWorkspaces: async () => [] });
    window.assistant = GpPlanningAssistant.mount(document.getElementById("planning"), { api });
    window.data = { weekStart: "2031-04-07", context: planning.assessment.context, enrichmentPending: false };
    developer.activate();
  });
  return { page, errors, async close() { await page.evaluate(() => { developer.destroy(); assistant.reset(); }); await page.close(); } };
}
async function capture(page, name) { if (!process.env.GP_ASSISTANT_SCREENSHOT_DIR) return; fs.mkdirSync(process.env.GP_ASSISTANT_SCREENSHOT_DIR, { recursive: true }); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ fullPage: true, path: path.join(process.env.GP_ASSISTANT_SCREENSHOT_DIR, name + ".png") }); }
for (const [name, viewport, dark] of [["desktop", { width: 1366, height: 900 }, false], ["phone", { width: 390, height: 844 }, false], ["phone-dark", { width: 390, height: 844 }, true]]) {
  test(`Developer hierarchy and portal.assistant settings on ${name}`, { skip: !enabled }, async () => {
    const f = await setup({ viewport, dark }); try {
      const page = f.page;
      await page.locator('[data-gp-voice-page="voice.assistants"]').click();
      await page.waitForFunction(() => document.querySelector('[name="maxSessionSeconds"]').value === "600");
      assert.equal(await page.locator('[data-gp-voice-page="voice.assistants"]').getAttribute("aria-current"), "page");
      await page.locator('[name="maxSessionSeconds"]').fill("240");
      await page.locator('.voice-settings form:not([hidden]) button[type="submit"]').click();
      await page.waitForFunction(() => document.querySelector(".voice-settings-status").textContent.includes("Gespeichert"));
      await capture(page, "voice-settings-" + name);
      await page.locator('[data-gp-voice-page="portal.assistant"]').click();
      assert.equal(await page.locator('[data-gp-voice-page="portal.assistant"]').getAttribute("aria-current"), "page");
      assert(await page.locator('[data-gp-voice-page="voice.assistants"]').evaluate(el => el.classList.contains("is-active-ancestor")));
      await page.locator('[name="pilotEmployeeNumbers"]').fill("252");
      await page.locator('[name="portalEnabled"]').uncheck(); await page.locator('.voice-settings form:not([hidden]) button[type="submit"]').click();
      await page.waitForFunction(() => !voice.settings.portal.enabled && !document.querySelector('[name="portalEnabled"]').disabled);
      assert.equal(await page.evaluate(() => voice.settings.maxSessionSeconds), 240);
      assert.deepEqual(await page.evaluate(() => voice.settings.portal.pilotEmployeeNumbers), ["252"]);
      await capture(page, "portal-assistant-" + name);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert((await page.locator('.voice-settings form:not([hidden]) button[type="submit"]').boundingBox()).height >= 44);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
  test(`planning findings, severity filter and configuration on ${name}`, { skip: !enabled }, async () => {
    const f = await setup({ viewport, dark }); try {
      const page = f.page; await page.evaluate(() => { developer.suspend(); assistant.synchronize({ data, session, allowed: true }); });
      await page.waitForFunction(() => document.querySelector(".planning-assistant-status").textContent.includes("1 Konflikt · 1 Warnung"));
      await page.locator("#planning>details>summary").first().click(); assert.equal(await page.locator(".planning-assistant-finding").count(), 3);
      await page.getByLabel("Hinweise nach Schweregrad filtern").selectOption("warning"); assert.equal(await page.locator(".planning-assistant-finding").count(), 1);
      await page.getByLabel("Hinweise nach Schweregrad filtern").selectOption("all");
      await capture(page, "planning-" + name);
      await page.locator(".planning-assistant-settings>summary").click(); await page.locator('[name="weeklyToleranceMinutes"]').fill("20");
      await page.getByRole("button", { name: "Position hinzufügen", exact: true }).click(); await page.getByLabel("Erforderliche Position", { exact: true }).selectOption("sales");
      await page.getByLabel("Mindestanzahl", { exact: true }).fill("2"); await page.getByLabel("Alexandra Beispiel", { exact: true }).check();
      await page.getByRole("button", { name: "Prüfeinstellungen speichern", exact: true }).click();
      await page.waitForFunction(() => planning.configuration.configuration.weeklyToleranceMinutes === 20 && !document.querySelector('[name="weeklyToleranceMinutes"]').disabled);
      const writes = await page.evaluate(() => calls.filter(call => call.method === "PUT")); assert.equal(writes.length, 1); assert.equal(writes[0].url, "/api/settings/planning-assistant");
      assert.deepEqual(writes[0].body.configuration, { weeklyToleranceMinutes: 20, requiredPositions: [{ positionId: "sales", count: 2 }], keyPersonNumbers: ["A"] });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
test("Developer logout discards late configuration response and rights changes hide the complete workspace", { skip: !enabled }, async () => {
  const f = await setup(); try {
    await f.page.evaluate(() => { hold = true; }); await f.page.locator('[data-gp-voice-page="voice.assistants"]').click();
    await f.page.waitForFunction(() => waits.length > 0);
    await f.page.evaluate(() => { session = null; developer.synchronize(); waits.splice(0).forEach(resolve => resolve()); });
    assert.equal(await f.page.locator("#developer").isVisible(), false); assert.equal(await f.page.locator('.voice-settings input[name="maxSessionSeconds"]').inputValue(), "");
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test("planning ignores stale scope responses, clears on logout and shows outages instead of old results", { skip: !enabled }, async () => {
  const f = await setup(); try {
    await f.page.evaluate(() => { developer.suspend(); hold = true; assistant.synchronize({ data, session, allowed: true }); });
    await f.page.waitForFunction(() => waits.length > 0);
    await f.page.evaluate(() => { assistant.reset(); waits.splice(0).forEach(resolve => resolve()); hold = false; });
    assert.equal(await f.page.locator("#planning").isVisible(), false); assert.equal(await f.page.locator(".planning-assistant-finding").count(), 0);
    await f.page.evaluate(() => { fail = true; assistant.synchronize({ data: { ...data }, session, allowed: true }); });
    await f.page.waitForFunction(() => document.querySelector(".planning-assistant-status").textContent.includes("nicht verfügbar"));
    assert.equal(await f.page.locator(".planning-assistant-finding").count(), 0); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test("configuration conflict preserves entered fields for explicit reload", { skip: !enabled }, async () => {
  const f = await setup(); try {
    await f.page.locator('[data-gp-voice-page="voice.assistants"]').click(); await f.page.waitForFunction(() => document.querySelector('[name="maxSessionSeconds"]').value === "600");
    await f.page.locator('[name="maxSessionSeconds"]').fill("300"); await f.page.evaluate(() => { conflict = true; });
    await f.page.locator('.voice-settings form:not([hidden]) button[type="submit"]').click(); await f.page.waitForFunction(() => document.querySelector(".voice-settings-status").textContent.includes("inzwischen geändert"));
    assert.equal(await f.page.locator('[name="maxSessionSeconds"]').inputValue(), "300"); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test("automatic plan refresh preserves unsaved settings and the original revision", { skip: !enabled }, async () => {
  const f = await setup(); try {
    const page = f.page;
    await page.evaluate(() => { developer.suspend(); assistant.synchronize({ data, session, allowed: true }); });
    await page.waitForFunction(() => document.querySelector(".planning-assistant-status").textContent.includes("1 Konflikt · 1 Warnung"));
    await page.locator(".planning-assistant-settings>summary").click(); await page.locator('[name="weeklyToleranceMinutes"]').fill("25");
    await page.evaluate(() => { planning.configuration.revision = "p-changed"; planning.configuration.configuration.weeklyToleranceMinutes = 5; assistant.synchronize({ data: { ...data }, session, allowed: true }); });
    await page.waitForFunction(() => !document.querySelector('[name="weeklyToleranceMinutes"]').disabled);
    assert.equal(await page.locator('[name="weeklyToleranceMinutes"]').inputValue(), "25");
    await page.evaluate(() => { conflict = true; }); await page.getByRole("button", { name: "Prüfeinstellungen speichern", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".planning-assistant-settings").textContent.includes("inzwischen geändert"));
    const last = await page.evaluate(() => calls.filter(item => item.method === "PUT").at(-1)); assert.equal(last.body.revision, "p-1");
    await page.evaluate(() => { conflict = false; }); await page.getByRole("button", { name: "Eingaben verwerfen und neu laden", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[name="weeklyToleranceMinutes"]').value === "5"); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

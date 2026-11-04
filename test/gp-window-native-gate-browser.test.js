"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/portal.html"), "utf8");
const portal = fs.readFileSync(path.join(root, "public/portal.js"), "utf8").replace(/\r\n/g, "\n");
const workspaceId = "personalActionsDialog";

function fragment(id) {
  const match = html.match(new RegExp('<dialog\\b[^>]*\\bid="' + id + '"[^>]*>'));
  assert.ok(match, `Actual portal dialog missing: ${id}`);
  const end = html.indexOf("</dialog>", match.index);
  assert.ok(end > match.index);
  return html.slice(match.index, end + 9);
}

function passwordCloseSource() {
  const start = portal.indexOf("function closePasswordChangeDialog("), end = portal.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start);
  return portal.slice(start, end + 3);
}

async function fixture(browser, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.abort());
  await page.setContent('<button id="syntheticOpener">BEISPIEL</button>'
    + [workspaceId, "passwordDialog", "passwordResetRequestDialog", "passwordResetConfirmDialog"].map(fragment).join(""));
  for (const file of ["portal.css", "gp-window.css"]) await page.addStyleTag({ path: path.join(root, "public", file) });
  for (const file of ["gp-window-preferences.js", "gp-window.js"]) await page.addScriptTag({ path: path.join(root, "public", file) });
  await page.evaluate(({ actor, authorized, windows, source }) => {
    window.actor = actor;
    window.authorized = authorized;
    window.reads = [];
    window.writes = [];
    window.el = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
    window.setPasswordChangeControlsEnabled = enabled => {
      for (const input of el.passwordForm.querySelectorAll("input")) input.disabled = !enabled;
    };
    window.closePasswordChangeDialog = Function("return (" + source + ")")();
    el.passwordDialog.dataset.required = "true";
    el.passwordDialog.addEventListener("cancel", event => { event.preventDefault(); closePasswordChangeDialog(); });
    document.querySelectorAll("[data-close-dialog]").forEach(button => {
      button.addEventListener("click", () => closePasswordChangeDialog());
    });
    window.manager = GpWindow.installDocument(document, {
      actorKey: () => window.actor,
      canUse: () => window.authorized,
      readPreferences: async () => { reads.push(window.actor); return { version: 1, windows }; },
      writePreferences: async value => { writes.push({ actor: window.actor, value }); },
      api: async () => { throw new Error("Unexpected real API access in native gate fixture"); },
    });
  }, { actor: options.actor ?? "", authorized: options.authorized ?? false,
    windows: options.windows || {}, source: passwordCloseSource() });
  return { page, errors };
}

async function nativePassword(page) {
  await page.evaluate(() => el.passwordDialog.showModal());
  await page.waitForFunction(() => el.passwordDialog.querySelector(".gp-dialog-window-title"));
  assert.equal(await page.locator("#passwordDialog").evaluate(node => node.matches(":modal")), true);
  assert.equal(await page.locator("#passwordDialog [data-gp-window-toggle]").count(), 0);
  return page.locator("#passwordDialog").boundingBox();
}

function browserOptions() {
  return { headless: true,
    ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}),
    args: ["--no-first-run"] };
}

test("denied or empty-actor windows expose native password/reset gates without preferences or workspace access",
  { skip: process.env.GP_WINDOW_BROWSER_TEST !== "1", timeout: 60000 }, async () => {
    const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
    const browser = await chromium.launch(browserOptions());
    try {
      for (const options of [
        { actor: "", authorized: false },
        { actor: "SYNTHETIC-A", authorized: false },
        { actor: "", authorized: true },
      ]) {
        const { page, errors } = await fixture(browser, options);
        try {
          // Activation itself must be harmless when denied. Waiting for ready
          // would be wrong: no preference request is permitted in this state.
          await page.evaluate(() => manager.preferences.activate());
          assert.equal(await page.evaluate(() => reads.length), 0);
          assert.equal(await page.evaluate(() => manager.preferences.ready), false);
          assert.equal(await page.locator("#" + workspaceId).getAttribute("data-gp-window-mode"), "workspace");
          assert.deepEqual(await page.evaluate(() => {
            el.personalActionsDialog.showModal();
            const ticket = GpWindow.capture(el.personalActionsDialog);
            return [el.personalActionsDialog.open, ticket === null, GpWindow.current(ticket),
              GpWindow.currentContext(GpWindow.captureContext(document))];
          }), [false, true, false, false]);

          await nativePassword(page);
          assert.equal((await page.locator("#passwordDialog .gp-dialog-window-title").boundingBox()).height, 44);
          await page.locator("#passwordDialog [data-gp-window-close]").focus();
          await page.keyboard.press("Escape");
          assert.equal(await page.locator("#passwordDialog").evaluate(node => node.open), true);
          await page.locator("#passwordDialog [data-gp-window-close]").click();
          assert.equal(await page.locator("#passwordDialog").evaluate(node => node.open), true, "Generated close respects the required password gate");
          // Neutral native windows can be moved, but never write account state.
          const move = page.locator("#passwordDialog .gp-dialog-window-title");
          await move.focus(); await page.keyboard.press("ArrowRight");
          await page.evaluate(() => closePasswordChangeDialog({ force: true }));
          for (const id of ["passwordResetRequestDialog", "passwordResetConfirmDialog"]) {
            await page.evaluate(id => document.getElementById(id).showModal(), id);
            await page.waitForFunction(id => document.getElementById(id).querySelector(".gp-dialog-window-title"), id);
            assert.equal(await page.locator("#" + id).evaluate(node => node.matches(":modal")), true);
            assert.equal(await page.locator("#" + id + " [data-gp-window-toggle]").count(), 0);
            await page.locator("#" + id + " [data-gp-window-close]").focus();
            await page.keyboard.press("Escape");
            await page.waitForFunction(id => !document.getElementById(id).open, id);
          }
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.deepEqual(await page.evaluate(() => [reads.length, writes.length]), [0, 0]);
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      }
    } finally { await browser.close(); }
  });

test("a native dialog discards previous actor geometry and workspace tickets after synchronize",
  { skip: process.env.GP_WINDOW_BROWSER_TEST !== "1", timeout: 60000 }, async () => {
    const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
    const browser = await chromium.launch(browserOptions());
    try {
      const baseline = await fixture(browser);
      const defaultGeometry = await nativePassword(baseline.page);
      await baseline.page.close();
      const saved = { x: 31, y: 47, width: 900, height: 760, minimized: true };
      const { page, errors } = await fixture(browser, {
        actor: "SYNTHETIC-A", authorized: true, windows: { passwordDialog: saved },
      });
      try {
        await nativePassword(page);
        await page.waitForFunction(() => manager.preferences.ready);
        const accountGeometry = await page.locator("#passwordDialog").boundingBox();
        for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(accountGeometry[key] - saved[key]) < 2, `Authorized ${key}`);
        assert.equal(await page.locator("#passwordDialog .gp-dialog-body").isVisible(), true, "Native security dialogs ignore saved minimization");
        assert.deepEqual(await page.evaluate(() => {
          window.oldNativeTicket = GpWindow.capture(el.passwordDialog);
          return [GpWindow.current(oldNativeTicket), reads.length, writes.length];
        }), [true, 1, 0]);
        await page.evaluate(() => {
          closePasswordChangeDialog({ force: true });
          el.personalActionsDialog.showModal();
          window.oldWorkspaceTicket = GpWindow.capture(el.personalActionsDialog);
          window.oldContextTicket = GpWindow.captureContext(document);
          window.oldWorkspaceWasCurrent = GpWindow.current(oldWorkspaceTicket);
          // Native close events are queued. Keep the close, account reset and
          // reopen in one turn to exercise the stale account geometry race.
          actor = ""; authorized = false; manager.synchronize();
          el.passwordDialog.showModal();
        });
        assert.equal(await page.evaluate(() => oldWorkspaceWasCurrent), true);
        assert.deepEqual(await page.evaluate(() => [
          GpWindow.current(oldNativeTicket, { allowClosed: true }),
          GpWindow.current(oldWorkspaceTicket, { allowClosed: true }),
          GpWindow.currentContext(oldContextTicket),
        ]), [false, false, false]);
        const neutralGeometry = await nativePassword(page);
        for (const key of ["x", "y", "width", "height"]) {
          assert.ok(Math.abs(neutralGeometry[key] - defaultGeometry[key]) < 2, `Neutral ${key} uses DOM default, not previous account`);
        }
        assert.ok(Math.abs(neutralGeometry.width - saved.width) > 100);
        assert.deepEqual(await page.evaluate(() => {
          el.personalActionsDialog.showModal();
          return [el.personalActionsDialog.open, GpWindow.capture(el.personalActionsDialog) === null];
        }), [false, true]);
        await page.locator("#passwordDialog [data-gp-window-close]").focus();
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#passwordDialog").evaluate(node => node.open), true);
        await page.evaluate(() => manager.preferences.activate());
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.deepEqual(await page.evaluate(() => [reads.length, writes.length]), [1, 0], "No preferences are accessed after actor denial");
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    } finally { await browser.close(); }
  });

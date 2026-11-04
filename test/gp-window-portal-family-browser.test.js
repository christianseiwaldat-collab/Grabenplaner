"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/portal.html"), "utf8");
const portal = fs.readFileSync(path.join(root, "public/portal.js"), "utf8").replace(/\r\n/g, "\n");
const workspaces = ["historyDetailDialog", "notificationsDialog", "personalActionsDialog", "portalLearningProgressDialog"];
const security = ["passwordDialog", "passwordResetRequestDialog", "passwordResetConfirmDialog", "loanConfirmationDialog"];

function dialog(id) {
  const match = html.match(new RegExp('<dialog\\b[^>]*\\bid="' + id + '"[^>]*>'));
  assert.ok(match, `Actual portal dialog missing: ${id}`);
  const end = html.indexOf("</dialog>", match.index);
  assert.ok(end > match.index, id);
  return html.slice(match.index, end + 9);
}

function portalFunction(name) {
  const marker = `function ${name}(`;
  const start = portal.indexOf(marker), end = portal.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, `Actual portal handler missing: ${name}`);
  return portal.slice(start, end + 3);
}

test("actual portal workspaces retain their content on desktop and touch devices while required decisions remain modal",
  { skip: process.env.GP_WINDOW_BROWSER_TEST !== "1", timeout: 90000 }, async () => {
    const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}),
      args: ["--no-first-run"],
    });
    const screenshotDirectory = path.resolve(process.env.GP_WINDOW_SCREENSHOT_DIR
      || path.join(root, "..", "output", "gp-22-blocks-20261011"));
    assert.ok(!screenshotDirectory.toLowerCase().startsWith(root.toLowerCase() + path.sep), "Screenshots must stay outside Git checkout");
    fs.mkdirSync(screenshotDirectory, { recursive: true });
    try {
      for (const mode of [
        { name: "desktop", viewport: { width: 1440, height: 1000 }, hasTouch: false },
        { name: "mobile", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
      ]) {
        const context = await browser.newContext({
          viewport: mode.viewport, hasTouch: mode.hasTouch, isMobile: mode.isMobile === true,
        });
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(7000);
          const errors = [];
          page.on("pageerror", error => errors.push(error.message));
          await page.route("**/*", route => route.abort());
          await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><button id="syntheticBackground" class="text-button">BEISPIEL Hintergrund</button>'
            + [...workspaces, ...security].map(dialog).join(""));
          for (const file of ["portal.css", "gp-window.css"]) {
            await page.addStyleTag({ path: path.join(root, "public", file) });
          }
          for (const file of ["gp-window-preferences.js", "gp-window.js"]) {
            await page.addScriptTag({ path: path.join(root, "public", file) });
          }
          await page.evaluate(source => {
            window.actor = "SYNTHETIC-PORTAL-A";
            window.backgroundClicks = 0;
            window.closeCounts = {};
            window.savedWindows = [];
            window.originalForms = new Map();
            window.el = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
            window.setPasswordChangeControlsEnabled = enabled => {
              for (const input of el.passwordForm.querySelectorAll("input")) input.disabled = !enabled;
            };
            window.closePasswordChangeDialog = Function("return (" + source + ")")();
            el.passwordDialog.dataset.required = "true";
            el.passwordDialog.addEventListener("cancel", event => {
              event.preventDefault(); closePasswordChangeDialog();
            });
            el.loanConfirmationDialog.addEventListener("cancel", event => event.preventDefault());
            document.addEventListener("click", event => {
              if (event.target.closest("[data-close-dialog]")) return void closePasswordChangeDialog();
              const attributes = {
                "data-close-history-detail": "historyDetailDialog",
                "data-close-notifications": "notificationsDialog",
                "data-close-personal-actions": "personalActionsDialog",
                "data-close-portal-learning-progress": "portalLearningProgressDialog",
                "data-close-password-reset-request": "passwordResetRequestDialog",
                "data-close-password-reset-confirm": "passwordResetConfirmDialog",
              };
              for (const [attribute, id] of Object.entries(attributes)) {
                if (event.target.closest(`[${attribute}]`)) { el[id].close(); return; }
              }
            });
            el.syntheticBackground.onclick = () => backgroundClicks++;
            for (const node of document.querySelectorAll("dialog")) {
              originalForms.set(node.id, node.querySelector("form"));
              closeCounts[node.id] = 0;
              node.addEventListener("close", () => closeCounts[node.id]++);
            }
            el.historyDetailTitle.textContent = "BEISPIEL · Antragsverlauf";
            el.historyDetailSummary.innerHTML = "<strong>BEISPIEL · 12.–14. Oktober</strong><p>Synthetischer Antrag für die Fensterprüfung.</p>";
            el.historyDecisionTimeline.innerHTML = "<article>BEISPIEL: Antrag erstellt und fachlich geprüft.</article>";
            el.notificationList.innerHTML = '<button class="notification-item" type="button"><span><strong>BEISPIEL · Neue Information</strong><small>Synthetische Benachrichtigung.</small></span></button>';
            el.personalActionsList.innerHTML = '<article class="personal-action-row"><div><strong>BEISPIEL · Eigene Aktion</strong><p>Diese Einträge gehören ausschließlich zum synthetischen Browsertest.</p></div></article>';
            el.portalLearningProgressSummary.innerHTML = "<strong>BEISPIEL · Schulungsfortschritt</strong><p>Eigene Arbeitsfassung mit unverändertem Revisionsstand.</p>";
            el.portalLearningProgressSteps.innerHTML = '<label class="portal-learning-progress-step"><input type="checkbox" data-portal-learning-step="SYN-STEP"><span><strong>1. BEISPIEL-Schritt</strong><small>Synthetischer Lernschritt.</small></span><em>Pflicht</em></label>';
            window.manager = GpWindow.installDocument(document, {
              actorKey: () => actor,
              canUse: () => Boolean(actor),
              readPreferences: async () => ({ version: 1, windows: {} }),
              writePreferences: async value => savedWindows.push(value),
            });
          }, portalFunction("closePasswordChangeDialog"));
          await page.evaluate(() => manager.preferences.activate());
          await page.waitForFunction(() => manager.preferences.ready);
          assert.equal(await page.evaluate(() => innerWidth), mode.viewport.width, mode.name + " actual CSS viewport");
          const activate = async target => {
            if (mode.hasTouch) await target.tap(); else await target.click();
          };

          for (const id of workspaces) {
            assert.equal(await page.locator("#" + id).getAttribute("data-gp-window-mode"), "workspace", id);
            await page.evaluate(id => document.getElementById(id).showModal(), id);
            assert.equal(await page.locator("#" + id).evaluate(node => node.matches(":modal")), false, id);
            assert.equal(await page.locator("#" + id + " .gp-dialog-window-title").count(), 1, id);
            assert.equal(await page.locator("#" + id + " button:visible").filter({hasText:/^[×✕✖]$/}).count(),1,id);
            assert.ok(Math.abs((await page.locator("#" + id + " .gp-dialog-window-title").boundingBox()).height - 44) < .01, id);
            assert.equal(await page.evaluate(id => document.getElementById(id).querySelector("form") === originalForms.get(id), id), true);
            // These actual portal workspaces have no file input. File retention
            // is checked only if the portal adds a real attachment control.
            const files = page.locator("#" + id + ' input[type="file"]');
            if (await files.count()) {
              await files.first().setInputFiles({ name: "BEISPIEL.txt", mimeType: "text/plain", buffer: Buffer.from("BEISPIEL") });
            }
            if (id === "portalLearningProgressDialog") {
              await page.locator("#portalLearningProgressAssessmentNote").fill("BEISPIEL: Ungespeicherte Rückmeldung bleibt erhalten.");
              await page.locator('[data-portal-learning-step="SYN-STEP"]').check();
            }
            const before = await page.locator("#" + id + " .gp-dialog-body").textContent();
            await activate(page.locator("#" + id + " [data-gp-window-toggle]"));
            await activate(page.locator("#syntheticBackground"));
            assert.equal(await page.locator("#" + id).evaluate(node => node.open), true);
            assert.equal(await page.evaluate(id => closeCounts[id], id), 0, "Minimizing must not dispatch close");
            await activate(page.locator("#" + id + " [data-gp-window-toggle]"));
            assert.equal(await page.locator("#" + id + " .gp-dialog-body").textContent(), before);
            if (await files.count()) assert.equal(await files.first().evaluate(node => node.files[0].name), "BEISPIEL.txt");
            if (id === "portalLearningProgressDialog") {
              assert.equal(await page.locator("#portalLearningProgressAssessmentNote").inputValue(), "BEISPIEL: Ungespeicherte Rückmeldung bleibt erhalten.");
              assert.equal(await page.locator('[data-portal-learning-step="SYN-STEP"]').isChecked(), true);
            }
            assert.equal(await page.locator("#" + id + " .gp-dialog-body").evaluate(node => node.scrollWidth > node.clientWidth + 1), false, id);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            await page.screenshot({ path: path.join(screenshotDirectory, `block07-portal-${mode.name}-${id}.png`), fullPage: true });
            await page.locator("#" + id + " [data-gp-window-close]").focus();
            await page.keyboard.press("Escape");
            await page.waitForFunction(id => !document.getElementById(id).open, id);
            assert.equal(await page.evaluate(id => closeCounts[id], id), 1);
          }
          assert.equal(await page.evaluate(() => backgroundClicks), workspaces.length);

          // Keep a real workspace open underneath each native security dialog.
          await page.evaluate(() => el.portalLearningProgressDialog.showModal());
          await page.locator("#portalLearningProgressAssessmentNote").fill("BEISPIEL: Entwurf hinter Pflichtdialog.");
          for (const id of security) {
            assert.notEqual(await page.locator("#" + id).getAttribute("data-gp-window-mode"), "workspace", id);
            await page.evaluate(id => document.getElementById(id).showModal(), id);
            assert.equal(await page.locator("#" + id).evaluate(node => node.matches(":modal")), true, id);
            assert.equal(await page.locator("#" + id + " [data-gp-window-toggle]").count(), 0, id);
            await page.locator("#" + id + " [data-gp-window-close]").focus();
            await page.keyboard.press("Escape");
            if (["passwordDialog", "loanConfirmationDialog"].includes(id)) {
              assert.equal(await page.locator("#" + id).evaluate(node => node.open), true, "Required cancel remains blocked");
              await activate(page.locator("#" + id + " [data-gp-window-close]"));
              assert.equal(await page.locator("#" + id).evaluate(node => node.open), true, "GP close must honor required cancel");
              if (id === "passwordDialog") await page.evaluate(() => closePasswordChangeDialog({ force: true }));
              else await page.evaluate(() => el.loanConfirmationDialog.close());
            } else await page.waitForFunction(id => !document.getElementById(id).open, id);
            assert.equal(await page.locator("#portalLearningProgressDialog").evaluate(node => node.open), true);
            assert.equal(await page.locator("#portalLearningProgressAssessmentNote").inputValue(), "BEISPIEL: Entwurf hinter Pflichtdialog.");
          }

          for (const id of workspaces) await page.evaluate(id => document.getElementById(id).showModal(), id);
          await page.evaluate(() => { actor = ""; manager.synchronize(); });
          for (const id of workspaces) assert.equal(await page.locator("#" + id).isVisible(), false, id);
          assert.equal(await page.locator("dialog[open]").count(), 0);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  });

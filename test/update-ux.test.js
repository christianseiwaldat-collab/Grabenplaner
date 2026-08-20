const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");

test("Updater-Oberfläche unterscheidet Service-, Sicherheits- und Funktionsupdates", () => {
  const appSource = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const styles = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");

  assert.match(appSource, /const updateTypeLabel = status\.updateTypeLabel \|\| "Update"/);
  assert.match(appSource, /status\.updateKind === "security" \? "security" : "available"/);
  assert.match(appSource, /`\$\{updateTypeLabel\} verfügbar`/);
  assert.match(styles, /\.settings-update-button\.security/);
  assert.equal((html.match(/id="updateCheckButton"/g) || []).length, 1);
  const sidebar = html.match(/<aside class="sidebar"[\s\S]*?<\/aside>/)?.[0] || "";
  const settingsHeader = html.match(/<section id="settingsView"[\s\S]*?<header class="settings-header">[\s\S]*?<\/header>/)?.[0] || "";
  assert.doesNotMatch(sidebar, /id="updateCheckButton"/);
  assert.match(settingsHeader, /class="settings-update-button" id="updateCheckButton"/);
  assert.doesNotMatch(appSource, /Klick unten links/);
  assert.match(appSource, /const updateAccess = !lanActive \|\| permissions\.includes\("update:write"\)/);
  assert.match(appSource, /mobilePortalLocationDisplayAccess \|\| birthdayPresentationSettingsAccess \|\| updateAccess/);
  assert.match(appSource, /updateCheckButton\?\.classList\.toggle\("hidden", !updateAccess\)/);
  assert.match(styles, /data-active-page-theme="dark"[^\n]*#settingsView \.settings-update-button\.current[^\n]*var\(--success-surface\)/);
  assert.match(styles, /data-active-page-theme="dark"[^\n]*#settingsView \.settings-update-button\.available[^\n]*var\(--warning-surface\)/);
  assert.match(styles, /data-active-page-theme="dark"[^\n]*#settingsView \.settings-update-button:is\(\.security,\.error\)[^\n]*var\(--danger-surface\)/);
});

test("Sidebar, Rechteerklärung und xoffi-Wochenbestätigung behalten ihre Layoutverträge", () => {
  const appSource = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const styles = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");

  assert.match(html, /class="nav-item nav-module-route request-nav-item hidden"/);
  assert.doesNotMatch(styles, /\.request-nav-item\s*\{[^}]*grid-template-columns/);

  assert.equal((html.match(/id="rightsDashboardExplanation"/g) || []).length, 1);
  assert.match(appSource, /selectedButton\.insertAdjacentElement\("afterend", elements\.rightsDashboardExplanation\)/);
  assert.match(styles, /\.rights-dashboard-permission-grid > \.rights-dashboard-explanation\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);

  for (const id of [
    "xoffiScreenshotWeekConfirmation",
    "xoffiScreenshotWeekConfirmationText",
    "xoffiScreenshotWeekConfirmed",
    "xoffiScreenshotWeekConfirmationLabel",
  ]) assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1);
  assert.match(appSource, /screenshotWeekConfirmed:\s*elements\.xoffiScreenshotWeekConfirmed\?\.checked === true/);
  assert.match(appSource, /weekResolution\.confirmationRequired/);
  assert.match(appSource, /weekResolution\.status === "conflict"/);
  assert.match(appSource, /weekResolution\.status === "uncertain"/);
});

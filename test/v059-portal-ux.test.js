"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");

test("v0.59: mobile Leitungsansicht folgt effektiven Rechten", () => {
  const source = fs.readFileSync(path.join(projectRoot, "public", "portal.js"), "utf8");

  assert.match(source, /const leadershipPortalPermissions = new Set\(\[/);
  assert.match(source, /user\.permissions\.some\(\(permission\) => leadershipPortalPermissions\.has\(permission\)\)/);
  assert.doesNotMatch(source, /function isLeadershipUser[\s\S]{0,220}includes\(user\?\.role\)/);
});

test("v0.59: Fehler des aktiven Leitungsbereichs werden nicht als leere Liste verdeckt", () => {
  const source = fs.readFileSync(path.join(projectRoot, "public", "portal.js"), "utf8");

  assert.match(source, /const activeFailure = results\.find\([\s\S]{0,220}tasks\[index\]\.kind === portalState\.leadershipKind/);
  assert.match(source, /if \(activeFailure\) \{[\s\S]{0,260}Dieser Bereich konnte nicht geladen werden/);
});

test("v0.59: geschützte AUM-Benachrichtigungen bleiben in der mobilen Leitungsansicht", () => {
  const source = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
  const notificationBlock = source.match(/createPortalNotification\(recipient, "protected\.update"[\s\S]{0,620}?protectedPortalEntityId\("amu-report"[\s\S]{0,220}?\n\s*\}\);/);

  assert.ok(notificationBlock, "AUM-Benachrichtigungsblock fehlt");
  assert.match(notificationBlock[0], /target: "\/portal\.html\?tab=leadershipApprovals/);
  assert.doesNotMatch(notificationBlock[0], /target: "\/\?view=requests&kind=amu"/);
});

test("v0.59: externe Warnkanäle werden vor Aktivierung per Einmalcode bestätigt", () => {
  const source = fs.readFileSync(path.join(projectRoot, "public", "portal.js"), "utf8");
  const confirmationBlock = source.match(/async function confirmSicknessNotificationVerification[\s\S]+?\n\}/);

  assert.match(source, /Bestätigung ausständig/);
  assert.match(source, /data-channel-code type="text" inputmode="numeric" autocomplete="one-time-code"/);
  assert.match(source, /\/sickness-notification-preferences\/verification"/);
  assert.match(source, /\/sickness-notification-preferences\/verification\/confirm"/);
  assert.match(source, /JSON\.stringify\(\{ channel, destination, earliestTime:/);
  assert.match(source, /JSON\.stringify\(\{ channel, code \}\)/);
  assert.ok(confirmationBlock, "Bestätigungsfunktion fehlt");
  assert.doesNotMatch(confirmationBlock[0], /console\./);
});

test("v0.59: normales Speichern übernimmt keine unbestätigt geänderten Empfänger", () => {
  const source = fs.readFileSync(path.join(projectRoot, "public", "portal.js"), "utf8");
  const saveBlock = source.match(/async function saveSicknessNotificationPreferences[\s\S]+?\n\}/);

  assert.ok(saveBlock, "Speicherfunktion für Warnkanäle fehlt");
  assert.match(saveBlock[0], /Bitte geänderte Empfänger zuerst mit einem Bestätigungscode bestätigen/);
  assert.match(saveBlock[0], /enabled: Boolean\(preference\.verifiedAt\)/);
  assert.match(saveBlock[0], /destination: preference\.destination \|\| ""/);
});

test("v0.59: OTP-Zeilen stapeln sich auf schmalen Handy-Displays", () => {
  const source = fs.readFileSync(path.join(projectRoot, "public", "portal.css"), "utf8");

  assert.match(source, /@media \(max-width:560px\)[\s\S]*?\.notification-channel-row \{ grid-template-columns:1fr;/);
  assert.match(source, /\.notification-channel-setup,\.notification-verification-row \{ grid-column:1; grid-template-columns:1fr; \}/);
  assert.match(source, /\.notification-channel-setup button,\.notification-verification-row button \{ width:100%; \}/);
});

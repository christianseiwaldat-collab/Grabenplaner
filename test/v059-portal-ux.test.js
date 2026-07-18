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

test("v0.59: Krankmeldung und AUM bilden einen mobilen Fall mit Zeitraumskalender", () => {
  const html = fs.readFileSync(path.join(projectRoot, "public", "portal.html"), "utf8");
  const css = fs.readFileSync(path.join(projectRoot, "public", "portal.css"), "utf8");

  assert.match(html, /class="sickness-hub-heading"[\s\S]*?<svg[\s\S]*?Krankmeldung &amp; AUM/);
  assert.match(html, /id="sicknessDateRangeButton"[\s\S]*?id="amuDateRangeButton"/);
  assert.match(html, /id="dateRangeCalendarGrid"/);
  assert.match(html, /id="amuIncapacityTo" type="hidden"/);
  assert.doesNotMatch(html, /id="amuIncapacityTo"[^>]*required/);
  assert.match(html, /id="sicknessRecoveryDialog"[\s\S]*?Wieder arbeitsfähig ab/);
  assert.match(css, /\.sickness-case-actions button[\s\S]*?min-height:38px/);
  assert.match(css, /@media \(max-width:430px\)/);
});

test("v0.59: lokale Datenerkennung verarbeitet gespeicherte Fotos und PDFs vor dem Upload", () => {
  const html = fs.readFileSync(path.join(projectRoot, "public", "portal.html"), "utf8");
  const source = fs.readFileSync(path.join(projectRoot, "public", "portal.js"), "utf8");

  assert.match(html, /id="amuDocuments"[^>]*accept="application\/pdf,image\/jpeg/);
  assert.match(html, /src="\/amu-pdf-client\.js"/);
  assert.match(source, /async function recognizeAmuFiles\(files, contextName = "amu"\)/);
  assert.match(source, /isPdfFile\(file\)[\s\S]*?ensureAmuPdfClient\(\)\.recognize/);
  assert.match(source, /for \(const contextName of \["amu", "sickness"\]\)/);
  assert.doesNotMatch(source, /async function recognizeAmuImage/);
});

test("AUM Block 3: Krankmeldung kann ein Dokument direkt mit denselben Uploadregeln senden", () => {
  const html = fs.readFileSync(path.join(projectRoot, "public", "portal.html"), "utf8");
  const source = fs.readFileSync(path.join(projectRoot, "public", "portal.js"), "utf8");

  assert.match(html, /id="sicknessAmuPanel"[\s\S]*?AUM direkt mitsenden/);
  assert.match(html, /id="sicknessAmuDocuments"[^>]*data-amu-context="sickness"/);
  assert.match(html, /id="sicknessAmuCamera"[^>]*capture="environment"/);
  assert.match(source, /async function uploadAmuForContext/);
  assert.match(source, /uploadAmuForContext\("sickness"/);
  assert.match(source, /body\.append\("directSicknessReport", "1"\)/);
  assert.match(source, /selectedAmuFiles\("sickness"\)/);
});

test("AUM Block 4: PL-Regel, persönliche Freigabe und Soll-Arbeitstage sind bedienbar", () => {
  const adminHtml = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const adminSource = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");

  assert.match(adminHtml, /id="sicknessAumAllowanceEnabled"/);
  assert.match(adminHtml, /id="sicknessAumAllowanceMaxCases"[^>]*max="20"/);
  assert.match(adminHtml, /id="sicknessAumAllowanceMaxDays"[^>]*max="3"/);
  assert.match(adminHtml, /id="employeeTargetWorkdays"[^>]*min="1"[^>]*max="6"/);
  assert.match(adminHtml, /id="employeeSicknessWithoutAumEnabled"/);
  assert.match(adminSource, /aumAllowance:\s*\{[\s\S]*?maxCasesPerYear:[\s\S]*?maxCalendarDaysPerCase:/);
  assert.match(adminSource, /function syncEmployeeSicknessAllowanceField/);
  assert.match(adminSource, /targetWorkdaysPerWeek: Number\(elements\.employeeTargetWorkdays\.value\)/);
});

test("AUM Block 4: Mitarbeiterportal zeigt Kontingent und gespeicherte Krankenstandszeit", () => {
  const portalHtml = fs.readFileSync(path.join(projectRoot, "public", "portal.html"), "utf8");
  const portalSource = fs.readFileSync(path.join(projectRoot, "public", "portal.js"), "utf8");

  assert.match(portalHtml, /id="sicknessAumAllowance"/);
  assert.match(portalSource, /Ohne AUM möglich · noch \$\{allowance\.remainingCases\}/);
  assert.match(portalSource, /AUM laut aktueller Unternehmensregel erforderlich/);
  assert.match(portalSource, /Angerechnete Krankenstandszeit:/);
  assert.match(portalSource, /item\.aum_allowance\?\.required === false/);
});

test("Portal: Rückkehr von der Handy-Kamera hält den AUM-Bereich aktiv", () => {
  const source = fs.readFileSync(path.join(projectRoot, "public", "portal.js"), "utf8");
  const selectionBlock = source.match(/function handleAmuFileSelection\(event\) \{[\s\S]+?\n\}/);

  assert.match(source, /const portalTabStorageKey = "grabenplaner\.portal\.active-tab"/);
  assert.match(source, /function requestedPortalTab\(\) \{[\s\S]*?storedPortalTab\(\)/);
  assert.match(source, /function rememberPortalTab\(tab\) \{[\s\S]*?history\.replaceState/);
  assert.match(source, /portalState\.activeTab = tab;\s+rememberPortalTab\(tab\);/);
  assert.ok(selectionBlock, "Dateiauswahl-Behandlung fehlt");
  assert.match(selectionBlock[0], /portalState\.activeTab !== "amu"\) setTab\("amu"\)/);
});

test("Portal: mobiles Scroll-Resize lässt AUM als Unterbereich von Mehr geöffnet", () => {
  const source = fs.readFileSync(path.join(projectRoot, "public", "portal.js"), "utf8");

  assert.match(source, /const mobileMoreSecondaryTabs = new Set\(\["timeOff", "vacation", "amu", "settings"\]\)/);
  assert.match(source, /const secondaryViaMore = modules\.includes\("more"\) && mobileMoreSecondaryTabs\.has\(portalState\.activeTab\)/);
  assert.match(source, /activeButton\?\.classList\.contains\("hidden"\) && modules\.length && !secondaryViaMore/);
  assert.match(source, /representedByMore[\s\S]*?button\.dataset\.tab === "leadershipMore"/);
  assert.match(source, /window\.addEventListener\("resize", applyDeviceMode/);
});

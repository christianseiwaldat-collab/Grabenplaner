"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const portalHtml = fs.readFileSync(path.join(projectRoot, "public", "portal.html"), "utf8");
const portalScript = fs.readFileSync(path.join(projectRoot, "public", "portal.js"), "utf8");
const portalStyles = fs.readFileSync(path.join(projectRoot, "public", "portal.css"), "utf8");
const settingsView = portalHtml.match(
  /<section class="portal-view" id="settingsView"[\s\S]*?(?=<section class="portal-view active" id="scheduleView")/,
)?.[0] || "";
const notificationCard = settingsView.match(
  /<details[^>]+id="emailSettingsCard"[\s\S]*?(?=<details class="portal-card portal-settings-section portal-settings-password")/,
)?.[0] || "";
const notificationScript = portalScript.match(
  /const personalNotificationChannels[\s\S]*?(?=async function loadAmuSettings)/,
)?.[0] || "";

test("persönliche Benachrichtigungseinstellungen sind für echte Mitarbeiterkonten geschlossen verfügbar", () => {
  const cardTag = settingsView.match(/<details[^>]+id="emailSettingsCard"[^>]*>/)?.[0] || "";
  assert.match(cardTag, /class="[^"]*portal-settings-section[^"]*email-settings-card[^"]*"/);
  assert.doesNotMatch(cardTag, /\bhidden\b|\sopen(?:\s|=|>)/);
  assert.match(notificationCard, /Externe Benachrichtigungen/);
  assert.match(notificationCard, /Meine Zustellziele/);
  assert.match(notificationCard, /Kanäle auswählen/);
  assert.match(notificationCard, /Schlafmodus/);

  const emailCard = settingsView.indexOf('id="emailSettingsCard"');
  const passwordCard = settingsView.indexOf("portal-settings-password");
  assert.ok(emailCard >= 0 && emailCard < passwordCard);
  assert.equal(
    settingsView.lastIndexOf("<details"),
    settingsView.lastIndexOf('<details class="portal-card portal-settings-section portal-settings-password"'),
  );

  assert.match(portalScript, /if \(personalEmailSettingsAvailable\(\)\) loadEmailSettings\(\);/);
  assert.doesNotMatch(portalScript, /if \(hasPortalPermission\([^)]*\)\)\s*loadEmailSettings\(\)/);
});

test("Organisations- und Terminalkonten sehen und laden keine persönlichen Benachrichtigungseinstellungen", () => {
  assert.match(
    portalScript,
    /function isOrganizationAccount\(user = portalUser\(\)\) \{[\s\S]*?\["branch", "terminal"\]\.includes\(user\?\.accountType\)/,
  );
  assert.match(
    portalScript,
    /function personalEmailSettingsAvailable\(user = portalUser\(\)\) \{[\s\S]*?user\?\.isEmployee === true && !isOrganizationAccount\(user\)/,
  );
  assert.match(
    portalScript,
    /emailSettingsCard\?\.classList\.toggle\("hidden", !personalEmailSettingsAvailable\(\)\)/,
  );
  assert.match(
    portalScript,
    /async function loadEmailSettings\([^)]*\) \{\s*if \(!personalEmailSettingsAvailable\(\)\) return;/,
  );
  assert.match(portalScript, /emailSettingsCard\.open && personalEmailSettingsAvailable\(\)/);
});

test("mobile Zustellziele sind ausschließlich maskierte, nicht editierbare Stammdatenwerte", () => {
  assert.match(notificationCard, /E-Mail und Telefon stammen ausschließlich aus deinen geschützten Personalstammdaten/);
  assert.match(notificationCard, /Hier sind keine Kontaktdaten editierbar/);
  assert.match(notificationCard, /id="notificationTargetList"/);
  assert.doesNotMatch(notificationCard, /type="(?:email|tel)"|id="emailAddressInput"|data-channel-destination/);
  assert.doesNotMatch(notificationCard, /Adresse (?:hinterlegen|ändern)/);

  assert.match(notificationScript, /function notificationTargetMasked\(target\) \{\s*return String\(target\?\.masked \|\| ""\)\.trim\(\);/);
  assert.match(notificationScript, /const masked = notificationTargetMasked\(target\);/);
  assert.doesNotMatch(notificationScript, /target\?\.(?:value|email|phone|destination)|preference\.destination/);
  for (const endpoint of [
    "/api/portal/v1/me/email-settings/address",
    "/api/portal/v1/me/sickness-notification-preferences",
  ]) {
    assert.equal(portalScript.includes(endpoint), false, endpoint);
  }
});

test("alle echten Mitarbeiterkonten können vorhandene Kanäle vormerken, Versandbereitschaft bleibt getrennt", () => {
  assert.match(notificationScript, /Object\.freeze\(\["email", "sms", "whatsapp"\]\)/);
  assert.match(
    notificationScript,
    /const selectable = raw\.selectable === true \|\| \(raw\.selectable !== false && Boolean\(masked\)\);/,
  );
  assert.match(
    notificationScript,
    /const deliveryReady = selectable\s*&& targetState === "verified"\s*&& raw\.verificationRequired !== true\s*&& \(raw\.deliveryReady === true \|\| raw\.available === true\);/,
  );
  assert.match(notificationScript, /data-notification-channel-enabled[\s\S]*?disabled/);
  assert.match(notificationScript, /preference\.selectable \? "" : "disabled"/);
  assert.match(notificationScript, /!preference\.enabled[\s\S]*?Auswahl möglich/);
  assert.match(notificationScript, /Ausgewählt · Ziel noch nicht bestätigt/);
  assert.match(notificationScript, /Ausgewählt · Versand noch nicht verfügbar/);
  assert.match(
    notificationScript,
    /async function saveNotificationPreferences\(event\) \{[\s\S]*?if \(!personalEmailSettingsAvailable\(\)\) return;/,
  );
  assert.match(notificationScript, /const body = \{ channels \};/);
  assert.match(
    notificationScript,
    /api\("\/api\/portal\/v1\/me\/email-settings\/categories", \{\s*method: "PUT",\s*body: JSON\.stringify\(body\)/,
  );
  assert.doesNotMatch(
    notificationScript.match(/async function saveNotificationPreferences[\s\S]*?\n\}/)?.[0] || "",
    /destination|address|phone|email\s*:/,
  );
});

test("Bestätigung bleibt kanalbezogen und sendet niemals das maskierte Stammdatenziel", () => {
  assert.match(notificationScript, /notificationVerificationChannels[\s\S]*?\["email"\][\s\S]*?\["sms", "whatsapp"\]/);
  assert.match(
    notificationScript,
    /raw\?\.verificationRequired === true && raw\?\.verificationAvailable === true/,
  );
  assert.match(notificationScript, /Die Bestätigung ist derzeit technisch nicht verfügbar/);
  assert.match(notificationScript, /data-notification-verification-request/);
  assert.match(notificationScript, /data-notification-verification-confirm/);
  assert.match(
    notificationScript,
    /api\("\/api\/portal\/v1\/me\/email-settings\/verification", \{\s*method: "POST",\s*body: JSON\.stringify\(\{ channel \}\)/,
  );
  assert.match(
    notificationScript,
    /api\("\/api\/portal\/v1\/me\/email-settings\/verification\/confirm", \{\s*method: "POST",\s*body: JSON\.stringify\(\{ channel, code \}\)/,
  );
  for (const functionName of ["requestNotificationVerification", "confirmNotificationVerification"]) {
    const source = notificationScript.match(new RegExp(`async function ${functionName}[\\s\\S]*?\\n\\}`))?.[0] || "";
    assert.doesNotMatch(source, /destination|masked|target\s*:/);
  }
});

test("Schlafmodus nutzt die kanonische Berechtigungsgrenze und bleibt darunter read-only", () => {
  assert.match(notificationCard, /id="notificationEarliestTime"[^>]*disabled/);
  assert.match(notificationCard, /Zentral vorgegeben · nur lesbar/);
  assert.match(
    notificationScript,
    /function notificationQuietHoursEditable[\s\S]*?hasPortalPermission\("notifications:settings"\) && data\?\.quietHours\?\.editable === true;/,
  );
  assert.match(
    notificationScript,
    /const quietHoursEditable = notificationQuietHoursEditable\(\);\s*if \(quietHoursEditable\) body\.earliestTime = el\.notificationEarliestTime\.value;/,
  );
  const permissionGate = notificationScript.match(
    /function notificationQuietHoursEditable[\s\S]*?\n\}/,
  )?.[0] || "";
  assert.doesNotMatch(permissionGate, /employee|manager|department_manager|admin|developer|role/);
});

test("Fachereignisse benennen Einsatzanfragen als erste zentrale Versandart und bleiben mobil einspaltig", () => {
  assert.match(notificationCard, /Einsatzanfragen können bei ausgewähltem, bestätigtem E-Mail-Kanal automatisch versendet werden/);
  assert.match(notificationScript, /<span>Noch nicht aktiviert<\/span>/);
  assert.doesNotMatch(
    notificationCard.match(/<div class="email-category-list"[\s\S]*?<\/section>/)?.[0] || "",
    /type="checkbox"/,
  );
  assert.match(portalStyles, /\.email-settings-layout \{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(portalStyles, /@media \(max-width:760px\) \{ \.email-settings-layout \{ grid-template-columns:1fr; \}/);
});

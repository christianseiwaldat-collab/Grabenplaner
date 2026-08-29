"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");
const adminHtml = read("public/index.html");
const adminScript = read("public/app.js");
const portalHtml = read("public/portal.html");
const portalScript = read("public/portal.js");
const boundaries = read("public/credential-boundaries.js");

test("Arbeitsformulare werden zentral von echten Kontoformularen abgegrenzt", () => {
  assert.ok(adminHtml.indexOf('<script src="/credential-boundaries.js"></script>') < adminHtml.indexOf('<script src="/app.js"></script>'));
  assert.ok(portalHtml.indexOf('<script src="/credential-boundaries.js"></script>') < portalHtml.indexOf('<script src="/portal.js"></script>'));
  assert.match(boundaries, /ACCOUNT_CREDENTIAL_FORM_IDS = new Set\(\[[\s\S]*?"adminLoginForm"[\s\S]*?"portalLoginForm"[\s\S]*?"passwordResetConfirmForm"[\s\S]*?"passwordForm"[\s\S]*?"adminSetupForm"/);
  assert.match(boundaries, /function hardenOperationalForm\(form\)[\s\S]*?if \(!passwordInputs\.length && form\.dataset\.gpNoncredentialForm !== "true"\) return;[\s\S]*?form\.setAttribute\("autocomplete", "off"\)/);
  assert.match(boundaries, /input\.setAttribute\("data-1p-ignore", "true"\)/);
  assert.match(boundaries, /input\.setAttribute\("data-lpignore", "true"\)/);
  assert.doesNotMatch(boundaries, /querySelectorAll\("input, textarea"\)/);
  assert.match(boundaries, /new MutationObserver\([\s\S]*?attributeFilter: \["open", "class", "hidden", "aria-hidden", "style"\][\s\S]*?subtree: true/);
});

test("Operative Passwortfelder werden nicht automatisch befüllt und nach Interaktion erneut gesperrt", () => {
  assert.match(boundaries, /function markOperationalPassword\(input\)[\s\S]*?firstHardening[\s\S]*?autocomplete", "off"[\s\S]*?data-gp-password-manager-ignore[\s\S]*?if \(firstHardening\) input\.readOnly = true/);
  assert.match(boundaries, /OPERATIONAL_PASSWORD_SELECTOR = 'input\[data-gp-password-manager-ignore="true"\]'/);
  assert.match(boundaries, /function disableManaged\(input[\s\S]*?input\.value = ""[\s\S]*?resetPasswordVisibility\(input\)[\s\S]*?input\.disabled = true/);
  assert.match(boundaries, /function disableManaged\(input[\s\S]*?input\.defaultValue = ""[\s\S]*?input\.removeAttribute\("value"\)/);
  assert.match(boundaries, /function reconcilePassword\(input\)[\s\S]*?surfaceIsActive\(input\)[\s\S]*?enableManaged\(input\)[\s\S]*?disableManaged\(input,/);
  assert.match(boundaries, /enableManaged\(input\);[\s\S]*?if \(accountForm\) input\.readOnly = false/);
  assert.match(boundaries, /APPLICATION_DISABLED_ATTRIBUTE = "data-gp-credential-app-disabled"/);
  assert.match(boundaries, /function enableManaged\(input\)[\s\S]*?APPLICATION_DISABLED_ATTRIBUTE\) !== "true"[\s\S]*?input\.disabled = false/);
  assert.match(boundaries, /function setApplicationDisabled\(input, disabled\)[\s\S]*?APPLICATION_DISABLED_ATTRIBUTE[\s\S]*?surfaceIsActive\(input\)[\s\S]*?disableManaged\(input, \{ clear: false \}\)/);
  assert.match(boundaries, /function shouldPreserveWhilePanelHidden\(input\)[\s\S]*?surfaceIsActive\(panel\.parentElement\)/);
  assert.match(boundaries, /disableManaged\(input, \{ clear: !shouldPreserveWhilePanelHidden\(input\) \}\)/);
  assert.match(boundaries, /document\.addEventListener\("focusout"[\s\S]*?queueMicrotask\(\(\) => \{ input\.readOnly = true; \}\)/);
  assert.match(boundaries, /document\.addEventListener\("submit"[\s\S]*?input\.readOnly = true/);
  assert.match(boundaries, /document\.addEventListener\("keydown", \(event\) => \{\s*unlockOperationalPassword\(event\.target\);[\s\S]*?event\.key !== "Enter"/);
  assert.match(boundaries, /document\.addEventListener\("reset"[\s\S]*?inputs\.forEach\(\(input\) => \{[\s\S]*?input\.value = ""[\s\S]*?resetPasswordVisibility\(input\)[\s\S]*?reconcilePassword\(input\)/);
});

test("Der gezeigte Positionsdialog liefert Chrome keine Anmeldeheuristik", () => {
  assert.match(adminHtml, /<form id="positionForm" class="position-form" autocomplete="off" data-gp-noncredential-form="true">/);
  assert.match(adminHtml, /id="positionName" name="position"[^>]*autocomplete="off"[^>]*data-1p-ignore="true"[^>]*data-lpignore="true"/);
});

test("Verdeckte Loginfelder sind leer und deaktiviert, sichtbare Loginfelder bleiben semantisch korrekt", () => {
  assert.match(adminHtml, /id="adminLoginPersonnelNumber" name="username" autocomplete="username" required disabled/);
  assert.match(adminHtml, /id="adminLoginPassword" name="password" type="password" autocomplete="current-password" required disabled/);
  assert.match(adminScript, /function showLoginGate\([\s\S]*?adminLoginPersonnelNumber\.disabled = false[\s\S]*?adminLoginPassword\.disabled = false/);
  assert.match(adminScript, /function closeAdminCredentialDialogsForLogin\(\)[\s\S]*?dialog\[open\][\s\S]*?data-gp-credential-field[\s\S]*?dialog\.close\(\)/);
  assert.match(adminScript, /function showLoginGate\([\s\S]*?portal-locked[\s\S]*?closeAdminCredentialDialogsForLogin\(\)[\s\S]*?reconcileAll\(\)/);
  assert.match(boundaries, /function surfaceIsActive\(input\)[\s\S]*?portal-locked[\s\S]*?adminLoginForm/);
  assert.match(adminScript, /function hideLoginGate\(\)[\s\S]*?adminLoginPassword\.value = ""[\s\S]*?adminLoginPersonnelNumber\.disabled = true[\s\S]*?adminLoginPassword\.disabled = true/);
  assert.match(portalHtml, /id="loginPersonnelNumber" name="username" autocomplete="username"[^>]*required disabled/);
  assert.match(portalHtml, /id="loginPassword" name="password" type="password" autocomplete="current-password"[^>]*required disabled/);
  assert.match(portalScript, /function showLogin\([\s\S]*?setPortalLoginControlsEnabled\(false\)[\s\S]*?setPortalLoginControlsEnabled\(true\)/);
  assert.match(portalScript, /function showPortal\([\s\S]*?setPortalLoginControlsEnabled\(false\)/);
  assert.match(portalScript, /function setPortalLoginControlsEnabled\(enabled\)[\s\S]*?loginPassword\.value = ""[\s\S]*?resetCredentialVisibility\(el\.loginPassword\)/);
  assert.match(portalScript, /if \(enabled\) el\.loginPassword\.readOnly = false/);
});

test("Passwortänderung und Reset besitzen einen eigenen Benutzernamen- und Aktiv-Lebenszyklus", () => {
  assert.doesNotMatch(portalHtml, /id="passwordResetUsername"/);
  assert.doesNotMatch(portalScript, /loginPersonnelNumber\?\.value/);
  assert.match(portalHtml, /id="passwordChangeUsername" name="username" autocomplete="username" readonly disabled/);
  assert.match(portalHtml, /id="currentPassword" name="current-password" type="password" autocomplete="current-password"[^>]*disabled/);
  assert.match(portalHtml, /id="newPassword" name="new-password" type="password"[^>]*autocomplete="new-password"[^>]*disabled/);
  assert.match(portalScript, /function openPasswordResetConfirm\([\s\S]*?showModal\(\)[\s\S]*?setPasswordResetConfirmControlsEnabled\(true\)/);
  assert.match(portalScript, /function closePasswordResetConfirm\([\s\S]*?setPasswordResetConfirmControlsEnabled\(false\)/);
  assert.match(portalScript, /function openPasswordChangeDialog\([\s\S]*?showModal\(\)[\s\S]*?setPasswordChangeControlsEnabled\(true\)/);
  assert.match(portalScript, /function closePasswordChangeDialog\([\s\S]*?setPasswordChangeControlsEnabled\(false\)/);
  assert.match(portalScript, /function neutralizeCredentialDialogsForLogin\(\)[\s\S]*?closePasswordChangeDialog\(\{ force: true \}\)[\s\S]*?passwordResetConfirmDialog\?\.open[\s\S]*?closePasswordResetConfirm\(\)[\s\S]*?setPasswordResetConfirmControlsEnabled\(false\)[\s\S]*?passwordResetRequestDialog\?\.open[\s\S]*?passwordResetRequestDialog\.close\(\)/);
  assert.match(portalScript, /function showLogin\([\s\S]*?neutralizeCredentialDialogsForLogin\(\)/);
  assert.match(portalScript, /passwordDialog\?\.addEventListener\("cancel", \(event\) => \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?closePasswordChangeDialog\(\)/);
  assert.match(portalScript, /function resetCredentialVisibility\(input\)[\s\S]*?resetPasswordVisibility\(input\)/);
});

test("Admin-Ersteinrichtung bleibt ein echtes Kontoformular mit sauberer Passwortsemantik", () => {
  assert.match(adminHtml, /id="adminSetupEmployee" name="username" autocomplete="username" required/);
  assert.match(adminHtml, /id="adminSetupPassword" name="new-password" type="password"[^>]*autocomplete="new-password"/);
  assert.match(adminHtml, /id="adminSetupPasswordRepeat" name="new-password-repeat" type="password"[^>]*autocomplete="new-password"/);
});

test("Alle statischen und dynamischen Passwortoberflächen fallen unter den zentralen Lebenszyklus", () => {
  const staticPasswordInputs = [...adminHtml.matchAll(/<input\b[^>]*type="password"[^>]*>/g)];
  const portalPasswordInputs = [...portalHtml.matchAll(/<input\b[^>]*type="password"[^>]*>/g)];
  const dynamicPasswordInputs = [...adminScript.matchAll(/<input\b[^>`]*type="password"[^>`]*>/g)];
  assert.equal(staticPasswordInputs.length, 16);
  assert.equal(portalPasswordInputs.length, 6);
  assert.equal(dynamicPasswordInputs.length, 3);
  assert.match(boundaries, /function hardenRoot\(root\)[\s\S]*?input\[type="password"\][\s\S]*?forEach\(reconcilePassword\)/);
  assert.match(boundaries, /function surfaceIsActive\(input\)[\s\S]*?dialog && !dialog\.open[\s\S]*?\[hidden\], \.hidden[\s\S]*?getClientRects\(\)\.length === 0/);
  for (const inputName of ["databaseDownloadCurrentPassword", "vpsRebootCurrentPassword", "offsiteCreateCurrentPassword", "offsiteActivateCurrentPassword"]) {
    assert.match(adminScript, new RegExp(`setAdminCredentialDisabled\\(\\s*elements\\.${inputName}`));
  }
  assert.match(adminHtml, /data-usb-wizard-panel="team" data-gp-credential-preserve-on-hide="true"/);
  assert.match(adminScript, /data-usb-start-password[^>]*disabled data-gp-credential-app-disabled="true"/);
  assert.match(adminScript, /function setUsbWizardStep\(step\)[\s\S]*?GrabenplanerCredentialBoundaries\?\.reconcileAll\(\)/);
  assert.match(adminScript, /async function createUsbStick\(\)[\s\S]*?const ready = Boolean\([\s\S]*?usbCreatorPassword\.value[\s\S]*?selectedUsbLocationIds\(\)\.length[\s\S]*?usbFormatConfirmation\.value\.trim\(\) === expectedConfirmation[\s\S]*?if \(!ready\)/);
  assert.match(adminScript, /function clearUsbProvisioningPasswords\(\)[\s\S]*?usbCreatorPassword[\s\S]*?usbDraftPassword[\s\S]*?data-usb-start-password[\s\S]*?override\.startPassword = ""[\s\S]*?draft\.startPassword = ""/);
  assert.doesNotMatch(adminScript, /data-usb-start-password[^>]*value="\$\{/);
  assert.match(adminScript, /usbEmployeeSelection\.querySelectorAll\("\[data-usb-employee\]"\)[\s\S]*?input\.value = override\?\.startPassword \?\? draft\?\.startPassword \?\? ""[\s\S]*?input\.removeAttribute\("value"\)/);
  assert.match(adminScript, /function setView\(view\)[\s\S]*?state\.currentView === "settings" && view !== "settings"[\s\S]*?clearUsbProvisioningPasswords\(\)/);
  assert.match(adminScript, /function setSettingsTab\(tab\)[\s\S]*?backupSettings\.classList\.contains\("active"\) && activeTab !== "backup"[\s\S]*?clearUsbProvisioningPasswords\(\)/);
});

test("Jedes statische Passwortfeld deklariert seinen Browserzweck", () => {
  for (const [file, source] of [["index.html", adminHtml], ["portal.html", portalHtml]]) {
    const passwordInputs = source.match(/<input\b[^>]*type="password"[^>]*>/g) || [];
    assert.ok(passwordInputs.length > 0, `${file}: keine Passwortfelder gefunden`);
    passwordInputs.forEach((input) => {
      assert.match(input, /autocomplete="(?:current-password|new-password)"/, `${file}: Autocomplete-Zweck fehlt in ${input}`);
    });
  }
});

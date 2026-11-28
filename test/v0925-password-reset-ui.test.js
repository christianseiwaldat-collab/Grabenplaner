"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const portalHtml = fs.readFileSync(path.join(__dirname, "..", "public", "portal.html"), "utf8");
const portalScript = fs.readFileSync(path.join(__dirname, "..", "public", "portal.js"), "utf8");
const administrationHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("v0.92.5: Login bietet einen zugänglichen Passwort-Reset ohne Kontoauskunft", () => {
  assert.match(portalHtml, /id="forgotPasswordButton"[^>]*>Passwort zurücksetzen</);
  assert.match(portalHtml, /id="passwordResetRequestDialog"[\s\S]*?id="passwordResetEmail"[\s\S]*?type="email"/);
  assert.match(portalHtml, /Aus Datenschutzgr[^<]+ist die R[^<]+ckmeldung immer gleich/);
  assert.match(portalScript, /\/api\/portal\/v1\/auth\/password-reset\/request/);
  assert.match(portalScript, /Falls ein passender pers[^"\r\n]+Zugang vorhanden ist, wurde ein R[^"\r\n]+cksetzlink versendet/);
});

test("Filialkonto kann den Link an die hinterlegte Adresse anfordern", () => {
  assert.match(portalHtml, /id="passwordResetBranchLogin"/);
  assert.match(portalHtml, /an die für dieses Filialkonto hinterlegte E-Mail-Adresse gesendet/);
  assert.match(portalScript, /branchLoginName: el\.passwordResetBranchLogin\.value\.trim\(\)/);
  assert.match(administrationHtml, /href="\/portal\.html#passwort-zuruecksetzen">Passwort zurücksetzen/);
  assert.match(portalScript, /function openPasswordResetFromLocation\(\)[\s\S]*?openPasswordResetRequest\(\)/);
});

test("v0.92.5: Reset-Link bleibt im Fragment und verlangt Passwortwiederholung", () => {
  assert.match(portalScript, /window\.location\.hash[\s\S]*?\^#password-reset=\(\[A-Za-z0-9_-\]\{43\}\)\$/);
  assert.match(portalHtml, /id="passwordResetNewPassword"[\s\S]*?autocomplete="new-password"/);
  assert.match(portalHtml, /id="passwordResetRepeatPassword"[\s\S]*?autocomplete="new-password"/);
  assert.match(portalScript, /newPassword !== repeatPassword/);
  assert.match(portalScript, /\/api\/portal\/v1\/auth\/password-reset\/confirm/);
  assert.match(portalScript, /clearPasswordResetHash\(\)[\s\S]*?showLogin\(\)/);
  assert.match(portalScript, /function closePasswordResetConfirm\(\)[\s\S]*?clearPasswordResetHash\(\)[\s\S]*?passwordResetToken\.value = ""/);
});

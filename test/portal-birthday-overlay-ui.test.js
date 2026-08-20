"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const html = read("public/portal.html");
const script = read("public/portal.js");
const css = read("public/portal.css");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `Startmarke fehlt: ${start}`);
  assert.ok(to > from, `Endmarke fehlt: ${end}`);
  return source.slice(from, to);
}

test("Block 10: Portal enthält genau den neutralen barrierearmen Geburtstagsdialog", () => {
  const dialog = between(
    html,
    '<dialog class="birthday-presentation-dialog"',
    '<dialog class="portal-learning-progress-dialog"',
  );
  assert.match(dialog, /id="birthdayPresentationDialog" aria-labelledby="birthdayPresentationTitle" aria-describedby="birthdayPresentationText"/);
  assert.match(dialog, /id="birthdayPresentationGraphic" alt="" aria-hidden="true"/);
  assert.match(dialog, /id="birthdayPresentationTitle">Alles Gute zum Geburtstag!<\/h2>/);
  assert.match(dialog, /id="birthdayPresentationClose"[^>]+aria-label="Geburtstagsgruß schließen"/);
  assert.match(dialog, /id="birthdayPresentationConfirm"[^>]*>Schließen<\/button>/);
  assert.doesNotMatch(dialog, /Geburtsdatum|Geburtsjahr|Alter|\bDatum\b|\bJahr\b/i);
});

test("Block 10: Claim nutzt POST und den zentralen CSRF-API-Helfer erst nach persönlicher Initialisierung", () => {
  const implementation = between(script, "const birthdayPresentationPaths", "function message(");
  assert.match(implementation, /api\("\/api\/portal\/v1\/me\/birthday-presentation\/claim", \{\s*method: "POST",\s*body: "\{\}"/);
  assert.match(script, /if \(token && !\["GET", "HEAD"\][\s\S]*headers\["X-CSRF-Token"\] = token/);
  assert.equal((script.match(/await loadPortalData\(\);\s*await refreshBirthdayPresentationTheme\(\);\s*await claimBirthdayPresentation\(\);/g) || []).length, 3);
  assert.match(script, /function changePassword\([\s\S]*?await loadPortalData\(\);\s*await refreshBirthdayPresentationTheme\(\);\s*await claimBirthdayPresentation\(\);/);
  assert.match(implementation, /user\.isEmployee !== true \|\| isOrganizationAccount\(user\)/);
  assert.doesNotMatch(implementation, /localStorage|sessionStorage/);
});

test("Block 10: nur die fünf festen ID-Pfad-Paare dürfen angezeigt werden", () => {
  const implementation = between(script, "const birthdayPresentationPaths", "function message(");
  const expected = {
    elegant: "elegant",
    farbenfroh: "farbenfroh",
    fotowelt: "fotowelt",
    technik: "technik",
    standard: "dezent",
  };
  for (const [id, asset] of Object.entries(expected)) {
    assert.match(implementation, new RegExp(`${id}: "\\/assets\\/birthday-presentations\\/${asset}\\.svg"`));
  }
  assert.match(implementation, /Object\.hasOwn\(birthdayPresentationPaths, id\)/);
  assert.match(implementation, /birthdayPresentationPaths\[id\] !== previewUrl/);
  assert.match(implementation, /!result\?\.presentation \|\| typeof result\.presentation !== "object"/);
  assert.doesNotMatch(implementation, /innerHTML|insertAdjacentHTML|createObjectURL|data:image|https?:\/\//i);
});

test("Block 10: Fokus, Escape, Logout, Actorwechsel und Fehler neutralisieren die UI", () => {
  const implementation = between(script, "const birthdayPresentationPaths", "function message(");
  assert.match(implementation, /birthdayPresentationReturnFocus = document\.activeElement instanceof HTMLElement/);
  assert.match(implementation, /requestAnimationFrame\(\(\) => \{[\s\S]*generation === portalState\.birthdayPresentationClaimGeneration[\s\S]*birthdayPresentationDialog\?\.open[\s\S]*birthdayPresentationConfirm\?\.focus\(\)/);
  assert.match(implementation, /returnFocus\?\.isConnected[\s\S]*returnFocus\.focus\(\)/);
  assert.match(script, /birthdayPresentationDialog\?\.addEventListener\("cancel", \(event\) => \{\s*event\.preventDefault\(\);\s*closeBirthdayPresentation\(\)/);
  assert.match(script, /function showLogin\([^)]*\) \{[\s\S]{0,350}neutralizeBirthdayPresentation\(\)/);
  assert.match(script, /if \(birthdayPresentationActor\(\) !== birthdayPresentationActor\(session\?\.user\)\) \{\s*neutralizeBirthdayPresentation\(\)/);
  assert.match(implementation, /catch \{\s*if \(generation === portalState\.birthdayPresentationClaimGeneration\) neutralizeBirthdayPresentation\(\)/);
  assert.match(script, /birthdayPresentationGraphic\?\.addEventListener\("error", \(\) => neutralizeBirthdayPresentation\(\)\)/);
  assert.match(implementation, /birthdayPresentationGraphic\.removeAttribute\("src"\)/);
});

test("Block 10: Einblendung selbst bleibt mobil, kontrastfähig und bewegungsarm", () => {
  assert.match(css, /\.birthday-presentation-dialog \{[^}]*width:min\(560px,calc\(100% - 24px\)\)/);
  assert.match(css, /@media \(max-width:360px\) \{[\s\S]*\.birthday-presentation-dialog \{[^}]*width:calc\(100% - 12px\)/);
  assert.match(css, /@media \(prefers-color-scheme:dark\) \{[\s\S]*\.birthday-presentation-dialog/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\) \{[\s\S]*\.birthday-presentation-dialog\[open\][^}]*animation:none/);
  assert.match(css, /\.birthday-presentation-panel \{[^}]*max-height:min\(90dvh,820px\)[^}]*overflow-y:auto/);
  assert.match(css, /\.birthday-presentation-close:focus-visible,[^\{]+\{ outline:3px solid #0b5f43/);
  assert.match(css, /\.birthday-presentation-copy \.eyebrow \{ color:#1d5944; \}/);
  assert.match(css, /@media \(prefers-color-scheme:dark\) \{[\s\S]*\.birthday-presentation-copy \.eyebrow \{ color:#b7f0d7; \}/);
  const birthdayCss = css.match(/\.birthday-presentation-dialog[\s\S]*?(?=\.history-card)/)?.[0] || "";
  assert.doesNotMatch(birthdayCss, /\.portal-(?:header|tabs|view|card)|\bbody\s*\{|\bhtml\s*\{|--green|--bg/);
});

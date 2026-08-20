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

function colorFromTheme(id, variable) {
  const selector = `html[data-portal-birthday-theme="${id}"]`;
  const blockStart = css.indexOf(`${selector} {`);
  assert.ok(blockStart >= 0, `Themeblock fehlt: ${id}`);
  const blockEnd = css.indexOf("\n}", blockStart);
  const block = css.slice(blockStart, blockEnd);
  const match = block.match(new RegExp(`${variable}:(#[0-9a-f]{6})`, "i"));
  assert.ok(match, `${variable} fehlt für ${id}`);
  return match[1];
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4));
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(first, second) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)]
    .sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

test("Block 11: Theme-Vertrag akzeptiert nur fünf feste IDs und genau ein Root-Dataset", () => {
  const implementation = between(script, "const birthdayPresentationThemeIds", "function message(");
  for (const id of ["standard", "elegant", "farbenfroh", "fotowelt", "technik"]) {
    assert.match(implementation, new RegExp(`\\b${id}: true`));
    assert.match(css, new RegExp(`html\\[data-portal-birthday-theme="${id}"\\]`));
  }
  assert.match(implementation, /api\("\/api\/portal\/v1\/me\/birthday-presentation\/theme", \{\s*signal: controller\.signal/);
  assert.match(implementation, /Object\.hasOwn\(birthdayPresentationThemeIds, id\)/);
  assert.match(implementation, /document\.documentElement\.dataset\.portalBirthdayTheme = id/);
  assert.match(implementation, /delete document\.documentElement\.dataset\.portalBirthdayTheme/);
  assert.doesNotMatch(implementation, /classList|setAttribute\(|innerHTML|insertAdjacentHTML|eval\(|Function\(|https?:\/\//i);
  assert.doesNotMatch(html, /data-portal-birthday-theme/);
});

test("Block 11: Theme-Aktivierung nutzt keine clientseitigen Geburts- oder Datumsdaten", () => {
  const implementation = between(script, "function clearBirthdayPresentationThemeRefreshTimer", "function message(");
  assert.doesNotMatch(implementation, /localStorage|sessionStorage|indexedDB|document\.cookie|birthDate|dateOfBirth|Geburtsdatum|new Date|Date\(|toLocale/i);
  assert.doesNotMatch(implementation, /previewUrl|\.src\s*=|createObjectURL|data:image/i);
  assert.match(implementation, /result && Object\.hasOwn\(result, "theme"\)/);
  assert.match(implementation, /theme && typeof theme === "object" && !Array\.isArray\(theme\)/);
});

test("Block 11: Initialisierung, Pflichtpasswort, Actorwechsel, Login und Logout sind fail-neutral", () => {
  assert.equal((script.match(/await loadPortalData\(\);\s*await refreshBirthdayPresentationTheme\(\);\s*await claimBirthdayPresentation\(\);/g) || []).length, 3);
  assert.match(script, /function changePassword\([\s\S]*?await refreshBirthdayPresentationTheme\(\);\s*await claimBirthdayPresentation\(\);/);
  assert.match(script, /portalState\.session\?\.user\) portalState\.session\.user\.mustChangePassword = false/);
  assert.match(script, /if \(!actor \|\| portalUser\(\)\?\.mustChangePassword === true\) \{\s*neutralizeBirthdayPresentationTheme\(\)/);
  assert.match(script, /function showLogin\([^)]*\) \{[\s\S]{0,450}neutralizeBirthdayPresentationTheme\(\)/);
  assert.match(script, /if \(birthdayPresentationActor\(\) !== birthdayPresentationActor\(session\?\.user\)\) \{\s*neutralizeBirthdayPresentation\(\);\s*neutralizeBirthdayPresentationTheme\(\)/);
  assert.match(script, /async function logout\(\)[\s\S]{0,500}neutralizeBirthdayPresentationTheme\(\)/);
  assert.match(script, /Die Abmeldung konnte nicht bestätigt werden:[\s\S]{0,180}refreshBirthdayPresentationTheme\(\)/);
  assert.match(script, /catch \{[\s\S]*?delete document\.documentElement\.dataset\.portalBirthdayTheme/);
});

test("Block 11: Tageswechsel wird mit einem begrenzten Timer und Sichtbarkeits-Refresh serverseitig nachgezogen", () => {
  const implementation = between(script, "const birthdayPresentationThemeIds", "function message(");
  assert.match(implementation, /BIRTHDAY_PRESENTATION_THEME_REFRESH_MS = 5 \* 60 \* 1000/);
  assert.match(implementation, /birthdayPresentationThemeRefreshTimer = window\.setTimeout/);
  assert.match(implementation, /if \(document\.hidden\) \{\s*scheduleBirthdayPresentationThemeRefresh/);
  assert.match(script, /document\.addEventListener\("visibilitychange"[\s\S]{0,180}refreshBirthdayPresentationTheme\(\)/);
  assert.match(implementation, /birthdayPresentationThemeRefreshPromise/);
  assert.match(implementation, /clearBirthdayPresentationThemeRefreshTimer\(\)/);
  assert.match(implementation, /BIRTHDAY_PRESENTATION_THEME_REQUEST_TIMEOUT_MS = 8000/);
  assert.match(implementation, /const controller = new AbortController\(\)/);
  assert.match(implementation, /\(\) => controller\.abort\(\)/);
  assert.match(implementation, /window\.clearTimeout\(requestTimeout\)/);
  assert.match(implementation, /birthdayPresentationThemeRequestController\?\.abort\(\)/);
  assert.doesNotMatch(implementation, /setInterval/);
});

test("Block 11: alle fünf Themes gestalten Flächen, Navigation, Dialoge und Typografie über Variablen", () => {
  for (const variable of [
    "--birthday-theme-accent",
    "--birthday-theme-accent-strong",
    "--birthday-theme-highlight",
    "--birthday-theme-ink",
    "--birthday-theme-muted",
    "--birthday-theme-line",
    "--birthday-theme-surface",
    "--birthday-theme-input",
    "--birthday-theme-font",
    "--birthday-theme-focus",
  ]) assert.match(css, new RegExp(variable));
  assert.match(css, /html\[data-portal-birthday-theme\] #portalApp \.portal-header/);
  assert.match(css, /html\[data-portal-birthday-theme\] #portalApp :is\(\.portal-card,\.schedule-day/);
  assert.match(css, /html\[data-portal-birthday-theme\] #portalApp :is\(\.portal-tabs,\.leadership-filter-tabs\)/);
  assert.match(css, /html\[data-portal-birthday-theme\] dialog:not\(\.birthday-presentation-dialog\)/);
  assert.match(css, /html\[data-portal-birthday-theme\] #portalApp :is\(h1,h2\)/);
  assert.match(css, /html\[data-portal-birthday-theme\] #portalApp :is\(\.portal-tabs,\.branch-mobile-action-bar\)/);
  assert.match(css, /html\[data-portal-birthday-theme\] #portalApp,[\s\S]*dialog:not\(\.birthday-presentation-dialog\) \{ font-family:var\(--birthday-theme-font\)/);
  for (const surface of [
    ".approval-type label",
    ".traffic-check:not(.green):not(.yellow):not(.red)",
    ".time-summary > div",
    ".correction-entry-row",
    ".leadership-more-grid button",
    ".loan-overview-table",
    ".loan-return-item",
    ".amu-ocr-status:not(.success):not(.warning):not(.error)",
    ".portal-learning-skill-node",
  ]) assert.match(css, new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Block 11: Themes bleiben bei Darkmode, reduzierter Bewegung und 320-Pixel-Ansicht robust", () => {
  assert.match(css, /@media \(prefers-color-scheme:dark\) \{[\s\S]*html\[data-portal-birthday-theme\]/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\) \{[\s\S]*html\[data-portal-birthday-theme\] #portalApp \*/);
  assert.match(css, /animation-duration:\.01ms !important/);
  assert.match(css, /transition-duration:\.01ms !important/);
  assert.match(css, /@media \(max-width:360px\) \{[\s\S]*max-width:calc\(100vw - 8px\)/);
  assert.match(css, /outline:3px solid var\(--birthday-theme-focus\)/);
  assert.match(css, /@media \(forced-colors:active\) \{[\s\S]*background:Highlight;[\s\S]*outline:3px solid Highlight/);
  const themeCss = css.slice(css.indexOf("/* Block 11:"));
  assert.doesNotMatch(themeCss, /outline:3px solid color-mix\([^\n]*transparent/);
  assert.doesNotMatch(themeCss, /animation-name|@keyframes|blink|marquee/i);
});

test("Block 12: alle hellen Geburtstagsthemes erfüllen die statischen Kontrastgrenzen", () => {
  for (const id of ["standard", "elegant", "farbenfroh", "fotowelt", "technik"]) {
    const input = colorFromTheme(id, "--birthday-theme-input");
    assert.ok(
      contrastRatio(colorFromTheme(id, "--birthday-theme-ink"), input) >= 4.5,
      `${id}: Haupttext unterschreitet 4,5:1`,
    );
    assert.ok(
      contrastRatio(colorFromTheme(id, "--birthday-theme-muted"), input) >= 4.5,
      `${id}: Sekundärtext unterschreitet 4,5:1`,
    );
    assert.ok(
      contrastRatio("#ffffff", colorFromTheme(id, "--birthday-theme-accent")) >= 4.5,
      `${id}: Primärschaltfläche unterschreitet 4,5:1`,
    );
    assert.ok(
      contrastRatio("#ffffff", colorFromTheme(id, "--birthday-theme-accent-strong")) >= 4.5,
      `${id}: Primärverlauf unterschreitet 4,5:1`,
    );
    assert.ok(
      contrastRatio(colorFromTheme(id, "--birthday-theme-focus"), input) >= 3,
      `${id}: Fokusmarkierung unterschreitet 3:1`,
    );
  }
  assert.ok(contrastRatio("#f3f6f5", "#18221f") >= 4.5, "Darkmode-Haupttext");
  assert.ok(contrastRatio("#c0cac6", "#18221f") >= 4.5, "Darkmode-Sekundärtext");
  assert.ok(contrastRatio("#101a17", "#79c8a8") >= 4.5, "Darkmode-Primärschaltfläche");
  assert.ok(contrastRatio("#b8f3d8", "#18221f") >= 3, "Darkmode-Fokusmarkierung");
});

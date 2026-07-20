"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

test("Standorte nutzen ein responsives Zweispaltenraster mit neutralem Leerzustand", () => {
  assert.match(styles, /\.location-list\s*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media \(max-width:1180px\)[\s\S]*\.location-list\s*\{\s*grid-template-columns:1fr/);
  assert.match(styles, /data-active-page-theme="dark"\] #personnelView \.location-card \.empty-options\s*\{[^}]*background:#1d2925/);
});

test("Beide Mitarbeitendenansichten teilen Spaltenauswahl und sortierbare Überschriften", () => {
  assert.match(html, /id="teamDisplayColumnsButton"/);
  assert.match(html, /id="personnelDisplayColumnsButton"/);
  assert.match(html, /id="employeeColumnsModal"/);
  assert.match(script, /const EMPLOYEE_DISPLAY_COLUMNS/);
  assert.match(script, /data-employee-sort/);
  assert.match(script, /new Intl\.Collator\("de-AT", \{ numeric: true/);
  assert.match(script, /employeeDisplayColumnsStorageKey/);
  assert.match(script, /employeeDisplaySortStorageKey/);
  assert.doesNotMatch(script, /fieldKey: "(?:socialSecurityNumber|emergencyContact\.)/);
});

test("Darkmode gestaltet Rechtekarten und Dialog-Scrollbalken durchgängig dunkel", () => {
  assert.match(styles, /data-active-page-theme="dark"\] \.modal :is\(\.employee-additional-rights/);
  assert.match(styles, /data-active-page-theme="dark"\] \.modal :is\(\.employee-access-right/);
  assert.match(styles, /data-active-page-theme="dark"\] :is\(\.modal,\.modal form,\.modal \*\)::-webkit-scrollbar-track/);
});

test("Serverbetrieb meldet am unteren Seitenrand ab und beendet nicht den Host", () => {
  assert.match(script, /querySelector\("span"\)\.textContent = serverActive \? "Logout" : "Beenden"/);
  assert.match(script, /if \(serverActive\) return logoutPortal\(\)/);
  assert.match(styles, /\.sidebar-exit-button\.logout-mode/);
  assert.match(html, /id="portalLogoutButton"[^>]*>\(Logout\)<\/button>/);
});

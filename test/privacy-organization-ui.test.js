"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDocument } = require("htmlparser2");
const UI = require("../public/privacy-organization");

const user = (overrides = {}) => ({ employeeNumber: "SYNTHETIC-HR", role: "hr", isEmployee: true, accountType: "employee", sessionKind: "employee", permissions: ["privacy_organization:read", "privacy_organization:manage", "privacy_organization:approve"], ...overrides });
const fields = [
  { key: "title", label: "Titel", type: "text", requiredOnReview: true },
  { key: "description", label: "Beschreibung", type: "textarea" },
  { key: "dataCategories", label: "Datenkategorien", type: "listrefs" },
  { key: "role", label: "Rolle", type: "enum", options: [{ value: "controller", label: "Verantwortlicher" }, { value: "processor", label: "Auftragsverarbeiter" }] },
  { key: "awarenessAt", label: "Kenntnis", type: "instant" },
  { key: "worksCouncilConfirmed", label: "Beteiligung belegt", type: "boolean" },
  { key: "affectedCount", label: "Anzahl", type: "number", integer: true },
];
const register = (overrides = {}) => ({
  revision: 1,
  capabilities: { read: true, manage: true, approve: true },
  records: [{ id: "SYNTHETIC-ACTIVITY", kind: "activity", title: "Synthetische Verarbeitung", revision: 1, status: "draft", payload: { title: "Synthetische Verarbeitung", description: "Sachliche Testkategorien", dataCategories: [], role: "controller", awarenessAt: null, worksCouncilConfirmed: false, affectedCount: null }, readiness: { ready: false, issues: [{ field: "dataCategories", message: "Datenkategorien fehlen." }] }, updatedAt: "2026-10-03T14:00:00+02:00" }],
  catalog: {
    kinds: UI.TABS.map(tab => ({ id: tab.kind, label: tab.label, fields })),
    sources: [{ id: "synthetic", title: "Synthetische Quelle", url: "https://example.test/source", version: "Testfassung", retrievedOn: "2026-10-03" }],
    activityTemplates: [{ id: "synthetic-template", title: "Synthetische Vorlage", payload: { title: "Vorlage", dataCategories: ["test_category"] } }],
  },
  ...overrides,
});

test("Datenschutz öffnet für persönliche HR/Admin/Developer-Konten mit ausdrücklichem Fachrecht", () => {
  for (const role of ["hr", "admin", "developer"]) {
    for (const permission of ["privacy_organization:read", "privacy_organization:manage", "privacy_organization:approve"]) {
      assert.equal(UI.accessAllowed(user({ role }), permission), true, `${role}: ${permission}`);
      assert.equal(UI.accessAllowed(user({ role, permissions: [] }), permission), false, `${role}: missing ${permission}`);
    }
    for (const changes of [{ permissions: ["privacy_organization:manage"] }, { localSystem: true }, { sessionKind: "local" }, { sessionKind: undefined }, { employeeNumber: "local" }, { employeeNumber: "" }, { isEmployee: false }, { isEmployee: undefined }, { accountType: "branch" }, { accountType: undefined }]) assert.equal(UI.accessAllowed(user({ role, ...changes })), false, JSON.stringify({ role, ...changes }));
  }
  for (const role of ["it_admin", "manager", "employee"]) assert.equal(UI.accessAllowed(user({ role })), false, role);
});

test("History-/Tab-Normalisierung nimmt ausschließlich feste Bereiche an", () => {
  for (const tab of UI.TABS) assert.equal(UI.normalizeTab(tab.id), tab.id);
  for (const value of [null, undefined, "person=123", "breaches/SYNTHETIC-ID", "javascript:alert(1)", "__proto__"]) assert.equal(UI.normalizeTab(value), "overview");
  assert.equal(UI.TABS.find(tab => tab.id === "agreements").kind, "works_agreement");
});

test("Quellenlinks akzeptieren HTTPS ohne Zugangsdaten und führen keinen Inhalt aus", () => {
  assert.equal(UI.safeSourceUrl("https://example.test/a?q=1"), "https://example.test/a?q=1");
  for (const value of ["javascript:alert(1)", "data:text/html,x", "http://example.test", "//example.test", "https://secret@example.test/"]) assert.equal(UI.safeSourceUrl(value), "");
  const document = parseDocument(UI.renderSources([{ title: '<img src=x onerror="bad()">', url: "javascript:alert(1)", summary: '<script>bad()</script>' }]));
  assert.equal(allNodes(document).some(node => ["img", "script", "a"].includes(node.name)), false);
  assert.match(textOf(document), /<img src=x onerror="bad\(\)">/);
});

test("72-Stunden-Anzeige benutzt Serverzustand und macht fehlende Fristen nicht grün", () => {
  const unknown = UI.renderDeadlines({ kind: "breach" });
  assert.match(unknown, /noch ungeklärt/);
  assert.doesNotMatch(unknown, /als versendet|erforderlich · Entscheidung|status-badge active/);
  const late = UI.renderDeadlines({ kind: "breach", deadlines: { authorityState: "overdue", authorityDueAt: "2026-10-06T12:30:00Z", hoursRemaining: -1.5 } });
  assert.match(late, /is-urgent/);
  assert.match(late, /1\.5 Stunden überschritten/);
  assert.match(late, /Wien/);
  assert.match(UI.renderDeadlines({ kind: "breach", deadlines: { authorityState: "recorded_late" } }), /Versand nach Frist/);
  assert.equal(UI.renderDeadlines({ kind: "activity", deadlines: { authorityState: "overdue" } }), "");
});

test("Zeitpunkte brauchen einen Offset und werden ohne Host-Zeitzonenannahme für Wien angezeigt", () => {
  assert.match(UI.formatInstant("2026-10-03T12:30:00Z"), /14:30.*Wien/);
  assert.match(UI.formatInstant("2026-12-03T12:30:00Z"), /13:30.*Wien/);
  assert.match(UI.formatInstant("2026-10-03T12:30:00"), /ungeklärt/);
  assert.match(UI.formatInstant("invalidZ"), /ungeklärt/);
});

test("Felder übernehmen nur den erlaubten Katalog und escaped Inhalte", () => {
  const source = [...fields, { key: "__proto__", type: "text" }, { key: "constructor", type: "text" }, { key: "person.number", type: "text" }, { key: "html", type: "html" }];
  assert.deepEqual(UI.catalogFields({ fields: source }).map(field => field.key), fields.map(field => field.key));
  const document = parseDocument(UI.fieldMarkup({ key: "description", label: '<svg onload="bad()">', type: "textarea", help: '<script>bad()</script>' }, { description: '</textarea><script>bad()</script>' }));
  assert.equal(allNodes(document).some(node => ["svg", "script"].includes(node.name)), false);
  assert.match(textOf(document), /<\/textarea><script>bad\(\)<\/script>/);
});

test("Feldlesen bewahrt Ausgangsfakten und erzeugt Arrays, Nullzeitpunkte und boolesche Werte", () => {
  const data = { title: "  Verarbeitung  ", description: "Sachlich", dataCategories: "employee_category,\ncontract_category\n", role: "controller", awarenessAt: "", worksCouncilConfirmed: true, affectedCount: "0" };
  const original = { retainedSchemaField: "preserved" };
  const result = UI.readFormPayload(fields, key => data[key], original);
  assert.equal(result.title, "Verarbeitung");
  assert.deepEqual(result.dataCategories, ["employee_category", "contract_category"]);
  assert.equal(result.awarenessAt, null);
  assert.equal(result.worksCouncilConfirmed, true);
  assert.equal(result.affectedCount, 0);
  assert.equal(result.retainedSchemaField, "preserved");
  assert.deepEqual(original, { retainedSchemaField: "preserved" });
});

test("Lokale Eingabeprüfung stoppt ungezonte Zeitpunkte und ungültige Zahlen vor einem Schreibaufruf", () => {
  assert.throws(() => UI.readFormPayload(fields, key => key === "awarenessAt" ? "2026-10-03T10:00" : ""), /UTC-Offset/);
  assert.throws(() => UI.readFormPayload(fields, key => key === "affectedCount" ? "NaN" : ""), /gültige Zahl/);
  assert.throws(() => UI.readFormPayload(fields, key => key === "affectedCount" ? "1.2" : ""), /gültige Zahl/);
  assert.equal(UI.readFormPayload(fields, key => key === "awarenessAt" ? "2026-10-03T10:00:00+02:00" : "").awarenessAt, "2026-10-03T10:00:00+02:00");
});

test("Prüfstand unterscheidet prüfbare Angaben von offenen Aufgaben und führt kein Server-HTML aus", () => {
  const source = UI.renderReadiness({ ready: true, releaseReady: false, issues: [], warnings: [{ message: "Betriebliche Abnahme offen." }] });
  assert.match(source, /Bereit für die fachliche Prüfung/);
  assert.doesNotMatch(source, /Produktionsreif|rechtskonform|Freigegeben/);
  const document = parseDocument(UI.renderReadiness({ ready: false, issues: [{ message: '<img src=x onerror="bad()">' }] }));
  assert.equal(allNodes(document).some(node => node.name === "img"), false);
});

test("Aktionen werden nach Fachrechten und Status begrenzt; Meldung ist bereits im Entwurf dokumentierbar", () => {
  const ids = (record, capabilities) => UI.recordActions(record, capabilities).map(action => action.id);
  assert.deepEqual(ids({ kind: "breach", status: "draft" }, {}), ["read"]);
  assert.deepEqual(ids({ kind: "breach", status: "draft" }, { manage: true }), ["read", "edit", "submit", "record_notification"]);
  assert.deepEqual(ids({ kind: "works_agreement", status: "submitted" }, { approve: true }), ["read", "approve"]);
  assert.deepEqual(ids({ kind: "works_agreement", status: "submitted" }, { approve: true, manage: true, currentActorIsAuthor: true }), ["read", "edit", "return", "archive"]);
  assert.equal(ids({ kind: "breach", status: "archived" }, { manage: true, approve: true }).includes("record_notification"), false);
  assert.equal(ids({ kind: "organization", status: "approved" }, { manage: true }).includes("archive"), false);
});

// A small parsed DOM exercises the real controller without executing markup or
// depending on a browser-specific DOM package. All fixtures are synthetic.
function allNodes(node) { return (node.children || []).flatMap(child => [child, ...allNodes(child)]); }
function textOf(node) { return node.type === "text" ? node.data || "" : (node.children || []).map(textOf).join(""); }
function fixtureHost() {
  const rootNode = { type: "tag", name: "div", attribs: {}, children: [], parent: null, fixtureRoot: true };
  const cache = new WeakMap(), handlers = new Map();
  function match(node, selector) {
    return selector.split(",").some(piece => {
      const trimmed = piece.trim(), classMatch = /^\.([\w-]+)$/.exec(trimmed);
      if (classMatch) return String(node.attribs?.class || "").split(/\s+/).includes(classMatch[1]);
      const selected = /^(\w+)?(?:\[([\w-]+)(?:=['"]?([^'"\]]+)['"]?)?\])?$/.exec(trimmed);
      return selected && (!selected[1] || node.name === selected[1]) && (!selected[2] || Object.hasOwn(node.attribs || {}, selected[2]) && (selected[3] === undefined || node.attribs[selected[2]] === selected[3]));
    });
  }
  function wrap(node) {
    if (cache.has(node)) return cache.get(node);
    const classes = new Set(String(node.attribs?.class || "").split(/\s+/).filter(Boolean));
    const target = {
      classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); }, contains(value) { return classes.has(value); }, toggle(value, enabled) { if (enabled === undefined ? !classes.has(value) : enabled) classes.add(value); else classes.delete(value); } },
      get dataset() { return Object.fromEntries(Object.entries(node.attribs || {}).filter(([key]) => key.startsWith("data-")).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])); },
      get isConnected() { let item = node; while (item.parent) item = item.parent; return item === rootNode; },
      get hidden() { return Object.hasOwn(node.attribs || {}, "hidden"); },
      set hidden(value) { if (value) node.attribs.hidden = ""; else delete node.attribs.hidden; },
      get open() { return Object.hasOwn(node.attribs || {}, "open"); },
      set open(value) { if (value) node.attribs.open = ""; else delete node.attribs.open; },
      get checked() { return Object.hasOwn(node.attribs || {}, "checked"); },
      set checked(value) { if (value) node.attribs.checked = ""; else delete node.attribs.checked; },
      get value() { if (Object.hasOwn(target, "fixtureValue")) return target.fixtureValue; if (node.name === "textarea") return textOf(node); if (node.name === "select") return allNodes(node).find(item => item.name === "option" && Object.hasOwn(item.attribs || {}, "selected"))?.attribs.value || ""; return node.attribs?.value || ""; },
      set value(value) { target.fixtureValue = String(value); },
      get textContent() { return textOf(node); },
      set textContent(value) { node.children = [{ type: "text", data: String(value), parent: node }]; },
      set innerHTML(source) { for (const child of node.children || []) child.parent = null; node.children = parseDocument(source).children; for (const child of node.children) child.parent = node; },
      get elements() { return { namedItem(name) { const child = allNodes(node).find(item => item.attribs?.name === name); return child ? wrap(child) : null; } }; },
      querySelector(selector) { return target.querySelectorAll(selector)[0] || null; },
      querySelectorAll(selector) { return allNodes(node).filter(child => match(child, selector)).map(wrap); },
      matches(selector) { return match(node, selector); },
      closest(selector) { let cursor = node; while (cursor) { if (match(cursor, selector)) return wrap(cursor); cursor = cursor.parent; } return null; },
      setAttribute(name, value) { node.attribs[name] = String(value); },
      replaceChildren() { for (const child of node.children || []) child.parent = null; node.children = []; },
      close() { target.open = false; }, showModal() { target.open = true; }, focus() {}, scrollIntoView() {},
      addEventListener(name, handler) { handlers.set(name, handler); }, removeEventListener(name) { handlers.delete(name); },
      async fire(name, event) { return await handlers.get(name)?.(event); },
    };
    cache.set(node, target); return target;
  }
  return wrap(rootNode);
}

test("Unberechtigte Konten lösen weder Lesen noch persistente Steuerungen aus", async () => {
  const host = fixtureHost(); let reads = 0;
  const workspace = UI.mount(host, { api: async () => { reads++; return register(); }, user: user({ role: "it_admin" }) });
  assert.equal(await workspace.activate("breaches"), false);
  assert.equal(reads, 0);
  assert.equal(host.querySelector("[data-po-panel]"), null);
  workspace.destroy();
});

test("Ein persönliches Developer-Konto kann alle fünf Datenschutzbereiche öffnen und Arbeitsfassungen bearbeiten", async () => {
  const host = fixtureHost(), calls = [];
  const workspace = UI.mount(host, { api: async (url, options = {}) => { calls.push({ url, options }); return register(); }, user: user({ role: "developer" }) });
  for (const tab of UI.TABS) {
    assert.equal(await workspace.activate(tab.id), true, tab.id);
    assert.equal(workspace.getTab(), tab.id);
    assert.ok(host.querySelector("[data-po-panel]"), tab.id);
    assert.match(host.textContent, new RegExp(tab.id === "overview" ? "Datenschutzorganisation" : tab.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal(calls.length, UI.TABS.length);
  assert.ok(calls.every(call => call.url === "/api/privacy-organization" && !call.options.method));
  await workspace.activate("data-map");
  const edit = host.querySelector('[data-po-action="edit"]');
  assert.ok(edit);
  await host.fire("click", { target: edit });
  assert.ok(host.querySelector("[data-po-edit-form]"));
  assert.equal(host.querySelector("[data-po-edit-form]").elements.namedItem("title").value, "Synthetische Verarbeitung");
  workspace.destroy();
});

test("Ein verzögertes Register darf nach Kontowechsel keine Informationen anzeigen", async () => {
  const host = fixtureHost(); let resolve, currentUser = user(), actor = "account-a";
  const workspace = UI.mount(host, { api: () => new Promise(done => { resolve = done; }), user: () => currentUser, accessKey: () => actor });
  const work = workspace.activate("data-map");
  actor = "account-b"; currentUser = user({ role: "developer" }); resolve(register());
  assert.equal(await work, false);
  assert.doesNotMatch(host.textContent, /Synthetische Verarbeitung/);
  workspace.destroy();
});

test("Suspend und erneutes Öffnen invalidieren alte Requests und führen genau eine aktuelle Anzeige aus", async () => {
  const host = fixtureHost(), pending = []; let count = 0;
  const workspace = UI.mount(host, { api: () => { count++; return new Promise(resolve => pending.push(resolve)); }, user: user() });
  const first = workspace.activate("data-map"); workspace.suspend();
  const second = workspace.activate("breaches");
  pending[0](register()); await first;
  assert.doesNotMatch(host.textContent, /Synthetische Verarbeitung/);
  pending[1](register()); await second;
  assert.equal(count, 2); assert.equal(workspace.getTab(), "breaches");
  workspace.destroy(); assert.equal(host.textContent, "");
});

test("Ein 409-Konflikt und Aktualisieren bewahren Eingaben und ursprüngliche Revision bis zum bewussten Neuöffnen", async () => {
  const host = fixtureHost(), calls = []; let latest = register();
  const workspace = UI.mount(host, { user: user(), api: async (url, options = {}) => { calls.push({ url, options }); if (options.method === "POST") { const error = new Error("stale revision"); error.status = 409; throw error; } return latest; } });
  await workspace.activate("data-map");
  const edit = host.querySelector('[data-po-action="edit"]'); await host.fire("click", { target: edit });
  let form = host.querySelector("[data-po-edit-form]");
  const title = form.elements.namedItem("title"); title.value = "Ungespeicherte synthetische Änderung";
  await host.fire("input", { target: title });
  assert.equal(workspace.hasUnsavedChanges(), true);
  await host.fire("submit", { target: form, preventDefault() {} });
  assert.equal(form.elements.namedItem("title").value, "Ungespeicherte synthetische Änderung");
  assert.match(form.querySelector("[data-po-form-status]").textContent, /Eingaben bleiben erhalten/);
  assert.equal(JSON.parse(calls.find(call => call.options.method === "POST").options.body).expectedRevision, 1);
  latest = register({ revision: 2 }); await workspace.load();
  form = host.querySelector("[data-po-edit-form]");
  assert.equal(form.elements.namedItem("title").value, "Ungespeicherte synthetische Änderung");
  await host.fire("submit", { target: form, preventDefault() {} });
  assert.equal(JSON.parse(calls.filter(call => call.options.method === "POST").at(-1).options.body).expectedRevision, 1);
  await workspace.activate("dpia");
  assert.equal(workspace.hasUnsavedChanges(), true);
  assert.equal(host.querySelector("[data-po-edit-form]").elements.namedItem("title").value, "Ungespeicherte synthetische Änderung");
  workspace.destroy(); assert.equal(host.textContent, "");
});

test("Form-Speichern sendet explizites create/update mit Arrays und Revision, niemals Rohdaten als URL", async () => {
  const host = fixtureHost(), calls = [];
  const workspace = UI.mount(host, { user: user(), api: async (url, options = {}) => { calls.push({ url, options }); return register({ revision: options.method ? 2 : 1 }); } });
  await workspace.activate("data-map");
  await host.fire("click", { target: host.querySelector('[data-po-action="edit"]') });
  const form = host.querySelector("[data-po-edit-form]"); form.elements.namedItem("dataCategories").value = "synthetic_one\nsynthetic_two";
  await host.fire("submit", { target: form, preventDefault() {} });
  const call = calls.find(item => item.options.method === "POST");
  assert.equal(call.url, "/api/privacy-organization/commands");
  assert.deepEqual(JSON.parse(call.options.body).payload.dataCategories, ["synthetic_one", "synthetic_two"]);
  assert.equal(JSON.parse(call.options.body).action, "update");
  assert.equal(JSON.parse(call.options.body).id, "SYNTHETIC-ACTIVITY");
  assert.equal(host.querySelector("[data-po-edit-form]"), null);
  assert.equal(workspace.hasUnsavedChanges(), false);
  workspace.destroy();
});

test("Reiner Lesezugriff zeigt keine neue Fassung, Freigabe oder Versandsteuerung", async () => {
  const host = fixtureHost(); const result = register({ records: [{ ...register().records[0], kind: "breach", status: "submitted" }], capabilities: { read: true, manage: false, approve: false } });
  const workspace = UI.mount(host, { user: user(), api: async () => result }); await workspace.activate("breaches");
  for (const action of ["edit", "new", "approve", "return", "record_notification", "close"]) assert.equal(host.querySelector(`[data-po-action="${action}"]`), null, action);
  await host.fire("click", { target: host.querySelector('[data-po-action="read"]') });
  assert.equal(host.querySelector("[data-po-edit-form]"), null);
  assert.match(host.textContent, /Fassung ansehen/);
  workspace.destroy();
});

test("Dokumentierte Meldungen benötigen einen ausdrücklichen Versandnachweis und führen nur den Registercommand aus", async () => {
  const host = fixtureHost(), calls = [];
  const result = register({ records: [{ ...register().records[0], kind: "breach", status: "draft" }] });
  const workspace = UI.mount(host, { user: user(), api: async (url, options = {}) => { calls.push({ url, options }); return result; } });
  await workspace.activate("breaches");
  await host.fire("click", { target: host.querySelector('[data-po-action="record_notification"]') });
  const form = host.querySelector("[data-po-decision-form]");
  assert.match(form.textContent, /bereits erfolgter externer Versand/);
  form.elements.namedItem("channel").value = "authority"; form.elements.namedItem("phase").value = "initial";
  form.elements.namedItem("sentAt").value = "2026-10-03T14:00:00"; form.elements.namedItem("evidenceReference").value = "SYNTHETIC-RECEIPT";
  await host.fire("submit", { target: form, preventDefault() {} });
  assert.equal(calls.some(call => call.options.method === "POST"), false);
  form.elements.namedItem("sentAt").value = "2026-10-03T14:00:00+02:00";
  await host.fire("submit", { target: form, preventDefault() {} });
  const posted = calls.find(call => call.options.method === "POST");
  assert.equal(posted.url, "/api/privacy-organization/commands");
  assert.deepEqual(JSON.parse(posted.options.body).decision, { channel: "authority", phase: "initial", sentAt: "2026-10-03T14:00:00+02:00", evidenceReference: "SYNTHETIC-RECEIPT", details: "" });
  workspace.destroy();
});

test("Alle aktuellen Core-Katalogfelder werden als speicherbare Arbeitsfassung gelesen, inklusive leeren Datumsfeldern", () => {
  const Core = require("../lib/privacy-organization");
  for (const definition of Core.PRIVACY_ORGANIZATION_CATALOG.kinds) {
    assert.equal(UI.catalogFields(definition).length, definition.fields.length, definition.id);
    const payload = UI.readFormPayload(definition.fields, () => "");
    const ledger = definition.id === "organization"
      ? Core.createPrivacyLedger({ initialOrganization: payload })
      : Core.applyPrivacyCommand(Core.createPrivacyLedger(), { expectedRevision: 0, action: "create", kind: definition.id, payload }, { actor: { personal: true, employeeNumber: "SYNTHETIC-HR", role: "hr", permissions: ["privacy_organization:manage"] }, now: "2026-10-03T12:00:00Z" });
    assert.equal(Core.verifyPrivacyLedger(ledger).valid, true);
    for (const field of definition.fields.filter(item => item.type === "date")) assert.equal(payload[field.key], "", `${definition.id}: ${field.key}`);
    for (const field of definition.fields.filter(item => item.type === "enum")) assert.equal(payload[field.key], "unknown", `${definition.id}: ${field.key}`);
  }
});

test("VVT-Auswahl bindet eine DSFA an die gewählte fachlich freigegebene Inhaltsfassung", async () => {
  const Core = require("../lib/privacy-organization"), host = fixtureHost();
  const activity = { ...register().records[0], status: "approved", revision: 3, contentSha256: "a".repeat(64), readiness: { ready: true, releaseReady: true, issues: [] } };
  const result = register({ catalog: Core.PRIVACY_ORGANIZATION_CATALOG, records: [activity] });
  const calls = [];
  const workspace = UI.mount(host, { user: user(), api: async (url, options = {}) => { calls.push({ url, options }); return result; } });
  await workspace.activate("dpia"); await host.fire("click", { target: host.querySelector('[data-po-action="new"]') });
  const form = host.querySelector("[data-po-edit-form]");
  const selected = form.elements.namedItem("activityId"); selected.value = activity.id;
  await host.fire("change", { target: selected });
  assert.equal(form.elements.namedItem("activitySha256").value, activity.contentSha256);
  await host.fire("submit", { target: form, preventDefault() {} });
  const sent = JSON.parse(calls.find(call => call.options.method === "POST").options.body);
  assert.equal(sent.kind, "dpia");
  assert.equal(sent.payload.activityId, activity.id);
  assert.equal(sent.payload.activitySha256, activity.contentSha256);
  workspace.destroy();
});

test("Legacy-Verweise folgen ausschließlich der frischen Serverfreigabe und umgehen keine Fachrechte", async () => {
  const host = fixtureHost(), navigated = [];
  const result = register({ legacyAccess: { dataRequests: false, retention: true } });
  const workspace = UI.mount(host, { user: user(), api: async () => result, onLegacyNavigate: destination => navigated.push(destination) });
  await workspace.activate("overview");
  assert.equal(host.querySelector('[data-po-legacy="requests"]'), null);
  const retention = host.querySelector('[data-po-legacy="retention"]'); assert.ok(retention);
  await host.fire("click", { target: retention });
  assert.deepEqual(navigated, ["retention"]);
  workspace.destroy();
});

test("Entscheidungsentwürfe bleiben bei suspend erhalten; Esc verwirft sie ohne ausdrückliche Entscheidung nicht", async () => {
  const host = fixtureHost(), oldConfirm = globalThis.confirm;
  const result = register({ records: [{ ...register().records[0], status: "submitted", lastAuthor: "SYNTHETIC-OTHER", submittedBy: "SYNTHETIC-OTHER" }] });
  globalThis.confirm = () => false;
  const workspace = UI.mount(host, { user: user(), api: async () => result });
  try {
    await workspace.activate("data-map"); await host.fire("click", { target: host.querySelector('[data-po-action="approve"]') });
    const form = host.querySelector("[data-po-decision-form]"), reason = form.elements.namedItem("reason"); reason.value = "Unfertige synthetische Prüfung";
    await host.fire("input", { target: reason });
    const dialog = host.querySelector("[data-po-decision]"); let prevented = false;
    await host.fire("cancel", { target: dialog, preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(workspace.hasUnsavedChanges(), true);
    workspace.suspend(); assert.equal(dialog.open, false);
    await workspace.activate("data-map"); assert.equal(dialog.open, true);
    assert.equal(host.querySelector("[data-po-decision-form]").elements.namedItem("reason").value, "Unfertige synthetische Prüfung");
  } finally { workspace.destroy(); if (oldConfirm === undefined) delete globalThis.confirm; else globalThis.confirm = oldConfirm; }
});

test("Die einreichende oder zuletzt bearbeitende Person erhält keine Selbstfreigabeschaltfläche", async () => {
  const host = fixtureHost();
  const result = register({ records: [{ ...register().records[0], status: "submitted", lastAuthor: "SYNTHETIC-HR", submittedBy: "SYNTHETIC-HR" }] });
  const workspace = UI.mount(host, { user: user(), api: async () => result }); await workspace.activate("data-map");
  assert.equal(host.querySelector('[data-po-action="approve"]'), null);
  assert.ok(host.querySelector('[data-po-action="return"]'));
  workspace.destroy();
});

test("Bereits dokumentierte oder begründet ausgeschlossene Meldungen zeigen keinen irreführenden Überschreitungszähler", () => {
  for (const authorityState of ["recorded", "recorded_late", "not_required", "controller_responsibility"]) {
    const markup = UI.renderDeadlines({ kind: "breach", status: "approved", deadlines: { authorityState, hoursRemaining: -200, authorityDueAt: "2026-10-01T12:00:00Z" } });
    assert.doesNotMatch(markup, /200\.0 Stunden überschritten/);
  }
  assert.match(UI.renderDeadlines({ kind: "breach", status: "draft", deadlines: { authorityState: "not_required" } }), /Vorgesehene Entscheidung.*Fachprüfung offen/);
  assert.match(UI.renderDeadlines({ kind: "breach", status: "draft", deadlines: { authorityState: "overdue", effectiveControllerAwareAt: "2026-10-01T12:00:00Z" } }, { evaluatedAt: "2026-10-03T12:00:00Z" }), /Fristauslösende Kenntnis.*Stand der Auswertung/);
});

test("Archivieren folgt dem Vorfallsabschluss und kann unbenötigte sonstige Entwürfe erhalten", () => {
  const actions = record => UI.recordActions(record, { manage: true }).map(item => item.id);
  assert.equal(actions({ kind: "breach", status: "approved", payload: { breachConfirmed: "yes" } }).includes("archive"), false);
  assert.equal(actions({ kind: "breach", status: "draft", payload: { breachConfirmed: "unknown" } }).includes("archive"), false);
  assert.equal(actions({ kind: "breach", status: "closed", payload: { breachConfirmed: "yes" } }).includes("archive"), true);
  assert.equal(actions({ kind: "breach", status: "closed" }).includes("edit"), false);
  assert.equal(actions({ kind: "activity", status: "draft" }).includes("archive"), true);
});

test("Jedes erneute Öffnen lädt aktuelle Bewertungen, während die Arbeitsfassung erhalten bleibt", async () => {
  const host = fixtureHost(); let reads = 0, latest = register();
  const workspace = UI.mount(host, { user: user(), api: async () => { reads++; return latest; } });
  await workspace.activate("data-map");
  latest = register({ revision: 2, records: [{ ...register().records[0], title: "Aktueller synthetischer Prüfstand" }] });
  await workspace.activate("data-map");
  assert.equal(reads, 2); assert.match(host.textContent, /Aktueller synthetischer Prüfstand/);
  workspace.destroy();
});

test("Eine überfällige VVT-Freigabe wird nicht als aktuelle DSFA-Grundlage angeboten", async () => {
  const Core = require("../lib/privacy-organization"), host = fixtureHost();
  const expired = { ...register().records[0], status: "approved", contentSha256: "b".repeat(64), readiness: { ready: false, releaseReady: false, issues: [{ message: "VVT-Prüfung überfällig." }] } };
  const result = register({ catalog: Core.PRIVACY_ORGANIZATION_CATALOG, records: [expired] });
  const workspace = UI.mount(host, { user: user(), api: async () => result }); await workspace.activate("dpia");
  await host.fire("click", { target: host.querySelector('[data-po-action="new"]') });
  const select = host.querySelector("[data-po-edit-form]").elements.namedItem("activityId");
  assert.equal(select.querySelectorAll("option").some(option => option.value === expired.id), false);
  select.value = expired.id; await host.fire("change", { target: select });
  assert.equal(host.querySelector("[data-po-edit-form]").elements.namedItem("activitySha256").value, "");
  workspace.destroy();
});


test("Fachgruppen erhalten jedes Katalogfeld und zusätzliche Metadaten auch in geschlossenen Bereichen", async () => {
  const Core = require("../lib/privacy-organization");
  for (const kind of Core.PRIVACY_ORGANIZATION_CATALOG.kinds) {
    const extra = { key: "futureMetadata", label: "Zusätzliche sachliche Angabe", type: "text" };
    const currentFields = [...kind.fields, extra];
    const groups = UI.fieldSections(kind.id, currentFields);
    const keys = groups.flatMap(group => group.fields.map(field => field.key));
    assert.deepEqual([...keys].sort(), currentFields.map(field => field.key).sort(), kind.id);
    assert.equal(new Set(keys).size, currentFields.length, kind.id);
    const host = fixtureHost();
    const record = { id: "SYNTHETIC-GROUPED", kind: kind.id, status: "draft", revision: 1, payload: { futureMetadata: "Zusätzliche synthetische Metadaten" }, readiness: { ready: false } };
    const result = register({ catalog: { ...Core.PRIVACY_ORGANIZATION_CATALOG, kinds: [{ ...kind, fields: currentFields }] }, records: [record] });
    const workspace = UI.mount(host, { user: user(), api: async () => result });
    await workspace.activate(UI.TABS.find(tab => tab.kind === kind.id).id);
    await host.fire("click", { target: host.querySelector('[data-po-action="edit"]') });
    const form = host.querySelector("[data-po-edit-form]");
    assert.ok(form, kind.id);
    for (const field of currentFields) assert.ok(form.elements.namedItem(field.key), `${kind.id}.${field.key}`);
    const saved = UI.readFormPayload(currentFields, (name, type) => type === "boolean" ? form.elements.namedItem(name).checked : form.elements.namedItem(name).value, record.payload);
    assert.equal(saved.futureMetadata, record.payload.futureMetadata);
    assert.equal(host.querySelector("[data-po-editor]").open, true);
    workspace.destroy();
  }
});

test("Nativer Arbeitsfassungsdialog bewahrt Eingaben bei Esc und suspend und schließt erst nach bestätigtem Verwerfen", async () => {
  const host = fixtureHost(), oldConfirm = globalThis.confirm;
  const workspace = UI.mount(host, { user: user(), api: async () => register() });
  globalThis.confirm = () => false;
  try {
    await workspace.activate("data-map");
    await host.fire("click", { target: host.querySelector('[data-po-action="edit"]') });
    const dialog = host.querySelector("[data-po-editor]"), form = host.querySelector("[data-po-edit-form]");
    const input = form.elements.namedItem("title"); input.value = "Unfertige synthetische Arbeitsfassung";
    await host.fire("input", { target: input });
    let prevented = false;
    await host.fire("cancel", { target: dialog, preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(dialog.open, true); assert.equal(workspace.hasUnsavedChanges(), true);
    assert.equal(form.elements.namedItem("title").value, "Unfertige synthetische Arbeitsfassung");
    workspace.suspend(); assert.equal(dialog.open, false);
    await workspace.activate("data-map"); assert.equal(dialog.open, true);
    assert.equal(form.elements.namedItem("title").value, "Unfertige synthetische Arbeitsfassung");
    globalThis.confirm = () => true;
    await host.fire("cancel", { target: dialog, preventDefault() {} });
    assert.equal(dialog.open, false); assert.equal(dialog.hidden, true); assert.equal(workspace.hasUnsavedChanges(), false);
    assert.equal(host.querySelector("[data-po-edit-form]"), null);
  } finally { workspace.destroy(); if (oldConfirm === undefined) delete globalThis.confirm; else globalThis.confirm = oldConfirm; }
});

test("Fachfehler ohne Feldkennung machen zugeklappte Angaben erreichbar und erhalten die Arbeitsfassung", async () => {
  const Core = require("../lib/privacy-organization");
  for (const scenario of [
    { kind: "organization", code: "PRIVACY_ORGANIZATION_PERSONAL_REFERENCE_INVALID", message: "Eine benannte persönliche Datenschutz-Zuständigkeit ist keinem aktiven persönlichen GP-Konto zugeordnet.", field: "dpoEmployeeNumber", value: "SYNTHETIC-INACTIVE", status: 409 },
    { kind: "works_agreement", code: "PRIVACY_ORGANIZATION_INVALID_DATE", message: "Gültigkeitsende liegt vor dem Beginn.", field: "validTo", value: "2026-01-01", status: 400 },
  ]) {
    const host = fixtureHost();
    const record = { id: "SYNTHETIC-ERROR", kind: scenario.kind, status: "draft", revision: 1, payload: {}, readiness: { ready: false } };
    const result = register({ catalog: Core.PRIVACY_ORGANIZATION_CATALOG, records: [record] });
    const workspace = UI.mount(host, { user: user(), api: async (url, options = {}) => {
      if (options.method === "POST") throw Object.assign(new Error(scenario.message), { code: scenario.code, status: scenario.status });
      return result;
    } });
    try {
      await workspace.activate(UI.TABS.find(tab => tab.kind === scenario.kind).id);
      await host.fire("click", { target: host.querySelector('[data-po-action="edit"]') });
      const form = host.querySelector("[data-po-edit-form]"), groups = form.querySelectorAll(".privacy-org-field-section");
      assert.ok(groups.length > 1);
      assert.ok(groups.some(group => !group.open), "Die fehlerhafte Fassung beginnt mit geschlossenen Fachgruppen");
      const input = form.elements.namedItem(scenario.field); input.value = scenario.value;
      await host.fire("input", { target: input });
      await host.fire("submit", { target: form, preventDefault() {} });
      assert.ok(groups.every(group => group.open), scenario.kind);
      assert.equal(host.querySelector("[data-po-editor]").open, true);
      assert.equal(form.elements.namedItem(scenario.field).value, scenario.value);
      assert.equal(workspace.hasUnsavedChanges(), true);
      assert.equal(form.querySelector("[data-po-form-status]").textContent, scenario.message);
      assert.deepEqual(record.payload, {});
    } finally { workspace.destroy(); }
  }
});

test("Spätere Eingaben bleiben nach create/update geöffnet und werden anschließend als neue Fassung desselben Eintrags gespeichert", async () => {
  for (const create of [false, true]) {
    const host = fixtureHost(), writes = []; let resolveFirst, latest = register();
    const workspace = UI.mount(host, { user: user(), api: async (_url, options = {}) => {
      if (!options.method) return latest;
      const body = JSON.parse(options.body); writes.push(body);
      const original = latest.records.find(record => record.id === body.id);
      const saved = { ...(original || latest.records[0]), id: original?.id || "SYNTHETIC-NEW", revision: (original?.revision || 0) + 1, title: body.payload.title, payload: body.payload };
      latest = register({ revision: body.expectedRevision + 1, records: [...latest.records.filter(record => record.id !== saved.id), saved] });
      return writes.length === 1 ? new Promise(resolve => { resolveFirst = () => resolve(latest); }) : latest;
    } });
    try {
      await workspace.activate("data-map");
      await host.fire("click", { target: host.querySelector(create ? '[data-po-action="new"]' : '[data-po-action="edit"]') });
      const form = host.querySelector("[data-po-edit-form]"), title = form.elements.namedItem("title");
      title.value = "Erster Stand"; await host.fire("input", { target: title });
      const saving = host.fire("submit", { target: form, preventDefault() {} });
      title.value = "Weiter bearbeitet"; await host.fire("input", { target: title });
      title.value = "Letzter neuer Stand"; await host.fire("input", { target: title });
      assert.equal(writes[0].payload.title, "Erster Stand");
      resolveFirst(); await saving;
      assert.equal(host.querySelector("[data-po-edit-form]"), form); assert.equal(host.querySelector("[data-po-editor]").open, true);
      assert.equal(title.value, "Letzter neuer Stand"); assert.equal(workspace.hasUnsavedChanges(), true);
      assert.match(form.querySelector("[data-po-form-status]").textContent, /späteren Änderungen.*noch nicht gespeichert/);
      await host.fire("submit", { target: form, preventDefault() {} });
      assert.equal(writes.length, 2); assert.equal(writes[1].expectedRevision, 2); assert.equal(writes[1].action, "update");
      assert.equal(writes[1].id, create ? "SYNTHETIC-NEW" : "SYNTHETIC-ACTIVITY"); assert.equal(writes[1].payload.title, "Letzter neuer Stand");
      assert.equal(latest.records.length, create ? 2 : 1, "Weiteres Speichern erzeugt keinen doppelten Eintrag");
      assert.equal(host.querySelector("[data-po-edit-form]"), null); assert.equal(workspace.hasUnsavedChanges(), false);
    } finally { workspace.destroy(); }
  }
});

test("Fehler beim Speichern bewahren auch während des Requests geänderte Eingaben und die ursprüngliche Revision", async () => {
  for (const status of [400, 409, 503]) {
    const host = fixtureHost(), writes = []; let rejectSave;
    const workspace = UI.mount(host, { user: user(), api: async (_url, options = {}) => {
      if (!options.method) return register();
      writes.push(JSON.parse(options.body)); return new Promise((_resolve, reject) => { rejectSave = reject; });
    } });
    try {
      await workspace.activate("data-map"); await host.fire("click", { target: host.querySelector('[data-po-action="edit"]') });
      const form = host.querySelector("[data-po-edit-form]"), title = form.elements.namedItem("title");
      const saving = host.fire("submit", { target: form, preventDefault() {} });
      title.value = "Während Fehlerantwort bearbeitet"; await host.fire("input", { target: title });
      rejectSave(Object.assign(new Error(status === 409 ? "stale revision" : "Speicherung fehlgeschlagen"), { status })); await saving;
      assert.equal(host.querySelector("[data-po-edit-form]"), form); assert.equal(title.value, "Während Fehlerantwort bearbeitet");
      assert.equal(workspace.hasUnsavedChanges(), true); assert.equal(form.querySelector('button[type="submit"]').disabled, false);
      const retry = host.fire("submit", { target: form, preventDefault() {} });
      assert.equal(writes[1].expectedRevision, 1); assert.equal(writes[1].payload.title, "Während Fehlerantwort bearbeitet");
      rejectSave(Error("Erneuter Fehler")); await retry;
    } finally { workspace.destroy(); }
  }
});

test("Eine alte Speicherantwort darf eine zwischenzeitlich neu geöffnete Arbeitsfassung nicht schließen", async () => {
  const host = fixtureHost(), previousConfirm = globalThis.confirm; let resolveSave;
  const workspace = UI.mount(host, { user: user(), api: async (_url, options = {}) => options.method
    ? new Promise(resolve => { resolveSave = resolve; }) : register() });
  globalThis.confirm = () => true;
  try {
    await workspace.activate("data-map"); await host.fire("click", { target: host.querySelector('[data-po-action="edit"]') });
    const original = host.querySelector("[data-po-edit-form]");
    const saving = host.fire("submit", { target: original, preventDefault() {} });
    await host.fire("click", { target: host.querySelector("[data-po-close-editor]") });
    await host.fire("click", { target: host.querySelector("[data-po-template]") });
    const replacement = host.querySelector("[data-po-edit-form]"), title = replacement.elements.namedItem("title");
    title.value = "Anderer offener Entwurf"; await host.fire("input", { target: title });
    resolveSave(register({ revision: 2 })); await saving;
    assert.notEqual(replacement, original); assert.equal(host.querySelector("[data-po-edit-form]"), replacement);
    assert.equal(title.value, "Anderer offener Entwurf"); assert.equal(workspace.hasUnsavedChanges(), true);
  } finally { workspace.destroy(); if (previousConfirm === undefined) delete globalThis.confirm; else globalThis.confirm = previousConfirm; }
});

test("Spätere Draft-Eingaben werden nur auf die unmittelbare Antwort des eigenen Schreibens umgebunden", async () => {
  const host = fixtureHost(), writes = []; let resolveSave;
  const workspace = UI.mount(host, { user: user(), api: async (_url, options = {}) => {
    if (!options.method) return register(); writes.push(JSON.parse(options.body));
    return new Promise(resolve => { resolveSave = resolve; });
  } });
  try {
    await workspace.activate("data-map"); await host.fire("click", { target: host.querySelector('[data-po-action="edit"]') });
    const form = host.querySelector("[data-po-edit-form]"), title = form.elements.namedItem("title");
    const saving = host.fire("submit", { target: form, preventDefault() {} });
    title.value = "Noch offener Stand"; await host.fire("input", { target: title });
    resolveSave(register({ revision: 3 })); await saving;
    assert.equal(title.value, "Noch offener Stand"); assert.equal(workspace.hasUnsavedChanges(), true);
    const retry = host.fire("submit", { target: form, preventDefault() {} });
    assert.equal(writes[1].expectedRevision, 1, "Eine fremde Folgerevision darf nicht still zur Schreibbasis werden");
    resolveSave(register({ revision: 2 })); await retry;
  } finally { workspace.destroy(); }
});

test("Fachentscheidungsfelder sind während des Schreibens gesperrt und nach einem Fehler wieder bedienbar", async () => {
  const host = fixtureHost(); let rejectSave;
  const result = register({ records: [{ ...register().records[0], kind: "breach", status: "draft" }] });
  const workspace = UI.mount(host, { user: user(), api: async (_url, options = {}) => options.method
    ? new Promise((_resolve, reject) => { rejectSave = reject; }) : result });
  try {
    await workspace.activate("breaches"); await host.fire("click", { target: host.querySelector('[data-po-action="record_notification"]') });
    const form = host.querySelector("[data-po-decision-form]");
    form.elements.namedItem("sentAt").value = "2026-10-05T10:00:00+02:00"; form.elements.namedItem("evidenceReference").value = "SYNTHETIC-RECEIPT";
    const fields = form.querySelectorAll("input,textarea,select"), saving = host.fire("submit", { target: form, preventDefault() {} });
    assert.ok(fields.length > 0); assert.ok(fields.every(field => field.disabled === true));
    rejectSave(Error("Entscheidung nicht gespeichert")); await saving;
    assert.ok(fields.every(field => !field.disabled)); assert.equal(form.elements.namedItem("evidenceReference").value, "SYNTHETIC-RECEIPT");
    assert.equal(host.querySelector("[data-po-decision]").open, true);
  } finally { workspace.destroy(); }
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseDocument } = require("htmlparser2");
const UI = require("../public/security-audits");
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

const user = (changes = {}) => ({ employeeNumber: "SYNTHETIC-AUDITOR", accountId: "synthetic-account", role: "developer", isEmployee: true, accountType: "employee", sessionKind: "employee", permissions: ["security_audits:read", "security_audits:manage"], ...changes });
const catalog = [
  { id: "1.1.1", chapterId: "V1", chapter: "Synthetic chapter", section: "Synthetic section", title: "Synthetic requirement A", level: 1 },
  { id: "1.1.2", chapterId: "V1", chapter: "Synthetic chapter", section: "Synthetic section", title: "Synthetic requirement B", level: 2 },
  { id: "1.1.3", chapterId: "V1", chapter: "Synthetic chapter", section: "Synthetic section", title: "Synthetic requirement C", level: 3 },
  { id: "1.1.4", chapterId: "V1", chapter: "Synthetic chapter", section: "Synthetic section", title: "Synthetic requirement D", level: 3 },
];
function audit(changes = {}) {
  return { id: "SYNTHETIC-RUN", title: "Synthetischer Prüfstand", standardVersion: "5.0.0", performedAt: "2026-10-18", auditor: "Synthetische Prüfung", scope: "Synthetischer isolierter Test", target: { commit: "a".repeat(40), version: "0.0.0-synthetic", environment: "local" }, limitations: ["Kein Produktivnachweis"], checks: [{ requirementId: "1.1.1", status: "passed", method: "automated_test", note: "Synthetischer Testbeleg", evidence: [{ kind: "test", reference: "synthetic/test", summary: "Synthetisch" }] }], findings: [{ id: "SYNTHETIC-FINDING", title: "Synthetischer Befund", priority: "P2", severity: "medium", status: "open", confidence: "hypothesis", requirementIds: ["1.1.2"], description: "Synthetische Beobachtung", impact: "Synthetische Auswirkung", recommendation: "Gezielt prüfen", acceptance: "Nachweis erbringen", owner: "", dueDate: "", note: "", retestEvidence: "" }], summary: { total: 4, inScope: 2, assessed: 1, passed: 1, failed: 0, partial: 0, notTested: 1, notApplicable: 0, blocked: 0 }, contentSha256: "b".repeat(64), ...changes };
}
const projection = (changes = {}) => ({ revision: 1, capabilities: { read: true, manage: true }, standard: { name: "OWASP ASVS", version: "5.0.0", targetLevel: 2, requirementCount: 4, sourceUrl: "https://owasp.org/projects/asvs", license: "CC-BY-SA-4.0" }, catalog, runs: [audit()], ...changes });
function tables() {
  const mounted = [];
  return { mounted, factory(options) {
    const result = { options, values: options.rows, destroyed: false, setRows(rows) { this.values = rows; }, refresh() {}, destroy() { this.destroyed = true; this.values = []; options.host.replaceChildren(); } };
    mounted.push(result); return result;
  } };
}
const action = (name, id) => ({ disabled: false, dataset: { saAction: name, saId: id }, closest(selector) { return selector === "[data-sa-action]" ? this : null; } });
const fireAction = (host, name, id) => host.fire("click", { target: action(name, id) });
const fireSubmit = host => host.fire("submit", { target: host.querySelector("[data-sa-form]"), preventDefault() {} });
function fill(form, values) { for (const [key, value] of Object.entries(values)) form.elements.namedItem(key).value = value; }

test("Audit access requires a personal eligible account and independent read/manage grants", () => {
  for (const role of ["admin", "it_admin", "developer"]) {
    assert.equal(UI.accessAllowed(user({ role })), true);
    assert.equal(UI.accessAllowed(user({ role, permissions: [] })), false);
    assert.equal(UI.accessAllowed(user({ role, permissions: ["security_audits:manage"] }), "security_audits:manage"), false);
    assert.equal(UI.accessAllowed(user({ role, permissions: ["security_audits:read"] }), "security_audits:manage"), false);
  }
  for (const overrides of [{ role: "hr" }, { role: "employee" }, { role: "manager" }, { employeeNumber: "local" }, { employeeNumber: "" }, { localSystem: true }, { accountType: "branch" }, { sessionKind: "local" }, { isEmployee: false }, { mustChangePassword: true }, { permissions: ["privacy_organization:read", "privacy_organization:manage"] }]) assert.equal(UI.accessAllowed(user(overrides)), false);
});

test("Canonical coverage keeps missing target requirements and explicit L3 checks visible", () => {
  const run = audit({ checks: [{ requirementId: "1.1.1", status: "partial", method: "code_review" }, { requirementId: "1.1.3", status: "blocked", method: "none" }] });
  const rows = UI.canonicalChecks(run, catalog);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.status), ["partial", "not_tested", "blocked", "out_of_scope"]);
  assert.deepEqual(rows.map(row => row.inScope), [true, true, true, false]);
  assert.equal(rows[1].title, catalog[1].title);
  assert.deepEqual(rows[1].evidence, []);
});

test("Audit calendar dates are not treated as missing timezone-bearing timestamps", () => {
  assert.match(UI.formatAuditDate("2026-10-18"), /18\.10\.2026/);
  assert.match(UI.formatAuditDate("2026-02-30"), /ungültig/);
  assert.match(UI.formatAuditDate(""), /nicht belegt/);
  assert.match(UI.formatInstant("2026-10-18T09:00:00Z"), /Wien/);
});

test("Untrusted finding and evidence values remain text and source links require safe HTTPS", () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const html = UI.findingMarkup({ ...audit().findings[0], title: hostile, description: hostile, owner: hostile, retestEvidence: hostile }) + UI.evidenceMarkup([{ kind: hostile, reference: "javascript:alert(1)", summary: hostile }]);
  assert.equal(allNodes(parseDocument(html)).some(node => ["script", "img"].includes(node.name)), false);
  assert.match(html, /&lt;img/);
  assert.equal(UI.safeSourceUrl("https://user:password@example.test/"), "");
  assert.equal(UI.safeSourceUrl("javascript:alert(1)"), "");
  assert.equal(UI.safeSourceUrl("https://example.test/source"), "https://example.test/source");
  const finding = UI.findingMarkup({ ...audit().findings[0], evidence: [{ kind: "code", reference: "synthetic/file:12", summary: hostile }], history: [{ status: "in_progress", at: "2026-10-18T09:00:00Z", actor: "SYNTHETIC", revision: 2, note: hostile, retestEvidence: hostile }] });
  assert.match(finding, /<h3>Belege<\/h3>/); assert.match(finding, /synthetic\/file:12/);
  assert.match(finding, /Änderungsverlauf \(1\)/);
  assert.equal(allNodes(parseDocument(finding)).some(node => ["script", "img"].includes(node.name)), false);
});

test("Import parsing preserves the original report and enforces the byte limit", () => {
  const run = audit();
  assert.deepEqual(UI.parseImport(JSON.stringify(run)), run);
  assert.deepEqual(UI.parseImport(JSON.stringify({ run })), run);
  assert.throws(() => UI.parseImport("{"), /gültiges JSON/);
  assert.throws(() => UI.parseImport('{"title":"wrong"}'), /checks und findings/);
  assert.throws(() => UI.parseImport(JSON.stringify(run), UI.MAX_IMPORT_BYTES + 1), /900 KiB/);
  assert.throws(() => UI.parseImport(JSON.stringify(audit({ scope: "ä".repeat(500000) }))), /900 KiB/);
  const withoutVersion = audit(); delete withoutVersion.standardVersion;
  assert.equal(UI.parseImport(JSON.stringify(withoutVersion)).standardVersion, undefined, "No silent default replaces required server validation");
});

test("Finding decisions need a reason, a retest for fixed and an owner plus expiry for acceptance", () => {
  const form = values => ({ elements: { namedItem: name => ({ value: values[name] || "" }) } });
  assert.throws(() => UI.findingChanges(form({ status: "in_progress" })), /Begründung/);
  assert.throws(() => UI.findingChanges(form({ status: "fixed", note: "Synthetic reason" })), /Nachprüfungsbeleg/);
  assert.throws(() => UI.findingChanges(form({ status: "risk_accepted", note: "Synthetic reason" })), /verantwortliche Person/);
  assert.throws(() => UI.findingChanges(form({ status: "risk_accepted", note: "Synthetic reason", owner: "Synthetic owner", dueDate: "2000-01-01" })), /zukünftiges Zieldatum/);
  assert.equal(UI.findingChanges(form({ status: "fixed", note: "Synthetic reason", retestEvidence: "Synthetic test at commit abc" })).status, "fixed");
});

test("Unauthorized users perform no reads; empty register gives an explicit empty state without a scan", async () => {
  let reads = 0;
  const unauthorizedHost = fixtureHost(), denied = UI.mount(unauthorizedHost, { user: user({ role: "hr" }), api: async () => { reads++; } });
  assert.equal(await denied.activate(), false); assert.equal(reads, 0); denied.destroy();
  const host = fixtureHost(), workspace = UI.mount(host, { user: user(), api: async () => { reads++; return projection({ runs: [] }); } });
  try {
    await workspace.activate();
    assert.match(host.textContent, /Noch kein Auditbericht erfasst/);
    assert.match(host.textContent, /keine Scans/);
    assert.equal(reads, 1);
    assert.equal(host.querySelector('[data-sa-action="import"]').hidden, false);
  } finally { workspace.destroy(); }
});

test("Read-only results use account-scoped shared tables and expose no import or edit controls", async () => {
  const host = fixtureHost(), shared = tables(), requests = [];
  const workspace = UI.mount(host, { user: user({ permissions: ["security_audits:read"] }), tableFactory: shared.factory, api: async (url, options = {}) => { requests.push({ url, options }); return projection({ capabilities: { read: true, manage: false } }); } });
  try {
    await workspace.activate();
    assert.equal(host.querySelector('[data-sa-action="import"]').hidden, true);
    assert.equal(shared.mounted[0].options.tableId, "security-audits-findings");
    assert.equal(shared.mounted[0].options.identity(), JSON.stringify(["synthetic-account", "SYNTHETIC-AUDITOR"]));
    await fireAction(host, "finding", "SYNTHETIC-FINDING");
    assert.match(host.textContent, /Synthetische Beobachtung/);
    assert.equal(host.querySelector('[data-sa-action="edit"]'), null);
    await fireAction(host, "import");
    assert.equal(host.querySelector('[data-sa-form="import"]'), null);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/security-audits");
  } finally { workspace.destroy(); }
});

test("Changing account while a read is pending cannot render sensitive previous results", async () => {
  const host = fixtureHost(), shared = tables(); let actor = user(), resolveRead;
  const workspace = UI.mount(host, { user: () => actor, tableFactory: shared.factory, api: async () => new Promise(resolve => { resolveRead = resolve; }) });
  try {
    const loading = workspace.activate(); actor = user({ employeeNumber: "OTHER", accountId: "other" });
    resolveRead(projection()); assert.equal(await loading, false);
    assert.equal(host.textContent, ""); assert.equal(shared.mounted.length, 0);
  } finally { workspace.destroy(); }
});

test("Suspend invalidates an old response and only the current activation can populate results", async () => {
  const host = fixtureHost(), shared = tables(), responses = [];
  const workspace = UI.mount(host, { user: user(), tableFactory: shared.factory, api: async () => new Promise(resolve => responses.push(resolve)) });
  try {
    const old = workspace.activate(); workspace.suspend(); const fresh = workspace.activate();
    responses[1](projection({ runs: [audit({ title: "CURRENT" })] })); await fresh;
    responses[0](projection({ runs: [audit({ title: "STALE" })] })); await old;
    assert.match(host.textContent, /CURRENT/); assert.doesNotMatch(host.textContent, /STALE/);
    assert.equal(shared.mounted.filter(table => !table.destroyed).length, 1);
  } finally { workspace.destroy(); }
});

test("Server 403 clears previous findings and presents a readable access message", async () => {
  const host = fixtureHost(), shared = tables(); let reject = false;
  const workspace = UI.mount(host, { user: user(), tableFactory: shared.factory, api: async () => { if (reject) throw Object.assign(Error("denied"), { status: 403 }); return projection(); } });
  try {
    await workspace.activate(); await fireAction(host, "finding", "SYNTHETIC-FINDING");
    assert.match(host.textContent, /Synthetische Beobachtung/);
    reject = true; await workspace.load();
    assert.doesNotMatch(host.textContent, /Synthetische Beobachtung|Synthetischer Prüfstand/);
    assert.match(host.textContent, /Zugriff.*verweigert/);
    assert.ok(shared.mounted.every(table => table.destroyed));
  } finally { workspace.destroy(); }
});

test("Local JSON import only posts after preview and explicit submission with the original revision", async () => {
  const host = fixtureHost(), shared = tables(), writes = [];
  const imported = audit({ id: "SYNTHETIC-IMPORTED", title: '<img src=x onerror="alert(1)">' });
  const workspace = UI.mount(host, { user: user(), tableFactory: shared.factory, api: async (_url, options = {}) => { if (!options.method) return projection({ runs: [] }); writes.push(JSON.parse(options.body)); return projection({ revision: 2, runs: [imported] }); } });
  try {
    await workspace.activate(); await fireAction(host, "import");
    const input = host.querySelector("[data-sa-file]"); input.files = [{ size: 1500, text: async () => JSON.stringify(imported) }];
    await host.fire("change", { target: input });
    assert.equal(writes.length, 0); assert.equal(host.querySelectorAll("img").length, 0);
    assert.match(host.textContent, /erst mit „Prüfbericht speichern“/);
    await fireSubmit(host);
    assert.deepEqual(writes[0], { action: "import", expectedRevision: 1, run: imported });
    assert.equal(workspace.hasUnsavedChanges(), false); assert.equal(host.querySelector("[data-sa-form]"), null);
  } finally { workspace.destroy(); }
});

test("A newly required password change clears loaded findings and drafts on reads and writes", async () => {
  for (const operation of ["read", "write"]) {
    const host = fixtureHost(), shared = tables(); let requirePassword = false;
    const workspace = UI.mount(host, { user: user(), tableFactory: shared.factory, api: async () => { if (requirePassword) throw Object.assign(Error("password change required"), { status: 428 }); return projection(); } });
    try {
      await workspace.activate(); await fireAction(host, "edit", "SYNTHETIC-FINDING");
      const form = host.querySelector("[data-sa-form]"); fill(form, { status: "in_progress", note: "CONFIDENTIAL SYNTHETIC DRAFT" });
      await host.fire("input", { target: form.elements.namedItem("note") }); requirePassword = true;
      if (operation === "read") await workspace.load(); else await fireSubmit(host);
      assert.equal(workspace.hasUnsavedChanges(), false); assert.equal(host.querySelector("[data-sa-form]"), null);
      assert.doesNotMatch(host.textContent, /CONFIDENTIAL SYNTHETIC DRAFT|Synthetischer Prüfstand|Synthetischer Befund/);
      assert.match(host.textContent, /Startpasswort ändern/); assert.ok(shared.mounted.every(table => table.destroyed));
    } finally { workspace.destroy(); }
  }
});

test("A delayed local file read is discarded after account switch", async () => {
  const host = fixtureHost(); let actor = user(), resolveFile;
  const workspace = UI.mount(host, { user: () => actor, api: async () => projection({ runs: [] }) });
  try {
    await workspace.activate(); await fireAction(host, "import");
    const input = host.querySelector("[data-sa-file]"); input.files = [{ size: 1000, text: () => new Promise(resolve => { resolveFile = resolve; }) }];
    const reading = host.fire("change", { target: input }); actor = user({ accountId: "OTHER" });
    resolveFile(JSON.stringify(audit())); await reading;
    assert.equal(host.textContent, ""); assert.equal(workspace.hasUnsavedChanges(), false);
  } finally { workspace.destroy(); }
});

test("A finding conflict preserves the entered reason and old write revision across refresh", async () => {
  const host = fixtureHost(), shared = tables(), writes = []; let revision = 1;
  const workspace = UI.mount(host, { user: user(), tableFactory: shared.factory, api: async (_url, options = {}) => { if (!options.method) return projection({ revision }); writes.push(JSON.parse(options.body)); throw Object.assign(Error("conflict"), { status: 409 }); } });
  try {
    await workspace.activate(); await fireAction(host, "edit", "SYNTHETIC-FINDING");
    const form = host.querySelector("[data-sa-form]"); fill(form, { status: "in_progress", owner: "Synthetische Verantwortung", note: "Synthetische Begründung" });
    await host.fire("input", { target: form.elements.namedItem("note") }); await fireSubmit(host);
    assert.match(form.querySelector("[data-sa-form-status]").textContent, /Registerstand hat sich geändert/);
    assert.equal(workspace.hasUnsavedChanges(), true); revision = 2; await workspace.load();
    assert.equal(form.elements.namedItem("note").value, "Synthetische Begründung");
    await fireSubmit(host);
    assert.equal(writes[1].expectedRevision, 1); assert.equal(writes[1].changes.note, "Synthetische Begründung");
    assert.equal(writes[1].action, "update_finding"); assert.equal(writes[1].runId, "SYNTHETIC-RUN");
  } finally { workspace.destroy(); }
});

test("Late writes after suspension cannot close or replace the retained finding draft", async () => {
  const host = fixtureHost(), shared = tables(); let resolveWrite;
  const workspace = UI.mount(host, { user: user(), tableFactory: shared.factory, api: async (_url, options = {}) => options.method ? new Promise(resolve => { resolveWrite = resolve; }) : projection() });
  try {
    await workspace.activate(); await fireAction(host, "edit", "SYNTHETIC-FINDING");
    const form = host.querySelector("[data-sa-form]"); fill(form, { status: "in_progress", note: "Synthetischer Entwurf" });
    const saving = fireSubmit(host); workspace.suspend();
    resolveWrite(projection({ revision: 2 })); await saving;
    assert.equal(workspace.hasUnsavedChanges(), true); assert.equal(host.querySelector("[data-sa-dialog]").open, false);
    assert.match(form.querySelector("[data-sa-form-status]").textContent, /Bereichswechsel/);
    await workspace.activate(); assert.equal(host.querySelector("[data-sa-dialog]").open, true);
    assert.equal(form.elements.namedItem("note").value, "Synthetischer Entwurf");
  } finally { workspace.destroy(); }
});

test("Filters keep canonical gaps visible and separate out-of-profile requirements", async () => {
  const host = fixtureHost(), shared = tables();
  const workspace = UI.mount(host, { user: user(), tableFactory: shared.factory, api: async () => projection() });
  try {
    await workspace.activate(); await host.fire("click", { target: host.querySelector('[data-sa-panel="checks"]') });
    const currentTable = shared.mounted.at(-1);
    assert.deepEqual(currentTable.values.map(row => row.status), ["passed", "not_tested"]);
    const profile = host.querySelector('[data-sa-filter="profile"]'); profile.value = "all"; await host.fire("change", { target: profile });
    assert.equal(currentTable.values.length, 4);
    const status = host.querySelector('[data-sa-filter="checkStatus"]'); status.value = "not_tested"; await host.fire("change", { target: status });
    assert.deepEqual(currentTable.values.map(row => row.id), ["1.1.2"]);
  } finally { workspace.destroy(); }
});

test("Expired risk acceptance remains distinct and actionable in filters, details and edits", async () => {
  const host = fixtureHost(), shared = tables();
  const expired = { ...audit().findings[0], status: "risk_accepted", effectiveStatus: "risk_acceptance_expired", riskAcceptanceExpired: true, overdue: true, owner: "Synthetic owner", dueDate: "2000-01-01" };
  const workspace = UI.mount(host, { user: user(), tableFactory: shared.factory, api: async () => projection({ runs: [audit({ findings: [expired] })] }) });
  try {
    await workspace.activate();
    const filter = host.querySelector('[data-sa-filter="findingStatus"]'); filter.value = "risk_acceptance_expired"; await host.fire("change", { target: filter });
    assert.equal(shared.mounted.at(-1).values.length, 1);
    filter.value = "risk_accepted"; await host.fire("change", { target: filter }); assert.equal(shared.mounted.at(-1).values.length, 0);
    await fireAction(host, "finding", "SYNTHETIC-FINDING"); assert.match(host.textContent, /Risikoakzeptanz abgelaufen/);
    assert.ok(host.querySelector(".security-audits-warning"));
    await fireAction(host, "edit", "SYNTHETIC-FINDING");
    assert.equal(host.querySelector("[data-sa-form]").elements.namedItem("status").value, "risk_accepted");
  } finally { workspace.destroy(); }
});

test("Before-unload protects unsaved drafts; destroy removes handlers and all finding data", async () => {
  const previousAdd = globalThis.addEventListener, previousRemove = globalThis.removeEventListener, listeners = new Map();
  globalThis.addEventListener = (name, handler) => listeners.set(name, handler); globalThis.removeEventListener = name => listeners.delete(name);
  const host = fixtureHost(), shared = tables(), workspace = UI.mount(host, { user: user(), tableFactory: shared.factory, api: async () => projection() });
  try {
    await workspace.activate(); await fireAction(host, "edit", "SYNTHETIC-FINDING");
    const input = host.querySelector("[data-sa-form]").elements.namedItem("note"); input.value = "Unsaved synthetic note";
    await host.fire("input", { target: input }); let prevented = false;
    listeners.get("beforeunload")({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
    workspace.destroy(); assert.equal(host.textContent, ""); assert.equal(listeners.size, 0);
  } finally { workspace.destroy(); if (previousAdd === undefined) delete globalThis.addEventListener; else globalThis.addEventListener = previousAdd; if (previousRemove === undefined) delete globalThis.removeEventListener; else globalThis.removeEventListener = previousRemove; }
});

test("The audit module does not store report content or search terms in browser persistence", () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/security-audits.js"), "utf8");
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|\.setItem\(/);
  assert.match(source, /RightsSettingsTable/);
  assert.doesNotMatch(source, /GP-SEC-01|f40271d|uploader_credentials/);
});

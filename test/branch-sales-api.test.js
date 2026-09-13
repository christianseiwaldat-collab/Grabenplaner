"use strict";
const assert = require("node:assert/strict"), test = require("node:test");
const crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-branch-sales-"));
const key = Buffer.alloc(32, 57);
Object.assign(process.env, { DB_PATH: path.join(root, "demo.db"), BACKUP_DIR: path.join(root, "backups"),
  GRABENPLANER_DATA_DIR: path.join(root, "data"), GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1",
  GRABENPLANER_INTEGRATION_KEY_ID: "branch-sales-test", GRABENPLANER_INTEGRATION_KEY: key.toString("base64"), NODE_ENV: "test" });
const { app, db, releaseInstanceLockForTests, installationFeaturesForApiPath } = require("../server");
const { createIntegrationSecretVault } = require("../lib/integration-secret-vault");
const { BRANCH_ARTICLES_PERMISSION: A, BRANCH_RECEIPTS_PERMISSION: R } = require("../lib/branch-sales-access");
const vault = createIntegrationSecretVault({ activeKeyId: "branch-sales-test", keys: { "branch-sales-test": key } });
let server, url, hr, branch, accountId, ids;
const account = permissions => ({ loginName: "suche-demo", displayName: "Suche Demo", accountType: "branch", active: true,
  password: "Lokale-Suche-Test!", permissions, scopes: [{ locationId: "93" }] });
async function request(route, { method = "GET", body, session = branch, raw = false } = {}) {
  const response = await fetch(url + route, { method, headers: { "Content-Type": "application/json", ...(session?.cookie ? { Cookie: session.cookie } : {}),
    ...(session?.csrf ? { "X-CSRF-Token": session.csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = raw ? Buffer.from(await response.arrayBuffer()) : await response.json();
  return { status: response.status, data, headers: response.headers };
}
const post = (suffix, body, options = {}) => request("/api/portal/v1/branch-receipts/" + suffix, { method: "POST", body, ...options });
const query = { dateFrom: "2026-09-01", dateTo: "2026-09-13" };
async function login() {
  const result = await request("/api/portal/v1/auth/login", { method: "POST", session: null, body: { loginName: account([]).loginName, password: account([]).password } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const cookies = result.headers.getSetCookie().map(v => v.split(";", 1)[0]);
  return { cookie: cookies.join("; "), csrf: decodeURIComponent(cookies.find(v => v.startsWith("grabenplaner_csrf=")).split("=")[1]) };
}
async function enable(permissions, extra = {}) {
  const result = await request("/api/portal/v1/organization-accounts/" + accountId, { method: "PUT", session: hr, body: { ...account(permissions), password: "", ...extra } });
  assert.equal(result.status, 200, JSON.stringify(result.data)); branch = await login();
  return result.data.account;
}
test.before(async () => {
  for (const id of ["93", "94"]) db.prepare("INSERT INTO locations (id,name,min_staff,active) VALUES (?,?,0,1)").run(id, "Demo-Filiale " + id);
  db.exec("INSERT INTO employees (personnel_number,full_name,nickname,color,contracted_hours,home_location_id,active) VALUES ('sales-hr','Demo Leitung','Demo','#287a67',38.5,'93',1)");
  db.exec("INSERT INTO portal_users (employee_number,password_hash,role,active,must_change_password) VALUES ('sales-hr','test-only','hr',1,0)");
  const token = crypto.randomBytes(32).toString("hex"), csrf = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO portal_sessions (id,employee_number,token_hash,expires_at) VALUES (?,'sales-hr',?,'2099-12-31T23:59:59.000Z')")
    .run(crypto.randomUUID(), crypto.createHash("sha256").update(token).digest("hex"));
  hr = { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); }); url = "http://127.0.0.1:" + server.address().port;
  const created = await request("/api/portal/v1/organization-accounts", { method: "POST", session: hr, body: account([]) });
  assert.equal(created.status, 201, JSON.stringify(created.data)); accountId = created.data.account.id; branch = await login();
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  db.close(); releaseInstanceLockForTests();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("gp-branch-sales-")); fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Artikelsuche und Belegsuche im echten Filialportal", async t => {
  await t.test("beide Funktionen sind standardmäßig aus und erfordern eine Anmeldung", async () => {
    for (const route of ["/api/portal/v1/branch-articles", "/api/portal/v1/branch-receipts/context"]) {
      assert.equal((await request(route)).status, 403); assert.equal((await request(route, { session: null })).status, 401);
    }
    for (const suffix of ["search", "documents", "export.pdf"]) assert.equal((await post(suffix, {})).status, 403);
    const catalog = await request("/api/portal/v1/organization-accounts", { session: hr });
    assert.ok(JSON.stringify(catalog.data).includes(A)); assert.ok(JSON.stringify(catalog.data).includes(R));
  });
  await t.test("Artikelfreischaltung öffnet nur die Artikelsuche", async () => {
    const saved = await enable([A]); assert.ok(saved.permissions.includes(A)); assert.ok(!saved.permissions.includes(R));
    assert.equal((await request("/api/portal/v1/branch-articles")).status, 200);
    assert.equal((await post("search", query)).status, 403);
    assert.equal((await request("/api/sales/articles")).status, 403);
    assert.equal((await request("/api/receipt-search/context")).status, 403);
  });
  await t.test("Belegfreischaltung öffnet nur Belege und erklärt einen fehlenden Kassenstand", async () => {
    await enable([R]); assert.equal((await request("/api/portal/v1/branch-articles")).status, 403);
    const context = await request("/api/portal/v1/branch-receipts/context"); assert.equal(context.status, 200); assert.equal(context.data.available, false);
    assert.equal((await post("search", query)).status, 503);
    ids = await require("./fixtures/branch-sales-data").seedBranchSalesData({ databasePath: process.env.DB_PATH, vault });
    await enable([A, R]);
  });
  await t.test("Artikelnummer, Bezeichnung, EAN, Archiv und Seitengrenzen nutzen den gemeinsamen Katalog", async () => {
    for (const value of ["00042", "Aurora", "4006381333931"]) {
      const result = await request("/api/portal/v1/branch-articles?query=" + encodeURIComponent(value));
      assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.items.length, 1);
      assert.equal(result.data.items[0].articleNumber, "00042");
      assert.equal(Number(result.data.items[0].retailGross), 249.9); assert.equal(Number(result.data.items[0].internetGross), 239);
      assert.doesNotMatch(JSON.stringify(result.data), /purchase|123\.456789|createdBy|sourceSnapshot|currentRevision/);
    }
    const first = (await request("/api/portal/v1/branch-articles")).data;
    const second = (await request("/api/portal/v1/branch-articles?offset=20")).data;
    assert.equal(first.total, 42); assert.equal(first.items.length, 20); assert.equal(second.items.length, 20);
    assert.ok(second.items.every(item => !first.items.some(other => other.articleNumber === item.articleNumber)));
    const archive = await request("/api/portal/v1/branch-articles?status=inactive"); assert.equal(archive.data.total, 1); assert.equal(archive.data.items[0].active, false);
    assert.equal((await request("/api/portal/v1/branch-articles?query=not-existing")).data.total, 0);
  });
  await t.test("Belegkontext, Nummern- und Positionssuche bleiben auf die Konto-Filiale begrenzt", async () => {
    const context = await request("/api/portal/v1/branch-receipts/context"); assert.equal(context.data.location.id, "93");
    assert.doesNotMatch(JSON.stringify(context.data), /94|customer|personnel/);
    const result = await post("search", query); assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.items.length, 20); assert.ok(result.data.next);
    const second = await post("search", { ...query, cursor: result.data.next }); assert.equal(second.data.items.length, 5); assert.equal(second.data.next, null);
    for (const rows of [result.data.items, second.data.items]) assert.ok(rows.every(item => item.locationId === "93"));
    assert.doesNotMatch(JSON.stringify(result.data.items), /FOREIGN|090077|090078|personnel|customer/);
    for (const filter of [{ receipt: "10001" }, { receipt: "5001" }, { query: "00042" }]) {
      const found = await post("search", { ...query, ...filter }); assert.equal(found.status, 200); assert.ok(found.data.items.length);
    }
    assert.equal((await post("search", { ...query, receipt: "10025" })).data.items.length, 0);
    assert.ok((await post("search", { ...query, query: "FOREIGN-RECEIPT-SECRET" })).data.items.length === 0);
  });
  await t.test("Detail und PDF enthalten vollständige eigene Positionen ohne Kunden- und Personaldaten", async () => {
    const detail = await post("documents", { ids: [ids.ownId] }); assert.equal(detail.status, 200, JSON.stringify(detail.data));
    assert.equal(detail.data.items[0].lines.length, 1); assert.equal(detail.data.items[0].lines[0].quantity, "2");
    assert.doesNotMatch(JSON.stringify(detail.data), /090077|090078|personnel|customer|FOREIGN/);
    const pdf = await post("export.pdf", { ids: [ids.ownId] }, { raw: true }); assert.equal(pdf.status, 200);
    assert.equal(pdf.data.subarray(0, 5).toString(), "%PDF-"); assert.match(pdf.headers.get("content-type"), /application\/pdf/);
    assert.match(pdf.headers.get("content-disposition"), /attachment/); assert.match(pdf.headers.get("cache-control"), /no-store/);
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({ data: new Uint8Array(pdf.data), isEvalSupported: false }), document = await task.promise;
    const text = (await (await document.getPage(1)).getTextContent()).items.map(item => item.str).join(" "); await task.destroy();
    assert.match(text, /Beleginformation - keine Rechnung/); assert.match(text, /499,80/); assert.match(text, /Kamera Aurora/);
    assert.doesNotMatch(text, /090077|090078|FOREIGN|Personalnummer/);
    if (process.env.BRANCH_SALES_PDF_QA) { fs.mkdirSync(path.dirname(process.env.BRANCH_SALES_PDF_QA), { recursive: true }); fs.writeFileSync(process.env.BRANCH_SALES_PDF_QA, pdf.data); }
  });
  await t.test("fremde Beleg-IDs, fehlendes CSRF und manipulierte Filter werden abgewiesen", async () => {
    for (const suffix of ["documents", "export.pdf"]) {
      assert.equal((await post(suffix, { ids: [ids.foreignId] })).status, 403);
      assert.equal((await post(suffix, { ids: [ids.ownId] }, { session: { cookie: branch.cookie } })).status, 403);
      assert.equal((await post(suffix, { ids: [ids.ownId, ids.foreignId] })).status, 422);
    }
    for (const spoof of [{ locationId: "94" }, { sourceId: "another" }, { kind: "journal" }, { seller: "090077" }, { customer: "090078" }, { projection: { company: true } }]) {
      assert.equal((await post("search", { ...query, ...spoof })).status, 422);
    }
    for (const route of ["?locationId=94", "?query[]=x", "?offset=-1", "?sort=purchaseNet"]) {
      assert.ok([400, 422].includes((await request("/api/portal/v1/branch-articles" + route)).status));
    }
    for (const invalid of [{ dateFrom: "2026-02-30" }, { dateTo: "2099-01-01" }, { dateTo: "2026-08-01" }]) assert.equal((await post("search", { ...query, ...invalid })).status, 422);
  });
  await t.test("Rechteentzug beendet alte Sitzungen; ein frisch angemeldetes Konto kann keine alten PDFs laden", async () => {
    const old = branch; await enable([A]);
    assert.equal((await post("export.pdf", { ids: [ids.ownId] }, { session: old })).status, 401);
    assert.equal((await post("export.pdf", { ids: [ids.ownId] })).status, 403);
    assert.equal((await request("/api/portal/v1/branch-articles")).status, 200);
    await enable([R]); assert.equal((await request("/api/portal/v1/branch-articles")).status, 403);
  });
  await t.test("Rechte, Konto und Filiale werden nach asynchronem Beleglesen erneut geprüft", async () => {
    const { openSqliteApplicationPersistence } = require("../lib/persistence/sqlite/provider");
    const { SQLITE_APPLICATION_CATALOG } = require("../lib/persistence/sqlite/application-catalog");
    const reader = openSqliteApplicationPersistence({ databasePath: process.env.DB_PATH, catalog: SQLITE_APPLICATION_CATALOG });
    try {
      const runtime = require("../lib/persistence/repositories/branch-receipt-runtime").createBranchReceiptRuntime({ access: reader.provider, vault });
      const initial = { id: "synthetic-session", sessionKind: "organization", isEmployee: false, accountType: "branch", accountId,
        employeeNumber: null, permissions: [R], scopes: [{ locationId: "93", departmentId: null }] };
      for (const change of [{ permissions: [] }, { accountId: "other-account" }, { scopes: [{ locationId: "94" }] }, { id: "other-session" }]) {
        let current = initial;
        await assert.rejects(runtime.run(async () => current, async workspace => {
          const document = await workspace.receipts.documents({ ids: [ids.ownId] });
          current = { ...initial, ...change }; return document;
        }), e => e.status === 403);
      }
      const context = await runtime.run(async () => initial, workspace => workspace.context()); assert.equal(context.location.id, "93");
    } finally { await reader.provider.close(); reader.database.close(); }
  });
  await t.test("Hintergrundleser behält Filialgrenzen, Seitenwechsel und Datenstand; Rechteentzug stoppt die Ausgabe", async () => {
    const { openSqliteApplicationPersistence } = require("../lib/persistence/sqlite/provider");
    const { SQLITE_APPLICATION_CATALOG } = require("../lib/persistence/sqlite/application-catalog");
    const reader = openSqliteApplicationPersistence({ databasePath: process.env.DB_PATH, catalog: SQLITE_APPLICATION_CATALOG });
    const workers = Array.from({ length: 2 }, () => require("../lib/sales-report-batch-worker").createSalesReportBatchWorker({
      databasePath: process.env.DB_PATH, keyConfiguration: { activeKeyId: "branch-sales-test", keys: { "branch-sales-test": key } },
      workerFile: path.resolve(__dirname, "../test-support/branch-sales-worker.cjs"), today: "2026-09-13" }));
    let current = { id: "worker-session", sessionKind: "organization", isEmployee: false, accountType: "branch", accountId,
      permissions: [R], scopes: [{ locationId: "93" }] }, sent, revoke = false, sequence = 0;
    const read = input => workers[sequence++ % workers.length].run(input);
    const runtime = require("../lib/persistence/repositories/branch-receipt-runtime").createBranchReceiptRuntime({ access: reader.provider, vault,
      dispatchRead: async input => { sent = input; const result = await read(input); if (revoke) current = { ...current, permissions: [] }; return result; } });
    try {
      const run = work => runtime.run(async () => current, work);
      const search = { ...query, sourceId: "compact-cash", locationId: "93", sort: "date", direction: "desc", limit: 20 };
      const first = await run(w => w.receipts.search(search)); assert.equal(first.items.length, 20);
      const second = await run(w => w.receipts.search({ ...search, cursor: first.next })); assert.equal(second.items.length, 5);
      assert.ok([...first.items, ...second.items].every(item => item.locationId === "93"));
      const detail = await run(w => w.receipts.documents({ ids: [ids.ownId] })); assert.equal(detail.items[0].lines.length, 1);
      assert.doesNotMatch(JSON.stringify(detail), /FOREIGN|090077|090078/);
      await assert.rejects(read({ ...sent, sourceRevision: "outdated" }), e => e.code === "IMPORT_HISTORY_RESULTS_CHANGED");
      await assert.rejects(run(w => w.receipts.documents({ ids: [ids.foreignId] })), e => e.code === "IMPORT_FORBIDDEN");
      revoke = true;
      await assert.rejects(run(w => w.receipts.documents({ ids: [ids.ownId] })), e => e.status === 403);
    } finally { await Promise.all(workers.map(worker => worker.stop())); await reader.provider.close(); reader.database.close(); }
  });
  await t.test("Mehrfachzuordnung und inaktive Filialen erlauben keine neue Suche", async () => {
    await enable([A, R], { scopes: [{ locationId: "93" }, { locationId: "94" }] });
    assert.equal((await request("/api/portal/v1/branch-articles")).status, 403);
    assert.equal((await post("search", query)).status, 403);
    await enable([A, R]); db.exec("UPDATE locations SET active=0 WHERE id='93'");
    try { assert.equal((await post("export.pdf", { ids: [ids.ownId] })).status, 403); }
    finally { db.exec("UPDATE locations SET active=1 WHERE id='93'"); }
  });
  await t.test("persönliche und Terminalkonten erhalten keinen Zugang durch die neuen Schalter", async () => {
    assert.equal((await request("/api/portal/v1/branch-articles", { session: hr })).status, 403);
    const terminal = await request("/api/portal/v1/organization-accounts", { method: "POST", session: hr,
      body: { ...account([A, R]), loginName: "search-terminal", accountType: "terminal" } }); assert.equal(terminal.status, 403);
    assert.deepEqual(installationFeaturesForApiPath("/portal/v1/branch-articles"), ["employeePortal"]);
    assert.deepEqual(installationFeaturesForApiPath("/portal/v1/branch-receipts/export.pdf"), ["employeePortal"]);
  });
});

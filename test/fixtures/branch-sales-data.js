"use strict";

// Synthetic local fixture only. No source Access files or productive databases.
const crypto = require("node:crypto");
const C = require("../../lib/data-import-contract");
const H = require("../../lib/tradefoto-history-profiles");
const { openSqliteApplicationPersistence } = require("../../lib/persistence/sqlite/provider");
const { SQLITE_APPLICATION_CATALOG } = require("../../lib/persistence/sqlite/application-catalog");
const { createSalesArticleCatalogRepository } = require("../../lib/persistence/repositories/sales-article-catalog");
const { salesArticleImportContentSha256 } = require("../../lib/sales-article-catalog");
const { loadManagedDataImportProtection } = require("../../lib/data-import-managed-protection");
const { createCashSnapshotStore } = require("../../lib/persistence/repositories/cash-snapshots");
const { createCashPublicationRuntime } = require("../../lib/persistence/repositories/cash-publication-runtime");
const { CASH_SNAPSHOT_TABLES: TABLES } = require("../../lib/persistence/statements/cash-snapshots");
const { CASH_SOURCE_POLICIES } = require("../../lib/cash-source-policies");
const { createManagedSalesHistoryRuntime } = require("../../lib/persistence/repositories/sales-history-runtime");
const TIME = "2026-09-13T12:00:00.000Z";
const digest = text => crypto.createHash("sha256").update(text).digest("hex");
const raw = (name, values) => ({ ...Object.fromEntries(H.tableFor("cash", name).columns.map(c => [c.name, null])), ...values });

async function seedBranchSalesData({ databasePath, vault, ownLocation = "93", otherLocation = "94", replacePreview = false }) {
  const app = openSqliteApplicationPersistence({ databasePath, catalog: SQLITE_APPLICATION_CATALOG });
  let protection;
  try {
    const catalog = createSalesArticleCatalogRepository(app.provider);
    const articles = Array.from({ length: 43 }, (_, i) => ({ sourceArticleKey: String(i + 1), articleNumber: String(i + 42).padStart(5, "0"),
      description: i === 0 ? "Kamera Aurora 24 – Vorführmodell" : i === 1 ? "Objektiv 35 mm – Café Edition" : `Kamerazubehör Muster ${i + 1}`,
      active: i !== 2, sourceUpdatedAt: null,
      identifiers: i ? [] : [{ identifierType: "ean13", identifierValue: "4006381333931", isPrimary: true, sourceField: "EAN", sourceRank: 1 }],
      prices: [
        { priceType: "sales", priceBasis: "gross", amount: "249.90", currency: "EUR", sourceField: "VK_Preis", qualityStatus: "confirmed" },
        { priceType: "internet_1", priceBasis: "gross", amount: "239.00", currency: "EUR", sourceField: "Internet", qualityStatus: "confirmed" },
        { priceType: "average_purchase", priceBasis: "net", amount: "123.456789", currency: "EUR", sourceField: "EK", qualityStatus: "confirmed" },
      ] }));
    await catalog.importSnapshot({ snapshot: { sourceSystem: "tradefoto.artikel_stamm", sourceProfileVersion: "branch-demo-v1",
      sourceSchemaSha256: digest("branch-demo-schema"), sourceFileSha256: digest("branch-demo-articles"), contentSha256: salesArticleImportContentSha256(articles),
      snapshotAt: TIME, articles }, actor: "synthetic-demo", timestamp: TIME });
    protection = await loadManagedDataImportProtection({ access: app.provider, vault, create: true, clock: () => TIME });
    await require('./branch-article-details').seedBranchArticleDetails({ access: app.provider, protection, ownLocation, otherLocation });
    const actor = { scopeId: "grabenplaner-main", ownerId: "synthetic-admin" };
    const session = { employeeNumber: actor.ownerId, accountId: null, isEmployee: true, permissions: [
      "data:imports:read", "data:imports:prepare", "data:imports:apply", "sales:analytics:access", "sales:analytics:company:read", "sales:history:read", "locations:write",
    ], locations: [], authorizedLocationIds: [] };
    const data = { Umsatz_KASSE: [], Umsatz_Kasse_Details: [] };
    const locations = [...Array(25).fill('093'), '094', '05', '11', '13', '18', '77', '99', '0', '03', '70', '90', 'UNKNOWN'];
    for (let i = 0; i < locations.length; i++) {
      const foreign = i >= 25, location = locations[i];
      const head = raw("Umsatz_KASSE", { Bonnr: String(10000 + i), Filialid: location, Kassenid: "01", Bondatum: "2026-09-10T00:00:00.000",
        VerkäuferID: i === 0 ? '00012' : i === 1 ? '34' : i === 2 ? '112' : "090077", KUND_NR: i === 1 ? '090079' : i === 23 ? '0' : "090078", RechnungsNr: String(5000 + i), RechnungsBetrag: "0" });
      data.Umsatz_KASSE.push(head);
      data.Umsatz_Kasse_Details.push(raw("Umsatz_Kasse_Details", { Bonnr: head.Bonnr, Filialid: location, Kassenid: head.Kassenid, Bondatum: head.Bondatum,
        RepID: "00000000-0000-0000-0000-" + String(i + 1).padStart(12, "0"), EAN: "00042", VKMenge: "2", VK_Preis: "249.9", MWST: "20",
        Verkäuferid: "999", Artikelbezeichnung: foreign ? "Kamera Demo · Filiale " + location : "Kamera Aurora 24 – Vorführmodell", ...CASH_SOURCE_POLICIES[0].policy.statusRules[3].flags }));
    }
    const fileSha256 = C.fingerprint(data), id = protection.digest(["source", actor, "cash", fileSha256]);
    const store = createCashSnapshotStore({ access: app.provider, protection, actor, clock: () => TIME });
    await store.begin(id, { kind: "cash", fileSha256, bytes: 4096, tables: TABLES.map(t => ({ name: t.name, profileHash: t.profile.fingerprint, declaredRows: data[t.name]?.length || 0 })) });
    for (const table of TABLES) {
      const source = data[table.name] || [];
      await store.startTable(id, table.name, source.length);
      if (source.length) await store.append(id, table.name, 1, source.map((row, i) => H.prepareTradeFotoHistoryRow("cash", table.name, row, { fileSha256, rowNumber: i + 1 })));
      await store.finishTable(id, table.name);
    }
    let result = await store.seal(id, { tables: TABLES.length, rows: locations.length * 2 });
    while (result.status === "reviewing") result = await store.review(id);
    const policy = { ...CASH_SOURCE_POLICIES[0], fileSha256 };
    const publisher = createCashPublicationRuntime({ access: app.provider, vault, policies: [policy], scopeId: actor.scopeId, enabled: true, clock: () => TIME });
    const expectedRevision = replacePreview ? (await publisher.operation(async () => session, 'context', { sourceId: id })).state.revision : 0;
    const request = { sourceId: id, expectedRevision, label: "Synthetischer Kassenstand · Demo", policyId: policy.id, resolveArticles: false,
      mappings: [{ kind: "FILIALEN", sourceId: "093", targetId: ownLocation, historical: false }, ...['094', '03', '70'].map(sourceId => ({ kind: 'FILIALEN', sourceId, targetId: otherLocation, historical: false }))] };
    const preview = await publisher.operation(async () => session, "preview", { request });
    await publisher.operation(async () => session, "activate", { request, planHash: preview.planHash });
    const runtime = createManagedSalesHistoryRuntime({ access: app.provider, vault, cashEnabled: true, today: () => "2026-09-13" });
    return await runtime.run(async () => session, async workspace => {
      const found = await workspace.receipts.search({ sourceId: "compact-cash", dateFrom: "2026-09-01", dateTo: "2026-09-13", limit: 100 });
      const ownId = found.items.find(item => item.locationId === ownLocation).id;
      return { ownId, foreignId: found.items.find(item => item.receipt === '10025').id,
        unassignedId: ownId.replace(/\d{10}$/, String(locations.length).padStart(10, '0')) };
    });
  } finally { protection?.destroy(); await app.provider.close(); app.database.close(); }
}

async function enrichBranchSalesData({ databasePath, vault }) {
  const app = openSqliteApplicationPersistence({ databasePath, catalog: SQLITE_APPLICATION_CATALOG });
  let protection;
  try {
    protection = await loadManagedDataImportProtection({ access: app.provider, vault, create: false });
    await require('./branch-article-details').seedBranchArticleDetails({ access: app.provider, protection });
  } finally { protection?.destroy(); await app.provider.close(); app.database.close(); }
}
module.exports = { seedBranchSalesData, enrichBranchSalesData };

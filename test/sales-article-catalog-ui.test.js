"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const functionSearchCatalog = fs.readFileSync(
  path.join(root, "public", "function-search-catalog.js"),
  "utf8",
);

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Artikelstamm ist ein eigener berechtigungsgeschützter Verkaufsbereich", () => {
  const navigation = between(
    html,
    '<section class="nav-module hidden" id="salesAdministrationNav"',
    "</nav>",
  );
  assert.match(navigation, /id="salesArticleCatalogNavButton"[^>]*data-view="articleCatalog"|data-view="articleCatalog"[^>]*id="salesArticleCatalogNavButton"/);
  assert.match(navigation, /<span>Artikelstamm<\/span>/);

  const landing = between(html, '<section id="salesAdministrationView"', '<section id="crmView"');
  assert.match(landing, /id="salesArticleCatalogDashboardCard"[^>]*data-sales-dashboard-view="articleCatalog"/);
  assert.match(landing, /id="salesArticleCatalogView"[^>]*aria-labelledby="salesArticleCatalogTitle"/);

  assert.match(app, /function canAccessSalesArticleCatalog\(\)[\s\S]*sales:articles:access/);
  assert.match(app, /function canReadSalesArticles\(\)[\s\S]*canAccessSalesArticleCatalog\(\)[\s\S]*sales:articles:read/);
  assert.match(app, /salesArticleCatalogNavButton\?\.classList\.toggle\("hidden", !salesArticleCatalogAccess\)/);
  assert.match(app, /salesArticleCatalogDashboardCard\?\.classList\.toggle\("hidden", !salesArticleCatalogAccess\)/);
  assert.match(app, /view === "articleCatalog" && !canAccessSalesArticleCatalog\(\)/);
  assert.match(app, /elements\.salesArticleCatalogView\?\.classList\.toggle\("active", view === "articleCatalog"\)/);
});

test("Artikelsuche verwendet nur bestätigte Listenfelder und den serverseitigen Vertrag", () => {
  const view = between(html, '<section id="salesArticleCatalogView"', '<section id="crmView"');
  assert.match(view, /<span>Artikelnummer oder Bezeichnung<\/span><input id="salesArticleSearchQuery"/);
  assert.match(view, /placeholder="z\. B\. Sony A7\* 24-105mm"/);
  assert.match(view, /id="salesArticleAdvancedSearch"/);
  assert.match(view, /id="salesArticleSearchIdentifier"[^>]*pattern="\[0-9\]\{1,14\}"/);
  assert.match(view, /id="salesArticleSearchStatusFilter"/);
  assert.match(view, /id="salesArticleSearchSourceSystem"/);
  assert.match(view, /value="manual\.article-catalog">Manuelle Pflege/);
  assert.match(view, /value="legacy\.loan_articles">Übernommene Leihartikel/);
  assert.match(app, /value === "legacy\.loan_articles"\) return "Übernommene Leihartikel"/);
  assert.match(app, /value === "manual\.article-catalog"\) return "Manuelle Pflege"/);
  assert.doesNotMatch(view, /Marke|Lieferant|Warengruppe|Verkaufspreis|Einkaufspreis/);

  const parameters = between(
    app,
    "function salesArticleCatalogSearchParameters(offset)",
    "async function loadSalesArticleCatalog",
  );
  for (const parameter of ["query", "identifier", "status", "sourceSystem", "sort", "direction", "limit", "offset"]) {
    assert.match(parameters, new RegExp(`parameters\\.set\\("${parameter}"`));
  }
  assert.match(app, /api\(`\/api\/sales\/articles\?\$\{salesArticleCatalogSearchParameters\(offset\)\}`\)/);
  assert.match(app, /"articleNumber", label: "Artikelnummer"/);
  assert.match(app, /"description", label: "Bezeichnung"/);
  assert.match(app, /"primaryIdentifier", label: "EAN \/ GTIN"/);
  assert.match(app, /"status", label: "Status"/);
  assert.match(app, /"sourceSystem", label: "Quellsystem"/);
});

test("Ergebnisfeld startet mit zehn Zeilen, erlaubt 5 bis 20 und behält wählbare sortierbare Köpfe", () => {
  const view = between(html, '<section id="salesArticleCatalogView"', '<section id="crmView"');
  assert.match(view, /id="salesArticleResultsToggle"[^>]*aria-controls="salesArticleResultsBody"[^>]*aria-expanded="true"/);
  assert.match(view, /id="salesArticleTableScroll"[^>]*role="region"/);
  assert.match(view, /id="salesArticleTableHead"/);
  assert.match(view, /id="salesArticleTableBody"/);
  assert.match(view, /id="salesArticleSearchStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(view, /id="salesArticleLoadStatus"[^>]*(?:role="status"|aria-live=)/);

  assert.match(styles, /\.sales-article-table-scroll\s*\{[^}]*height:calc\(var\(--sales-article-header-height\) \+ \(10 \* var\(--sales-article-row-height\)\) \+ 1px\)[^}]*overflow:auto/s);
  assert.match(styles, /@media \(max-width:820px\) and \(any-pointer:fine\)[\s\S]*10 \* var\(--sales-article-row-height\)\) \+ 18px/);
  assert.match(styles, /\.sales-article-table th\s*\{[^}]*position:sticky[^}]*top:0/s);
  assert.match(styles, /\.sales-article-table th,.sales-article-table td\s*\{[^}]*white-space:nowrap/s);
  assert.match(app, /data-sales-article-sort=/);
  assert.match(app, /aria-sort=/);
  assert.match(app, /resultsExpanded = !state\.salesArticleCatalog\.resultsExpanded/);
  const headRenderer = between(app, "function renderSalesArticleCatalogHead", "function salesArticleCatalogVisibleWindow");
  assert.match(headRenderer, /querySelectorAll\("\[data-sales-article-sort\]"\)/);
  assert.match(headRenderer, /const columns = selectedSalesArticleColumns\(\)/);
  assert.match(headRenderer, /buttons\.map\(b => b\.dataset\.salesArticleSort\)\.join/);
  assert.match(view, /id="salesArticleResizeHandle"[^>]*aria-valuemin="5"[^>]*aria-valuemax="20"/);
  assert.match(styles, /\.sales-article-table-scroll\s*\{ min-height:0; max-height:none;/);
  assert.ok(view.indexOf('id="salesArticleSearchForm"') < view.indexOf('id="salesArticleActionsLogButton"'));
  assert.match(headRenderer, /button\.closest\("th"\)\?\.setAttribute/);
});

test("Weitere Seiten werden nur innerhalb der Ergebnisliste stabil nachgeladen", () => {
  assert.match(app, /salesArticleTableScroll\?\.addEventListener\("scroll"/);
  assert.match(app, /scrollArea\.scrollHeight - scrollArea\.scrollTop - scrollArea\.clientHeight/);
  assert.match(app, /loadSalesArticleCatalog\(\)/);
  assert.match(app, /const seen = new Set\(combined\.map\(salesArticleCatalogItemKey\)\)/);
  assert.match(app, /catalog\.nextOffset = incoming\.length \? responseOffset \+ incoming\.length : catalog\.total/);
  assert.match(app, /catalog\.loading \|\| !catalog\.searchStarted \|\| catalog\.nextOffset >= catalog\.total/);
  assert.match(app, /salesArticleResults\.setAttribute\("aria-busy", String\(catalog\.loading\)\)/);
  assert.match(app, /function salesArticleCatalogVisibleWindow\(itemCount\)/);
  assert.match(app, /catalog\.items\.slice\(start, end\)/);
  assert.match(app, /salesArticleCatalogSpacerRow\(start \* SALES_ARTICLE_CATALOG_ROW_HEIGHT/);
  assert.match(styles, /\.sales-article-spacer-row td\s*\{[^}]*max-height:none/s);

  const setView = between(app, "function setView(view)", "function applyRequestedView(");
  assert.match(setView, /view === "articleCatalog"\) \{[\s\S]*?renderSalesArticleCatalogResults\(\)/);
  assert.doesNotMatch(setView, /view === "articleCatalog"\) loadSalesArticleCatalog/);
  const bootstrap = between(app, "async function bootstrapApplication()", "async function loginToAdministration(event)");
  assert.doesNotMatch(bootstrap, /loadSalesArticleCatalog|\/api\/sales\/articles/);
});

test("ACCESS ohne READ zeigt die Fläche, sendet aber keine Artikeldaten-Anfrage", () => {
  assert.match(app, /function applySalesArticleCatalogReadState\(canRead = canReadSalesArticles\(\)\)/);
  assert.match(app, /control\.disabled = !canRead/);
  assert.match(app, /Für die Artikelsuche fehlt das Leserecht „sales:articles:read“/);
  assert.match(app, /if \(canRead && !state\.salesArticleCatalog\.searchStarted\)[\s\S]*Suchbegriff eingeben oder die erweiterte Suche verwenden/);
  const loader = between(app, "async function loadSalesArticleCatalog", "function changeSalesArticleCatalogSort");
  assert.match(loader, /if \(!canReadSalesArticles\(\)\) \{[\s\S]*return;/);
  assert.ok(loader.indexOf("if (!canReadSalesArticles())") < loader.indexOf("await api("));
  assert.match(app, /!salesArticleCatalogReadAccess && \(state\.salesArticleCatalog\.searchStarted \|\| state\.salesArticleCatalog\.items\.length\)/);
});

test("Login-Gate verwirft laufende Artikelsuchen und der erste Ladezustand bleibt eindeutig", () => {
  const loginGate = between(app, "function showLoginGate", "function hideLoginGate");
  assert.match(loginGate, /state\.salesArticleCatalog\.actorKey = ""/);
  assert.match(loginGate, /clearSalesArticleCatalogState\(\)/);

  const renderer = between(app, "function renderSalesArticleCatalogResults", "function salesArticleCatalogFormValues");
  assert.match(renderer, /if \(catalog\.loading && !loaded\)/);
  assert.match(renderer, /textContent = "Suche läuft …"/);
  assert.match(renderer, /textContent = "Treffer werden ermittelt\."/);
});

test("Globale Funktionssuche öffnet den freigegebenen Artikelstamm direkt", () => {
  assert.match(functionSearchCatalog, /"articleCatalog"/);
  assert.match(
    functionSearchCatalog,
    /entry\(\s*"sales\.article-catalog",[\s\S]*?\["salesArticleCatalogNavButton"\],[\s\S]*?\{ view: "articleCatalog", focusId: "salesArticleSearchQuery" \}/,
  );
});

test("Unter der Liste öffnet sich eine vollbreite lesende Artikelkartei", () => {
  const view = between(html, '<section id="salesArticleCatalogView"', '<section id="crmView"');
  assert.match(view, /id="salesArticleDetail"[^>]*aria-labelledby="salesArticleDetailTitle"[^>]*aria-busy="false"/);
  assert.match(view, /id="salesArticleDetailTitle"[^>]*tabindex="-1"/);
  assert.match(view, /id="salesArticleDetailNavigation"[^>]*aria-label="Bereiche der Artikelansicht"/);
  assert.match(view, /href="#salesArticleMasterDataSection"/);
  assert.match(view, /href="#salesArticleIdentifiersSection"/);
  assert.match(view, /href="#salesArticlePricesSection"/);
  assert.match(view, /href="#salesArticleHistorySection"/);
  assert.match(view, /id="salesArticleDetailStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(view, /Artikelstamm im Detail/);
  assert.doesNotMatch(view, /Artikel importieren|Lieferant|Filialwerte|Taxonomie|Warengruppe|Notizen|Zubehör/);
  const detailStyles = between(styles, ".sales-article-detail {", "}");
  assert.match(detailStyles, /width:100%/);
  assert.match(detailStyles, /min-width:0/);
  assert.doesNotMatch(detailStyles, /max-width:/);

  const renderer = between(
    app,
    "function renderSalesArticleCatalogDetail()",
    "async function loadSalesArticleCatalogDetail",
  );
  assert.match(renderer, /Stammdaten/);
  assert.match(renderer, /EAN \/ GTIN/);
  assert.match(renderer, /Verkaufspreise/);
  assert.match(renderer, /EK & Kalkulation/);
  assert.match(renderer, /Datenherkunft/);
  assert.match(renderer, /Versionsverlauf/);
  assert.doesNotMatch(renderer, /Lieferant|Filialwerte|Taxonomie|Warengruppe|Notizen|Zubehör/);
});

test("Artikel werden ausschließlich nach einer ausdrücklichen Trefferauswahl geladen", () => {
  const rows = between(
    app,
    "function renderSalesArticleCatalogRows()",
    "function renderSalesArticleCatalogResults()",
  );
  assert.match(rows, /data-sales-article-number=/);
  assert.match(app, /data-sales-article-open=/);
  assert.match(app, /aria-current="true"/);

  const loader = between(
    app,
    "async function loadSalesArticleCatalogDetail",
    "function salesArticleCatalogCell",
  );
  assert.match(loader, /new URLSearchParams\(\{ articleNumber: normalizedArticleNumber \}\)/);
  assert.match(loader, /api\(`\/api\/sales\/articles\/detail\?\$\{parameters\}`\)/);
  assert.match(loader, /catalog\.detailRequestId \+= 1/);
  assert.match(loader, /requestId !== catalog\.detailRequestId/);
  assert.match(loader, /normalizedArticleNumber !== catalog\.selectedArticleNumber/);
  assert.match(loader, /catalog\.detailLoading = true/);
  assert.match(loader, /catalog\.detailError = error\.message/);
  assert.match(app, /event\.detail === 0/);
  assert.match(app, /data-sales-article-detail-retry/);
  const detailRenderer = between(
    app,
    "function renderSalesArticleCatalogDetail()",
    "async function loadSalesArticleCatalogDetail",
  );
  assert.match(
    detailRenderer,
    /if \(catalog\.detailError\)[\s\S]*catalog\.detailMoveFocus = false[\s\S]*data-sales-article-detail-retry[\s\S]*\.focus\(\)[\s\S]*return;/,
  );

  const searchLoader = between(
    app,
    "async function loadSalesArticleCatalog({",
    "function changeSalesArticleCatalogSort",
  );
  assert.match(searchLoader, /if \(!preserveDetail\) resetSalesArticleCatalogDetailState\(\)/);
  const reset = between(
    app,
    "function resetSalesArticleCatalogSearch(",
    "function currentSalesArticleCatalogActorKey",
  );
  assert.match(reset, /resetSalesArticleCatalogDetailState\(\)/);
});

test("Preisgruppen unterscheiden serverseitig gesperrt von freigegeben aber leer", () => {
  const normalizer = between(
    app,
    "function normalizeSalesArticleDetailPayload(payload = {})",
    "function salesArticleCatalogMoney",
  );
  assert.match(normalizer, /allowed === true && Array\.isArray\(value\)/);
  assert.match(normalizer, /normalizedPriceGroup\(prices\.sales, effectiveCapabilities\.pricesRead\)/);
  assert.match(normalizer, /normalizedPriceGroup\(prices\.costs, effectiveCapabilities\.costsRead\)/);
  assert.match(normalizer, /pricesRead: capabilities\.pricesRead === true && canReadSalesArticlePrices\(\)/);
  assert.match(normalizer, /costsRead: capabilities\.costsRead === true && canReadSalesArticleCosts\(\)/);
  assert.match(normalizer, /write: capabilities\.write === true && canWriteSalesArticles\(\)/);
  assert.match(normalizer, /import: capabilities\.import === true && canImportSalesArticles\(\)/);
  const priceNormalizer = between(
    app,
    "function normalizeSalesArticleDetailPrice",
    "function normalizeSalesArticleDetailPayload",
  );
  assert.match(priceNormalizer, /displayLabel: String\(value\.displayLabel \|\| ""\)/);
  assert.match(app, /usable: value\.usable === true && \["confirmed", "inferred"\]\.includes\(qualityStatus\)/);

  const priceRenderer = between(
    app,
    "function renderSalesArticleDetailPriceGroup",
    "function renderSalesArticleDetailHistory",
  );
  assert.match(priceRenderer, /if \(prices === null\)/);
  assert.match(priceRenderer, /else if \(!prices\.length\)/);
  assert.match(priceRenderer, /sales-article-price-cards/);
  assert.match(priceRenderer, /price\.usable \? escapeHtml\(salesArticleCatalogMoney/);
  assert.match(priceRenderer, /price\.displayLabel \|\| SALES_ARTICLE_PRICE_TYPE_LABELS\[price\.priceType\]/);
  assert.match(priceRenderer, /sales-article-detail-quality/);
  assert.doesNotMatch(priceRenderer, /sourceField|createdBy|sourceSnapshotId|productId/);

  assert.match(styles, /\.sales-article-detail-overview\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /@media \(max-width:900px\)[\s\S]*\.sales-article-detail-overview\s*\{[^}]*grid-template-columns:1fr/s);
  assert.match(styles, /@media \(max-width:650px\)[\s\S]*\.sales-article-detail-data\s*\{[^}]*grid-template-columns:1fr/s);
  assert.match(styles, /\.sales-article-detail-table-wrap\s*\{[^}]*overflow:auto/s);
});

test("Ein laufender Preisrechtewechsel entfernt bereits geladene Artikeldetails fail-closed", () => {
  assert.match(app, /function canReadSalesArticlePrices\(\)[\s\S]*sales:articles:prices:read/);
  assert.match(app, /function canReadSalesArticleCosts\(\)[\s\S]*sales:articles:costs:read/);
  const accessKey = between(
    app,
    "function currentSalesArticleCatalogDetailAccessKey()",
    "function syncSalesArticleCatalogActorState()",
  );
  assert.match(accessKey, /canReadSalesArticles\(\)/);
  assert.match(accessKey, /canReadSalesArticlePrices\(\)/);
  assert.match(accessKey, /canReadSalesArticleCosts\(\)/);
  const sync = between(
    app,
    "function syncSalesArticleCatalogActorState()",
    "function clearSalesArticleCatalogState",
  );
  assert.match(sync, /detailAccessChanged/);
  assert.match(sync, /resetSalesArticleCatalogDetailState\(\)/);
  assert.match(sync, /renderSalesArticleCatalogDetail\(\)/);
  assert.match(sync, /geänderter Artikelrechte aus der Ansicht entfernt/);
});

test("Block 3 bietet kompakte, berechtigungsgeschützte Artikelaktionen ohne Import-UI", () => {
  const view = between(html, '<section id="salesArticleCatalogView"', '<section id="crmView"');
  assert.match(view, /id="salesArticleCreateButton"[^>]*aria-controls="salesArticleEditorDialog"/);
  assert.match(view, /id="salesArticleActionsLogButton"[^>]*aria-controls="personalActionsAdminDialog"/);
  assert.match(view, /id="salesArticleDetailActions"[^>]*aria-label="Aktionen für den ausgewählten Artikel"/);
  for (const action of ["edit", "copy", "archive"]) {
    assert.match(view, new RegExp(`data-sales-article-action="${action}"`));
  }
  assert.doesNotMatch(view, /Artikel importieren|Import starten|Datei auswählen/);

  assert.match(app, /function canWriteSalesArticles\(\)[\s\S]*sales:articles:write/);
  assert.match(app, /function canImportSalesArticles\(\)[\s\S]*sales:articles:import/);
  assert.match(app, /function canImportSalesArticles\(\)[\s\S]*canReadSalesArticles\(\)/);
  assert.doesNotMatch(
    between(app, "function canImportSalesArticles()", "function canOpenSalesAdministrationModule"),
    /canWriteSalesArticles/,
  );
  assert.match(app, /salesArticleCreateButton\?\.classList\.toggle\("hidden", !salesArticleCatalogWriteAccess\)/);
  assert.match(app, /function salesArticleDetailCanWrite\(\)[\s\S]*capabilities\?\.write === true/);
  assert.match(app, /function applySalesArticleCatalogManagementState\(canWrite = canWriteSalesArticles\(\)\)/);
  assert.match(app, /closeSalesArticleManagementDialogs\(\{ restoreFocus: false \}\)/);
});

test("Artikeleditor validiert Stammdaten und EAN/GTIN sicher", () => {
  const dialogs = between(html, '<dialog class="modal sales-article-editor-dialog"', '<dialog class="modal sales-article-archive-dialog"');
  assert.match(dialogs, /id="salesArticleEditorArticleNumber"[^>]*maxlength="80"[^>]*required/);
  assert.match(dialogs, /id="salesArticleEditorDescriptionField"[^>]*maxlength="300"[^>]*required/);
  assert.match(dialogs, /id="salesArticleIdentifierRows"/);
  assert.match(dialogs, /id="salesArticleIdentifierAdd"/);
  assert.match(dialogs, /id="salesArticleSalesPriceFields"/);
  assert.match(dialogs, /id="salesArticleCostPriceFields"/);

  assert.match(app, /function salesArticleIdentifierChecksumIsValid\(value\)/);
  assert.match(app, /\[8, 12, 13, 14\]\.includes\(digits\.length\)/);
  assert.match(app, /Die Prüfziffer dieser EAN-\/GTIN-Kennung ist ungültig/);
  assert.match(app, /identifierValue\.padStart\(14, "0"\)/);
  assert.match(app, /rows\.length >= 32/);
  assert.match(app, /identifiers\.length && !identifiers\.some\(\(\{ isPrimary \}\) => isPrimary\)/);
  assert.match(app, /mode === "edit" \? salesArticleEditableIdentifiers\(source\.identifiers\) : \[\]/);
});

test("Artikeleditor reduziert äquivalente UPC-/GTIN-Aliasse ohne die Detailhistorie zu verändern", () => {
  const reducerSource = between(
    app,
    "function salesArticleEditableIdentifiers",
    "function salesArticleIdentifierType",
  );
  const reduceIdentifiers = Function(
    `"use strict"; ${reducerSource}; return salesArticleEditableIdentifiers;`,
  )();
  const aliases = [
    { identifierValue: "036000291452", isPrimary: false },
    { identifierValue: "00036000291452", isPrimary: true },
  ];

  assert.deepEqual(reduceIdentifiers(aliases), [
    { identifierValue: "00036000291452", isPrimary: true },
  ]);
  assert.equal(aliases.length, 2);

  const open = between(app, "function openSalesArticleEditor", "function openSalesArticleArchive");
  assert.match(open, /mode === "edit" \? salesArticleEditableIdentifiers\(source\.identifiers\) : \[\]/);
  assert.doesNotMatch(
    between(app, "function renderSalesArticleCatalogDetail", "async function loadSalesArticleCatalogDetail"),
    /salesArticleEditableIdentifiers/,
  );
});

test("Preisgruppen werden getrennt freigegeben, exakt validiert und nur geändert übertragen", () => {
  assert.match(app, /const SALES_ARTICLE_SALES_PRICE_TYPES = Object\.freeze/);
  assert.match(app, /const SALES_ARTICLE_COST_PRICE_TYPES = Object\.freeze/);
  const renderer = between(
    app,
    "function renderSalesArticlePriceEditorGroup",
    "function markSalesArticlePriceGroupDirty",
  );
  assert.match(renderer, /canReadSalesArticlePrices\(\)/);
  assert.match(renderer, /canReadSalesArticleCosts\(\)/);
  assert.match(renderer, /Quellwerte bleiben geschützt/);
  assert.match(renderer, /salesArticlePriceGroupEnabled = "false"/);
  assert.doesNotMatch(renderer, /qualityStatus|sourceField/);

  const payload = between(app, "function salesArticleEditorPriceGroup", "function setSalesArticleEditorMessage");
  assert.match(payload, /mode === "edit" && !state\.salesArticleCatalog\.editorPriceDirtyGroups\.has\(group\)/);
  assert.match(payload, /return undefined/);
  assert.match(payload, /\^\[A-Z\]\{3\}\$/);
  assert.match(app, /\^\(\\d\{1,18\}\)\(\?:\\\.\(\\d\{1,12\}\)\)\?\$/);

  const editorPayload = between(app, "function salesArticleEditorPayload", "function invalidateAdminPersonalActionsAfterMutation");
  assert.match(editorPayload, /if \(sales && \(catalog\.editorMode === "edit" \|\| sales\.prices\.length\)\) prices\.sales/);
  assert.match(editorPayload, /if \(costs && \(catalog\.editorMode === "edit" \|\| costs\.prices\.length\)\) prices\.costs/);
  assert.match(editorPayload, /if \(Object\.keys\(prices\)\.length\) payload\.prices = prices/);
});

test("Mutationen verwenden body-basierte Artikelnummern, CAS und aktualisieren Suche sowie Detail", () => {
  const submit = between(app, "async function submitSalesArticleEditor", "async function submitSalesArticleArchive");
  assert.match(submit, /api\("\/api\/sales\/articles", \{ method: "POST"/);
  assert.match(submit, /api\("\/api\/sales\/articles\/copy"/);
  assert.match(submit, /sourceArticleNumber: originalArticleNumber/);
  assert.match(submit, /api\("\/api\/sales\/articles"[\s\S]*method: "PUT"/);
  assert.match(submit, /currentArticleNumber: originalArticleNumber/);
  assert.doesNotMatch(submit, /encodeURIComponent\(originalArticleNumber\)/);
  assert.match(submit, /SALES_ARTICLE_REVISION_CONFLICT/);

  const archive = between(app, "async function submitSalesArticleArchive", "function setSalesArticleCatalogDetailStatus");
  assert.match(archive, /api\("\/api\/sales\/articles\/archive"/);
  assert.match(archive, /JSON\.stringify\(\{ articleNumber, expectedRevision: catalog\.archiveExpectedRevision \}\)/);
  assert.doesNotMatch(archive, /encodeURIComponent\(articleNumber\)/);
  assert.match(app, /loadSalesArticleCatalog\(\{ reset: true, preserveDetail: true \}\)/);
});

test("Archivierung warnt rot und verlangt die exakte Artikelnummer", () => {
  const archiveDialog = between(html, '<dialog class="modal sales-article-archive-dialog"', '<dialog class="modal personal-actions-admin-dialog"');
  assert.match(archiveDialog, /id="salesArticleArchiveWarning"/);
  assert.match(archiveDialog, /Dieser Artikel wird für neue Vorgänge gesperrt/);
  assert.match(archiveDialog, /id="salesArticleArchiveConfirmation"[^>]*required/);
  assert.match(archiveDialog, /id="salesArticleArchiveSubmit"[^>]*disabled/);
  assert.match(styles, /\.sales-article-archive-warning\s*\{[^}]*border-left:5px solid var\(--coral\)[^}]*background:/s);
  assert.match(app, /trim\(\)\s*=== state\.salesArticleCatalog\.archiveArticleNumber/);
  assert.match(app, /salesArticleArchiveConfirmation\.setCustomValidity\(""\)/);
});

test("Persönliches Aktionslog verarbeitet Artikel-Undo additiv und ohne versteckte URL-ID", () => {
  const undo = between(app, "async function undoAdminPersonalAction", "let functionSearchController");
  assert.match(undo, /result\?\.salesArticle/);
  assert.match(undo, /refreshSalesArticleAfterMutation\(result\.salesArticle/);
  assert.match(undo, /refreshPersonalActions: false/);
  assert.match(undo, /focusDetail: false/);
  assert.match(app, /invalidateAdminPersonalActionsAfterMutation\(\)/);
  assert.match(app, /salesArticleActionsLogButton\?\.addEventListener\("click", openAdminPersonalActions\)/);
});

test("Artikeleditor ist nach erfolgreicher Mutation erneut speicherbar", () => {
  const reset = between(
    app,
    "function resetSalesArticleEditorState",
    "function closeSalesArticleEditor",
  );
  assert.match(reset, /catalog\.editorPending = false/);
  assert.match(reset, /salesArticleEditorSubmit\.disabled = false/);

  const open = between(app, "function openSalesArticleEditor", "function openSalesArticleArchive");
  assert.match(open, /if \(catalog\.editorPending \|\| catalog\.archivePending\) return/);
  assert.match(open, /salesArticleEditorSubmit\.disabled = false/);

  const submit = between(app, "async function submitSalesArticleEditor", "async function submitSalesArticleArchive");
  assert.match(submit, /catalog\.editorPending = true/);
  assert.match(submit, /salesArticleEditorSubmit\.disabled = true/);
  assert.match(submit, /closeSalesArticleEditor\(\{ restoreFocus: false, force: true \}\)/);
});

test("Laufende Artikelmutationen verwerfen höher projizierte Antworten nach Rechte- oder Sessiondrift", () => {
  const accessKey = between(
    app,
    "function currentSalesArticleCatalogDetailAccessKey",
    "function syncSalesArticleCatalogActorState",
  );
  for (const capability of [
    "canReadSalesArticles()",
    "canReadSalesArticlePrices()",
    "canReadSalesArticleCosts()",
    "canWriteSalesArticles()",
    "canImportSalesArticles()",
  ]) {
    assert.match(accessKey, new RegExp(capability.replace(/[()]/g, "\\$&")));
  }

  const guards = between(
    app,
    "function captureSalesArticleMutationContext",
    "async function discardStaleSalesArticleMutationResponse",
  );
  const makeGuards = Function(
    "currentSalesArticleCatalogActorKey",
    "currentSalesArticleCatalogDetailAccessKey",
    "canReadSalesArticles",
    "canWriteSalesArticles",
    `"use strict"; ${guards}; return { captureSalesArticleMutationContext, salesArticleMutationContextIsCurrent };`,
  );
  const current = { actorKey: "419", accessKey: "419|true|true|true|true|false", read: true, write: true };
  const race = makeGuards(
    () => current.actorKey,
    () => current.accessKey,
    () => current.read,
    () => current.write,
  );
  const captured = race.captureSalesArticleMutationContext();
  assert.equal(race.salesArticleMutationContextIsCurrent(captured), true);
  current.accessKey = "419|true|true|false|true|false";
  assert.equal(race.salesArticleMutationContextIsCurrent(captured), false, "Kostenrechtentzug muss die Antwort verwerfen");
  current.accessKey = "419|true|false|false|true|false";
  assert.equal(race.salesArticleMutationContextIsCurrent(captured), false, "Preisrechtentzug muss die Antwort verwerfen");
  current.actorKey = "430";
  assert.equal(race.salesArticleMutationContextIsCurrent(captured), false, "Actorwechsel muss die Antwort verwerfen");

  const refresh = between(app, "async function refreshSalesArticleAfterMutation", "async function submitSalesArticleEditor");
  assert.ok(refresh.indexOf("salesArticleMutationContextIsCurrent") < refresh.indexOf("normalizeSalesArticleDetailPayload"));
  assert.match(refresh, /expectedActorKey/);
  assert.match(refresh, /expectedAccessKey/);
  assert.match(refresh, /return discardStaleSalesArticleMutationResponse/);

  const editor = between(app, "async function submitSalesArticleEditor", "async function submitSalesArticleArchive");
  assert.ok(editor.indexOf("captureSalesArticleMutationContext") < editor.indexOf("await api("));
  assert.ok(editor.indexOf("salesArticleMutationContextIsCurrent") < editor.indexOf("catalog.editorPending = false"));
  assert.match(editor, /expectedActorKey: requestContext\.actorKey/);
  assert.match(editor, /expectedAccessKey: requestContext\.accessKey/);

  const archive = between(app, "async function submitSalesArticleArchive", "function setSalesArticleCatalogDetailStatus");
  assert.ok(archive.indexOf("captureSalesArticleMutationContext") < archive.indexOf("await api("));
  assert.ok(archive.indexOf("salesArticleMutationContextIsCurrent") < archive.indexOf("catalog.archivePending = false"));
  assert.match(archive, /expectedActorKey: requestContext\.actorKey/);
  assert.match(archive, /expectedAccessKey: requestContext\.accessKey/);
});

test("Artikel-Undo prüft Artikelrechte nach dem Request, Dienstplan-Undo bleibt separat", () => {
  const undo = between(app, "async function undoAdminPersonalAction", "let functionSearchController");
  assert.ok(undo.indexOf("captureSalesArticleMutationContext") < undo.indexOf("await api("));
  assert.ok(undo.indexOf("applyCurrentManualScheduleLockResult") < undo.indexOf("if (result?.salesArticle)"));
  assert.match(undo, /salesArticleMutationContextIsCurrent\(salesArticleRequestContext\)/);
  assert.match(undo, /expectedActorKey: salesArticleRequestContext\.actorKey/);
  assert.match(undo, /expectedAccessKey: salesArticleRequestContext\.accessKey/);
  assert.match(undo, /reloadArticleNumber: salesArticleReloadNumber/);
});

test("READ-Entzug leert Treffer, Zähler und Auswahl und invalidiert eine laufende Suche", () => {
  const sync = between(
    app,
    "function syncSalesArticleCatalogActorState",
    "function clearSalesArticleCatalogState",
  );
  assert.match(sync, /if \(!canReadSalesArticles\(\)\)[\s\S]*resetSalesArticleCatalogSearch/);

  const reset = between(
    app,
    "function resetSalesArticleCatalogSearch",
    "function currentSalesArticleCatalogActorKey",
  );
  assert.match(reset, /items: \[\]/);
  assert.match(reset, /total: 0/);
  assert.match(reset, /resetSalesArticleCatalogDetailState\(\)/);
  assert.match(reset, /catalog\.requestId \+= 1/);

  const loader = between(app, "async function loadSalesArticleCatalog", "function changeSalesArticleCatalogSort");
  assert.ok(loader.indexOf("if (requestId !== catalog.requestId) return") < loader.indexOf("catalog.items = combined"));
});

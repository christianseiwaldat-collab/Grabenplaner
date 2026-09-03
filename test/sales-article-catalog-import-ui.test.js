"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Startanker fehlt: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Endanker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Importdialog zeigt den bestätigten sicheren Teilimport statt eines direkten Dateiimports", () => {
  const dialog = between(
    html,
    '<dialog class="modal sales-article-import-dialog"',
    '<dialog class="modal personal-actions-admin-dialog"',
  );
  for (const id of [
    "salesArticleImportDialog",
    "salesArticleImportForm",
    "salesArticleImportFile",
    "salesArticleImportPreviewButton",
    "salesArticleImportSummary",
    "salesArticleImportValidCount",
    "salesArticleImportUnchangedCount",
    "salesArticleImportConflictCount",
    "salesArticleImportRejectedCount",
    "salesArticleImportIssues",
    "salesArticleImportConfirmed",
    "salesArticleImportApplyButton",
    "salesArticleImportReset",
    "salesArticleImportCancel",
    "salesArticleImportMessage",
  ]) {
    assert.match(dialog, new RegExp(`id="${id}"`), id);
  }
  assert.match(dialog, /zuerst vollständig geprüft/);
  assert.match(dialog, /Ohne ausdrückliche Bestätigung werden keine Artikeldaten verändert/);
  assert.match(dialog, /sichere Teilmenge wird gemeinsam und revisionssicher übernommen/);
  assert.match(dialog, /Konflikt- und Quarantänezeilen bleiben vollständig unangetastet/);
  assert.match(dialog, /UTF-8-JSON/);
  assert.doesNotMatch(dialog, /\.accdb|Access-Passwort|Zugangsdaten eingeben/i);
  assert.match(dialog, /id="salesArticleImportApplyButton"[^>]*disabled/);
});

test("Import bleibt ein eigenständiges Recht und wird bei Live-Rechtewechsel geschlossen", () => {
  assert.match(app, /function canImportSalesArticles\(\)[\s\S]*sales:articles:import/);
  assert.match(app, /function canImportSalesArticles\(\)[\s\S]*canReadSalesArticles\(\)/);
  assert.match(app, /salesArticleImportButton\?\.classList\.toggle\("hidden", !salesArticleCatalogImportAccess\)/);
  assert.match(app, /function salesArticleImportContextIsCurrent\(context\)[\s\S]*actorKey[\s\S]*accessKey[\s\S]*canReadSalesArticles\(\)[\s\S]*canImportSalesArticles\(\)/);
  assert.match(app, /if \(!canImport && elements\.salesArticleImportDialog\?\.open\)[\s\S]*closeSalesArticleImport/);
  assert.match(app, /loadSalesArticleImportCatalog\(\)[\s\S]*captureSalesArticleImportContext\(\)[\s\S]*importCatalogRequestId[\s\S]*salesArticleImportContextIsCurrent\(context\)/);
  assert.match(app, /previewSalesArticleImport\(\)[\s\S]*captureSalesArticleImportContext\(\)[\s\S]*importRequestId[\s\S]*salesArticleImportContextIsCurrent\(context\)/);
  assert.match(app, /applySalesArticleImport\(event\)[\s\S]*captureSalesArticleImportContext\(\)[\s\S]*importRequestId[\s\S]*salesArticleImportContextIsCurrent\(context\)/);
});

test("Client bindet sich an MIME, serverseitige Limits und den singularen Währungskatalog", () => {
  const normalizer = between(
    app,
    "function normalizeSalesArticleImportCatalog(payload = {}) {",
    "function normalizeSalesArticleImportPreview(payload = {}) {",
  );
  assert.match(normalizer, /grabenplaner\.tradefoto\.article-catalog\.v1/);
  assert.match(normalizer, /application\/vnd\.grabenplaner\.tradefoto-articles\+json|SALES_ARTICLE_IMPORT_MIME/);
  assert.match(normalizer, /tradefoto\.artikel_stamm/);
  assert.match(normalizer, /tradefoto-article-v1/);
  assert.match(normalizer, /sourceSchemaSha256/);
  assert.match(normalizer, /payload\.maxBytes/);
  assert.match(normalizer, /payload\.maxRows/);
  assert.match(normalizer, /payload\.maxWorkUnits/);
  assert.match(normalizer, /String\(payload\.currency/);
  assert.match(normalizer, /"EUR"/);
  assert.doesNotMatch(normalizer, /Array\.isArray\(payload\.currency\)|payload\.currency\.includes/);
  assert.doesNotMatch(normalizer, /payload\.currencies/);

  const preview = between(
    app,
    "async function previewSalesArticleImport() {",
    "async function applySalesArticleImport(event) {",
  );
  assert.match(preview, /file\.size < 1 \|\| file\.size > contract\.maxBytes/);
  assert.match(preview, /rawApi\("\/api\/sales\/articles\/import\/preview"/);
  assert.match(preview, /"Content-Type": SALES_ARTICLE_IMPORT_MIME/);
  assert.match(preview, /"X-Import-Filename": encodeURIComponent\(file\.name/);
  assert.match(preview, /body: file/);
  assert.doesNotMatch(preview, /FileReader|readAsText|JSON\.parse\(/);
});

test("Vorschau rendert nur normalisierte Zähler und maskierte Texte, niemals Preisbeträge", () => {
  const issueLabels = between(
    app,
    "const SALES_ARTICLE_IMPORT_ISSUE_LABELS = Object.freeze({",
    "const SALES_ARTICLE_IMPORT_ERROR_LABELS = Object.freeze({",
  );
  for (const code of [
    "duplicate_source_key",
    "duplicate_article_number",
    "duplicate_gtin",
    "gross_net_pair_incomplete",
    "tax_code_unknown",
  ]) {
    assert.match(issueLabels, new RegExp(`\\b${code}:`), code);
  }
  assert.doesNotMatch(issueLabels, /tax_code_not_20_percent/);
  const normalizer = between(
    app,
    "function normalizeSalesArticleImportPreview(payload = {}) {",
    "function setSalesArticleImportMessage(",
  );
  assert.match(normalizer, /summary\.create \+ summary\.update \+ summary\.unchanged \+ summary\.blocked !== summary\.total/);
  assert.match(normalizer, /\.slice\(0, 200\)/);
  assert.match(normalizer, /Object\.hasOwn\(SALES_ARTICLE_IMPORT_ISSUE_LABELS, code\)/);
  assert.match(normalizer, /payload\.canApply === true[\s\S]*summary\.total > 0/);
  assert.match(normalizer, /summary\.create \+ summary\.update > 0[\s\S]*summary\.blocked > 0/);
  assert.doesNotMatch(normalizer, /amount|currency|priceBasis|sourceField/);

  const renderer = between(
    app,
    "function renderSalesArticleImport() {",
    "function clearSalesArticleImportPreviewState(",
  );
  assert.match(renderer, /salesArticleImportValidCount\.textContent = String\(summary\.create \+ summary\.update\)/);
  assert.match(renderer, /salesArticleImportConflictCount\.textContent = String\(summary\.blocked\)/);
  assert.match(renderer, /escapeHtml\(row\.articleNumber/);
  assert.match(renderer, /escapeHtml\(row\.description/);
  assert.match(renderer, /escapeHtmlAttribute\(row\.action\)/);
  assert.match(renderer, /Preisfelder ohne Betragsvorschau/);
  assert.doesNotMatch(renderer, /row\.prices|row\.amount|price\.amount/);
});

test("Apply überträgt ausschließlich Preview-ID und Fingerprint und verlangt die Checkbox", () => {
  const apply = between(
    app,
    "async function applySalesArticleImport(event) {",
    "function closeSalesArticleManagementDialogs(",
  );
  assert.match(apply, /elements\.salesArticleImportConfirmed\?\.checked !== true/);
  assert.match(apply, /api\("\/api\/sales\/articles\/import\/apply"/);
  assert.match(apply, /previewId: preview\.previewId/);
  assert.match(apply, /confirmationFingerprint: preview\.confirmationFingerprint/);
  assert.doesNotMatch(apply, /rows:|articles:|file:/);
  assert.match(apply, /SALES_ARTICLE_IMPORT_PREVIEW_EXPIRED/);
  assert.match(apply, /SALES_ARTICLE_IMPORT_PREVIEW_STALE/);
  assert.match(apply, /SALES_ARTICLE_IMPORT_CONFIRMATION_INVALID/);
  assert.match(apply, /discardSalesArticleImportPreview/);
  assert.match(apply, /invalidateAdminPersonalActionsAfterMutation\(\)/);
  assert.match(apply, /Quarantänebefunde revisionssicher protokolliert/);

  const release = between(
    app,
    "async function releaseSalesArticleImportPreview(previewId, context) {",
    "function discardSalesArticleImportPreview(",
  );
  assert.match(release, /\/api\/sales\/articles\/import\/previews\//);
  assert.match(release, /method: "DELETE"/);
  assert.match(release, /salesArticleImportContextIsCurrent\(context\)/);
});

test("Import-Undo leert das veraltete Detail, lädt eine gestartete Suche neu und aktualisiert das Aktionslog", () => {
  const undo = between(
    app,
    "async function undoAdminPersonalAction(actionId) {",
    "let functionSearchController = null;",
  );
  assert.match(undo, /if \(result\?\.salesArticleImport\)/);
  assert.match(undo, /salesArticleImportContextIsCurrent\(salesArticleImportRequestContext\)/);
  assert.match(undo, /resetSalesArticleCatalogDetailState\(\)/);
  assert.match(undo, /state\.salesArticleCatalog\.searchStarted/);
  assert.match(undo, /loadSalesArticleCatalog\(\{ reset: true, preserveDetail: false \}\)/);
  assert.match(undo, /loadAdminPersonalActions\(\)/);
  assert.match(undo, /Artikelimport rückgängig gemacht\. Bitte einen Artikel neu auswählen\./);
});

test("Importdialog bleibt kompakt, scrollbar und auf schmalen Ansichten bedienbar", () => {
  assert.match(styles, /\.sales-article-import-dialog\s*\{/);
  assert.match(styles, /\.sales-article-import-issues-scroll\s*\{[^}]*overflow:auto/s);
  assert.match(styles, /\.sales-article-import-issues th\s*\{[^}]*position:sticky/s);
  assert.match(styles, /\.sales-article-import-summary\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /@media \(max-width:900px\)[\s\S]*\.sales-article-import-summary\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /@media \(max-width:650px\)[\s\S]*\.sales-article-import-file-actions\s*\{[^}]*grid-template-columns:1fr/s);
});

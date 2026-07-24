"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

test("v0.82 Admin-UI trennt Governance-Bereiche nach expliziten Rechten", () => {
  for (const permission of [
    "retention:read",
    "retention:manage",
    "data_subject_requests:read",
    "data_subject_requests:manage",
    "data_subject_requests:export",
    "vacation_accounts:read",
    "vacation_accounts:manage",
    "time_records:read",
    "time_records:generate",
  ]) {
    assert.match(script, new RegExp(permission.replace(":", "\\:")));
  }
  assert.match(html, /data-settings-tab="dataProtection"/);
  assert.match(html, /id="dataSubjectRequestsSection"/);
  assert.match(html, /id="vacationAccountsModal"/);
  assert.match(html, /id="monthlyTimeRecordsModal"/);
  assert.match(script, /function canManageVacationAccounts\(\)/);
  assert.match(script, /if \(!canManageVacationAccounts\(\)\)/);
});

test("v0.82 Governance-UI nutzt nur die dokumentierten API-Verträge", () => {
  assert.match(script, /api\("\/api\/privacy-governance\/retention"\)/);
  assert.match(script, /api\("\/api\/privacy-governance\/retention\/preview"/);
  assert.match(script, /api\("\/api\/privacy-governance\/retention\/rules"/);
  assert.match(script, /api\("\/api\/privacy-governance\/retention\/holds"/);
  assert.match(script, /api\(`\/api\/privacy-governance\/retention\/holds\/\$\{encodeURIComponent\(id\)\}\/release`/);
  assert.match(script, /api\("\/api\/privacy-governance\/requests"\)/);
  assert.match(script, /api\(`\/api\/privacy-governance\/requests\/\$\{encodeURIComponent\(request\.id\)\}`\)/);
  assert.match(script, /rawApi\(\s*`\/api\/privacy-governance\/requests\/\$\{encodeURIComponent\(request\.id\)\}\/export`/);
  assert.match(script, /api\(`\/api\/vacation-accounts\?year=\$\{encodeURIComponent\(year\)\}`\)/);
  assert.match(script, /api\(`\/api\/time-record-statements\?month=\$\{encodeURIComponent\(month\)\}`\)/);
  assert.match(script, /api\("\/api\/time-record-statements\/generate"/);
  assert.match(script, /api\(`\/api\/time-record-statements\/\$\{encodeURIComponent\(String\(statementId\)\)\}`/);
});

test("v0.82 Aufbewahrungsansicht bleibt eine reine Vorschau ohne Löschaktion", () => {
  assert.match(html, /Reine Löschvorschau/);
  assert.match(html, /bewusst keine Lösch-Schaltfläche/);
  assert.match(script, /Es wurde nichts gelöscht oder verändert/);
  assert.doesNotMatch(html, /id="(?:delete|execute)Retention/i);
});

test("v0.82 Monatsnachweise unterscheiden Ist-Zeit ausdrücklich von Planzeit", () => {
  assert.match(html, /geprüften Ist-Zeiten/);
  assert.match(html, /geplante Dienstzeit wird nicht als Ist-Arbeitszeit übernommen/);
  assert.match(script, /Erfasste Ist-Zeit/);
  assert.match(script, /keine Planzeit/);
  assert.match(html, /id="monthlyTimeRecordActionModal"/);
  assert.match(html, /neue, unveränderliche Revision/);
});

test("v0.82 Admin-UI schließt die freigegebenen Aufbewahrungs- und Exportabläufe", () => {
  for (const id of [
    "addRetentionRuleButton",
    "retentionRuleModal",
    "addRetentionHoldButton",
    "retentionHoldModal",
    "downloadDataSubjectRequestExportButton",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /function dataSubjectRequestCanBeExported\(request\)/);
  assert.match(script, /\["approved", "partially_approved", "fulfilled", "partially_fulfilled"\]/);
  assert.match(script, /data-new-retention-rule-version/);
  assert.match(script, /data-release-retention-hold/);
  assert.match(script, /encodeURIComponent\(request\.id\)/);
  assert.match(script, /encodeURIComponent\(id\)/);
  assert.match(html, /Eine Freigabe beendet nur die Schutzsperre\. Sie löscht keine Daten/);
});

test("v0.82 Governance-Karten sind responsiv und dark-mode-fähig", () => {
  assert.match(styles, /\.governance-dialog\s*\{/);
  assert.match(styles, /@media \(max-width:760px\)[\s\S]*\.governance-record-metrics\s*\{\s*grid-template-columns:1fr/);
  assert.match(styles, /data-active-page-theme="dark"\] :is\(\.governance-dialog/);
  assert.match(html, /aria-live="polite"/);
});

test("v0.82 Migrationswächter umfasst alle Governance-Tabellen und Immutable-Trigger", () => {
  for (const table of [
    "vacation_account_revisions",
    "vacation_account_events",
    "vacation_history_events",
    "time_record_statements",
    "time_record_statement_events",
    "retention_policy_versions",
    "retention_preview_runs",
    "legal_holds",
    "privacy_requests",
    "privacy_request_events",
    "privacy_export_receipts",
  ]) {
    assert.match(server, new RegExp(`"${table}"`));
  }
  for (const trigger of [
    "trg_vacation_account_revisions_immutable_update",
    "trg_vacation_account_events_immutable_delete",
    "trg_vacation_history_events_immutable_update",
    "trg_time_record_statements_immutable_delete",
    "trg_time_record_statement_events_immutable_update",
    "trg_retention_policy_versions_immutable_delete",
    "trg_retention_preview_runs_immutable_update",
    "trg_privacy_request_events_immutable_delete",
  ]) {
    assert.match(server, new RegExp(`"${trigger}"`));
  }
  assert.match(server, /privacyGovernanceTables\.some\(\(name\) => !tableExists\(name\)\)/);
  assert.match(server, /privacyGovernanceImmutableTriggerDefinitions\.some\([\s\S]*!privacyGovernanceImmutableTriggerMatches\(definition\)/);
  assert.match(server, /if \(privacyGovernanceMigrationRequired\) \{\s*removeMalformedPrivacyGovernanceImmutableTriggers\(\)/);
});

test("v0.82 GET-Routen bleiben lesend und Anspruchsänderungen verlangen das Verwaltungsrecht", () => {
  const retentionGet = server.slice(
    server.indexOf('app.get("/api/privacy-governance/retention"'),
    server.indexOf('app.post("/api/privacy-governance/retention/rules"'),
  );
  assert.doesNotMatch(retentionGet, /ensureDefaultRetentionRules|seedRetentionRules/);
  const vacationGet = server.slice(
    server.indexOf('app.get("/api/vacation-accounts"'),
    server.indexOf('app.get("/api/time-record-statements"'),
  );
  assert.doesNotMatch(vacationGet, /ensureVacationAccount/);
  assert.match(server, /app\.put\("\/api\/vacation-entitlements"[\s\S]*requirePortalAdminOrLocal\(request, "vacation_accounts:manage"\)/);
});

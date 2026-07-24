"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  OFFICIAL_RETENTION_SOURCES,
  RETENTION_GOVERNANCE_NOTICE,
  createRetentionRuleVersion,
  previewRetentionCandidates,
  verifyRetentionRuleVersion,
} = require("../lib/retention-policy");

function rule(overrides = {}) {
  return {
    id: "employee-master-data",
    version: "2026.1-draft",
    category: "employee_master_data",
    title: "Mitarbeiterstammdaten nach Ende des Zwecks",
    status: "active",
    validFrom: "2026-01-01",
    validTo: null,
    sources: [OFFICIAL_RETENTION_SOURCES.eu_gdpr],
    startTrigger: "purpose_ended",
    retention: { value: 1, unit: "years" },
    disposition: "manual_review",
    legalHold: { behavior: "exclude_while_active" },
    ...overrides,
  };
}

test("v0.82: Regelversionen besitzen deterministische Belege und keine Compliance-Zusage", () => {
  const first = createRetentionRuleVersion(rule());
  const second = createRetentionRuleVersion({
    legalHold: { behavior: "exclude_while_active" },
    disposition: "manual_review",
    retention: { unit: "years", value: 1 },
    startTrigger: "purpose_ended",
    sources: [OFFICIAL_RETENTION_SOURCES.eu_gdpr],
    validTo: null,
    validFrom: "2026-01-01",
    status: "active",
    title: "Mitarbeiterstammdaten nach Ende des Zwecks",
    category: "employee_master_data",
    version: "2026.1-draft",
    id: "employee-master-data",
  });

  assert.equal(first.contentSha256, second.contentSha256);
  assert.equal(verifyRetentionRuleVersion(first), true);
  assert.match(RETENTION_GOVERNANCE_NOTICE, /keine Löschung/);
  assert.match(RETENTION_GOVERNANCE_NOTICE, /rechtlich geprüft/);
  assert.equal(first.sources[0].url, "https://eur-lex.europa.eu/eli/reg/2016/679/oj");

  first.title = "Manipuliert";
  assert.equal(verifyRetentionRuleVersion(first), false);
});

test("v0.82: Vorschau nennt fällige Kandidaten, führt aber niemals eine Maßnahme aus", () => {
  const version = createRetentionRuleVersion(rule({
    retention: { value: 6, unit: "months" },
    disposition: "delete",
  }));
  const result = previewRetentionCandidates({
    ruleVersions: [version],
    records: [
      {
        id: "employee:100",
        category: "employee_master_data",
        subjectId: "100",
        startTrigger: "purpose_ended",
        startAt: "2026-01-31",
      },
      {
        id: "employee:101",
        category: "employee_master_data",
        subjectId: "101",
        startTrigger: "purpose_ended",
        startAt: "2026-04-30",
      },
    ],
    legalHolds: [],
    asOf: "2026-07-31",
  });

  assert.equal(result.mode, "preview_only");
  assert.equal(result.automaticExecution, false);
  assert.equal(result.counts.candidates, 1);
  assert.deepEqual(result.candidates.map((item) => item.recordId), ["employee:100"]);
  assert.equal(result.candidates[0].dueAt, "2026-07-31");
  assert.equal(result.candidates[0].disposition, "delete");
  assert.equal(result.candidates[0].approvalRequired, true);
  assert.equal(result.candidates[0].automaticExecution, false);
  assert.match(result.receiptSha256, /^[a-f0-9]{64}$/);
});

test("v0.82: aktive Legal Holds schließen fällige Datensätze konservativ aus", () => {
  const result = previewRetentionCandidates({
    ruleVersions: [createRetentionRuleVersion(rule({
      retention: { value: 30, unit: "days" },
      disposition: "anonymize",
    }))],
    records: [{
      id: "employee:100",
      category: "employee_master_data",
      subjectId: "100",
      startTrigger: "purpose_ended",
      startAt: "2026-01-01",
    }],
    legalHolds: [{
      id: "hold:litigation:1",
      status: "active",
      recordId: "",
      subjectId: "100",
      category: "",
      validFrom: "2026-02-01",
      validTo: null,
      reasonCode: "pending_proceeding",
    }],
    asOf: "2026-07-31",
  });

  assert.equal(result.counts.candidates, 0);
  assert.equal(result.counts.legalHold, 1);
  assert.equal(result.assessments[0].state, "legal_hold");
  assert.deepEqual(result.assessments[0].legalHoldIds, ["hold:litigation:1"]);
});

test("v0.82: fehlende Regeln gehen in manuelle Prüfung statt in eine Löschliste", () => {
  const result = previewRetentionCandidates({
    ruleVersions: [],
    records: [{
      id: "unknown:1",
      category: "unclassified_legacy_data",
      subjectId: "",
      startTrigger: "record_created",
      startAt: "2020-01-01",
    }],
    legalHolds: [],
    asOf: "2026-07-31",
  });

  assert.equal(result.counts.manualReview, 1);
  assert.equal(result.counts.candidates, 0);
  assert.equal(result.assessments[0].reasonCode, "NO_APPLICABLE_RULE");
});

test("v0.82: bestehende AUM- und Krankmeldungsbereinigung läuft nicht mehr automatisch", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.equal((serverSource.match(/purgeExpiredAmuDocuments\(/g) || []).length, 1);
  assert.equal((serverSource.match(/purgeExpiredSicknessData\(/g) || []).length, 1);
});

test("v0.82: überlappende aktive Versionen und unsichere Eingaben werden abgelehnt", () => {
  const first = createRetentionRuleVersion(rule({
    version: "2026.1",
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
  }));
  const overlapping = createRetentionRuleVersion(rule({
    version: "2026.2",
    validFrom: "2026-07-01",
    validTo: null,
  }));
  assert.throws(
    () => previewRetentionCandidates({
      ruleVersions: [first, overlapping],
      records: [],
      legalHolds: [],
      asOf: "2026-07-31",
    }),
    { code: "RETENTION_RULE_OVERLAP" },
  );

  assert.throws(
    () => createRetentionRuleVersion(rule({ automaticDelete: true })),
    { code: "RETENTION_RULE_FIELDS_INVALID" },
  );
  assert.throws(
    () => createRetentionRuleVersion(rule({
      sources: [{ ...OFFICIAL_RETENTION_SOURCES.eu_gdpr, url: "http://example.test/source" }],
    })),
    { code: "RETENTION_SOURCE_URL_INVALID" },
  );
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  OFFICIAL_LEAVE_SOURCES,
  allocateLeaveConsumption,
  appendLeaveLedgerSnapshot,
  assessLeaveLimitation,
  createLeaveLedger,
  previewFirstEmploymentYearEntitlement,
  verifyLeaveLedger,
} = require("../lib/leave-governance");

function tranche(overrides = {}) {
  return {
    id: "leave-2025",
    leaveYearStart: "2025-01-01",
    leaveYearEnd: "2025-12-31",
    grantedOn: "2025-01-01",
    euMinimumDays: 20,
    nationalAdditionalDays: 5,
    consumedEuMinimumDays: 0,
    consumedNationalAdditionalDays: 0,
    parentalLeaveExtensionDays: 0,
    status: "active",
    ...overrides,
  };
}

test("v0.82 Urlaub: offizielle Quellen und deterministische Belege sind Teil jeder konservativen Vorschau", () => {
  assert.ok(OFFICIAL_LEAVE_SOURCES.some(({ id, url }) => id === "at-urlg-2" && url.startsWith("https://")));
  assert.ok(OFFICIAL_LEAVE_SOURCES.some(({ id }) => id === "at-ogh-8oba23-23z"));
  assert.ok(OFFICIAL_LEAVE_SOURCES.some(({ id }) => id === "at-ogh-8obs1-25t"));

  const input = {
    employmentStart: "2026-01-15",
    asOf: "2026-03-15",
    annualEntitlementDays: 25,
    leaveYearType: "work_year",
  };
  const first = previewFirstEmploymentYearEntitlement(input);
  const second = previewFirstEmploymentYearEntitlement({
    annualEntitlementDays: 25,
    leaveYearType: "work_year",
    asOf: "2026-03-15",
    employmentStart: "2026-01-15",
  });
  assert.equal(first.receiptSha256, second.receiptSha256);
  assert.match(first.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.previewOnly, true);
  assert.equal(first.automaticGrant, false);
  assert.equal(first.manualReview, true);
  assert.equal(first.method, "conservative_daily_pro_rata_preview");
  assert.ok(first.previewDays > 0 && first.previewDays < 25);

  const full = previewFirstEmploymentYearEntitlement({
    ...input,
    asOf: "2026-07-15",
  });
  assert.equal(full.previewDays, 25);
  assert.equal(full.method, "full_after_six_months");
});

test("v0.82 Urlaub: Verbrauch wird auf die aelteste valide Tranche und getrennte Komponenten verteilt", () => {
  const result = allocateLeaveConsumption({
    asOf: "2026-07-24",
    amountDays: 8,
    tranches: [
      tranche({
        id: "leave-invalid",
        leaveYearStart: "2024-01-01",
        leaveYearEnd: "2024-12-31",
        grantedOn: "2024-01-01",
        status: "invalidated",
      }),
      tranche({
        id: "leave-2026",
        leaveYearStart: "2026-01-01",
        leaveYearEnd: "2026-12-31",
        grantedOn: "2026-01-01",
      }),
      tranche({
        id: "leave-2025",
        consumedEuMinimumDays: 18,
        consumedNationalAdditionalDays: 2,
      }),
    ],
  });
  assert.deepEqual(
    result.allocations.map(({ trancheId, component, days }) => [trancheId, component, days]),
    [
      ["leave-2025", "eu_minimum", 2],
      ["leave-2025", "national_additional", 3],
      ["leave-2026", "eu_minimum", 3],
    ],
  );
  assert.equal(result.allocatedDays, 8);
  assert.equal(result.unallocatedDays, 0);
  assert.equal(result.mutatesEntitlement, false);
});

test("v0.82 Urlaub: Verjaehrung bleibt Kandidat und ohne AG-Nachweise zwingend manual_review", () => {
  const withoutEvidence = assessLeaveLimitation({
    tranche: tranche(),
    asOf: "2028-01-01",
    employerEvidence: {
      enablementProvided: false,
      formalInvitationProvided: false,
      timelyWarningProvided: false,
      evidenceIds: [],
    },
  });
  assert.equal(withoutEvidence.candidateOn, "2028-01-01");
  assert.equal(withoutEvidence.limitationCandidate, true);
  assert.equal(withoutEvidence.state, "manual_review");
  assert.equal(withoutEvidence.manualReview, true);
  assert.equal(withoutEvidence.automaticExpiry, false);
  assert.deepEqual(
    withoutEvidence.missingEvidence,
    ["actual_enablement", "formal_invitation", "clear_timely_warning"],
  );

  const extended = assessLeaveLimitation({
    tranche: tranche({ parentalLeaveExtensionDays: 120 }),
    asOf: "2028-01-01",
    employerEvidence: {
      enablementProvided: true,
      formalInvitationProvided: true,
      timelyWarningProvided: true,
      evidenceIds: ["notice-1"],
    },
  });
  assert.equal(extended.candidateOn, "2028-04-30");
  assert.equal(extended.state, "not_due");
  assert.equal(extended.automaticExpiry, false);

  const evidenceComplete = assessLeaveLimitation({
    tranche: tranche(),
    asOf: "2028-01-01",
    employerEvidence: {
      enablementProvided: true,
      formalInvitationProvided: true,
      timelyWarningProvided: true,
      evidenceIds: ["enablement-1", "warning-1"],
    },
  });
  assert.equal(evidenceComplete.state, "candidate_with_evidence");
  assert.equal(evidenceComplete.manualReview, true, "Auch vollstaendige Evidenz loest keine automatische Verjaehrung aus.");
});

test("v0.82 Urlaub: Ledger bleibt append-only, hashverkettet und revisionsfaehig", () => {
  const original = createLeaveLedger({
    ledgerId: "leave-ledger-252",
    employeeId: "252",
    createdAt: "2026-07-24T00:15:00.000Z",
    employmentStart: "2018-04-01",
    annualEntitlementDays: 25,
    workingDaysPerWeek: 5,
    leaveYearType: "calendar_year",
  });
  assert.equal(verifyLeaveLedger(original), true);

  const first = appendLeaveLedgerSnapshot(original, {
    entryId: "entry-1",
    kind: "entitlement_snapshot",
    effectiveDate: "2026-01-01",
    recordedAt: "2026-07-24T00:16:00.000Z",
    actorId: "system",
    snapshot: {
      tranche: tranche({
        id: "leave-2026",
        leaveYearStart: "2026-01-01",
        leaveYearEnd: "2026-12-31",
        grantedOn: "2026-01-01",
      }),
    },
  });
  const corrected = appendLeaveLedgerSnapshot(first, {
    entryId: "entry-2",
    kind: "correction_snapshot",
    effectiveDate: "2026-01-01",
    recordedAt: "2026-07-24T00:17:00.000Z",
    actorId: "pl-101",
    supersedesEntryId: "entry-1",
    snapshot: { reason: "Gepruefte Vertragsgrundlage", annualEntitlementDays: 30 },
  });

  assert.equal(original.entries.length, 0, "Append darf das vorherige Ledger nicht veraendern.");
  assert.equal(first.entries.length, 1);
  assert.equal(corrected.entries.length, 2);
  assert.equal(corrected.entries[1].previousEntrySha256, corrected.entries[0].entrySha256);
  assert.equal(corrected.previousReceiptSha256, first.receiptSha256);
  assert.equal(verifyLeaveLedger(corrected), true);

  const tampered = structuredClone(corrected);
  tampered.entries[0].snapshot.tranche.euMinimumDays = 0;
  assert.equal(verifyLeaveLedger(tampered), false);
  assert.throws(
    () => appendLeaveLedgerSnapshot(tampered, {
      entryId: "entry-3",
      kind: "snapshot",
      effectiveDate: "2026-07-24",
      recordedAt: "2026-07-24T00:18:00.000Z",
      actorId: "system",
      snapshot: {},
    }),
    /receipt verification/i,
  );
});

test("v0.82 Urlaub: Ein bestätigter Nullstand bleibt exakt null und wird nicht künstlich erhöht", () => {
  const ledger = createLeaveLedger({
    ledgerId: "leave-ledger-zero",
    employeeId: "zero",
    createdAt: "2026-07-24T00:20:00.000Z",
    employmentStart: "2026-07-01",
    annualEntitlementDays: 0,
    workingDaysPerWeek: 5,
    leaveYearType: "calendar_year",
  });
  assert.equal(ledger.annualEntitlementDays, 0);
  assert.equal(verifyLeaveLedger(ledger), true);
});

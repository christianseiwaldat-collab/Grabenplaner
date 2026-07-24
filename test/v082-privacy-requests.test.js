"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  OFFICIAL_PRIVACY_SOURCES,
  PRIVACY_REQUEST_GOVERNANCE_NOTICE,
  allowedPrivacyRequestTransitions,
  completePrivacyRequest,
  createPrivacyRequest,
  decidePrivacyRequest,
  extendPrivacyRequestDeadline,
  setPrivacyRequestIdentity,
  verifyPrivacyRequest,
  withdrawPrivacyRequest,
} = require("../lib/privacy-requests");

function request(overrides = {}) {
  return createPrivacyRequest({
    id: "privacy:request:2026-0001",
    type: "access",
    subjectId: "employee:100",
    scope: ["time_entries", "employee_master_data"],
    receivedAt: "2026-01-31T10:15:00+01:00",
    channel: "portal",
    ...overrides,
  });
}

function verifiedIdentity(value = request()) {
  return setPrivacyRequestIdentity(value, {
    status: "verified",
    assessedAt: "2026-02-01T09:00:00Z",
    assessedBy: "privacy_officer:1",
    reasonCode: "portal_identity_verified",
  });
}

function refusal(scopeItem, overrides = {}) {
  return {
    scopeItem,
    reasonCode: "documented_exception",
    reason: "Die konkrete Ausnahme wurde durch eine berechtigte Person geprüft.",
    sources: [OFFICIAL_PRIVACY_SOURCES.eu_gdpr],
    ...overrides,
  };
}

test("v0.82: Anfrage startet mit Monatsziel, offenem Identitätsstatus und Belegkette", () => {
  const value = request();

  assert.equal(value.status, "received");
  assert.equal(value.identity.status, "pending");
  assert.equal(value.deadline.initialTargetAt, "2026-02-28T09:15:00.000Z");
  assert.equal(value.deadline.extensionMonths, 0);
  assert.equal(value.events.length, 1);
  assert.equal(value.events[0].previousReceiptSha256, "0".repeat(64));
  assert.equal(verifyPrivacyRequest(value), true);
  assert.match(PRIVACY_REQUEST_GOVERNANCE_NOTICE, /keine Löschung oder Datenübertragung/);
  assert.match(PRIVACY_REQUEST_GOVERNANCE_NOTICE, /berechtigte Person geprüft/);

  const tampered = structuredClone(value);
  tampered.scope.push("hidden_category");
  assert.equal(verifyPrivacyRequest(tampered), false);
});

test("v0.82: Identitätsprüfung ist zwingend und Fristverlängerung bleibt auf zwei Monate begrenzt", () => {
  const pending = request();
  assert.throws(
    () => extendPrivacyRequestDeadline(pending, {
      months: 2,
      reasonCode: "complex_request",
      reason: "Mehrere getrennte Datenbestände müssen nachvollziehbar geprüft werden.",
      notifiedAt: "2026-02-20T10:00:00Z",
      actor: "privacy_officer:1",
    }),
    { code: "PRIVACY_EXTENSION_STATUS_INVALID" },
  );

  const inReview = verifiedIdentity(pending);
  const extended = extendPrivacyRequestDeadline(inReview, {
    months: 2,
    reasonCode: "complex_request",
    reason: "Mehrere getrennte Datenbestände müssen nachvollziehbar geprüft werden.",
    notifiedAt: "2026-02-20T10:00:00Z",
    actor: "privacy_officer:1",
  });
  assert.equal(extended.status, "extended");
  assert.equal(extended.deadline.extensionMonths, 2);
  assert.equal(extended.deadline.extendedTargetAt, "2026-04-28T09:15:00.000Z");
  assert.equal(verifyPrivacyRequest(extended), true);

  assert.throws(
    () => extendPrivacyRequestDeadline(inReview, {
      months: 3,
      reasonCode: "complex_request",
      reason: "Zu lange Verlängerung.",
      notifiedAt: "2026-02-20T10:00:00Z",
      actor: "privacy_officer:1",
    }),
    { code: "PRIVACY_INTEGER_INVALID" },
  );
  assert.throws(
    () => extendPrivacyRequestDeadline(inReview, {
      months: 1,
      reasonCode: "late_notice",
      reason: "Die Mitteilung wäre verspätet.",
      notifiedAt: "2026-03-01T10:00:00Z",
      actor: "privacy_officer:1",
    }),
    { code: "PRIVACY_EXTENSION_NOTICE_LATE" },
  );
});

test("v0.82: Teilgenehmigung muss jeden Umfang sicher abdecken und Ablehnungen belegen", () => {
  const inReview = verifiedIdentity();
  const decision = decidePrivacyRequest(inReview, {
    outcome: "partially_approved",
    decidedAt: "2026-02-10T10:00:00Z",
    decidedBy: "privacy_officer:1",
    approvedScope: ["employee_master_data"],
    refusals: [refusal("time_entries")],
    summary: "Ein Teil wird bereitgestellt; die Teilablehnung wurde dokumentiert.",
  });

  assert.equal(decision.status, "partially_approved");
  assert.equal(decision.decision.automatic, false);
  assert.equal(decision.decision.humanReviewRequired, true);
  assert.deepEqual(decision.decision.approvedScope, ["employee_master_data"]);
  assert.equal(decision.decision.refusals[0].scopeItem, "time_entries");
  assert.equal(verifyPrivacyRequest(decision), true);

  const completed = completePrivacyRequest(decision, {
    completedAt: "2026-02-11T10:00:00Z",
    completedBy: "privacy_officer:1",
    reference: "protected-export:2026-0001",
  });
  assert.equal(completed.status, "partially_fulfilled");
  assert.equal(completed.completion.reference, "protected-export:2026-0001");
  assert.equal(verifyPrivacyRequest(completed), true);

  assert.throws(
    () => decidePrivacyRequest(inReview, {
      outcome: "partially_approved",
      decidedAt: "2026-02-10T10:00:00Z",
      decidedBy: "privacy_officer:1",
      approvedScope: ["employee_master_data"],
      refusals: [],
      summary: "",
    }),
    { code: "PRIVACY_DECISION_SCOPE_INCOMPLETE" },
  );
});

test("v0.82: vollständige Ablehnung verlangt je Umfang eine begründete offizielle Quelle", () => {
  const inReview = verifiedIdentity();
  const rejected = decidePrivacyRequest(inReview, {
    outcome: "rejected",
    decidedAt: "2026-02-10T10:00:00Z",
    decidedBy: "privacy_officer:1",
    approvedScope: [],
    refusals: [
      refusal("employee_master_data"),
      refusal("time_entries"),
    ],
    summary: "Die dokumentierte Entscheidung ist vollständig ablehnend.",
  });

  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.decision.refusals.length, 2);
  assert.equal(verifyPrivacyRequest(rejected), true);
  assert.deepEqual(allowedPrivacyRequestTransitions("rejected"), []);

  assert.throws(
    () => decidePrivacyRequest(inReview, {
      outcome: "rejected",
      decidedAt: "2026-02-10T10:00:00Z",
      decidedBy: "privacy_officer:1",
      approvedScope: [],
      refusals: [{
        scopeItem: "employee_master_data",
        reasonCode: "undocumented",
        reason: "Ohne Quelle.",
        sources: [],
      }, refusal("time_entries")],
      summary: "",
    }),
    { code: "PRIVACY_REFUSAL_SOURCES_INVALID" },
  );
});

test("v0.82: unzureichende Identität führt nicht automatisch zur Sachablehnung", () => {
  const pending = setPrivacyRequestIdentity(request(), {
    status: "insufficient",
    assessedAt: "2026-02-01T09:00:00Z",
    assessedBy: "privacy_officer:1",
    reasonCode: "additional_evidence_needed",
  });
  assert.equal(pending.status, "identity_pending");
  assert.equal(pending.decision, null);
  assert.equal(verifyPrivacyRequest(pending), true);

  assert.throws(
    () => decidePrivacyRequest(pending, {
      outcome: "approved",
      decidedAt: "2026-02-02T09:00:00Z",
      decidedBy: "privacy_officer:1",
      approvedScope: pending.scope,
      refusals: [],
      summary: "",
    }),
    { code: "PRIVACY_DECISION_STATUS_INVALID" },
  );
});

test("v0.82: Statusmaschine erlaubt dokumentierte Rücknahme, aber keine Wiederöffnung finaler Fälle", () => {
  const pending = request({ type: "objection", scope: ["marketing_contact"] });
  const withdrawn = withdrawPrivacyRequest(pending, {
    at: "2026-02-01T09:00:00Z",
    actor: "employee:100",
    reasonCode: "withdrawn_by_subject",
  });
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(verifyPrivacyRequest(withdrawn), true);
  assert.deepEqual(allowedPrivacyRequestTransitions("withdrawn"), []);
  assert.throws(
    () => setPrivacyRequestIdentity(withdrawn, {
      status: "verified",
      assessedAt: "2026-02-02T09:00:00Z",
      assessedBy: "privacy_officer:1",
      reasonCode: "late_verification",
    }),
    { code: "PRIVACY_IDENTITY_STATUS_INVALID" },
  );

  assert.throws(
    () => createPrivacyRequest({
      id: "privacy:bad",
      type: "erasure",
      subjectId: "employee:100",
      scope: ["all_personal_data"],
      receivedAt: "2026-01-31T10:15:00+01:00",
      channel: "portal",
      automaticallyDelete: true,
    }),
    { code: "PRIVACY_REQUEST_INPUT_FIELDS_INVALID" },
  );
});

test("v0.82: alle sechs Betroffenenrechte sind modelliert und eine Rücknahme nach Entscheidung bleibt belegbar", () => {
  for (const type of ["access", "rectification", "erasure", "restriction", "portability", "objection"]) {
    const created = request({
      id: `privacy:${type}`,
      type,
      scope: [`scope_${type}`],
    });
    assert.equal(created.type, type);
    assert.equal(verifyPrivacyRequest(created), true);
  }

  const inReview = verifiedIdentity(request({ scope: ["employee_master_data"] }));
  const approved = decidePrivacyRequest(inReview, {
    outcome: "approved",
    decidedAt: "2026-02-10T10:00:00Z",
    decidedBy: "privacy_officer:1",
    approvedScope: ["employee_master_data"],
    refusals: [],
    summary: "Der Umfang wurde vollständig freigegeben.",
  });
  const withdrawn = withdrawPrivacyRequest(approved, {
    at: "2026-02-10T11:00:00Z",
    actor: "employee:100",
    reasonCode: "withdrawn_after_decision",
  });
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(withdrawn.decision.outcome, "approved");
  assert.equal(verifyPrivacyRequest(withdrawn), true);
});

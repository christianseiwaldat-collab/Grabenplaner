"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LOAN_RETURN_POLICY_PERMISSION: RIGHT,
  loanReturnPolicySettingKey,
  loanReturnPolicyFromSettings,
  normalizeLoanReturnPolicy,
  canManageLoanReturnPolicy,
  loanReturnPolicyAllowsLocation,
  assertLoanReturnPolicyCompletion,
} = require("../lib/loan-return-policy");

test("Rücknahme ist ohne gespeicherte Regel alleine möglich; ungültige Daten schwächen keine Kontrolle", () => {
  assert.deepEqual(loanReturnPolicyFromSettings({}, "18"), { requiresWitness: false });
  const key = loanReturnPolicySettingKey("18");
  assert.deepEqual(loanReturnPolicyFromSettings({ [key]: "true" }, "18"), { requiresWitness: true });
  assert.deepEqual(loanReturnPolicyFromSettings({ [key]: "false" }, "18"), { requiresWitness: false });
  assert.deepEqual(loanReturnPolicyFromSettings({ [key]: "true" }, "05"), { requiresWitness: false });
  for (const value of ["", "1", true, "invalid"]) {
    assert.throws(() => loanReturnPolicyFromSettings({ [key]: value }, "18"), { code: "LOAN_RETURN_POLICY_STORED_INVALID", status: 503 });
  }
  assert.throws(() => loanReturnPolicySettingKey("18\0foreign"), { code: "LOAN_RETURN_POLICY_LOCATION_INVALID" });
});

test("Teilspeichern erhält die Rücknahmeregel und akzeptiert ausschließlich echte boolesche Werte", () => {
  assert.deepEqual(normalizeLoanReturnPolicy(undefined, { requiresWitness: true }), { requiresWitness: true });
  assert.deepEqual(normalizeLoanReturnPolicy({ requiresWitness: false }, { requiresWitness: true }), { requiresWitness: false });
  for (const value of [null, [], {}, { requiresWitness: "false" }, { requiresWitness: true, enabled: true }]) {
    assert.throws(() => normalizeLoanReturnPolicy(value), { code: "LOAN_RETURN_POLICY_INVALID" });
  }
});

test("FL und AL mit Zusatzrecht dürfen nur ihre Stammfiliale regeln; Filialkonten dürfen es nie", () => {
  for (const role of ["manager", "department_manager"]) {
    const session = { role, homeLocationId: "18", sessionKind: "employee", permissions: [RIGHT] };
    assert.equal(canManageLoanReturnPolicy(session), true);
    assert.equal(loanReturnPolicyAllowsLocation(session, "18"), true);
    assert.equal(loanReturnPolicyAllowsLocation(session, "05"), false);
    assert.equal(canManageLoanReturnPolicy({ ...session, permissions: [] }), false);
    assert.equal(canManageLoanReturnPolicy({ ...session, sessionKind: "organization" }), false);
  }
  assert.equal(canManageLoanReturnPolicy({ role: "employee", permissions: [RIGHT] }), false);
  for (const role of ["hr", "admin", "it_admin", "developer"]) {
    assert.equal(loanReturnPolicyAllowsLocation({ role, permissions: [RIGHT] }, "05"), true);
  }
});

test("Verpflichtende Gegenprüfung kann beim Abschluss nicht übergangen werden", () => {
  assert.doesNotThrow(() => assertLoanReturnPolicyCompletion({ requiresWitness: false }));
  assert.doesNotThrow(() => assertLoanReturnPolicyCompletion({ requiresWitness: true }, { witnessEmployeeNumber: "17" }));
  assert.throws(() => assertLoanReturnPolicyCompletion({ requiresWitness: true }), { code: "LOAN_RETURN_WITNESS_REQUIRED", status: 409 });
});

test("Rücknahmebeleg unterscheidet Einzelabschluss von Gegenprüfung und Leitungsabschluss", async () => {
  const { normalizeLoanPdfSpec, renderLoanPdf } = require("../lib/loan-pdf");
  const spec = {
    type: "return", confirmationMode: "single", loanId: "single-test", location: { id: "18", name: "BEISPIEL Filiale" },
    borrower: { employeeNumber: "17", name: "BEISPIEL Anna" }, recordedBy: { employeeNumber: "17", name: "BEISPIEL Anna" },
    items: [{ articleNumber: "123456", description: "BEISPIEL Gerät", conditionReturn: "good" }],
  };
  assert.equal(normalizeLoanPdfSpec(spec).confirmationMode, "single");
  const pdf = await renderLoanPdf(spec);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: Uint8Array.from(pdf), disableWorker: true, isEvalSupported: false, useSystemFonts: true });
  const document = await loadingTask.promise;
  try {
    const page = await document.getPage(1);
    const text = (await page.getTextContent()).items.map((item) => item.str).join(" ");
    assert.match(text, /Rücknahme abgeschlossen/i);
    assert.match(text, /Ohne zweite Gegenprüfung/);
    assert.doesNotMatch(text, /Abschluss durch Filialleitung|Gegenprüfung durch/i);
  } finally { await loadingTask.destroy(); }
});

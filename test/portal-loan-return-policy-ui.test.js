"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/portal.js"), "utf8");
const openReturn = source.slice(source.indexOf("async function openLoanReturn("), source.indexOf("async function submitLoanReturn("));

async function openReturnForPolicy(requiresWitness, locationManage = false) {
  const controls = Object.fromEntries([
    "loanReturnTitle", "loanReturnSummary", "loanReturnItems", "loanReturnWitness", "loanReturnNote", "loanReturnWitnessHint", "loanReturnSubmit", "loanReturnPhotos", "loanReturnCamera", "loanReturnMessage", "loanReturnDialog",
  ].map((id) => [id, { value: "", textContent: "", innerHTML: "", required: false, showModal() { this.open = true; } }]));
  const context = {
    el: controls,
    portalState: {
      loans: [{ id: "loan", borrower: { employeeNumber: "17", name: "BEISPIEL Anna" }, items: [{ position: 1, articleNumber: "123456", description: "BEISPIEL Gerät", conditionOut: "good" }], revision: 1 }],
      loanStatus: { location: { returnPolicy: { requiresWitness } }, permissions: { locationManage } },
      loanTeamMembers: [{ employeeNumber: "17", name: "BEISPIEL Anna" }, { employeeNumber: "21", name: "BEISPIEL Ben" }],
    },
    loadLoanTeamMembers: async () => {}, portalUser: () => ({ employeeNumber: "17" }),
    esc: (value) => String(value || ""), loanConditionOptions: () => '<option value="good">Gut</option>', setLoanPhotoFiles: () => {}, message: () => {},
  };
  vm.runInNewContext(`${openReturn}\nglobalThis.openReturn = openLoanReturn;`, context);
  await context.openReturn("loan");
  return controls;
}

test("Persönliches Rücknahmeformular bietet den direkten Abschluss als Standard an", async () => {
  const controls = await openReturnForPolicy(false);
  assert.equal(controls.loanReturnWitness.required, false);
  assert.match(controls.loanReturnWitness.innerHTML, /Ohne zweite Person direkt abschließen/);
  assert.equal(controls.loanReturnSubmit.textContent, "Rücknahme abschließen");
  assert.match(controls.loanReturnWitnessHint.textContent, /alleine abschließen/);
  assert.doesNotMatch(controls.loanReturnWitness.innerHTML, /value="17"/);
  assert.match(controls.loanReturnWitness.innerHTML, /value="21"/);
});

test("Verpflichtende Gegenprüfung wird auch für die Filialleitung eindeutig angezeigt", async () => {
  for (const manager of [false, true]) {
    const controls = await openReturnForPolicy(true, manager);
    assert.equal(controls.loanReturnWitness.required, true);
    assert.match(controls.loanReturnWitness.innerHTML, /Zweites Teammitglied auswählen/);
    assert.equal(controls.loanReturnSubmit.textContent, "Gegenbestätigung anfordern");
    assert.match(controls.loanReturnWitnessHint.textContent, /Gegenprüfung verpflichtend/);
  }
});

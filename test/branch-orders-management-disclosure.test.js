"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Startmarker fehlt: ${startMarker}`);
  assert.notEqual(end, -1, `Endmarker fehlt: ${endMarker}`);
  return appSource.slice(start, end);
}

class FakeDetails {
  constructor(attribute, value, { open = false, fieldSelector = "", field = null } = {}) {
    this.attribute = attribute;
    this.value = value;
    this.open = open;
    this.fieldSelector = fieldSelector;
    this.field = field;
  }

  getAttribute(attribute) {
    return attribute === this.attribute ? this.value : null;
  }

  querySelector(selector) {
    return selector === this.fieldSelector ? this.field : null;
  }
}

class FakeWorkspace {
  constructor(details) {
    this.details = details;
  }

  querySelectorAll(selector) {
    const match = selector.match(/^details\[([^\]]+)\]\[open\]$/);
    if (!match) return [];
    return this.details.filter((details) => details.attribute === match[1] && details.open);
  }

  querySelector(selector) {
    const match = selector.match(/^details\[([^=]+)="([^"]+)"\]$/);
    if (!match) return null;
    return this.details.find((details) => details.attribute === match[1] && details.value === match[2]) || null;
  }
}

test("Filialbestellung behält geöffnete Bereiche beim Neurendern und fokussiert neue Positionen", () => {
  const initialWorkspace = new FakeWorkspace([
    new FakeDetails("data-branch-orders-management-section", "catalog", { open: true }),
    new FakeDetails("data-branch-orders-management-section", "units"),
    new FakeDetails("data-branch-orders-management-catalog-item", "item-existing", { open: true }),
  ]);
  const context = {
    CSS: { escape: (value) => String(value) },
    elements: { branchOrdersManagementWorkspace: initialWorkspace },
  };
  const helpersSource = sourceBetween(
    "const branchOrdersManagementDisclosureAttributes",
    "function renderBranchOrdersManagement()",
  );
  vm.runInNewContext(`${helpersSource}\nglobalThis.helpers = { captureBranchOrdersManagementDisclosureState, restoreBranchOrdersManagementDisclosureState, revealBranchOrdersManagementDisclosure };`, context);

  const opened = context.helpers.captureBranchOrdersManagementDisclosureState();
  const titleField = {
    focused: false,
    selected: false,
    focus() { this.focused = true; },
    select() { this.selected = true; },
  };
  const catalogSection = new FakeDetails("data-branch-orders-management-section", "catalog");
  const unitsSection = new FakeDetails("data-branch-orders-management-section", "units");
  const existingItem = new FakeDetails("data-branch-orders-management-catalog-item", "item-existing");
  const newItem = new FakeDetails("data-branch-orders-management-catalog-item", "item-new", {
    fieldSelector: '[data-branch-orders-management-field="catalog-item-title"]',
    field: titleField,
  });
  context.elements.branchOrdersManagementWorkspace = new FakeWorkspace([
    catalogSection,
    unitsSection,
    existingItem,
    newItem,
  ]);

  context.helpers.restoreBranchOrdersManagementDisclosureState(opened);
  assert.equal(catalogSection.open, true);
  assert.equal(existingItem.open, true);
  assert.equal(unitsSection.open, false);
  assert.equal(newItem.open, false);

  context.helpers.revealBranchOrdersManagementDisclosure(
    "catalog",
    "data-branch-orders-management-catalog-item",
    "item-new",
    '[data-branch-orders-management-field="catalog-item-title"]',
  );
  assert.equal(catalogSection.open, true);
  assert.equal(newItem.open, true);
  assert.equal(titleField.focused, true);
  assert.equal(titleField.selected, true);
});

test("+ Position ergänzt den Entwurf und öffnet anschließend genau den neuen Editor", () => {
  const draft = {
    recipients: [],
    units: [{ id: "unit-1", title: "Stück" }],
    items: [],
    groups: [],
  };
  let rendered = 0;
  let revealArguments = null;
  let prevented = false;
  let propagationStopped = false;
  const button = {
    dataset: {
      branchOrdersManagementAction: "add-catalog-item",
      branchOrdersManagementId: "",
    },
  };
  const context = {
    CSS: { escape: (value) => String(value) },
    elements: { branchOrdersManagementWorkspace: null },
    state: { branchOrdersManagement: null },
    captureBranchOrdersManagementDraft: () => draft,
    branchOrdersManagementClientId: () => "item-new",
    renderBranchOrdersManagement: () => { rendered += 1; },
    revealBranchOrdersManagementDisclosure: (...args) => { revealArguments = args; },
    setBranchOrdersManagementMessage: () => {},
    moveBranchOrdersManagementEntry: () => {},
  };
  const handlerSource = sourceBetween(
    "function handleBranchOrdersManagementAction(event)",
    "const branchLoanOverviewColumnCatalog",
  );
  vm.runInNewContext(`${handlerSource}\nglobalThis.handleAction = handleBranchOrdersManagementAction;`, context);

  context.handleAction({
    target: { closest: () => button },
    preventDefault() { prevented = true; },
    stopPropagation() { propagationStopped = true; },
  });

  assert.equal(prevented, true);
  assert.equal(propagationStopped, true);
  assert.equal(rendered, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(draft.items)), [{
    id: "item-new",
    title: "Neue Position",
    unitId: "unit-1",
    recipientId: "",
  }]);
  assert.deepEqual(Array.from(revealArguments), [
    "catalog",
    "data-branch-orders-management-catalog-item",
    "item-new",
    '[data-branch-orders-management-field="catalog-item-title"]',
  ]);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Startmarker fehlt: ${startMarker}`);
  assert.notEqual(end, -1, `Endmarker fehlt: ${endMarker}`);
  return appSource.slice(start, end);
}

class FakeDetails {
  constructor(attribute, value, { open = false } = {}) {
    this.attribute = attribute;
    this.value = value;
    this.open = open;
  }

  getAttribute(attribute) {
    return attribute === this.attribute ? this.value : null;
  }
}

class FakeWorkspace {
  constructor(details, selectors = new Map()) {
    this.details = details;
    this.selectors = selectors;
  }

  querySelectorAll(selector) {
    const match = selector.match(/^details\[([^\]]+)\]\[open\]$/);
    if (!match) return [];
    return this.details.filter((details) => details.attribute === match[1] && details.open);
  }

  querySelector(selector) {
    const match = selector.match(/^details\[([^=]+)="([^"]+)"\]$/);
    if (match) {
      return this.details.find((details) => details.attribute === match[1] && details.value === match[2]) || null;
    }
    return this.selectors.get(selector) || null;
  }
}

test("Filialbestellung behält geöffnete Hauptbereiche und fokussiert den Tabelleneditor", () => {
  const initialWorkspace = new FakeWorkspace([
    new FakeDetails("data-branch-orders-management-section", "catalog", { open: true }),
    new FakeDetails("data-branch-orders-management-section", "units"),
  ]);
  const context = {
    CSS: { escape: (value) => String(value) },
    Intl,
    state: { branchOrdersManagementCatalogSort: { key: "position", direction: "asc" } },
    escapeHtml: (value) => String(value),
    escapeHtmlAttribute: (value) => String(value),
    elements: { branchOrdersManagementWorkspace: initialWorkspace },
  };
  const helpersSource = sourceBetween(
    "const branchOrdersManagementDisclosureAttributes",
    "function renderBranchOrdersManagement()",
  );
  vm.runInNewContext(`${helpersSource}\nglobalThis.helpers = { captureBranchOrdersManagementDisclosureState, restoreBranchOrdersManagementDisclosureState, revealBranchOrdersManagementCatalogEditor };`, context);

  const opened = context.helpers.captureBranchOrdersManagementDisclosureState();
  const titleField = {
    focused: false,
    selected: false,
    focus() { this.focused = true; },
    select() { this.selected = true; },
  };
  const editor = {
    querySelector(selector) {
      return selector === '[data-branch-orders-management-field="catalog-item-title"]' ? titleField : null;
    },
  };
  const catalogSection = new FakeDetails("data-branch-orders-management-section", "catalog");
  const unitsSection = new FakeDetails("data-branch-orders-management-section", "units");
  context.elements.branchOrdersManagementWorkspace = new FakeWorkspace(
    [catalogSection, unitsSection],
    new Map([['[data-branch-orders-management-catalog-editor="item-new"]', editor]]),
  );

  context.helpers.restoreBranchOrdersManagementDisclosureState(opened);
  assert.equal(catalogSection.open, true);
  assert.equal(unitsSection.open, false);

  context.helpers.revealBranchOrdersManagementCatalogEditor("item-new");
  assert.equal(titleField.focused, true);
  assert.equal(titleField.selected, true);
});

test("Positionstabelle sortiert zugänglich nach Position, Bezeichnung und Einheit", () => {
  const context = {
    Intl,
    state: { branchOrdersManagementCatalogSort: { key: "title", direction: "asc" } },
    escapeHtml: (value) => String(value),
    escapeHtmlAttribute: (value) => String(value),
  };
  const sortSource = sourceBetween(
    "const branchOrdersManagementCatalogColumns",
    "function revealBranchOrdersManagementCatalogEditor",
  );
  vm.runInNewContext(`${sortSource}\nglobalThis.catalog = { sortedBranchOrdersManagementCatalogItems, branchOrdersManagementCatalogHeader };`, context);
  const draft = {
    items: [
      { id: "beta", title: "Batterien", unitId: "piece", recipientId: "target-b" },
      { id: "alpha", title: "Analogfilm", unitId: "box", recipientId: "target-a" },
      { id: "gamma", title: "Versandtaschen", unitId: "", recipientId: "" },
    ],
    units: [{ id: "box", title: "Karton" }, { id: "piece", title: "Stück" }],
    recipients: [{ id: "target-a", email: "a@example.test" }, { id: "target-b", email: "b@example.test" }],
  };

  assert.deepEqual(
    Array.from(context.catalog.sortedBranchOrdersManagementCatalogItems(draft), (item) => item.id),
    ["alpha", "beta", "gamma"],
  );
  context.state.branchOrdersManagementCatalogSort = { key: "unit", direction: "desc" };
  assert.deepEqual(
    Array.from(context.catalog.sortedBranchOrdersManagementCatalogItems(draft), (item) => item.id),
    ["beta", "alpha", "gamma"],
  );
  assert.match(context.catalog.branchOrdersManagementCatalogHeader(), /aria-sort="descending"/);
  assert.match(context.catalog.branchOrdersManagementCatalogHeader(), /data-branch-orders-management-sort-key="unit"/);
  context.state.branchOrdersManagementCatalogSort = { key: "position", direction: "desc" };
  assert.deepEqual(
    Array.from(context.catalog.sortedBranchOrdersManagementCatalogItems(draft), (item) => item.id),
    ["gamma", "alpha", "beta"],
  );
});

test("Position hinzufügen übernimmt die Bezeichnung und öffnet genau den neuen Inline-Editor", () => {
  const draft = {
    recipients: [],
    units: [{ id: "unit-1", title: "Stück" }],
    items: [],
    groups: [],
  };
  const titleField = { value: "  Speicherkarten  ", focus() {} };
  let rendered = 0;
  let revealedItemId = "";
  const button = {
    dataset: {
      branchOrdersManagementAction: "add-catalog-item",
      branchOrdersManagementId: "",
    },
  };
  const context = {
    elements: {
      branchOrdersManagementWorkspace: {
        querySelector(selector) {
          return selector === "[data-branch-orders-management-new-item-title]" ? titleField : null;
        },
        querySelectorAll() { return []; },
      },
    },
    state: {
      branchOrdersManagement: null,
      branchOrdersManagementCatalogEditingId: "",
      branchOrdersManagementCatalogSort: { key: "position", direction: "asc" },
    },
    captureBranchOrdersManagementDraft: () => draft,
    branchOrdersManagementClientId: () => "item-new",
    renderBranchOrdersManagement: () => { rendered += 1; },
    revealBranchOrdersManagementCatalogEditor: (itemId) => { revealedItemId = itemId; },
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
    preventDefault() {},
    stopPropagation() {},
  });

  assert.equal(rendered, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(draft.items)), [{
    id: "item-new",
    title: "Speicherkarten",
    unitId: "unit-1",
    recipientId: "",
  }]);
  assert.equal(context.state.branchOrdersManagementCatalogEditingId, "item-new");
  assert.equal(revealedItemId, "item-new");
});

test("Bearbeiten öffnet den gewählten Editor; Löschen entfernt Position und Gruppenzuordnung", () => {
  const draft = {
    recipients: [],
    units: [{ id: "unit-1", title: "Stück" }],
    items: [{ id: "item-1", title: "Batterien", unitId: "unit-1", recipientId: "" }],
    groups: [{ id: "group-1", title: "Theke", hint: "", itemIds: ["item-1"] }],
  };
  let rendered = 0;
  let revealedItemId = "";
  const context = {
    elements: { branchOrdersManagementWorkspace: { querySelectorAll() { return []; } } },
    state: {
      branchOrdersManagement: null,
      branchOrdersManagementCatalogEditingId: "",
      branchOrdersManagementCatalogSort: { key: "position", direction: "asc" },
    },
    captureBranchOrdersManagementDraft: () => draft,
    renderBranchOrdersManagement: () => { rendered += 1; },
    revealBranchOrdersManagementCatalogEditor: (itemId) => { revealedItemId = itemId; },
    setBranchOrdersManagementMessage: () => {},
    moveBranchOrdersManagementEntry: () => {},
  };
  const handlerSource = sourceBetween(
    "function handleBranchOrdersManagementAction(event)",
    "const branchLoanOverviewColumnCatalog",
  );
  vm.runInNewContext(`${handlerSource}\nglobalThis.handleAction = handleBranchOrdersManagementAction;`, context);
  const invoke = (action) => context.handleAction({
    target: {
      closest: () => ({
        dataset: {
          branchOrdersManagementAction: action,
          branchOrdersManagementId: "item-1",
        },
      }),
    },
    preventDefault() {},
    stopPropagation() {},
  });

  invoke("edit-catalog-item");
  assert.equal(context.state.branchOrdersManagementCatalogEditingId, "item-1");
  assert.equal(revealedItemId, "item-1");
  assert.equal(rendered, 1);

  invoke("remove-catalog-item");
  assert.deepEqual(JSON.parse(JSON.stringify(draft.items)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(draft.groups[0].itemIds)), []);
  assert.equal(context.state.branchOrdersManagementCatalogEditingId, "");
  assert.equal(rendered, 2);
});

test("Tabellenzeilen bleiben lesend und bieten nur kleine Textaktionen", () => {
  const itemMarkup = sourceBetween(
    "const catalogPositions = new Map",
    "const groupRows = draft.groups.length",
  );
  assert.match(appSource, /branch-orders-management-catalog-table/);
  assert.match(itemMarkup, />Bearbeiten<\/button>/);
  assert.match(itemMarkup, />Löschen<\/button>/);
  assert.doesNotMatch(itemMarkup, /<tr[^>]+data-branch-orders-management-action=/);
  assert.match(appSource, /data-branch-orders-management-new-item-title/);
  assert.match(stylesSource, /\.branch-orders-management-table-action[^}]*text-decoration:underline/);
});

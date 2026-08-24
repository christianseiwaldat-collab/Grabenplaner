"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const portalSource = fs.readFileSync(path.join(root, "public", "portal.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "public", "portal.css"), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = portalSource.indexOf(startMarker);
  const end = portalSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Startmarker fehlt: ${startMarker}`);
  assert.notEqual(end, -1, `Endmarker fehlt: ${endMarker}`);
  return portalSource.slice(start, end);
}

test("Portal-Konfiguration normalisiert Versandarten und sortiert Positionen alphanumerisch", () => {
  const context = {
    Intl,
    branchOrderClientId: (prefix) => `${prefix}-test`,
    portalState: { branchOrderSettingsUnitSort: { key: "title", direction: "asc" } },
  };
  const helpers = sourceBetween(
    "const branchOrderDeliveryModes",
    "function renderBranchOrderSettings()",
  );
  vm.runInNewContext(`${helpers}\nglobalThis.branchOrders = { clonedBranchOrderConfiguration, branchOrderItemsAlphabetically, sortBranchOrderGroupItemIdsAlphabetically, sortedBranchOrderSettingsUnits, branchOrderSettingsUnitHeader };`, context);

  const cloned = context.branchOrders.clonedBranchOrderConfiguration({
    recipients: [
      { id: "default", email: "a@example.test" },
      {
        id: "configured",
        email: "b@example.test",
        ccEmail: "cc@example.test",
        primaryDeliveryMode: "message_pdf",
        ccDeliveryMode: "pdf_only",
      },
      { id: "invalid", primaryDeliveryMode: "unknown", ccDeliveryMode: "" },
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(cloned.recipients.map((recipient) => ({
    id: recipient.id,
    ccEmail: recipient.ccEmail,
    primaryDeliveryMode: recipient.primaryDeliveryMode,
    ccDeliveryMode: recipient.ccDeliveryMode,
  })))), [
    { id: "default", ccEmail: "", primaryDeliveryMode: "message", ccDeliveryMode: "message" },
    { id: "configured", ccEmail: "cc@example.test", primaryDeliveryMode: "message_pdf", ccDeliveryMode: "pdf_only" },
    { id: "invalid", ccEmail: "", primaryDeliveryMode: "message", ccDeliveryMode: "message" },
  ]);

  const items = [
    { id: "ten", title: "Plotter 10" },
    { id: "alpha", title: "Analogfilm" },
    { id: "two", title: "Plotter 2" },
  ];
  assert.deepEqual(
    Array.from(context.branchOrders.branchOrderItemsAlphabetically(items), (item) => item.id),
    ["alpha", "two", "ten"],
  );
  assert.deepEqual(items.map((item) => item.id), ["ten", "alpha", "two"], "Katalogreihenfolge bleibt unverändert");

  const group = { itemIds: ["ten", "missing", "alpha", "two"] };
  context.branchOrders.sortBranchOrderGroupItemIdsAlphabetically(group, items);
  assert.deepEqual(Array.from(group.itemIds), ["alpha", "two", "ten", "missing"]);

  const units = [{ id: "roll-10", title: "Rolle 10" }, { id: "roll-2", title: "Rolle 2" }];
  assert.deepEqual(
    Array.from(context.branchOrders.sortedBranchOrderSettingsUnits(units), (unit) => unit.id),
    ["roll-2", "roll-10"],
  );
  assert.match(context.branchOrders.branchOrderSettingsUnitHeader(), /aria-sort="ascending"/);
  assert.match(context.branchOrders.branchOrderSettingsUnitHeader(), /data-branch-order-sort-units="title"/);
});

test("Portal zeigt Empfängeroptionen, A-Z-Aktion und kompakte Maßeinheitentabelle", () => {
  const renderSource = sourceBetween(
    "function renderBranchOrderSettings()",
    "function branchOrderDraftRecipient(id)",
  );
  const interactionSource = sourceBetween(
    "function updateBranchOrderSettingsDraft(event)",
    "el.loanRefresh?.addEventListener",
  );

  assert.match(renderSource, /data-branch-order-settings-field="recipient-cc-email"/);
  assert.match(renderSource, /data-branch-order-settings-field="recipient-primary-delivery-mode"/);
  assert.match(renderSource, /data-branch-order-settings-field="recipient-cc-delivery-mode"/);
  assert.match(renderSource, /\["message_pdf", "E-Mail-Text \+ Bestell-PDF"\]/);
  assert.match(renderSource, /\["pdf_only", "Nur Bestell-PDF"\]/);
  assert.match(renderSource, /!emailDelivery\.attachmentsAvailable \? "disabled"/);
  assert.match(renderSource, /emailDelivery\.available && emailDelivery\.attachmentsAvailable/);
  assert.match(renderSource, /data-branch-order-sort-group-items=/);
  assert.match(renderSource, />A–Z sortieren<\/button>/);
  assert.match(renderSource, /const assignableItems = \(group\) => branchOrderItemsAlphabetically/);
  assert.match(renderSource, /class="branch-order-unit-table"/);
  assert.match(renderSource, /branchOrderSettingsUnitHeader\(\)/);
  assert.match(renderSource, /data-branch-order-new-unit-title/);
  assert.match(renderSource, /data-branch-order-edit-unit=/);
  assert.match(renderSource, />Bearbeiten<\/button>/);
  assert.match(renderSource, />Löschen<\/button>/);
  assert.doesNotMatch(renderSource, /<tr[^>]*data-branch-order-edit-unit=/, "Tabellenzeilen sind nicht klickbar");
  assert.match(interactionSource, /Diese Einheit wird noch von einer Position verwendet/);
  assert.match(interactionSource, /sortBranchOrderGroupItemIdsAlphabetically\(group, draft\.items\)/);
  assert.match(interactionSource, /Bitte eine Bezeichnung für die neue Maßeinheit eingeben/);
  assert.match(portalSource, /branchOrderSettings\?\.emailDelivery\?\.attachmentsAvailable !== true/);

  assert.match(stylesSource, /\.branch-order-unit-table-wrap[^}]*overflow-x:auto/);
  assert.match(stylesSource, /\.branch-order-table-action[^}]*text-decoration:underline/);
  assert.match(stylesSource, /\.branch-order-unit-order-button[^}]*width:32px/);
  assert.match(stylesSource, /\.branch-order-unit-sort-button[^}]*cursor:pointer/);
  assert.match(stylesSource, /\.branch-order-editor-grid,\.branch-order-settings-item,\.branch-order-unit-create \{ grid-template-columns:1fr/);
});

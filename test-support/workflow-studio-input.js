"use strict";

const { randomUUID } = require("node:crypto");
const Editor = require("../public/workflow-studio-editor");

function input() {
  const draft = Editor.createDraft(null, { type: "company", locationId: null, departmentId: null }, randomUUID);
  draft.title = "Beschaffung im Team";
  draft.description = "Erste Zeile\nZweite Zeile";
  draft.category = "Waren für die Filiale";
  draft.processTypeLabel = "Einkauf";
  draft.steps[0].title = "Bestellung prüfen";
  draft.steps[0].description = "Dokumentation\nmit mehreren Zeilen";
  draft.steps[0].responsibilityReference = "hr";
  return {
    revision: 0, title: draft.title, description: draft.description, symbol: draft.symbol,
    category: draft.category, processTypeLabel: draft.processTypeLabel,
    scope: draft.scope, steps: draft.steps,
  };
}

function payload(draft) {
  const { id, status, snapshotSha256, createdAt, updatedAt, ...data } = draft;
  return data;
}

module.exports = { input, payload };

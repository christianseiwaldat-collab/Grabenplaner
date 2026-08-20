"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFunctionSearchUi } = require("../public/function-search-ui");

class FakeClassList {
  constructor(values = []) { this.values = new Set(values); }
  contains(value) { return this.values.has(value); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

class FakeElement {
  constructor(ownerDocument, tagName = "div", classes = []) {
    this.ownerDocument = ownerDocument;
    this.tagName = String(tagName).toUpperCase();
    this.classList = new FakeClassList(classes);
    this.attributes = new Map();
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.id = "";
    this.type = "";
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.focusCalls = [];
    this.scrollCalls = [];
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children.forEach((child) => { child.parentElement = null; });
    this.children = [];
    children.forEach((child) => this.appendChild(child));
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }

  dispatch(type, init = {}) {
    const event = {
      type,
      target: init.target || this,
      key: init.key || "",
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...init,
    };
    [...(this.listeners.get(type) || [])].forEach((listener) => listener(event));
    return event;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      if (selector === '[role="option"]' && node.getAttribute("role") === "option") matches.push(node);
      node.children.forEach(visit);
    };
    this.children.forEach(visit);
    return matches;
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (selector === "[data-function-search-index]"
        && Object.hasOwn(current.dataset, "functionSearchIndex")) return current;
      current = current.parentElement;
    }
    return null;
  }

  focus(options) { this.focusCalls.push(options); }
  scrollIntoView(options) { this.scrollCalls.push(options); }
}

class FakeDocument {
  constructor() { this.listeners = new Map(); }
  createElement(tagName) { return new FakeElement(this, tagName); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, init = {}) {
    const event = { type, target: init.target || null, ...init };
    [...(this.listeners.get(type) || [])].forEach((listener) => listener(event));
    return event;
  }
}

function fixture(search, onSelect = null) {
  const documentRef = new FakeDocument();
  const container = new FakeElement(documentRef, "section");
  const input = container.appendChild(new FakeElement(documentRef, "input"));
  const clearButton = container.appendChild(new FakeElement(documentRef, "button", ["hidden"]));
  const popover = container.appendChild(new FakeElement(documentRef, "div", ["hidden"]));
  const status = popover.appendChild(new FakeElement(documentRef, "p"));
  const results = popover.appendChild(new FakeElement(documentRef, "div"));
  const controller = createFunctionSearchUi({
    container,
    input,
    clearButton,
    popover,
    status,
    results,
    search,
    onSelect,
  });
  return { documentRef, container, input, clearButton, popover, status, results, controller };
}

const SEARCH_RESULTS = Object.freeze([
  Object.freeze({
    id: "planning.overview",
    entry: Object.freeze({ id: "planning.overview", label: "Dienstplanung öffnen", path: ["Filialverwaltung", "Dienstplanung"] }),
  }),
  Object.freeze({
    id: "vacation.overview",
    entry: Object.freeze({ id: "vacation.overview", label: "Urlaubsplanung öffnen", path: ["Filialverwaltung", "Urlaubsplanung"] }),
  }),
]);

test("Block 5: Combobox aktualisiert Treffer, aktives Ziel und Auswahl vollständig per Tastatur", () => {
  const selected = [];
  const ui = fixture(() => SEARCH_RESULTS, (entry, result) => selected.push({ entry, result }));
  ui.input.value = "Planung";
  ui.input.dispatch("input");

  assert.equal(ui.popover.classList.contains("hidden"), false);
  assert.equal(ui.input.getAttribute("aria-expanded"), "true");
  assert.equal(ui.clearButton.classList.contains("hidden"), false);
  assert.equal(ui.status.textContent, "2 Treffer");
  assert.equal(ui.results.children.length, 2);
  assert.equal(ui.results.children[0].type, "button");
  assert.equal(ui.results.children[0].getAttribute("role"), "option");
  assert.equal(ui.results.children[0].getAttribute("tabindex"), "-1");
  assert.equal(ui.results.children[0].getAttribute("aria-selected"), "true");
  assert.equal(ui.input.getAttribute("aria-activedescendant"), ui.results.children[0].id);

  const down = ui.input.dispatch("keydown", { key: "ArrowDown" });
  assert.equal(down.defaultPrevented, true);
  assert.equal(ui.results.children[0].getAttribute("aria-selected"), "false");
  assert.equal(ui.results.children[1].getAttribute("aria-selected"), "true");
  assert.equal(ui.input.getAttribute("aria-activedescendant"), ui.results.children[1].id);
  assert.equal(ui.results.children[1].scrollCalls.length, 1);

  const enter = ui.input.dispatch("keydown", { key: "Enter" });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].entry.id, "vacation.overview");
  assert.equal(selected[0].result, SEARCH_RESULTS[1]);
  assert.equal(ui.popover.classList.contains("hidden"), true);
  assert.equal(ui.input.getAttribute("aria-expanded"), "false");
  assert.equal(ui.input.getAttribute("aria-activedescendant"), null);
});
test("Block 5: Maus, Escape, Außenklick und Löschen halten Fokus und Offenstatus konsistent", () => {
  const selected = [];
  const ui = fixture(() => SEARCH_RESULTS, (entry) => selected.push(entry.id));
  ui.input.value = "Urlaub";
  ui.controller.refresh();

  ui.results.dispatch("pointermove", { target: ui.results.children[1] });
  assert.equal(ui.results.children[1].getAttribute("aria-selected"), "true");
  ui.results.dispatch("click", { target: ui.results.children[1] });
  assert.deepEqual(selected, ["vacation.overview"]);

  ui.controller.refresh();
  const escape = ui.input.dispatch("keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.propagationStopped, true);
  assert.equal(ui.popover.classList.contains("hidden"), true);

  ui.controller.refresh();
  const outside = new FakeElement(ui.documentRef, "button");
  ui.documentRef.dispatch("pointerdown", { target: outside });
  assert.equal(ui.popover.classList.contains("hidden"), true);

  ui.input.value = "Urlaub";
  ui.controller.refresh();
  ui.clearButton.dispatch("click");
  assert.equal(ui.input.value, "");
  assert.equal(ui.results.children.length, 0);
  assert.equal(ui.clearButton.classList.contains("hidden"), true);
  assert.equal(ui.input.focusCalls.length, 1);
});

test("Block 5: Fehler, ausgeblendete Suche und Destroy liefern keine veralteten Treffer", () => {
  let calls = 0;
  const ui = fixture(() => {
    calls += 1;
    throw new Error("synthetic search failure");
  });
  ui.input.value = "Backup";
  assert.deepEqual(ui.controller.refresh(), []);
  assert.equal(ui.status.textContent, "Keine passende Funktion gefunden.");
  assert.equal(ui.popover.classList.contains("hidden"), false);

  ui.controller.setVisible(false);
  assert.equal(ui.input.value, "");
  assert.equal(ui.results.children.length, 0);
  assert.equal(ui.popover.classList.contains("hidden"), true);
  ui.input.value = "Dienstplan";
  ui.input.dispatch("input");
  assert.equal(calls, 1);

  ui.controller.destroy();
  ui.input.value = "Urlaub";
  ui.input.dispatch("input");
  assert.equal(calls, 1);
  assert.equal(ui.documentRef.listeners.get("pointerdown")?.size || 0, 0);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseDocument } = require('htmlparser2');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function sourceBetween(start, end) {
  const left = source.indexOf(start), right = source.indexOf(end, left + start.length);
  assert.ok(left >= 0 && right > left);
  return source.slice(left, right);
}
function context(extra = {}) {
  const ctx = { ...extra, document: { createElement() { return { textContent: '', get innerHTML() { return this.textContent.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); } }; } } };
  vm.runInNewContext(sourceBetween('function escapeHtml(value)', 'function activeLocations()'), ctx);
  return ctx;
}
function nodes(root, predicate) {
  const found = [];
  function walk(node) { if (predicate(node)) found.push(node); for (const child of node.children || []) walk(child); }
  walk(root); return found;
}
function renderCatalog(title) {
  const item = { id: 'synthetic-item', title, unitId: '', recipientId: '' };
  const workspace = { innerHTML: '' };
  const ctx = context({
    elements: { branchOrdersView: {}, branchOrdersManagementWorkspace: workspace },
    state: { branchOrdersManagement: { locationId: 'synthetic-location', emailDelivery: {} },
      branchOrdersManagementDraft: { recipients: [], units: [], items: [item], groups: [] },
      branchOrdersManagementCatalogEditingId: item.id, branchOrdersManagementCatalogSearch: '' },
    branchOrdersManagementLocations: () => [{ id: 'synthetic-location', name: 'Synthetic' }],
    selectedBranchOrdersManagementLocationId: () => 'synthetic-location',
    captureBranchOrdersManagementDisclosureState: () => new Map(),
    sortedBranchOrdersManagementUnits: draft => draft.units,
    sortedBranchOrdersManagementCatalogItems: draft => draft.items,
    branchOrdersManagementUnitHeader: () => '', branchOrdersManagementCatalogHeader: () => '',
    restoreBranchOrdersManagementDisclosureState() {}, applyBranchOrdersManagementCatalogSearch() {}, renderBranchOrdersManagementHistory() {},
  });
  vm.runInNewContext(sourceBetween('function renderBranchOrdersManagement()', 'function rememberBranchOrderView()'), ctx);
  ctx.renderBranchOrdersManagement();
  return parseDocument(workspace.innerHTML);
}

test('app HTML encoding keeps hostile text inside both quoted attribute contexts', () => {
  const { escapeHtml } = context();
  const hostile = `\" autofocus onfocus=\"alert(1) ' data-extra='value & <svg/onload=alert(2)>`;
  for (const quote of ['"', "'"]) {
    const document = parseDocument(`<input value=${quote}${escapeHtml(hostile)}${quote}>`);
    const inputs = nodes(document, node => node.name === 'input');
    assert.equal(inputs.length, 1);
    assert.deepEqual(Object.keys(inputs[0].attribs), ['value']);
    assert.equal(inputs[0].attribs.value, hostile);
    assert.equal(nodes(document, node => node.name === 'svg').length, 0);
  }
});

test('real branch order catalog renderer cannot create event or structural attributes from stored titles', () => {
  const hostile = 'Product" autofocus onfocus="alert(1)" data-injected="yes';
  const document = renderCatalog(hostile);
  const inputs = nodes(document, node => node.name === 'input' && node.attribs['data-branch-orders-management-field'] === 'catalog-item-title');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].attribs.value, hostile);
  assert.equal(inputs[0].attribs.maxlength, '180');
  assert.deepEqual(Object.keys(inputs[0].attribs).sort(), ['data-branch-orders-management-field', 'maxlength', 'value']);
  assert.equal(nodes(document, node => Object.keys(node.attribs || {}).some(key => /^on|^autofocus$|^data-injected$/.test(key))).length, 0);
});

test('normal catalog labels preserve quotes, ampersands, umlauts and numeric values', () => {
  const label = 'Fotopapier "Glanz" & O\'Brien – Größe 10×15';
  const document = renderCatalog(label);
  const input = nodes(document, node => node.name === 'input' && node.attribs['data-branch-orders-management-field'] === 'catalog-item-title')[0];
  assert.equal(input.attribs.value, label);
  assert.ok(nodes(document, node => node.type === 'text').some(node => node.data === label));
  const { escapeHtml } = context();
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
});

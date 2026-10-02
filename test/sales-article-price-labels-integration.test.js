'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const integration = source.slice(source.indexOf('function applySalesArticleDetailTabs()'), source.indexOf('function normalizeSalesArticleCatalogItem'));

function harness() {
  const links = Array.from({ length: 7 }, () => ({ setAttribute() {}, classList: { toggle() {} } }));
  const panels = new Map();
  const calls = [];
  const context = {
    state: { currentView: 'articleCatalog', salesArticleCatalog: {
      detailTab: 'salesArticlePriceLabelsSection', detail: { article: { articleNumber: '107014' } },
      tools: { activate: id => calls.push(['history', id]) }, priceLabels: {
        activate: () => calls.push(['labels']), suspend: () => calls.push(['suspend']),
      },
    } },
    elements: { salesArticleDetailNavigation: { setAttribute() {}, querySelectorAll: () => links } },
    document: { getElementById: id => { if (!panels.has(id)) panels.set(id, { setAttribute() {} }); return panels.get(id); } },
    canUseSalesPriceLabels: () => true,
    currentSalesArticleCatalogDetailAccessKey: () => 'article-owner',
    currentSalesPriceLabelsAccessKey: () => 'label-owner',
    setView: view => { calls.push(['view', view]); context.state.currentView = view; },
    salesPriceLabelsWorkspace: { openArticle: (...args) => calls.push(['open', ...args]) },
  };
  vm.createContext(context); vm.runInContext(integration, context);
  return { context, links, panels, calls };
}

test('Preisschild is placed after sales and activates its library only when selected', () => {
  const navigation = html.slice(html.indexOf('id="salesArticleDetailNavigation"'), html.indexOf('id="salesArticleDetailBody"'));
  assert.ok(navigation.indexOf('href="#salesArticleSalesSection"') < navigation.indexOf('href="#salesArticlePriceLabelsSection"'));
  const { context, links, panels, calls } = harness();
  context.applySalesArticleDetailTabs();
  assert.equal(links[6].hidden, false);
  assert.equal(panels.get('salesArticlePriceLabelsSection').hidden, false);
  assert.equal(calls.filter(call => call[0] === 'labels').length, 1);
  context.state.salesArticleCatalog.detailTab = 'salesArticleOverviewPanel';
  context.applySalesArticleDetailTabs();
  assert.equal(panels.get('salesArticlePriceLabelsSection').hidden, true);
  assert.equal(calls.filter(call => call[0] === 'suspend').length, 1);
  assert.equal(calls.filter(call => call[0] === 'labels').length, 1);
});

test('Without price-label rights the tab is hidden and a stale selection falls back to master data', () => {
  const { context, links, panels, calls } = harness();
  context.canUseSalesPriceLabels = () => false;
  context.applySalesArticleDetailTabs();
  assert.equal(links[6].hidden, true);
  assert.equal(panels.get('salesArticleOverviewPanel').hidden, false);
  assert.equal(panels.get('salesArticlePriceLabelsSection').hidden, true);
  assert.equal(calls.some(call => call[0] === 'labels'), false);
});

test('Opening a current article passes template and copy intent, while stale article or rights are rejected', () => {
  const { context, calls } = harness();
  context.openSalesArticlePriceLabel({ articleNumber: '107014', templateId: 'shared-template', copy: true });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['view', 'priceLabels'], ['open', '107014', 'shared-template', { copy: true }]]);
  calls.length = 0;
  context.state.currentView = 'articleCatalog';
  context.openSalesArticlePriceLabel({ articleNumber: 'old-article' });
  assert.equal(calls.length, 0);
  context.canUseSalesPriceLabels = () => false;
  context.openSalesArticlePriceLabel({ articleNumber: '107014' });
  assert.equal(calls.length, 0);
  assert.equal(context.currentSalesArticlePriceLabelsAccessKey(), 'article-owner|label-owner');
});

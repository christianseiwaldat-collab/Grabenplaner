(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SalesArticleColumnWidths = api;
})(typeof window === 'object' ? window : this, function() {
  'use strict';
  const MIN = 80, MAX = 800;
  const DEFAULTS = Object.freeze({articleNumber:125, description:340, retailGross:150, internetGross:180,
    retailNet:150, internetNet:180, purchaseNet:140, purchaseGross:140, primaryIdentifier:170, status:90, sourceSystem:155});
  const clamp = value => Math.min(MAX, Math.max(MIN, Math.round(value)));
  function normalize(input, ids = Object.keys(DEFAULTS)) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    return Object.fromEntries(ids.filter(id => Object.hasOwn(input, id) && typeof input[id] === 'number' && Number.isFinite(input[id]))
      .map(id => [id, clamp(input[id])]));
  }
  function valid(input, ids = Object.keys(DEFAULTS)) {
    return input !== null && typeof input === 'object' && !Array.isArray(input)
      && Object.entries(input).every(([id, width]) => ids.includes(id) && Number.isInteger(width) && width >= MIN && width <= MAX);
  }
  const tableLayout = typeof module === 'object' && module.exports ? require('./table-layout') : window.GrabenplanerTableLayout;
  function attach(table, options) {
    return tableLayout.attach(table, {...options, defaults:DEFAULTS, allowedColumns:() => Object.keys(DEFAULTS), resizeAttribute:'data-sales-article-column-resize'});
  }
  return {MIN, MAX, DEFAULTS, clamp, normalize, valid, attach};
});

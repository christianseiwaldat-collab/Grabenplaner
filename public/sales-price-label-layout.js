(function(host, factory) {
  'use strict'; const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host) host.GrabenplanerPriceLabelLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const MAX_LABELS = 1000, MAX_PAGES = 200, BORDER_WIDTH_MM = .18, CUT_WIDTH_MM = .15;
  const papers = Object.freeze({A4:Object.freeze([210,297]), A5:Object.freeze([148,210]), A6:Object.freeze([105,148])});
  // Callers validate their options first. Millimeters stay unrounded here so
  // browser, export and decimal paper sizes all use the same physical grid.
  function create(options, itemCount = 0) {
    if (!Number.isInteger(itemCount) || itemCount < 0) throw new TypeError('Ungültige Artikelanzahl.');
    const base = options.paper === 'custom' ? [options.paperWidthMm, options.paperHeightMm] : papers[options.paper];
    const width = options.orientation === 'portrait' ? Math.min(...base) : Math.max(...base);
    const height = options.orientation === 'portrait' ? Math.max(...base) : Math.min(...base);
    const columns = Math.max(0, Math.floor((width - 2 * options.marginMm + options.gapMm + 1e-8) / (options.labelWidthMm + options.gapMm)));
    const rows = Math.max(0, Math.floor((height - 2 * options.marginMm + options.gapMm + 1e-8) / (options.labelHeightMm + options.gapMm)));
    const capacity = columns * rows, labelCount = itemCount * options.copies;
    const pageCount = capacity ? Math.ceil(labelCount / capacity) : 0;
    function slot(index) {
      if (!capacity || !Number.isInteger(index) || index < 0) return null;
      const position = index % capacity, column = position % columns, row = Math.floor(position / columns);
      return Object.freeze({index, page:Math.floor(index / capacity), position, column, row,
        x:options.marginMm + column * (options.labelWidthMm + options.gapMm),
        y:options.marginMm + row * (options.labelHeightMm + options.gapMm),
        width:options.labelWidthMm, height:options.labelHeightMm, occupied:index < labelCount,
        itemIndex:Math.floor(index / options.copies), copyIndex:index % options.copies});
    }
    function page(index = 0) {
      if (!capacity || !Number.isInteger(index) || index < 0 || index >= Math.max(1, pageCount)) return [];
      return Array.from({length:capacity}, (_, position) => slot(index * capacity + position));
    }
    return Object.freeze({width, height, columns, rows, capacity, labelCount, pageCount,
      pageWidthMm:width, pageHeightMm:height, perPage:capacity,
      exceedsLimits:labelCount > MAX_LABELS || pageCount > MAX_PAGES, slot, page});
  }
  function shapeBounds(shape, x, y, width, height, strokeWidth = 0) {
    const inset = strokeWidth / 2;
    if (shape === 'circle') {
      const diameter = Math.min(width, height) - strokeWidth;
      return {kind:'circle', x:x + (width - diameter) / 2, y:y + (height - diameter) / 2,
        width:diameter, height:diameter, radius:diameter / 2};
    }
    return {kind:shape === 'rounded' ? 'rounded' : 'rectangle', x:x + inset, y:y + inset,
      width:width - strokeWidth, height:height - strokeWidth,
      radius:shape === 'rounded' ? Math.max(0, Math.min(3, width * .1, height * .1) - inset) : 0};
  }
  const cutsVisible = options => options.showBorder === false && options.cutMarks === true;
  return Object.freeze({create, shapeBounds, cutsVisible, MAX_LABELS, MAX_PAGES, BORDER_WIDTH_MM, CUT_WIDTH_MM});
});

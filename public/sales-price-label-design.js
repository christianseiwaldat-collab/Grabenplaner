(function(host, factory) {
  'use strict'; const common = typeof module === 'object' && module.exports;
  const api = factory(common ? require('./sales-price-label-fonts') : host.GrabenplanerPriceLabelFonts);
  if (common) module.exports = api;
  if (host) host.GrabenplanerPriceLabelDesign = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Fonts) {
  'use strict';
  const MM = 72 / 25.4, MIN_FONT_SIZE_PT = 5, MAX_FONT_SIZE_PT = 120, MIN_BOX_MM = 1;
  const fields = Object.freeze([
    ['headline', 'Überschrift'], ['brand', 'Marke'], ['description', 'Artikeltext'], ['price', 'Preis'],
    ['articleNumber', 'Artikelnummer'], ['ean', 'EAN'], ['tax', 'MwSt.-Hinweis'], ['footer', 'Fußtext'],
  ].map(([id, label]) => Object.freeze({id, label})));
  const fieldIds = Object.freeze(fields.map(field => field.id));
  const geometryKeys = ['xMm', 'yMm', 'widthMm', 'heightMm'];
  const textKeys = ['fontId', 'fontSizePt', ...geometryKeys];
  const imageKeys = ['assetId', ...geometryKeys];
  const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  const plain = value => value && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const fail = () => { throw new TypeError('Die Text- oder Bildgestaltung des Preisschilds ist ungültig.'); };
  function dimensions(options) {
    const width = options?.labelWidthMm, height = options?.labelHeightMm;
    if (![width, height].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 10 && value <= 500)) fail();
    return {width, height};
  }
  function geometry(value, options) {
    const {width, height} = dimensions(options);
    if (!geometryKeys.every(key => Object.hasOwn(value, key) && typeof value[key] === 'number' && Number.isFinite(value[key]))) fail();
    const {xMm, yMm, widthMm, heightMm} = value;
    if (xMm < 0 || yMm < 0 || widthMm < MIN_BOX_MM || heightMm < MIN_BOX_MM
      || xMm + widthMm > width + .001 || yMm + heightMm > height + .001) fail();
    return {xMm, yMm, widthMm, heightMm};
  }
  function normalizeTextBoxes(value = {}, options) {
    if (!plain(value) || Object.keys(value).some(key => !fieldIds.includes(key))) fail();
    const result = {};
    for (const id of fieldIds) {
      if (!Object.hasOwn(value, id)) continue;
      const box = value[id];
      if (!plain(box) || Object.keys(box).length !== textKeys.length || Object.keys(box).some(key => !textKeys.includes(key))
        || !Fonts.get(box.fontId) || typeof box.fontSizePt !== 'number' || !Number.isFinite(box.fontSizePt)
        || box.fontSizePt < MIN_FONT_SIZE_PT || box.fontSizePt > MAX_FONT_SIZE_PT) fail();
      result[id] = Object.freeze({fontId:box.fontId, fontSizePt:box.fontSizePt, ...geometry(box, options)});
    }
    return Object.freeze(result);
  }
  function normalizeImageBoxes(value = [], options) {
    if (!Array.isArray(value) || value.length > 3) fail();
    const ids = new Set();
    return Object.freeze(value.map(box => {
      if (!plain(box) || Object.keys(box).length !== imageKeys.length || Object.keys(box).some(key => !imageKeys.includes(key))
        || typeof box.assetId !== 'string' || !UUID.test(box.assetId) || ids.has(box.assetId)) fail();
      ids.add(box.assetId);
      return Object.freeze({assetId:box.assetId, ...geometry(box, options)});
    }));
  }
  // The editor rounds only a gesture result, never saved or default geometry.
  function boundedBox(options, value) {
    const {width, height} = dimensions(options);
    if (!plain(value) || !geometryKeys.every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))) fail();
    const floor = number => Math.floor((number + 1e-8) * 100) / 100;
    const round = number => Math.round(number * 100) / 100;
    const widthMm = floor(Math.max(MIN_BOX_MM, Math.min(width, value.widthMm)));
    const heightMm = floor(Math.max(MIN_BOX_MM, Math.min(height, value.heightMm)));
    const xMm = Math.min(floor(width - widthMm), Math.max(0, round(value.xMm)));
    const yMm = Math.min(floor(height - heightMm), Math.max(0, round(value.yMm)));
    return Object.freeze({xMm, yMm, widthMm, heightMm});
  }
  function getContentGeometry(options, {hasLogo = Boolean(options.logoKitId && options.logoAssetKey), hasPhoto = false} = {}) {
    const {width, height} = dimensions(options);
    let xMm = 0, yMm = 0, widthMm = width, heightMm = height;
    if (options.shape === 'circle') {
      const side = Math.min(width, height) * .69;
      xMm = (width - side) / 2; yMm = (height - side) / 2; widthMm = side; heightMm = side;
    }
    const padMm = Math.min(4, widthMm * .06, heightMm * .075);
    xMm += padMm; yMm += padMm; widthMm -= 2 * padMm; heightMm -= 2 * padMm;
    const reservedLogo = Boolean(hasLogo && options.logoMode === 'reserved');
    let logoBox = null;
    if (reservedLogo) {
      const top = options.logoPosition.startsWith('top-'), anchor = options.logoPosition.split('-')[1];
      logoBox = Object.freeze({xMm:anchor === 'center' ? xMm + (widthMm - options.logoWidthMm) / 2
        : anchor === 'right' ? xMm + widthMm - options.logoWidthMm : xMm,
      yMm:top ? yMm : yMm + heightMm - options.logoHeightMm, widthMm:options.logoWidthMm, heightMm:options.logoHeightMm});
      const reservedHeight = options.logoHeightMm + options.logoSpacingMm;
      if (top) yMm += reservedHeight;
      heightMm -= reservedHeight;
    } else if (hasLogo) {
      logoBox = Object.freeze({xMm:options.logoXmm, yMm:options.logoYmm, widthMm:options.logoWidthMm, heightMm:options.logoHeightMm});
    }
    const topHeightMm = heightMm * .13, descriptionYmm = yMm + topHeightMm + heightMm * .025, descriptionHeightMm = heightMm * .25;
    const photoWidthMm = hasPhoto ? Math.min(widthMm * .28, descriptionHeightMm * 1.1) : 0;
    const photoBox = photoWidthMm ? Object.freeze({xMm:xMm + widthMm - photoWidthMm, yMm:descriptionYmm,
      widthMm:photoWidthMm, heightMm:descriptionHeightMm}) : null;
    const before = reservedLogo && options.logoPosition.startsWith('top-') ? Math.min(padMm * .5, options.logoSpacingMm) : 0;
    const promoBand = Object.freeze({xMm:0, yMm:reservedLogo && options.logoPosition.startsWith('top-') ? yMm - before : 0,
      widthMm:width, heightMm:reservedLogo && options.logoPosition.startsWith('top-')
        ? topHeightMm + before + heightMm * .02 : Math.max(yMm + topHeightMm + heightMm * .02, height * .18)});
    return Object.freeze({xMm, yMm, widthMm, heightMm, padMm, topHeightMm, descriptionYmm, descriptionHeightMm, reservedLogo, logoBox, photoBox, promoBand});
  }
  function contrast(color) {
    const parts = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return parts[0] * .2126 + parts[1] * .7152 + parts[2] * .0722 > .179 ? '#12221C' : '#FFFFFF';
  }
  function taxText(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) value = String(value);
    if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,6})?$/.test(value) || Number(value) > 100) return 'MwSt. prüfen';
    return 'inkl. ' + (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value).replace('.', ',') + ' % MwSt.';
  }
  // Each ID is independent, even when the legacy headline uses the brand as
  // its fallback. Sparse overrides leave every untouched field on that layout.
  function create(options, item = {}, context = {}) {
    const hasPhoto = context.hasPhoto === undefined ? Boolean(options.showPhoto && (item.imageKey || item.imageUrl)) : context.hasPhoto;
    const overrides = normalizeTextBoxes(options.textBoxes, options), content = getContentGeometry(options, {...context,hasPhoto});
    const {xMm, yMm, widthMm, heightMm, topHeightMm, descriptionYmm, descriptionHeightMm, reservedLogo} = content;
    const imageWidthMm = content.photoBox?.widthMm || 0;
    const align = options.design === 'minimal' ? 'center' : 'left';
    const header = {xMm, yMm, widthMm, heightMm:topHeightMm, fontSizePt:Math.min(13, topHeightMm * MM / 1.25),
      minFontSizePt:6, bold:true, truncate:true, align, color:options.design === 'promo' ? contrast(options.color) : options.color};
    const boxes = {
      headline:{...header, visible:Boolean(options.headline)},
      brand:{...header, visible:Boolean(item.brand && (!options.headline || overrides.brand))},
      description:{xMm, yMm:descriptionYmm, widthMm:widthMm - (imageWidthMm ? imageWidthMm + 2 : 0), heightMm:descriptionHeightMm,
        fontSizePt:Math.min(14, heightMm * MM * .095), minFontSizePt:6, bold:options.design !== 'minimal', truncate:true, align, color:'#12221C', visible:true},
      price:{xMm, yMm:yMm + heightMm * (reservedLogo ? .43 : .445), widthMm, heightMm:heightMm * (reservedLogo ? .25 : .275),
        fontSizePt:Math.min(85, heightMm * MM * (reservedLogo ? .20 : .225)), minFontSizePt:12, bold:true, truncate:false, align:'center',
        color:options.design === 'promo' && contrast(options.color) === '#FFFFFF' ? options.color : '#12221C', visible:true},
    };
    const detailIds = ['tax', 'articleNumber', 'ean', 'footer'];
    const visible = {tax:options.showTax, articleNumber:options.showArticleNumber, ean:Boolean(options.showEan && item.ean), footer:Boolean(options.footer)};
    const selected = detailIds.filter(id => visible[id]), rowCount = Math.max(1, selected.length);
    const startMm = yMm + heightMm * (reservedLogo ? .70 : .735), rowHeightMm = heightMm * (reservedLogo ? .30 : .265) / rowCount;
    for (const [index, id] of detailIds.entries()) {
      const row = visible[id] ? selected.indexOf(id) : Math.min(index, rowCount - 1);
      boxes[id] = {xMm, yMm:startMm + row * rowHeightMm, widthMm, heightMm:rowHeightMm, fontSizePt:Math.min(8, rowHeightMm * MM / 1.25),
        minFontSizePt:5, bold:false, truncate:id === 'footer', align:'center', color:'#44564D', visible:Boolean(visible[id])};
    }
    return Object.freeze(Object.fromEntries(fieldIds.map(id => [id, Object.freeze({...boxes[id], fontId:options.fontId,
      ...(overrides[id] || {}), override:Boolean(overrides[id])})])));
  }
  function layoutText(value, box, measureText) {
    if (typeof value !== 'string' || typeof measureText !== 'function') fail();
    const width = box.widthMm * MM, height = box.heightMm * MM;
    const measure = (text, size) => measureText(text, box.fontId, size, Boolean(box.bold));
    function wrapped(size) {
      const lines = []; let line = '';
      for (const word of value.split(/ +/)) {
        if (!word) continue;
        const candidate = line ? line + ' ' + word : word;
        if (measure(candidate, size) <= width) { line = candidate; continue; }
        if (line) { lines.push(line); line = ''; }
        for (const character of word) {
          if (line && measure(line + character, size) > width) { lines.push(line); line = ''; }
          line += character;
        }
      }
      if (line) lines.push(line);
      return lines;
    }
    const result = (size, lines, clipped = false) => Object.freeze({fontSizePt:size, lines:Object.freeze(lines), lineHeightPt:size * 1.22, clipped});
    if (!value) return result(box.fontSizePt, []);
    if (box.override) {
      const lines = wrapped(box.fontSizePt), count = Math.max(0, Math.floor((height + 1e-8) / (box.fontSizePt * 1.22)));
      return result(box.fontSizePt, lines.slice(0, count), lines.length > count || lines.some(line => measure(line, box.fontSizePt) > width + .001));
    }
    for (let size = box.fontSizePt; size >= box.minFontSizePt - .001; size -= .25) {
      const lines = wrapped(size);
      if (lines.length * size * 1.22 <= height && lines.every(line => measure(line, size) <= width + .001)) return result(size, lines);
    }
    const size = box.minFontSizePt, count = Math.floor(height / (size * 1.22));
    if (box.truncate && count >= 1) {
      const lines = wrapped(size).slice(0, count); let last = lines.at(-1);
      while (last && measure(last + '...', size) > width) last = last.slice(0, -1);
      lines[lines.length - 1] = last + '...'; return result(size, lines, true);
    }
    return result(size, [], true);
  }
  return Object.freeze({fields, fieldIds, normalizeTextBoxes, normalizeImageBoxes, boundedBox, getContentGeometry, taxText, create, layoutText,
    MIN_FONT_SIZE_PT, MAX_FONT_SIZE_PT, MIN_BOX_MM, MM});
});

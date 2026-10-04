'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSalesPriceLabelsPdf, normalizeOptions, MM } = require('../lib/sales-price-labels-pdf');
const Editor = require('../public/sales-price-labels');

// This table describes the public format choices, independently of the editor.
const FORMATS = [
  { id: 'window', width: 90, height: 60 },
  { id: 'shelf', width: 70, height: 40 },
  { id: 'stand', width: 105, height: 148 },
  { id: 'a5', width: 148, height: 210 },
  { id: 'a4', width: 210, height: 297 },
];
const article = {
  articleNumber: '000123', description: 'Kamera ÄÖÜ ß', brand: 'FOTO',
  priceGross: '1599.005', taxRate: '20', ean: '4547410533644',
};
const logoSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="#215345"/></svg>');
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < .04, `${message}: ${actual} != ${expected}`);
const contains = (outer, inner) => inner.x >= outer.x - .04 && inner.y >= outer.y - .04
  && inner.x + inner.width <= outer.x + outer.width + .04
  && inner.y + inner.height <= outer.y + outer.height + .04;
function dimensions(format, orientation) {
  const short = Math.min(format.width, format.height), long = Math.max(format.width, format.height);
  return orientation === 'portrait' ? [short, long] : [long, short];
}
function bounds(points) {
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
async function inspect(buffer) {
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), pdf = await task.promise;
  try {
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number), content = await page.getTextContent(), operators = await page.getOperatorList();
      const labels = [], images = [], stack = [];
      let matrix = [1, 0, 0, 1, 0, 0], fillColor = '';
      for (let index = 0; index < operators.fnArray.length; index++) {
        const code = operators.fnArray[index], args = operators.argsArray[index];
        if (code === OPS.save) stack.push({ matrix: matrix.slice(), fillColor });
        else if (code === OPS.restore) ({ matrix, fillColor } = stack.pop() || { matrix: [1, 0, 0, 1, 0, 0], fillColor: '' });
        else if (code === OPS.transform) {
          const [a, b, c, d, e, f] = matrix, [g, h, j, k, l, m] = args;
          matrix = [a * g + c * h, b * g + d * h, a * j + c * k, b * j + d * k, a * l + c * m + e, b * l + d * m + f];
        } else if (code === OPS.setFillRGBColor) fillColor = String(args[0]).toLowerCase();
        else if (code === OPS.constructPath && args[0] === OPS.fill && args[2] && fillColor === '#ffffff') {
          const [a, b, c, d, e, f] = matrix, [x1, y1, x2, y2] = args[2];
          labels.push(bounds([[x1, y1], [x2, y1], [x1, y2], [x2, y2]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f])));
        } else if ([OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(code)) {
          const [a, b, c, d, e, f] = matrix;
          images.push(bounds([[e, f], [a + e, b + f], [c + e, d + f], [a + c + e, b + d + f]]));
        }
      }
      const text = content.items.filter(item => item.str);
      const textRects = text.map(item => {
        const style = content.styles[item.fontName], ascent = style?.ascent ?? .8, descent = style?.descent ?? -.2;
        return { str: item.str, x: item.transform[4], y: item.transform[5] + descent * item.height,
          width: item.width, height: (ascent - descent) * item.height };
      });
      pages.push({ width: page.view[2] - page.view[0], height: page.view[3] - page.view[1], labels, images, textRects,
        text: text.map(item => item.str).join(' '),
        fontNames: [...new Set(text.map(item => page.commonObjs.get(item.fontName)?.name))],
        lastImage: Math.max(operators.fnArray.lastIndexOf(OPS.paintImageXObject), operators.fnArray.lastIndexOf(OPS.paintInlineImageXObject)),
        lastText: operators.fnArray.lastIndexOf(OPS.showText) });
    }
    return pages;
  } finally { await task.destroy(); }
}

test('Editor formats preserve legacy sizes, all paper settings and canonical API keys', () => {
  assert.deepEqual(Editor.labelFormats.map(({ id, width, height }) => ({ id, width, height })), FORMATS);
  const source = { ...Editor.defaults, paper: 'custom', paperWidthMm: 400, paperHeightMm: 450,
    orientation: 'landscape', marginMm: 7, gapMm: 5, fontId: 'spectral', design: 'promo', footer: 'Beratung' };
  const before = { ...source };
  for (const format of FORMATS) {
    const legacy = Editor.applyLabelFormat(source, format.id);
    assert.equal(legacy.labelWidthMm, format.width); assert.equal(legacy.labelHeightMm, format.height);
    for (const orientation of ['portrait', 'landscape']) {
      const changed = Editor.applyLabelFormat(source, format.id, orientation), [width, height] = dimensions(format, orientation);
      assert.equal(changed.labelWidthMm, width); assert.equal(changed.labelHeightMm, height);
      assert.deepEqual(Editor.labelFormat(changed), { id: format.id, orientation });
      assert.deepEqual(Object.keys(changed).sort(), Object.keys(Editor.defaults).sort(), 'Format and label orientation remain presentation choices');
      for (const field of ['paper', 'paperWidthMm', 'paperHeightMm', 'orientation', 'marginMm', 'gapMm', 'fontId', 'footer']) assert.equal(changed[field], source[field], `Choosing a label changed ${field}`);
      assert.equal(changed.design, format.id === 'shelf' ? 'minimal' : source.design, 'Existing shelf design remains available');
      assert.equal(normalizeOptions(changed).labelWidthMm, width, 'Canonical result is accepted by the server');
    }
  }
  assert.deepEqual(source, before, 'Choosing formats does not mutate the source template');
  assert.throws(() => Editor.applyLabelFormat(source, 'a7'));
  assert.throws(() => Editor.applyLabelFormat(source, 'a4', 'horizontal'));
  assert.deepEqual(Editor.labelFormat({ labelWidthMm: 73.5, labelHeightMm: 52 }), { id: 'custom', orientation: 'landscape' });
  const custom = Editor.applyLabelFormat({ ...source, labelWidthMm: 73.5, labelHeightMm: 52 }, 'custom', 'portrait');
  assert.equal(custom.labelWidthMm, 52); assert.equal(custom.labelHeightMm, 73.5);
});

test('Smaller formats keep free-logo boxes bounded without changing paper or chosen font', () => {
  const source = { ...Editor.defaults, labelWidthMm: 210, labelHeightMm: 297, logoMode: 'free',
    logoXmm: 190, logoYmm: 277, logoWidthMm: 20, logoHeightMm: 20, fontId: 'fira-mono' };
  const changed = Editor.applyLabelFormat(source, 'shelf');
  assert.equal(changed.logoWidthMm, 20); assert.equal(changed.logoHeightMm, 20);
  assert.equal(changed.logoXmm, 50); assert.equal(changed.logoYmm, 20);
  assert.equal(changed.fontId, 'fira-mono'); assert.equal(changed.paper, source.paper); assert.equal(changed.orientation, source.orientation);
  assert.equal(normalizeOptions(changed).logoMode, 'free');
  const large = Editor.applyLabelFormat({ ...source, logoXmm: 0, logoYmm: 0, logoWidthMm: 200, logoHeightMm: 210 }, 'shelf', 'portrait');
  assert.equal(large.labelWidthMm, 40); assert.equal(large.labelHeightMm, 70);
  assert.equal(large.logoWidthMm, 40); assert.equal(large.logoHeightMm, 70);
  assert.equal(large.logoXmm, 0); assert.equal(large.logoYmm, 0); normalizeOptions(large);
  assert.equal(source.logoXmm, 190); assert.equal(source.logoYmm, 277, 'Original logo geometry is untouched');
});

test('Paper adjustment only proposes an explicit fit and retains label geometry accepted by the server', async () => {
  assert.equal(Editor.paperAdjustment({ ...Editor.defaults }), null);
  const cases = [
    { width: 210, height: 297, paper: 'A4', orientation: 'portrait', expectedPaper: 'A4', expectedOrientation: 'portrait', expectedMargin: 0 },
    { width: 297, height: 210, paper: 'A4', orientation: 'portrait', expectedPaper: 'A4', expectedOrientation: 'landscape', expectedMargin: 0 },
    { width: 210, height: 148, paper: 'A4', orientation: 'portrait', expectedPaper: 'A4', expectedOrientation: 'landscape', expectedMargin: 10 },
    { width: 148, height: 210, paper: 'A6', orientation: 'portrait', expectedPaper: 'A5', expectedOrientation: 'portrait', expectedMargin: 0 },
    { width: 300, height: 400, paper: 'A4', orientation: 'portrait', expectedPaper: 'custom', expectedOrientation: 'portrait', expectedMargin: 0 },
  ];
  for (const item of cases) {
    const source = { ...Editor.defaults, paper: item.paper, orientation: item.orientation, labelWidthMm: item.width, labelHeightMm: item.height }, before = { ...source };
    assert.equal(Editor.paperLayout(source).capacity, 0);
    const proposal = Editor.paperAdjustment(source);
    assert.equal(proposal.paper, item.expectedPaper); assert.equal(proposal.orientation, item.expectedOrientation); assert.equal(proposal.marginMm, item.expectedMargin);
    assert.deepEqual(source, before, 'Merely rendering a proposal does not apply it');
    assert.deepEqual(Object.keys(proposal).sort(), ['marginMm', 'orientation', 'paper', 'paperHeightMm', 'paperWidthMm'].sort());
    const applied = { ...source, ...proposal }, canonical = normalizeOptions(applied);
    assert.equal(canonical.labelWidthMm, item.width); assert.equal(canonical.labelHeightMm, item.height);
    const [page] = await inspect(await createSalesPriceLabelsPdf({ items: [article], options: applied }));
    near(page.labels[0].width, item.width * MM, 'Proposed paper does not scale label width');
    near(page.labels[0].height, item.height * MM, 'Proposed paper does not scale label height');
  }
});

for (const format of FORMATS) for (const orientation of ['portrait', 'landscape']) {
  test(`${format.id} ${orientation}: PDF preserves exact label geometry, copies and bounded text`, async () => {
    const [labelWidthMm, labelHeightMm] = dimensions(format, orientation);
    const [pageWidthMm, pageHeightMm] = orientation === 'portrait' ? [210, 297] : [297, 210];
    const marginMm = format.id === 'a4' ? 0 : 10;
    const options = { paper: 'A4', orientation, labelWidthMm, labelHeightMm, marginMm, copies: 2, gapMm: 4 };
    const before = { ...options }, normalized = normalizeOptions(options);
    assert.deepEqual(options, before, 'Normalization must not rewrite caller options');
    assert.equal(normalized.labelWidthMm, labelWidthMm); assert.equal(normalized.labelHeightMm, labelHeightMm);
    assert.equal(normalized.paper, 'A4'); assert.equal(normalized.orientation, orientation);
    assert.deepEqual(normalizeOptions(normalized), normalized, 'Saved canonical dimensions remain repeatable');
    const pages = await inspect(await createSalesPriceLabelsPdf({ items: [article], options }));
    const columns = Math.floor((pageWidthMm - 2 * marginMm + 4) / (labelWidthMm + 4));
    const rows = Math.floor((pageHeightMm - 2 * marginMm + 4) / (labelHeightMm + 4));
    assert.equal(pages.length, Math.ceil(2 / (columns * rows)));
    assert.equal(pages.reduce((sum, page) => sum + page.labels.length, 0), 2);
    assert.equal((pages.map(page => page.text).join(' ').match(/1\.599,01 €/g) || []).length, 2);
    assert.equal((pages.map(page => page.text).join(' ').match(/Art\. 000123/g) || []).length, 2);
    assert.equal((pages.map(page => page.text).join(' ').match(/EAN 4547410533644/g) || []).length, 2);
    for (const page of pages) {
      near(page.width, pageWidthMm * MM, 'Paper width'); near(page.height, pageHeightMm * MM, 'Paper height');
      for (const [slot, label] of page.labels.entries()) {
        near(label.width, labelWidthMm * MM, 'Unscaled label width'); near(label.height, labelHeightMm * MM, 'Unscaled label height');
        near(label.x, (marginMm + (slot % columns) * (labelWidthMm + 4)) * MM, 'Label column');
        near(label.y, page.height - (marginMm + Math.floor(slot / columns) * (labelHeightMm + 4) + labelHeightMm) * MM, 'Label row');
        assert.ok(contains({ x: 0, y: 0, width: page.width, height: page.height }, label), 'Label lies on selected paper');
      }
      for (const rect of page.textRects) assert.ok(page.labels.some(label => contains(label, rect)), `${format.id} ${orientation}: text exceeds its label: ${rect.str}`);
    }
  });
}

test('A4 labels need zero margin on A4 paper and never silently shrink to its printable area', async () => {
  for (const orientation of ['portrait', 'landscape']) {
    const [labelWidthMm, labelHeightMm] = dimensions(FORMATS[4], orientation);
    const options = { paper: 'A4', orientation, labelWidthMm, labelHeightMm, marginMm: 10 };
    assert.throws(() => normalizeOptions(options), { code: 'PRICE_LABEL_FIT' });
    await assert.rejects(createSalesPriceLabelsPdf({ items: [article], options }), { code: 'PRICE_LABEL_FIT' });
    const [page] = await inspect(await createSalesPriceLabelsPdf({ items: [article], options: { ...options, marginMm: 0 } }));
    assert.equal(page.labels.length, 1);
    near(page.labels[0].x, 0, 'A4 label x'); near(page.labels[0].y, 0, 'A4 label y');
    near(page.labels[0].width, page.width, 'Full A4 width'); near(page.labels[0].height, page.height, 'Full A4 height');
  }
});

test('A5 label orientation and paper orientation are independent canonical settings', async () => {
  for (const orientation of ['portrait', 'landscape']) {
    const [labelWidthMm, labelHeightMm] = dimensions(FORMATS[3], orientation);
    const options = { paper: 'A4', orientation, labelWidthMm, labelHeightMm, marginMm: 10 };
    const [page] = await inspect(await createSalesPriceLabelsPdf({ items: [article], options }));
    assert.equal(page.labels.length, 1); near(page.labels[0].width, labelWidthMm * MM, 'A5 width'); near(page.labels[0].height, labelHeightMm * MM, 'A5 height');
    const otherOrientation = orientation === 'portrait' ? 'landscape' : 'portrait';
    assert.throws(() => normalizeOptions({ ...options, orientation: otherOrientation }), { code: 'PRICE_LABEL_FIT' });
    await assert.rejects(createSalesPriceLabelsPdf({ items: [article], options: { ...options, orientation: otherOrientation } }), { code: 'PRICE_LABEL_FIT' });
    const [samePaper] = await inspect(await createSalesPriceLabelsPdf({ items: [article], options: { ...options, paper: 'A5', marginMm: 0 } }));
    near(samePaper.labels[0].width, samePaper.width, 'A5 on A5 width'); near(samePaper.labels[0].height, samePaper.height, 'A5 on A5 height');
  }
  for (const field of ['labelFormat', 'labelOrientation']) assert.throws(() => normalizeOptions({ [field]: 'a5' }), { code: 'PRICE_LABEL_OPTIONS' }, 'Presentation choices do not extend the API schema');
});

test('Large formats retain the chosen embedded font and free-logo millimeter box in both orientations', async () => {
  const Fonts = require('../public/sales-price-label-fonts'), fs = require('node:fs'), path = require('node:path');
  const fontkit = require('node:module').createRequire(require.resolve('pdfkit'))('fontkit'), font = Fonts.get('pt-serif');
  const expectedFonts = [font.regular, font.bold].map(asset => fontkit.create(fs.readFileSync(path.join(__dirname, '../public', asset.slice(1)))).postscriptName);
  for (const format of FORMATS.slice(3)) for (const orientation of ['portrait', 'landscape']) {
    const [labelWidthMm, labelHeightMm] = dimensions(format, orientation), marginMm = format.id === 'a4' ? 0 : 10;
    const options = { paper: 'A4', orientation, labelWidthMm, labelHeightMm, marginMm, fontId: font.id,
      logoMode: 'free', logoKitId: 'synthetic', logoAssetKey: 'logo', logoXmm: labelWidthMm - 20, logoYmm: labelHeightMm - 10, logoWidthMm: 20, logoHeightMm: 10 };
    const [page] = await inspect(await createSalesPriceLabelsPdf({ items: [article], options, logoBuffer: logoSvg }));
    assert.equal(page.images.length, 1); assert.equal(page.labels.length, 1); assert.ok(page.lastImage > page.lastText, 'Free logo remains an explicit overlay');
    for (const expected of expectedFonts) assert.ok(page.fontNames.some(name => name?.endsWith(expected)), `Chosen font missing: ${expected}`);
    assert.match(page.text, /Kamera ÄÖÜ ß/); assert.match(page.text, /1\.599,01 €/);
    const [label] = page.labels, [image] = page.images;
    near(image.x, label.x + options.logoXmm * MM, 'Free logo x');
    near(image.y, label.y + 2.5 * MM, 'Free logo y includes centered aspect fit');
    near(image.width, 20 * MM, 'Free logo width'); near(image.height, 5 * MM, 'Logo retains 4:1 ratio');
    assert.ok(contains(label, image), 'Free logo stays inside the full-size label');
    for (const rect of page.textRects) assert.ok(contains(label, rect), `Large-format text exceeds label: ${rect.str}`);
  }
});

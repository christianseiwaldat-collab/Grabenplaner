'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Design = require('../public/sales-price-label-design');
const Pdf = require('../lib/sales-price-labels-pdf');
const Fonts = require('../public/sales-price-label-fonts');
const assetId = '12345678-1234-4234-8234-abcdefabcdef';
const box = (changes = {}) => ({fontId:'pt-serif', fontSizePt:11, xMm:2, yMm:3, widthMm:40, heightMm:8, ...changes});
const item = {brand:'Marke', description:'Artikel', articleNumber:'123', ean:'456'};
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('Shared browser and PDF geometry separates all eight fields and preserves untouched legacy defaults', () => {
  const options = Pdf.normalizeOptions(), before = JSON.stringify(options), boxes = Design.create(options, item);
  assert.deepEqual(Object.keys(boxes), Design.fieldIds); assert.equal(Design.fieldIds.length, 8);
  assert.equal(boxes.headline.visible, false); assert.equal(boxes.brand.visible, true);
  near(boxes.brand.xMm, 4); near(boxes.brand.yMm, 4); near(boxes.brand.widthMm, 82); near(boxes.brand.heightMm, 6.76);
  near(boxes.description.yMm, 12.06); near(boxes.description.heightMm, 13);
  near(boxes.price.yMm, 27.14); near(boxes.price.heightMm, 14.3);
  near(boxes.tax.yMm, 42.22); near(boxes.articleNumber.yMm, 42.22 + 13.78 / 3); near(boxes.ean.yMm, 42.22 + 2 * 13.78 / 3);
  assert.equal(boxes.price.fontId, Fonts.defaultId); assert.equal(boxes.brand.fontSizePt, 13);
  assert.equal(JSON.stringify(options), before); assert.equal(boxes.price.override, false);
  const browser = {}; vm.createContext(browser);
  for (const file of ['sales-price-label-fonts.js', 'sales-price-label-design.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), browser);
  browser.input = JSON.stringify({options, item});
  assert.equal(vm.runInContext('JSON.stringify(GrabenplanerPriceLabelDesign.create(JSON.parse(input).options, JSON.parse(input).item))', browser), JSON.stringify(boxes));
});

test('Sparse full text descriptors validate allowed fonts, bounded points and within-label millimeters without mutating callers', () => {
  const value = {description:box(), price:box({fontId:'fira-mono', fontSizePt:24, yMm:14})}, before = structuredClone(value);
  const normalized = Design.normalizeTextBoxes(value, Pdf.normalizeOptions());
  assert.deepEqual(normalized, value); assert.deepEqual(value, before); assert.notEqual(normalized.price, value.price);
  assert.ok(Object.isFrozen(normalized.price)); assert.deepEqual(Pdf.normalizeOptions({textBoxes:value}).textBoxes, value);
  assert.deepEqual(Pdf.normalizeOptions(Pdf.normalizeOptions({textBoxes:value})).textBoxes, value);
  for (const invalid of [null, [], {unknown:box()}, {price:null}, {price:{...box(), extra:true}}, {price:{fontId:'roboto'}},
    {price:box({fontId:'Arial'})}, {price:box({fontId:'../../private'})}, {price:box({fontSizePt:4.99})}, {price:box({fontSizePt:120.01})},
    {price:box({fontSizePt:NaN})}, {price:box({xMm:-.01})}, {price:box({yMm:Infinity})}, {price:box({widthMm:0})},
    {price:box({xMm:51})}, {price:box({yMm:53})}, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => Design.normalizeTextBoxes(invalid, Pdf.normalizeOptions()));
    assert.throws(() => Pdf.normalizeOptions({textBoxes:invalid}), {code:'PRICE_LABEL_OPTIONS'});
  }
  assert.deepEqual(Design.normalizeTextBoxes(Object.create(null), Pdf.normalizeOptions()), {});
});

test('Per-field overrides retain every unrelated box and font, including independent headline and brand', () => {
  const options = Pdf.normalizeOptions({headline:'Angebot', textBoxes:{brand:box()}}), boxes = Design.create(options, item);
  assert.equal(boxes.headline.visible, true); assert.equal(boxes.brand.visible, true); assert.equal(boxes.brand.fontId, 'pt-serif');
  assert.equal(boxes.brand.fontSizePt, 11); assert.equal(boxes.description.fontId, 'roboto'); assert.equal(boxes.price.fontId, 'roboto');
  assert.equal(boxes.description.override, false); assert.equal(boxes.brand.override, true);
  const untouched = Design.create({...options, textBoxes:{}}, item);
  for (const id of Design.fieldIds.filter(id => id !== 'brand')) assert.deepEqual(boxes[id], untouched[id]);
  const photo = Design.create(options, {...item, imageUrl:'/synthetic'}, {hasPhoto:true});
  near(photo.description.widthMm, 82 - Math.min(82 * .28, 13 * 1.1) - 2);
  const photoBox = Design.getContentGeometry(options,{hasPhoto:true}).photoBox;
  near(photoBox.xMm,4+82-Math.min(82*.28,13*1.1)); near(photoBox.yMm,12.06); near(photoBox.heightMm,13);
});

test('Reserved logos and circular labels project the existing independent text defaults in millimeters', () => {
  const options = Pdf.normalizeOptions({logoKitId:'kit', logoAssetKey:'logo'}), boxes = Design.create(options, item);
  near(boxes.brand.yMm, 16); near(boxes.description.yMm, 22.2); near(boxes.price.yMm, 33.2); near(boxes.price.heightMm, 10);
  const bottom = Design.create({...options, logoPosition:'bottom-center'}, item);
  near(bottom.brand.yMm, 4); near(bottom.price.yMm, 21.2);
  const noLogo = Design.create(options, item, {hasLogo:false}); near(noLogo.price.yMm, 27.14);
  const circle = Design.create({...options, shape:'circle', logoKitId:'', logoAssetKey:''}, item);
  near(circle.brand.xMm, 26.784); near(circle.brand.yMm, 11.784); near(circle.brand.widthMm, 36.432);
  const promo = Design.getContentGeometry({...options, design:'promo', logoSpacingMm:0});
  assert.ok(promo.promoBand.yMm >= promo.logoBox.yMm + promo.logoBox.heightMm);
});

test('Gesture bounds never extend beyond decimal label edges or change preferred font values', () => {
  const geometry = {xMm:80, yMm:55, widthMm:20.555, heightMm:10.555}, before = {...geometry};
  const value = Design.boundedBox({labelWidthMm:90.555, labelHeightMm:60.555}, geometry);
  assert.ok(value.xMm + value.widthMm <= 90.555); assert.ok(value.yMm + value.heightMm <= 60.555); assert.deepEqual(geometry, before);
  assert.deepEqual(Design.boundedBox({labelWidthMm:10, labelHeightMm:10}, {xMm:-5,yMm:25,widthMm:20,heightMm:.1}), {xMm:0,yMm:9,widthMm:10,heightMm:1});
  assert.throws(() => Design.boundedBox({labelWidthMm:90,labelHeightMm:60}, {...geometry,xMm:NaN}));
});

test('Three raster overlays carry only normalized asset IDs and bounded geometry, never buffers, paths or URLs', () => {
  const image = {assetId, xMm:0, yMm:0, widthMm:90, heightMm:60}, value = [image,
    {...image,assetId:'22345678-1234-4234-8234-abcdefabcdef',xMm:10,widthMm:30},
    {...image,assetId:'32345678-1234-4234-8234-abcdefabcdef',yMm:30,heightMm:20}];
  const normalized = Pdf.normalizeOptions({imageBoxes:value}); assert.deepEqual(normalized.imageBoxes, value);
  assert.notEqual(normalized.imageBoxes[0], image); assert.ok(Object.isFrozen(normalized.imageBoxes[0]));
  for (const invalid of [null, {}, [...value,image], [{...image,assetId:'../../private'}], [{...image,assetId:'https://example.test/image.png'}],
    [{...image,url:'/image'}], [{...image,buffer:'base64'}], [{...image,widthMm:91}], [{...image,assetId:assetId.toUpperCase()}], [image,{...image,xMm:10,widthMm:30}]]) {
    assert.throws(() => Pdf.normalizeOptions({imageBoxes:invalid}), {code:'PRICE_LABEL_OPTIONS'});
  }
});

test('Shared wrapping fixes explicit point size and reports clipping instead of silently shrinking that choice', () => {
  const measure = (text, _fontId, size) => text.length * size * .5;
  const custom = {...box({widthMm:15,heightMm:10}), override:true, bold:false};
  const fitted = Design.layoutText('abc def ghi', custom, measure);
  assert.equal(fitted.fontSizePt, 11); assert.deepEqual(fitted.lines, ['abc def', 'ghi']); assert.equal(fitted.clipped, false);
  const clipped = Design.layoutText('abc def ghi jkl mno', {...custom,heightMm:5}, measure);
  assert.equal(clipped.fontSizePt, 11); assert.equal(clipped.lines.length, 1); assert.equal(clipped.clipped, true);
  const tiny = Design.layoutText('Preis', {...custom,heightMm:1}, measure); assert.equal(tiny.lines.length, 0); assert.equal(tiny.clipped, true);
  const automatic = Design.layoutText('abcdefghijkl', {...custom,override:false,minFontSizePt:5,truncate:false}, measure);
  assert.ok(automatic.fontSizePt <= 11); assert.equal(automatic.clipped, false);
});

test('Shared tax text preserves the PDF contract for trailing zeros and invalid rates', () => {
  for (const [input, expected] of [[20,'inkl. 20 % MwSt.'],['20.000','inkl. 20 % MwSt.'],['10.2500','inkl. 10,25 % MwSt.'],
    [0,'inkl. 0 % MwSt.'],['100.000000','inkl. 100 % MwSt.']]) assert.equal(Design.taxText(input),expected);
  for (const input of [undefined,null,-1,101,NaN,Infinity,'101','20,0','20.0000001',' 20','1e1']) assert.equal(Design.taxText(input),'MwSt. prüfen');
});

test('Protected named and personal default templates preserve independent sparse text geometry across reload and update', async t => {
  const {fixture} = require('../test-support/trade-insights-sqlite');
  const Store = require('../lib/sales-price-label-template-store'), persistence = await fixture(t);
  const context = await Store.resolveTemplateSessionContext({employeeNumber:'42',accountId:'user-42',sessionKind:'employee',
    isEmployee:true,fullName:'Synthetic Design',localSystem:true,mustChangePassword:false}, {listBranchAccounts:async () => []});
  const store = Store.createSalesPriceLabelTemplateStore({access:persistence.app.provider,vault:persistence.vault});
  const options = {footer:'Beratung',textBoxes:{price:box({fontId:'fira-mono',fontSizePt:18,yMm:20,heightMm:12}),footer:box({yMm:44})}};
  const input = {title:'Synthetic Design',options,filenameOptions:{},visibility:'private',recipients:[]};
  const saved = await store.create(context,input), loaded = await store.get(context,saved.id);
  assert.deepEqual(loaded.options.textBoxes,options.textBoxes);
  assert.deepEqual(Object.keys(loaded.options.textBoxes).sort(),['footer','price']);
  await store.setDefault(context,{options,filenameOptions:{}});
  const reloaded = Store.createSalesPriceLabelTemplateStore({access:persistence.app.provider,vault:persistence.vault});
  assert.deepEqual((await reloaded.getDefault(context)).options.textBoxes,options.textBoxes);
  const changed = {...options,textBoxes:{...options.textBoxes,price:{...options.textBoxes.price,xMm:12,fontSizePt:17.5}}};
  const updated = await reloaded.update(context,saved.id,{...input,version:1,options:changed});
  assert.equal(updated.version,2); assert.deepEqual((await store.get(context,saved.id)).options.textBoxes,changed.textBoxes);
  assert.deepEqual(options.textBoxes.price,box({fontId:'fira-mono',fontSizePt:18,yMm:20,heightMm:12}));
});

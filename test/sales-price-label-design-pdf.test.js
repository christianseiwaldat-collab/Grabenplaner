'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), sharp = require('sharp');
const Pdf = require('../lib/sales-price-labels-pdf'), Design = require('../public/sales-price-label-design');
const Fonts = require('../public/sales-price-label-fonts');
const item = {articleNumber:'000123',description:'Kamera ÄÖÜ ß',brand:'Marke',priceGross:'1599.005',taxRate:'20',ean:'4547410533644'};
const assetId = '12345678-1234-4234-8234-abcdefabcdef';
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < .02, `${message}: ${actual} != ${expected}`);
async function inspect(buffer) {
  const {getDocument, OPS} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({data:new Uint8Array(buffer), isEvalSupported:false}), pdf = await task.promise;
  try {
    const page = await pdf.getPage(1), content = await page.getTextContent(), operators = await page.getOperatorList();
    const texts = [];
    for (const entry of content.items.filter(entry => entry.str)) {
      const value = {text:entry.str,width:entry.width,height:entry.height,transform:entry.transform,
        font:page.commonObjs.get(entry.fontName)?.name?.replace(/^[A-Z]{6}\+/, '')};
      const prior = texts.at(-1);
      // PDF.js exposes mono-font spaces as separate runs. Rejoin only the
      // adjacent runs of the same physical line and family before comparing.
      if (prior && prior.font === value.font && Math.abs(prior.transform[5]-value.transform[5]) < .001
        && prior.transform[0] === value.transform[0] && value.transform[4] >= prior.transform[4]
        && value.transform[4] <= prior.transform[4]+prior.width+.1) {
        prior.text += value.text; prior.width = value.transform[4]+value.width-prior.transform[4];
      } else texts.push(value);
    }
    let matrix = [1,0,0,1,0,0]; const stack = [], images = [];
    for (let index = 0; index < operators.fnArray.length; index++) {
      const code = operators.fnArray[index], args = operators.argsArray[index];
      if (code === OPS.save) stack.push(matrix.slice());
      else if (code === OPS.restore) matrix = stack.pop() || [1,0,0,1,0,0];
      else if (code === OPS.transform) {
        const [a,b,c,d,e,f] = matrix, [g,h,j,k,l,m] = args;
        matrix = [a*g+c*h,b*g+d*h,a*j+c*k,b*j+d*k,a*l+c*m+e,b*l+d*m+f];
      } else if ([OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(code)) {
        const [a,b,c,d,e,f] = matrix, points = [[e,f],[a+e,b+f],[c+e,d+f],[a+c+e,b+d+f]], xs = points.map(p => p[0]), ys = points.map(p => p[1]);
        images.push({x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys),index});
      }
    }
    return {texts, images, width:page.view[2], height:page.view[3], lastText:operators.fnArray.lastIndexOf(OPS.showText),
      pageCount:pdf.numPages, allText:texts.map(entry => entry.text).join(' ')};
  } finally { await task.destroy(); }
}
const descriptor = (fontId, fontSizePt, yMm, heightMm = 5) => ({fontId,fontSizePt,xMm:5,yMm,widthMm:80,heightMm});

test('Every separate text field embeds its chosen family, exact point size and saved full-label position', async () => {
  const textBoxes = {
    headline:descriptor('lato',8,5), brand:descriptor('pt-serif',9,10), description:descriptor('fira-sans',10,15,6),
    price:descriptor('fira-mono',16,22,9), articleNumber:descriptor('ibm-plex-mono',8,33),
    ean:descriptor('spectral',8,39), tax:descriptor('barlow',8,45), footer:descriptor('crimson-text',8,51),
  };
  const options = {headline:'Angebot',footer:'Beratung vor Ort',textBoxes}, before = structuredClone(options);
  const page = await inspect(await Pdf.createSalesPriceLabelsPdf({items:[item],options}));
  assert.deepEqual(options, before); assert.equal(page.pageCount,1);
  const values = {headline:'Angebot',brand:'Marke',description:'Kamera ÄÖÜ ß',price:'1.599,01 €',articleNumber:'Art. 000123',ean:'EAN 4547410533644',tax:'inkl. 20 % MwSt.',footer:'Beratung vor Ort'};
  const fontkit = require('node:module').createRequire(require.resolve('pdfkit'))('fontkit');
  for (const [id, value] of Object.entries(values)) {
    const printed = page.texts.find(entry => entry.text === value); assert.ok(printed, id+' disappeared from the export');
    const box = textBoxes[id], effective = Design.create(Pdf.normalizeOptions(options), item)[id], family = Fonts.get(box.fontId);
    const expectedFont = fontkit.create(fs.readFileSync(path.join(__dirname,'../public',(effective.bold?family.bold:family.regular).slice(1)))).postscriptName;
    assert.equal(printed.font, expectedFont, id+' changed font'); near(printed.transform[0], box.fontSizePt, id+' point size');
    const x = (10+box.xMm)*Pdf.MM, top = (10+box.yMm)*Pdf.MM;
    assert.ok(printed.transform[4] >= x-.02 && printed.transform[4]+printed.width <= x+box.widthMm*Pdf.MM+.02, id+' exceeded its horizontal box');
    const baselineFromTop = page.height - printed.transform[5];
    assert.ok(baselineFromTop > top && baselineFromTop < top+box.heightMm*Pdf.MM, id+' did not use its saved Y position');
  }
});

test('An edited field leaves the legacy positions, font and strings of every other visible field unchanged', async () => {
  const before = await inspect(await Pdf.createSalesPriceLabelsPdf({items:[item]}));
  const after = await inspect(await Pdf.createSalesPriceLabelsPdf({items:[item],options:{textBoxes:{description:descriptor('pt-serif',10,14,7)}}}));
  for (const original of before.texts.filter(entry => entry.text !== item.description)) {
    assert.deepEqual(after.texts.find(entry => entry.text === original.text), original, original.text+' changed while editing only the article text');
  }
  const updated = after.texts.find(entry => entry.text === item.description);
  assert.notDeepEqual(updated.transform,before.texts.find(entry => entry.text === item.description).transform);
  assert.match(updated.font,/PTSerif/);
  const empty = await inspect(await Pdf.createSalesPriceLabelsPdf({items:[item],options:{textBoxes:{},imageBoxes:[]}}));
  assert.deepEqual(empty.texts, before.texts, 'Empty overrides preserve the legacy drawing exactly');
});

test('Three resolved PNG overlays preserve millimeter fit, appear after text and roundtrip without binary data in options', async () => {
  const buffer = await sharp({create:{width:80,height:40,channels:4,background:'#0080ff'}}).png().toBuffer();
  const imageBoxes = [0,1,2].map(index => ({assetId:`${index+1}2345678-1234-4234-8234-abcdefabcdef`,xMm:5+index*25,yMm:5+index*15,widthMm:20,heightMm:10}));
  const normalized = Pdf.normalizeOptions({imageBoxes}); assert.deepEqual(Pdf.normalizeOptions(JSON.parse(JSON.stringify(normalized))), normalized);
  const page = await inspect(await Pdf.createSalesPriceLabelsPdf({items:[item],options:normalized,imageBuffers:new Map(imageBoxes.map(box=>[box.assetId,buffer]))}));
  assert.equal(page.images.length,3); assert.match(page.allText,/1\.599,01 €/);
  for (let index = 0; index < 3; index++) {
    const box = imageBoxes[index], image = page.images[index];
    assert.ok(image.index > page.lastText); near(image.x,(10+box.xMm)*Pdf.MM,'image X');
    near(page.height-image.y-image.height,(10+box.yMm)*Pdf.MM,'image Y');
    near(image.width,box.widthMm*Pdf.MM,'image width'); near(image.height,box.heightMm*Pdf.MM,'image height');
  }
  assert.doesNotMatch(JSON.stringify(normalized),/base64|buffer|data:/i);
});

test('User raster overlays preserve reserved-first and free-last branding layers', async () => {
  const image = await sharp({create:{width:40,height:20,channels:3,background:'#0080ff'}}).png().toBuffer();
  const logoBuffer = await sharp({create:{width:40,height:20,channels:3,background:'#ff8000'}}).png().toBuffer();
  const imageBoxes = [{assetId,xMm:5,yMm:20,widthMm:20,heightMm:10}];
  for (const logoMode of ['reserved','free']) {
    const options = {logoKitId:'kit',logoAssetKey:'logo',logoMode,logoWidthMm:20,logoHeightMm:10,logoXmm:15,logoYmm:20,imageBoxes};
    const page = await inspect(await Pdf.createSalesPriceLabelsPdf({items:[item],options,logoBuffer,imageBuffers:new Map([[assetId,image]])}));
    assert.equal(page.images.length,2);
    if (logoMode === 'reserved') {
      assert.ok(page.images[0].index < page.lastText, 'Reserved branding must retain its legacy layer before text');
      assert.ok(page.images[1].index > page.lastText, 'User raster must be a separate overlay after text');
      near(page.images[1].x,15*Pdf.MM,'reserved overlay X');
    } else {
      assert.ok(page.images[0].index > page.lastText, 'User raster must be after text');
      near(page.images[0].x,15*Pdf.MM,'free overlay X');
      near(page.images[1].x,25*Pdf.MM,'free branding X');
      assert.ok(page.images[1].index > page.images[0].index, 'Free branding must remain the final overlay');
    }
  }
});

test('Missing, malformed, oversized or unresolved design images fail before a PDF is published', async () => {
  const imageBoxes = [{assetId,xMm:1,yMm:1,widthMm:20,heightMm:10}], options = {imageBoxes};
  for (const imageBuffers of [undefined, new Map(), {[assetId]:Buffer.from('x')}, new Map([[assetId,'/private/image.png']]),
    new Map([[assetId,Buffer.from('<svg/>')]]), new Map([[assetId,Buffer.alloc(10*1024*1024+1)]])]) {
    await assert.rejects(Pdf.createSalesPriceLabelsPdf({items:[item],options,imageBuffers}), {code:'PRICE_LABEL_IMAGE'});
  }
  const tooWide = await sharp({create:{width:1601,height:1,channels:3,background:'#0080ff'}}).png().toBuffer();
  await assert.rejects(Pdf.createSalesPriceLabelsPdf({items:[item],options,imageBuffers:new Map([[assetId,tooWide]])}), {code:'PRICE_LABEL_IMAGE'});
  const incomplete = Buffer.from('89504e470d0a1a0a','hex');
  await assert.rejects(Pdf.createSalesPriceLabelsPdf({items:[item],options,imageBuffers:new Map([[assetId,incomplete]])}), {code:'PRICE_LABEL_IMAGE'});
});

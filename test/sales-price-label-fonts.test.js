'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createRequire } = require('node:module');
const fontkit = createRequire(require.resolve('pdfkit'))('fontkit');
const Fonts = require('../public/sales-price-label-fonts');
const Editor = require('../public/sales-price-labels');
const Pdf = require('../lib/sales-price-labels-pdf');
const directory = path.join(__dirname, '../public/fonts/price-labels');

test('Twelve shared font families contain real static 400/700 fonts, pinned provenance, licences and German/Euro glyphs', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'assets.json'), 'utf8'));
  assert.equal(Fonts.families.length, 12); assert.equal(new Set(Fonts.families.map(font => font.id)).size, 12);
  assert.equal(manifest.families.length, 12);
  const identities = new Set();
  for (const family of Fonts.families) {
    const provenance = manifest.families.find(row => row.id === family.id);
    assert.ok(provenance); if (family.id !== 'roboto') assert.match(provenance.source.commit, /^[a-f0-9]{40}$/);
    const licence = fs.readFileSync(path.join(directory, provenance.license.file));
    assert.equal(crypto.createHash('sha256').update(licence).digest('hex'), provenance.license.sha256);
    for (const [weight, asset] of [[400, family.regular], [700, family.bold]]) {
      assert.match(asset, /^\/fonts\/price-labels\/[a-z-]+\/(Regular|Bold)\.ttf$/);
      const bytes = fs.readFileSync(path.join(__dirname, '../public', asset.slice(1)));
      const supplied = provenance.fonts.find(font => font.weight === weight);
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), supplied.sha256);
      const font = fontkit.create(bytes); identities.add(font.familyName);
      assert.equal(font.familyName, family.label); assert.equal(font['OS/2'].usWeightClass, weight);
      assert.equal(Object.keys(font.variationAxes).length, 0);
      for (const character of 'ÄÖÜäöüß€0123456789') assert.ok(font.hasGlyphForCodePoint(character.codePointAt(0)), family.label + ' lacks ' + character);
    }
  }
  assert.equal(identities.size, 12);
  assert.doesNotMatch(Fonts.css(), /https?:|local\(/);
});

test('Front/backend reject forged fonts and free geometry while legacy options default to reserved Roboto', () => {
  for (const normalize of [Editor.normalizeOptions, Pdf.normalizeOptions]) {
    assert.equal(normalize({}).fontId, 'roboto'); assert.equal(normalize({}).logoMode, 'reserved');
    for (const input of [null, [], {fontId:'Arial'}, {fontId:'../../private'}, {logoMode:'absolute'}, {logoXmm:-1},
      {logoYmm:NaN}, {logoMode:'free',logoXmm:71}, {logoMode:'free',logoYmm:51}, {logoLayer:9}]) assert.throws(() => normalize(input));
    const allowed = normalize({fontId:'spectral',logoMode:'free',logoXmm:69.5,logoYmm:49.5,logoWidthMm:20.5,logoHeightMm:10.5});
    assert.equal(allowed.logoXmm + allowed.logoWidthMm, 90); assert.equal(allowed.logoYmm + allowed.logoHeightMm, 60);
  }
  const bounded = Editor.boundedLogo({labelWidthMm:90.555,labelHeightMm:60.555}, {x:80,y:55,width:20.555,height:10.555});
  assert.ok(bounded.logoXmm + bounded.logoWidthMm <= 90.555); assert.ok(bounded.logoYmm + bounded.logoHeightMm <= 60.555);
});

test('Millimeter frame uses scaled BCR borders and inner dimensions, including GP 150% font zoom', () => {
  const frame = Editor.logoFrame({offsetWidth:454,clientWidth:450,offsetHeight:304,clientHeight:300,clientLeft:2,clientTop:2,
    getBoundingClientRect:()=>({left:10,top:20,width:681,height:456})});
  assert.deepEqual(frame,{left:13,top:23,width:675,height:450});
});

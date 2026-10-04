(function(host, factory) {
  'use strict'; const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host) host.GrabenplanerPriceLabelFonts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  // The browser and PDF renderer use these exact, local 400/700 font files.
  const families = Object.freeze([
    ['roboto', 'Roboto'], ['lato', 'Lato'], ['pt-sans', 'PT Sans'], ['fira-sans', 'Fira Sans'],
    ['barlow', 'Barlow'], ['alegreya-sans', 'Alegreya Sans'], ['pt-serif', 'PT Serif'],
    ['ibm-plex-serif', 'IBM Plex Serif'], ['spectral', 'Spectral'], ['crimson-text', 'Crimson Text'],
    ['fira-mono', 'Fira Mono'], ['ibm-plex-mono', 'IBM Plex Mono'],
  ].map(([id, label]) => Object.freeze({ id, label, cssFamily: 'GP Label ' + label,
    regular: '/fonts/price-labels/' + id + '/Regular.ttf', bold: '/fonts/price-labels/' + id + '/Bold.ttf' })));
  const get = id => families.find(family => family.id === id) || null;
  const css = () => families.map(font => [
    `@font-face{font-family:"${font.cssFamily}";font-style:normal;font-weight:400;font-display:swap;src:url("${font.regular}") format("truetype");}`,
    `@font-face{font-family:"${font.cssFamily}";font-style:normal;font-weight:700;font-display:swap;src:url("${font.bold}") format("truetype");}`,
  ].join('\n')).join('\n');
  return Object.freeze({ families, get, css, defaultId: 'roboto' });
});

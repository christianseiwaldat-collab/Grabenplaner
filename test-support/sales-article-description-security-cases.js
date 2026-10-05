'use strict';
// Shared synthetic sanitizer cases and structural assertions. This module does
// not register tests or load the product sanitizer; browser tests may reuse it.
const assert = require('node:assert/strict');
const { parseDocument } = require('htmlparser2');

const LIMITS = Object.freeze({ inputBytes: 32768, outputBytes: 65536, textBytes: 32768, nodes: 2000, depth: 32 });
const ALLOWED = new Set('p br div ul ol li strong b em i u s h3 h4 blockquote pre code table thead tbody tfoot tr th td'.split(' '));
const VOID_DROPS = ['input', 'img', 'source', 'link', 'meta', 'base', 'embed', 'area', 'param', 'track', 'wbr'];
const SUBTREE_DROPS = ['script', 'style', 'iframe', 'svg', 'math', 'object', 'form', 'button', 'select', 'textarea',
  'picture', 'video', 'audio', 'template', 'noscript', 'xmp', 'plaintext', 'title', 'head', 'applet', 'frameset'];
const semantic = value => value.replace(/\u00a0/g, ' ').replace(/\s+/gu, ' ').trim();

const vectors = [
  { name: 'empty', raw: '', expectText: '', hasMarkup: false, truncated: false },
  { name: 'plain-business-text', raw: 'Kamera 35 mm – groß & leicht', expectText: 'Kamera 35 mm – groß & leicht', hasMarkup: false, truncated: false },
  { name: 'literal-angle-brackets', raw: 'Preis < 10 & Bestand > 2', expectText: 'Preis < 10 & Bestand > 2', truncated: false },
  { name: 'allowed-paragraph-formatting', raw: '<p>Kamera <strong>robust</strong> <em>leicht</em></p>', expectText: 'Kamera robust leicht', requiredTags: ['p', 'strong', 'em'], hasMarkup: true, truncated: false },
  { name: 'allowed-table', raw: '<table><thead><tr><th>Breite</th></tr></thead><tbody><tr><td>12 mm</td></tr></tbody></table>', textContains: ['Breite', '12 mm'], requiredTags: ['table', 'thead', 'tbody', 'tr', 'th', 'td'], truncated: false },
  { name: 'allowed-lists-headings-code', raw: '<h3>Technik</h3><h4>Maße</h4><ul><li><b>fest</b></li></ul><ol><li><i>leicht</i></li></ol><blockquote><u>Hinweis</u><s>alt</s></blockquote><pre><code>&lt;b&gt;Code&lt;/b&gt;</code></pre>', textContains: ['Technik', 'Maße', 'fest', 'leicht', 'Hinweis', 'alt', '<b>Code</b>'], requiredTags: ['h3', 'h4', 'ul', 'li', 'ol', 'blockquote', 'u', 's', 'pre', 'code'] },
  { name: 'attributes-on-safe-elements-removed', raw: '<p id="x" class="x" style="background:url(https://assets.invalid/x)" onclick="bad()" contenteditable="true" data-x="x" aria-label="x" dir="rtl">SAFE</p>', expectText: 'SAFE', requiredTags: ['p'] },
  { name: 'mixed-case-event-attributes', raw: '<P OnMoUsEoVeR="bad()" STYLE="color:red"><STRONG>SAFE</STRONG></P>', expectText: 'SAFE', requiredTags: ['p', 'strong'] },
  { name: 'unknown-benign-container-unwrapped', raw: '<section><custom-element>SAFE</custom-element></section>', expectText: 'SAFE' },
  { name: 'comments-and-doctype', raw: '<!DOCTYPE html><!-- DROP_MARKER --><p>SAFE</p>', expectText: 'SAFE', textAbsent: ['DROP_MARKER'] },
  { name: 'processing-instruction', raw: '<?xml version="1.0"?><p>SAFE</p>', expectText: 'SAFE' },
  { name: 'encoded-markup-stays-text', raw: '&lt;img src=x onerror=bad()&gt;', expectText: '<img src=x onerror=bad()>', forbiddenTags: ['img'] },
  { name: 'double-encoding-not-decoded-twice', raw: '&amp;lt;script&amp;gt;ALPHA&amp;lt;/script&amp;gt;', expectText: '&lt;script&gt;ALPHA&lt;/script&gt;', forbiddenTags: ['script'] },
  { name: 'numeric-and-named-entities', raw: '&#60;b&#62;A&#38;B&#60;/b&#62; &copy; &#x1F600;', expectText: '<b>A&B</b> © 😀', forbiddenTags: ['b'] },
  { name: 'unknown-entity-remains-text', raw: 'A &zzUnregisteredEntity; B', expectText: 'A &zzUnregisteredEntity; B' },
  { name: 'legacy-entity-prefix-decoded-once', raw: '&notARealEntity;', expectText: '\u00acARealEntity;' },
  { name: 'numeric-invalid-codepoints', raw: '&#0;&#xD800;&#x110000;', expectText: '\uFFFD\uFFFD\uFFFD' },
  { name: 'script-rawtext-not-safe-descendants', raw: '<script><p>DROP_MARKER</p></script><p>SAFE</p>', expectText: 'SAFE', textAbsent: ['DROP_MARKER'] },
  { name: 'script-self-closing-html-mode', raw: '<script/>DROP_MARKER</script><p>SAFE</p>', expectText: 'SAFE', textAbsent: ['DROP_MARKER'] },
  { name: 'unclosed-script-fails-closed', raw: '<p>SAFE</p><script>DROP_MARKER', expectText: 'SAFE', textAbsent: ['DROP_MARKER'] },
  { name: 'nested-form-input-drop-state', raw: '<form>DROP_MARKER<input><p>DROP_MARKER</p></form><p>SAFE</p>', expectText: 'SAFE', textAbsent: ['DROP_MARKER'] },
  { name: 'nested-dangerous-subtrees', raw: '<svg><foreignObject><div>DROP_MARKER<script>DROP_MARKER</script></div></foreignObject></svg><p>SAFE</p>', expectText: 'SAFE', textAbsent: ['DROP_MARKER'] },
  { name: 'math-annotation-html', raw: '<math><annotation-xml encoding="text/html"><p>DROP_MARKER<img src=x onerror=bad()></p></annotation-xml></math><p>SAFE</p>', expectText: 'SAFE', textAbsent: ['DROP_MARKER'] },
  { name: 'html-mutation-foreign-table', raw: '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=bad()>"></table></mtext></math><p>SAFE</p>', textContains: ['SAFE'] },
  { name: 'html-mutation-svg-style', raw: '<svg><p><style><img src=x onerror=bad()></style></p></svg><p>SAFE</p>', textContains: ['SAFE'] },
  { name: 'malformed-comment-breakout', raw: '<!--><img src=x onerror=bad()><p>SAFE</p>', textContains: ['SAFE'] },
  { name: 'bogus-declaration', raw: '<!x><p>SAFE</p>', expectText: 'SAFE' },
  { name: 'mismatched-allowed-tags', raw: '<p><strong>SAFE</p></strong>', expectText: 'SAFE' },
  { name: 'implicit-list-closing', raw: '<ul><li>ONE<li>TWO</ul>', textContains: ['ONE', 'TWO'], requiredTags: ['ul', 'li'] },
  { name: 'malformed-table-safe-output', raw: '<table><td>ONE<td>TWO</table><p>SAFE', textContains: ['ONE', 'TWO', 'SAFE'] },
  { name: 'attribute-quote-breakout', raw: '<p title="x\"><img src=x onerror=bad()><p>SAFE</p>', textContains: ['SAFE'] },
  { name: 'safe-tag-self-close-html-mode', raw: '<div/>SAFE', expectText: 'SAFE' },
  { name: 'textarea-rcdata-not-description', raw: '<textarea>&lt;p&gt;DROP_MARKER&lt;/p&gt;</textarea><p>SAFE</p>', expectText: 'SAFE', textAbsent: ['DROP_MARKER'] },
  { name: 'entity-inline-events-are-not-reparsed', raw: '<p>&lt;svg/onload=bad()&gt;</p>', expectText: '<svg/onload=bad()>' },
];

for (const tag of VOID_DROPS) vectors.push({ name: 'void-drop-' + tag,
  raw: `<${tag} src="https://assets.invalid/secret" href="https://assets.invalid/secret" onload="bad()"><p>SAFE</p>`, expectText: 'SAFE' });
for (const tag of SUBTREE_DROPS) {
  // plaintext consumes its remaining input in HTML mode, even a closing tag.
  if (tag === 'plaintext') vectors.push({ name: 'subtree-drop-plaintext', raw: '<p>SAFE</p><plaintext>DROP_MARKER</plaintext><p>DROP_MARKER</p>', expectText: 'SAFE', textAbsent: ['DROP_MARKER'] });
  else vectors.push({ name: 'subtree-drop-' + tag, raw: `<${tag}>DROP_MARKER</${tag}><p>SAFE</p>`, expectText: 'SAFE', textAbsent: ['DROP_MARKER'] });
}

for (const href of ['javascript:bad()', 'JaVaScRiPt:bad()', 'java&#x09;script:bad()', 'java&#10;script:bad()',
  '&#106;avascript:bad()', '&Tab;javascript:bad()', '&NewLine;javascript:bad()', 'data:text/html,ALPHA',
  'vbscript:bad()', 'file:///tmp/x', 'blob:https://example.invalid/x', 'mailto:mail@example.invalid',
  'ftp://example.invalid/x', '//example.invalid/x', '/relative', '#fragment', '%6aavascript:bad()']) {
  vectors.push({ name: 'url-reject-' + vectors.length, raw: `<a href="${href}" target="_blank" rel="opener">SAFE</a>`, expectText: 'SAFE', noLinks: true });
}
vectors.push(
  { name: 'url-https-query-entities', raw: '<a href="https://example.invalid/info?a=1&amp;b=2" onclick="bad()" ping="https://assets.invalid/x" download referrerpolicy="unsafe-url">SAFE</a>', expectText: 'SAFE', safeHref: 'https://example.invalid/info?a=1&b=2' },
  { name: 'url-http-allowed', raw: '<a href="http://example.invalid/info" target="_self" rel="opener">SAFE</a>', expectText: 'SAFE', safeHref: 'http://example.invalid/info' },
  { name: 'url-duplicate-unsafe-first', raw: '<a href="javascript:bad()" href="https://example.invalid/">SAFE</a>', expectText: 'SAFE', noLinks: true },
  { name: 'url-encoded-attribute-breakout', raw: '<a href="https://example.invalid/&quot; onclick=&quot;bad()">SAFE</a>', expectText: 'SAFE' },
);

const limitVectors = [
  { name: 'input-ascii-exact', raw: 'A'.repeat(32768), expectText: 'A'.repeat(32768), truncated: false },
  { name: 'input-ascii-overflow', raw: 'A'.repeat(32768) + 'Z', expectText: 'A'.repeat(32768), truncated: true },
  { name: 'input-euro-exact', raw: 'A'.repeat(32765) + '€', expectText: 'A'.repeat(32765) + '€', truncated: false, noReplacement: true },
  { name: 'input-euro-overflow', raw: 'A'.repeat(32766) + '€', expectText: 'A'.repeat(32766), truncated: true, noReplacement: true },
  { name: 'input-astral-exact', raw: 'A'.repeat(32764) + '😀', expectText: 'A'.repeat(32764) + '😀', truncated: false, noReplacement: true },
  { name: 'input-astral-overflow', raw: 'A'.repeat(32765) + '😀', expectText: 'A'.repeat(32765), truncated: true, noReplacement: true },
  { name: 'input-cut-inside-close-tag', raw: '<p>' + 'A'.repeat(32763) + '</p>', truncated: true },
  { name: 'input-cut-inside-entity', raw: 'A'.repeat(32766) + '&lt;script&gt;bad()', truncated: true },
  { name: 'output-escape-amplification', raw: '&'.repeat(32768), truncated: true, textAlphabet: '&' },
  { name: 'output-reserves-closing-tags', raw: '<div><strong>' + '&'.repeat(32000) + '</strong></div>', truncated: true, requiredTags: ['div', 'strong'] },
  { name: 'many-entity-events-one-text-node', raw: '&amp;'.repeat(6000), expectText: '&'.repeat(6000), truncated: false },
  { name: 'node-budget-overflow', raw: '<br>'.repeat(2001), truncated: true },
  { name: 'node-budget-counts-text', raw: '<p>x</p>'.repeat(1001), truncated: true },
  { name: 'depth-exact', raw: '<div>'.repeat(32) + 'SAFE' + '</div>'.repeat(32), expectText: 'SAFE', truncated: false },
  { name: 'depth-overflow', raw: '<div>'.repeat(33) + 'SAFE' + '</div>'.repeat(33), truncated: true },
  { name: 'unknown-wrapper-depth-overflow', raw: '<x>'.repeat(100) + '<p>SAFE</p>' + '</x>'.repeat(100), truncated: true },
  { name: 'unclosed-deep-input', raw: '<div>'.repeat(5000), truncated: true },
  { name: 'huge-single-attribute-bounded-input', raw: '<p title="' + 'A'.repeat(100000) + '">SAFE</p>', truncated: true },
];

function inspectHtml(html, { allowLinks = false } = {}) {
  assert.equal(typeof html, 'string');
  assert.ok(Buffer.byteLength(html, 'utf8') <= LIMITS.outputBytes, 'HTML exceeds byte budget');
  assert.equal(Buffer.from(html, 'utf8').toString('utf8'), html, 'HTML contains an unpaired surrogate');
  const document = parseDocument(html, { xmlMode: false, decodeEntities: true });
  const tags = [], links = []; let nodes = 0;
  const pending = document.children.map(node => ({ node, depth: 0 }));
  while (pending.length) {
    const { node, depth } = pending.pop();
    assert.ok(++nodes <= LIMITS.nodes, 'output exceeds node budget');
    if (node.type === 'text') continue;
    assert.equal(node.type, 'tag', 'output contains a comment, directive, or active node');
    const name = node.name.toLowerCase();
    assert.ok(ALLOWED.has(name) || allowLinks && name === 'a', 'unexpected element: ' + name);
    assert.ok(depth + 1 <= LIMITS.depth, 'output exceeds element depth');
    tags.push(name);
    if (name === 'a') {
      const expectedAttributes = ['href', 'rel', 'target'];
      if (Object.hasOwn(node.attribs, 'referrerpolicy')) {
        assert.equal(node.attribs.referrerpolicy, 'no-referrer'); expectedAttributes.push('referrerpolicy');
      }
      assert.deepEqual(Object.keys(node.attribs).sort(), expectedAttributes.sort());
      const { href, rel, target } = node.attribs;
      assert.match(href, /^https?:\/\//i, 'href must be explicitly absolute HTTP(S)');
      assert.ok(!/[\u0000-\u0020\u007f]/u.test(href), 'href contains literal controls/space');
      assert.ok(['http:', 'https:'].includes(new URL(href).protocol));
      assert.equal(target, '_blank');
      assert.deepEqual(rel.toLowerCase().split(/\s+/u).sort(), ['noopener', 'noreferrer']);
      links.push(href);
    } else assert.deepEqual(Object.keys(node.attribs), [], 'attributes retained on ' + name);
    for (const child of node.children || []) pending.push({ node: child, depth: depth + 1 });
  }
  return { tags, links, nodes };
}

function assertResult(vector, result, options = {}) {
  assert.ok(result && typeof result === 'object');
  assert.deepEqual(Object.keys(result).sort(), ['hasMarkup', 'html', 'text', 'truncated']);
  assert.equal(typeof result.text, 'string');
  assert.equal(typeof result.hasMarkup, 'boolean');
  assert.equal(typeof result.truncated, 'boolean');
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= LIMITS.textBytes, 'text exceeds byte budget');
  assert.equal(Buffer.from(result.text, 'utf8').toString('utf8'), result.text, 'text contains an unpaired surrogate');
  const inspected = inspectHtml(result.html, options);
  if (Object.hasOwn(vector, 'expectText')) assert.equal(semantic(result.text), semantic(vector.expectText));
  for (const value of vector.textContains || []) assert.ok(result.text.includes(value), 'missing displayed text: ' + value);
  for (const value of vector.textAbsent || []) { assert.ok(!result.text.includes(value)); assert.ok(!result.html.includes(value)); }
  for (const name of vector.requiredTags || []) assert.ok(inspected.tags.includes(name), 'missing allowed structure: ' + name);
  for (const name of vector.forbiddenTags || []) assert.ok(!inspected.tags.includes(name), 'encoded text was reparsed as markup');
  if (Object.hasOwn(vector, 'hasMarkup')) assert.equal(result.hasMarkup, vector.hasMarkup);
  if (Object.hasOwn(vector, 'truncated')) assert.equal(result.truncated, vector.truncated);
  if (vector.noReplacement) assert.ok(!result.text.includes('\uFFFD'), 'valid code point was split at UTF-8 limit');
  if (vector.textAlphabet) assert.ok([...result.text].every(character => vector.textAlphabet.includes(character)));
  if (vector.noLinks || !options.allowLinks) assert.deepEqual(inspected.links, []);
  if (vector.safeHref && options.allowLinks) assert.deepEqual(inspected.links, [vector.safeHref]);
  return inspected;
}


function* grammarVectors(count = 3000) {
  assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 10000);
  let state = 20261005;
  const next = () => state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  const tokens = ['<p>', '</p>', '<div>', '</div>', '<strong>', '</strong>', '<table>', '<tr>', '<td>', '</td>', '</table>',
    '<svg>', '</svg>', '<math>', '</math>', '<style>', '</style>', '<script>', '</script>', '<!--', '-->', '&lt;', '&amp;',
    '<img src=x onerror=bad()>', '<a href=javascript:bad()>', '</a>', '<a href=https://example.invalid/>',
    '<noscript>', '</noscript>', '<textarea>', '</textarea>', '<template>', '</template>', 'SAFE', '"', "'", '<', '>', '/', '='];
  for (let index = 0; index < count; index++) {
    let raw = '';
    for (let token = 0, length = 1 + next() % 80; token < length; token++) raw += tokens[next() % tokens.length];
    yield { name: 'synthetic-grammar-' + index, raw };
  }
}

module.exports = { vectors, limitVectors, grammarVectors, inspectHtml, assertResult, LIMITS };

'use strict';
// Security regressions for the fixed article-description projection. All inputs
// are synthetic. A second parse checks structural safety; browser HTML5 reparse
// coverage belongs to the independent browser integration qualification.
const { sanitizeArticleDescription } = require('../lib/sales-article-description');
const assert = require('node:assert/strict');
const test = require('node:test');
const { vectors, limitVectors, grammarVectors, assertResult } = require('../test-support/sales-article-description-security-cases');

for (const vector of [...vectors, ...limitVectors]) {
  test('article description safety: ' + vector.name, () => {
    assertResult(vector, sanitizeArticleDescription(vector.raw), { allowLinks: true });
  });
}

test('article description safety: 3000 reproducible malformed combinations preserve the output contract', () => {
  for (const vector of grammarVectors()) {
    assertResult(vector, sanitizeArticleDescription(vector.raw), { allowLinks: true });
  }
});

test('article description keeps preformatted text and plain source line breaks', () => {
  const preformatted = '  first\n    second\n';
  const pre = sanitizeArticleDescription('<pre>' + preformatted + '</pre>');
  assert.equal(pre.text, preformatted);
  assert.equal(pre.html, '<pre>' + preformatted + '</pre>');
  const plain = 'First line\n  second line\nThird line';
  assert.equal(sanitizeArticleDescription(plain).text, plain);
});

test('article description normalizes lone surrogates without breaking valid astral characters', () => {
  const raw = 'A\ud800B\udc00C😀D';
  const result = sanitizeArticleDescription(raw);
  assert.equal(result.html, 'A\uFFFDB\uFFFDC😀D');
  assert.equal(result.text, 'A\uFFFDB\uFFFDC😀D');
  assert.equal(result.truncated, false);
});

test('dropped active content never reappears as an empty-result plaintext fallback', () => {
  for (const raw of ['<script>bad()</script>', '<style>body{background:url(https://assets.invalid/x)}</style>',
    '<iframe srcdoc="<script>bad()</script>">DROP_MARKER</iframe>', '<svg onload="bad()">DROP_MARKER</svg>']) {
    const result = sanitizeArticleDescription(raw);
    assert.equal(result.html, '');
    assert.equal(result.text, '');
    assert.equal(result.truncated, false);
  }
});

test('description input must be a string and is never coerced through attacker methods', () => {
  const poison = { toString() { assert.fail('object coercion must not run'); } };
  for (const raw of [null, undefined, 42, {}, [], poison, Symbol('synthetic')]) {
    assert.throws(() => sanitizeArticleDescription(raw), TypeError);
  }
});

test('description links reject credentials and oversized URLs while preserving only fixed attributes', () => {
  for (const href of ['https://user:password@example.invalid/x', 'http://user@example.invalid/x',
    'https://example.invalid/' + 'x'.repeat(2048)]) {
    assertResult({ raw: '', expectText: 'SAFE', noLinks: true }, sanitizeArticleDescription('<a href="' + href + '">SAFE</a>'), { allowLinks: true });
  }
});

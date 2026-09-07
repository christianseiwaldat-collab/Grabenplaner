'use strict';

// Shared by the article, customer and cash searches. No regex from user input.
const MAX_TERMS = 10;
const FOLDS = Object.freeze({ ä: 'a', ö: 'o', ü: 'u', ß: 'ss', á: 'a', à: 'a', â: 'a', é: 'e', è: 'e', ê: 'e', í: 'i', ì: 'i', î: 'i', ó: 'o', ò: 'o', ô: 'o', ú: 'u', ù: 'u', û: 'u', ç: 'c', ñ: 'n' });
const SEPARATORS = ' -./\\,:;()[]{}+="\'\t\r\n–—';
function fold(value) {
  return String(value ?? '').toLocaleLowerCase('de-AT').replace(/[äöüßáàâéèêíìîóòôúùûçñ]/g, c => FOLDS[c]);
}
function text(value) {
  return [...fold(value)].filter(c => !SEPARATORS.includes(c)).join('');
}
function terms(value) {
  const decoded = String(value ?? '').replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (raw, n) => {
    const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
  });
  const parts = fold(decoded).split(/[\s\-./\\,:;()[\]{}+="'–—]+/u).map(t => t.replace(/\*+/g, '*')).filter(t => /[^*?]/u.test(t));
  if (parts.length > MAX_TERMS) throw new RangeError('Bitte höchstens zehn Suchbegriffe verwenden.');
  return [...new Set(parts)];
}
function like(term) { return '%' + term.replace(/[!%_]/g, c => '!' + c).replace(/\*/g, '%').replace(/\?/g, '_') + '%'; }
function parameters(value) {
  const list = terms(value);
  return Object.fromEntries(Array.from({ length: MAX_TERMS }, (_, i) => ['query' + i, list[i] ? like(list[i]) : '%']));
}
// Linear glob matching with a remembered star; bounded input, no backtracking regex.
function glob(haystack, pattern) {
  let h = 0, p = 0, star = -1, retry = 0;
  while (h < haystack.length) {
    if (pattern[p] === '?' || pattern[p] === haystack[h]) { h++; p++; }
    else if (pattern[p] === '*') { star = p++; retry = h; }
    else if (star >= 0) { p = star + 1; h = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
function matches(values, query) {
  const haystack = (Array.isArray(values) ? values : [values]).map(text).join(' ');
  return terms(query).every(term => glob(haystack, '*' + term + '*'));
}
// SQL is composed only from application-owned column expressions and constants.
function sqlText(expression) {
  let sql = `gp_unicode_casefold(COALESCE(${expression}, ''))`;
  for (const [from, to] of [...Object.entries(FOLDS), ...[...SEPARATORS].map(c => [c, ''])]) {
    sql = `REPLACE(${sql}, '${from.replaceAll("'", "''")}', '${to}')`;
  }
  return sql;
}
function sqlPredicate(expressions) {
  const haystack = expressions.map(sqlText).join(" || ' ' || ");
  return Array.from({ length: MAX_TERMS }, (_, i) => `($query${i} = '%' OR LOWER(${haystack}) LIKE LOWER($query${i}) ESCAPE '!')`).join('\n AND ');
}
module.exports = { MAX_TERMS, text, terms, parameters, matches, sqlPredicate };

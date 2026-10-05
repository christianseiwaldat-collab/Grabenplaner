'use strict';
const W = require('../../statements/sales-article-workspace');
const { SALES_ARTICLE_CATALOG_STATEMENTS: A } = require('../../statements/sales-article-catalog');
const { searchBase, CATALOG: source } = require('../../sqlite/sales-article-workspace-catalog');
const { compileSalesEntry } = require('../sales/catalog');
const { relation } = require('../sales/layout');
const readerSources = [
  ...require('../../sqlite/import-master-catalog').SQLITE_IMPORT_MASTER_CATALOG,
  ...require('../../sqlite/import-history-catalog').SQLITE_IMPORT_HISTORY_CATALOG,
];
function candidateSearch(base) {
  const sql = searchBase(base);
  const firstTerm = "($query0 = '%' OR (LOWER(article.search_text) LIKE LOWER($query0) ESCAPE '!' OR EXISTS (SELECT 1 FROM sales_article_identifiers aliases WHERE aliases.product_id=article.product_id AND aliases.source_snapshot_id=article.source_snapshot_id AND aliases.identifier_value LIKE $query0 ESCAPE '!')))";
  if (sql.split(firstTerm).length !== 2) throw new Error('Article search candidate predicate requires review');
  // Resolve the first term independently so PostgreSQL can use the existing
  // text GIN index. An OR with a correlated alias lookup instead scans articles
  // in display order, even for very selective terms. The remaining terms and
  // filters still apply to each candidate, with the original matching rules.
  // UNION removes duplicate products; aliases match the current snapshot only.
  return sql.replace(firstTerm, `article.product_id IN (
    SELECT article.product_id FROM sales_article_search_projection article
    WHERE $query0 = '%' OR LOWER(article.search_text) LIKE LOWER($query0) ESCAPE '!'
    UNION
    SELECT aliases.product_id FROM sales_article_identifiers aliases
    JOIN sales_article_search_projection current_article
      ON current_article.product_id=aliases.product_id
      AND current_article.source_snapshot_id=aliases.source_snapshot_id
    WHERE $query0 <> '%' AND aliases.identifier_value LIKE $query0 ESCAPE '!'
  )`);
}
function numericIdentifiers(sql) {
  // The catalog's CHECK constraints restrict both identifier columns to digits.
  // ASCII case folding therefore changes neither value; removing it saves work
  // on every alias row. Keep parameter folding and LIKE escape rules unchanged.
  return sql.replaceAll('gp . ascii_fold ( ( aliases . identifier_value ) :: text )', 'aliases.identifier_value')
    .replaceAll('gp . ascii_fold ( ( gp . lower ( searched_identifier . identifier_value ) ) :: text )', 'searched_identifier.identifier_value')
    .replaceAll('gp . ascii_fold ( ( gp . lower ( searched_identifier . canonical_gtin14 ) ) :: text )', 'searched_identifier.canonical_gtin14');
}
const CATALOG = [[W.search,A.search,true],[W.count,A.countSearch,true],
  [W.searchWithoutText,A.search,false],[W.countWithoutText,A.countSearch,false]].map(([statement,base,candidates]) => {
  const compiled = compileSalesEntry({statement:base,sql:candidates ? candidateSearch(base) : searchBase(base),returning:false},8).providerEntry;
  const parameter = '$' + (compiled.parameterBindings.length + 1);
  const filter = '(' + parameter + '::jsonb IS NULL OR article.product_id IN (SELECT a.product_id FROM '
    + relation('sales_articles') + " a WHERE a.source_system='tradefoto.artikel_stamm' AND a.source_article_key IN (SELECT value FROM jsonb_array_elements_text("
    + parameter + '::jsonb))))';
  return {...compiled,statement,sql:numericIdentifiers(compiled.sql).replace(/\bWHERE\b/i,'WHERE ' + filter + ' AND'),
    parameterOrder:[...compiled.parameterOrder,'orderKeys'],
    parameterBindings:[...compiled.parameterBindings,{parameter:'orderKeys',source:'value',path:[]}]};
});
CATALOG.push(compileSalesEntry(source.find(e => e.statement === W.revisions),8).providerEntry);
CATALOG.push(compileSalesEntry(source.find(e => e.statement === W.notes),8).providerEntry);
CATALOG.push(compileSalesEntry(source.find(e => e.statement === W.articleStock),8).providerEntry);
for (const entry of W.readerBatches) CATALOG.push(require('../import-reader-batches').importReaderBatch(entry,
  compileSalesEntry(readerSources.find(candidate => candidate.statement === entry.source),8).providerEntry));
CATALOG.push({statement:W.segments,returning:false,parameterOrder:['scopeId','ids'],
  sql:'SELECT r.id,r.revision,r.source_table AS "sourceTable",r.source_instance AS "sourceInstance",r.identity_hash AS "identityHash",r.profile_hash AS "profileHash",s.kind,s.data_class AS "dataClass",s.payload,p.payload AS "provenancePayload" FROM '
    + relation('import_master_records') + ' r JOIN ' + relation('import_master_segments')
    + " s ON s.record_id=r.id LEFT JOIN " + relation('import_master_segments') + " p ON p.record_id=r.id AND p.kind='provenance' AND p.data_class='internal_business' WHERE r.scope_id=$1 AND r.source_instance='tradefoto-trade' AND r.id IN (SELECT value FROM jsonb_array_elements_text($2::jsonb)) AND ((r.source_table='ARTIKEL_STAMM' AND s.kind='attributes' AND s.data_class='internal_business') OR (r.source_table='ARTIKEL_ZWEITLIEFERANT' AND s.kind='costs' AND s.data_class='catalog_costs'))"});
module.exports = { CATALOG };

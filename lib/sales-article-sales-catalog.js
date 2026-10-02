'use strict';
const { searchArticle,articleSourceLinks } = require('./sales-article-sales-statements');
const { CASH_SNAPSHOT_TABLES } = require('./persistence/statements/cash-snapshots');
const lines = CASH_SNAPSHOT_TABLES.find(t => t.name === 'Umsatz_Kasse_Details');
// The existing article/date index narrows the scan before any encrypted source
// position is read. Zero/missing source branches remain candidates only; the
// backend authenticates them separately before returning a visible row.
const CATALOG = Object.freeze([{ statement: searchArticle, returning: false, sql: `SELECT r.source_row AS sourceRow,r.business_date AS businessDate,r.parent_row AS parentRow,r.location_key AS locationKey
  FROM ${lines.sqlName} r WHERE r.dataset_slot=$datasetSlot AND r.article_key=$articleKey
  AND r.business_date >= $dateFrom AND r.business_date <= $dateTo
  AND (($unassigned=0 AND r.location_key IN (SELECT source_key FROM cash_publication_bindings
    WHERE publication_id=$publicationId AND kind='FILIALEN' AND target_id=$locationId))
    OR ($unassigned=1 AND NOT EXISTS(SELECT 1 FROM cash_publication_bindings b
      WHERE b.publication_id=$publicationId AND b.kind='FILIALEN' AND b.source_key=r.location_key))
    OR ($includeZero=1 AND r.location_key IS NULL))
  AND (r.business_date<$afterDate OR (r.business_date=$afterDate AND r.source_row<$afterRow))
  ORDER BY r.business_date DESC,r.source_row DESC LIMIT $limit` },
  {statement: articleSourceLinks,returning: false,sql: `SELECT source_article_key AS sourceArticleKey
    FROM sales_article_source_links WHERE product_id=$productId AND source_system=$sourceSystem
    ORDER BY source_article_key LIMIT $limit`}]);
module.exports = { CATALOG };

'use strict';
const { CASH_PUBLICATION_STATEMENTS: S, CASH_PUBLICATION_COLUMNS: C } = require('../statements/cash-publications');
const { CASH_SNAPSHOT_TABLES: TABLES } = require('../statements/cash-snapshots');
const snake = k => k.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const select = (columns, prefix = '') => Object.keys(columns).map(k => `${prefix}${snake(k)} AS "${k}"`).join(', ');
const insert = (name, columns) => `INSERT INTO ${name} (${Object.keys(columns).map(snake).join(', ')}) VALUES (${Object.keys(columns).map(k => '$' + k).join(', ')})`;
const entry = (statement, sql) => Object.freeze({ statement, sql, returning: false });
const references = { FILIALEN: ['location_key', ['Filialid', 'Filiale', 'FilialId']], MITARBEITER: ['seller_key', ['VerkäuferID', 'Verkäuferid']], ARTIKEL_STAMM: ['article_key', ['EAN']], KUNDEN: ['customer_key', ['KUND_NR']] };
const bindingJoin = (alias, kind, field) => `LEFT JOIN cash_publication_bindings ${alias} ON ${alias}.publication_id=$publicationId AND ${alias}.kind='${kind}' AND ${alias}.source_key=${field}`;
const reportTable = TABLES.find(t => t.name === 'Umsatz_Kasse_Details').sqlName;
const SQLITE_CASH_PUBLICATIONS_CATALOG = Object.freeze([
  entry(S.reportSourceSearch, `SELECT source_row AS "sourceRow",business_date AS "businessDate" FROM ${reportTable} INDEXED BY ${reportTable}_location_key
    WHERE dataset_slot=$datasetSlot AND location_key IS $locationKey AND business_date >= $dateFrom AND business_date <= $dateTo
    AND (business_date<$afterDate OR (business_date=$afterDate AND source_row<$afterRow))
    ORDER BY business_date DESC,source_row DESC LIMIT $limit`),
  entry(S.state, `SELECT ${select(C.STATE)} FROM cash_publication_state WHERE scope_id=$scopeId`),
  entry(S.insertState, insert('cash_publication_state', C.STATE) + ' ON CONFLICT(scope_id) DO NOTHING'),
  entry(S.updateState, 'UPDATE cash_publication_state SET revision=revision+1,payload=$payload WHERE scope_id=$scopeId AND revision=$revision'),
  entry(S.publication, `SELECT ${select(C.PUBLICATION)} FROM cash_publications WHERE id=$id AND scope_id=$scopeId`),
  entry(S.insertPublication, insert('cash_publications', C.PUBLICATION)),
  entry(S.insertBinding, insert('cash_publication_bindings', C.BINDING)),
  entry(S.binding, `SELECT ${select(C.BINDING)} FROM cash_publication_bindings WHERE publication_id=$publicationId AND kind=$kind AND source_key=$sourceKey`),
  entry(S.bindings, `SELECT ${select(C.BINDING)} FROM cash_publication_bindings WHERE publication_id=$publicationId AND kind=$kind ORDER BY source_key LIMIT $limit`),
  entry(S.bindingCount, 'SELECT COUNT(*) AS count FROM cash_publication_bindings WHERE publication_id=$publicationId'),
  entry(S.bindingInventory, 'SELECT row_count AS "rowCount",generation FROM cash_binding_inventory WHERE publication_id=$publicationId'),
  ...[false, true].flatMap(assigned => Object.entries(assigned ? S.searchAssigned : S.search).map(([name, statement]) => {
    const t = TABLES.find(t => t.name === name), sales = name === 'Umsatz_Kasse_Details', head = TABLES.find(t => t.name === 'Umsatz_KASSE');
    return entry(statement, `SELECT r.source_row AS "sourceRow",r.business_date AS "businessDate" FROM ${t.sqlName} r
      ${sales ? `JOIN ${head.sqlName} h ON h.dataset_slot=r.dataset_slot AND h.source_row=r.parent_row` : ''}
      ${assigned ? '' : bindingJoin('l', 'FILIALEN', 'r.location_key')}
      ${bindingJoin('s', 'MITARBEITER', 'r.seller_key')}
      ${bindingJoin('hs', 'MITARBEITER', sales ? 'h.seller_key' : 'r.seller_key')}
      ${bindingJoin('c', 'KUNDEN', sales ? 'h.customer_key' : 'r.customer_key')}
      WHERE r.dataset_slot=$datasetSlot AND r.business_date >= $dateFrom AND r.business_date <= $dateTo
      AND ${assigned ? "($unassigned=0 AND r.location_key IN (SELECT source_key FROM cash_publication_bindings WHERE publication_id=$publicationId AND kind='FILIALEN' AND target_id=$locationId))" : '(($unassigned=1 AND l.target_id IS NULL) OR ($unassigned=0 AND l.target_id=$locationId))'}
      AND ($sellerMode='none' OR ($sellerMode='unassigned' AND CASE WHEN $sellerRole='header_seller' THEN hs.target_id ELSE s.target_id END IS NULL)
        OR ($sellerMode='target' AND CASE WHEN $sellerRole='header_seller' THEN hs.target_id ELSE s.target_id END=$sellerId))
      AND ($customerId IS NULL OR c.target_id=$customerId)
      AND (r.business_date<$afterDate OR (r.business_date=$afterDate AND r.source_row<$afterRow))
      ORDER BY r.business_date DESC,r.source_row DESC LIMIT $limit`);
  })),
  ...Object.entries(references).map(([kind, [column, fields]]) => {
    const parts = TABLES.flatMap((t, index) => fields.some(f => t.columns.some(c => c.name === f))
      ? [`SELECT ${column} AS source_key,${index} AS table_index,MIN(source_row) AS source_row FROM ${t.sqlName} WHERE dataset_slot=$datasetSlot AND ${column}>$after GROUP BY ${column}`] : []);
    return entry(S.references[kind], `SELECT source_key AS "sourceKey",table_index AS "tableIndex",source_row AS "sourceRow" FROM (${parts.join(' UNION ALL ')}) ORDER BY source_key,table_index LIMIT $limit`);
  }),
]);
module.exports = { SQLITE_CASH_PUBLICATIONS_CATALOG };

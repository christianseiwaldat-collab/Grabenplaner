'use strict';
const {CASH_PUBLICATION_STATEMENTS:S}=require('../../statements/cash-publications');
const {CASH_SNAPSHOT_TABLES:TABLES}=require('../../statements/cash-snapshots');
const REFERENCES={FILIALEN:['location_key',['Filialid','Filiale','FilialId']],MITARBEITER:['seller_key',['VerkäuferID','Verkäuferid']],
  ARTIKEL_STAMM:['article_key',['EAN']],KUNDEN:['customer_key',['KUND_NR']]};

// Read one authenticated representative per reference through the existing
// (dataset, reference, date, row) index. GROUP BY/MIN rescanned the whole cash
// history on each page, even when the file contained only a few branches.
// The representative need not be the earliest row: the repository verifies
// its sealed content and reference key before it can become a mapping.
function indexedCashReferencePages(entries) {
  const replacements=new Map(Object.entries(REFERENCES).map(([kind,[column,fields]])=>{
    const tables=TABLES.map((t,index)=>({t,index})).filter(({t})=>fields.some(f=>t.columns.some(c=>c.name===f)));
    const scans=tables.map(({t,index})=>`refs_${index} AS (
      (SELECT ${column} AS source_key,source_row,1 AS step FROM kassa.${t.sqlName}
       WHERE dataset_slot=$1::bigint AND ${column}>$2::bytea ORDER BY ${column} LIMIT 1)
      UNION ALL
      SELECT next.source_key,next.source_row,prior.step+1 FROM refs_${index} prior
      CROSS JOIN LATERAL (SELECT ${column} AS source_key,source_row FROM kassa.${t.sqlName}
        WHERE dataset_slot=$1::bigint AND ${column}>prior.source_key ORDER BY ${column} LIMIT 1) next
      WHERE prior.step<$3::bigint
    )`);
    const sql=`WITH RECURSIVE ${scans.join(',\n')}
      SELECT source_key AS "sourceKey",table_index::bigint AS "tableIndex",source_row AS "sourceRow"
      FROM (${tables.map(({index})=>`SELECT source_key,${index} AS table_index,source_row FROM refs_${index}`).join(' UNION ALL ')}) refs
      ORDER BY source_key,table_index LIMIT $3::bigint`;
    return [S.references[kind],{statement:S.references[kind],sql,parameterOrder:['datasetSlot','after','limit'],returning:false}];
  }));
  return entries.map(entry=>replacements.has(entry.statement)?Object.freeze(replacements.get(entry.statement)):entry);
}
module.exports={indexedCashReferencePages};

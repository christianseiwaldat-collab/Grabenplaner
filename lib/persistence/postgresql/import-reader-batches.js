'use strict';
function importReaderBatch({source,batch},compiled){
 if(!compiled)throw new Error('Qualified import reader statement required');
 const sql=compiled.sql.replace(/\$(\d+)/g,(_match,index)=>{
  const name=compiled.parameterOrder[Number(index)-1];
  if(!['text','safe_integer'].includes(source.parameters[name].kind))throw new Error('Import reader batch type requires qualification');
  return `(request.value->>'${name}')`;
 });
 return Object.freeze({statement:batch,sql:`SELECT request.ordinality::bigint AS "batchOrdinal", result.*
 FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS request(value,ordinality)
 CROSS JOIN LATERAL (${sql}) AS result ORDER BY request.ordinality`,parameterOrder:Object.freeze(['requests']),returning:false});
}
module.exports={importReaderBatch};

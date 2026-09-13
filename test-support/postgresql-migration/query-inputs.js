'use strict';
// Finite synthetic probes, not production defaults. The database-discovered
// parameter types are pinned with the compiled source contract.
function sample(name,type){
  if(/^(bigint|integer|smallint|numeric|double precision|real)$/.test(type)){
    if(/limit/i.test(name))return 10;if(/cursor/i.test(name))return 1000000;if(/year/i.test(name))return 2026;
    if(/offset|exclude|existing|include|inactive/i.test(name))return 0;return 1;
  }
  if(type==='boolean')return false;if(type==='bytea')return Buffer.from([1,2]);
  if(name==='minimumLastSeenModifier')return '-5 minutes';
  if(/^(json|jsonb)$/.test(type))return [];
  if(/employeeNumber|personnelNumber|recipientEmployeeNumber/i.test(name))return '00002';
  if(/locationId/i.test(name))return '18';
  if(/costCenterId/i.test(name))return 'cc18';
  if(/positionId/i.test(name))return 'verkaufsmitarbeiter';
  if(/role/i.test(name))return 'employee';
  if(/query[0-9]|pattern/i.test(name))return '%';
  if(/tokens|eventTypes|ids$|statuses|numbers$/i.test(name))return [];
  if(/weekStart/i.test(name))return '2026-09-07';if(/weekEnd/i.test(name))return '2026-09-13';
  if(/yearStart/i.test(name))return '2026-01-01';if(/yearEnd/i.test(name))return '2026-12-31';
  if(/dateFrom|fromDate/i.test(name))return '2026-09-01';if(/dateTo|toDate/i.test(name))return '2026-09-30';
  if(/timestamp|now|asOf/i.test(name))return '2026-09-12T10:00:00.000Z';
  if(/date|day/i.test(name))return '2026-09-12';
  if(/startTime/i.test(name))return '08:00';if(/endTime/i.test(name))return '16:30';
  if(name==='direction')return 'asc';if(name==='sort')return 'name';
  return '';
}
function parameters(entry,types){
  const result={};
  for(const [name,field] of Object.entries(entry.statement.parameters)){
    if(field.kind==='json')result[name]={};
    else if(field.kind==='boolean')result[name]=false;
    else if(field.kind==='bytes')result[name]=Buffer.from([1,2]);
    else if(field.kind==='safe_integer')result[name]=sample(name,'bigint');
    else if(['bigint_string','decimal_string'].includes(field.kind))result[name]='1';
    else if(field.kind==='date')result[name]='2026-09-12';
    else if(field.kind==='time')result[name]='08:00';
    else if(field.kind==='utc_timestamp')result[name]='2026-09-12T10:00:00.000Z';
    else {const value=sample(name,'text');result[name]=typeof value==='string'?value:JSON.stringify(value);}
  }
  entry.parameterBindings.forEach((binding,index)=>{
    if(binding.source==='value'||binding.path.length===0)return;
    let target=result[binding.parameter];
    for(let p=0;p<binding.path.length-1;p++)target=target[binding.path[p]]??=(typeof binding.path[p+1]==='number'?[]:{});
    const key=binding.path.at(-1);if(binding.source==='json-extract')target[key]=sample(String(key),types[index]);
  });
  return result;
}
module.exports={parameters};

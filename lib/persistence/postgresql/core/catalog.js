'use strict';
const {createHash}=require('node:crypto');
const {SQLITE_APPLICATION_CATALOG}=require('../../sqlite/application-catalog');
const {compilePostgresqlDialectEntry}=require('../dialect-compiler');
const inventory=require('../contracts/block-1-inventory.json');
const schema=require('../contracts/source-schema-v09237.json');
const S=require('./sql');
const metadataStatements=new Set(['custom-work-rules.publication-registry-available','work-rule-governance.schema-tables']);
const sha=value=>createHash('sha256').update(value).digest('hex');
const scope=new Map(inventory.statements.filter(e=>e.boundary==='core'||metadataStatements.has(e.id)).map(e=>[e.id,e]));
function sourceEntries(){
  const entries=SQLITE_APPLICATION_CATALOG.filter(e=>scope.has(e.statement.id));
  if(entries.length!==1125||entries.some(e=>scope.get(e.statement.id).sourceSha256!==sha(e.sql)))throw new Error('Core source catalog drift; review new contracts');
  return entries;
}
function sourceContract(entry){return sha(JSON.stringify({sql:entry.sql,statement:entry.statement,returning:entry.returning}));}
function fallbackBindings(entry){
  const t=S.tokens(entry.sql),bindings=[];
  function bind(parameter,source='value',path=[]){
    const item={parameter,source,path},key=JSON.stringify(item);let i=bindings.findIndex(b=>JSON.stringify(b)===key);
    if(i<0){i=bindings.length;bindings.push(item);}return '$'+(i+1);
  }
  for(let i=0;i<t.length;i++){
    const n=t[i].toLowerCase();
    if(['json_extract','json_type'].includes(n)&&t[i+1]==='('){
      const end=S.matching(t,i+1),args=S.split(t.slice(i+2,end));
      if(args[0]?.length===1&&/^\$[a-z]/i.test(args[0][0])&&args.length<=2){
        const raw=args[1]?S.text(args[1]).slice(1,-1):'$';
        if(!/^\$(\.[A-Za-z_][A-Za-z_0-9]*|\[\d+\])*$/.test(raw))throw new Error('Unreviewed parameter JSON path');
        const path=raw.slice(1).match(/[a-z_][a-z_0-9]*|\d+/gi)?.map(p=>/^\d+$/.test(p)?Number(p):p)||[];
        const placeholder=bind(args[0][0].slice(1),n==='json_type'?'json-type':'json-extract',path);
        t.splice(i,end-i+1,n==='json_type'?`(${placeholder}::text)`:placeholder);
      }
    }
    if(/^\$[a-z_]/i.test(t[i]))t[i]=bind(t[i].slice(1));
  }
  return {sql:S.text(t),parameterBindings:bindings,parameterOrder:Object.keys(entry.statement.parameters).sort()};
}
function jsonObjects(input){
  const t=S.tokens(input);
  for(let i=t.length-1;i>=0;i--){
    if(['json_object','jsonb_build_object'].includes(t[i]?.toLowerCase())&&t[i+1]==='('){
      const end=S.matching(t,i+1),args=S.split(t.slice(i+2,end));
      if(args.length%2)throw new Error('Invalid JSON object arguments');
      for(let a=1;a<args.length;a+=2)if(args[a][0]?.toUpperCase()==='EXISTS')args[a]=['('+S.text(args[a])+')::integer'];
      const chunks=[];for(let j=0;j<args.length;j+=80)chunks.push('jsonb_build_object('+args.slice(j,j+80).map(S.text).join(',')+')');
      t.splice(i,end-i+1,'('+ (chunks.join(' || ')||"'{}'::jsonb") +')');
    }
  }
  return S.text(t);
}
function resultProjection(sql,entry){
  const columns=Object.entries(entry.statement.columns);if(!columns.length)return sql;
  const t=S.tokens(sql);let depth=0,start=-1,end=t.length;
  for(let i=0;i<t.length;i++){
    if(t[i]==='(')depth++;else if(t[i]===')')depth--;
    if(depth===0&&t[i].toUpperCase()===(entry.returning?'RETURNING':'SELECT')){start=i+1;break;}
  }
  if(start<0)throw new Error('No result projection');
  const distinct=t[start]?.toUpperCase()==='DISTINCT';if(distinct)start++;
  depth=0;for(let i=start;i<t.length;i++){if(t[i]==='(')depth++;else if(t[i]===')')depth--;if(depth===0&&['FROM','UNION','ORDER','LIMIT','WHERE'].includes(t[i].toUpperCase())){end=i;break;}}
  let fields=S.split(t.slice(start,end)).flatMap(field=>{
    if(field.length===3&&field[1]==='.'&&field[2]==='*'){
      const alias=field[0];let table;
      for(let i=end;i<t.length-1;i++)if(S.name(t[i+1])===S.name(alias)&&schema.tables.some(s=>s.name===S.name(t[i])))table=schema.tables.find(s=>s.name===S.name(t[i]));
      if(!table)throw new Error('Unreviewed star projection');
      return table.columns.map(c=>[alias,'.','"'+c.name+'"']);
    }return [field];
  });
  if(fields.length!==columns.length)throw new Error('Unreviewed result projection arity');
  // SQLite's provider reads columns by name; physical ALTER TABLE order can
  // differ from the result contract. PostgreSQL's positional decoder must not
  // silently rename a star-expanded column to a different field.
  const byName=new Map(fields.map(field=>[S.name(field.at(-1)),field]));
  if(byName.size===fields.length&&columns.every(([name])=>byName.has(name.toLowerCase())))fields=columns.map(([name])=>byName.get(name.toLowerCase()));
  const projections=fields.map((field,index)=>{
    const [name,definition]=columns[index];let level=0,alias=-1;
    for(let i=0;i<field.length;i++){if(field[i]==='(')level++;else if(field[i]===')')level--;if(level===0&&field[i].toUpperCase()==='AS')alias=i;}
    if(alias>=0)field=field.slice(0,alias);
    let expression=S.text(field);
    if(definition.kind==='boolean')expression=`CASE (${expression})::text WHEN '0' THEN false WHEN '1' THEN true ELSE (${expression})::text::boolean END`;
    else if(['text','date','time','utc_timestamp','decimal_string','bigint_string'].includes(definition.kind))expression=`(${expression})::text`;
    return expression+' AS "'+name+'"';
  });
  t.splice(start,end-start,projections.join(','));return S.text(t);
}
function jsonBindingType(entry,binding){
  if(binding.source==='json-type')return 'text';
  if(binding.path.length===0)return 'text';
  const property=binding.path.at(-1);if(typeof property!=='string')return null;
  if(property==='departmentId')return entry.statement.id==='integration-runtime.list-payroll-handoff-employees'?'text':'bigint';
  if(['excludedGroupId','eventTypes'].includes(property))return 'text';
  if(entry.statement.id==='portal-access.password-reset.revoke-for-employee'&&property==='exceptId')return 'text';
  const column=property.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());
  const references=(scope.get(entry.statement.id)||inventory.statements.find(s=>s.id===entry.statement.id))?.references;
  if(!references)throw new Error('Unreviewed statement references');
  const types=new Set(schema.tables.filter(t=>references.includes(t.name)).flatMap(t=>t.columns.filter(c=>c.name===column).map(c=>c.type)));
  if(types.size!==1)return null;
  return {TEXT:'text',INTEGER:'bigint',REAL:'double precision',BLOB:'bytea'}[[...types][0]]||null;
}
function coreExpressions(input,entry){
  let t=S.tokens(input);
  // SQLite ignores these ORDER BY clauses on a one-row aggregate. Make the
  // documented arrays deterministic by moving that order into the aggregate.
  // Membership and historical values are unchanged; comparison treats permission
  // collections as sets and deliveries as chronological records.
  for(let i=t.length-1;i>=0;i--){
    if(t[i]?.toLowerCase()==='json_group_array'&&t[i+1]==='('){
      const end=S.matching(t,i+1);let depth=0,order=-1,stop=-1;
      for(let j=end+1;j<t.length;j++){
        if(t[j]==='(')depth++;else if(t[j]===')'){if(depth===0){stop=j;break;}depth--;}
        if(depth===0&&t[j]?.toUpperCase()==='ORDER'&&t[j+1]?.toUpperCase()==='BY')order=j;
      }
      if(order>=0&&stop>=0){const sort=t.slice(order+2,stop);t.splice(order,stop-order);t.splice(end,0,'ORDER','BY',...sort);}
    }
  }
  for(let i=t.length-1;i>=0;i--){
    if(t[i]?.toUpperCase()==='LIKE'){
      const negative=t[i-1]?.toUpperCase()==='NOT',leftEnd=i-(negative?2:1),start=S.atomStart(t,leftEnd);
      let end=i+2;
      if(t[i+1]==='(')end=S.matching(t,i+1)+1;
      else if(t[i+2]==='(')end=S.matching(t,i+2)+1;
      while(t[end]==='||'){
        end+=2;if(t[end]==='(')end=S.matching(t,end)+1;
      }
      let escape="''",stop=end;
      if(t[end]?.toUpperCase()==='ESCAPE'){escape=t[end+1];stop=end+2;}
      const left=S.text(t.slice(start,leftEnd+1)),right=S.text(t.slice(i+1,end));
      t.splice(start,stop-start,`(gp.ascii_fold((${left})::text) ${negative?'NOT ':''}LIKE gp.ascii_fold((${right})::text) ESCAPE ${escape})`);i=start;
    }
  }
  t=S.tokens(S.text(t));
  for(let i=t.length-1;i>=0;i--){
    const n=t[i]?.toLowerCase();
    if(n==='user')t[i]='"user"';
    if(n==='gp_unicode_casefold')t[i]='gp.unicode_lower';
    if(n==='cast'&&t[i+1]==='('){
      const end=S.matching(t,i+1);
      if(t[end-1]?.toUpperCase()==='INTEGER'&&t[end-2]?.toUpperCase()==='AS')t.splice(i,end-i+1,'gp.sqlite_integer(('+S.text(t.slice(i+2,end-2))+')::text)');
    }
    if(n==='exists'&&['THEN','ELSE'].includes(t[i-1]?.toUpperCase())){
      const end=S.matching(t,i+1);t.splice(i,end-i+1,'('+S.text(t.slice(i,end+1))+')::integer');
    }
    if(n==='json_group_array'&&t[i+1]==='('){
      const end=S.matching(t,i+1);t.splice(i,end-i+1,"COALESCE(jsonb_agg("+S.text(t.slice(i+2,end))+"),'[]'::jsonb)");
    }
    if(n==='group_concat'&&t[i+1]==='('){
      const end=S.matching(t,i+1),args=S.split(t.slice(i+2,end));
      t.splice(i,end-i+1,'string_agg('+S.text(args[0])+'::text,'+(args[1]?S.text(args[1]):"','")+')');
    }
  }
  let sql=S.text(t);
  if(entry.statement.id==='integration-runtime.list-payroll-handoff-employees')sql=sql.replace('e . preferred_department_id = $2',"e . preferred_department_id = NULLIF($2::text,'')::bigint");
  if(/^INSERT OR IGNORE /i.test(sql)){
    sql=sql.replace(/^INSERT OR IGNORE /i,'INSERT ');
    const returning=sql.search(/\bRETURNING\b/i);
    sql=returning<0?sql+' ON CONFLICT DO NOTHING':sql.slice(0,returning)+' ON CONFLICT DO NOTHING '+sql.slice(returning);
  }
  return sql;
}
function nullOrdering(input){
  const t=S.tokens(input);
  for(let i=t.length-1;i>=0;i--){
    if(t[i]?.toUpperCase()!=='ORDER'||t[i+1]?.toUpperCase()!=='BY')continue;
    let end=i+2,depth=0;
    for(;end<t.length;end++){
      if(t[end]==='(')depth++;else if(t[end]===')'){if(depth===0)break;depth--;}
      if(depth===0&&['LIMIT','OFFSET','UNION','RETURNING','ROWS','RANGE'].includes(t[end].toUpperCase()))break;
    }
    const fields=S.split(t.slice(i+2,end)).map(f=>f.some(v=>v.toUpperCase()==='NULLS')?S.text(f):S.text(f)+' NULLS '+(f.at(-1)?.toUpperCase()==='DESC'?'LAST':'FIRST'));
    t.splice(i+2,end-i-2,fields.join(','));
  }
  return S.text(t);
}
function compileCoreEntry(entry){
  let candidate;try{candidate=compilePostgresqlDialectEntry(entry);}catch{candidate=null;}
  if(/gp_unicode_casefold/i.test(entry.sql))candidate=null;
  let compiled=candidate?.strategy==='portable-generated'?{sql:candidate.compiledSql,parameterBindings:candidate.parameterBindings,parameterOrder:candidate.parameterOrder}:fallbackBindings(entry);
  let sql=S.expression(coreExpressions(compiled.sql,entry));
  sql=jsonObjects(sql);
  // Keep the existing 0/1 physical Core contract for direct boolean parameters.
  const t=S.tokens(sql);
  for(let i=0;i<t.length;i++){
    if(/^\$\d+$/.test(t[i])){
      const binding=compiled.parameterBindings[Number(t[i].slice(1))-1];
      if(binding.source!=='value'){
        const type=jsonBindingType(entry,binding);
        if(type){
          // Historical imports use an empty-string sentinel for no department.
          if(type==='bigint'&&t[i-1]==='('&&t[i-2]?.toUpperCase()==='NULLIF'&&t[i+1]===','&&t[i+2]==="''"&&t[i+3]===')'){
            t.splice(i-2,6,`(NULLIF(${t[i]}::text,'')::bigint)`);i-=2;
          }else t[i]=`(${t[i]}::${type})`;
        }
      }
      if(binding.source==='value'){
        const kind=entry.statement.parameters[binding.parameter].kind;
        const type={text:'text',safe_integer:'bigint',bigint_string:'bigint',decimal_string:'numeric',json:'text',date:'text',time:'text',utc_timestamp:'text',bytes:'bytea'}[kind];
        if(kind==='boolean')t[i]=`CASE WHEN ${t[i]}::boolean THEN 1 WHEN ${t[i]}::boolean IS NULL THEN NULL ELSE 0 END`;
        else if(type)t[i]=`(${t[i]}::${type})`;
      }
    }
  }
  sql=nullOrdering(resultProjection(S.text(t),entry));
  return {providerEntry:{statement:entry.statement,sql,parameterOrder:compiled.parameterOrder,parameterBindings:compiled.parameterBindings,returning:entry.returning},
    provenance:{statementId:entry.statement.id,sourceContract:sourceContract(entry),sqlSha256:sha(sql)}};
}
function createCoreCatalog(){
  const compiled=sourceEntries().map(compileCoreEntry);
  const lock=require('../contracts/block-4-catalog.json');
  assertCoreCatalogLock(compiled,lock);
  return Object.freeze({entries:Object.freeze(compiled.map(e=>Object.freeze(e.providerEntry))),provenance:Object.freeze(compiled.map(e=>Object.freeze(e.provenance))),productActivation:false});
}
function assertCoreCatalogLock(compiled,lock){
  const pinned=new Map(lock.entries.map(e=>[e.statementId,e]));
  if(lock.version!==1||lock.productActivation!==false||lock.scope!=='core-development'||pinned.size!==1125||lock.entries.length!==1125||compiled.length!==1125
    ||lock.schemaPlanSha256!==require('./schema').createSchemaPlan().digest
    ||compiled.some(e=>{const p=pinned.get(e.provenance.statementId);return !p||p.sourceContract!==e.provenance.sourceContract||p.sqlSha256!==e.provenance.sqlSha256;}))throw new Error('Core catalog lock drift; explicit qualification required');
}
module.exports={sourceEntries,sourceContract,compileCoreEntry,createCoreCatalog,assertCoreCatalogLock};

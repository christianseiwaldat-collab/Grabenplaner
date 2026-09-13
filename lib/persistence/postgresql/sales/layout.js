'use strict';
const inventory=require('../contracts/block-1-inventory.json');
const source=require('../contracts/source-schema-v09237.json');
const {tokens,text,name}=require('../core/sql');
const SCHEMAS=Object.freeze(['gp','kassa','integration','trade','reporting']);
const SEARCH_PATH='pg_catalog,'+SCHEMAS.join(',');
const tables=new Map(inventory.tables.filter(t=>t.database==='sales').map(t=>[t.name,t]));
function stageTables(stage){
  if(![5,6,7,8].includes(stage))throw new Error('Sales migration stage is not implemented');
  return [...tables.values()].filter(t=>stage===8|| (stage===5?t.schema==='kassa':t.schema!=='reporting'));
}
function relation(table){
  const target=tables.get(table);if(!target)throw new Error('Unreviewed Sales relation '+table);
  return target.schema+'."'+table+'"';
}
function qualify(sql){
  const t=tokens(sql.replace(/\$gp_trigger\$/g,'GP_MIGRATION_FUNCTION_BODY_TAG'));
  for(let i=0;i<t.length;i++){
    if(t[i].toLowerCase()==='typeof'&&t[i+1]==='(')t[i]='gp.sqlite_typeof';
    if(t[i].toUpperCase()==='INDEXED'&&t[i+1]?.toUpperCase()==='BY'){t.splice(i,3);i--;continue;}
    if(t[i]==='gp'&&t[i+1]==='.'&&name(t[i+2])==='article_reference_snapshots'){t.splice(i,3,relation('sales_article_revisions'));continue;}
    if(t[i]==='gp'&&t[i+1]==='.'&&tables.has(name(t[i+2]))){t.splice(i,3,relation(name(t[i+2])));continue;}
    const n=name(t[i]);if(tables.has(n)&&t[i-1]!=='.')t[i]=relation(n);
  }
  return text(t).replace(/GP_MIGRATION_FUNCTION_BODY_TAG/g,'$gp_trigger$')
    .replace(/DO UPDATE SET count = count \+ 1/g,'DO UPDATE SET count = integration.data_import_run_state_counts.count + 1');
}
module.exports={inventory,source,SCHEMAS,SEARCH_PATH,tables,stageTables,relation,qualify};

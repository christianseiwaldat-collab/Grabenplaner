'use strict';

const crypto=require('node:crypto');

const FULL_SCOPE='full';
const DEPLOY_SCOPE='deploy-owned';
const POLICY_ID='core-and-owned-sales-access-v3';
const FRESH_POLICY_ID='core-and-owned-sales-access-v4';
const FRESH_BASIS='fresh-source-rebuild';
const FORMAT='grabenplaner-deploy-sales-plan';
const IDENTIFIER=/^[a-z][a-z0-9_]{0,62}$/;

// Source-level replay rebuilds completed Access technical histories and links.
// The sparse state file preserves only GP/unknown/pending rows and their actual
// anchor closure. Its selector checks incoming FK rows before sealing a point.
// Unknown tables, images, mappings, PDFs, run/event audit and Core remain intact.
const RULES=Object.freeze([
  ...Array.from({length:7},(_,index)=>Object.freeze({schema:'kassa',table:'cash_snapshot_'+index,rebuild:'archived-cash-source',mode:'empty'})),
  ...require('./access-owned-state').PROJECTED_TABLES.map(({schema,table})=>Object.freeze({schema,table,rebuild:'source-level-access-replay-and-owned-anchor-state',mode:'projection'})),
  Object.freeze({schema:'trade',table:'sales_article_search_projection',rebuild:'article-search-cache',mode:'empty'}),
  Object.freeze({schema:'trade',table:'sales_article_search_dirty',rebuild:'article-search-cache',mode:'empty'}),
]);
const FRESH_RULES=Object.freeze(RULES.map(rule=>Object.freeze({...rule,rebuild:rule.schema==='kassa'?'fresh-cash-source':rule.mode==='projection'?'fresh-access-replay-and-owned-anchor-state':rule.rebuild})));

function stable(value){
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
const hash=value=>crypto.createHash('sha256').update(stable(value)).digest('hex');
const POLICY_SHA256=hash({policyId:POLICY_ID,rules:RULES});
const FRESH_POLICY_SHA256=hash({policyId:FRESH_POLICY_ID,basis:FRESH_BASIS,rules:FRESH_RULES});
const key=table=>table.schema+'.'+table.table;
const order=(left,right)=>key(left)<key(right)?-1:key(left)>key(right)?1:0;
const fail=code=>{throw Object.assign(new Error(code),{code});};

function normalizeScope(scope=FULL_SCOPE){
  if(scope!==FULL_SCOPE&&scope!==DEPLOY_SCOPE)fail('PG_RECOVERY_SCOPE_INVALID');
  return scope;
}

function tableReference(value){
  if(!value||typeof value.schema!=='string'||typeof value.table!=='string'||!IDENTIFIER.test(value.schema)||!IDENTIFIER.test(value.table))fail('PG_DEPLOY_SALES_TABLE_INVALID');
  return {schema:value.schema,table:value.table};
}

function freeze(value){
  if(value&&typeof value==='object'){
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Call with the actual tables and foreign keys read in the locked Sales
// snapshot. Foreign keys must include incoming references from other schemas:
// retained -> empty edges invalidate the point. Edges to sparse tables require
// the owned-state selector's actual row closure; the table list alone is not a
// proof that its retained foreign keys are present. Constraints remain enabled.
function buildSalesPlan({tables,foreignKeys,basis}={}){
  if(basis!==undefined&&basis!==FRESH_BASIS)fail('PG_DEPLOY_SALES_BASIS');
  const fresh=basis===FRESH_BASIS,rules=fresh?FRESH_RULES:RULES;
  if(!Array.isArray(tables)||!tables.length||tables.length>10000||!Array.isArray(foreignKeys)||foreignKeys.length>20000)fail('PG_DEPLOY_SALES_INVENTORY_REQUIRED');
  const reviewedTables=tables.map(tableReference).sort(order);
  const names=new Set(reviewedTables.map(key));
  if(names.size!==reviewedTables.length)fail('PG_DEPLOY_SALES_TABLE_DUPLICATE');
  const ruleByName=new Map(rules.map(rule=>[key(rule),rule]));
  const excludedTables=reviewedTables.filter(table=>ruleByName.has(key(table)));
  const retainedTables=reviewedTables.filter(table=>!ruleByName.has(key(table)));
  const excluded=new Set(excludedTables.map(key));
  const edges=new Map();
  for(const value of foreignKeys){
    const from=tableReference(value),to=tableReference({schema:value?.referencedSchema,table:value?.referencedTable});
    if(!excluded.has(key(from))&&excluded.has(key(to))&&ruleByName.get(key(to)).mode!=='projection')fail('PG_DEPLOY_SALES_RETAINED_DEPENDENCY');
    const edge={...from,referencedSchema:to.schema,referencedTable:to.table};
    edges.set(stable(edge),edge);
  }
  const reviewedForeignKeys=[...edges.values()].sort((left,right)=>stable(left)<stable(right)?-1:stable(left)>stable(right)?1:0);
  const plan={format:FORMAT,schemaVersion:1,scope:DEPLOY_SCOPE,policyId:fresh?FRESH_POLICY_ID:POLICY_ID,policySha256:fresh?FRESH_POLICY_SHA256:POLICY_SHA256,
    ...(fresh?{basis:FRESH_BASIS}:{}),
    tables:reviewedTables,foreignKeys:reviewedForeignKeys,excludedTables,retainedTables,
    projectedTables:excludedTables.filter(table=>ruleByName.get(key(table)).mode==='projection'),
    requiredSourceKinds:excludedTables.some(table=>ruleByName.get(key(table)).mode==='projection')
      ? [...require('../../../data-import-source-catalog').SOURCE_KINDS]
      : excludedTables.some(table=>table.schema==='kassa')?['cash']:[]};
  return freeze({...plan,planSha256:hash(plan)});
}

function validateSalesPlan(plan){
  const fresh=plan?.policyId===FRESH_POLICY_ID;
  if(!plan||plan.format!==FORMAT||plan.schemaVersion!==1||plan.scope!==DEPLOY_SCOPE
    ||(fresh?plan.basis!==FRESH_BASIS||plan.policySha256!==FRESH_POLICY_SHA256:plan.policyId!==POLICY_ID||plan.policySha256!==POLICY_SHA256||plan.basis!==undefined))fail('PG_DEPLOY_SALES_PLAN_INVALID');
  const expected=buildSalesPlan({tables:plan.tables,foreignKeys:plan.foreignKeys,...(fresh?{basis:FRESH_BASIS}:{})});
  if(stable(plan)!==stable(expected))fail('PG_DEPLOY_SALES_PLAN_INVALID');
  return expected;
}

function excludedTableDataArguments(plan){
  const verified=validateSalesPlan(plan);
  // pg_dump's quoted pattern components are exact identifiers. No glob, regex,
  // schema exclusion or shell interpolation is allowed into this argument list.
  return verified.excludedTables.map(table=>'--exclude-table-data="'+table.schema+'"."'+table.table+'"');
}

module.exports={FULL_SCOPE,DEPLOY_SCOPE,POLICY_ID,POLICY_SHA256,FRESH_POLICY_ID,FRESH_POLICY_SHA256,FRESH_BASIS,RULES,FRESH_RULES,normalizeScope,buildSalesPlan,validateSalesPlan,excludedTableDataArguments};

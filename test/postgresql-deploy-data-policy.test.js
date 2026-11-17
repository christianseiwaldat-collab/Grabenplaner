'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../lib/persistence/postgresql/operations/deploy-data-policy');
const inventory=require('../lib/persistence/postgresql/contracts/block-1-inventory.json');
const ref=name=>({schema:name.split('.')[0],table:name.split('.')[1]});
const name=table=>table.schema+'.'+table.table;

function currentInventory(){
  const tables=inventory.tables.filter(table=>table.database==='sales');
  const byName=new Map(tables.map(table=>[table.name,table]));
  return {tables:tables.map(table=>({schema:table.schema,table:table.name})),
    foreignKeys:tables.flatMap(table=>table.foreignKeys.map(foreign=>({schema:table.schema,table:table.name,
      referencedSchema:foreign.targetDatabase==='core'?'integration':byName.get(foreign.table).schema,
      referencedTable:foreign.targetDatabase==='core'?'core_location_references':foreign.table})))};
}

test('scope defaults to the complete pair and rejects unsupported or misspelled scopes',()=>{
  assert.equal(P.normalizeScope(),'full');
  assert.equal(P.normalizeScope('deploy-owned'),'deploy-owned');
  for(const scope of [null,'core','sales','Full','',true,{},[]])assert.throws(()=>P.normalizeScope(scope),{code:'PG_RECOVERY_SCOPE_INVALID'});
});

test('the current dependency graph preserves identities, GP decisions, undo payloads, images and report facts',()=>{
  const plan=P.buildSalesPlan(currentInventory());
  assert.equal(plan.excludedTables.length,29);
  const retained=new Set(plan.retainedTables.map(name));
  for(const table of ['trade.sales_article_own_images','trade.sales_articles','trade.sales_article_import_snapshots','trade.sales_article_source_links',
    'trade.sales_article_identifier_owners','integration.data_import_runs','integration.data_import_events','reporting.sales_import_profiles','reporting.sales_branch_mapping_revisions',
    'reporting.sales_report_product_group_metrics','reporting.sales_report_total_metrics','reporting.sales_import_staging_records'])assert.ok(retained.has(table),table);
  assert.equal(plan.projectedTables.length,20);
  const projected=new Set(plan.projectedTables.map(name));
  for(const table of ['trade.import_master_records','integration.import_history_versions','integration.import_history_references',
    'integration.data_import_change_payload_refs','integration.data_import_rows','integration.data_import_links'])assert.ok(projected.has(table),table);
  assert.deepEqual(plan.requiredSourceKinds,['trade','cash','bestell','weum','inventur','lieferantenrechnungen']);
  assert.ok(Object.isFrozen(plan)&&Object.isFrozen(plan.excludedTables)&&Object.isFrozen(plan.excludedTables[0]));
  assert.deepEqual(P.validateSalesPlan(JSON.parse(JSON.stringify(plan))),plan);
});

test('unknown tables remain intact while the three exact history extensions join sparse replay',()=>{
  const input=currentInventory();
  input.tables.push(...['gp.environment_contract','integration.core_audit_outbox','integration.core_audit_delivery',
    'integration.import_history_snapshots','integration.import_history_snapshot_members',
    'integration.import_history_snapshot_attestations','trade.sales_article_new_user_content','kassa.cash_snapshot_7'].map(ref));
  const plan=P.buildSalesPlan(input),retained=new Set(plan.retainedTables.map(name));
  for(const table of input.tables.slice(-8).filter(table=>!table.table.startsWith('import_history_')))assert.ok(retained.has(name(table)),name(table));
  assert.equal(plan.excludedTables.length,32);
  assert.equal(plan.projectedTables.length,23);
});

test('a retained relation referencing excluded data invalidates the reduced point before a dump',()=>{
  const input=currentInventory();
  input.tables.push(ref('trade.new_cash_annotation'));
  input.foreignKeys.push({...ref('trade.new_cash_annotation'),referencedSchema:'kassa',referencedTable:'cash_snapshot_1'});
  assert.throws(()=>P.buildSalesPlan(input),{code:'PG_DEPLOY_SALES_RETAINED_DEPENDENCY'});
  // Incoming dependencies outside the normal Sales schemas also block it.
  input.foreignKeys.pop();
  input.foreignKeys.push({...ref('external.protected_cash_links'),referencedSchema:'kassa',referencedTable:'cash_snapshot_1'});
  assert.throws(()=>P.buildSalesPlan(input),{code:'PG_DEPLOY_SALES_RETAINED_DEPENDENCY'});
});

test('plan fingerprints ignore query ordering and duplicate composite foreign-key edges',()=>{
  const input=currentInventory(),original=P.buildSalesPlan(input);
  input.tables.reverse();input.foreignKeys.reverse();input.foreignKeys.push({...input.foreignKeys[0]});
  const reordered=P.buildSalesPlan(input);
  assert.deepEqual(reordered,original);
  assert.match(original.policySha256,/^[a-f0-9]{64}$/);
  assert.match(original.planSha256,/^[a-f0-9]{64}$/);
  input.tables.push(ref('trade.new_owned_content'));
  assert.notEqual(P.buildSalesPlan(input).planSha256,original.planSha256);
});

test('a manifest cannot enlarge its exclusions, remove its retained data or rewrite its source requirement',()=>{
  const plan=P.buildSalesPlan(currentInventory());
  const tamper=change=>{const copy=JSON.parse(JSON.stringify(plan));change(copy);assert.throws(()=>P.excludedTableDataArguments(copy),{code:'PG_DEPLOY_SALES_PLAN_INVALID'});};
  tamper(copy=>copy.excludedTables.push(ref('trade.sales_article_own_images')));
  tamper(copy=>copy.retainedTables.pop());
  tamper(copy=>copy.requiredSourceKinds=[]);
  tamper(copy=>copy.policyId='unreviewed-policy');
  tamper(copy=>copy.planSha256='0'.repeat(64));
});

test('dump arguments omit data only and quote each exact reviewed table identifier',()=>{
  const plan=P.buildSalesPlan(currentInventory()),args=P.excludedTableDataArguments(plan);
  assert.equal(args.length,29);
  assert.ok(args.includes('--exclude-table-data="kassa"."cash_snapshot_0"'));
  assert.ok(args.includes('--exclude-table-data="trade"."sales_article_search_projection"'));
  assert.ok(args.every(argument=>/^--exclude-table-data="[a-z_]+"\."[a-z0-9_]+"$/.test(argument)));
  assert.ok(!args.some(argument=>argument.includes('*')||argument.includes('sales_article_own_images')));
  const projectionOnly=P.buildSalesPlan({tables:[ref('trade.sales_article_search_projection'),ref('trade.sales_article_own_images')],foreignKeys:[]});
  assert.deepEqual(projectionOnly.requiredSourceKinds,[]);
});

test('missing dependency inventories, duplicate tables and unsafe identifiers fail closed',()=>{
  for(const input of [undefined,{}, {tables:[],foreignKeys:[]}, {tables:[ref('trade.sales_articles')]},
    {tables:[ref('trade.sales_articles'),ref('trade.sales_articles')],foreignKeys:[]},
    {tables:[{schema:'trade',table:'sales_articles*'}],foreignKeys:[]},
    {tables:[{schema:'trade',table:'sales_articles; DROP TABLE x'}],foreignKeys:[]},
    {tables:[ref('trade.sales_articles')],foreignKeys:[{schema:'trade',table:'sales_articles',referencedSchema:'kassa',referencedTable:'cash*'}]}])assert.throws(()=>P.buildSalesPlan(input));
});

test('fresh-generation V4 has its own explicit policy binding while preserving the exact V3 table boundary',()=>{
  const input=currentInventory(),old=P.buildSalesPlan(input),fresh=P.buildSalesPlan({...input,basis:P.FRESH_BASIS});
  assert.equal(fresh.policyId,P.FRESH_POLICY_ID);assert.equal(fresh.basis,'fresh-source-rebuild');
  assert.notEqual(fresh.policySha256,old.policySha256);assert.notEqual(fresh.planSha256,old.planSha256);
  assert.deepEqual(fresh.excludedTables,old.excludedTables);assert.deepEqual(fresh.retainedTables,old.retainedTables);
  assert.deepEqual(P.excludedTableDataArguments(fresh),P.excludedTableDataArguments(old));
  assert.deepEqual(P.validateSalesPlan(JSON.parse(JSON.stringify(fresh))),fresh);assert.deepEqual(P.validateSalesPlan(old),old);
  for(const tamper of [copy=>delete copy.basis,copy=>copy.basis='archive-optional',copy=>copy.policyId=P.POLICY_ID,copy=>copy.requiredSourceKinds=[]]){
    const copy=JSON.parse(JSON.stringify(fresh));tamper(copy);assert.throws(()=>P.validateSalesPlan(copy),{code:'PG_DEPLOY_SALES_PLAN_INVALID'});
  }
  assert.throws(()=>P.buildSalesPlan({...input,basis:'archive-optional'}),{code:'PG_DEPLOY_SALES_BASIS'});
  assert.equal(P.FRESH_RULES.length,32);assert.ok(P.FRESH_RULES.filter(rule=>rule.schema==='kassa').every(rule=>rule.rebuild==='fresh-cash-source'));
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../lib/data-import-contract'), H = require('../lib/tradefoto-history-profiles');
const { SQLITE_APPLICATION_CATALOG: HISTORICAL_APPLICATION_CATALOG, SALES_REPORT_RECEIPT_ISSUE_CATALOG } = require('../lib/persistence/sqlite/application-catalog');
// The historical dialect catalog stays frozen; this fixture also exercises the
// separately qualified current receipt-issue read used by report jobs.
const SQLITE_APPLICATION_CATALOG = Object.freeze([...HISTORICAL_APPLICATION_CATALOG, ...SALES_REPORT_RECEIPT_ISSUE_CATALOG]);
const { ensureSqliteDataImportRuntimeSchema } = require('../lib/persistence/sqlite/operations/data-import-runtime-schema');
const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
const { loadManagedDataImportProtection } = require('../lib/data-import-managed-protection');
const { createCashSnapshotStore } = require('../lib/persistence/repositories/cash-snapshots');
const { createCashPublicationRuntime } = require('../lib/persistence/repositories/cash-publication-runtime');
const { createManagedSalesHistoryRuntime } = require('../lib/persistence/repositories/sales-history-runtime');
const { CASH_SNAPSHOT_TABLES: TABLES } = require('../lib/persistence/statements/cash-snapshots');
const { CASH_SOURCE_POLICIES } = require('../lib/cash-source-policies');
const TIME = '2026-09-07T12:00:00.000Z';
const code = c => e => e.code === c;
const raw = (name, values) => ({ ...Object.fromEntries(H.tableFor('cash', name).columns.map(c => [c.name, null])), ...values });
function rows({ count = 1, price = '12', seller = '07', location = '018', unknown = false, description = 'Synthetic article' } = {}) {
  const flags = CASH_SOURCE_POLICIES[0].policy.statusRules[3].flags;
  const head = raw('Umsatz_KASSE', { Bonnr: '000001', Filialid: location, Kassenid: '01', Bondatum: '2010-01-02T00:00:00.000',
    VerkäuferID: '08', KUND_NR: '00031', RechnungsBetrag: String(count * Number(price)) });
  return { Umsatz_KASSE: [head], Umsatz_Kasse_Details: Array.from({ length: count }, (_, i) => raw('Umsatz_Kasse_Details', {
    Bonnr: head.Bonnr, Filialid: location, Kassenid: head.Kassenid, Bondatum: head.Bondatum,
    RepID: '00000000-0000-0000-0000-' + String(i + 1).padStart(12, '0'), EAN: '00042', VKMenge: '1', VK_Preis: price,
    MWST: '20', Verkäuferid: seller, Artikelbezeichnung: description, ...flags, ...(unknown ? { Beratung: true } : {}) })) };
}
// Exercise the PostgreSQL repository branch through a real transactional
// synthetic database. The adapter delegates each batch to equivalent scalar
// statements; native PostgreSQL SQL is checked separately.
function publicationBatchFixture(base){
  const {createPersistenceProviderFacade}=require('../lib/persistence/contract');
  const {POSTGRESQL_CAPABILITIES}=require('../lib/persistence/postgresql/provider');
  const {CASH_PUBLICATION_BATCHES:B}=require('../lib/persistence/statements/cash-publication-batches');
  const M=require('../lib/persistence/statements/import-master-data').IMPORT_MASTER_STATEMENTS;
  const S=require('../lib/persistence/statements/cash-publications').CASH_PUBLICATION_STATEMENTS;
  const state={options:[],queries:[],batches:0,failBatch:0};
  async function query(tx,s,p){
    state.queries.push(s.id);
    if(s===B.articles){const result=[];for(const sourceArticleKey of p.keys){const target=await tx.queryOne(M.articleBySource,{sourceSystem:p.sourceSystem,sourceArticleKey});if(target)result.push({sourceArticleKey,...target});}return result;}
    const index=B.rows.indexOf(s);
    if(index>=0){const result=[];for(const sourceRow of p.rows){const row=await tx.queryOne(TABLES[index].statements.row,{datasetSlot:p.datasetSlot,sourceRow});if(row)result.push(row);}return result;}
    if(s.operation==='queryOne'){const row=await tx.queryOne(s,p);return row?[row]:[];}return tx.queryAll(s,p);
  }
  async function execute(tx,s,p){
    if(s!==B.bindings)return tx.execute(s,p);
    assert.ok(p.rows.length>0&&p.rows.length<=200);state.batches++;
    for(const row of p.rows)await tx.execute(S.insertBinding,{...row,sourceKey:Buffer.from(row.sourceKey,'hex')});
    return {rowsAffected:p.rows.length-(state.failBatch===state.batches?1:0),returnedRows:[]};
  }
  const access=createPersistenceProviderFacade({providerId:'postgresql',capabilities:POSTGRESQL_CAPABILITIES,
    query:(s,p)=>query(base,s,p),execute:(s,p)=>execute(base,s,p),close:async()=>{},
    async beginTransaction(options){
      state.options.push(options);let ready,finish,cancel;
      const opened=new Promise(resolve=>{ready=resolve;}),ending=new Promise((resolve,reject)=>{finish=resolve;cancel=reject;});ending.catch(()=>{});
      const done=base.transaction(async tx=>{ready(tx);await ending;},options);done.catch(()=>{});const tx=await opened;
      return {query:(s,p)=>query(tx,s,p),execute:(s,p)=>execute(tx,s,p),async commit(){finish();await done;},async rollback(){cancel(new Error('Synthetic rollback'));try{await done;}catch{}}};
    }});
  return {access,state};
}

async function reportPdfText(buffer) {
  assert.ok(Buffer.isBuffer(buffer)); assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false });
  const document = await loading.promise;
  try {
    const pages = [];
    for (let i = 1; i <= document.numPages; i++) pages.push((await (await document.getPage(i)).getTextContent()).items.map(t => t.str).join(' '));
    return pages.join('\n');
  } finally { await loading.destroy(); }
}

test('cash branch controls only offer known GP targets and reject a tampered selection',()=>{
  const UI=require('../public/cash-publication'),locations=[{sourceId:'<img>',targetId:'gp-18',historical:false,match:'previous'}],targets=[{id:'gp-18',label:'<script>',active:true}];
  const html=UI.renderLocations(locations,targets);assert.doesNotMatch(html,/<img>|<script>|type="text"/);
  assert.match(html,/<select data-c-location="0"/);assert.match(html,/Bisherige Zuordnung/);
  assert.equal(UI.locationMappings(locations,targets).length,1);
  assert.throws(()=>UI.locationMappings([{...locations[0],targetId:'invented'}],targets),/vorhandenen GP-Standort/);
});

test('cash publication UI escapes identifiers and late replies cannot restore a closed view', async () => {
  const UI = require('../public/cash-publication'), handlers = {}; let resolve;
  assert.doesNotMatch(UI.renderMappings([{ kind: 'FILIALEN', sourceId: '<img src=x>', targetId: '<script>x</script>' }]), /<img|<script>/);
  const root = { textContent: '', querySelector: () => null, addEventListener: (n, h) => { handlers[n] = h; }, removeEventListener() {}, replaceChildren() { this.textContent = ''; } };
  let signal; const view = UI.mount(root, { source: { id: 'a'.repeat(64) }, api: (_url, options) => { signal = options.signal; return new Promise(r => { resolve = r; }); } });
  view.destroy(); assert.equal(signal.aborted, true); resolve({ private: true }); await new Promise(r => setImmediate(r)); assert.equal(root.textContent, '');
});
test('editing the form during preview never enables activation of a stale proposal', async () => {
  const UI = require('../public/cash-publication'), handlers = {};
  const fields = { label: { value: 'First label' }, policy: { value: 'test' }, articles: { checked: false }, activate: { disabled: true }, message: { textContent: '' } };
  const root = { textContent: '', innerHTML: '', querySelector: s => fields[/data-c="([^"]+)"/.exec(s)?.[1]],
    addEventListener: (n, h) => { handlers[n] = h; }, removeEventListener() {}, replaceChildren() {} };
  let resolve;
  const view = UI.mount(root, { source: { id: 'a'.repeat(64) }, api: async url => url.endsWith('/context')
    ? { available: true, projection: { apply: true }, mappingProjection: { tables: [] }, state: { revision: 0 }, policies: [{ id: 'test', label: 'Test' }] }
    : new Promise(r => { resolve = r; }) });
  await new Promise(r => setImmediate(r));
  const button = { hasAttribute: n => n === 'data-c-preview' };
  const pending = handlers.click({ target: { closest: () => button }, stopPropagation() {} });
  await new Promise(r => setImmediate(r)); fields.label.value = 'Changed label';
  handlers.input({ target: fields.label, stopPropagation() {} }); resolve({ planHash: 'b'.repeat(64), bindings: 1, message: 'Old preview' });
  await pending; assert.equal(fields.activate.disabled, true); assert.match(fields.message.textContent, /während der Prüfung geändert/); view.destroy();
});
async function customerMaster(f, sourceId = '00031', options = {}) {
  require('../lib/persistence/sqlite/operations/crm-schema').ensureSqliteCrmSchema(f.app.database);
  f.app.database.exec('CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail TEXT,created_at TEXT)');
  for (const permission of ['crm:access', 'crm:customers:read', 'crm:customers:write', 'crm:purchases:read'])
    if (!f.session.permissions.includes(permission)) f.session.permissions.push(permission);
  const source = await require('../test-support/trade-insights-fixture').insightFixture({
    access: f.app.provider, protection: f.protection, ...f.actor, seedBase: false });
  await source.ingest('KUNDEN', [{ KUND_NR: sourceId, VORNAME: 'Synthetic', NACHNAME: 'Customer' }], { master: true, ...options });
  const record = (await source.masters.mappings({ table: 'KUNDEN', sourceInstance: options.sourceInstance || 'tradefoto-trade', key: sourceId })).items[0];
  const input = { recordId: record.id, expectedSourceRevision: record.revision };
  const synced = await source.masters.syncCustomer(input, (await source.masters.previewCustomer(input)).planHash);
  return { source, record, synced, customerId: synced.targetId };
}

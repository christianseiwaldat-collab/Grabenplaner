'use strict';
const crypto = require('node:crypto');
const C = require('./data-import-contract');
const Model = require('./sales-article-sales-model');
const { buildSalesHistoryProjection } = require('./sales-history-access');
const { reportMarginPolicyFor } = require('./sales-report-margin');
const { createSalesMasterReader } = require('./persistence/repositories/sales-master-data');
const { createImportMasterReferenceReader } = require('./persistence/repositories/import-master-data');
const { IMPORT_MASTER_STATEMENTS: CRM } = require('./persistence/statements/import-master-data');
const { resolveArticleSalesIdentity } = require('./sales-article-sales-identity');
const MAX_ROWS = 10000, MAX_BYTES = 16 * 1024 * 1024, MAX_STORE_BYTES = 64 * 1024 * 1024, TTL = 900000, BATCH = 200;
const START = Object.freeze({ afterDate: '9999-12-31', afterId: '~' });
const linked = ref => !!ref?.targetId && ['linked','historical_mapping'].includes(ref.status);
function createArticleSalesStore() { return { entries: new Map(),busy: new Set() }; }
function createArticleSalesWorkspace({ access,protection,backend,getSession,getActor,today,now = () => Date.now(),store = createArticleSalesStore(),listPricePolicy = null }) {
  function state() {
    const session = getSession(),actor = getActor(),p = buildSalesHistoryProjection(session),grants = Model.capabilities(session);
    if (!grants.sales || actor.scopeId !== backend.source.scopeId) C.fail('IMPORT_FORBIDDEN',403);
    return { session,actor,p,grants,locations: backend.source.locations.filter(l => p.company || p.locationIds.includes(l.id)),
      signature: protection.digest([actor,session.employeeNumber,session.accountId || '',p,grants]) };
  }
  function reader(tx,s) {
    return backend.service(tx,value => {
      if (value.source !== 'cash' || value.sourceInstance !== 'tradefoto-cash' || !['Umsatz_Kasse_Details','Umsatz_KASSE'].includes(value.sourceTable)) return false;
      if (value.action === 'history.scope') {
        const branch = value.locations.find(l => l.role === 'location.filialid');
        return linked(branch) ? s.locations.some(l => l.id === branch.targetId) : s.p.unassigned;
      }
      if (value.action === 'history.reference' && value.targetKind === 'crm_customer') return s.grants.customers;
      return value.dataClasses.every(k => ['internal_business','customer_restricted'].includes(k)
        || k === 'personnel_restricted' && s.grants.sellers || k === 'catalog_costs' && s.grants.margin);
    });
  }
  async function collect(tx,s,q,identity) {
    const service = reader(tx,s),master = createSalesMasterReader({ protection,scopeId: s.actor.scopeId }),rows = [],seen = new Set(),receipts = new Map(),people = new Map(),customers = new Map();
    const locations = q.locationId ? [q.locationId] : [...s.locations.map(l => l.id),...(s.p.unassigned ? ['unassigned'] : [])];
    const marginPolicy = reportMarginPolicyFor(backend.policy); let position = START,bytes = 0;
    for (;;) {
      let candidates = [];
      for (const locationId of locations) {
        for (const sourceKey of identity.sourceKeys) {
          candidates.push(...await backend.searchArticle(tx,{ ...q,articleNumber:sourceKey,...position,locationId,unassigned: locationId === 'unassigned',limit: BATCH + 1 }));
          candidates.sort((a,b) => b.businessDate.localeCompare(a.businessDate) || b.id.localeCompare(a.id)); candidates = candidates.slice(0,BATCH + 1);
        }
      }
      const selected=candidates.slice(0,BATCH);
      for (let index=0;index<selected.length;index++) {
        const candidate=selected[index];
        if(service.prefetch && index%20===0){const ids=[...new Set(selected.slice(index,index+20).map(r=>r.parentId))];await service.prefetch(ids);}
        if (seen.has(candidate.id)) C.fail('IMPORT_HISTORY_INTEGRITY'); seen.add(candidate.id);
        const detail = await service.detail(candidate.id),fields = detail.fields,refs = Object.fromEntries(detail.references.map(r => [r.role,r]));
        if (detail.table !== 'Umsatz_Kasse_Details' || !identity.sourceKeys.includes(fields.EAN) || detail.provenance.businessDate !== candidate.businessDate) C.fail('IMPORT_HISTORY_INTEGRITY');
        const branch = refs['location.filialid'],locationId = linked(branch) ? branch.targetId : 'unassigned';
        if (!locations.includes(locationId) || q.locationId && locationId !== q.locationId) C.fail('IMPORT_HISTORY_INTEGRITY');
        const receiptId = detail.provenance.parentId;
        if(receiptId!==candidate.parentId)C.fail('IMPORT_HISTORY_INTEGRITY');
        if (!receipts.has(receiptId)) receipts.set(receiptId,{ head: await service.detail(receiptId),checked: await service.receipt(receiptId) });
        const {head,checked} = receipts.get(receiptId);
        if (head.table !== 'Umsatz_KASSE' || head.provenance.businessDate !== candidate.businessDate) C.fail('IMPORT_HISTORY_INTEGRITY');
        const metric = checked.canAggregate ? checked.positions?.find(m => m.key === fields.RepID) : null;
        const row = { id: detail.id,receiptId,date: candidate.businessDate,locationId,sourceLocationId: fields.Filialid,
          location: s.locations.find(l => l.id === locationId)?.label || 'Filialzuordnung offen',articleNumber: identity.basis === 'catalog_source_link' ? q.articleNumber : fields.EAN,articleSourceKey:fields.EAN,
          quantity: fields.VKMenge,description: fields.Artikelbezeichnung || '',deviceNumber: fields.KameraNr || '',receipt: fields.Bonnr || '',
          status: metric?.status || 'review',issues: metric ? [] : checked.issues || ['POSITION_RECONCILIATION_MISSING'],
          ...Model.metrics(fields,metric,backend.policy,marginPolicy,s.grants.margin,listPricePolicy) };
        if (s.grants.sellers) {
          const sourceId = fields['Verkäuferid'] == null || /^0+$/.test(String(fields['Verkäuferid'])) ? '' : String(fields['Verkäuferid']);
          row.personnel = sourceId; row.personnelTargetId = linked(refs.line_seller) ? refs.line_seller.targetId : null;
          if (sourceId && !people.has(sourceId)) people.set(sourceId,await master.byKey(tx,'MITARBEITER',[sourceId],['NACHNAME']));
          row.personnelSurname = people.get(sourceId)?.NACHNAME || '';
        }
        if (s.grants.customers) {
          const number = head.fields.KUND_NR == null || /^0+$/.test(String(head.fields.KUND_NR)) ? '' : String(head.fields.KUND_NR);
          if (number && !customers.has(number)) {
            let ref = head.references.find(r => r.role === 'customer');
            if (!linked(ref)) ref = await createImportMasterReferenceReader({ protection,authorize: () => s.grants.customers })(tx,{ ...s.actor,sourceInstance: 'tradefoto-trade' },'KUNDEN',[number]);
            const customer = linked(ref) ? await tx.queryOne(CRM.crmGet,{ id: ref.targetId }) : null;
            customers.set(number,{ customer,ref });
          }
          const customer = customers.get(number)?.customer;
          row.customerAccount = number; row.customerNumber = customer?.customerNumber || number;
          row.customerNumberBasis = customer?.customerNumber ? 'crm_customer_number' : 'trade_customer_account';
          row.customerId = customer?.id || null;
          row.customerName = customer ? [customer.firstName,customer.lastName].filter(Boolean).join(' ') || customer.companyName || '' : '';
          row.customerStatus = customer ? 'linked' : number ? 'unlinked' : 'anonymous';
        }
        bytes += Buffer.byteLength(JSON.stringify(row)); if (rows.length >= MAX_ROWS || bytes > MAX_BYTES) C.fail('IMPORT_ARTICLE_SALES_LIMIT',413);
        rows.push(row);
      }
      if (candidates.length <= BATCH) break;
      position = { afterDate: candidates[BATCH - 1].businessDate,afterId: candidates[BATCH - 1].id };
    }
    return rows;
  }
  async function search(input) {
    const started = performance.now(),s = state(),q = Model.query(input,{ today: today(),grants: s.grants });
    if (q.locationId && !s.locations.some(l => l.id === q.locationId) && !(q.locationId === 'unassigned' && s.p.unassigned)) C.fail('IMPORT_FORBIDDEN',403);
    const context = ['article-sales-result-v1',s.signature];
    for (const [id,saved] of store.entries) if (saved.expires < now() && !store.busy.has(id)) store.entries.delete(id);
    let entry,token,id;
    const response = await access.transaction(async tx => {
      const identity = await resolveArticleSalesIdentity(tx,q.articleNumber);
      const signature = protection.digest({ ...q,identity,cursor: '',resultSet: '',sort: '',direction: '',limit: 0 });
      const epoch = protection.digest(await backend.epoch(tx));
      if (q.cursor || q.resultSet) {
        try { token = protection.open(q.cursor || q.resultSet,context); entry = store.entries.get(token.id); } catch { C.fail('IMPORT_HISTORY_RESULTS_CHANGED',409); }
        if (!entry || entry.owner !== s.signature || entry.signature !== signature || entry.epoch !== epoch || token.signature !== signature || token.expires !== entry.expires || entry.expires < now()
          || q.cursor && (token.mode !== 'page' || token.sort !== q.sort || token.direction !== q.direction) || q.resultSet && !q.cursor && token.mode !== 'resultSet') C.fail('IMPORT_HISTORY_RESULTS_CHANGED',409);
        id = token.id;
      } else {
        const owned = [...store.entries].filter(([,saved]) => saved.owner === s.signature);
        while (owned.length >= 4) store.entries.delete(owned.shift()[0]);
        if (store.entries.size >= 16 || store.busy.size >= 3) C.fail('IMPORT_RECEIPT_SEARCH_BUSY',429);
        id = crypto.randomUUID(); store.busy.add(id);
        try {
          const rows = await collect(tx,s,q,identity),payload = protection.seal(rows,[...context,id]),bytes = Buffer.byteLength(payload);
          if (bytes > MAX_BYTES || [...store.entries.values()].reduce((n,e) => n + e.bytes,0) + bytes > MAX_STORE_BYTES) C.fail('IMPORT_ARTICLE_SALES_LIMIT',413);
          entry = { owner: s.signature,signature,epoch,payload,bytes,expires: now() + TTL };
          store.entries.set(id,entry);
        } finally { store.busy.delete(id); }
      }
      const rows = protection.open(entry.payload,[...context,id]); rows.sort((a,b) => Model.compare(a,b,q.sort,q.direction));
      const offset = q.cursor ? C.integer(token.offset,0,MAX_ROWS) : 0,end = offset + q.limit,more = end < rows.length;
      const seal = data => protection.seal({id,signature,expires: entry.expires,...data},context);
      return { rows: rows.slice(offset,end),total: rows.length,complete: !more,sorting: false,
        next: more ? seal({mode: 'page',offset: end,sort: q.sort,direction: q.direction}) : null,resultSet: seal({mode: 'resultSet'}) };
    },{ isolation: 'serializable',readOnly: true });
    if (state().signature !== s.signature) C.fail('IMPORT_FORBIDDEN',403);
    return { ...response,available: true,durationMs: Math.round(performance.now() - started),sourceLabel: backend.source.label,
      sourceDate: backend.source.contentDate || null,capabilities: s.grants,columns: Object.fromEntries(Model.availableColumns(s.grants).map(k => [k,Model.COLUMNS[k]])),
      note: 'Preise und Rohertrag je Stück; RE % bezogen auf den Netto-VK. Historischer Sollpreis bleibt als Quellwert gekennzeichnet, solange seine Preisbasis nicht bestätigt ist. Belege mit ungeklärter Prüfung haben keine berechneten Werte.' };
  }
  return Object.freeze({ search });
}
module.exports = { createArticleSalesWorkspace,createArticleSalesStore,MAX_ROWS };

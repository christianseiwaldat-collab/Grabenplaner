'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../lib/data-import-contract'), H = require('../lib/tradefoto-history-profiles');
const R = require('../lib/tradefoto-sales-rules'), M = require('../lib/sales-report-model');
const { CASH_SOURCE_POLICIES, resolveCashSalesPolicy } = require('../lib/cash-source-policies');
const { reportMarginPolicyFor } = require('../lib/sales-report-margin');
const scope = { scopeId: 'synthetic-review', sourceInstance: 'cash-review' };
const raw = (name, data) => ({ ...Object.fromEntries(H.tableFor('cash', name).columns.map(c => [c.name, null])), ...data });
const key = { Bonnr: '1', Bondatum: '2026-08-01T00:00:00.000', Filialid: '18', Kassenid: '0' };
const flags = Object.fromEntries(R.STATUS_FIELDS.map(k => [k, false]));
const head = amount => raw('Umsatz_KASSE', { ...key, RechnungsBetrag: amount });
const line = (id, extra = {}) => raw('Umsatz_Kasse_Details', { ...key, ...flags,
  RepID: '00000000-0000-0000-0000-' + String(id).padStart(12, '0'), VKMenge: '1', VK_Preis: '120', MWST: '20',
  Sortiment: 130, UMarke: 'Sony', RohertragDM: '20', ...extra });
const original = extra => R.defineTradeFotoSalesPolicy({ ...CASH_SOURCE_POLICIES[0].policy, ...scope, ...extra });
const policy = () => resolveCashSalesPolicy(original());
function coverage(h, rows) { return R.defineTradeFotoReceiptCoverage({ ...scope, fileSha256: '1'.repeat(64), schemaSha256: H.profileFor('cash', 'Umsatz_KASSE').schemaSha256,
  evidenceSha256: '2'.repeat(64), expectedSourceRows: rows.length, verifiedSourceRows: rows.length, head: h, lines: rows }); }
function reconcile(h, rows, options = {}) { return R.reconcileTradeFotoReceipt({ ...scope, head: h,
  lines: rows.map(source => ({ source, parentRevision: 1 })), headRevision: 1, snapshotDate: '2026-09-10',
  policy: policy(), coverage: coverage(h, rows), ...options }); }
const query = { productGroupIds: [], manufacturerIds: [], sellerIds: [], groupBy: ['productGroup'],
  metrics: ['grossRevenue', 'netRevenue', 'grossMargin', 'quantity', 'receiptCount', 'customerCount'] };
function report(rows, result) {
  const state = M.accumulator();
  for (const f of rows) M.accumulate(state, 'current', query, { metric: result.positions.find(p => p.key === f.RepID),
    quantity: f.VKMenge, margin: M.positionMargin(f.RohertragDM, f.VKMenge), receiptKey: 'one-receipt', customerKey: 'one-customer',
    productGroup: { id: String(f.Sortiment), label: String(f.Sortiment) } });
  return M.finishReport(state, query);
}

test('structured net invoices survive changed import evidence, row IDs and descriptions without approving ordinary tills', () => {
  const h = { ...head('100'), RechnungsNr: '70001' }, rows = [line(1, { RechnungsNr: 70001 })];
  const first = reconcile(h, rows); assert.equal(first.canAggregate, true);
  assert.equal(first.reconciliation.headerStatus, 'checked_invoice_convention'); assert.equal(first.totals.net, '100.00');
  const replacement = [{ ...rows[0], RepID: line(99).RepID, Artikelbezeichnung: 'Updated source text' }];
  const renewed = R.defineTradeFotoReceiptCoverage({ ...scope, fileSha256: '3'.repeat(64), evidenceSha256: '4'.repeat(64),
    schemaSha256: H.profileFor('cash', 'Umsatz_KASSE').schemaSha256, expectedSourceRows: 200, verifiedSourceRows: 200, head: h, lines: replacement });
  const next = reconcile(h, replacement, { coverage: renewed });
  assert.equal(next.canAggregate, true); assert.deepEqual(next.totals, first.totals);
  for (const [changedHead, changedRows] of [
    [{ ...h, RechnungsNr: '0' }, rows], [{ ...h, Kassenid: '1' }, rows.map(r => ({ ...r, Kassenid: '1' }))],
    [h, rows.map(r => ({ ...r, RechnungsNr: 70002 }))], [h, rows.map(r => ({ ...r, Beratung: true }))],
    [{ ...h, RechnungsBetrag: '100.01' }, rows], [h, rows.map(r => ({ ...r, VK_Preis: '121' }))]
  ]) assert.equal(reconcile(changedHead, changedRows).canAggregate, false);
  assert.equal(reconcile(h, rows, { coverage: null }).canAggregate, false);
  assert.equal(reconcile(h, rows, { coverage: coverage(h, replacement) }).canAggregate, false);
});
test('invoice VAT-group rounding preserves positions and rejects a one-cent error with mixed rates', () => {
  const h = { ...head('0.12'), RechnungsNr: '70002' };
  const rows = [line(1, { VK_Preis: '0.03' }), line(2, { VK_Preis: '0.03' }), line(3, { VK_Preis: '0.04', MWST: '10' }),
    line(4, { VK_Preis: '0.04', MWST: '10' })].map(r => ({ ...r, RechnungsNr: 70002 }));
  const result = reconcile(h, rows); assert.equal(result.canAggregate, true);
  assert.equal(result.reconciliation.rounding, 'vat_total'); assert.equal(result.totals.net, '0.14');
  assert.equal(reconcile({ ...h, RechnungsBetrag: '0.11' }, rows).canAggregate, false);
  const mixed = rows.map((r, i) => i ? r : { ...r, RechnungsNr: 70003 });
  assert.equal(reconcile(h, mixed).canAggregate, false);
});
test('Access Single source totals reconcile by exact stored representation without cent tolerance or changed metrics', () => {
  for (const sample of [
    { amount: 406.275, price: '487.53', qty: '1', gross: '487.53', net: '406.28', basis: 'net' },
    { amount: 373.905, price: '149.562', qty: '2.5', gross: '373.91', net: '311.59', basis: 'gross' },
    { amount: 67025.83333333333, price: '80431', qty: '1', gross: '80431.00', net: '67025.83', basis: 'net' }
  ]) {
    const h = { ...head(String(Math.fround(sample.amount))), RechnungsNr: '70003' };
    const rows = [line(1, { RechnungsNr: 70003, VK_Preis: sample.price, VKMenge: sample.qty })], before = C.canonical([h, rows]);
    const result = reconcile(h, rows); assert.equal(result.canAggregate, true);
    assert.equal(result.reconciliation.rounding, 'source_single_total'); assert.equal(result.reconciliation.headerBasis, sample.basis);
    assert.equal(result.reconciliation.toleranceMinor, 0); assert.equal(result.reconciliation.difference, '0.00');
    assert.equal(result.totals.gross, sample.gross); assert.equal(result.totals.net, sample.net);
    assert.equal(C.canonical([h, rows]), before);
    const rounded = Number(h.RechnungsBetrag).toFixed(2);
    assert.equal(reconcile({ ...h, RechnungsBetrag: String(Number(rounded) + 0.02) }, rows).canAggregate, false);
  }
  const h = { ...head('406.27'), RechnungsNr: '70003' }, rows = [line(1, { RechnungsNr: 70003, VK_Preis: '487.53' })];
  assert.equal(reconcile(h, rows).canAggregate, false, 'an ordinary wrong cent value is not the exact source Single');
});

test('corroborated exact half-cent net invoice uses half-even Single head without altering position rounding', () => {
  for (const sign of [1, -1]) {
    const h = { ...head(String(Math.fround(sign * 240.72))), RechnungsNr: '70005' };
    const rows = [line(1, { VK_Preis: '19.99', VKMenge: String(sign * 10) }), line(2, { VK_Preis: '21.99', VKMenge: String(sign) }),
      line(3, { VK_Preis: '21.99', VKMenge: String(sign) }), line(4, { VK_Preis: '44.99', VKMenge: String(sign) })].map(r => ({ ...r, RechnungsNr: 70005 }));
    const checked = reconcile(h, rows);
    assert.equal(checked.canAggregate, true); assert.equal(checked.reconciliation.rounding, 'source_single_half_even_net_tie');
    assert.equal(checked.reconciliation.toleranceMinor, 0); assert.equal(checked.totals.net, sign === 1 ? '240.73' : '-240.73');
    assert.equal(reconcile({ ...h, RechnungsBetrag: String(Math.fround(sign * 240.71)) }, rows).canAggregate, false);
    assert.equal(reconcile(h, rows.map((r,i) => i ? r : { ...r, VK_Preis: '20.00' })).canAggregate, false);
  }
});

test('invoice unit-net rounding matches exact stored heads without changing booked prices or accepting nearby cents', () => {
  for(const sample of [
    {head:-71.40,bad:-71.41,price:'16.99',qty:'-5',vat:'19',net:'-71.39',method:'source_single_unit_net_2'},
    {head:-133.16,bad:-133.15,price:'79.90',qty:'-2',vat:'20',net:'-133.17',method:'source_single_unit_net_2'}
  ]) {
    const h={...head(String(Math.fround(sample.head))),RechnungsNr:'70006'},rows=[line(1,{RechnungsNr:70006,VK_Preis:sample.price,VKMenge:sample.qty,MWST:sample.vat})];
    const checked=reconcile(h,rows);assert.equal(checked.canAggregate,true);assert.equal(checked.totals.net,sample.net);
    assert.equal(checked.reconciliation.rounding,sample.method);assert.equal(checked.reconciliation.toleranceMinor,0);
    assert.equal(reconcile({...h,RechnungsBetrag:String(Math.fround(sample.bad))},rows).canAggregate,false);
  }
  const h={...head(String(Math.fround(97.22196))),RechnungsNr:'70007'},rows=[line(1,{RechnungsNr:70007,VK_Preis:'0.49',VKMenge:'76'}),line(2,{RechnungsNr:70007,VK_Preis:'39.99',VKMenge:'1.5'})];
  const checked=reconcile(h,rows);assert.equal(checked.canAggregate,true);assert.equal(checked.reconciliation.rounding,'source_single_gross_from_net_4');
  assert.equal(checked.totals.gross,'97.23');assert.equal(checked.totals.net,'81.02');
  assert.equal(reconcile({...h,RechnungsBetrag:'97.22'},rows).canAggregate,false,'an ordinary wrong cent value is not the exact source float');
  const changed=rows.map((r,i)=>i?r:{...r,RechnungsNr:70008});
  const wrongReference=reconcile({...h,RechnungsBetrag:'97.23'},changed);
  assert.equal(wrongReference.canAggregate,false);assert.ok(wrongReference.issues.includes('RECEIPT_INVOICE_REFERENCE_MISMATCH'));
  const technicalHead={...head('0'),RechnungsNr:'1'};
  const technicalRows=[line(1,{RechnungsNr:-1,VK_Preis:'0'})];
  assert.equal(reconcile(technicalHead,technicalRows).canAggregate,true,'a negative source sentinel is not a different positive invoice reference');
  const mixedHead={...head(String(Math.fround(142.84))),RechnungsNr:'70008'};
  const mixed=[line(1,{RechnungsNr:70008,VK_Preis:'16.99',VKMenge:'3',MWST:'19'}),
    line(2,{RechnungsNr:70008,EAN:'0000000000095',Sortiment:170101,MWST:'0',VK_Preis:'50',VKMenge:'2'})];
  const withVoucher=reconcile(mixedHead,mixed);assert.equal(withVoucher.canAggregate,true);
  assert.equal(withVoucher.totals.net,'42.83');assert.equal(withVoucher.reconciliation.positionRoundingDifference,'-0.01');
});
test('a voucher invoice checks its nominal amount while all goods metrics remain zero, including cancellation', () => {
  for (const sign of [1, -1]) {
    const h = { ...head(String(sign * 2500)), RechnungsNr: '70004' }, rows = [line(1, { RechnungsNr: 70004,
      Sortiment: 170101, MWST: '0', VKMenge: String(sign * 25), VK_Preis: '100', RohertragDM: '999' })];
    const checked = reconcile(h, rows); assert.equal(checked.canAggregate, true);
    assert.equal(checked.reconciliation.headerStatus, 'checked_invoice_voucher_amount');
    const totals = report(rows, checked).total.metrics;
    for (const metric of ['netRevenue', 'grossRevenue', 'grossMargin', 'receiptCount']) assert.equal(Number(totals[metric].current), 0);
    assert.equal(reconcile({ ...h, RechnungsBetrag: String(sign * 2500 + 1) }, rows).canAggregate, false);
  }
});
test('signed discounts are adjustments across source flag variants and never authorise a negative goods price', () => {
  for (const Sortiment of [170201, 170301, 170302]) for (const AStorno of [false, true]) for (const SonderartikelS of [false, true]) {
    for (const sign of [1, -1]) {
      const rows = [line(1, { Sortiment, AStorno, SonderartikelS, VK_Preis: '-12', VKMenge: String(sign), RohertragDM: '-10' })];
      const result = reconcile(head(String(sign * -12)), rows); assert.equal(result.canAggregate, true);
      assert.equal(result.positions[0].status, 'adjustment'); assert.equal(report(rows, result).total.metrics.quantity.current, '0.000000');
      assert.equal(report(rows, result).total.metrics.grossMargin.current, sign === 1 ? '-10.00' : '10.00');
    }
  }
  const bad = reconcile(head('-12'), [line(1, { VK_Preis: '-12' })]); assert.ok(bad.issues.includes('NEGATIVE_UNIT_PRICE_REVIEW'));
  const { fingerprint, ...definition } = policy();
  assert.throws(() => R.defineTradeFotoSalesPolicy({ ...definition, invoiceHeaderConvention: 'any_net_match' }));
  assert.throws(() => R.defineTradeFotoSalesPolicy({ ...definition, headerToleranceMinor: 1 }));
  const rule = definition.statusRules.find(r => r.status === 'sale');
  assert.throws(() => R.defineTradeFotoSalesPolicy({ ...definition, statusRules: [{ ...rule, signedAdjustmentPrice: true }] }));
});
test('effective cash rules preserve the sealed source contract and unrelated policies', () => {
  const old = original(), before = C.canonical(old), current = resolveCashSalesPolicy(old);
  assert.equal(C.canonical(old), before); assert.equal(old.version, 1); assert.equal(current.version, 20);
  assert.equal(current.id, 'cash-confirmed-20260911');
  assert.notEqual(current.fingerprint, old.fingerprint);
  assert.equal(resolveCashSalesPolicy(current), current);
  const custom = original({ headerToleranceMinor: 1 }); assert.equal(resolveCashSalesPolicy(custom), custom);
  assert.equal(reportMarginPolicyFor(old), reportMarginPolicyFor(current));
});

test('confirmed insurance and phone credit keep full booked value and historical margin across later imports and returns', () => {
  for (const sample of [
    { group: 110901, article: '0000000081711', price: '189', margin: '47.25', special: true },
    { group: 110901, article: '0000000077284', price: '189', margin: '47.25', special: false },
    { group: 80501, article: '0000000057659', price: '10', margin: '0.70', special: false }
  ]) for (const sign of [1, -1]) {
    const h = head('0'), rows = [line(1, { Sortiment: sample.group, EAN: sample.article, MWST: '0',
      SonderartikelS: sample.special, VKMenge: String(sign * 2), VK_Preis: sample.price, RohertragDM: sample.margin })];
    const before = C.canonical([h, rows]), result = reconcile(h, rows);
    assert.equal(result.canAggregate, true); assert.equal(Number(result.totals.net), sign * 2 * Number(sample.price));
    assert.equal(result.positions[0].status, sign > 0 ? 'sale' : 'return');
    const total = report(rows, result).total.metrics;
    assert.equal(Number(total.grossMargin.current), sign * 2 * Number(sample.margin));
    assert.equal(Number(total.quantity.current), sign * 2);
    const replacement = [{ ...rows[0], RepID: line(90).RepID, Artikelbezeichnung: 'Changed import description' }];
    const proof = R.defineTradeFotoReceiptCoverage({ ...scope, fileSha256: '5'.repeat(64), evidenceSha256: '6'.repeat(64),
      schemaSha256: H.profileFor('cash', 'Umsatz_KASSE').schemaSha256, expectedSourceRows: 5000, verifiedSourceRows: 5000, head: h, lines: replacement });
    const later = reconcile(h, replacement, { coverage: proof });
    assert.equal(later.canAggregate, true); assert.deepEqual(later.totals, result.totals);
    assert.equal(C.canonical([h, rows]), before);
    assert.equal(reconcile(h, [{ ...rows[0], Beratung: true }]).canAggregate, false);
    assert.equal(reconcile(h, [{ ...rows[0], MWST: '99' }]).canAggregate, false);
  }
  const paidUnknown = reconcile(head('0'), [line(1, { MWST: '0', Sortiment: 999999 })]);
  assert.equal(paidUnknown.canAggregate, false, 'the confirmed families do not approve unrelated zero-tax goods');
});

test('confirmed income and outstanding-credit accounts count as signed revenue without goods quantity across recognised flags', () => {
  for (const EAN of ['0000000904800', '0000000902761']) for (const AStorno of [false, true]) for (const SonderartikelS of [false, true]) for (const sign of [1, -1]) {
    const rows = [line(1, { EAN, Sortiment: 999999, VK_Preis: '120', VKMenge: String(sign), AStorno, SonderartikelS, RohertragDM: '12.50' })];
    const result = reconcile(head(String(sign * 120)), rows), totals = report(rows, result).total.metrics;
    assert.equal(result.canAggregate, true); assert.equal(result.positions[0].status, 'adjustment');
    assert.equal(totals.netRevenue.current, sign === 1 ? '100.00' : '-100.00');
    assert.equal(totals.grossMargin.current, sign === 1 ? '12.50' : '-12.50'); assert.equal(totals.quantity.current, '0.000000');
    assert.equal(reconcile(head('0'), [{ ...rows[0], Beratung: true }]).canAggregate, false);
    const replacement = [{ ...rows[0], RepID: line(99).RepID, Artikelbezeichnung: 'Source description changed' }];
    assert.deepEqual(reconcile(head(String(sign * 120)), replacement).totals, result.totals);
  }
  assert.equal(reconcile(head('0'), [line(1, { EAN: '0000000904801', Sortiment: 999999, SonderartikelS: true })]).canAggregate, false);
});

test('user-confirmed rental security is signed booked revenue, not goods quantity, and never guesses a missing margin', () => {
  for (const sign of [1,-1]) for (const SonderartikelS of [false,true]) for (const MWST of ['0','20']) {
    const h = head(String(sign * 1100)), rows = [line(1, { EAN: '0000000106582', Sortiment: 110401,
      VKMenge: String(sign), VK_Preis: '1100', MWST, SonderartikelS, RohertragDM: '0' })];
    const checked = reconcile(h,rows), totals = report(rows,checked).total.metrics;
    assert.equal(checked.canAggregate,true);assert.equal(checked.totals.gross,sign > 0 ? '1100.00' : '-1100.00');
    assert.equal(totals.quantity.current,'0.000000');assert.equal(totals.grossMargin.current,'0.00');
    const missing = [{...rows[0],RohertragDM:null}], result = reconcile(h,missing);
    assert.equal(result.canAggregate,true);assert.equal(report(missing,result).total.metrics.grossMargin.current,null);
  }
});

test('ordinary free trade article follows signed sales while known interim-payment identities remain guarded', () => {
  for (const sign of [1,-1]) {
    const h = head('0'), rows = [line(1,{EAN:'0000000106030',Sortiment:170102,SonderartikelS:true,VKMenge:String(sign),VK_Preis:'120',RohertragDM:'15'})];
    const checked = reconcile(h,rows), total = report(rows,checked).total.metrics;
    assert.equal(checked.canAggregate,true);assert.equal(checked.positions[0].status,sign > 0 ? 'sale' : 'return');
    assert.equal(total.netRevenue.current,sign > 0 ? '100.00' : '-100.00');assert.equal(total.grossMargin.current,sign > 0 ? '15.00' : '-15.00');
    const {fingerprint,...definition}=policy(), key=R.receiptKeyFingerprint(h);
    const guarded=R.defineTradeFotoSalesPolicy({...definition,statusRules:definition.statusRules.map(r=>r.id.startsWith('confirmed-ordinary-trade-goods-')?{...r,exceptReceiptKeys:[key]}:r)});
    assert.equal(reconcile(h,rows,{policy:guarded}).canAggregate,false);
    assert.equal(reconcile(h,rows.map(r=>({...r,RepID:line(99).RepID,Artikelbezeichnung:'New text',VK_Preis:'121'})),{policy:guarded}).canAggregate,false);
  }
});

test('Printcenter generates ordinary revenue and historical margin at the cash posting, including reversal and later import', () => {
  for(const sign of [1,-1]) {
    const h=head('0'),rows=[line(1,{EAN:'0000000078711',Sortiment:999999,SonderartikelS:true,VKMenge:String(sign*2),VK_Preis:'3.60',RohertragDM:'0.80'})];
    const checked=reconcile(h,rows),total=report(rows,checked).total.metrics;
    assert.equal(checked.canAggregate,true);assert.equal(total.netRevenue.current,sign>0?'6.00':'-6.00');
    assert.equal(total.grossMargin.current,sign>0?'1.60':'-1.60');assert.equal(Number(total.quantity.current),sign*2);
    const changed=rows.map(r=>({...r,RepID:line(99).RepID,Artikelbezeichnung:'Changed print order text'}));
    assert.deepEqual(reconcile(h,changed).totals,checked.totals);
    assert.equal(reconcile(h,changed.map(r=>({...r,Beratung:true}))).canAggregate,false);
  }
});

test('free own service voucher issuance is not a sales receipt; a mixed goods receipt is counted once', () => {
  const voucher=line(1,{EAN:'0000000102865',Sortiment:170302,MWST:'0',VK_Preis:'0',RohertragDM:'20'});
  const issued=reconcile(head('0'),[voucher]);assert.equal(issued.canAggregate,true);assert.equal(issued.positions[0].status,'voucher_issue');
  const alone=report([voucher],issued).total.metrics;
  for(const id of ['grossRevenue','netRevenue','grossMargin','receiptCount','customerCount','quantity'])assert.equal(Number(alone[id].current),0);
  const mixed=[voucher,line(2)],sold=reconcile(head('120'),mixed),totals=report(mixed,sold).total.metrics;
  assert.equal(sold.canAggregate,true);assert.equal(totals.netRevenue.current,'100.00');assert.equal(totals.receiptCount.current,'1');
  assert.equal(totals.grossMargin.current,'20.00');assert.equal(totals.quantity.current,'1.000000');
});

test('confirmed trade-in payout reduces revenue without sold quantity and preserves distinct UID clearing', () => {
  for(const sign of [1,-1]) {
    const h=head(String(sign*650)),rows=[line(1,{EAN:'0000000058204',Sortiment:170102,SonderartikelS:true,VKMenge:String(sign),VK_Preis:'650',MWST:'0',RohertragDM:'0'})];
    const checked=reconcile(h,rows),total=report(rows,checked).total.metrics;
    assert.equal(checked.canAggregate,true);assert.equal(checked.positions[0].status,'adjustment');
    assert.equal(total.netRevenue.current,sign>0?'650.00':'-650.00');assert.equal(total.quantity.current,'0.000000');
    assert.equal(total.grossMargin.current,'0.00');
    const uid=rows.map(r=>({...r,AStorno:true}));const cleared=reconcile(head('0'),uid);
    assert.equal(cleared.canAggregate,true);assert.equal(cleared.positions[0].status,'uid_clearing');assert.equal(cleared.totals.net,'0.00');
  }
});

test('recorded zero VAT on a complete referenced invoice keeps source prices and still requires the exact head amount', () => {
  const h = { ...head('60'), RechnungsNr: '71000' };
  const rows = [line(1, { RechnungsNr: 71000, VK_Preis: '60', MWST: '0' })];
  const checked = reconcile(h, rows);
  assert.equal(checked.canAggregate, true); assert.equal(checked.totals.net, '60.00'); assert.equal(checked.totals.tax, '0.00');
  for (const [alteredHead, alteredRows] of [
    [{ ...h, RechnungsBetrag: '60.01' }, rows], [{ ...h, RechnungsBetrag: '0' }, rows],
    [{ ...h, Kassenid: '1' }, rows.map(r => ({ ...r, Kassenid: '1' }))],
    [h, rows.map(r => ({ ...r, RechnungsNr: 71001 }))], [h, rows.map(r => ({ ...r, VK_Preis: '61' }))]
  ]) assert.equal(reconcile(alteredHead, alteredRows).canAggregate, false);
  const { fingerprint, ...definition } = policy();
  assert.throws(() => R.defineTradeFotoSalesPolicy({ ...definition, invoiceZeroVatMeaning: 'guess_exemption' }));
});

test('financial evidence survives GUID and description changes but not changed finances, source membership or customer context', () => {
  const h = head('100'), rows = [line(1)], fingerprint = R.receiptFinancialFingerprint(h, rows);
  const { fingerprint: ignored, ...definition } = policy();
  const trusted = R.defineTradeFotoSalesPolicy({ ...definition, headerBasisOverrides: [{ receiptFingerprint: '0'.repeat(64), receiptFinancialFingerprint: fingerprint, basis: 'net' }] });
  assert.equal(reconcile(h, rows, { policy: trusted }).canAggregate, true);
  const changed = [{ ...rows[0], RepID: line(98).RepID, Artikelbezeichnung: 'New import label' }];
  assert.equal(R.receiptFinancialFingerprint(h, changed), fingerprint);
  assert.equal(reconcile(h, changed, { policy: trusted }).canAggregate, true);
  assert.equal(reconcile(h, changed, { policy: trusted, coverage: coverage(h, rows) }).canAggregate, false);
  for (const alteration of [{ VKMenge: '2' }, { VK_Preis: '121' }, { MWST: '19' }, { RohertragDM: '21' }, { Sortiment: 131 }, { Beratung: true }]) {
    const altered = [{ ...rows[0], ...alteration }];
    assert.notEqual(R.receiptFinancialFingerprint(h, altered), fingerprint);
    assert.equal(reconcile(h, altered, { policy: trusted }).canAggregate, false);
  }
  assert.notEqual(R.receiptFinancialFingerprint({ ...h, KUND_NR: 'new-customer' }, rows), fingerprint);
  assert.notEqual(R.receiptFinancialFingerprint(h, [...rows, line(2)]), fingerprint);
});

test('confirmed tax code ten supports free and paid books while unknown tax codes remain open', () => {
  const h = head('120'), rows = [line(1), line(2, { VK_Preis: '0', MWST: '10', Sortiment: 50901, RohertragDM: '0' })];
  const result = reconcile(h, rows);
  assert.equal(result.canAggregate, true); assert.equal(result.positions[1].gross, '0.00'); assert.equal(result.positions[1].net, '0.00');
  assert.equal(result.totals.gross, '120.00'); assert.equal(report(rows, result).total.metrics.grossMargin.current, '20.00');
  const paid = [rows[0], { ...rows[1], VK_Preis: '11', VKMenge: '2', RohertragDM: '1' }];
  const checked = reconcile(head('142'), paid);
  assert.equal(checked.canAggregate, true); assert.equal(checked.positions[1].gross, '22.00');
  assert.equal(checked.positions[1].net, '20.00'); assert.equal(checked.positions[1].tax, '2.00');
  assert.equal(report(paid, checked).total.metrics.grossMargin.current, '22.00');
  const invalid = reconcile(h, [rows[0], { ...rows[1], MWST: '99' }]);
  assert.equal(invalid.canAggregate, false); assert.ok(invalid.issues.includes('VAT_CODE_UNKNOWN'));
});

test('separate manufacturer discounts and their reversal reconcile while keeping item margin and goods quantity', () => {
  for (const sign of [1, -1]) {
    const rows = [line(1, { VKMenge: String(sign), VK_Preis: '1369', RohertragDM: '137.94907831964053' }),
      line(2, { VKMenge: String(-sign), VK_Preis: '95.82', Sortiment: 170201, UMarke: 'Separate discount', SonderartikelS: true, RohertragDM: '0' })];
    const result = reconcile(head(String(sign * 1273.18)), rows), totals = report(rows, result);
    assert.equal(result.canAggregate, true); assert.equal(result.positions[1].status, 'adjustment');
    assert.equal(result.counts.adjustments, 1); assert.equal(totals.total.metrics.quantity.current, sign === 1 ? '1.000000' : '-1.000000');
    assert.equal(totals.total.metrics.grossMargin.current, sign === 1 ? '137.95' : '-137.95');
    assert.equal(totals.rows.find(r => r.dimensions[0].id === '130').metrics.netRevenue.current, sign === 1 ? '1140.83' : '-1140.83');
    assert.equal(totals.rows.find(r => r.dimensions[0].id === '170201').metrics.netRevenue.current, sign === 1 ? '-79.85' : '79.85');
    const unknown = reconcile(head('0'), [rows[0], { ...rows[1], Sortiment: 999 }]);
    assert.equal(unknown.canAggregate, false); assert.ok(unknown.issues.includes('STATUS_REVIEW_REQUIRED'));
  }
});

test('voucher redemption is payment and does not reduce goods revenue, cash margin or sellable quantity', () => {
  const rows = [line(1, { VK_Preis: '600', RohertragDM: '100' }), line(2, { VKMenge: '-4', VK_Preis: '100', MWST: '0',
    AStorno: true, Sortiment: 170101, RohertragDM: '0' })];
  const result = reconcile(head('0'), rows), totals = report(rows, result);
  assert.equal(result.canAggregate, true); assert.equal(result.positions[1].status, 'payment'); assert.equal(result.counts.payments, 1);
  assert.equal(result.totals.gross, '600.00'); assert.equal(result.totals.net, '500.00');
  for (const [key, expected] of Object.entries({ netRevenue: '500.00', grossMargin: '100.00', quantity: '1.000000', receiptCount: '1', customerCount: '1' })) {
    assert.equal(totals.total.metrics[key].current, expected);
  }
  const paymentOnly = report([rows[1]], reconcile(head('0'), [rows[1]]));
  for (const metric of ['grossMargin', 'netRevenue', 'receiptCount', 'customerCount']) assert.equal(Number(paymentOnly.total.metrics[metric].current), 0);
  const changed = reconcile(head('0'), [rows[0], { ...rows[1], Sortiment: 170102 }]);
  assert.equal(changed.canAggregate, false, 'an unconfirmed advance-payment group is not inferred from voucher rules');
});

test('article 98 adds or subtracts revenue without goods quantity or margin in every confirmed flag combination', () => {
  for (const AStorno of [false, true]) for (const SonderartikelS of [false, true]) for (const sign of [1, -1]) {
    for (const RohertragDM of [null, '0', '999.99']) {
      const rows = [line(1, { EAN: '0000000000098', Sortiment: 170102, AStorno, SonderartikelS,
        VKMenge: String(sign * 2), VK_Preis: '150', RohertragDM })];
      const before = C.canonical(rows), checked = reconcile(head(String(sign * 300)), rows), totals = report(rows, checked);
      assert.equal(checked.canAggregate, true); assert.equal(checked.counts.deposits, 1); assert.equal(checked.counts.sales, 0);
      assert.equal(checked.positions[0].status, 'deposit'); assert.equal(checked.totals.gross, sign === 1 ? '300.00' : '-300.00');
      assert.equal(checked.totals.net, sign === 1 ? '250.00' : '-250.00');
      for (const [metric, expected] of Object.entries({ grossMargin: '0.00', quantity: '0.000000', receiptCount: '1', customerCount: '1' })) {
        assert.equal(totals.total.metrics[metric].current, expected, metric);
      }
      assert.equal(totals.coverage.current.marginMissing, 0); assert.equal(totals.coverage.current.excluded, 0);
      assert.equal(C.canonical(rows), before);
    }
  }
});

test('deposit redemption reconciles a mixed camera receipt and retains each original cash margin', () => {
  const rows = [
    line(1, { EAN: '0000000100792', Sortiment: 10102, VK_Preis: '1449', RohertragDM: '255.60308102607814' }),
    line(2, { VK_Preis: '749', RohertragDM: '133.31994202761456' }),
    line(3, { VK_Preis: '0', RohertragDM: '-10.684334824346319' }),
    line(4, { EAN: '0000000084461', Sortiment: 50301, VK_Preis: '79.90', RohertragDM: '38.58876699393196' }),
    line(5, { VK_Preis: '29.99', RohertragDM: '13.639666669362756' }),
    line(6, { Sortiment: 170101, MWST: '0', VK_Preis: '0', RohertragDM: null }),
    line(7, { EAN: '0000000000098', Sortiment: 170102, SonderartikelS: true, VKMenge: '-1', VK_Preis: '300', RohertragDM: null })
  ];
  const h = head('2007.8900146484375'), checked = reconcile(h, rows), totals = report(rows, checked);
  assert.equal(checked.canAggregate, true); assert.deepEqual(checked.issues, []); assert.equal(checked.reconciliation.difference, '0.00');
  assert.equal(checked.totals.gross, '2007.89'); assert.equal(checked.totals.net, '1673.24');
  assert.equal(totals.total.metrics.grossMargin.current, '430.47'); assert.equal(totals.total.metrics.quantity.current, '5.000000');
  const byGroup = id => totals.rows.find(r => r.dimensions[0].id === id);
  assert.equal(byGroup('10102').metrics.grossMargin.current, '255.60');
  assert.equal(byGroup('50301').metrics.grossMargin.current, '38.59');
  assert.equal(byGroup('170102').metrics.grossRevenue.current, '-300.00'); assert.equal(byGroup('170102').metrics.grossMargin.current, '0.00');
  const noCoverage = reconcile(h, rows, { coverage: null }); assert.equal(noCoverage.canAggregate, false);
  const wrongHead = reconcile(head('2307.89'), rows); assert.equal(wrongHead.canAggregate, false); assert.ok(wrongHead.issues.includes('RECEIPT_AMOUNT_MISMATCH'));
});

test('deposit confirmation does not classify another article, tax code or unconfirmed status as a deposit', () => {
  const deposit = line(1, { EAN: '0000000000098', Sortiment: 170102, VK_Preis: '300', SonderartikelS: true });
  for (const extra of [{ EAN: '0000000000099' }, { Sortiment: 999 }, { MWST: '0' }, { MWST: '10' }, { Ret: true },
    { BStorno: true }, { R: true }, { N: true }, { ZR: true }, { set: true }, { Beratung: true }, { VKMenge: '0' }, { VK_Preis: '-300' }]) {
    const checked = reconcile(head('300'), [{ ...deposit, ...extra }]);
    assert.equal(checked.canAggregate, false, JSON.stringify(extra)); assert.equal(checked.positions, null);
  }
  const generic = reconcile(head('300'), [{ ...deposit, EAN: '0000000000099', SonderartikelS: false }]);
  assert.equal(generic.positions[0].status, 'sale');
  const { fingerprint, ...current } = policy();
  const previous = R.defineTradeFotoSalesPolicy({ ...current, version: 8, statusRules: current.statusRules.filter(r => r.status !== 'deposit') });
  const oldResult = reconcile(head('300'), [deposit], { policy: previous });
  assert.equal(oldResult.canAggregate, false); assert.ok(oldResult.issues.includes('STATUS_REVIEW_REQUIRED'));
});

test('voucher issuance retains its source value while all goods metrics and cash margin stay zero', () => {
  for (const unitMargin of [null, '0', '999.99']) {
    const rows = [line(1, { EAN: '0000000000094', VKMenge: '2', VK_Preis: '10', MWST: '0', Sortiment: 170101,
      RohertragDM: unitMargin, KalkRohertrag: '1999.98', DEK_A: null })], h = head('0'), before = C.canonical([h, rows]);
    const result = reconcile(h, rows), totals = report(rows, result);
    assert.equal(result.canAggregate, true); assert.equal(result.counts.voucherIssues, 1);
    assert.equal(result.counts.sales, 0); assert.equal(result.counts.review, 0);
    assert.deepEqual(result.positions, [{ key: rows[0].RepID, status: 'voucher_issue', gross: '0.00', net: '0.00', tax: '0.00' }]);
    for (const [metric, expected] of Object.entries({ grossRevenue: '0.00', netRevenue: '0.00', grossMargin: '0.00',
      quantity: '0.000000', receiptCount: '0', customerCount: '0' })) assert.equal(totals.total.metrics[metric].current, expected, metric);
    assert.equal(totals.coverage.current.excluded, 1); assert.equal(totals.coverage.current.marginMissing, 0);
    assert.equal(C.canonical([h, rows]), before, 'stored value and source margin remain untouched');
    assert.equal(reconcile(h, rows, { coverage: null }).canAggregate, false);
    assert.equal(reconcile(head('20'), rows).canAggregate, false, 'unconfirmed nonzero heads still require reconciliation');
  }
});

test('voucher issuance and cancellation require the confirmed group, tax code and flags together', () => {
  const issue = line(1, { VKMenge: '2', VK_Preis: '10', MWST: '0', Sortiment: 170101, RohertragDM: '0' });
  for (const extra of [{ Sortiment: 170102 }, { Sortiment: 130101 }, { MWST: '99' }, { SonderartikelS: true },
    { Ret: true }, { VKMenge: '0' }]) {
    const result = reconcile(head('0'), [{ ...issue, ...extra }]);
    assert.equal(result.canAggregate, false); assert.equal(result.positions, null); assert.equal(result.totals, null);
  }
  const cancelled = reconcile(head('0'), [{ ...issue, VKMenge: '-2' }]);
  assert.equal(cancelled.canAggregate, true); assert.equal(cancelled.positions[0].status, 'voucher_issue');
  assert.equal(report([{ ...issue, VKMenge: '-2' }], cancelled).total.metrics.netRevenue.current, '0.00');
  for (const Sortiment of [170101, 130101]) {
    const unchanged = reconcile(head('20'), [{ ...issue, Sortiment, MWST: '20' }]);
    assert.equal(unchanged.canAggregate, true); assert.equal(unchanged.positions[0].status, 'sale');
    assert.equal(unchanged.totals.gross, '20.00', 'the exception does not remove unrelated confirmed sales');
  }
  const negativePrice = reconcile(head('0'), [{ ...issue, VK_Preis: '-10' }]);
  assert.deepEqual(negativePrice.issues, ['NEGATIVE_UNIT_PRICE_REVIEW']); assert.equal(negativePrice.canAggregate, false);
});

test('bounded status-rule exceptions reject malformed filters and do not introduce first-match precedence', () => {
  const { fingerprint, ...definition } = policy(), rule = definition.statusRules.find(r => r.id === 'confirmed-example-3');
  for (const except of [[], [{}], [{ productGroups: undefined }], [{ flags }], [{ productGroups: [] }],
    [{ productGroups: ['170101', '170101'] }], [{ vatCodes: [0] }], [{ articleNumbers: ['x'.repeat(33)] }],
    Array.from({ length: 11 }, () => ({ vatCodes: ['0'] }))]) {
    assert.throws(() => R.defineTradeFotoSalesPolicy({ ...definition, statusRules: [{ ...rule, except }] }), e => e instanceof C.DataImportError);
  }
  const { except, ...withoutException } = rule;
  const ambiguous = R.defineTradeFotoSalesPolicy({ ...definition,
    statusRules: definition.statusRules.map(r => r.id === rule.id ? withoutException : r) });
  const result = reconcile(head('0'), [line(1, { MWST: '0', Sortiment: 170101 })], { policy: ambiguous });
  assert.equal(result.canAggregate, false); assert.ok(result.issues.includes('STATUS_RULE_AMBIGUOUS'));
});

test('a confirmed net header applies only to the complete unchanged receipt source', () => {
  const h = head('720'), rows = [line(1, { VK_Preis: '864' })], proof = coverage(h, rows);
  const { fingerprint, ...definition } = policy();
  const known = R.defineTradeFotoSalesPolicy({ ...definition, headerBasisOverrides: [{ receiptFingerprint: C.fingerprint([proof.headHash, proof.lineHashes]), basis: 'net' }] });
  const result = reconcile(h, rows, { policy: known });
  assert.equal(result.canAggregate, true); assert.equal(result.totals.gross, '864.00'); assert.equal(result.reconciliation.headerBasis, 'net');
  assert.equal(reconcile(h, rows).canAggregate, false, 'no automatic guess based on matching net arithmetic');
  assert.equal(reconcile(h, rows, { policy: known, coverage: null }).canAggregate, false);
  const different = rows.map(f => ({ ...f, Artikelbezeichnung: 'changed source' }));
  assert.equal(reconcile(h, different, { policy: known }).canAggregate, false);
  assert.equal(reconcile(head('864'), rows, { policy: known }).reconciliation.headerBasis, 'gross');
});

test('confirmed net heads preserve gross positions and cash margins across line rounding and Access precision', () => {
  const examples = [
    { amount: '753.25', gross: '903.90', net: '753.25', margin: '119.08', items: [
      ['69.900000000000', '25.008832000000005'], ['799.000000000000', '85.45842840266926'], ['35.000000000000', '8.609538765432099']
    ] },
    { amount: '790.8333129882812', gross: '949.00', net: '790.83', margin: '219.80', items: [
      ['949.000000000000', '219.80368333333342']
    ] }
  ];
  for (const example of examples) {
    const h = head(example.amount), rows = example.items.map(([price, margin], i) => line(i + 1, {
      VK_Preis: price, RohertragDM: margin, DEK_A: null
    })), before = C.canonical([h, rows]), proof = coverage(h, rows);
    const { fingerprint, ...definition } = policy();
    const confirmed = R.defineTradeFotoSalesPolicy({ ...definition, headerBasisOverrides: [
      ...definition.headerBasisOverrides, { receiptFingerprint: C.fingerprint([proof.headHash, proof.lineHashes]), basis: 'net' }
    ] });
    const checked = reconcile(h, rows, { policy: confirmed }), totals = report(rows, checked);
    assert.equal(checked.canAggregate, true); assert.deepEqual(checked.issues, []);
    assert.equal(checked.reconciliation.headerBasis, 'net'); assert.equal(checked.reconciliation.difference, '0.00');
    assert.equal(checked.totals.gross, example.gross); assert.equal(checked.totals.net, example.net);
    assert.equal(totals.total.metrics.grossMargin.current, example.margin);
    assert.equal(totals.total.metrics.receiptCount.current, '1'); assert.equal(totals.coverage.current.review, 0);
    assert.equal(C.canonical([h, rows]), before, 'the full source and historical unit margins remain unchanged');
    assert.equal(reconcile(h, rows).canAggregate, false, 'matching net arithmetic does not approve another source');
    assert.equal(reconcile(h, rows, { policy: confirmed, coverage: null }).canAggregate, false);
    const changed = reconcile(h, rows.map((row, i) => i ? row : { ...row, RohertragDM: '999' }), { policy: confirmed });
    assert.equal(changed.canAggregate, false, 'an altered cash margin no longer matches the approved source');
    assert.equal(changed.reconciliation.headerBasis, 'gross');
  }
});

test('instant prints use the booked unit price including tiers without a second discount or an EK lookup', () => {
  for (const [quantity, price, unitMargin, gross, net, margin] of [
    ['4', '0.89', '0.5191666666666667', '3.56', '2.97', '2.08'],
    ['50', '0.69', '0.3191666666666667', '34.50', '28.75', '15.96']
  ]) {
    const rows = [line(1, { EAN: '0000000081619', Sortiment: 60401, SonderartikelS: true, VKMenge: quantity,
      VK_Preis: price, RohertragDM: unitMargin, Rabatt: '20', Rabatt_DM: '1', DEK_A: null })];
    const result = reconcile(head(gross), rows), totals = report(rows, result);
    assert.equal(result.canAggregate, true); assert.equal(result.positions[0].status, 'sale');
    assert.equal(result.totals.gross, gross); assert.equal(result.totals.net, net);
    assert.equal(totals.total.metrics.grossMargin.current, margin);
    assert.equal(totals.total.metrics.quantity.current, quantity + '.000000');
    assert.equal(reconcile(head(gross), rows, { coverage: null }).canAggregate, false);
    assert.equal(reconcile(head('1'), rows).canAggregate, false, 'a confirmed sale still requires a matching receipt');
  }
});

test('the repair estimate fee remains earned without an offset and reverses only the recorded charge at repair billing', () => {
  const fee = line(1, { EAN: '0000000049742', Sortiment: 110201, SonderartikelS: true, VK_Preis: '75', RohertragDM: '18.75', DEK_A: null });
  const charge = reconcile(head('75'), [fee]), initial = report([fee], charge);
  assert.equal(charge.canAggregate, true); assert.equal(charge.positions[0].status, 'sale');
  assert.equal(initial.total.metrics.grossRevenue.current, '75.00');
  assert.equal(initial.total.metrics.grossMargin.current, '18.75', 'no hypothetical later offset is subtracted');
  const offset = { ...fee, VKMenge: '-1' }, repair = line(2, { VK_Preis: '112.79', RohertragDM: '23.25', Sortiment: 110201 });
  const settlement = reconcile(head('37.79'), [repair, offset]), final = report([repair, offset], settlement);
  assert.equal(settlement.canAggregate, true); assert.equal(settlement.positions[1].status, 'return');
  assert.equal(settlement.positions[1].net, '-62.50'); assert.equal(settlement.counts.returns, 1);
  assert.equal(final.total.metrics.grossRevenue.current, '37.79'); assert.equal(final.total.metrics.grossMargin.current, '4.50');
  const cents = value => BigInt(value.replace('.', ''));
  assert.equal(cents(initial.total.metrics.grossRevenue.current) + cents(final.total.metrics.grossRevenue.current), 11279n);
  assert.equal(cents(initial.total.metrics.grossMargin.current) + cents(final.total.metrics.grossMargin.current), 2325n);
});

test('the new confirmations do not approve other special articles, status combinations or VAT codes', () => {
  const print = line(1, { EAN: '0000000081619', Sortiment: 60401, SonderartikelS: true });
  const fee = line(2, { EAN: '0000000049742', Sortiment: 110201, SonderartikelS: true, VK_Preis: '75' });
  for (const row of [
    { ...print, MWST: '0' }, { ...print, MWST: '99' }, { ...print, Beratung: true }, { ...print, VKMenge: '0' },
    { ...print, Sortiment: 60204 }, { ...fee, Sortiment: 170401 },
    { ...fee, Sortiment: 170102 }, { ...fee, MWST: '10' }, { ...fee, Ret: true }
  ]) {
    const result = reconcile(head('0'), [row]);
    assert.equal(result.canAggregate, false); assert.equal(result.totals, null); assert.equal(result.positions, null);
    assert.ok(result.issues.includes('STATUS_REVIEW_REQUIRED'));
  }
  const { fingerprint, ...definition } = policy();
  for (const articleNumbers of [[], ['same', 'same'], [42], ['x'.repeat(33)]]) {
    assert.throws(() => R.defineTradeFotoSalesPolicy({ ...definition,
      statusRules: [{ ...definition.statusRules.at(-1), articleNumbers }] }), e => e instanceof C.DataImportError);
  }
});

test('HD processing retains sales and cash margin while a net head requires the confirmed full source', () => {
  const processing = (id, price, margin) => line(id, { EAN: '0000000000011', Sortiment: 60203, SonderartikelS: true,
    VK_Preis: price, RohertragDM: margin, DEK_A: null });
  const hd = [
    processing(1, '86.99', '36.24583333333333'), processing(2, '84.21', '35.0875'),
    processing(3, '40.79', '16.99583333333333'), processing(4, '80.34', '33.475'),
    processing(5, '41.60', '17.33333333333333'), processing(6, '35.66', '14.85833333333333')
  ];
  const rows = [...hd, line(7, { VK_Preis: '379', RohertragDM: '20' })];
  const valid = reconcile(head('748.59'), rows), totals = report(rows, valid);
  assert.equal(valid.canAggregate, true); assert.equal(valid.counts.sales, 7);
  assert.equal(valid.totals.net, '623.83'); assert.equal(totals.total.metrics.grossMargin.current, '174.01');
  const hdGroup = totals.rows.find(item => item.dimensions[0].id === '60203');
  assert.equal(hdGroup.metrics.grossRevenue.current, '369.59'); assert.equal(hdGroup.metrics.netRevenue.current, '308.00');
  assert.equal(hdGroup.metrics.grossMargin.current, '154.01'); assert.equal(hdGroup.metrics.quantity.current, '6.000000');
  const open = reconcile(head('623.8250122070312'), rows);
  assert.deepEqual(open.issues, ['RECEIPT_AMOUNT_MISMATCH']); assert.equal(open.canAggregate, false);
  assert.equal(open.counts.sales, 7); assert.equal(open.counts.review, 0);
  assert.equal(open.totals, null); assert.equal(open.positions, null, 'all receipt values stay gated by the unconfirmed head');
  const uidHead = head('623.8250122070312'), uidCoverage = coverage(uidHead, rows);
  const { fingerprint, ...definition } = policy();
  assert.equal(definition.headerBasisOverrides.length, 13, 'five earlier sources plus eight invoices independently checked against the invoice database');
  const confirmedNet = R.defineTradeFotoSalesPolicy({ ...definition, headerBasisOverrides: [...definition.headerBasisOverrides,
    { receiptFingerprint: C.fingerprint([uidCoverage.headHash, uidCoverage.lineHashes]), basis: 'net' }] });
  const before = C.canonical([uidHead, rows]);
  const netReceipt = reconcile(uidHead, rows, { policy: confirmedNet, coverage: uidCoverage });
  assert.equal(netReceipt.canAggregate, true); assert.equal(netReceipt.reconciliation.headerBasis, 'net');
  assert.equal(netReceipt.reconciliation.difference, '0.00');
  assert.deepEqual(netReceipt.totals, valid.totals); assert.deepEqual(netReceipt.positions, valid.positions, 'gross source positions are not rewritten for the net head');
  assert.equal(report(rows, netReceipt).total.metrics.grossMargin.current, '174.01');
  assert.equal(C.canonical([uidHead, rows]), before);
  assert.equal(reconcile(head('748.59'), rows, { policy: confirmedNet }).reconciliation.headerBasis, 'gross');
  assert.equal(reconcile(uidHead, rows, { policy: confirmedNet, coverage: null }).canAggregate, false);
  const changed = rows.map((row, i) => i ? row : { ...row, Artikelbezeichnung: 'Changed source' });
  assert.equal(reconcile(uidHead, changed, { policy: confirmedNet }).canAggregate, false, 'a changed receipt does not inherit the exception');
  for (const extra of [{ Sortiment: 60204 }, { MWST: '0' }, { VKMenge: '0' }, { Ret: true }]) {
    const other = reconcile(head('0'), [{ ...hd[0], ...extra }]);
    assert.equal(other.canAggregate, false); assert.ok(other.issues.includes('STATUS_REVIEW_REQUIRED'));
  }
});

test('UID card clearing and its cash counterbooking retain signed source amounts without goods metrics', () => {
  for (const quantity of ['1', '-1']) for (const unitMargin of [null, '0', '999']) {
    const rows = [line(1, { EAN: '0000000058204', Sortiment: 170102, MWST: '0', AStorno: true, SonderartikelS: true,
      VKMenge: quantity, VK_Preis: '290.83', RohertragDM: unitMargin, DEK_A: null })], before = C.canonical(rows);
    const result = reconcile(head('0'), rows), totals = report(rows, result);
    assert.equal(result.canAggregate, true); assert.equal(result.counts.uidClearings, 1);
    assert.equal(result.counts.sales, 0); assert.equal(result.counts.returns, 0);
    assert.deepEqual(result.positions, [{ key: rows[0].RepID, status: 'uid_clearing', gross: '0.00', net: '0.00', tax: '0.00' }]);
    for (const [metric, expected] of Object.entries({ grossRevenue: '0.00', netRevenue: '0.00', grossMargin: '0.00',
      quantity: '0.000000', receiptCount: '0', customerCount: '0' })) assert.equal(totals.total.metrics[metric].current, expected, metric);
    assert.equal(totals.coverage.current.excluded, 1); assert.equal(totals.coverage.current.marginMissing, 0);
    assert.equal(C.canonical(rows), before); assert.equal(reconcile(head('0'), rows, { coverage: null }).canAggregate, false);
    assert.equal(reconcile(head('290.83'), rows).canAggregate, false, 'unconfirmed heads are not erased by a non-revenue classification');
  }
});

test('UID clearing applies only to the confirmed article and preserves other VAT and return gates', () => {
  const clearing = line(1, { EAN: '0000000058204', Sortiment: 170102, MWST: '0', AStorno: true, SonderartikelS: true, VK_Preis: '290.83' });
  for (const extra of [{ EAN: '0000000058205' }, { EAN: null }, { Sortiment: 130101 }, { Sortiment: 170101 },
    { MWST: '99' }, { BStorno: true }, { SonderartikelS: false }, { VKMenge: '0' }]) {
    const result = reconcile(head('0'), [{ ...clearing, ...extra }]);
    assert.equal(result.canAggregate, false); assert.equal(result.positions, null);
  }
  const tradeIn=reconcile(head('0'),[{...clearing,AStorno:false,VKMenge:'-1'}]);
  assert.equal(tradeIn.canAggregate,true);assert.equal(tradeIn.positions[0].status,'adjustment');assert.equal(tradeIn.totals.net,'-290.83');
  for (const quantity of ['1', '-1']) {
    const taxable = reconcile(head('0'), [{ ...clearing, VKMenge: quantity, MWST: '20' }]);
    assert.equal(taxable.canAggregate, true); assert.equal(taxable.positions[0].status, quantity === '1' ? 'sale' : 'return');
    assert.equal(taxable.totals.gross, quantity === '1' ? '290.83' : '-290.83');
  }
  assert.deepEqual(reconcile(head('0'), [{ ...clearing, VK_Preis: '-290.83' }]).issues, ['NEGATIVE_UNIT_PRICE_REVIEW']);
  const { fingerprint, ...definition } = policy();
  const overlap = R.defineTradeFotoSalesPolicy({ ...definition, statusRules: definition.statusRules.map(rule => {
    if (rule.id !== 'confirmed-example-0') return rule;
    const { except, ...original } = rule; return original;
  }) });
  assert.ok(reconcile(head('0'), [clearing], { policy: overlap }).issues.includes('STATUS_RULE_AMBIGUOUS'));
});

test('negative goods quantities reduce revenue and historical cash margin without reclassifying voucher payments', () => {
  for (const [price, margin, quantity, gross, net, expectedMargin] of [
    ['13.99', '3.408333333333333', '-1', '-13.99', '-11.66', '-3.41'],
    ['13.99', '3.408333333333333', '-2', '-27.98', '-23.32', '-6.82'],
    ['22.99', '19.066333333333336', '-1', '-22.99', '-19.16', '-19.07']
  ]) {
    const rows = [line(1, { AStorno: true, VKMenge: quantity, VK_Preis: price, RohertragDM: margin, DEK_A: null })];
    const result = reconcile(head(gross), rows), totals = report(rows, result);
    assert.equal(result.canAggregate, true); assert.equal(result.positions[0].status, 'return');
    assert.equal(result.counts.returns, 1); assert.equal(result.totals.gross, gross); assert.equal(result.totals.net, net);
    assert.equal(totals.total.metrics.grossMargin.current, expectedMargin);
    assert.equal(totals.total.metrics.quantity.current, quantity + '.000000');
    assert.equal(reconcile(head('1'), rows).canAggregate, false);
    assert.equal(reconcile(head(gross), rows, { coverage: null }).canAggregate, false);
    assert.equal(reconcile(head('0'), [{ ...rows[0], MWST: '0' }]).canAggregate, false, 'unknown zero-tax goods stay open');
    assert.equal(reconcile(head('0'), [{ ...rows[0], Ret: true }]).canAggregate, false);
  }
  const payment = reconcile(head('0'), [line(1, { AStorno: true, VKMenge: '-1', VK_Preis: '100', MWST: '0', Sortiment: 170101 })]);
  assert.equal(payment.canAggregate, true); assert.equal(payment.positions[0].status, 'payment');
  assert.equal(payment.totals.gross, '0.00');
});

test('confirmed used goods use zero stored VAT and exact signed historical cash margin before cent rounding', () => {
  for (const [price, unitMargin, quantity, revenue, margin] of [
    ['149', '39.485', '1', '149.00', '39.49'], ['349', '92.485', '1', '349.00', '92.49'],
    ['159', '42.135', '1', '159.00', '42.14'], ['149', '39.485', '2', '298.00', '78.97'],
    ['149', '39.485', '-2', '-298.00', '-78.97'], ['149', '0', '1', '149.00', '0.00'],
    ['149', null, '1', '149.00', null]
  ]) {
    const rows = [line(1, { EAN: '0000000069877', Sortiment: 130101, MWST: '0', AStorno: true, SonderartikelS: true,
      VK_Preis: price, VKMenge: quantity, RohertragDM: unitMargin, KalkRohertrag: '9999', DEK_A: '1234' })];
    const h = head(revenue), before = C.canonical([h, rows]), result = reconcile(h, rows), totals = report(rows, result);
    assert.equal(result.canAggregate, true); assert.equal(result.positions[0].status, quantity.startsWith('-') ? 'return' : 'sale');
    assert.deepEqual(result.totals, { currency: 'EUR', gross: revenue, net: revenue, tax: '0.00' });
    assert.equal(totals.total.metrics.netRevenue.current, revenue); assert.equal(totals.total.metrics.grossMargin.current, margin);
    assert.equal(totals.total.metrics.quantity.current, quantity + '.000000');
    assert.equal(totals.coverage.current.marginMissing, unitMargin === null ? 1 : 0, 'missing cash margin never falls back to current EK or KalkRohertrag');
    assert.equal(C.canonical([h, rows]), before);
    assert.equal(reconcile(h, rows, { coverage: null }).canAggregate, false);
    assert.equal(reconcile(head('1'), rows).canAggregate, false);
  }
});

test('the used-goods zero-VAT exception requires every confirmed source field and keeps tax/status gates', () => {
  const used = line(1, { EAN: '0000000069877', Sortiment: 130101, MWST: '0', AStorno: true, SonderartikelS: true, VK_Preis: '149' });
  for (const extra of [{ EAN: '0000000069878' }, { EAN: null }, { Sortiment: 130102 }, { MWST: '99' }, { BStorno: true },
    { Ret: true }, { VK_Preis: '-149' }, { VKMenge: '0' }]) {
    const result = reconcile(head('0'), [{ ...used, ...extra }]);
    assert.equal(result.canAggregate, false); assert.equal(result.totals, null);
  }
  const taxable = reconcile(head('120'), [{ ...used, MWST: '20', VK_Preis: '120' }]);
  assert.equal(taxable.canAggregate, true); assert.equal(taxable.totals.net, '100.00'); assert.equal(taxable.totals.tax, '20.00');
  const { fingerprint, ...definition } = policy(), { zeroPriceVatExceptions, ...beforeConfirmation } = definition;
  const unconfirmed = reconcile(head('149'), [used], { policy: R.defineTradeFotoSalesPolicy(beforeConfirmation) });
  assert.equal(unconfirmed.canAggregate, false); assert.ok(unconfirmed.issues.includes('VAT_CODE_UNKNOWN')); assert.equal(unconfirmed.totals, null);
  for (const exceptions of [[], [{}], [{ vatCodes: ['0'] }], [{ productGroups: ['130101'] }],
    [{ vatCodes: ['99'], productGroups: ['130101'] }], [{ vatCodes: ['0'], productGroups: [] }],
    [{ vatCodes: ['0'], articleNumbers: ['same', 'same'] }], [{ vatCodes: ['0'], productGroups: ['130101'], flags }],
    Array.from({ length: 11 }, () => ({ vatCodes: ['0'], productGroups: ['130101'] }))]) {
    assert.throws(() => R.defineTradeFotoSalesPolicy({ ...definition, zeroPriceVatExceptions: exceptions }), e => e instanceof C.DataImportError);
  }
});

function withReceiptRules(h, rows, extra = {}) {
  const proof = coverage(h, rows), hash = C.fingerprint([proof.headHash, proof.lineHashes]), { fingerprint, ...definition } = policy();
  return { proof, hash, definition, checked: reconcile(h, rows, { coverage: proof,
    policy: R.defineTradeFotoSalesPolicy({ ...definition, headerBasisOverrides: [...definition.headerBasisOverrides,
      { receiptFingerprint: hash, basis: 'net', rounding: 'vat_total' }], ...extra }) }) };
}
test('verified net invoices check VAT totals while preserving every rounded position and historical cash margin', () => {
  const examples = [
    { header: '1529.949951171875', gross: '1835.94', net: '1529.96', difference: '0.01', lines: [
      { VKMenge:'4', VK_Preis:'14.99' }, { VK_Preis:'12.99' }, { VK_Preis:'13.99' }, { VK_Preis:'1749' }] },
    { header:'857.5', gross:'1029.00', net:'857.50', difference:'0.00', lines:[{VK_Preis:'1029'}] },
    { header:'678.3333129882812', gross:'814.00', net:'678.34', difference:'0.01', lines:[
      {VK_Preis:'899'},{VK_Preis:'15'},{VK_Preis:'100',VKMenge:'-1',Sortiment:170201,SonderartikelS:true,RohertragDM:'0'}] }
  ];
  for(const example of examples) {
    const h=head(example.header),rows=example.lines.map((values,i)=>line(i+1,values)),before=C.canonical([h,rows]);
    const {checked,proof,hash,definition}=withReceiptRules(h,rows);
    assert.equal(checked.canAggregate,true);assert.deepEqual(checked.issues,[]);
    assert.equal(checked.totals.gross,example.gross);assert.equal(checked.totals.net,example.net);
    assert.equal(checked.reconciliation.rounding,'vat_total');assert.equal(checked.reconciliation.positionRoundingDifference,example.difference);
    assert.equal(checked.reconciliation.difference,'0.00');assert.equal(checked.reconciliation.toleranceMinor,0);
    const ordinary=reconcile(head(example.gross),rows);
    assert.deepEqual(checked.positions,ordinary.positions);assert.deepEqual(checked.totals,ordinary.totals);
    assert.equal(C.canonical([h,rows]),before);
    assert.equal(report(rows,checked).total.metrics.grossMargin.current,report(rows,ordinary).total.metrics.grossMargin.current);
    const bound=R.defineTradeFotoSalesPolicy({...definition,headerBasisOverrides:[...definition.headerBasisOverrides,{receiptFingerprint:hash,basis:'net',rounding:'vat_total'}]});
    assert.equal(reconcile(h,rows,{policy:bound,coverage:null}).canAggregate,false);
    const changed=rows.map((r,i)=>i?r:{...r,Artikelbezeichnung:'changed source'});
    assert.equal(reconcile(h,changed,{policy:bound,coverage:coverage(h,changed)}).canAggregate,false);
    assert.equal(reconcile(h,rows).canAggregate,false,'an unrelated source does not inherit this exact net invoice check');
    if(example.difference!=='0.00') {
      const oldNet=R.defineTradeFotoSalesPolicy({...definition,headerBasisOverrides:[{receiptFingerprint:hash,basis:'net'}]});
      assert.equal(reconcile(h,rows,{policy:oldNet,coverage:proof}).canAggregate,false,'per-position reconciliation remains strict without the verified rounding option');
    }
  }
});
test('VAT-total reconciliation keeps tax rates separate, signed returns and a strict zero-cent error boundary', () => {
  const rows=[line(1,{VK_Preis:'0.03'}),line(2,{VK_Preis:'0.03'}),line(3,{VK_Preis:'0.06',MWST:'10'}),line(4,{VK_Preis:'0.06',MWST:'10'})];
  assert.equal(withReceiptRules(head('0.16'),rows).checked.canAggregate,true);
  assert.equal(withReceiptRules(head('0.15'),rows).checked.canAggregate,false,'no one-cent tolerance is introduced');
  const negative=rows.map(r=>({...r,VKMenge:'-1'}));assert.equal(withReceiptRules(head('-0.16'),negative).checked.canAggregate,true);
  const altered=rows.map((r,i)=>i?r:{...r,VK_Preis:'0.04'});
  assert.equal(withReceiptRules(head('0.16'),altered).checked.canAggregate,false,'a newly bound source with a real amount discrepancy is still rejected');
});
test('the source-family house-fair adjustment survives an import without binding a single receipt hash', () => {
  const h={...head('2856.175048828125'),RechnungsNr:'60689'},rows=[line(1,{VK_Preis:'3899',RohertragDM:'274.51172839203855'}),line(2,{VK_Preis:'28.41',RohertragDM:'10.375'}),
    line(3,{VKMenge:'-1',VK_Preis:'300',Sortiment:170201,SonderartikelS:true,RohertragDM:'0'}),
    line(4,{VKMenge:'-1',VK_Preis:'200',EAN:'0000000000999',Sortiment:170301,SonderartikelS:true,RohertragDM:'166.66666666666663'})].map(row=>({...row,RechnungsNr:60689}));
  const result=reconcile(h,rows),total=report(rows,result).total.metrics;
  assert.equal(result.canAggregate,true);assert.equal(result.totals.gross,'3427.41');assert.equal(result.totals.net,'2856.18');
  assert.equal(result.counts.adjustments,2);assert.equal(total.quantity.current,'2.000000');assert.equal(total.grossMargin.current,'118.22');
  const changed=rows.map((r,i)=>i?r:{...r,Artikelbezeichnung:'different invoice source'});
  assert.equal(reconcile(h,changed).canAggregate,true);
  assert.equal(reconcile({...h,RechnungsBetrag:'2856.19'},changed).canAggregate,false);
  assert.equal(reconcile(h,rows,{coverage:null}).canAggregate,false);
});
test('receipt-specific rounding and status bindings reject ambiguous or unsupported policy shapes',()=>{
  const {fingerprint,...definition}=policy(),hash='a'.repeat(64);
  for(const item of [{receiptFingerprint:hash,basis:'gross',rounding:'vat_total'},{receiptFingerprint:hash,basis:'net',rounding:'guess'},{receiptFingerprint:hash,basis:'net',toleranceMinor:1}])
    assert.throws(()=>R.defineTradeFotoSalesPolicy({...definition,headerBasisOverrides:[item]}));
  const rule=definition.statusRules.at(-1);
  for(const receiptFingerprints of [[],[hash,hash],['bad']])assert.throws(()=>R.defineTradeFotoSalesPolicy({...definition,statusRules:[...definition.statusRules.slice(0,-1),{...rule,receiptFingerprints}]}));
});

function interimPaymentFixture() {
  const initialHead=head('0'),counterHead={...head('0'),Bonnr:'2'};
  const interim=extra=>line(1,{EAN:'0000000106030',Sortiment:170102,SonderartikelS:true,VK_Preis:'299.16',RohertragDM:'0',...extra});
  const initial=[interim({})],counter=[interim({Bonnr:'2',VKMenge:'-1',RepID:line(2).RepID}),
    line(3,{Bonnr:'2',EAN:'0000000058204',Sortiment:170102,AStorno:true,SonderartikelS:true,VK_Preis:'299.16',MWST:'0',RohertragDM:'0'})];
  const receipts=[{head:initialHead,lines:initial},{head:counterHead,lines:counter}];
  const {fingerprint,...definition}=policy(),rules=receipts.map((receipt,index)=>{
    const proof=coverage(receipt.head,receipt.lines);
    return {id:'synthetic-interim-'+index,status:'uid_clearing',quantitySign:index?'negative':'positive',flags:{...flags,SonderartikelS:true},
      productGroups:['170102'],vatCodes:['20'],articleNumbers:['0000000106030'],receiptFingerprints:[C.fingerprint([proof.headHash,proof.lineHashes])],
      receiptFinancialFingerprints:[R.receiptFinancialFingerprint(receipt.head,receipt.lines)]};
  });
  const keys=receipts.map(r=>R.receiptKeyFingerprint(r.head));
  return {receipts,known:R.defineTradeFotoSalesPolicy({...definition,statusRules:[...definition.statusRules.map(rule=>rule.id.startsWith('confirmed-ordinary-trade-goods-')
    ?{...rule,exceptReceiptKeys:[...rule.exceptReceiptKeys,...keys]}:rule),...rules]})};
}
test('a verified cancelled taxable interim payment and its UID rebooking have no goods revenue, margin, quantity or receipt count',()=>{
  const {receipts,known}=interimPaymentFixture(),state=M.accumulator(),before=C.canonical(receipts);
  for(const [index,{head:h,lines:rows}]of receipts.entries()) {
    assert.equal(reconcile(h,rows).canAggregate,true,'unrelated ordinary trade follows the explicitly confirmed signed sales definition');
    const checked=reconcile(h,rows,{policy:known});assert.equal(checked.canAggregate,true);assert.deepEqual(checked.issues,[]);
    assert.equal(checked.counts.uidClearings,rows.length);assert.equal(checked.totals.gross,'0.00');assert.equal(checked.totals.net,'0.00');
    for(const source of rows)M.accumulate(state,'current',query,{metric:checked.positions.find(p=>p.key===source.RepID),quantity:source.VKMenge,
      margin:M.positionMargin(source.RohertragDM,source.VKMenge),receiptKey:'interim-'+index,customerKey:null,productGroup:{id:'170102',label:'Anzahlung'}});
  }
  const interimReport=M.finishReport(state,query);
  assert.equal(interimReport.coverage.current.review,0);assert.equal(interimReport.coverage.current.excluded,3);
  assert.equal(interimReport.total.metrics.grossRevenue.current,'0.00');assert.equal(interimReport.total.metrics.netRevenue.current,'0.00');
  assert.equal(interimReport.total.metrics.grossMargin.current,'0.00');assert.equal(interimReport.total.metrics.quantity.current,'0.000000');
  assert.equal(interimReport.total.metrics.receiptCount.current,'0');assert.equal(C.canonical(receipts),before);
  // A separately recorded later goods sale is valued normally, without adding
  // the earlier payment or its cancellation to the goods sale a second time.
  const goodsHead={...head('120'),Bonnr:'3'},goods=line(4,{Bonnr:'3'}),checked=reconcile(goodsHead,[goods],{policy:known});
  assert.equal(checked.canAggregate,true);M.accumulate(state,'current',query,{metric:checked.positions[0],quantity:goods.VKMenge,
    margin:M.positionMargin(goods.RohertragDM,goods.VKMenge),receiptKey:'goods',customerKey:null,productGroup:{id:'130',label:'Goods'}});
  const total=M.finishReport(state,query).total.metrics;
  assert.equal(total.netRevenue.current,'100.00');assert.equal(total.grossMargin.current,'20.00');assert.equal(total.quantity.current,'1.000000');assert.equal(total.receiptCount.current,'1');
});
test('interim payment confirmation protects its finances and membership while normal trade outside those identities remains usable',()=>{
  const {receipts,known}=interimPaymentFixture();
  for(const {head:h,lines:rows}of receipts) {
    const proof=coverage(h,rows);
    assert.equal(reconcile(h,rows,{policy:known,coverage:null}).canAggregate,false);
    for(const changed of [{VK_Preis:'299.17'},{RohertragDM:'0.01'},{Sortiment:999},{EAN:'0000000106031'},{Beratung:true},{MWST:'10'}]) {
      const altered=rows.map((r,i)=>i?r:{...r,...changed});
      const result=reconcile(h,altered,{policy:known,coverage:coverage(h,altered)});
      assert.equal(result.canAggregate,false);assert.equal(result.positions,null);assert.equal(result.totals,null);
    }
    const refreshed=rows.map((r,i)=>({...r,RepID:line(50+i).RepID,Artikelbezeichnung:'Changed source text'}));
    const refreshedResult=reconcile(h,refreshed,{policy:known,coverage:coverage(h,refreshed)});
    assert.equal(refreshedResult.canAggregate,true);assert.ok(refreshedResult.positions.every(p=>p.status==='uid_clearing'));
    const ordinary=rows.map((r,i)=>i?r:{...r,SonderartikelS:false});
    const defaultResult=reconcile(h,ordinary),knownResult=reconcile(h,ordinary,{policy:known});
    assert.deepEqual(knownResult.positions,defaultResult.positions,'independently confirmed ordinary sales/returns keep their original valuation');
    assert.deepEqual(knownResult.totals,defaultResult.totals);
    const otherHead={...h,Bonnr:'999'},otherRows=rows.map(r=>({...r,Bonnr:'999'}));
    const unrelated=reconcile(otherHead,otherRows,{policy:known,coverage:coverage(otherHead,otherRows)});
    assert.equal(unrelated.canAggregate,true);assert.ok(unrelated.positions.some(p=>['sale','return'].includes(p.status)));
    if(rows.length>1)assert.equal(reconcile(h,rows.slice(1),{policy:known,coverage:proof}).canAggregate,false,'partial source pages cannot authorize the rebooking');
  }
});

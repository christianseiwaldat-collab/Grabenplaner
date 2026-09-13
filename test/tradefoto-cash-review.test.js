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

test('effective cash rules preserve the sealed source contract and unrelated policies', () => {
  const old = original(), before = C.canonical(old), current = resolveCashSalesPolicy(old);
  assert.equal(C.canonical(old), before); assert.equal(old.version, 1); assert.equal(current.version, 9);
  assert.equal(current.id, 'cash-confirmed-20260911');
  assert.notEqual(current.fingerprint, old.fingerprint);
  assert.equal(resolveCashSalesPolicy(current), current);
  const custom = original({ headerToleranceMinor: 1 }); assert.equal(resolveCashSalesPolicy(custom), custom);
  assert.equal(reportMarginPolicyFor(old), reportMarginPolicyFor(current));
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

test('voucher issuance requires the confirmed group, tax code, flags and positive quantity together', () => {
  const issue = line(1, { VKMenge: '2', VK_Preis: '10', MWST: '0', Sortiment: 170101, RohertragDM: '0' });
  for (const extra of [{ Sortiment: 170102 }, { Sortiment: 130101 }, { MWST: '99' }, { SonderartikelS: true },
    { Ret: true }, { VKMenge: '-2' }, { VKMenge: '0' }]) {
    const result = reconcile(head('0'), [{ ...issue, ...extra }]);
    assert.equal(result.canAggregate, false); assert.equal(result.positions, null); assert.equal(result.totals, null);
  }
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
    { ...print, MWST: '0' }, { ...print, MWST: '99' }, { ...print, Beratung: true }, { ...print, VKMenge: '-1' },
    { ...print, Sortiment: 60203 }, { ...fee, EAN: '0000000049743' }, { ...fee, EAN: null },
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
  assert.equal(definition.headerBasisOverrides.length, 3, 'only the three individually confirmed real receipt sources are configured');
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
  for (const extra of [{ EAN: '0000000000012' }, { Sortiment: 60204 }, { MWST: '0' }, { VKMenge: '-1' }, { Ret: true }]) {
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
    { MWST: '99' }, { BStorno: true }, { SonderartikelS: false }, { AStorno: false }, { VKMenge: '0' }]) {
    const result = reconcile(head('0'), [{ ...clearing, ...extra }]);
    assert.equal(result.canAggregate, false); assert.equal(result.positions, null);
  }
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

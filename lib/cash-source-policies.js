'use strict';
const H = require('./tradefoto-history-profiles');
// Only the five status combinations in the previously user-confirmed examples.
// Unknown combinations remain review-required. Code 0 was evidenced only on
// zero-price positions, never as a general tax-exemption rule.
const combinations = [[true,true,'positive'],[true,true,'negative'],[true,false,'positive'],[false,false,'positive'],[false,false,'negative']];
const CASH_SOURCE_POLICIES = Object.freeze([Object.freeze({
  id: 'cash-confirmed-20260907', label: 'Bestätigte Kassenregeln · Belegabgleich September 2026',
  fileSha256: '6a7e9f3cb8404299da54aef8c5ab661d7d66e1791003ebcd62c10d60a6a4e395',
  appliesTo: 'matching_cash_schema',
  policy: Object.freeze({ id: 'cash-confirmed-20260907', version: 1,
    schemaSha256: H.profileFor('cash', 'Umsatz_KASSE').schemaSha256,
    evidenceSha256: '2a135e55d21d296deed3a431a3e8c91855c967f8123af9f9d765c52caf3f74f2',
    approvedBy: 'user-confirmed-receipt-examples', approvedAt: '2026-09-07T12:00:00.000Z',
    currency: 'EUR', minorUnits: 2, priceBasis: 'gross', priceMeaning: 'final_unit', headerBasis: 'gross',
    rounding: 'half_away_from_zero', vatRates: { '20': '20', '0': '0' }, zeroPriceVatCodes: ['0'],
    headerToleranceMinor: 0, headerZeroMeaning: 'unavailable',
    statusRules: combinations.map(([AStorno,SonderartikelS,quantitySign],i) => ({ id: 'confirmed-example-' + i,
      flags: { AStorno, BStorno: false, Ret: false, R: false, N: false, ZR: false, set: false, SonderartikelS, Beratung: false },
      quantitySign, status: quantitySign === 'negative' ? 'return' : 'sale' }))
  })
})]);
// Preserve the sealed publication's original definition. This revision applies
// only to that exact, previously approved contract after its integrity check.
// Reports bind the effective fingerprint and cannot resume across rule changes.
function resolveCashSalesPolicy(policy) {
  const C = require('./data-import-contract');
  const original = { ...CASH_SOURCE_POLICIES[0].policy, scopeId: policy.scopeId, sourceInstance: policy.sourceInstance };
  const { fingerprint, ...definition } = policy;
  if (!C.equal(original, definition)) return policy;
  const flags = { AStorno: false, BStorno: false, Ret: false, R: false, N: false, ZR: false, set: false, SonderartikelS: true, Beratung: false };
  const reviewed = { ...original, id: 'cash-confirmed-20260910', version: 2,
    evidenceSha256: C.fingerprint({ prior: original.evidenceSha256, revision: 'cash-review-20260910',
      manufacturerDiscounts: 'user-confirmed-signed-separate-positions', voucherRedemption: 'user-confirmed-payment', taxCode10: 'user-confirmed-ten-percent',
      netReceipt: '42ede06754f9eadaa85b4afd8cae85599d11c46a3bbb0a270a0658fa26235af8' }),
    approvedAt: '2026-09-10T00:00:00.000Z',
    vatRates: { ...original.vatRates, '10': '10' },
    statusRules: [...original.statusRules, ...['negative', 'positive'].map(quantitySign => ({
      id: 'manufacturer-discount-' + quantitySign, status: 'adjustment', flags, quantitySign,
      productGroups: ['170201'], vatCodes: ['20'] })),
      { id: 'voucher-redemption-payment', status: 'payment', quantitySign: 'negative', productGroups: ['170101'], vatCodes: ['0'],
        flags: { ...flags, AStorno: true, SonderartikelS: false } }],
    // Only the user-confirmed mixed-format receipt uses a net head. The complete
    // source fingerprint keeps unrelated or changed gross receipts unchanged.
    headerBasisOverrides: [{ receiptFingerprint: '42ede06754f9eadaa85b4afd8cae85599d11c46a3bbb0a270a0658fa26235af8', basis: 'net' }]
  };
  const services = { ...reviewed, id: 'cash-confirmed-20260911', version: 3,
    evidenceSha256: C.fingerprint({ prior: reviewed.evidenceSha256, revision: 'cash-review-20260911',
      instantPrints: 'user-confirmed-normal-sales-at-booked-unit-price-including-tier-prices',
      repairEstimateFee: 'user-confirmed-service-charge-and-recorded-offset-when-repair-invoiced' }),
    approvedAt: '2026-09-11T00:00:00.000Z',
    statusRules: [...reviewed.statusRules,
      { id: 'instant-print-sale', status: 'sale', flags, quantitySign: 'positive', productGroups: ['60401'], vatCodes: ['20'] },
      // Only the confirmed fee article receives this additional special-item
      // interpretation. No offset is invented when the repair is not performed.
      ...['positive', 'negative'].map(quantitySign => ({ id: 'repair-estimate-fee-' + quantitySign,
        status: quantitySign === 'positive' ? 'sale' : 'return', flags, quantitySign,
        productGroups: ['110201'], vatCodes: ['20'], articleNumbers: ['0000000049742'] }))]
  };
  const processing = { ...services, version: 4,
    evidenceSha256: C.fingerprint({ prior: services.evidenceSha256, revision: 'cash-review-hd-20260911',
      hdProcessing: 'user-confirmed-normal-sales-at-booked-unit-price-with-cash-margin' }),
    statusRules: [...services.statusRules,
      { id: 'hd-processing-sale', status: 'sale', flags, quantitySign: 'positive',
        productGroups: ['60203'], vatCodes: ['20'], articleNumbers: ['0000000000011'] }]
  };
  const netReceipts = { ...processing, version: 5,
    evidenceSha256: C.fingerprint({ prior: processing.evidenceSha256, revision: 'cash-review-uid-head-20260911',
      netReceipt: '892aceb22ab1a6926a628adb5ca97ba2bb7ef1c744e8e4cb49e1ebaa2029d9f2',
      meaning: 'user-confirmed-uid-purchase-booked-to-branch-net-header-gross-positions' }),
    // This confirmed later branch posting has a net head and gross positions.
    // Its complete source fingerprint is not a general UID or tax rule.
    headerBasisOverrides: [...processing.headerBasisOverrides,
      { receiptFingerprint: '892aceb22ab1a6926a628adb5ca97ba2bb7ef1c744e8e4cb49e1ebaa2029d9f2', basis: 'net' }]
  };
  const issuanceFilter = { productGroups: ['170101'], vatCodes: ['0'] };
  const vouchers = { ...netReceipts, version: 6,
    evidenceSha256: C.fingerprint({ prior: netReceipts.evidenceSha256, revision: 'cash-review-voucher-issuance-20260911',
      voucherIssuance: 'user-confirmed-no-revenue-or-margin-before-goods-sale' }),
    // Remove only the confirmed voucher combination from the earlier generic
    // sale rule. All other matches keep their meaning; ambiguity stays an error.
    statusRules: [...netReceipts.statusRules.map(rule => rule.id === 'confirmed-example-3'
      ? { ...rule, except: [issuanceFilter] } : rule),
      { id: 'voucher-issuance', status: 'voucher_issue', quantitySign: 'positive', ...issuanceFilter,
        flags: { ...flags, SonderartikelS: false } }]
  };
  const uidClearingFilter = { productGroups: ['170102'], vatCodes: ['0'], articleNumbers: ['0000000058204'] };
  const clearingAndReturns = { ...vouchers, version: 7,
    evidenceSha256: C.fingerprint({ prior: vouchers.evidenceSha256, revision: 'cash-review-uid-clearing-returns-20260911',
      uidClearing: 'user-confirmed-card-receipt-and-cash-transfer-to-accounting-before-final-uid-sale',
      negativeItems: 'user-confirmed-goods-returns-with-signed-cash-margin',
      netReceipt: 'f6a5be6905ff7f1bc7eda5250f6630d40673c229bdd5c21c292abc541b8a90cb' }),
    // Only the confirmed clearing article leaves the generic sale/return rules.
    // Its signed payment amount remains in the source, not in goods metrics.
    statusRules: [...vouchers.statusRules.map(rule => ['confirmed-example-0', 'confirmed-example-1'].includes(rule.id)
      ? { ...rule, except: [...(rule.except || []), uidClearingFilter] } : rule),
      ...['positive', 'negative'].map(quantitySign => ({ id: 'uid-clearing-' + quantitySign, status: 'uid_clearing',
        quantitySign, ...uidClearingFilter, flags: { ...flags, AStorno: true } })),
      { id: 'confirmed-negative-item-return', status: 'return', quantitySign: 'negative',
        flags: { ...flags, AStorno: true, SonderartikelS: false }, except: [issuanceFilter] }],
    // Net is confirmed for this complete source; a UID background is optional
    // and does not imply a new tax rule or a guess for other receipt heads.
    headerBasisOverrides: [...vouchers.headerBasisOverrides,
      { receiptFingerprint: 'f6a5be6905ff7f1bc7eda5250f6630d40673c229bdd5c21c292abc541b8a90cb', basis: 'net' }]
  };
  const usedGoods = { ...clearingAndReturns, version: 8,
    evidenceSha256: C.fingerprint({ prior: clearingAndReturns.evidenceSha256, revision: 'cash-review-used-goods-20260911',
      usedGoodsVat: 'user-confirmed-stored-zero-percent-vat-and-net-sale-amount',
      margin: 'historical-cash-unit-margin-times-signed-quantity' }),
    // Only the confirmed used-goods article may carry a nonzero sale price
    // with code 0. At zero percent the unchanged price is also the net amount.
    zeroPriceVatExceptions: [{ productGroups: ['130101'], articleNumbers: ['0000000069877'], vatCodes: ['0'] }]
  };
  const depositFilter = { productGroups: ['170102'], vatCodes: ['20'], articleNumbers: ['0000000000098'] };
  const deposits = { ...usedGoods, version: 9,
    evidenceSha256: C.fingerprint({ prior: usedGoods.evidenceSha256, revision: 'cash-review-deposit-20260913',
      deposit: 'user-confirmed-article-98-signed-revenue-on-receipt-and-redemption',
      margin: 'zero-deposit-margin-and-unchanged-historical-goods-margin' }),
    approvedAt: '2026-09-13T00:00:00.000Z',
    // Article 98 is revenue-bearing in both directions, unlike vouchers and
    // UID clearing in the same group. Preserve the source and its VAT code.
    // Remove only this exact article/filter from the generic goods rules.
    statusRules: [...usedGoods.statusRules.map(rule => rule.id.startsWith('confirmed-example-') || rule.id === 'confirmed-negative-item-return'
      ? { ...rule, except: [...(rule.except || []), depositFilter] } : rule),
      ...[false, true].flatMap(AStorno => [false, true].flatMap(SonderartikelS => ['positive', 'negative'].map(quantitySign => ({
        id: `deposit-${Number(AStorno)}-${Number(SonderartikelS)}-${quantitySign}`, status: 'deposit', quantitySign,
        ...depositFilter, flags: { ...flags, AStorno, SonderartikelS }
      }))))]
  };
  const confirmedNetHeads = [
    '06852e5ad7ac01eca49e820f76b264fd8fdabe8903cb82c545223633b32d6aaa',
    '553b9c4265c9709ec0462a2a7134808edc6e4ece22f2ebf7dbfc93513d7856f3'
  ];
  const priorNetHeads = { ...deposits, version: 10,
    evidenceSha256: C.fingerprint({ prior: deposits.evidenceSha256, revision: 'cash-review-net-heads-20260913',
      netReceipts: confirmedNetHeads, meaning: 'user-confirmed-net-headers-with-unchanged-gross-positions-and-cash-margin' }),
    // Confirmed complete sources only. Amounts, VAT and historical margins stay
    // unchanged; a changed or unrelated receipt still requires its own check.
    headerBasisOverrides: [...deposits.headerBasisOverrides,
      ...confirmedNetHeads.map(receiptFingerprint => ({ receiptFingerprint, basis: 'net' }))]
  };
  // Verified against Rechnung_Z.nettorechnung and Rechnungsdetails_Z.VK/N_VK.
  // Exact complete-source fingerprints; no automatic net guess from arithmetic.
  // Source net totals use invoice VAT-group rounding rather than per-position
  // rounding, including half-cent Access float storage at invoice 60689.
  const invoiceNetHeads = [
    '85cd978dd5e76d05c581577d8b99cfb5a408aa59f5f8b8f39d7553464741f5d5', // 60668
    '7297090c6e40189093c3b95aa635f1ce5506db835f6f15d6e41fd1835b091e64', // 60669
    'db92391b796c3b26f6141fa9338628a41e73604b70f090d76b62e0dba1d285a2', // 60688
    'f205c5f3e2d4ce24e359f2401dcda6b0411b31b1f630d84d374f67ef8159313f', // 60689
    'db5113d9638f5ff76d5efbf8c6eac77679825154e02ece0cc70ce239c7503698', // 60690
    'bb7ba0fc3e06cf47f23e26e8edcc13ad1a9e9643c9acac2d802d64f1d5b618ff', // 62172
    '2378e43f47c98ec036b24cffa3c45515f2143e56a5e9ee8a61a78dd35d970a41', // 62180
    'dcf967b295d7d3fa1f4e67a8d06118c442557be4a344788901d0f755fce861c1' // 62206
  ];
  const invoiceCrosscheck = { ...priorNetHeads, version: 11,
    approvedBy: 'source-verified-invoice-crosscheck', approvedAt: '2026-11-03T00:00:00.000Z',
    evidenceSha256: C.fingerprint({ prior: priorNetHeads.evidenceSha256, revision: 'cash-invoice-crosscheck-20261103',
      cashSource: 'ecb799207f1e3b89c073ffeb46f7570012690b311b399eaecb6591dc3b996f32',
      invoiceSource: '833493d7f909c84b85dc875ba32d4e144cc48f3bb8c9e8c126570b75bc2af426',
      invoiceNetHeads, meaning: 'net-invoice-flag-and-separate-gross-net-unit-prices-with-vat-total-rounding',
      houseFairDiscount: 'signed-separate-invoice-position-historical-cash-margin-unchanged' }),
    headerBasisOverrides: [...priorNetHeads.headerBasisOverrides,
      ...invoiceNetHeads.map(receiptFingerprint => ({ receiptFingerprint, basis: 'net', rounding: 'vat_total' }))],
    statusRules: [...priorNetHeads.statusRules, { id: 'verified-invoice-house-fair-discount', status: 'adjustment',
      quantitySign: 'negative', flags, productGroups: ['170301'], vatCodes: ['20'], articleNumbers: ['0000000000999'],
      receiptFingerprints: [invoiceNetHeads[3]] }]
  };
  // 25.09.2025 / branch 18: the taxable interim payment on 79603 is cancelled
  // on 79610 and rebooked to the already confirmed zero-VAT UID clearing item.
  // The unchanged full receipt sources and same-day Visa journal support this
  // settled payment flow. No later invoice is guessed from a matching amount.
  const interimClearing = [
    { receiptFingerprint: 'fd1c174bc12f4d7e767b83dad451bf27180351f6de9d8d3fa97c9cff741d15dd', sign: 'positive' },
    { receiptFingerprint: 'e1411877088a0999469df7ed77b4782d6885c5f0a2ae1df7e4cbfcbf1446f0e3', sign: 'negative' }
  ];
  const paymentCrosscheck = { ...invoiceCrosscheck, version: 12,
    approvedBy: 'source-verified-payment-crosscheck', approvedAt: '2026-11-03T00:00:00.000Z',
    evidenceSha256: C.fingerprint({ prior: invoiceCrosscheck.evidenceSha256, revision: 'cash-interim-uid-rebooking-20261103',
      cashSource: 'ecb799207f1e3b89c073ffeb46f7570012690b311b399eaecb6591dc3b996f32', interimClearing,
      journal: { date: '2025-09-25', branch: '18', transaction: 61833, document: 1130, account: 239070, outflow: '299.16' },
      meaning: 'cancelled-taxable-interim-payment-rebooked-to-confirmed-uid-clearing;no-goods-revenue-or-margin' }),
    statusRules: [...invoiceCrosscheck.statusRules, ...interimClearing.map(({ receiptFingerprint, sign }) => ({
      id: 'verified-interim-uid-clearing-' + sign, status: 'uid_clearing', quantitySign: sign,
      flags, productGroups: ['170102'], vatCodes: ['20'], articleNumbers: ['0000000106030'], receiptFingerprints: [receiptFingerprint]
    }))]
  };
  const families = confirmedSalesFamilies(generalizeCashSourcePolicy(paymentCrosscheck));
  const accounts = confirmedAccountRevenue(families);
  const rental = confirmedRentalSecurityRevenue(accounts);
  const trade = confirmedOrdinaryTradeGoods(rental);
  const printCenter = confirmedPrintCenterRevenue(trade);
  return require('./tradefoto-sales-rules').defineTradeFotoSalesPolicy(confirmedTradeInRevenue(printCenter));
}
// Source-family rules, deliberately independent of file hash, import generation,
// document number and mutable descriptions. Financial accounts outside these
// evidenced selectors and additional status flags continue to require review.
function generalizeCashSourcePolicy(previous) {
  const C = require('./data-import-contract');
  const flags = { AStorno: false, BStorno: false, Ret: false, R: false, N: false, ZR: false, set: false, SonderartikelS: false, Beratung: false };
  const discounts = { productGroups: ['170201', '170301', '170302'] };
  const cashExchange = { productGroups: ['160201'], articleNumbers: ['0000000078430'], vatCodes: ['0'] };
  const voucher = { productGroups: ['170101'], vatCodes: ['0'] };
  const services = { productGroups: ['60101', '60201', '60202', '60203', '60301', '60302', '60303',
    '60401', '60402', '60403', '60501', '60502', '60601', '60602', '60603', '60801',
    '110101', '110201', '110301', '110302', '110401', '110501', '110601', '110801', '110802', '110803', '111001'], vatCodes: ['20'] };
  const specialGoods = [services,
    { productGroups: ['130101'], articleNumbers: ['0000000069877'] },
    { productGroups: ['160201'], articleNumbers: ['0000000077271'], vatCodes: ['20'] },
    { productGroups: ['50107'], articleNumbers: ['0000000094074'], vatCodes: ['20'] },
    { productGroups: ['999999'], articleNumbers: ['0000000054324', '0000000044567', '0000000044568', '0000000044569', '0000000088880'] }];
  const replaced = rule => rule.id.startsWith('manufacturer-discount-') || rule.id === 'verified-invoice-house-fair-discount'
    || rule.id === 'instant-print-sale' || rule.id.startsWith('repair-estimate-fee-') || rule.id === 'hd-processing-sale'
    || rule.id === 'voucher-redemption-payment' || rule.id === 'voucher-issuance';
  const rules = previous.statusRules.filter(rule => !replaced(rule)).map(rule => rule.id.startsWith('confirmed-example-') || rule.id === 'confirmed-negative-item-return'
    ? { ...rule, except: [...(rule.except || []).filter(filter => !C.equal(filter, voucher)), discounts, cashExchange, voucher] } : rule);
  for (const AStorno of [false, true]) for (const SonderartikelS of [false, true]) for (const quantitySign of ['positive', 'negative']) {
    rules.push({ id: `source-discount-${Number(AStorno)}-${Number(SonderartikelS)}-${quantitySign}`,
      status: 'adjustment', signedAdjustmentPrice: true, quantitySign, ...discounts, flags: { ...flags, AStorno, SonderartikelS } });
  }
  specialGoods.forEach((filter, index) => {
    for (const quantitySign of ['positive', 'negative']) rules.push({ id: `source-special-goods-${index}-${quantitySign}`,
      status: quantitySign === 'positive' ? 'sale' : 'return', quantitySign, ...filter, flags: { ...flags, SonderartikelS: true } });
  });
  for (const quantitySign of ['positive', 'negative']) {
    rules.push({ id: 'source-cash-exchange-' + quantitySign, status: 'payment', quantitySign, ...cashExchange, flags: { ...flags, AStorno: true, SonderartikelS: true } });
    rules.push({ id: 'source-voucher-payment-' + quantitySign, status: 'payment', quantitySign, ...voucher, flags: { ...flags, AStorno: true } });
    rules.push({ id: 'source-voucher-issuance-' + quantitySign, status: 'voucher_issue', quantitySign, ...voucher, flags });
  }
  // MWST in cash rows is the recorded percentage, unlike article-master tax
  // codes. Preserve the historical value, including foreign rates; never use
  // today's location rate. Nonzero goods at code 0 remain explicitly limited.
  const recordedRates = ['7', '8', '9', '12', '13', '14', '15', '17', '18', '19', '21', '22', '23', '24', '25', '26', '27'];
  return { ...previous, version: 13, approvedAt: '2026-11-04T00:00:00.000Z', approvedBy: 'source-verified-full-cash-audit',
    evidenceSha256: C.fingerprint({ prior: previous.evidenceSha256, revision: 'cash-source-family-20261104',
      cashSource: 'ecb799207f1e3b89c073ffeb46f7570012690b311b399eaecb6591dc3b996f32',
      olderCashSource: '5121b1177c49c41c11ec6d48f9df51fe0b6e799ab927df49164cf2d24f3e7d3b',
      invoiceSource: '833493d7f909c84b85dc875ba32d4e144cc48f3bb8c9e8c126570b75bc2af426',
      netFlagsConfirmed: 164, netFlagContradictions: 0, discounts, specialGoods, cashExchange, voucher, recordedRates,
      invoiceHeadStorage: 'source-exact-Access-Single-of-unrounded-total;no-cent-tolerance',
      voucherInvoice: 'source-invoice-62069-2500-nominal-voucher-issuance-not-goods-revenue' }),
    invoiceHeaderConvention: 'cash_register_zero_same_invoice',
    vatRates: { ...previous.vatRates, ...Object.fromEntries(recordedRates.map(rate => [rate, rate])) }, statusRules: rules };
}
module.exports = { CASH_SOURCE_POLICIES, resolveCashSalesPolicy };

function confirmedSalesFamilies(previous) {
  const C = require('./data-import-contract');
  const flags = { AStorno: false, BStorno: false, Ret: false, R: false, N: false, ZR: false, set: false, SonderartikelS: true, Beratung: false };
  // Explicit user decisions: insurance uses the full booked selling price and
  // historical unit margin; prepaid phone credit uses its full booked value.
  // These groups are distinct from issuance/redemption of our own gift cards.
  const insurance = { productGroups: ['110901'] };
  const phoneCredit = { productGroups: ['80501'] };
  const serviceVoucher = { productGroups: ['170302'], articleNumbers: ['0000000102865'], vatCodes: ['0'] };
  const specialGoods = [insurance,
    { productGroups: ['160201'], articleNumbers: ['0000000000001', '0000000000034'], vatCodes: ['19', '20'] },
    { productGroups: ['50107'], articleNumbers: ['0000000000015', '0000000094074'], vatCodes: ['19', '20'] },
    { productGroups: ['60704'], articleNumbers: ['0000000104000'], vatCodes: ['20'] },
    { productGroups: ['999999'], articleNumbers: ['0000000100895'], vatCodes: ['20'] }];
  const financialIdentities = require('./cash-financial-identities.json');
  const rules = previous.statusRules.filter(rule => !rule.id.startsWith('source-special-goods-3-')).map(rule => ({ ...rule,
    ...(rule.id.startsWith('source-discount-') ? { except: [serviceVoucher] } : {}),
    ...(rule.receiptFingerprints ? { receiptFinancialFingerprints: rule.receiptFingerprints.map(key => financialIdentities[key]) } : {}) }));
  for (const [i, filter] of specialGoods.entries()) for (const quantitySign of ['positive', 'negative']) {
    rules.push({ id: `confirmed-sales-family-${i}-${quantitySign}`, status: quantitySign === 'positive' ? 'sale' : 'return',
      quantitySign, ...filter, flags });
  }
  for (const quantitySign of ['positive', 'negative']) rules.push({ id: 'confirmed-service-voucher-' + quantitySign,
    status: 'voucher_issue', quantitySign, ...serviceVoucher, flags: { ...flags, SonderartikelS: false } });
  return { ...previous, version: 14, approvedAt: '2026-11-05T00:00:00.000Z', approvedBy: 'user-confirmed-and-source-verified-sales-families',
    evidenceSha256: C.fingerprint({ prior: previous.evidenceSha256, revision: 'cash-confirmed-families-20261105',
      insurance: 'user-confirmed-full-booked-price-as-revenue-and-historical-cash-margin',
      phoneCredit: 'user-confirmed-full-booked-card-value-as-revenue',
      masterSource: '0656e890a54d3836316478cceadfb58a29ae412e01653feace4e2fd8425d3956', specialGoods, serviceVoucher,
      invoiceZeroVat: 'recorded-percentage-on-complete-register-zero-invoices;unchanged-zero-cent-header-check',
      invoiceNetHalfCent: 'invoice-60671-independent-head-240.72;exact-half-even-net-tie-then-Access-Single;positions-unchanged',
      financialIdentities }),
    invoiceZeroVatMeaning: 'recorded_percentage',
    invoiceHeaderRounding: 'source_single_half_even_net_tie',
    headerBasisOverrides: previous.headerBasisOverrides.map(item => ({ ...item, receiptFinancialFingerprint: financialIdentities[item.receiptFingerprint] })),
    zeroPriceVatExceptions: [...previous.zeroPriceVatExceptions, { ...insurance, vatCodes: ['0'] }, { ...phoneCredit, vatCodes: ['0'] }],
    statusRules: rules };
}

function confirmedAccountRevenue(previous) {
  const C = require('./data-import-contract');
  const filter = { productGroups: ['999999'], articleNumbers: ['0000000904800', '0000000902761'], vatCodes: ['20'] };
  const flags = { AStorno: false, BStorno: false, Ret: false, R: false, N: false, ZR: false, set: false, SonderartikelS: false, Beratung: false };
  const rules = previous.statusRules.map(rule => rule.id.startsWith('confirmed-example-') || rule.id === 'confirmed-negative-item-return'
    ? { ...rule, except: [...(rule.except || []), filter] } : rule);
  for (const AStorno of [false, true]) for (const SonderartikelS of [false, true]) for (const quantitySign of ['positive', 'negative']) {
    rules.push({ id: `confirmed-account-revenue-${Number(AStorno)}-${Number(SonderartikelS)}-${quantitySign}`,
      status: 'adjustment', signedAdjustmentPrice: true, quantitySign, ...filter, flags: { ...flags, AStorno, SonderartikelS } });
  }
  return { ...previous, version: 15, approvedBy: 'user-confirmed-account-revenue',
    evidenceSha256: C.fingerprint({ prior: previous.evidenceSha256, revision: 'cash-account-revenue-20261105', filter,
      meaning: 'user-confirmed-other-operating-income-and-outstanding-credit-notes-count-as-signed-booked-revenue;not-goods-quantity;historical-margin-unchanged' }),
    statusRules: rules };
}

function confirmedRentalSecurityRevenue(previous) {
  const C = require('./data-import-contract');
  const filter = { productGroups: ['110401'], articleNumbers: ['0000000106582'] };
  const flags = { AStorno: false, BStorno: false, Ret: false, R: false, N: false, ZR: false, set: false, SonderartikelS: false, Beratung: false };
  const rules = previous.statusRules.map(rule => rule.id.startsWith('confirmed-example-') || rule.id === 'confirmed-negative-item-return'
    || rule.id.startsWith('source-special-goods-0-') ? { ...rule, except: [...(rule.except || []), filter] } : rule);
  for (const AStorno of [false, true]) for (const SonderartikelS of [false, true]) for (const quantitySign of ['positive', 'negative']) {
    rules.push({ id: `confirmed-rental-security-${Number(AStorno)}-${Number(SonderartikelS)}-${quantitySign}`,
      status: 'adjustment', signedAdjustmentPrice: true, quantitySign, ...filter, flags: { ...flags, AStorno, SonderartikelS } });
  }
  return { ...previous, version: 16, approvedBy: 'user-confirmed-rental-security-revenue',
    evidenceSha256: C.fingerprint({ prior: previous.evidenceSha256, revision: 'cash-rental-security-revenue-20261105', filter,
      meaning: 'user-confirmed-rental-security-receipt-and-refund-as-signed-booked-revenue;not-sold-goods;preserve-historical-margin' }),
    zeroPriceVatExceptions: [...previous.zeroPriceVatExceptions, { ...filter, vatCodes: ['0'] }], statusRules: rules };
}

function confirmedOrdinaryTradeGoods(previous) {
  const C = require('./data-import-contract');
  const filter = { productGroups: ['170102'], articleNumbers: ['0000000106030'], vatCodes: ['20'] };
  const flags = { AStorno: false, BStorno: false, Ret: false, R: false, N: false, ZR: false, set: false, SonderartikelS: true, Beratung: false };
  // Preserve the already confirmed interim-payment exceptions, including
  // fresh GUIDs/text. Changed finances on those same receipt identities still
  // require review; the general goods rule cannot silently replace evidence.
  const exceptReceiptKeys = ['7a830716c887b0c280b60dfae6d7691d73a3c44d61285bc8fa8bda2acce20a53',
    'f1d442b45fa563002735f768e5250b3165eaa396735ab92c833631ad43d94a19'];
  return { ...previous, version: 17, approvedBy: 'user-confirmed-ordinary-trade-goods',
    evidenceSha256: C.fingerprint({ prior: previous.evidenceSha256, revision: 'cash-ordinary-trade-goods-20261105', filter, exceptReceiptKeys,
      meaning: 'user-confirmed-normal-signed-revenue-and-historical-cash-margin;preserve-confirmed-uid-interim-payments' }),
    statusRules: [...previous.statusRules, ...['positive','negative'].map(quantitySign => ({
      id: 'confirmed-ordinary-trade-goods-' + quantitySign, status: quantitySign === 'positive' ? 'sale' : 'return',
      quantitySign, ...filter, flags, exceptReceiptKeys }))] };
}

function confirmedPrintCenterRevenue(previous) {
  const C = require('./data-import-contract');
  const filter = { productGroups: ['999999'], articleNumbers: ['0000000078711'], vatCodes: ['20'] };
  const flags = { AStorno: false, BStorno: false, Ret: false, R: false, N: false, ZR: false, set: false, SonderartikelS: true, Beratung: false };
  return { ...previous, version: 18, approvedBy: 'user-confirmed-print-center-revenue',
    evidenceSha256: C.fingerprint({ prior: previous.evidenceSha256, revision: 'cash-print-center-revenue-20261105', filter,
      meaning: 'user-confirmed-print-center-revenue-arises-on-this-cash-position;normal-signed-sales-and-historical-margin',
      invoice60587: 'independent-invoice-head-97.22196000000001;gross-rebuilt-from-unit-net-rounded-to-four-currency-decimals;exact-Access-Single',
      invoices72254and73677: 'exact-recorded-Access-Single-net-heads-from-rounded-two-decimal-net-unit-prices;no-amount-tolerance',
      invoiceReferences: 'positive-line-invoice-reference-must-match-register-zero-invoice-header' }),
    invoiceUnitNetRounding: 'net_2_or_gross_4_single',
    statusRules: [...previous.statusRules, ...['positive','negative'].map(quantitySign => ({
      id: 'confirmed-print-center-' + quantitySign, status: quantitySign === 'positive' ? 'sale' : 'return',
      quantitySign, ...filter, flags }))] };
}

function confirmedTradeInRevenue(previous) {
  const C = require('./data-import-contract');
  const filter = { productGroups: ['170102'], articleNumbers: ['0000000058204'], vatCodes: ['0'] };
  const flags = { AStorno: false, BStorno: false, Ret: false, R: false, N: false, ZR: false, set: false, SonderartikelS: true, Beratung: false };
  return { ...previous, version: 20, approvedBy: 'user-confirmed-trade-in-revenue-reduction',
    evidenceSha256: C.fingerprint({ prior: previous.evidenceSha256, revision: 'cash-trade-in-revenue-20261105', filter,
      meaning: 'user-confirmed-trade-in-payout-reduces-revenue;reversal-restores-revenue;not-sold-goods;preserve-historical-margin-and-separate-uid-clearing' }),
    statusRules: [...previous.statusRules, ...['positive','negative'].map(quantitySign => ({
      id: 'confirmed-trade-in-' + quantitySign, status: 'adjustment', signedAdjustmentPrice: true, zeroVatConfirmed: true,
      quantitySign, ...filter, flags }))] };
}

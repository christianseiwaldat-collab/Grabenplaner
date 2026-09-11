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
  return require('./tradefoto-sales-rules').defineTradeFotoSalesPolicy({ ...clearingAndReturns, version: 8,
    evidenceSha256: C.fingerprint({ prior: clearingAndReturns.evidenceSha256, revision: 'cash-review-used-goods-20260911',
      usedGoodsVat: 'user-confirmed-stored-zero-percent-vat-and-net-sale-amount',
      margin: 'historical-cash-unit-margin-times-signed-quantity' }),
    // Only the confirmed used-goods article may carry a nonzero sale price
    // with code 0. At zero percent the unchanged price is also the net amount.
    zeroPriceVatExceptions: [{ productGroups: ['130101'], articleNumbers: ['0000000069877'], vatCodes: ['0'] }]
  });
}
module.exports = { CASH_SOURCE_POLICIES, resolveCashSalesPolicy };

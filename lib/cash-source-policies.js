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
module.exports = { CASH_SOURCE_POLICIES };

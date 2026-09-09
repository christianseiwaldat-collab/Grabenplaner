'use strict';
const H = require('./tradefoto-history-profiles');
// Confirmed by the user on 2026-09-09 from the BILD ANALOG cash example:
// RohertragDM is per unit; KalkRohertrag is the position amount (unit × quantity).
// Keep the historical source precision until rounding the complete position.
const CASH_REPORT_MARGIN_POLICY = Object.freeze({ id: 'cash-margin-unit-20260909', version: 1, meaning: 'unit', field: 'RohertragDM',
  quantityField: 'VKMenge', currency: 'EUR', minorUnits: 2, rounding: 'half_away_from_zero',
  schemaSha256: H.profileFor('cash', 'Umsatz_KASSE').schemaSha256, approvedOn: '2026-09-09', approvedBy: 'user-confirmed-cash-example' });
function reportMarginPolicyFor(salesPolicy) {
  return salesPolicy?.id === 'cash-confirmed-20260907' && salesPolicy.currency === 'EUR' && salesPolicy.minorUnits === 2
    && salesPolicy.schemaSha256 === CASH_REPORT_MARGIN_POLICY.schemaSha256 ? CASH_REPORT_MARGIN_POLICY : null;
}
module.exports = { CASH_REPORT_MARGIN_POLICY, reportMarginPolicyFor };

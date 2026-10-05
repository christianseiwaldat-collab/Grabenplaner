'use strict';
const { compileSalesEntry } = require('./catalog');
const { CASH_PUBLICATION_STATEMENTS: S } = require('../../statements/cash-publications');
const statements = new Set([...Object.values(S.searchCustomer), ...Object.values(S.searchCustomerAssigned)]);
// Extend the reader beside the frozen migration contracts. No customer data or
// Core tables are joined into Sales; only an authenticated opaque key is passed.
const CATALOG = Object.freeze(require('../../sqlite/cash-publications-catalog').SQLITE_CASH_PUBLICATIONS_CATALOG
  .filter(entry => statements.has(entry.statement))
  .map(entry => Object.freeze(compileSalesEntry(entry, 8).providerEntry)));
module.exports = { CATALOG };

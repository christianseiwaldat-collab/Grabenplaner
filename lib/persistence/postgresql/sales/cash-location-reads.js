'use strict';
const { compileSalesEntry } = require('./catalog');
// Add read statements beside the pinned migration catalogs, with no schema or
// historical source-contract change.
const CATALOG = Object.freeze(require('../../sqlite/cash-location-reads-catalog').CATALOG.map(entry =>
  Object.freeze(compileSalesEntry(entry, 8).providerEntry)));
module.exports = { CATALOG };

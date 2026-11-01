'use strict';
const {compileSalesEntry}=require('./catalog');
// Additive reads only; existing migration contracts and schema stay unchanged.
const CATALOG=Object.freeze(require('../../catalogs/data-import-source-tolerance-catalog').CATALOG.map(entry=>compileSalesEntry(entry,8).providerEntry));
module.exports={CATALOG};

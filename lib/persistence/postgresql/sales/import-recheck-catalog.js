'use strict';
const {compileSalesEntry}=require('./catalog');
// Additive runtime statements use the qualified existing schema. Historical
// migration catalogs and their checksums remain immutable.
const IMPORT_RECHECK_CATALOG=Object.freeze(require('../../sqlite/data-import-recheck-catalog').DATA_IMPORT_RECHECK_CATALOG.map(entry=>compileSalesEntry(entry,8).providerEntry));
module.exports={IMPORT_RECHECK_CATALOG};

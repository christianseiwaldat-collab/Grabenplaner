'use strict';
const {compileSalesEntry}=require('./catalog');
// Additive read-only runtime statement on the existing state/row index.
// Frozen migration catalogs and installed schemas remain unchanged.
const IMPORT_ISSUES_CATALOG=Object.freeze(require('../../catalogs/data-import-issues-catalog').IMPORT_ISSUES_CATALOG.map(entry=>{
  const compiled=compileSalesEntry(entry,8).providerEntry;
  return Object.freeze({...compiled,sql:compiled.sql.replace(/\brow_number NULLS FIRST\b/g,'row_number NULLS LAST')});
}));
module.exports={IMPORT_ISSUES_CATALOG};

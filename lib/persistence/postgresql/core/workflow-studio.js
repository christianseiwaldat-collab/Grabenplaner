"use strict";
const {compileCoreEntry}=require('./catalog');
// Reviewed read-only application extension over existing tables. The frozen
// migration inventory and source statement bodies remain unchanged; no DDL.
const CATALOG=require('../../catalogs/workflow-studio-catalog').CATALOG.map(entry=>{
 const compiled=compileCoreEntry(entry).providerEntry;
 return Object.freeze({...compiled,sql:compiled.sql.replace(/(?<![."a-z_])(custom_process_runs|custom_process_run_steps)\b/g,'gp.$1')});
});
module.exports={CATALOG:Object.freeze(CATALOG)};

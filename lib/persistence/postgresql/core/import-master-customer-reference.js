'use strict';
const { IMPORT_MASTER_STATEMENTS: S } = require('../../statements/import-master-data');
const { SQLITE_IMPORT_MASTER_CATALOG } = require('../../sqlite/import-master-catalog');
const { compileCoreEntry } = require('./catalog');
// A read-only application extension; the historical migration contracts and
// existing unique target identity index are unchanged.
const source = SQLITE_IMPORT_MASTER_CATALOG.find(entry => entry.statement === S.getBindingByTarget);
const compiled = compileCoreEntry(source).providerEntry;
const CATALOG = Object.freeze([Object.freeze({ ...compiled,
  sql: compiled.sql.replace(/\bimport_master_bindings\b/g, 'gp.import_master_bindings') })]);
module.exports = { CATALOG };

'use strict';
const {CATALOG}=require('../../sqlite/data-import-delete-catalog');
const {compileCoreEntry}=require('./catalog');
module.exports={CATALOG:CATALOG.filter(e=>['data-import-delete.source','data-import-delete.audit'].includes(e.statement.id)).map(e=>compileCoreEntry(e).providerEntry)};
